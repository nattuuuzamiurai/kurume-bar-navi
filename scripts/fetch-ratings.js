#!/usr/bin/env node
/**
 * Googleクチコミ★評価 + Googleマップ店舗写真 ローリング更新スクリプト(Places API New)
 *
 * data/place-ids.json の place_id を使い、Place Details (New) で rating / userRatingCount /
 * photos を取得する。全店を一度に更新せず、更新日時(updatedAt)が最も古い(または未取得の)
 * 店から N 店だけを毎回更新する「ローリング更新」にすることで、無料枠を絶対に超えないようにする。
 *
 * ■ ①★評価(既存): Place Details の rating / userRatingCount を data/ratings.json に保存。
 *   GET https://places.googleapis.com/v1/places/{place_id}
 *   FieldMask: rating,userRatingCount,photos
 *   → rating を含む取得は Places API (New) Enterprise SKU。無料枠【月1,000回】。
 *     photos フィールドを FieldMask に足してもSKUは変わらない(SKUは最上位で決まる)ので **追加課金ゼロ**。
 *   1回の実行で最大 N 店(N = RATINGS_BATCH_SIZE、既定22、上限30にハードクランプ)。
 *   日次1回なので概ね 22×31=682回/月 < 1,000回(=$0)。
 *
 * ■ ②Googleマップ店舗写真(2026-07-28 追加、社長承認「無料なら実践」):
 *   上の Place Details 応答に含まれる photos[0].name(=photo resource name)を使い、
 *   GET https://places.googleapis.com/v1/{photoName}/media?maxWidthPx=800&skipHttpRedirect=true
 *   を叩いて表示用URL(photoUri = lh3.googleusercontent.com…)を得る。この「実画像取得」だけが
 *   別SKU(Place Photo)で、無料枠は【月1,000回】(★評価の枠とは別)。
 *   - **対象は「公式ロゴ(VENUE_LOGOS)にもホットペッパー logo_image にも無いロゴなし店」だけ**
 *     (=サイト上でネームタイルになる店)。ロゴがある店には写真を出さない=無駄に叩かない。
 *   - **日次の取得件数を上限クランプ**(PHOTOS_DAILY_MAX、既定20、上限30=30×31=930回/月<1,000回)。
 *     ★評価の枠とは別だが、安全側で同じ上限にしている。**この上限は $0 を守る安全装置。引き上げないこと。**
 *   - 出力 data/google-photos.json には **表示用の photoUri と投稿者attribution(displayName/uri)だけ**を
 *     保存する。**画像バイナリ・photo name(参照)は保存しない**(Google規約: 保存/キャッシュ禁止)。
 *   - lh3 URL は失効前提。ローリング(google-photos の updatedAt が古い店から)で取り直す。
 *     build.js は失効時 <img onerror> でネームタイルにフォールバックする。
 *
 * ■ APIキー: process.env.GOOGLE_PLACES_API_KEY(GitHub Secrets / 環境変数のみ)。
 *   未設定なら何もせず正常終了(グレースフル)。キーは X-Goog-Api-Key ヘッダで渡し、URL・ログに出さない。
 *
 * ■ 出力:
 *   - data/ratings.json      { [venueId]: { rating, userRatingCount, updatedAt } }
 *   - data/google-photos.json{ [venueId]: { photoUri, attributions:[{displayName,uri}], updatedAt } }
 *
 * ■ 実行方法
 *   GOOGLE_PLACES_API_KEY=xxxx RATINGS_BATCH_SIZE=5 node scripts/fetch-ratings.js
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { publishedVenues } = require("./lib/published");
const { VENUE_LOGOS } = require("./lib/venue-logos");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const VENUES_FILE = path.join(DATA_DIR, "venues.json");
const PLACE_IDS_FILE = path.join(DATA_DIR, "place-ids.json");
const OUT_FILE = path.join(DATA_DIR, "ratings.json");
const PHOTOS_HP_FILE = path.join(DATA_DIR, "photos.generated.json"); // ホットペッパー logo 判定用(存在すれば)
const PHOTOS_OUT_FILE = path.join(DATA_DIR, "google-photos.json");

const API_BASE = "https://places.googleapis.com/v1/";
const DETAILS_BASE = API_BASE + "places/";
const SLEEP_MS = 250;

// ①★評価: 1回の実行で更新する店数 N。無料枠(月1,000回)を守るため MAX_BATCH でクランプ。
const DEFAULT_BATCH = 22;
const MAX_BATCH = 30; // 30 × 31日 = 930回/月 < 1,000回(無料枠)。$0を守る安全装置。引き上げないこと。
const BATCH_SIZE = Math.min(
  MAX_BATCH,
  Math.max(1, parseInt(process.env.RATINGS_BATCH_SIZE || String(DEFAULT_BATCH), 10) || DEFAULT_BATCH)
);

// ②写真: 1回の実行で「実画像取得(Place Photo media)」を叩く最大件数。
// PHOTOS_MAX_DAILY は $0(月<1,000回)を守る安全装置。30 × 31日 = 930回/月 < 1,000回。引き上げないこと。
const PHOTOS_DEFAULT_DAILY = 20;
const PHOTOS_MAX_DAILY = 30;
const PHOTOS_DAILY = Math.min(
  PHOTOS_MAX_DAILY,
  Math.max(0, parseInt(process.env.PHOTOS_DAILY_MAX || String(PHOTOS_DEFAULT_DAILY), 10) || PHOTOS_DEFAULT_DAILY)
);
const PHOTO_MAX_WIDTH = 800;

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

// Place Details を1回叩く。FieldMask に photos を含める(SKUは変わらない=$0)。
//   成功 -> { rating:Number|null, userRatingCount:Number, photoName:String|null, photoAttributions:Array }
//   place_id無効(404/400) -> { invalid: true, status }
//   通信/その他エラー(リトライ対象) -> { error: true, status }
function fetchDetailsOnce(apiKey, placeId) {
  const u = new URL(DETAILS_BASE + encodeURIComponent(placeId));
  const options = {
    method: "GET",
    hostname: u.hostname,
    path: u.pathname,
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "rating,userRatingCount,photos",
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
            // 先頭の写真1枚だけ採用(1店1枚)。name は media 取得に使うだけで保存しない。
            let photoName = null;
            let photoAttributions = [];
            if (Array.isArray(data.photos) && data.photos.length > 0) {
              const p0 = data.photos[0];
              if (p0 && typeof p0.name === "string" && p0.name) {
                photoName = p0.name;
                photoAttributions = normalizeAttributions(p0.authorAttributions);
              }
            }
            return done({ rating, userRatingCount, photoName, photoAttributions });
          } catch (e) {
            console.warn(`  [warn] Place Details JSONパース失敗 (${e.message})`);
            return done({ error: true, status: 0 });
          }
        }
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

// authorAttributions([{displayName, uri, photoUri}, ...])から、保存してよい displayName / uri だけを抽出。
// (photoUri=投稿者アイコン等は保存不要。displayName が無いものは捨てる。)
function normalizeAttributions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    if (!a || typeof a.displayName !== "string" || !a.displayName) continue;
    const entry = { displayName: a.displayName };
    if (typeof a.uri === "string" && a.uri) entry.uri = a.uri;
    out.push(entry);
  }
  return out;
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

// Place Photo media を1回叩く(skipHttpRedirect=true でJSON応答)。
//   成功 -> { photoUri:String }(lh3.googleusercontent.com… の表示用URL。キーは含まれない)
//   その他 -> { error: true, status }
// キーは X-Goog-Api-Key ヘッダで渡す(URL・ログにキーを出さないため)。
function fetchPhotoMediaOnce(apiKey, photoName) {
  const u = new URL(`${API_BASE}${photoName}/media?maxWidthPx=${PHOTO_MAX_WIDTH}&skipHttpRedirect=true`);
  const options = {
    method: "GET",
    hostname: u.hostname,
    path: u.pathname + u.search,
    headers: { "X-Goog-Api-Key": apiKey },
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
            const photoUri = typeof data.photoUri === "string" ? data.photoUri : "";
            if (/^https:\/\/lh3\.googleusercontent\.com\//.test(photoUri)) {
              return done({ photoUri });
            }
            console.warn("  [warn] Place Photo media: photoUri が想定外(lh3 でない)");
            return done({ error: true, status: 0 });
          } catch (e) {
            console.warn(`  [warn] Place Photo media JSONパース失敗 (${e.message})`);
            return done({ error: true, status: 0 });
          }
        }
        console.warn(`  [warn] Place Photo media HTTP ${res.statusCode}`);
        return done({ error: true, status: res.statusCode });
      });
    });
    req.on("error", (e) => {
      console.warn(`  [warn] Place Photo media リクエスト失敗 (${e.message})`);
      done({ error: true, status: 0 });
    });
    req.setTimeout(15000, () => {
      req.destroy();
      console.warn("  [warn] Place Photo media タイムアウト");
      done({ error: true, status: 0 });
    });
    req.end();
  });
}

async function fetchPhotoMedia(apiKey, photoName) {
  let r = await fetchPhotoMediaOnce(apiKey, photoName);
  if (r && r.error) {
    await sleep(SLEEP_MS * 2);
    r = await fetchPhotoMediaOnce(apiKey, photoName);
  }
  return r;
}

async function main() {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.log("[fetch-ratings] GOOGLE_PLACES_API_KEY 未設定のためスキップします(ratings/google-photos は変更しません)。");
    return;
  }

  const placeIds = readJSONSafe(PLACE_IDS_FILE, {});
  const ratings = readJSONSafe(OUT_FILE, {});
  const googlePhotos = readJSONSafe(PHOTOS_OUT_FILE, {});
  const hpPhotos = readJSONSafe(PHOTOS_HP_FILE, {}); // 存在しなければ {}(ホットペッパーlogo判定は空扱い)
  const published = publishedVenues(readJSON(VENUES_FILE));
  const publishedIds = new Set(published.map((v) => v.id));
  // venueId -> venue(name/category を写真の付随情報に使わないが、将来の拡張用に保持)。
  const venueById = new Map(published.map((v) => [v.id, v]));

  // 「ロゴなし店(=サイト上でネームタイルになる店)」判定:
  //   公式ロゴ(VENUE_LOGOS)が無く、かつホットペッパー logo_image も無い。
  //   ※ photos.generated.json が無い環境(このジョブで fetch-photos 未実行など)では
  //     ホットペッパーlogoは空扱いになる。その場合 build.js 側も同じく空扱いなので表示と整合する。
  const isNameTileStore = (id) => {
    if (VENUE_LOGOS[id]) return false;
    const hp = hpPhotos[id];
    if (hp && typeof hp.logo === "string" && hp.logo) return false;
    return true;
  };

  // 有効な place_id を持ち、かつ現在公開対象の店だけを更新候補にする。
  const candidates = Object.keys(placeIds)
    .filter((id) => publishedIds.has(id))
    .filter((id) => placeIds[id] && typeof placeIds[id].placeId === "string" && placeIds[id].placeId.length > 0);

  console.log(`[fetch-ratings] place_id保有かつ公開中の候補: ${candidates.length}件 / ★更新上限 N=${BATCH_SIZE} / 写真取得上限=${PHOTOS_DAILY}/日`);
  if (candidates.length === 0) {
    console.log("[fetch-ratings] 更新対象なし(place-ids.json に有効な place_id がまだありません)。終了します。");
    return;
  }

  // ★評価の updatedAt が古い順(未取得=最優先)に並べ、先頭 N 店を選ぶ。
  const ratingSortKey = (id) => {
    const r = ratings[id];
    if (!r || !r.updatedAt) return "";
    return r.updatedAt;
  };
  const selected = candidates
    .slice()
    .sort((a, b) => {
      const ka = ratingSortKey(a);
      const kb = ratingSortKey(b);
      if (ka < kb) return -1;
      if (ka > kb) return 1;
      return a < b ? -1 : 1;
    })
    .slice(0, BATCH_SIZE);

  let updated = 0;
  let withRating = 0;
  let invalidCount = 0;
  let transientSkip = 0;

  // 写真候補: 選ばれた店のうち「ロゴなし店」で photoName が取れたもの。
  // { id, photoName, attributions }
  const photoCandidates = [];

  for (let i = 0; i < selected.length; i++) {
    const id = selected[i];
    const placeId = placeIds[id].placeId;
    const r = await fetchDetails(apiKey, placeId);
    const now = new Date().toISOString();

    if (r && !r.error && !r.invalid) {
      ratings[id] = { rating: r.rating, userRatingCount: r.userRatingCount, updatedAt: now };
      updated++;
      if (typeof r.rating === "number") withRating++;
      // ロゴなし店で写真がある場合のみ、media取得の候補に積む($0のPlace Details応答から取得済み)。
      if (r.photoName && isNameTileStore(id)) {
        photoCandidates.push({ id, photoName: r.photoName, attributions: r.photoAttributions || [] });
      }
    } else if (r && r.invalid) {
      ratings[id] = { rating: null, userRatingCount: 0, updatedAt: now, note: "place_id_invalid" };
      updated++;
      invalidCount++;
      console.warn(`  [warn] ${id}: place_id が無効な可能性(要レビュー)`);
    } else {
      transientSkip++;
    }
    if (i < selected.length - 1) await sleep(SLEEP_MS);
  }

  // ratings.json を安定出力(venueId昇順)。
  const sortedRatings = {};
  for (const k of Object.keys(ratings).sort()) sortedRatings[k] = ratings[k];
  fs.writeFileSync(OUT_FILE, JSON.stringify(sortedRatings, null, 2) + "\n", "utf-8");

  // ---- ②Googleマップ店舗写真の取得(無料枠内・上限クランプ・ローリング)----
  // 写真候補を「google-photos の updatedAt が古い順(未取得=最優先)」に並べ、上限 PHOTOS_DAILY まで media 取得。
  const photoSortKey = (id) => {
    const g = googlePhotos[id];
    if (!g || !g.updatedAt) return "";
    return g.updatedAt;
  };
  photoCandidates.sort((a, b) => {
    const ka = photoSortKey(a.id);
    const kb = photoSortKey(b.id);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return a.id < b.id ? -1 : 1;
  });

  let photosFetched = 0;
  const toFetch = photoCandidates.slice(0, PHOTOS_DAILY); // 上限クランプ($0保証)
  for (let i = 0; i < toFetch.length; i++) {
    const { id, photoName, attributions } = toFetch[i];
    const m = await fetchPhotoMedia(apiKey, photoName);
    if (m && m.photoUri) {
      // 保存するのは表示用の photoUri と投稿者attribution(displayName/uri)だけ。
      // photo name(参照)・画像バイナリは保存しない(Google規約: 保存/キャッシュ禁止)。
      googlePhotos[id] = {
        photoUri: m.photoUri,
        attributions: attributions,
        updatedAt: new Date().toISOString(),
      };
      photosFetched++;
    }
    // 失敗時は既存の photoUri を残す(次回ローリングで再挑戦)。
    if (i < toFetch.length - 1) await sleep(SLEEP_MS);
  }

  // 掃除: もう「ロゴなし公開店」でなくなった店(公式/ホットペッパーロゴが付いた・非公開になった等)の
  // 写真エントリは削除する(build.js は表示優先順位で弾くので実害はないが、データを綺麗に保つ)。
  for (const id of Object.keys(googlePhotos)) {
    if (!publishedIds.has(id) || !isNameTileStore(id)) {
      delete googlePhotos[id];
    }
  }

  // google-photos.json を安定出力(venueId昇順)。
  const sortedPhotos = {};
  for (const k of Object.keys(googlePhotos).sort()) sortedPhotos[k] = googlePhotos[k];
  fs.writeFileSync(PHOTOS_OUT_FILE, JSON.stringify(sortedPhotos, null, 2) + "\n", "utf-8");

  const totalWithRating = Object.values(sortedRatings).filter((r) => typeof r.rating === "number").length;
  console.log(
    `[fetch-ratings] ★今回更新: ${updated}件(評価あり ${withRating} / place_id無効 ${invalidCount} / 通信エラー持越 ${transientSkip})`
  );
  console.log(`[fetch-ratings] ★累計で評価を保持: ${totalWithRating}件 / ${candidates.length}件`);
  console.log(
    `[fetch-ratings] 📷写真: 候補${photoCandidates.length}件中 ${toFetch.length}件を取得試行→ ${photosFetched}件成功 / 保持総数 ${Object.keys(sortedPhotos).length}件`
  );
  console.log(`[fetch-ratings] ${path.relative(ROOT, OUT_FILE)} と ${path.relative(ROOT, PHOTOS_OUT_FILE)} を更新しました。`);
}

main().catch((e) => {
  // 予期しない例外でもCI全体は止めない(出力ファイルはそのまま=状態は壊さない)。
  console.warn(`[fetch-ratings] 予期しないエラー: ${e.message}. 出力ファイルは変更せず続行します。`);
});
