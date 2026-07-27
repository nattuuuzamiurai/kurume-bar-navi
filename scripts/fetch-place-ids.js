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
 * ■ 誤マッチ検出(誤った店の評価を出さないことが最優先 / 2026-07-27 品質管理部指摘により強化)
 *   Text Search は「店名+住所」で問い合わせても、同じ町内の無関係な店や、同名の近隣別番地の店を
 *   返すことがある。旧版は「町名だけ一致(店名照合なし)」を採用してしまい別店を多数掴んだため、
 *   採用条件を以下の **すべて** を満たす場合のみに厳格化した(1つでも欠ければ placeId 空で保留):
 *     (a) 解決住所に「久留米」を含む(別エリアを弾く)
 *     (b) 店名が一致する(正規化+所在地ノイズ除去のうえ exact か強い部分一致)。**店名一致は必須**
 *     (c) 番地が一致する(元住所の番地が解決住所にも現れる)。同名の近隣別番地(例 ミライザカ
 *         東町33-8 と 33-5)を弾くための必須条件
 *   さらに Text Search が返す複数候補を評価し、(a)(b)(c)を満たす最良の1件を選ぶ(先頭を機械的に採らない)。
 *   → いずれも満たさなければ保留(placeId空・ログ出力)。「誤った店を出すより出さない方がまし」を徹底。
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
    .replace(/[()（）【】\[\]「」『』・,.。、!！?？~〜\-−–—―ー－‐_/\\'"’”“。･]/g, "");
}

// 店名から所在地ノイズ(西鉄久留米・久留米・駅前 等)を除く。
// 例:「旨唐揚げと居酒メシ 西鉄久留米ミライザカ」⇔ Googleの「旨唐揚げと居酒メシ ミライザカ」を
// 突合できるようにする。所在地語のみを対象にし、店名の本体(業態語・固有名)は削らない(過剰一致を防ぐ)。
function stripLocationNoise(s) {
  return s
    .replace(/西鉄久留米|ｊｒ久留米|jr久留米|西鉄|久留米|駅前|駅ちか|駅チカ/gi, "");
}

// 2文字列の最長共通連続部分文字列の長さ。
function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  const dp = new Array(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev + 1;
        if (dp[j] > best) best = dp[j];
      } else {
        dp[j] = 0;
      }
      prev = tmp;
    }
  }
  return best;
}

// 店名の一致判定(必須条件)。正規化+所在地ノイズ除去のうえ、以下のいずれかで一致とみなす:
//   exact   … 完全一致
//   partial … 短い方(2文字以上)が長い方に完全に含まれる
//   core    … 双方に包含は無いが、識別力のある共通連続部分が十分長い(3文字以上かつ短い方の40%以上)。
//             例:「韓ダイニング モイジャ」⇔「韓Dining モイジャ」(共通「モイジャ」)のような一部だけ英字/
//             カナ表記が違うケースを吸収する。※番地一致が別途必須なので、これで別店を誤採用する余地は小さい。
// カタカナ⇄英字が名前全体に及ぶ別表記(例 ALETTA/アレッタ、リメンバー/Remember)は共通部分が無く保留になる
// =誤った店を出さない安全側の挙動。
function nameMatchKind(venueName, resolvedName) {
  const a = stripLocationNoise(normalizeText(venueName));
  const b = stripLocationNoise(normalizeText(resolvedName));
  if (!a || !b) return null;
  if (a === b) return "exact";
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 2 && long.includes(short)) return "partial";
  const lcs = longestCommonSubstring(a, b);
  if (lcs >= 3 && lcs / short.length >= 0.4) return "core";
  return null;
}

// 住所の正規化(NFKC・各種ダッシュを「-」へ統一・「丁目/番地/番」を「-」へ・「号」を除去)。番地の突合に使う。
// 例「7丁目33」→「7-33」、「21番7号」→「21-7」。venues.json と Google で丁目表記が違っても突合できる。
// ※ 空白は残す(1個に圧縮)。空白を消すと「33-5 2F」の階数(2F)が番地と地続きになり「33-52f」となって
//    番地の数字境界判定を誤らせるため。空白はそのまま非数字の区切りとして機能させる。
function canonAddr(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(/[−–—―ー－‐]/g, "-")
    .replace(/丁目|丁|番地|番/g, "-")
    .replace(/号(室|館)?/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/[\s　]+/g, " ");
}

// 郵便番号(〒xxx-xxxx / xxx-xxxx)を除く。番地の数字と郵便番号の数字の偶発一致を防ぐ。
function stripPostal(s) {
  return s.replace(/〒?\d{3}-?\d{4}/g, "");
}

// 元住所から番地(丁目・番・号の数字列)を取り出す。例:「東町33-5 ニューフタマタ第三ビル1F」→「33-5」。
// ※ 空白は残したまま抽出する。空白を消すと番地の直後に続く階数(例「25-43 2F」の 2F)を巻き込んで
//    「25-432」のように誤抽出してしまうため。番地は最初の空白/非(数字・ハイフン)文字で区切る。
// 括弧書きの注記(例「久留米市(文化街商店街周辺)」)は除いてから抽出する。番地が無ければ空。
function extractBanchi(address) {
  const norm = canonAddr(String(address || "").replace(/[(（][^)）]*[)）]/g, ""));
  const m = norm.match(/久留米市\s*\D*?(\d+(?:-\d+)*)/);
  return m ? m[1] : "";
}

// 番地の一致判定(必須条件)。元住所の番地(例「33-5」)が解決住所にもそのまま現れるか。
// これにより同名の近隣別番地(例 ミライザカ 33-8 と 33-5)を弾く。番地が取れない元住所は不一致=保留。
// 数字境界を確認し、「2-16」が「12-16」の一部、「25-43」が「25-431」の一部…のような偶発一致を排除する。
function banchiMatches(venueBanchi, resolvedAddress) {
  if (!venueBanchi) return false;
  const rc = stripPostal(canonAddr(resolvedAddress));
  let from = 0;
  while (true) {
    const idx = rc.indexOf(venueBanchi, from);
    if (idx < 0) return false;
    const before = idx > 0 ? rc[idx - 1] : "";
    const after = idx + venueBanchi.length < rc.length ? rc[idx + venueBanchi.length] : "";
    if (!/\d/.test(before) && !/\d/.test(after)) return true; // 前後が数字でなければ独立した番地一致
    from = idx + 1;
  }
}

// 1つの候補が採用条件(久留米内 かつ 店名一致 かつ 番地一致)を満たすか評価する。
function evaluateCandidate(venue, cand, venueBanchi) {
  const inKurume = /久留米/.test(cand.formattedAddress);
  const nameKind = nameMatchKind(venue.name, cand.displayName);
  const banchiOk = banchiMatches(venueBanchi, cand.formattedAddress);
  return { inKurume, nameKind, banchiOk, ok: inKurume && !!nameKind && banchiOk };
}

// Text Search を1回叩き、候補の配列(最大10件)を返す。1リクエスト=1課金なので、複数候補を
// 受け取っても Pro SKU の呼び出し数は増えない。呼び出し側で店名+番地により最良の1件を選ぶ。
//   成功 -> { candidates: [{ id, displayName, formattedAddress }, ...] }(0件もあり)
//   通信/非200 -> { error: true, status }
function searchOnce(apiKey, textQuery) {
  const bodyObj = { textQuery, languageCode: "ja", regionCode: "JP", pageSize: 10 };
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
          const places = (data && data.places) || [];
          const candidates = places.map((p) => ({
            id: p.id || "",
            displayName: (p.displayName && p.displayName.text) || "",
            formattedAddress: p.formattedAddress || "",
          }));
          done({ candidates });
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
    const venueBanchi = extractBanchi(v.address);

    if (!r || r.error) {
      // 通信エラー: エントリは作らず(次回リトライできるように)スキップ。
      console.warn(`  [warn] ${v.id}: 取得失敗のため保留(次回再試行)`);
      if (i < batch.length - 1) await sleep(SLEEP_MS);
      continue;
    }

    const candidates = r.candidates || [];
    // 全候補を評価し、(久留米内 かつ 店名一致 かつ 番地一致)を満たす最良の1件を選ぶ。
    let best = null;
    let bestEval = null;
    for (const c of candidates) {
      const e = evaluateCandidate(v, c, venueBanchi);
      if (e.ok) {
        best = c;
        bestEval = e;
        break; // 条件を満たす先頭を採用(Text Searchは関連度順)
      }
    }

    if (best) {
      store[v.id] = {
        placeId: best.id,
        resolvedName: best.displayName,
        resolvedAddress: best.formattedAddress,
        query,
        // 採用根拠を残す(店名一致の種別 + 番地一致)。人手監査用。
        matchBy: `店名${bestEval.nameKind}+番地一致`,
        fetchedAt: now,
      };
      resolved++;
    } else {
      // 採用条件を満たす候補なし: placeId 空で保留。なぜ弾いたかと先頭候補を残す(人手レビュー用)。
      const top = candidates[0] || null;
      let reason;
      if (candidates.length === 0) {
        reason = "候補ゼロ(店名+住所で解決できず)";
      } else {
        const anyKurume = candidates.some((c) => /久留米/.test(c.formattedAddress));
        const anyName = candidates.some((c) => nameMatchKind(v.name, c.displayName));
        const anyNameKurume = candidates.some((c) => /久留米/.test(c.formattedAddress) && nameMatchKind(v.name, c.displayName));
        if (!anyKurume) reason = "全候補が別エリア(久留米を含まない)";
        else if (!anyName) reason = `店名が一致する候補なし(元「${v.name}」/ 先頭解決「${top ? top.displayName : ""}」)`;
        else if (!anyNameKurume) reason = "店名一致の候補が久留米外";
        else reason = `番地が一致する候補なし(元「${venueBanchi || "番地不明"}」/ 近隣別番地または住所曖昧の疑い)`;
      }
      store[v.id] = {
        placeId: "",
        needsReview: true,
        reviewReasons: [reason],
        candidate: top ? { placeId: top.id, name: top.displayName, address: top.formattedAddress } : null,
        query,
        fetchedAt: now,
      };
      reviewCount++;
      reviewLog.push(`  - ${v.id}「${v.name}」: ${reason}`);
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

// 直接実行された場合のみ main を走らせる(require で読み込んだ際はマッチング関数の単体テスト等に使える)。
if (require.main === module) {
  main().catch((e) => {
    // 予期しない例外でもCI全体は止めない(place-ids.json はそのまま=状態は壊さない)。
    console.warn(`[fetch-place-ids] 予期しないエラー: ${e.message}. place-ids.json は変更せず続行します。`);
  });
}

// マッチングロジックの単体テスト用にエクスポート(本体の実行には影響しない)。
module.exports = { normalizeText, stripLocationNoise, nameMatchKind, canonAddr, stripPostal, extractBanchi, banchiMatches, evaluateCandidate };
