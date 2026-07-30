#!/usr/bin/env node
/**
 * Googleクチコミ★評価 + 営業状況(businessStatus)ローリング更新スクリプト(Place Details / Places API New)
 *
 * data/place-ids.json の place_id を使い、Place Details (New) で rating / userRatingCount /
 * businessStatus を取得し data/ratings.json を更新する。全店を一度に更新せず、更新日時(updatedAt)が
 * 最も古い(または未取得の)店から N 店だけを毎回更新する「ローリング更新」にすることで、
 * Enterprise SKU の無料枠(月1,000回)を絶対に超えないようにする。
 *
 * ■ 使うAPIとコスト(無料枠を絶対に超えない設計)
 *   GET https://places.googleapis.com/v1/places/{place_id}
 *   FieldMask: rating,userRatingCount,businessStatus
 *   → rating / userRatingCount を含む取得は Places API (New) の Enterprise SKU。無料枠は【月1,000回】。
 *
 *   【businessStatus を足しても課金は増えない(2026-07-30 確認)】
 *   businessStatus 自体は Place Details "Pro" SKU のフィールドだが、Places API (New) の課金は
 *   1リクエストにつき **要求したフィールドの最上位ティア1つ分だけ** 発生する。公式ドキュメント
 *   (Places API / Usage and Billing「About field masks」)の原文:
 *     "use the FieldMask header in API requests to specify the list of fields to return in the
 *      response. You are then billed at the highest SKU applicable to your request. That means if
 *      you select fields in both the Essentials and the Pro SKUs, you are billed based on the Pro SKU."
 *     https://developers.google.com/maps/documentation/places/web-service/usage-and-billing
 *   本スクリプトは既に rating / userRatingCount(= Enterprise SKU。Pro より上位)を要求しているため、
 *   Pro ティアの businessStatus を追加してもリクエストは引き続き Enterprise SKU 1回として課金される
 *   (= 追加コスト・追加消費なし。呼び出し回数も従来どおり 1店=1回)。
 *   フィールドとティアの対応は Place Details (New) のドキュメントを参照
 *   ("The following fields trigger the Place Details Pro SKU: ... businessStatus ...",
 *    "The following fields trigger the Place Details Enterprise SKU: ... rating ... userRatingCount ...")
 *     https://developers.google.com/maps/documentation/places/web-service/place-details
 *   ※ 逆に言えば、Enterprise より上位(Enterprise + Atmosphere)のフィールドを足すと課金が上がる。
 *     FieldMask に足してよいのは Enterprise 以下のティアのフィールドだけ。
 *
 *   1回の実行で最大 N 店だけ取得する(N = 環境変数 RATINGS_BATCH_SIZE、既定 22)。
 *   ワークフロー(ratings.yml)は日次で1回だけ走るので、月間呼び出し数は概ね:
 *       N(=22) × 31日 = 682回 / 月  < 1,000回(無料枠)  ← $0 を厳守
 *   誤設定で N を大きくしても無料枠を超えないよう、コード側で N の上限を MAX_BATCH(=30)に
 *   ハードクランプする(30 × 31 = 930回/月 < 1,000)。**この上限は無料枠($0)を守る安全装置なので
 *   引き上げないこと。**
 *
 *   公開店 約161店を N=22 で回すと、各店およそ週1回のペースで評価が更新される(161 / 22 ≒ 7.3日)。
 *
 * ■ 最古から更新するロジック
 *   ratings.json の各店 updatedAt(ISO日時文字列)を昇順に並べ、未取得(updatedAt無し)を最優先、
 *   次に古い順に N 店選ぶ。取得できたら updatedAt を現在時刻に更新するので、次回は自然と別の店が回る。
 *
 * ■ 評価が無い店の扱い
 *   Google側に評価が無い(userRatingCount=0 等)場合も updatedAt は更新して rating:null で記録する
 *   (毎回同じ店を選び続けないため=ローテーションを進めるため)。build.js は rating が数値の店だけ★表示する。
 *
 * ■ APIキー
 *   process.env.GOOGLE_PLACES_API_KEY(GitHub Secrets / 環境変数のみ。コード・出力・ログに出さない)。
 *   未設定なら何もせず正常終了(グレースフル)。
 *
 * ■ businessStatus(閉店の機械的検知)
 *   Google が返す営業状況。値は OPERATIONAL / CLOSED_TEMPORARILY / CLOSED_PERMANENTLY のいずれか
 *   (返らない場合もある = null)。過去に閉店店舗を2度掲載した(poker-aa-aces / izakaya-sakuraya)反省から、
 *   人力確認に頼らず機械的に閉店の兆候を拾うために取得する。
 *   **このスクリプトは検知結果を記録するだけで、非掲載化は一切しない**。CLOSED_* を検知した店は
 *   build.js が `[warn]` で店舗IDを列挙するので、**人が現地情報・公式情報を確認してから**
 *   掲載継続/削除を判断する(place_id の誤マッチで別店舗の閉店を拾う可能性があるため)。
 *
 * ■ 出力: data/ratings.json(コミットして各店の評価を次の更新まで保持する)
 *   { [venueId]: { rating:Number|null, userRatingCount:Number, businessStatus:String|null, updatedAt:ISO文字列 } }
 *
 * ■ 実行方法
 *   GOOGLE_PLACES_API_KEY=xxxx RATINGS_BATCH_SIZE=5 node scripts/fetch-ratings.js
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { publishedVenues } = require("./lib/published");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const VENUES_FILE = path.join(DATA_DIR, "venues.json");
const PLACE_IDS_FILE = path.join(DATA_DIR, "place-ids.json");
const OUT_FILE = path.join(DATA_DIR, "ratings.json");

const DETAILS_BASE = "https://places.googleapis.com/v1/places/";
const SLEEP_MS = 250;

// 1回の実行で更新する店数 N。無料枠(月1,000回)を守るための安全上限 MAX_BATCH でクランプする。
// MAX_BATCH は $0 を守る安全装置。引き上げると無料枠超過=課金の恐れがあるため変更しないこと。
const DEFAULT_BATCH = 22;
const MAX_BATCH = 30; // 30 × 31日 = 930回/月 < 1,000回(無料枠)
const BATCH_SIZE = Math.min(
  MAX_BATCH,
  Math.max(1, parseInt(process.env.RATINGS_BATCH_SIZE || String(DEFAULT_BATCH), 10) || DEFAULT_BATCH)
);

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

// Google が返す営業状況の既知の値。想定外の値が来ても壊れないよう、既知の値以外は null にする。
const KNOWN_BUSINESS_STATUS = new Set(["OPERATIONAL", "CLOSED_TEMPORARILY", "CLOSED_PERMANENTLY"]);

// Place Details を1回叩く。
//   成功 -> { rating:Number|null, userRatingCount:Number, businessStatus:String|null }
//   place_id無効(404/NOT_FOUND等) -> { invalid: true, status }
//   通信/その他エラー(リトライ対象) -> { error: true, status }
function fetchDetailsOnce(apiKey, placeId) {
  const u = new URL(DETAILS_BASE + encodeURIComponent(placeId));
  const options = {
    method: "GET",
    hostname: u.hostname,
    path: u.pathname,
    headers: {
      "X-Goog-Api-Key": apiKey,
      // businessStatus は Pro ティア。既に Enterprise ティア(rating等)を要求しているので
      // 追加課金は発生しない(ファイル冒頭のコメント参照)。
      "X-Goog-FieldMask": "rating,userRatingCount,businessStatus",
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
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(raw);
            const rating = typeof data.rating === "number" ? data.rating : null;
            const userRatingCount = typeof data.userRatingCount === "number" ? data.userRatingCount : 0;
            const businessStatus = KNOWN_BUSINESS_STATUS.has(data.businessStatus) ? data.businessStatus : null;
            return done({ rating, userRatingCount, businessStatus });
          } catch (e) {
            console.warn(`  [warn] Place Details JSONパース失敗 (${e.message})`);
            return done({ error: true, status: 0 });
          }
        }
        // 404/400 は place_id 自体が無効な可能性が高い(リトライしても直らない)。
        if (res.statusCode === 404 || res.statusCode === 400) {
          console.warn(`  [warn] Place Details HTTP ${res.statusCode}(place_id無効の疑い)`);
          return done({ invalid: true, status: res.statusCode });
        }
        console.warn(`  [warn] Place Details HTTP ${res.statusCode}`);
        return done({ error: true, status: res.statusCode });
      });
    });
    req.on("error", (e) => {
      console.warn(`  [warn] Place Details リクエスト失敗 (${e.message})`);
      done({ error: true, status: 0 });
    });
    req.setTimeout(15000, () => {
      req.destroy();
      console.warn("  [warn] Place Details タイムアウト");
      done({ error: true, status: 0 });
    });
    req.end();
  });
}

// 通信起因の失敗のみ1回だけ再試行(place_id無効・成功は再試行しない)。
async function fetchDetails(apiKey, placeId) {
  let r = await fetchDetailsOnce(apiKey, placeId);
  if (r && r.error) {
    await sleep(SLEEP_MS * 2);
    r = await fetchDetailsOnce(apiKey, placeId);
  }
  return r;
}

async function main() {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.log("[fetch-ratings] GOOGLE_PLACES_API_KEY 未設定のためスキップします(ratings.json は変更しません)。");
    return;
  }

  const placeIds = readJSONSafe(PLACE_IDS_FILE, {});
  const ratings = readJSONSafe(OUT_FILE, {});
  const publishedIds = new Set(publishedVenues(readJSON(VENUES_FILE)).map((v) => v.id));

  // 有効な place_id を持ち、かつ現在公開対象の店だけを更新候補にする
  // (非公開店の評価は取得しない = 無料枠の無駄遣いと漏洩リスクを避ける)。
  const candidates = Object.keys(placeIds)
    .filter((id) => publishedIds.has(id))
    .filter((id) => placeIds[id] && typeof placeIds[id].placeId === "string" && placeIds[id].placeId.length > 0);

  console.log(`[fetch-ratings] place_id保有かつ公開中の候補: ${candidates.length}件 / 1回の更新上限 N=${BATCH_SIZE}`);
  if (candidates.length === 0) {
    console.log("[fetch-ratings] 更新対象なし(place-ids.json に有効な place_id がまだありません)。終了します。");
    return;
  }

  // updatedAt が古い順(未取得=最優先)に並べ、先頭 N 店を選ぶ。
  const sortKey = (id) => {
    const r = ratings[id];
    if (!r || !r.updatedAt) return ""; // 未取得は空文字=最小=最優先
    return r.updatedAt;
  };
  const selected = candidates
    .slice()
    .sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      if (ka < kb) return -1;
      if (ka > kb) return 1;
      return a < b ? -1 : 1; // 同順位は venueId で安定化
    })
    .slice(0, BATCH_SIZE);

  let updated = 0;
  let withRating = 0;
  let invalidCount = 0;
  let transientSkip = 0;
  const closedIds = []; // 今回 CLOSED_* を検知した店(人が確認するためログに出す。自動で非掲載にはしない)

  for (let i = 0; i < selected.length; i++) {
    const id = selected[i];
    const placeId = placeIds[id].placeId;
    const r = await fetchDetails(apiKey, placeId);
    const now = new Date().toISOString();

    if (r && !r.error && !r.invalid) {
      ratings[id] = {
        rating: r.rating,
        userRatingCount: r.userRatingCount,
        businessStatus: r.businessStatus,
        updatedAt: now,
      };
      updated++;
      if (typeof r.rating === "number") withRating++;
      if (r.businessStatus === "CLOSED_PERMANENTLY" || r.businessStatus === "CLOSED_TEMPORARILY") {
        closedIds.push(`${id}(${r.businessStatus})`);
        console.warn(`  [warn] ${id}: Google の営業状況が ${r.businessStatus}(閉店の疑い・要人力確認)`);
      }
    } else if (r && r.invalid) {
      // place_id 無効: 以後ローテーションで回り続けないよう updatedAt は進め、評価は null にする。
      ratings[id] = { rating: null, userRatingCount: 0, businessStatus: null, updatedAt: now, note: "place_id_invalid" };
      updated++;
      invalidCount++;
      console.warn(`  [warn] ${id}: place_id が無効な可能性(要レビュー)`);
    } else {
      // 一時的な通信エラー: updatedAt を進めず、次回リトライ(このバッチ分は消費)。
      transientSkip++;
    }
    if (i < selected.length - 1) await sleep(SLEEP_MS);
  }

  // venueId でソートして安定出力。
  const sorted = {};
  for (const k of Object.keys(ratings).sort()) sorted[k] = ratings[k];
  fs.writeFileSync(OUT_FILE, JSON.stringify(sorted, null, 2) + "\n", "utf-8");

  const totalWithRating = Object.values(sorted).filter((r) => typeof r.rating === "number").length;
  console.log(
    `[fetch-ratings] 今回更新: ${updated}件(うち評価あり ${withRating}件 / place_id無効 ${invalidCount}件 / 通信エラーで次回持越 ${transientSkip}件)`
  );
  console.log(`[fetch-ratings] 累計で評価を保持している店: ${totalWithRating}件 / ${candidates.length}件`);
  console.log(`[fetch-ratings] ${path.relative(ROOT, OUT_FILE)} を更新しました。`);
}

main().catch((e) => {
  // 予期しない例外でもCI全体は止めない(ratings.json はそのまま=状態は壊さない)。
  console.warn(`[fetch-ratings] 予期しないエラー: ${e.message}. ratings.json は変更せず続行します。`);
});
