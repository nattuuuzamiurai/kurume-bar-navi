#!/usr/bin/env node
/**
 * Google Places place_id 取得スクリプト(Text Search / Places API New)
 *
 * data/venues.json の各「公開店」について、まだ place_id を取得していない店だけ、
 * Text Search (New) を叩いて place_id を解決し data/place-ids.json に保存する。
 *
 * ■ 使うAPIとコスト
 *   POST https://places.googleapis.com/v1/places:searchText
 *   FieldMask: places.id, places.displayName, places.formattedAddress
 *   → この組み合わせは Text Search Pro SKU(無料枠 月5,000回)。
 *   公開店は約161店で、しかも「一度取得したら再取得しない」設計のため、実質一度きり=$0。
 *   ※ rating/userRatingCount は **含めない**(含めると Enterprise SKU になり無料枠が月1,000に減る)。
 *     評価の取得は fetch-ratings.js が別途 Place Details でローリング実行する。
 *
 * ■ 取得の粒度(再取得しない設計)
 *   place-ids.json に「その店のエントリが既に存在する」場合はスキップする(place_id が入っていても、
 *   誤マッチで空のまま保留されていても、いずれも再クエリしない)。place_id は基本的に不変なので
 *   1店1回の問い合わせで十分。誤マッチで保留になった店は人手でレビューし、正しい候補があれば
 *   place-ids.json の placeId を手で埋める / 取り直したい場合はその店のエントリを削除して再実行する。
 *
 * ■ 誤マッチ検出(誤った店の評価を出さないことが最優先)
 *   Text Search は同名別店・別エリアの店を返すことがある。以下のいずれかに当てはまる候補は
 *   「確信が持てない」とみなし、placeId は空のまま needsReview として保留し、警告ログを出す:
 *     (a) 解決された住所に「久留米」を含まない(=別エリアの店)
 *     (b) 解決された店名が元の店名と大きく食い違う(前方/部分一致しない)
 *   → 保留店は評価を取得・表示しない。人がログを見てレビューできる。
 *
 * ■ APIキー
 *   process.env.GOOGLE_PLACES_API_KEY(GitHub Secrets / 環境変数のみ。コード・出力・ログに出さない)。
 *   未設定なら何もせず正常終了(グレースフル)。CI・ローカルでキー無しでも壊れない。
 *
 * ■ 出力: data/place-ids.json(コミットして状態を永続化する)
 *   { [venueId]: { placeId, resolvedName, resolvedAddress, query, nameMatch, fetchedAt } }
 *   誤マッチ保留店: { placeId:"", needsReview:true, reviewReasons:[...], candidate:{...}, query, fetchedAt }
 *
 * ■ 実行方法
 *   GOOGLE_PLACES_API_KEY=xxxx node scripts/fetch-place-ids.js
 *   環境変数 PLACE_ID_MAX で1回に問い合わせる最大店数を制限できる(既定 200 = 一度に全件)。
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { publishedVenues } = require("./lib/published");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const VENUES_FILE = path.join(DATA_DIR, "venues.json");
const OUT_FILE = path.join(DATA_DIR, "place-ids.json");

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const SLEEP_MS = 250; // レートに優しくするための逐次リクエスト間ウェイト。
const PLACE_ID_MAX = Math.max(1, parseInt(process.env.PLACE_ID_MAX || "200", 10) || 200);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function readJSONSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return data && typeof data === "object" ? data : fallback;
  } catch (e) {
    console.warn(`[warn] ${path.basename(file)} の読み込みに失敗: ${e.message}. 空として続行します。`);
    return fallback;
  }
}

// 文字列の正規化(NFKC・小文字化・記号/空白除去)。全角/半角・言語や表記ゆれをある程度吸収する。
function normalizeText(s) {
  return String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[()（）【】\[\]「」『』・,.。、!！?？~〜\-−_/\\'"’”“]/g, "");
}

// 解決された店名が元の店名と「大きく食い違わない」か(前方/部分一致で判定)。
// 完全一致・どちらかがもう一方を含む場合は一致とみなす。カタカナ⇄英字(例 リメンバー/Remember)の
// ような別表記は店名だけでは一致と判定できないため、下の住所照合(町名一致)で確信度を担保する。
function nameMatchKind(venueName, resolvedName) {
  const a = normalizeText(venueName);
  const b = normalizeText(resolvedName);
  if (!a || !b) return null;
  if (a === b) return "exact";
  if (a.includes(b) || b.includes(a)) return "partial";
  return null;
}

// 元の住所から町名(丁目名)を取り出す。例:「福岡県久留米市東町39-11 …」→「東町」。
// 括弧書きの注記(例「久留米市(文化街商店街周辺)」)は除いてから抽出する。
function extractCho(address) {
  const norm = String(address || "").normalize("NFKC").replace(/[(（][^)）]*[)）]/g, "");
  const m = norm.match(/久留米市\s*([^\d\s]+?)(?=[\d]|$)/);
  const cho = m ? m[1].trim() : "";
  // 「大字」等の接頭辞だけ・空は無効扱い。
  return cho && cho !== "大字" ? cho : "";
}

// 誤マッチ判定。誤った店の評価を出さないことを最優先し、確信が持てなければ review にする。
// 確信ありの条件: 解決住所が「久留米」を含む(=別エリアでない) かつ
//   (元住所の町名が解決住所にも現れる=同じ町) または (店名が一致する)。
// これによりカタカナ/英字の表記ゆれ(住所で担保)や、住所が曖昧な店(店名で担保)を吸収しつつ、
// 別エリア・別の町の同名店は弾く。
function evaluateMatch(venue, resolved) {
  const reasons = [];
  const resolvedNorm = normalizeText(resolved.formattedAddress);
  const inKurume = /久留米/.test(resolved.formattedAddress);
  if (!inKurume) reasons.push("解決住所に「久留米」を含まない(別エリアの疑い)");

  const cho = extractCho(venue.address);
  const choMatch = !!cho && resolvedNorm.includes(normalizeText(cho));
  const nameKind = nameMatchKind(venue.name, resolved.displayName);

  // 久留米内であっても、町名も店名も一致しなければ「確信が持てない」= review。
  if (inKurume && !choMatch && !nameKind) {
    reasons.push(`町名も店名も一致しない(元「${venue.name}／${cho || "町名不明"}」/ 解決「${resolved.displayName}」)`);
  }
  return { ok: reasons.length === 0, reasons, choMatch, cho, nameKind };
}

// Text Search を1回叩き、先頭の候補を返す。
//   成功 -> { id, displayName, formattedAddress }
//   候補なし -> null
//   通信/非200 -> { error: true, status }
function searchOnce(apiKey, textQuery) {
  const bodyObj = { textQuery, languageCode: "ja", regionCode: "JP" };
  const body = JSON.stringify(bodyObj);
  const u = new URL(SEARCH_URL);
  const options = {
    method: "POST",
    hostname: u.hostname,
    path: u.pathname,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "X-Goog-Api-Key": apiKey,
      // place_id・店名・住所のみ要求(rating等は含めない=Pro SKUに留める)。
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress",
    },
  };
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          // レスポンス本文にはキーは含まれないが、念のため生ログは出さない。
          console.warn(`  [warn] Text Search HTTP ${res.statusCode}`);
          return done({ error: true, status: res.statusCode });
        }
        try {
          const data = JSON.parse(raw);
          const p = data && data.places && data.places[0];
          if (!p) return done(null);
          done({
            id: p.id || "",
            displayName: (p.displayName && p.displayName.text) || "",
            formattedAddress: p.formattedAddress || "",
          });
        } catch (e) {
          console.warn(`  [warn] Text Search JSONパース失敗 (${e.message})`);
          done({ error: true, status: 0 });
        }
      });
    });
    req.on("error", (e) => {
      console.warn(`  [warn] Text Search リクエスト失敗 (${e.message})`);
      done({ error: true, status: 0 });
    });
    req.setTimeout(15000, () => {
      req.destroy();
      console.warn("  [warn] Text Search タイムアウト");
      done({ error: true, status: 0 });
    });
    req.write(body);
    req.end();
  });
}

async function main() {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.log("[fetch-place-ids] GOOGLE_PLACES_API_KEY 未設定のためスキップします(place-ids.json は変更しません)。");
    return;
  }

  const venues = publishedVenues(readJSON(VENUES_FILE));
  const store = readJSONSafe(OUT_FILE, {});

  // まだエントリが無い公開店だけを対象にする(既にあれば place_id 有無に関わらず再取得しない)。
  const targets = venues.filter((v) => !(v.id in store));
  console.log(`[fetch-place-ids] 公開店 ${venues.length}件 / 未取得 ${targets.length}件 / 今回上限 ${PLACE_ID_MAX}件`);
  if (targets.length === 0) {
    console.log("[fetch-place-ids] 取得対象なし。終了します。");
    return;
  }

  const batch = targets.slice(0, PLACE_ID_MAX);
  let resolved = 0;
  let reviewCount = 0;
  const reviewLog = [];

  for (let i = 0; i < batch.length; i++) {
    const v = batch[i];
    const query = `${v.name} ${v.address || "久留米市"}`.trim();
    const r = await searchOnce(apiKey, query);
    const now = new Date().toISOString();

    if (!r || r.error) {
      // 候補なし / 通信エラー: エントリは作らず(次回リトライできるように)スキップ。
      if (r && r.error) console.warn(`  [warn] ${v.id}: 取得失敗のため保留(次回再試行)`);
      else console.warn(`  [warn] ${v.id}: 候補ゼロのため保留(次回再試行)`);
    } else {
      const evalr = evaluateMatch(v, r);
      if (!evalr.ok) {
        // 誤マッチの疑い: placeId は空のまま保留し、候補情報を残す(人手レビュー用)。
        store[v.id] = {
          placeId: "",
          needsReview: true,
          reviewReasons: evalr.reasons,
          candidate: { placeId: r.id, name: r.displayName, address: r.formattedAddress },
          query,
          fetchedAt: now,
        };
        reviewCount++;
        reviewLog.push(`  - ${v.id}「${v.name}」: ${evalr.reasons.join(" / ")}`);
      } else {
        store[v.id] = {
          placeId: r.id,
          resolvedName: r.displayName,
          resolvedAddress: r.formattedAddress,
          query,
          // 確信の根拠を残す(町名一致 / 店名一致)。人手監査用。
          matchBy: [evalr.choMatch ? "町名一致" : "", evalr.nameKind ? `店名${evalr.nameKind}` : ""].filter(Boolean).join("+"),
          fetchedAt: now,
        };
        resolved++;
      }
    }
    if (i < batch.length - 1) await sleep(SLEEP_MS);
  }

  // venueId でソートして安定出力(差分を読みやすく)。
  const sorted = {};
  for (const k of Object.keys(store).sort()) sorted[k] = store[k];
  fs.writeFileSync(OUT_FILE, JSON.stringify(sorted, null, 2) + "\n", "utf-8");

  console.log(`[fetch-place-ids] place_id 解決: ${resolved}件 / レビュー保留(誤マッチ疑い): ${reviewCount}件`);
  if (reviewLog.length > 0) {
    console.log("[fetch-place-ids] ⚠ 以下は誤マッチの疑いがあり placeId を空で保留しました。人手で確認してください:");
    console.log(reviewLog.join("\n"));
  }
  console.log(`[fetch-place-ids] ${path.relative(ROOT, OUT_FILE)} を更新しました(合計 ${Object.keys(sorted).length}件のエントリ)。`);
}

main().catch((e) => {
  // 予期しない例外でもCI全体は止めない(place-ids.json はそのまま=状態は壊さない)。
  console.warn(`[fetch-place-ids] 予期しないエラー: ${e.message}. place-ids.json は変更せず続行します。`);
});
