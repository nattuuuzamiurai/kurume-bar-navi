#!/usr/bin/env node
/**
 * 店舗写真フェッチスクリプト(ホットペッパー グルメ Webサービス)
 *
 * data/venues.json の各店の sources[].url からホットペッパーの店舗ID(strJxxxxxx)を
 * 正規表現で抽出し、ホットペッパー グルメAPIを **ID直接引き** で叩いて店の代表写真1枚
 * (shop.photo.pc.l)、店のロゴ画像(shop.logo_image)、店舗ページURL(shop.urls.pc)を収集する。
 *
 * 出力: data/photos.generated.json  (venue id -> { photo?, logo?, hpUrl })
 *   - photo / logo はどちらか一方だけ登録されている店もある(存在するフィールドのみ書き出す)。
 *   - このファイルは .gitignore 対象(コミットしない)。CIで毎回生成=常に最新。
 *   - 画像ファイルは保存しない。URL(imgfp.hotp.jp)のみ(ホットリンク表示は build.js 側で行う)。
 *
 * 【なぜ店名検索を使わないか】店名の曖昧一致は別店舗の写真を誤掲載するリスクがあるため、
 * sources に登録済みのホットペッパー店舗IDでの直接引きのみに限定する(README準拠)。
 *
 * APIキー: process.env.HOTPEPPER_API_KEY
 *   - 未設定なら **空マップを書き出して正常終了**(Secret未設定のCI・ローカルでもビルドが通る)。
 *   - キーはコード・コミット・ログに一切出さない(GitHub Secrets / 環境変数のみ)。
 *
 * 実行方法:
 *   HOTPEPPER_API_KEY=xxxx node scripts/fetch-photos.js
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const VENUES_FILE = path.join(DATA_DIR, "venues.json");
const OUT_FILE = path.join(DATA_DIR, "photos.generated.json");

const API_BASE = "https://webservice.recruit.co.jp/hotpepper/gourmet/v1/";
// ホットペッパー店舗ID: URL中の /str<英字1文字+数字列> を拾う。例 strJ000604272 -> J000604272
const HP_ID_RE = /hotpepper\.jp\/str([A-Za-z]\d+)/i;
// レートに優しくするための逐次リクエスト間ウェイト(ms)。全店でも約114件なので数十秒で終わる。
const SLEEP_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

// ホットペッパーの「画像なし」共通ダミー画像(例:
// https://imgfp.hotp.jp/SYS/cmn/images/common/diary/custom/m30_img_noimage.gif)を除外する。
// logo_image は未登録店でもこのプレースホルダーが返るため、そのままロゴに使うと汎用の
// 「NO IMAGE」画像が表示されてしまう。実ロゴ・実写真はコンテンツ配信パス /IMGH/ 配下にあり、
// ダミーは /SYS/cmn/... の noimage 系なので、それらを弾く。
function isPlaceholderImage(u) {
  if (!u) return true;
  return /\/SYS\/cmn\//i.test(u) || /noimage|no_image|noimg|dummy/i.test(u);
}

// venues.json から { venueId -> hpId } を抽出(ID直接引きのみ)。
function collectHpIds(venues) {
  const map = new Map();
  for (const v of venues) {
    for (const s of v.sources || []) {
      const m = (s.url || "").match(HP_ID_RE);
      if (m) {
        map.set(v.id, m[1]);
        break; // 最初に見つかった1件を採用
      }
    }
  }
  return map;
}

// 「ネットワーク起因の失敗(リトライ対象)」を表すセンチネル。
// 正常応答で「写真なし」だった場合(=null)とは区別する。
const RETRY = Symbol("retry");

// ホットペッパーAPIをID直接引きで1回叩く。
//   成功(写真 or ロゴあり) -> { photo, logo, hpUrl }(無い方は空文字)
//   正常応答だが写真・ロゴなし/店舗なし -> null(リトライしない)
//   通信失敗・タイムアウト・非200 -> RETRY(呼び出し側で1回だけ再試行)
function fetchShopOnce(apiKey, hpId) {
  const params = new URLSearchParams({ key: apiKey, id: hpId, format: "json" });
  const reqUrl = `${API_BASE}?${params.toString()}`;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const req = https.get(reqUrl, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        // ステータスコードやレスポンスにキーが含まれることは無いが、
        // 念のため生レスポンスはログに出さない(万一の露出防止)。
        if (res.statusCode !== 200) {
          console.warn(`  [warn] ${hpId}: HTTP ${res.statusCode}`);
          return done(RETRY);
        }
        try {
          const data = JSON.parse(raw);
          const shop = data && data.results && data.results.shop && data.results.shop[0];
          if (!shop) return done(null);
          let photo = (shop.photo && shop.photo.pc && shop.photo.pc.l) || "";
          // ロゴ画像(shop.logo_image)。フル応答(type=lite以外)にのみ含まれる。
          // ID直接引きはフル応答なので取得できる。文字列でなければ無視する。
          let logo = (typeof shop.logo_image === "string" && shop.logo_image) || "";
          // 「画像なし」ダミーは実素材として扱わない(汎用NO IMAGE画像の掲載を防ぐ)。
          if (isPlaceholderImage(photo)) photo = "";
          if (isPlaceholderImage(logo)) logo = "";
          // 写真・ロゴのどちらも無ければ「素材なし」= リトライ不要の null。
          if (!photo && !logo) return done(null);
          const hpUrl = (shop.urls && shop.urls.pc) || "";
          done({ photo, logo, hpUrl });
        } catch (e) {
          console.warn(`  [warn] ${hpId}: JSONパース失敗 (${e.message})`);
          done(RETRY);
        }
      });
    });
    req.on("error", (e) => {
      console.warn(`  [warn] ${hpId}: リクエスト失敗 (${e.message})`);
      done(RETRY);
    });
    req.setTimeout(15000, () => {
      req.destroy();
      console.warn(`  [warn] ${hpId}: タイムアウト`);
      done(RETRY);
    });
  });
}

// ネットワーク起因の失敗のみ1回だけ再試行する(写真なしは再試行しない)。
async function fetchShop(apiKey, hpId) {
  let r = await fetchShopOnce(apiKey, hpId);
  if (r === RETRY) {
    await sleep(SLEEP_MS * 2);
    r = await fetchShopOnce(apiKey, hpId);
  }
  return r === RETRY ? null : r;
}

async function main() {
  const apiKey = process.env.HOTPEPPER_API_KEY;

  // Secret未設定でもビルドを止めない: 空マップを書いて正常終了。
  if (!apiKey) {
    console.log("[fetch-photos] HOTPEPPER_API_KEY が未設定のため、写真フェッチをスキップします(空マップを出力)。");
    fs.writeFileSync(OUT_FILE, JSON.stringify({}, null, 2) + "\n", "utf-8");
    console.log(`[fetch-photos] ${path.relative(ROOT, OUT_FILE)} を出力しました(0件)。`);
    return;
  }

  const venues = readJSON(VENUES_FILE);
  const hpIds = collectHpIds(venues);
  console.log(`[fetch-photos] ホットペッパーID直接引き対象: ${hpIds.size}件`);

  const out = {};
  let photoCount = 0;
  let logoCount = 0;
  let i = 0;
  for (const [venueId, hpId] of hpIds) {
    i++;
    const result = await fetchShop(apiKey, hpId);
    if (result && (result.photo || result.logo)) {
      // 存在するフィールドだけを書き出す(photo だけ / logo だけの店もあるため差分を最小化)。
      const entry = {};
      if (result.photo) entry.photo = result.photo;
      if (result.logo) entry.logo = result.logo;
      if (result.hpUrl) entry.hpUrl = result.hpUrl;
      out[venueId] = entry;
      if (result.photo) photoCount++;
      if (result.logo) logoCount++;
    }
    if (i < hpIds.size) await sleep(SLEEP_MS);
  }

  // idソートで安定した出力にする(差分比較しやすく)。
  const sorted = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  fs.writeFileSync(OUT_FILE, JSON.stringify(sorted, null, 2) + "\n", "utf-8");

  console.log(`[fetch-photos] 写真取得できた店数: ${photoCount}件 / ロゴ取得できた店数: ${logoCount}件 / 対象 ${hpIds.size}件`);
  console.log(`[fetch-photos] ${path.relative(ROOT, OUT_FILE)} を出力しました。`);
}

main().catch((e) => {
  // 予期しない例外でもビルド全体を止めないよう、空マップを保証したうえで非ゼロ終了はしない。
  console.warn(`[fetch-photos] 予期しないエラー: ${e.message}. 空マップを出力して続行します。`);
  try {
    fs.writeFileSync(OUT_FILE, JSON.stringify({}, null, 2) + "\n", "utf-8");
  } catch (_) {
    /* ignore */
  }
});
