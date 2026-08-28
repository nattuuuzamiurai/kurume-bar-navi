#!/usr/bin/env node
/**
 * 久留米飲み屋ナビ 静的サイトビルドスクリプト
 *
 * data/*.json を読み込み、dist/ 配下に静的HTMLを生成する。
 * 外部ライブラリへの依存なし(Node.js標準モジュールのみ)。
 * GitHub Pages (https://<user>.github.io/kurume-bar-navi/) での配信を前提に、
 * すべての内部リンクに BASE_PATH を付与している。
 *
 * 実行方法: node scripts/build.js
 */

const fs = require("fs");
const path = require("path");

// 公開/非公開の判定は fetch 系スクリプトと共有する(単一の真実の源)。詳細は lib/published.js。
const { PUBLISHED_CATEGORIES, PHASE2_VENUE_IDS } = require("./lib/published");
// エリアガイド記事(content/guides/*.md)用の最小Markdown→HTML変換。詳細は lib/markdown.js。
const { parseGuideMarkdown } = require("./lib/markdown");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DIST_DIR = path.join(ROOT, "dist");
const ASSETS_DIR = path.join(ROOT, "assets");
const GUIDES_DIR = path.join(ROOT, "content", "guides");

const SITE_NAME = "久留米飲み屋ナビ";
const SITE_URL = "https://nattuuuzamiurai.github.io/kurume-bar-navi";
const BASE_PATH = "/kurume-bar-navi";

// Google Maps Embed API キー(place モードでGoogleのクチコミ★カードを地図枠内に出すために使う)。
// クライアント(iframe src)に載る性質のキーで、GitHub側でHTTPリファラー制限
// (nattuuuzamiurai.github.io/*)+API制限(Maps Embed APIのみ)がかかっており公開されても安全。
// ソースにはハードコードせず、必ず環境変数から読む(GitHub Secrets: GOOGLE_MAPS_EMBED_KEY)。
// 未設定(ローカル/未登録)の場合は従来のキーレス output=embed 形式にフォールバックする。
const GOOGLE_MAPS_EMBED_KEY = process.env.GOOGLE_MAPS_EMBED_KEY || "";

// 連絡先(掲載内容の追加・修正・削除依頼の受付先)。
// 2026-07-29 解決済み: 社長が用意した実運用のGoogleフォームに差し替え(旧ダミーメールを廃止)。
// 未ログインでも開けることを検証済みの公開フォームURL。削除依頼導線はすべてこのフォームへの通常リンク
// (mailto: は使わない)。経緯は data/venue-audit-log.md(2026-07-29 エントリ)にも記録。
const CONTACT_FORM_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSd6HX-N40kxZesknWaLnHHPjwHTwxK3wnAUsQm4zC8fDXBu7A/viewform";

// 削除依頼フォームへのリンク(<a>タグ)を生成するヘルパー。
// label はリンクテキスト(例: "こちらのお問い合わせフォーム")。rel/target で外部リンクとして安全に開く。
function contactFormLink(label) {
  return `<a href="${CONTACT_FORM_URL}" rel="nofollow noopener" target="_blank">${escapeHtml(label)}</a>`;
}

// 公開対象の業態allowlist(PUBLISHED_CATEGORIES)と店舗単位フェーズ2(PHASE2_VENUE_IDS)は
// scripts/lib/published.js に集約し、fetch 系スクリプトと共有している(単一の真実の源)。
// 詳しい方針・各IDの理由はそのファイルのコメントを参照。

// 営業状況を確認できていない店舗(削除はしないが、店舗ページに注記を出し、
// 未確認の営業時間は「情報準備中」に寄せて「営業中」判定・営業時間表示に使わない)。
// data/venues.json 側で hours/closedDays は既に null 化済み(=facet・バッジからも自動的に外れる)。
const UNVERIFIED_VENUE_IDS = new Set([
  // 食べログが「掲載保留」=営業状況未確認
  "izakaya-pachino",
  "izakaya-kairakutei",
  "izakaya-omoni",
  // 出典がInstagramのみで、Instagram側が投稿日取得をブロックしており最終更新を確認できない
  // (閉店の証拠もないため注記付きで掲載継続)
  // ※poker-ace-and-king(A&K)は2026-07-24 社長確認により営業中と確定したため解除。
  //   ただし詳細な営業データ(営業時間等)は未取得のままなのでnull据え置き。
  "shisha-0942",
  // 2026-07-29 の閉店確認(concafe/shisha 11店の全数確認)で、閉店の証拠は見つからなかったが
  // 営業中の裏付けも取れなかった3店。いずれも「Googleに施設登録がない + 情報源がアグリゲーター
  // サイト1〜2本のみ + 確認できる一次情報が1年以上前」という、過去に閉店を見落とした
  // CASINO Bar ACES と同じプロファイル。削除はせず注記付きで掲載継続する。
  // 詳細は data/venue-audit-log.md「2026-07-29(コンカフェ・シーシャ11店 閉店確認)」参照。
  "concafe-soul-one",
  "concafe-neko-maid-seven",
  "shisha-aima",
  // ------------------------------------------------------------------
  // 2026-07-30 社長判断により公開。確度C=1系統のみで営業実態未確認のため注記付き。
  //
  // 接待を伴う業態(スナック・キャバクラ・ラウンジ・クラブ・ガールズバー)144店の公開に伴い、
  // data/venues.json の verification が "C"(= 独立した情報源が1系統のみで、営業実態の裏取りが
  // 取れていない)の62店をここに登録する。営業時間・定休日は data/venues.json 側で null 化済みで、
  // 「今営業中」の絞り込み・営業中バッジ・営業時間表示から自動的に外れる。
  // 内訳: snack 21 / kyabakura 13 / lounge 13 / club 7 / girlsbar 8。
  // ------------------------------------------------------------------
  // snack (21件)
  "snack-koto", "snack-hanaakari", "snack-lavender",
  "snack-escargot", "snack-rion", "snack-70",
  "snack-status", "snack-reims", "snack-anew",
  "snack-lemon", "snack-shin-members", "snack-courage",
  "snack-pearl", "snack-amore", "snack-lapin",
  "snack-berry", "snack-rin", "snack-saito",
  "snack-calm", "snack-the-ritz", "snack-a-king",
  // kyabakura (13件)
  "kyabakura-kurume-rikyu", "kyabakura-club-g", "kyabakura-cordoba",
  "kyabakura-precious", "kyabakura-mary", "kyabakura-ariel",
  "kyabakura-nestia", "kyabakura-premier", "kyabakura-rudan",
  "kyabakura-all", "kyabakura-vega", "kyabakura-loop-vip",
  "kyabakura-lounge-loop",
  // lounge (13件)
  "lounge-aoi", "lounge-st-christopher", "lounge-rebo",
  "lounge-athena", "lounge-indigo", "lounge-sky",
  "lounge-lepin", "lounge-amon", "lounge-shion",
  "lounge-sugar", "lounge-jewel", "lounge-ai-spaed",
  "lounge-zen",
  // club (7件)
  "club-313", "club-cube", "club-r",
  "club-winx", "club-the-member", "club-ari",
  "club-kou",
  // girlsbar (8件)
  "girlsbar-8eight", "girlsbar-hrb", "girlsbar-all-new-ace",
  "girlsbar-pallas", "girlsbar-baccara", "girlsbar-bully",
  "girlsbar-secret", "girlsbar-family",
  // ------------------------------------------------------------------
  // 2026-08-22: エリアガイド公開作業(社長指示(2))のビルド確認中に、fetch-ratings.js の
  // ローリング更新(chore(ratings)コミット、2026-08-13〜18)が Google businessStatus を
  // CLOSED_PERMANENTLY/CLOSED_TEMPORARILY と返している4店を検知した。build.js は既存方針どおり
  // 自動delistはしないが、営業状況未確認として掲載し続けるのはリスクなのでここに追加する。
  // 詳細は data/venue-audit-log.md「2026-08-22」参照。
  "bar-cupanddish", "izakaya-buonricordo", "lounge-new-impact", "snack-orfe",
  // 2026-08-27: PR #48(editorial-notes)のQAレビューで発覚。izakaya-bonbori は
  // data/ratings.json の2026-08-23更新でGoogle businessStatusが CLOSED_TEMPORARILY を
  // 返している(ビルド時のwarnログにも出力済み)が未登録だった。本PR自体のバグではなく
  // 既存のギャップだが、発見した以上ここで解消する。
  "izakaya-bonbori",
]);
function todayJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}
const BUILD_DATE = todayJST();

function readJSON(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf-8"));
}

// 店舗ページに載せる編集部コメント(店舗ID → コメント文)。任意項目で、無い店舗も多い。
// コンテンツ制作部が data/venues.json の既存情報(タグ・営業時間・予算等)をもとに作成したもの。
const EDITORIAL_NOTES = readJSON("editorial-notes.json");

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function url(p) {
  // p は "/" から始まる絶対パス想定
  return `${BASE_PATH}${p}`;
}

function absoluteUrl(p) {
  return `${SITE_URL}${p}`;
}

// タグ名をURL/ディレクトリ名として使える形に変換する(例: "海鮮/魚介" -> "海鮮-魚介")。
// 表示上のタグ名(日本語)はそのまま保持し、パスにのみ使う。
function tagSlug(tag) {
  return tag.replace(/[\/\\:*?"<>|]/g, "-");
}

// ============================================================
// カテゴリごとのアイコン・差し色
//
// 【重要】実店舗の写真は一切使用しない。他サイト(食べログ・ホットペッパー・Retty等)の
// 写真を転載することは著作権リスクがあるため、社長方針により禁止されている。
// 代わりに、業態を表す汎用的な線画アイコン(自作のシンプルなSVG図形)をカードの
// ビジュアル要素として使い、視覚的なボリュームを補う。特定の店舗の実際の外観・内観を
// 表すものではなく、あくまで「業態を示す一般的なピクトグラム」であることを明確にするため、
// 実写のような装飾は避けている。
// ============================================================
// 業態カラー(2026-07-23 デザイン刷新: 明るめ藍色ベースに映える鮮やかトーンへ)。
// 社長承認済みの見本(redesign-prototype.html)の値を採用。
const CATEGORY_COLORS = {
  bar: "#9d8dff",
  izakaya: "#ff8a5c",
  concafe: "#ff85bd",
  shisha: "#3fd7b6",
  poker: "#5ad07a",
  // --- 2026-07-30 公開開始の5業態 ---
  // 【色の選び方】既存5業態(バー=紫250°/居酒屋=橙18°/コンカフェ=桃330°/シーシャ=青緑166°/
  // ポーカー=緑135°)と、リンク色のアンバー(--lantern 38°)から色相を離して選んだ。
  // 旧値はスナック=#e0b24a・クラブ=#f2c14e が同系の金色、キャバクラ=#ff7ab0・ガールズバー=#ff9ec4 が
  // コンカフェの桃色とほぼ同じで、一覧で並べたときに見分けがつかなかったため入れ替えている。
  // クラブのみ有彩色の空きが無かったため、彩度を落としたプラチナ系(ほぼ無彩色)で差別化した。
  snack: "#c3e04a", // イエローグリーン(72°)
  kyabakura: "#e36fe8", // マゼンタ(298°)
  lounge: "#4fc0f0", // スカイブルー(198°)
  club: "#cbd5e8", // プラチナシルバー(ほぼ無彩色)
  girlsbar: "#ff5f6d", // コーラルレッド(355°)
};

// 業態アイコン。見本のライン(24x24・stroke)スタイルに刷新。currentColor で業態カラーに追従。
const CATEGORY_ICONS = {
  // カクテルグラス
  bar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3h14l-7 8z"/><path d="M12 11v8"/><path d="M8 21h8"/></svg>`,
  // 提灯(ちょうちん)
  izakaya: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v2"/><rect x="6" y="5" width="12" height="14" rx="6"/><path d="M6 9h12M6 15h12"/><path d="M12 19v3"/></svg>`,
  // カップ+湯気
  concafe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 9h2a2 2 0 0 1 0 4h-2"/><path d="M10.5 3.5c.6.6.6 1.4 0 2M13.5 4.5c.4.4.4 1 0 1.4"/></svg>`,
  // シーシャ(水タバコ)
  shisha: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21h-2a4 4 0 0 1-4-4v-3h8v3"/><path d="M10 14V7a2 2 0 0 1 4 0c0 3 3 2 3 5"/><path d="M8 21h8"/><path d="M8 4c.7.6.7 1.4 0 2"/></svg>`,
  // スペード(カード/ポーカー)
  poker: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3c3 4 7 6.5 7 10a3.4 3.4 0 0 1-6 2.4c.4 2.2 1 3 2.2 4.1H8.8c1.2-1.1 1.8-1.9 2.2-4.1A3.4 3.4 0 0 1 5 13c0-3.5 4-6 7-10z"/></svg>`,
  // --- 2026-07-30 公開開始の5業態(いずれも既存アイコンと形が重ならないものを割り当てている) ---
  // 音符(カラオケ)
  snack: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>`,
  // ティアラ
  kyabakura: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8l3 9h10l3-9-5 4-3-6-3 6z"/></svg>`,
  // ソファ
  lounge: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4"/><path d="M3 12a2 2 0 0 1 4 0v3h10v-3a2 2 0 0 1 4 0v6H3z"/></svg>`,
  // ワイングラス2つ(乾杯)
  club: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h6l-2 7a2.5 2.5 0 0 1-2 0z"/><path d="M14 4h6l-2 7a2.5 2.5 0 0 1-2 0z"/><path d="M7 11v8M17 11v8"/><path d="M5 21h4M15 21h4"/></svg>`,
  // ビアグラス
  girlsbar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h9v13H7z"/><path d="M16 10h3v6h-3"/><path d="M7 7a2.5 2.5 0 0 1 2-4 2.5 2.5 0 0 1 4-.5 2.5 2.5 0 0 1 3 4.5"/></svg>`,
};

// UI用アイコン(タブバー・factsグリッド等)。見本のセットをそのまま採用。
const UI_ICONS = {
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="M20 20l-3.5-3.5"/></svg>`,
  pin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z"/><circle cx="12" cy="10" r="2.4"/></svg>`,
  tag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8.5" cy="8.5" r="1.4"/></svg>`,
  grid: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>`,
  yen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 5l5 7 5-7"/><path d="M12 12v7"/><path d="M8 14h8M8 17h8"/></svg>`,
  card: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/></svg>`,
  smoke: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17h13v3H3z"/><path d="M18 17v3M21 17v3"/><path d="M14 8c2 0 2-3 0-3M17 11c2.5 0 2.5-4 0-4"/></svg>`,
  seat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 11V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v5"/><path d="M4 11h16v5H4z"/><path d="M6 16v3M18 16v3"/></svg>`,
  cal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 9h16M8 3v4M16 3v4"/></svg>`,
  phone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h3l2 5-2.5 1.5a11 11 0 0 0 5 5L17 12l5 2v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4 6.2 2 2 0 0 1 6 4z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>`,
  walk: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="13" cy="4.5" r="1.6"/><path d="M11 21l1.5-6-2.5-2 1-5 3 2 2 1"/><path d="M9.5 13l-1.5 3-2 1"/></svg>`,
};

function uiIcon(name, cls) {
  const svg = UI_ICONS[name] || "";
  return cls ? `<span class="${cls}">${svg}</span>` : svg;
}

function categoryIconHtml(categoryId) {
  const icon = CATEGORY_ICONS[categoryId];
  if (!icon) return "";
  const color = CATEGORY_COLORS[categoryId] || "#9d8dff";
  return `<div class="venue-visual" style="--cat-color:${color}">${icon}</div>`;
}

// ============================================================
// 料理ジャンルの併記
//
// izakaya カテゴリには焼肉・イタリアン・中華・韓国料理等が含まれるため、業態表示を
// 「居酒屋(焼肉)」のように料理ジャンルを併記して分かりやすくする。tags のうち
// 「料理ジャンルを表すタグ」だけを CUISINE_TAGS で判定する(設備・利用シーン・飲み物
// タグは対象外)。表示ラベルの変更のみで、JSON-LD の @type(schemaType)は変更しない。
// バー/コンカフェ/シーシャ/ポーカーは対象外(izakaya のみ併記)。
// ============================================================
const CUISINE_TAGS = new Set([
  "焼肉", "ホルモン", "焼き鳥", "串焼き", "つくね", "鶏料理", "手羽先",
  "もつ鍋", "鍋料理", "海鮮/魚介", "焼き魚", "おでん", "天ぷら", "餃子",
  "中華", "韓国料理", "イタリアン", "スペイン料理", "タイ料理", "ピザ",
  "ビストロ", "グリル", "肉料理", "鉄板料理", "もんじゃ焼き", "炉端焼き",
  "沖縄料理", "郷土料理", "九州料理", "屋台",
  // 2026-07-25 掲載漏れ24店の追加にともない、その店の看板となる料理ジャンルを併記できるよう追加。
  // いずれも既存の公開店舗では未使用のタグのため、既存店の業態表示ラベルには影響しない。
  "唐揚げ", "串カツ", "しゃぶしゃぶ", "水炊き", "ステーキ", "肉寿司", "馬刺し", "ラーメン",
  // 2026-07-27 鉄板居酒屋 基地(お好み焼き店)の追加にともない併記。
  // どちらも既存の公開店舗では未使用のタグのため、既存店の業態表示ラベルには影響しない。
  "お好み焼き", "鉄板焼き",
]);

// 店舗の料理ジャンル併記文字列を返す(izakaya かつ料理ジャンルタグがある場合のみ。
// 代表として tags 配列の先頭順で最大2個まで)。それ以外は空文字。
function cuisineLabelFor(v) {
  if (v.category !== "izakaya") return "";
  const cuisines = (v.tags || []).filter((t) => CUISINE_TAGS.has(t)).slice(0, 2);
  return cuisines.join("・");
}

// 業態表示ラベル。料理ジャンル併記がある場合は「居酒屋(焼肉)」のように付す。
function categoryLabel(v, categoryName) {
  const c = cuisineLabelFor(v);
  return c ? `${categoryName}(${c})` : categoryName;
}

// ============================================================
// 店舗詳細情報の機械可読化(2026-07-22)
//
// data/venues.json は「出典の表記をそのまま残した日本語の文字列」を正とし(人が読んで
// 検証できる形を1か所に保つため)、絞り込み検索に必要な機械可読データは、ここで
// ビルド時に文字列からパースして生成する。パースできなかった店舗はその条件での
// 絞り込み対象から外れるだけで、表示(文字列)は従来どおり出る。
// パース結果の件数・失敗した文字列はビルドログに出力し、目視で検証できるようにしている。
// ============================================================

// 曜日文字 → JavaScript の Date#getDay() の値(日=0)
const DAY_TO_INDEX = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };
const JP_WEEK_ORDER = ["月", "火", "水", "木", "金", "土", "日"];
const ALL_DAY_CHARS = "月火水木金土日";

function normalizeText(s) {
  return String(s)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ":")
    .replace(/[～~]/g, "〜");
}

// 「(水〜日)」のように曜日だけが入った括弧は中身を残し、それ以外の括弧注記(L.O.等)は落とす。
function stripHoursNotes(s) {
  return s
    .replace(/[（(]([^）)]*)[）)]/g, (m, inner) =>
      /^[月火水木金土日祝前・、,〜\s]+$/.test(inner) ? inner : ""
    )
    .replace(/※.*$/g, "")
    .replace(/(ランチ|ディナー|カフェ|ハッピーアワー|バータイム|昼|夜)/g, "")
    .trim();
}

// 曜日表記(例: "月〜水・金〜日", "土日", "全日")を getDay() の配列に展開する。
function expandDayTokens(token) {
  let t = token
    .replace(/全日|毎日|終日|年中無休/g, ALL_DAY_CHARS)
    .replace(/平日/g, "月火水木金")
    .replace(/祝前日|祝前|祝日|祝/g, "");
  const days = new Set();
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (!(c in DAY_TO_INDEX)) continue;
    if (t[i + 1] === "〜" && t[i + 2] in DAY_TO_INDEX) {
      const from = JP_WEEK_ORDER.indexOf(c);
      const to = JP_WEEK_ORDER.indexOf(t[i + 2]);
      for (let k = 0; k < 7; k++) {
        const idx = (from + k) % 7;
        days.add(DAY_TO_INDEX[JP_WEEK_ORDER[idx]]);
        if (idx === to) break;
      }
      i += 2;
    } else {
      days.add(DAY_TO_INDEX[c]);
    }
  }
  return [...days];
}

const TIME_RANGE_RE = /(翌)?(\d{1,2}):(\d{2})\s*〜\s*(?:(翌)?(\d{1,2}):(\d{2})|(LAST|Last|last|ラスト))?/g;

// 営業時間文字列 + 定休日文字列 → [{day, start, end, fuzzyEnd}] (分単位。深夜は24:00超で表現)
function parseSchedule(hours, closedDays) {
  if (!hours) return { slots: [], parsed: false, fuzzy: false };
  const text = stripHoursNotes(normalizeText(hours));
  const closed = new Set(parseClosedDays(closedDays));
  const chunks = text.split("/");
  const slots = [];
  let fuzzy = false;
  let currentDays = null;
  for (const rawChunk of chunks) {
    const chunk = rawChunk.trim();
    if (!chunk) continue;
    const dayMatch = chunk.match(/^[月火水木金土日祝前全毎平終年中無休・、,〜\s]+/);
    let days = dayMatch ? expandDayTokens(dayMatch[0]) : [];
    if (days.length > 0) currentDays = days;
    else days = currentDays || expandDayTokens(ALL_DAY_CHARS);

    TIME_RANGE_RE.lastIndex = 0;
    let m;
    while ((m = TIME_RANGE_RE.exec(chunk)) !== null) {
      let start = Number(m[2]) * 60 + Number(m[3]) + (m[1] ? 1440 : 0);
      let end;
      let fuzzyEnd = false;
      if (m[5] !== undefined) {
        end = Number(m[5]) * 60 + Number(m[6]) + (m[4] ? 1440 : 0);
        if (end <= start) end += 1440;
      } else {
        // 「20:00〜LAST」など終了時刻が公開されていないもの。深夜5:00までを暫定の枠として扱い、
        // 画面上は「終了時刻不明」と明示する(勝手に閉店時刻を断定しないため)。
        end = 29 * 60;
        if (end <= start) end = start + 60;
        fuzzyEnd = true;
        fuzzy = true;
      }
      for (const d of days) {
        if (closed.has(d)) continue;
        slots.push({ day: d, start, end, fuzzyEnd });
      }
    }
  }
  return { slots, parsed: slots.length > 0, fuzzy };
}

// 定休日文字列 → getDay() の配列。「第2・第4木曜」のような隔週指定は週次の休みとして扱わない。
function parseClosedDays(s) {
  if (!s) return [];
  let t = normalizeText(s).replace(/[（(][^）)]*[）)]/g, "");
  if (/^(なし|無休|年中無休)/.test(t.trim())) return [];
  t = t.replace(/第[\d]+(?:[・,、]第?[\d]+)*(?:週)?[月火水木金土日]曜?日?/g, "");
  t = t.replace(/祝前日|祝前|祝日|祝/g, "");
  const days = new Set();
  for (const c of t) if (c in DAY_TO_INDEX) days.add(DAY_TO_INDEX[c]);
  return [...days];
}

// 予算文字列 → { min, max }(円)。「〜3000円」「2001〜3000円」「3500円」等に対応。
function parseBudget(s) {
  if (!s) return null;
  const t = normalizeText(s).replace(/[（(][^）)]*[）)]/g, "").replace(/,/g, "");
  let m = t.match(/(\d{3,6})\s*円?\s*〜\s*(\d{3,6})/);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  m = t.match(/〜\s*(\d{3,6})/);
  if (m) return { min: 0, max: Number(m[1]) };
  m = t.match(/(\d{3,6})\s*円\s*〜/);
  if (m) return { min: Number(m[1]), max: 100000 };
  m = t.match(/(\d{3,6})/);
  if (m) return { min: Number(m[1]), max: Number(m[1]) };
  return null;
}

const BUDGET_BUCKETS = [
  { value: "0-2000", label: "〜2000円", min: 0, max: 2000 },
  { value: "2000-3000", label: "2000〜3000円", min: 2000, max: 3000 },
  { value: "3000-4000", label: "3000〜4000円", min: 3000, max: 4000 },
  { value: "4000-", label: "4000円〜", min: 4000, max: 100000 },
];

function budgetBucketsFor(v) {
  const b = parseBudget(v.budgetDinner);
  if (!b) return [];
  return BUDGET_BUCKETS.filter((x) => b.min <= x.max && b.max >= x.min).map((x) => x.value);
}

// 支払い方法の文字列 → ["card", "cashless", "cash"] のトークン
function paymentTokens(s) {
  if (!s) return [];
  const t = normalizeText(s);
  const tokens = [];
  const cashOnly = /現金のみ/.test(t);
  if (cashOnly) {
    tokens.push("cash");
    return tokens;
  }
  const card = !/カード不可/.test(t) && (/カード可/.test(t) || /VISA|Visa|JCB|Master|MASTER|AMEX|Amex|ダイナース/.test(t));
  const emoney = /電子マネー可|楽天Edy|QUICPay|iD|交通系/.test(t) && !/電子マネー不可/.test(t);
  const qr = /QR可|QRコード決済可|PayPay可|PayPay|d払い|auPay|楽天ペイ|スマート支払い/.test(t);
  if (card) tokens.push("card");
  if (card || emoney || qr) tokens.push("cashless");
  // カード・電子マネー・QRのいずれも「不可」と明記されている場合は実質的に現金のみ
  if (tokens.length === 0 && /カード不可/.test(t) && /電子マネー不可/.test(t) && /QR不可|PayPay不可/.test(t)) {
    tokens.push("cash");
  }
  return tokens;
}

// 喫煙可否の文字列 → "no"(禁煙) / "mixed"(分煙) / "yes"(喫煙可)
function smokingToken(s) {
  if (!s) return "";
  const t = normalizeText(s);
  const fullNoSmoking = /全席禁煙|店内全面禁煙|店内禁煙|全面禁煙/.test(t);
  if (/分煙/.test(t)) return "mixed";
  if (!fullNoSmoking && /禁煙/.test(t) && /喫煙可|喫煙OK/.test(t)) return "mixed";
  if (fullNoSmoking || /^禁煙/.test(t.trim())) return "no";
  if (/喫煙可|喫煙OK/.test(t)) return "yes";
  return "";
}

// チャージ/お通しの文字列が「なし(無料)」を明言しているか。
// 時間帯・条件によっては料金が発生する店(例: 「Cafe Timeはチャージ無料、Bar Timeは550円」)を
// 「なし」と誤って断定しないよう、チャージ/お通し/席料の金額表記が併記されている場合は対象外にする。
function isChargeFree(s) {
  if (!s) return false;
  const t = normalizeText(s);
  const declaresFree = /お通し(代|料)?(は)?(なし|無し|無料)|チャージ(料|代)?(は)?(なし|無し|無料|不要)|席料(は)?(なし|無し|無料)|お席料なし/.test(t);
  const hasAmount = /(チャージ|お通し|席料|サービス料)[^、。]{0,12}\d+\s*円/.test(t);
  return declaresFree && !hasAmount;
}

// ============================================================
// 「写真を見る」外部リンク(出典元での閲覧に誘導する。写真そのものは転載しない)
// 写真が充実している傾向のあるサイトを優先的に選ぶ。
// ============================================================
const PHOTO_RICH_DOMAINS = [
  "instagram.com",
  "retty.me",
  "hotpepper.jp",
  "tabelog.com",
  "con-ca.jp",
  "concafe-ranking.jp",
  "cafecon.jp",
  "tiktok.com",
  "pokepara.jp",
  "town-night.jp",
  "caba2.net",
];

function pickPhotoSource(v) {
  const sources = v.sources || [];
  for (const domain of PHOTO_RICH_DOMAINS) {
    const found = sources.find((s) => s.url.includes(domain));
    if (found) return found;
  }
  return sources[0] || null;
}

// ============================================================
// Instagram公式埋め込みウィジェット(blockquote + embed.js)
//
// Meta Developerアプリ登録・アクセストークンは不要(2026-07時点で確認済み)。
// ただし「アクセストークンを使ってプロフィールの投稿一覧を自動取得する」ことは
// Meta Graph API(登録・トークン必須)の領域であり、今回は行っていない。
// そのためここでは、投稿の個別URL(パーマリンク)が判明している店舗に限定して、
// その1投稿だけを埋め込む方式にしている。プロフィールURLしか無い店舗は対象外
// (「写真を見る」の外部リンクボタンのみで対応)。
//
// 対象を増やす場合は、当該店舗のInstagram投稿(パーマリンク)を人手で確認し、
// このマップに追記すること。**その際、投稿の実際の投稿者アカウントが店舗の公式アカウントと
// 一致することを必ず確認すること**(検索エンジンの結果は、店舗が他アカウントの投稿に
// タグ付け・言及されているだけのケースを、店舗自身の投稿と誤認しやすいため注意)。
//
// 2026-07-17 品質管理部指摘により修正: shisha-0942(SHISHA BAR 0942)に埋め込んでいた
// https://www.instagram.com/p/C-wxVvmyfCG/ は、投稿者アカウントを再確認したところ
// 公式アカウント@shishabar0942ではなく、無関係な個人アカウント(@nangoku_zundare0942、
// 格闘技の試合報告の投稿で「at BAR 0942 @shishabar0942」と位置タグ付けしていただけ)の
// 投稿だったため削除した。@shishabar0942公式アカウント自身の投稿で、検索エンジンから
// パーマリンクを特定できるものが見つからなかったため、この店舗は埋め込み対象とせず、
// 「写真を見る」外部リンクボタン(pickPhotoSource)にフォールバックする。
// ============================================================
// 【2026-08-28 データ構造変更】1店舗1投稿固定の文字列から、複数投稿を受け付けられる配列に
// 拡張した。追加する投稿も、既存と同じ確認プロセス(embed.jsが生成する埋め込みの
// alt="Instagram post shared by @<handle>"表記、または検索結果の投稿者帰属フォーマット
// 「N likes, M comments - <handle> on <date>:」で投稿者アカウントを確認する)を経てから
// 追記すること。1件も確認できなければ従来通り登録しない(無理に埋めない)。
// 【2026-08-28 品質管理部指摘によりチェック観点を追加】投稿者確認だけでは不十分。
// 追加前に必ず「画像内テキスト(コースター・看板・POP・黒板等に印字/手書きされた文字)に
// 日付・期間限定情報が含まれていないか」を目視確認すること(bar-rojiura-sakahariで
// コースターの日付限定営業告知を見落として誤掲載した再発防止。詳細はREADME参照)。
const INSTAGRAM_POST_EMBEDS = {
  "poker-ken": ["https://www.instagram.com/p/DHUYDOMTOvi/"],
  "poker-ace-and-king": ["https://www.instagram.com/p/DMzHAQgzjCE/"],
  "shisha-aima": ["https://www.instagram.com/p/DIYIdGqBCkm/"],
  // 2026-07-19 追加。ロヂウラ酒八利の公式アカウント @rodiurasyuhari 自身が投稿した
  // パーマリンク。検索結果の投稿者表記(「33 likes, 0 comments - rodiurasyuhari on
  // May 8, 2025:」というInstagramの投稿者帰属フォーマット)で、投稿者が公式アカウント
  // @rodiurasyuhari 本人であることを確認済み(店舗紹介スニペットでも
  // 「ロヂウラ酒八利 豆津橋渡 (@rodiurasyuhari) 久留米の立ち飲み酒場」と一致確認)。
  // 【2026-08-28 追加→同日差し戻し】同じ公式アカウント @rodiurasyuhari の投稿
  // (https://www.instagram.com/p/DNVL2G-yFii/、店内カウンターのコースター写真)を
  // 一度追加したが、投稿者確認(alt文言照合)はできていたものの画像内テキストの確認が
  // 漏れており、品質管理部の指摘でコースターに「8月15日（金）通常営業いたします」
  // 「18時まで『せんべろ』やってますよ」という日付限定の営業告知が印字されていたことが
  // 判明。他候補(臨時休業告知・周年記念キャンペーン等)と同一カテゴリ(特定期間の告知)で
  // 不採用にすべきものだったため削除し、1件に戻した。再調査で日付・期間に紐づかない
  // 代替候補は見つからなかった(詳細はREADME「Instagram公式埋め込み・公式プロフィール
  // リンク」参照)。
  "bar-rojiura-sakahari": ["https://www.instagram.com/p/DJZZcLayobg/"],
};

const INSTAGRAM_EMBED_SCRIPT = `<script async src="//www.instagram.com/embed.js"></script>`;

function instagramEmbedHtml(venueId) {
  const postUrls = INSTAGRAM_POST_EMBEDS[venueId];
  if (!postUrls || postUrls.length === 0) return "";
  const blockquotesHtml = postUrls
    .map(
      (postUrl) =>
        `    <blockquote class="instagram-media" data-instgrm-permalink="${escapeHtml(postUrl)}" data-instgrm-version="14"></blockquote>`
    )
    .join("\n");
  if (postUrls.length === 1) {
    // 1件のときは従来どおり中央寄せの単一表示(出力するHTML構造は変更前と同一)。
    return `<div class="instagram-embed-wrap">
${blockquotesHtml}
</div>`;
  }
  // 2件以上のときは横スクロールで並べる(スマホは指スワイプ、PCはドラッグ/トラックパッド)。
  // 各投稿は幅300px程度で確保し、embed.js が実際の投稿を非同期に描画する。
  return `<div class="instagram-embed-gallery" tabindex="0" role="group" aria-label="Instagram投稿ギャラリー(${postUrls.length}件。左右にスワイプ・スクロールできます)">
${blockquotesHtml}
</div>`;
}

// ============================================================
// 公式サイト画像のホットリンク表示(2026-07-21、社長判断で公式ソース限定の写真掲載を解禁)
//
// 【方針・制約】
// - 使うのは「店自身が公式に発信している写真」のみ(公式サイトのog:image等)。
//   第三者グルメサイト(食べログ・ホットペッパー・Retty・ぐるなび等)の写真は一切使わない。
// - 画像は自サイトに保存(rehost)せず、店のサーバー上のURLを直接参照する <img>(ホットリンク)で
//   表示する。=複製・保存が発生しないため侵害の度合いが最も低い。**画像ファイルのホストは一切なし。**
// - すべての写真に「提供元(公式サイト)表示+公式サイトへのリンク」と、削除依頼の案内文を付ける。
//
// 【実測(curl、2026-07-21)】各 imageUrl は、当サイトの GitHub Pages ドメインを Referer に付けた
// クロスオリジン要求で HTTP 200 + Content-Type: image/* を返すことを確認済み(=サーバー側で
// リファラによるホットリンクブロックをしていない)。ただし実ブラウザでの最終描画は未検証
// (この環境では確認できない)。実機表示は社長のテスト確認に委ねる。
//
// 対象は、公式ドメイン(店名を含む店自身のサイト)の og:image が上記実測を満たした店舗に限定。
// ============================================================
// 【2026-08-28 データ構造変更】1店舗1枚固定 { imageUrl, sourceLabel, sourceUrl } から、
// 複数枚を受け付けられる配列 [{ imageUrl, sourceLabel, sourceUrl }, ...] に拡張した(表示側の
// 横スクロールギャラリー対応にあわせたもの。データの中身・出典元・取得方法は変更していない。
// 既存の1枚データをそのまま配列化しただけ)。写真を追加する場合はこの配列に要素を足すだけでよい。
const OFFICIAL_PHOTOS = {
  "bar-remember": [
    {
      imageUrl: "https://static.wixstatic.com/media/d671d7_b6cf8175b8d54a8a886dbc8580952a06~mv2.png/v1/fit/w_2500,h_1330,al_c/d671d7_b6cf8175b8d54a8a886dbc8580952a06~mv2.png",
      sourceLabel: "Remember 公式サイト",
      sourceUrl: "https://www.kurume-remember.com/",
    },
  ],
  "bar-oshu-kitchen-alma": [
    {
      imageUrl: "https://oshukitchen-alma.com/img/ogp.png",
      sourceLabel: "欧州キッチンアルマ 公式サイト",
      sourceUrl: "https://oshukitchen-alma.com/",
    },
  ],
  "izakaya-sumibi-sakagura-kita": [
    {
      imageUrl: "https://www.sumibishuzo-kita.com/shared/img/shared/ogp.png",
      sourceLabel: "炭火酒蔵 喜多 公式サイト",
      sourceUrl: "https://www.sumibishuzo-kita.com/",
    },
  ],
  // 【2026-07-21 レビュー部の条件付きGOにより除外】bar-lampsquare は画像が cdn.r-corona.jp
  // (Recruit系CDN)上にあり、公式サイト自体が Recruit の店舗ページ作成サービス owst.jp
  // (RestaurantBOARD)製。Recruit は今回禁止対象にしたホットペッパーグルメの親会社であり、
  // 「クリーンな公式ソース限定」の線引きを濁すため対象外とした(写真なし=ビジュアルヒーローのまま)。
  "izakaya-kiseki-tebasaki": [
    {
      imageUrl: "https://kiseteba.com/img/ogp.png",
      sourceLabel: "奇跡の手羽先 公式サイト",
      sourceUrl: "https://kiseteba.com/",
    },
  ],
};

// ============================================================
// 横スクロール写真ギャラリー(共通部品、2026-08-28 追加)
//
// 【方針】1枚でも複数枚でも同じ構造・同じ関数で描画する。CSS の scroll-snap のみで動かし
// (assets/style.css の .photo-gallery / .photo-gallery-item)、JSライブラリは使わない。
// - 1枚のときはギャラリー幅=写真幅になり横スクロールは発生しない(従来の単一写真表示と同じ見た目)。
// - 2枚以上のときだけ実際に横スクロール(スマホは指スワイプ、PCはドラッグ/トラックパッド、
//   キーボードは要素にフォーカスした状態での矢印キー)で切り替えられる。フォーカス可能にする
//   のもスクロールが実際に発生する(=2枚以上の)ときだけにしている(1枚だけの非スクロール要素を
//   無意味にタブストップにしないため)。
// - items: [{ img, alt, captionHtml? }]。captionHtml を渡した項目は写真ごとに個別の
//   figcaption(出典クレジット)を表示する(出典が写真ごとに異なりうる公式サイト画像向け)。
// - footerHtml を渡すと、ギャラリー全体の下に共有の説明文(単一の出典元表記など)を1つだけ表示する。
// ============================================================
function photoGalleryHtml(items, footerHtml) {
  if (!items || items.length === 0) return "";
  const multi = items.length > 1;
  const figuresHtml = items
    .map((it) => {
      const captionHtml = it.captionHtml ? `<figcaption class="small">${it.captionHtml}</figcaption>` : "";
      const onerrorAttr = it.onerror ? ` onerror="${it.onerror}"` : "";
      return `    <figure class="photo-gallery-item${it.itemClass ? ` ${it.itemClass}` : ""}">
      <img src="${escapeHtml(it.img)}" alt="${escapeHtml(it.alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer-when-downgrade"${onerrorAttr}>
      ${captionHtml}
    </figure>`;
    })
    .join("\n");
  const galleryAttrs = multi ? ` tabindex="0" role="group" aria-label="写真ギャラリー(${items.length}枚。左右にスワイプ・スクロールできます)"` : "";
  const galleryHtml = `<div class="photo-gallery"${galleryAttrs}>
${figuresHtml}
  </div>`;
  return footerHtml ? `${galleryHtml}\n  ${footerHtml}` : galleryHtml;
}

function officialPhotoHtml(venueId) {
  const photos = OFFICIAL_PHOTOS[venueId];
  if (!photos || photos.length === 0) return "";
  const items = photos.map((p) => ({
    img: p.imageUrl,
    alt: `${p.sourceLabel}の写真`,
    itemClass: "official-photo",
    captionHtml: `提供: <a href="${escapeHtml(p.sourceUrl)}" rel="nofollow noopener" target="_blank">${escapeHtml(p.sourceLabel)}</a>(画像は公式サイトのものを直接参照して表示しています。当サイトに保存はしていません)`,
  }));
  return photoGalleryHtml(items);
}

// ============================================================
// ホットペッパー グルメ Webサービスの店舗写真(2026-07-26、社長承認の機能追加)
//
// 【方針・制約】
// - ホットペッパー グルメの無料API(規約順守)から取得した店の代表写真1枚を、店舗ページ上部の
//   ヒーロー画像として表示する。画像は自サイトに保存せず、提供元(imgfp.hotp.jp)のURLを直接
//   参照する <img>(ホットリンク)。**画像ファイルのホストは一切なし。**
// - 対象は data/venues.json の sources にホットペッパー店舗ID(strJxxxxxx)を持つ店のみ。
//   その店舗IDでの **ID直接引き** で取得(店名検索の曖昧一致による誤掲載はしない)。
// - 写真には必須クレジット「【画像提供：ホットペッパー グルメ】」と、店舗ページ(urls.pc)への
//   「もっと見る」リンクを付ける。フッターには「Powered by ホットペッパーグルメ Webサービス」を出す。
//
// 【データの出所】scripts/fetch-photos.js が data/photos.generated.json(venue id ->
// { photo, hpUrl })を生成する。このファイルは .gitignore 対象で、CIで毎回生成=常に最新。
// ローカル/CIでフェッチ未実行、またはAPIキー未設定なら空マップ扱いでヒーロー写真は出さない
// (既存の「写真を見る↗」フォールバックはそのまま維持)。
// ============================================================
function loadGeneratedPhotos() {
  const file = path.join(DATA_DIR, "photos.generated.json");
  if (!fs.existsSync(file)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return data && typeof data === "object" ? data : {};
  } catch (e) {
    console.warn(`[warn] photos.generated.json の読み込みに失敗しました: ${e.message}`);
    return {};
  }
}

const VENUE_PHOTOS = loadGeneratedPhotos();

// ============================================================
// Googleクチコミ★評価の表示(2026-07-27、社長承認の機能追加)
//
// 【データの出所】scripts/fetch-ratings.js が Places API (New) から取得した rating /
// userRatingCount を data/ratings.json(venue id -> { rating, userRatingCount, updatedAt })
// に保存する。build.js はこのファイルを **読むだけ**(APIは一切叩かない=デプロイでの二重課金・
// 無限ループを防ぐ)。ファイルが無い/壊れている/評価が無い店は★を出さない(UI崩れなし)。
//
// 【Google帰属表示(必須・削除/改変/隠蔽NG)】★を出す店には、★と同じ視覚コンテナ内に
// 「Google」への帰属表示を必ず併記する(店舗ページ=「Google のクチコミ評価」、
// カード=小さな「Google」ラベル)。CSSで hidden にしたり文言を改変したりしないこと。
// ============================================================
function loadRatings() {
  const file = path.join(DATA_DIR, "ratings.json");
  if (!fs.existsSync(file)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return data && typeof data === "object" ? data : {};
  } catch (e) {
    console.warn(`[warn] ratings.json の読み込みに失敗しました: ${e.message}`);
    return {};
  }
}

const VENUE_RATINGS = loadRatings();

// 表示に使える評価(rating が正の数値の店のみ)。無ければ null。
function venueRating(v) {
  const r = VENUE_RATINGS[v.id];
  if (!r || typeof r.rating !== "number" || !(r.rating > 0)) return null;
  return { rating: r.rating, count: typeof r.userRatingCount === "number" ? r.userRatingCount : 0 };
}

// 星のビジュアル(塗り/半分/空を rating(0〜5)から算出)。
// グレーの空星5つの上に、金色の塗り星5つを rating/5 の幅でクリップして重ねることで、端数(半分星)も描画する。
// 星そのものは装飾なので aria-hidden にし、読み上げ用ラベルは呼び出し側のコンテナに付ける。
function starsHtml(rating, sizeClass) {
  const pct = Math.max(0, Math.min(100, (rating / 5) * 100));
  return `<span class="stars ${sizeClass}" style="--star-pct:${pct.toFixed(1)}%" aria-hidden="true"><span class="stars-empty">★★★★★</span><span class="stars-fill">★★★★★</span></span>`;
}

// 店舗ページ上部の大きな★評価ブロック(★ + 3.3 +(186件)+ Google帰属)。
function ratingHeroHtml(v) {
  const r = venueRating(v);
  if (!r) return "";
  const countText = r.count > 0 ? `（${r.count.toLocaleString("en-US")}件）` : "";
  const aria = `Googleのクチコミ評価 5段階中${r.rating.toFixed(1)}${r.count > 0 ? ` ${r.count}件` : ""}`;
  return `<div class="rating-hero" role="img" aria-label="${escapeHtml(aria)}">
    <div class="rating-hero-main">
      ${starsHtml(r.rating, "stars-lg")}
      <span class="rating-score">${r.rating.toFixed(1)}</span>
      <span class="rating-count">${countText}</span>
    </div>
    <span class="rating-source">Google のクチコミ評価</span>
  </div>`;
}

// 一覧カード内の小さな★評価(★ + 3.3 + Google帰属)。
function ratingCardHtml(v) {
  const r = venueRating(v);
  if (!r) return "";
  const aria = `Googleのクチコミ評価 5段階中${r.rating.toFixed(1)}`;
  return `<span class="venue-card-rating" role="img" aria-label="${escapeHtml(aria)}">${starsHtml(r.rating, "stars-sm")}<span class="rating-score-sm">${r.rating.toFixed(1)}</span><span class="rating-src-sm">Google</span></span>`;
}

// ヒーロー写真(ホットペッパー グルメ)。写真が無ければ空文字。
// onerror: 画像が読めなかったら figure(1枚のとき)/ 該当スライド(複数枚のとき)を非表示にする
// (空クレジットだけ残るのを防ぐ)。
//
// 【2026-08-28 将来の複数枚対応に備えた読み取り拡張】現状 scripts/fetch-photos.js は
// data/photos.generated.json に venue id -> { photo, logo?, hpUrl } と写真1枚(photo:文字列)
// しか書き出さない(今回のタスクではこのフェッチ側ロジックは変更していない)。将来
// fetch-photos.js が複数枚(photos: string[])を返すように拡張された場合に備え、ここでは
// `photos` 配列が来ていればそれを、無ければ従来の `photo`(単数)を1件配列にして使う、という
// 読み取りだけを先に用意しておく。現状は実質的に常に0〜1件なので、1枚のときの出力(HTML構造)は
// 変更前と完全に同一(=既存の描画は壊さない)。2枚以上になったときだけ横スクロールギャラリー
// (photoGalleryHtml、photo-section の公式写真ギャラリーと共通のCSS)で表示する。
function venueHeroPhotoHtml(v) {
  const p = VENUE_PHOTOS[v.id];
  if (!p) return "";
  const photoUrls = Array.isArray(p.photos) && p.photos.length > 0 ? p.photos : p.photo ? [p.photo] : [];
  if (photoUrls.length === 0) return "";
  const moreLink = p.hpUrl
    ? ` <a class="venue-hero-photo-more" href="${escapeHtml(p.hpUrl)}" rel="nofollow noopener" target="_blank">ホットペッパーで写真をもっと見る ↗</a>`
    : "";
  const credit = `<figcaption class="small venue-hero-photo-credit">【画像提供：ホットペッパー グルメ】${moreLink}</figcaption>`;
  if (photoUrls.length === 1) {
    // 現状(実質すべての店)はここを通る。変更前と同一のHTMLを出力する。
    return `<figure class="venue-hero-photo">
    <img src="${escapeHtml(photoUrls[0])}" alt="${escapeHtml(v.name)}の写真(ホットペッパー グルメ)" loading="lazy" decoding="async" referrerpolicy="no-referrer-when-downgrade" onerror="this.parentNode.style.display='none'">
    ${credit}
  </figure>`;
  }
  const items = photoUrls.map((src) => ({
    img: src,
    alt: `${v.name}の写真(ホットペッパー グルメ)`,
    // 複数枚のうち1枚だけ読めなかった場合は、そのスライドだけ非表示にする(ギャラリー全体は残す)。
    onerror: "this.closest('.photo-gallery-item').style.display='none'",
  }));
  return `<figure class="venue-hero-photo">
    ${photoGalleryHtml(items)}
    ${credit}
  </figure>`;
}

// ============================================================
// 店舗ロゴのホットリンク表示(2026-07-22)
//
// 【方針・制約】公式サイト画像(OFFICIAL_PHOTOS)と同じ線引きを踏襲する。
// - 使うのは「店自身(またはそのチェーン運営元)の公式サイト」に掲載されているロゴのみ。
//   第三者グルメサイト(食べログ・ホットペッパー・Retty・ぐるなび)およびそのページ作成
//   サービス(owst.jp / gorp.jp / r-corona.jp)由来の画像は一切使わない。
// - 画像は自サイトに保存(rehost)せず、店のサーバー上のURLを直接参照する <img>(ホットリンク)。
//   **画像ファイルのホストは一切なし。**
// - 店舗ページに提供元(公式サイト)へのリンクと削除依頼の案内を出す(venueLogoCreditHtml)。
//   一覧カードは煩雑になるため出典表記を出さない(店舗ページで担保)。
// - 読み込みに失敗した場合は業態アイコン(自作SVG)にフォールバックする(img の onerror)。
//
// 【bg フィールド】ロゴは透過PNGが多く、白抜き(白一色)のロゴは白背景だと見えない。
// - "light"(既定): 白背景。濃色のロゴ・背景が焼き込まれたロゴ向け。
// - "dark": 濃色背景。白抜きロゴ向け。
//   実際に画像を取得して合成し、白背景/濃色背景それぞれでの視認性を目視確認したうえで指定している
//   (2026-07-22時点で "dark" 指定は3件)。
//
// 【実測(curl、2026-07-22)】30件すべて、当サイトの GitHub Pages ドメインを Referer に付けた
// クロスオリジン要求で HTTP 200 + Content-Type: image/* を返すことを確認済み
// (=リファラによるホットリンクブロックなし)。ただし実ブラウザでの最終描画は未検証。
// ============================================================
const VENUE_LOGOS = {
  // --- 接待を伴う業態の公式サイトロゴ(2026-07-30) ---
  // 2026-07-30 の掲載範囲拡大にあわせてロゴを調査した。この業態は
  // **ホットペッパーもFacebookも使えない**(ホットペッパーグルメは風営法上の
  // 接待飲食店を扱っておらず、3班の調査でいずれも0件)ため、
  // 有効なのは (1)店の公式サイト (2)公式Instagram (3)公式TikTok の3ルートのみ。
  // 下記4件は最もリスクの低い(1)=公式サイトのホットリンクで、
  // 画像を実際に取得して**店名ロゴであることを目視確認**済み。
  "kyabakura-ace": {
    imageUrl: "https://kurume-ace.com/wp-content/themes/onepixel-child/images/header_logo.png",
    siteLabel: "A〈エース〉 公式サイト",
    siteUrl: "https://kurume-ace.com/",
  },
  "kyabakura-kurume-rikyu": {
    imageUrl: "https://kurume.sogo-leisure.co.jp/wp-content/uploads/sites/10/2020/04/rik_kr.png",
    siteLabel: "New Club 久留米離宮 公式サイト",
    siteUrl: "https://kurume.sogo-leisure.co.jp/shop_list/rikyu/",
  },
  "kyabakura-carnet": {
    imageUrl: "https://new-club-carnet.com/assets/new-club-carnet.com/wp-content/themes/onepixel-child/images/logo.png",
    siteLabel: "NEW CLUB CARNET 公式サイト",
    siteUrl: "https://new-club-carnet.com/",
  },
  "club-four-season": {
    imageUrl: "https://club-fourseason.com/wp-content/themes/onepixel-child/images/header_logo.png",
    siteLabel: "CLUB FOUR SEASON 公式サイト",
    siteUrl: "https://club-fourseason.com/",
  },
  // 公式Instagramもあるが、公式サイトのロゴが取れる店は
  // ホットリンク(自サイトに保存しない)= より低リスクな方を採る。
  "girlsbar-tree": {
    imageUrl: "https://girlsbartree.m-nanaumi.com/wp-content/uploads/2021/10/treelogo1.png",
    siteLabel: "Girl's Bar TREE 公式サイト",
    siteUrl: "https://girlsbartree.m-nanaumi.com/",
  },
  // 白抜き(白一色)ロゴ3件(2026-07-30)。当初「白背景では不可視」として保留していたが、
  // 実際に画像を取得して暗色背景に合成し、目視で判読できることを確認した。
  "kyabakura-shiki": {
    // 白一色の透過PNG。姉妹店(CARNET/FOUR SEASON)と同じ制作会社のテーマ。
    imageUrl: "https://new-club-shiki.com/wp-content/uploads/2019/11/logo.png",
    siteLabel: "NEW CLUB 四季 公式サイト",
    siteUrl: "https://new-club-shiki.com/",
    bg: "dark",
  },
  "club-sowaca": {
    // 白一色の透過PNG(Wix配信)。
    imageUrl: "https://static.wixstatic.com/media/d671d7_e0646ccb2329416b9517c4d55343c2fe~mv2.png",
    siteLabel: "Sowaca(ソワカ) 公式サイト",
    siteUrl: "https://www.kurume-sowaca.com/",
    bg: "dark",
  },
  "club-the-member": {
    // 白一色の透過WebP。
    imageUrl: "https://themember.jp/assets/img/logo.webp",
    siteLabel: "The Member(ザ・メンバー) 公式サイト",
    siteUrl: "https://themember.jp/",
    bg: "dark",
  },

  // --- 公式サイトロゴ 自動拡充(2026-07-27) ---
  "bar-141saketen": {
    imageUrl: "https://www.141saketen-kurume.com/wp-content/uploads/2023/04/logo-1.png",
    siteLabel: "141酒店 公式サイト",
    siteUrl: "https://www.141saketen-kurume.com/",
  },
  "izakaya-kushi-tanaka": {
    imageUrl: "https://restaurant.kushi-tanaka.com/images/logo.png",
    siteLabel: "串カツ田中 公式サイト",
    siteUrl: "https://restaurant.kushi-tanaka.com/detail/1220",
  },
  "izakaya-todoit": {
    imageUrl: "https://fancicalcafeandbar-todoit.com/img/main_logo.png",
    siteLabel: "to do it. -つどい- 公式サイト",
    siteUrl: "https://fancicalcafeandbar-todoit.com/",
  },
  "izakaya-tashu": {
    imageUrl: "https://static.wixstatic.com/media/8273ba_97ff1a8736c24ce2a2532c9e40868346~mv2.png",
    siteLabel: "もつ鍋 田しゅう 公式サイト",
    siteUrl: "https://www.motsunabe-tashu.com/",
  },
  "izakaya-kawakko": {
    imageUrl: "https://static.wixstatic.com/media/acc18a_aa89a1f222f94998a094f34be4311435~mv2.png/v1/fill/w_299,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/top_logo.png",
    siteLabel: "とりかわ博多かわっこ 公式サイト",
    siteUrl: "https://www.kawakko.com/",
  },
  "izakaya-tsukasa": {
    imageUrl: "https://kurume-yakitori-tsukasa.com/img/logo.png",
    siteLabel: "久留米焼鳥 つかさ 公式サイト",
    siteUrl: "https://kurume-yakitori-tsukasa.com/",
  },
  "izakaya-hamada": {
    imageUrl: "https://kushino-utage-hamada.com/system_panel/uploads/images/hd_logo.png",
    siteLabel: "串乃宴 はま田 公式サイト",
    siteUrl: "https://kushino-utage-hamada.com/",
  },
  "izakaya-hanhan": {
    imageUrl: "https://yakiniku-hanhan.com/struct/wp-content/uploads/logo.png",
    siteLabel: "炭火焼肉 絆繁 公式サイト",
    siteUrl: "https://yakiniku-hanhan.com/",
  },
  // --- Facebookページのロゴ 自動拡充(2026-07-28) ---
  "bar-papermoon": {
    imageUrl: "https://graph.facebook.com/294255527261386/picture?type=large",
    siteLabel: "ペーパームーン 公式Facebook",
    siteUrl: "https://www.facebook.com/294255527261386/",
  },
  "bar-rojiura-sakahari": {
    imageUrl: "https://graph.facebook.com/rodiurasyuhari/picture?type=large",
    siteLabel: "ロヂウラ酒八利 公式Facebook",
    siteUrl: "https://www.facebook.com/rodiurasyuhari/",
  },
  "bar-bistro-theater": {
    imageUrl: "https://graph.facebook.com/BistroTheater0516/picture?type=large",
    siteLabel: "ビストロシアター 公式Facebook",
    siteUrl: "https://www.facebook.com/BistroTheater0516/",
  },
  "bar-flavor": {
    imageUrl: "https://graph.facebook.com/utagespaceflavor/picture?type=large",
    siteLabel: "宴場FLAVOR 公式Facebook",
    siteUrl: "https://www.facebook.com/utagespaceflavor/",
  },
  "izakaya-kunsei-mammauto": {
    imageUrl: "https://graph.facebook.com/kunseisakaba.manmaaiuto/picture?type=large",
    siteLabel: "燻製ビストロ マンマ・ユート 公式Facebook",
    siteUrl: "https://www.facebook.com/kunseisakaba.manmaaiuto/",
  },
  "izakaya-yolo": {
    imageUrl: "https://graph.facebook.com/yolo0942/picture?type=large",
    siteLabel: "肉酒場YOLO 公式Facebook",
    siteUrl: "https://www.facebook.com/yolo0942/",
  },
  "izakaya-seppun": {
    imageUrl: "https://graph.facebook.com/kurume.seppun/picture?type=large",
    siteLabel: "通町 接吻 公式Facebook",
    siteUrl: "https://www.facebook.com/kurume.seppun/",
  },
  "izakaya-daisen": {
    imageUrl: "https://graph.facebook.com/kurumedaisen/picture?type=large",
    siteLabel: "久留米だいせん 公式Facebook",
    siteUrl: "https://www.facebook.com/kurumedaisen/",
  },
  "izakaya-hidamari-honten": {
    imageUrl: "https://graph.facebook.com/hidamari.syokudou/picture?type=large",
    siteLabel: "陽溜食堂 公式Facebook",
    siteUrl: "https://www.facebook.com/hidamari.syokudou/",
  },
  "izakaya-hidamari-hiyoshi": {
    imageUrl: "https://graph.facebook.com/hidamari.hiyosimati/picture?type=large",
    siteLabel: "陽溜食堂 日吉町店 公式Facebook",
    siteUrl: "https://www.facebook.com/hidamari.hiyosimati/",
  },
  "izakaya-hiroya": {
    imageUrl: "https://graph.facebook.com/yakinikuhorumonhiroya/picture?type=large",
    siteLabel: "焼肉ホルモン ひろ屋 公式Facebook",
    siteUrl: "https://www.facebook.com/yakinikuhorumonhiroya/",
  },
  "izakaya-rakuen": {
    imageUrl: "https://graph.facebook.com/rakuen.kurume/picture?type=large",
    siteLabel: "常夏酒場 楽園(RAKUEN) 公式Facebook",
    siteUrl: "https://www.facebook.com/rakuen.kurume/",
  },
  "concafe-seventh-heaven": {
    imageUrl: "https://graph.facebook.com/LC7thHeaven/picture?type=large",
    siteLabel: "Live Cafe Seventh Heaven 公式Facebook",
    siteUrl: "https://www.facebook.com/LC7thHeaven/",
  },
  "izakaya-tomosuke": {
    imageUrl: "https://graph.facebook.com/TomosukeKurume/picture?type=large",
    siteLabel: "串・麺 ともすけ 公式Facebook",
    siteUrl: "https://www.facebook.com/TomosukeKurume/",
  },
  "izakaya-ginshari": {
    imageUrl: "https://graph.facebook.com/1074032079420586/picture?type=large",
    siteLabel: "焼肉銀しゃり直球 久留米店 公式Facebook",
    siteUrl: "https://www.facebook.com/1074032079420586/",
  },
  "izakaya-gekkoyoku": {
    imageUrl: "https://graph.facebook.com/kurumegekkouyoku/picture?type=large",
    siteLabel: "月光浴 公式Facebook",
    siteUrl: "https://www.facebook.com/kurumegekkouyoku/",
  },
  // --- 居酒屋・料理系 ---
  "izakaya-kakomian": {
    imageUrl: "https://momo.cmosite.com/wp-content/uploads/sites/35/2020/01/logo_w.png",
    siteLabel: "かこみ庵 久留米店 公式サイト",
    siteUrl: "https://bb-kakomian.com/kurume/",
  },
  "izakaya-kiseki-tebasaki": {
    imageUrl: "https://kiseteba.com/img/apple-touch-icon.png",
    siteLabel: "奇跡の手羽先 公式サイト",
    siteUrl: "https://kiseteba.com/",
  },
  "izakaya-torimero": {
    imageUrl: "https://torimero.com/prd/wp/wp-content/uploads/2025/05/torimero512.png",
    siteLabel: "三代目 鳥メロ 公式サイト",
    siteUrl: "https://torimero.com/nishitetsukurume/",
  },
  "izakaya-sumibi-sakagura-kita": {
    imageUrl: "https://www.sumibishuzo-kita.com/shared/img/shared/logo.png",
    siteLabel: "炭火酒蔵 喜多 公式サイト",
    siteUrl: "https://www.sumibishuzo-kita.com/",
  },
  "izakaya-sengoku-ieyasu": {
    imageUrl: "https://yakitori-ieyasu.co.jp/wp-content/uploads/2019/04/logo.png",
    siteLabel: "戦国焼鳥 家康 公式サイト",
    siteUrl: "https://yakitori-ieyasu.co.jp/",
  },
  "izakaya-kuimonoya-wan": {
    // 白抜きの筆文字ロゴ(透過PNG)のため濃色背景。
    imageUrl: "https://www.oizumifoods.co.jp/img/common/shops/izakaya_logo01.png",
    siteLabel: "くいもの屋わん 公式サイト(大泉フーズ)",
    siteUrl: "https://search.oizumifoods.co.jp/detail/2583/",
    bg: "dark",
  },
  "izakaya-isomaru": {
    imageUrl: "https://isomaru.jp/wp-content/uploads/2022/11/isomarusuisan_logo.jpg",
    siteLabel: "磯丸水産 公式サイト",
    siteUrl: "https://isomaru.jp/1541/",
  },
  "izakaya-sanzoku-dining": {
    imageUrl: "https://www.dragoncafe.jp/shared/img/shared/logo.png",
    siteLabel: "SANZOKU DINING さっさん 公式サイト",
    siteUrl: "https://www.dragoncafe.jp/",
  },
  "izakaya-sumibi-kushiya": {
    imageUrl: "https://new-hakata-style.com/assets/img/apple-touch-icon.png",
    siteLabel: "ニューハカタスタイル 公式サイト",
    siteUrl: "https://new-hakata-style.com/",
  },
  "izakaya-taketora": {
    imageUrl: "https://hakata-gyoza-taketora.com/wp-content/uploads/2026/02/cropped-2026_02_12_0lb_Kleki_transparent-180x180.png",
    siteLabel: "博多一口餃子たけとら 公式サイト",
    siteUrl: "https://hakata-gyoza-taketora.com/",
  },
  "izakaya-toriichizu": {
    // 白抜きの鶏マーク(透過PNG)のため濃色背景。
    imageUrl: "https://toriichizu.net/wp-content/uploads/2020/12/cropped-logo-toriichizu-180x180.png",
    siteLabel: "とりいちず 公式サイト",
    siteUrl: "https://toriichizu.net/shoplist/fukuoka/kurumeshi/",
    bg: "dark",
  },
  "izakaya-shanghai-shuka": {
    // 白抜きの店名ロゴ(透過PNG)のため濃色背景。
    imageUrl: "https://shanghai-shuka.com/img/logo_footer.png",
    siteLabel: "上海酒家 公式サイト",
    siteUrl: "https://shanghai-shuka.com/",
    bg: "dark",
  },
  "izakaya-ryuoukan-honten": {
    imageUrl: "https://static.wixstatic.com/media/b86d6d_0c42461f10d74c13b7775778ef59a210~mv2.png",
    siteLabel: "焼肉龍王館 公式サイト",
    siteUrl: "https://www.ryuoukan.com/",
  },
  "izakaya-okinawa-kizuna": {
    imageUrl: "https://kizuna1110.com/system_panel/uploads/touchicon/touchicon.png",
    siteLabel: "沖縄風居酒屋 絆 公式サイト",
    siteUrl: "https://kizuna1110.com/",
  },
  "izakaya-mui": {
    imageUrl: "https://www.yakiniku-mui.com/shared/img/shared/logo.png",
    siteLabel: "韓国家庭料理 無為 公式サイト",
    siteUrl: "https://www.yakiniku-mui.com/",
  },
  "izakaya-amenita-pizzeria": {
    imageUrl: "https://pizzeria-amenita.com/wp-content/themes/bonse/assets/images/logo.png",
    siteLabel: "Pizzeria Amenita 公式サイト",
    siteUrl: "https://pizzeria-amenita.com/",
  },
  "izakaya-hirukara-shinkichi": {
    imageUrl: "https://shinkichi-kurume.jp/system_panel/uploads/images/fft_logo02.png",
    siteLabel: "昼カラ酒場しん吉 公式サイト",
    siteUrl: "https://shinkichi-kurume.jp/shinkichi",
  },
  "izakaya-kalbi-yokocho": {
    imageUrl: "https://karubiyokotyo.com/img/logo_footer.png",
    siteLabel: "久留米焼肉 カルビ横丁 公式サイト",
    siteUrl: "https://karubiyokotyo.com/",
  },
  "izakaya-tori-shiki": {
    imageUrl: "https://torishiki-kurume.com/img/apple-touch-icon.png",
    siteLabel: "焼き鳥とり四季 公式サイト",
    siteUrl: "https://torishiki-kurume.com/",
  },
  "izakaya-shiroichi": {
    // 原寸(1400x1461・約930KB)は表示サイズに対し過大なため、Wix標準のリサイズ済みURL
    // (アスペクト比はほぼ同じ 240x250、約55KB)を参照する。実測 200 + image/png。
    imageUrl: "https://static.wixstatic.com/media/c62334_eb94ec85033a42bc8b5d8ce68dbcbd8e~mv2_d_1400_1461_s_2.png/v1/fill/w_240,h_250,al_c,q_85/c62334_eb94ec85033a42bc8b5d8ce68dbcbd8e~mv2_d_1400_1461_s_2.png",
    siteLabel: "ホルモン家 しろ壱 公式サイト",
    siteUrl: "https://www.horumonya-shiroichi.com/",
  },
  "izakaya-karisamu": {
    imageUrl: "https://izzy.best/images/karisamu/kasamu_a.png",
    siteLabel: "カリサム 公式サイト",
    siteUrl: "https://izzy.best/karisamu/index.html",
  },
  // --- コンカフェ ---
  "girlsbar-axia": {
    imageUrl: "https://anisongaxia.com/common/upload_data/anisongaxiacom/image/apple-touch-icon.png",
    siteLabel: "コンセプトカフェ AXIA 公式サイト",
    siteUrl: "https://anisongaxia.com/",
  },
  "girlsbar-platinum-seven": {
    imageUrl: "https://kurume-seven.com/wp-content/uploads/2026/05/favicon-200x200.png",
    siteLabel: "カフェラウンジ PLATINUM SEVEN 公式サイト",
    siteUrl: "https://kurume-seven.com/",
  },
  // --- バー ---
  "bar-remember": {
    imageUrl: "https://static.wixstatic.com/media/d671d7_b6cf8175b8d54a8a886dbc8580952a06%7Emv2.png/v1/fill/w_180%2Ch_180%2Clg_1%2Cusm_0.66_1.00_0.01/d671d7_b6cf8175b8d54a8a886dbc8580952a06%7Emv2.png",
    siteLabel: "リメンバー 公式サイト",
    siteUrl: "https://www.kurume-remember.com/",
  },
  "bar-manuka": {
    // 白抜き版(manuqa-logo-white.png)は白背景で不可視のため、正方形マークの favicon を採用。
    imageUrl: "https://manuqa.jp/wp-content/themes/manuqa-theme/favicon.png",
    siteLabel: "マヌーカ 公式サイト",
    siteUrl: "https://manuqa.jp/",
  },
  "bar-oshu-kitchen-alma": {
    imageUrl: "https://oshukitchen-alma.com/img/apple-touch-icon.png",
    siteLabel: "欧州キッチンアルマ 公式サイト",
    siteUrl: "https://oshukitchen-alma.com/",
  },
  "bar-live-actor": {
    imageUrl: "https://livebaractor.com/wp-content/uploads/2021/11/cropped-icon-180x180.png",
    siteLabel: "Live Bar Actor 公式サイト",
    siteUrl: "https://livebaractor.com/",
  },
  "bar-highball-stand": {
    imageUrl: "https://highball-stand.com/wp-content/uploads/2024/07/cropped-logo1-180x180.png",
    siteLabel: "ザ・ハイボールスタンド 公式サイト",
    siteUrl: "https://highball-stand.com/",
  },
  "bar-welmona": {
    imageUrl: "https://welmona.com/img/apple-touch-icon.png",
    siteLabel: "BAR WELMONA 公式サイト",
    siteUrl: "https://welmona.com/",
  },
  "bar-aletta": {
    imageUrl: "https://aletta-kurume.com/home/wp-content/uploads/2018/12/cropped-9836b00030f5b01c0b638441173e8a18-180x180.jpg",
    siteLabel: "ALETTA 公式サイト",
    siteUrl: "https://aletta-kurume.com/",
  },
};

// ============================================================
// 公式Instagramプロフィール画像をロゴに使用(2026-07-29、社長がリスク承知で承認した方針例外)
//
// 【通常方針との違い】上の VENUE_LOGOS / OFFICIAL_PHOTOS は「画像を自サイトに保存せず、提供元
// サーバーのURLを直接参照(ホットリンク)」する方針。だが Instagram のプロフィール画像は CDN の
// 署名付きURLが短命でホットリンクに向かない。そこで社長承認のもと、**例外的に画像を自サイトへ保存
// (再ホスト)** して使う。対象は「公式ロゴもホットペッパー画像も無く、これまでネームタイル表示だった
// 店」14件(著作権・Instagram規約上のリスクは社長がリスク承知で承認済み。削除依頼の対象に含める)。
//
// 【保存場所】assets/insta-logos/{id}.jpg(150×150)。ビルド時に dist/assets/insta-logos/ へコピーし、
// <img src> はサイトのベースパス付きローカルパス(/kurume-bar-navi/assets/insta-logos/{id}.jpg)で参照する。
//
// 【クレジット】自サイトに保存しているため「当サイトには保存していません」とは書けない(虚偽になる)。
// venueLogoCreditHtml の instagram-local 分岐で、各店の公式Instagramへのリンク付きで正確に出典表記し、
// 削除依頼の連絡先も併記する。経緯・対象IDは data/venue-audit-log.md(2026-07-29 エントリ)にも記録。
//
// 値は各店の公式InstagramアカウントのプロフィールURL(= プロフィール画像の出典)。
// ============================================================
const INSTAGRAM_LOGOS = {
  "bar-1988": "https://www.instagram.com/1988.kurume/",
  "bar-tico": "https://www.instagram.com/bar_tico/",
  "bar-bigisland": "https://www.instagram.com/chiyatorashiya/",
  "bar-jackalope": "https://www.instagram.com/jackalope_kurume/",
  "bar-jinga45": "https://www.instagram.com/jinga45/",
  "izakaya-delica-amenita": "https://www.instagram.com/delica_bal_amenita/",
  "izakaya-oubu": "https://www.instagram.com/sakuramai_kurume/",
  "izakaya-geta": "https://www.instagram.com/izakaya_geta/",
  "izakaya-tacchan": "https://www.instagram.com/gyouzanotacchankurume/",
  "izakaya-sakana-to-kushi-tsubomi": "https://www.instagram.com/tsubomi_kurume/",
  "shisha-0942": "https://www.instagram.com/shishabar0942/",
  "shisha-aima": "https://www.instagram.com/kurume.shisha.ima/",
  "poker-ken": "https://www.instagram.com/kurume_ken_poker/",
  "poker-ace-and-king": "https://www.instagram.com/ace_and_king259/",
  // --- 第2弾(2026-07-29): ネームタイル店の公式IGを検索で発見し追加 ---
  "concafe-kurukuru-bakyun": "https://www.instagram.com/kurukuru_bqn/",
  "concafe-paracora": "https://www.instagram.com/parakora_/",
  "izakaya-toyfull-brewery": "https://www.instagram.com/toyfullbrewery/",
  "bar-kurume-standard": "https://www.instagram.com/kurumestandard/",
  "izakaya-bansun": "https://www.instagram.com/sousakubansun/",
  "shisha-x": "https://www.instagram.com/shisha_bar.x/",
  "izakaya-matsuo": "https://www.instagram.com/matsu_uo/",
  "izakaya-lucky-raku": "https://www.instagram.com/kurume.lucky/",
  "izakaya-motsunabe-sato": "https://www.instagram.com/motsunabe.sato/",
  "izakaya-yakiniku-zen": "https://www.instagram.com/yakinikuzen09/",
  "izakaya-kokaro": "https://www.instagram.com/koukarow/",
  "izakaya-matabee": "https://www.instagram.com/matab_ee/",
  // --- 第3弾(2026-07-29): 引き継ぎメモの「確認済みハンドル」6店を実アクセスで再検証し、
  //     唯一実在が確認できた1店を追加(残り5件は無効ハンドル/公式IG不在。詳細は data/venue-audit-log.md) ---
  "izakaya-grill-party": "https://www.instagram.com/grillparty.yakiniku/",
  // --- 第4弾(2026-07-30): 接待を伴う業態の掲載開始にあわせて追加 ---
  // この業態はホットペッパー・Facebookのルートが使えないため(いずれも3班の調査で0件)、
  // 公式サイトが無い店は公式Instagramのプロフィール画像が唯一の手段になる。
  // 全件、画像を実際に取得して**店名ロゴであることを目視確認**済み
  // (人物写真・キャスト写真・店内写真は不採用)。
  "snack-himari": "https://www.instagram.com/snack_himari/",
  "snack-destino": "https://www.instagram.com/destino0942/",
  "snack-takefuji": "https://www.instagram.com/fuji_ou.uo/",
  "snack-komorebi": "https://www.instagram.com/komorebikurume/",
  "snack-stella": "https://www.instagram.com/members_stellae/",
  "girlsbar-lips": "https://www.instagram.com/girls.bar_lips/",
  "girlsbar-secret": "https://www.instagram.com/girls.bar.secret/",
  "lounge-carat": "https://www.instagram.com/lounge.carat/",
  "lounge-ryusei": "https://www.instagram.com/loungeryusei/",
  "lounge-kanade": "https://www.instagram.com/members_kanade/",
};

// INSTAGRAM_LOGOS の件数上限(2026-07-29 制定の運用ルール③)。
// 公式Instagramプロフィール画像の自サイト保存(rehost)は、他にロゴを得られない店舗に限った例外運用であり、
// 無制限に広げないための歯止めとして上限を設けている。
// 上限に達したら「自動的に続けない」ことが運用ルールの趣旨なので、
// 超過した場合はビルドを失敗させて必ず人が判断する導線に戻す。
// 上限そのものを引き上げるには、README「著作権リスク階層の線引き」項の運用ルールの見直しが必要。
//
// 【算出根拠】ルール制定時から一貫して「公開店舗数の25%相当」を上限としている。
//   - 2026-07-29 制定時: 公開161店 × 25% ≒ 40件
//   - 2026-07-30 改定 : 接待を伴う業態の掲載開始により掲載277店 × 25% ≒ 69件
// 割合(25%)は変えていない。母数(公開店舗数)が増えた分だけ上限を引き上げたもの。
const INSTAGRAM_LOGOS_MAX = 69;
{
  const igLogoCount = Object.keys(INSTAGRAM_LOGOS).length;
  if (igLogoCount > INSTAGRAM_LOGOS_MAX) {
    throw new Error(
      `INSTAGRAM_LOGOS が上限を超えています(${igLogoCount}件 > 上限${INSTAGRAM_LOGOS_MAX}件)。` +
        `公式Instagramプロフィール画像の自サイト保存は上限${INSTAGRAM_LOGOS_MAX}件までの例外運用です。` +
        `件数を減らすか、運用ルール(README「著作権リスク階層の線引き」項)の見直しを経てから上限を変更してください。`
    );
  }
}

// ============================================================
// ロゴの出所解決(2026-07-28、社長承認の機能追加: ホットペッパー logo_image でロゴ自動付与)
//
// 【優先順位】
//   (1) VENUE_LOGOS(店の公式サイトの正規ロゴ)… 最優先。出所が公式サイトなので
//       ホットペッパーのクレジットは付けない(付けると出所の取り違えになる)。
//   (2) (1)が無く、INSTAGRAM_LOGOS(自サイト保存の公式Instagramプロフィール画像・再ホスト)が
//       あればそれを使う。出所は各店の公式Instagramなので、その旨を正確にクレジットする
//       (venueLogoCreditHtml の instagram-local 分岐。自サイト保存のため「保存していません」とは書かない)。
//   (3) (1)(2)が無く、ホットペッパー グルメの logo_image があればそれをロゴに使う。
//       出所はホットペッパー グルメ Webサービス(公式API)なので、規約どおり
//       「【画像提供：ホットペッパー グルメ】」相当のクレジットを必ず伴わせる
//       (店舗ページ=venueLogoCreditHtml の可視クレジット行 / カード=画像の title・alt に明示 +
//        全ページ共通フッターの「Powered by ホットペッパーグルメ Webサービス」で担保)。
//   (4) いずれも無ければ null(呼び出し側でネームタイルにフォールバック)。
//
// 【ホットリンク/非保存】(2)の imageUrl は imgfp.hotp.jp のURLをそのまま参照する <img>。
// 画像ファイルは保存・コミットしない(data/photos.generated.json は .gitignore 対象で、
// fetch-photos.js が CIで毎回生成)。読み込み失敗時は onerror で業態アイコンにフォールバックする。
// ============================================================
function resolveVenueLogo(v) {
  const official = VENUE_LOGOS[v.id];
  if (official && official.imageUrl) {
    return { source: "official", imageUrl: official.imageUrl, bg: official.bg || "light" };
  }
  // (2) 公式ロゴが無ければ、自サイト保存の公式Instagramプロフィール画像(再ホスト)を使う。
  // imageUrl はサイトのベースパス付きローカルパス。画像は assets/insta-logos/{id}.jpg を dist へコピー済み。
  const igSource = INSTAGRAM_LOGOS[v.id];
  if (igSource) {
    return { source: "instagram-local", imageUrl: url(`/assets/insta-logos/${v.id}.jpg`), bg: "light", igUrl: igSource };
  }
  const hp = VENUE_PHOTOS[v.id];
  if (hp && hp.logo) {
    return { source: "hotpepper", imageUrl: hp.logo, bg: "light", hpUrl: hp.hpUrl || "" };
  }
  return null;
}

// ============================================================
// 看板ネームプレート(ネームタイル)— ロゴ画像が無い店のフォールバック(2026-07-28)
//
// 公式ロゴもホットペッパー画像も無い店に、業態アイコンの代わりに「店名から作る看板風の
// ネームプレート」を出す。外部データ・画像は一切使わず HTML+CSS だけで描画するため、
// 著作権・規約リスクはゼロ(自前生成・クレジット不要)。本物の画像がある店は従来どおり
// 画像を優先し、ネームタイルは出さない(=あくまで画像が無い店のフォールバック)。
// ============================================================
// 業態 → 看板の英字ラベル(izakaya→IZAKAYA 等)。
const CATEGORY_PLATE_LABELS = {
  bar: "BAR",
  izakaya: "IZAKAYA",
  concafe: "CONCAFE",
  shisha: "SHISHA",
  poker: "POKER",
  // --- 2026-07-30 公開開始の5業態 ---
  snack: "SNACK",
  kyabakura: "KYABAKURA",
  lounge: "LOUNGE",
  club: "CLUB",
  girlsbar: "GIRLS BAR",
};

// ネームタイルのプレート本体(店名+業態ラベル+光点)を描画する。
// extraClass/hidden は onerror フォールバック用(画像読み込み失敗時に表示するため既定は hidden)。
function nameTilePlateHtml(v, extraClass, hidden) {
  const label = CATEGORY_PLATE_LABELS[v.category] || String(v.category || "").toUpperCase();
  const cls = "nametile-plate" + (extraClass ? ` ${extraClass}` : "");
  return `<span class="${cls}"${hidden ? " hidden" : ""}><span class="nametile-dot" aria-hidden="true"></span><span class="nametile-name">${escapeHtml(v.name)}</span><span class="nametile-cat">${escapeHtml(label)}</span></span>`;
}

// 店舗ロゴの枠(カード/ヒーロー)を描画する。ロゴが解決できた店舗はロゴ画像に差し替え、
// 公式ロゴもホットペッパー画像も無い店は看板ネームプレート(ネームタイル)を出す。
// 画像の読み込みに失敗した場合も onerror でネームタイルにフォールバックする。
// variant: "card" | "hero"
function venueIconSlotHtml(v, variant) {
  const cls = variant === "hero" ? "venue-hero-icon" : "venue-card-icon";
  const logo = resolveVenueLogo(v);
  // (3) 公式ロゴもホットペッパー画像も無い店は、業態アイコンではなくネームタイルを表示する。
  if (!logo) return `<span class="${cls} nametile">${nameTilePlateHtml(v, "", false)}</span>`;
  const bgClass = logo.bg === "dark" ? " has-logo-dark" : "";
  const isHp = logo.source === "hotpepper";
  const isIg = logo.source === "instagram-local";
  // ホットペッパー由来のロゴには規約準拠のクレジットを alt・title にも明示する。
  // 公式Instagram由来(自サイト保存)のロゴは、カードでも店名が伝わるよう alt・title に店名を出す。
  // (省スペースのカードでも画像に帰属が付き、全ページ共通フッターの「Powered by …」で site-wide の
  //  クレジットも担保される。店舗ページ側では venueLogoCreditHtml が可視クレジット行を別途出す。)
  const alt = isHp
    ? `${v.name}のロゴ(画像提供：ホットペッパー グルメ)`
    : isIg
      ? `${v.name}のロゴ(公式Instagramより)`
      : `${v.name}のロゴ`;
  const titleAttr = isHp
    ? ` title="【画像提供：ホットペッパー グルメ】"`
    : isIg
      ? ` title="${escapeHtml(v.name)}"`
      : "";
  // onerror: ロゴ枠の白背景等の装飾を外し、コンテナをネームタイル化して、隠してあるプレートを
  // 表示する(画像が消えたまま空白になったり、業態アイコンに戻ったりするのを防ぐ)。
  // 店舗ページでは、ロゴが出せなかったのに出典表記だけ残るのを防ぐため出典行も隠す。
  const onerror =
    "this.style.display='none';this.parentNode.classList.remove('has-logo','has-logo-dark');this.parentNode.classList.add('nametile');" +
    "var f=this.nextElementSibling;if(f){f.hidden=false;}" +
    (variant === "hero"
      ? "var c=document.getElementById('venue-logo-credit');if(c){c.hidden=true;}"
      : "");
  return `<span class="${cls} has-logo${bgClass}"><img class="venue-logo-img" src="${escapeHtml(logo.imageUrl)}" alt="${escapeHtml(alt)}"${titleAttr} loading="lazy" decoding="async" referrerpolicy="no-referrer-when-downgrade" onerror="${onerror}">${nameTilePlateHtml(v, "venue-logo-fallback", true)}</span>`;
}

// 店舗ページに出す、ロゴの出典表記(一覧カードには出さない)。
// - 公式サイトロゴ: 提供元(公式サイト)へのリンク + 削除依頼の案内。ホットペッパークレジットは付けない。
// - ホットペッパー logo_image: 規約準拠の「【画像提供：ホットペッパー グルメ】」+ 店舗ページへのリンク。
function venueLogoCreditHtml(v) {
  const logo = resolveVenueLogo(v);
  if (!logo) return "";
  if (logo.source === "hotpepper") {
    const moreLink = logo.hpUrl
      ? ` <a class="venue-hero-photo-more" href="${escapeHtml(logo.hpUrl)}" rel="nofollow noopener" target="_blank">ホットペッパーで見る ↗</a>`
      : "";
    return `<p class="small logo-credit" id="venue-logo-credit">ロゴ画像【画像提供：ホットペッパー グルメ】(提供元のサーバー上の画像を直接参照して表示しています。当サイトには保存していません)${moreLink}</p>`;
  }
  // 公式Instagramのプロフィール画像を自サイトに保存(再ホスト)して使っている店。
  // 自サイト保存なので「保存していません」とは書かず、出典の公式Instagramへのリンクを付けて正確に表記する。
  if (logo.source === "instagram-local") {
    return `<p class="small logo-credit" id="venue-logo-credit">ロゴ画像: <a href="${escapeHtml(logo.igUrl)}" rel="nofollow noopener" target="_blank">${escapeHtml(v.name)} 公式Instagram</a>のプロフィール画像を出典としています。掲載を希望されない店舗様は${contactFormLink("こちらのお問い合わせフォーム")}からご連絡ください。速やかに対応いたします。</p>`;
  }
  const official = VENUE_LOGOS[v.id];
  return `<p class="small logo-credit" id="venue-logo-credit">ロゴ画像: <a href="${escapeHtml(official.siteUrl)}" rel="nofollow noopener" target="_blank">${escapeHtml(official.siteLabel)}</a>のものを直接参照して表示しています(当サイトには保存していません)。掲載を希望されない店舗様は${contactFormLink("こちらのお問い合わせフォーム")}からご連絡ください。速やかに対応いたします。</p>`;
}

// ============================================================
// 公式SNS・ホームページのリンク表示(2026-07-25、社長要望
// 「店舗のSNSやホームページがあるならそれも店舗ページに載せましょう」)
//
// 【方針・制約】「その店の公式発信」だけを載せる。第三者のグルメ/情報サイト・ポータル・
// まとめサイト(食べログ・ホットペッパー・Retty・ぐるなび・Yahoo!・con-ca・town-night・
// pokepara・cafecon・nights.fun・arne・kurumefan 等)は、このセクションには一切出さない。
// 従来どおり店舗ページ下部の「情報源」セクション(出典表示)にのみ出す。
//
// 出所は2系統。いずれも「店自身の公式チャネル」であることを担保できるものに限定する:
//   (A) sources 内の公式SNS: instagram.com / x.com・twitter.com / facebook.com・fb.com / note.com。
//       これらのアカウントURLは既存運用で「店舗公式アカウント本人」であることを目視照合して
//       から sources に登録している(README「Instagram公式埋め込み・公式プロフィールリンク」
//       参照)。プラットフォームのホスト名が固定なので、第三者のグルメ/情報サイトが混入しない。
//   (B) 公式サイト: VENUE_LOGOS[id].siteUrl / OFFICIAL_PHOTOS[id][0].sourceUrl(配列の1枚目)。
//       これらはロゴ・公式写真の採用時に「禁止対象の第三者グルメサイト系列(owst.jp / r-corona.jp 等)
//       でないか」を確認済みのキュレーション済みURL(README「ロゴ・写真の採否基準」参照)。
//
// 【なぜ sources から公式サイトを機械抽出しないか】公開137店の sources を全走査したところ、
// 上記(A)のSNS以外で「店の独自ドメイン公式サイト」に当たるホストは1件も無く(独自ドメインは
// すべて VENUE_LOGOS/OFFICIAL_PHOTOS 側に登録済み)、残りはすべて既知の第三者ポータルだった。
// ここで blocklist 方式(既知の第三者「以外」を公式とみなす)を採ると、将来 sources に未知の
// 第三者ポータルが増えたとき「公式」欄へ誤って混入するリスクがある。そのため公式サイトは上記
// (B)の allowlist のみを採用する。新たに公式サイトを載せたい場合は VENUE_LOGOS もしくは
// OFFICIAL_PHOTOS に登録する(=採否基準のチェックを通す)。
// ============================================================

// 公式SNS/サイトのアイコン(自作インラインSVG。外部リソース・外部フォントは一切使わない)。
const OFFICIAL_LINK_ICONS = {
  // 地球儀(公式サイト)。currentColor で着色。
  website: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.7 3 2.7 15 0 18M12 3c-2.7 3-2.7 15 0 18"/></svg>`,
  // Instagram(角丸四角+レンズ+右上ドット)。
  instagram: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17" cy="7" r="1.15" fill="currentColor" stroke="none"/></svg>`,
  // X(旧Twitter)公式マーク(塗り)。
  x: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.53 3h3.02l-6.6 7.54L21.75 21h-6.08l-4.77-6.23L5.44 21H2.42l7.06-8.07L2.25 3h6.23l4.31 5.7L17.53 3zm-1.06 16.17h1.67L7.6 4.74H5.81l10.66 14.43z"/></svg>`,
  // Facebook 公式マーク(塗り)。
  facebook: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.9v-2.9h2.54V9.85c0-2.52 1.49-3.91 3.78-3.91 1.1 0 2.24.2 2.24.2v2.47h-1.26c-1.24 0-1.63.78-1.63 1.57v1.88h2.78l-.44 2.9h-2.34V22c4.78-.76 8.43-4.92 8.43-9.94z"/></svg>`,
  // note(公式note)。記事(横罫)アイコンで表現。ラベル「公式note」で明示。
  note: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="3.5" width="15" height="17" rx="2.5"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>`,
};

// 公式SNSとして採用する固定ホスト → 種別。ホスト名が固定なので第三者サイトは入らない。
const OFFICIAL_SNS_HOSTS = {
  "instagram.com": "instagram",
  "x.com": "x",
  "twitter.com": "x",
  "facebook.com": "facebook",
  "fb.com": "facebook",
  "note.com": "note",
};

const OFFICIAL_LINK_LABELS = {
  website: "公式サイト",
  instagram: "Instagram",
  x: "X（旧Twitter）",
  facebook: "Facebook",
  note: "公式note",
};

// 表示順: 公式サイト → Instagram → X → Facebook → note
const OFFICIAL_LINK_ORDER = { website: 0, instagram: 1, x: 2, facebook: 3, note: 4 };

function linkHost(u) {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  } catch (e) {
    return "";
  }
}

// SNSアカウントのハンドル(@xxx)をURLから推定する。
// 投稿/リール等(プロフィールでない)の場合や取得できない場合は空文字を返す。
function snsHandle(u) {
  try {
    let seg = (new URL(u).pathname.split("/").filter(Boolean)[0] || "").replace(/^@/, "");
    if (!seg || /^(p|reel|reels|explore|stories|share|hashtag|tags)$/i.test(seg)) return "";
    return "@" + seg;
  } catch (e) {
    return "";
  }
}

// 店舗の「公式SNS・ホームページ」リンクを表示順で返す。該当が無ければ空配列。
// 同一の公式サイトホスト・同一SNSプラットフォームの重複は1つにまとめる。
function officialLinksFor(v) {
  const links = [];
  const seenHosts = new Set(); // 公式サイトのホスト重複排除(ロゴと公式写真で同一サイトを指すケース)
  const seenTypes = new Set(); // SNSはプラットフォームごとに1つ

  // (B) 公式サイト(allowlist): ロゴ・公式写真のキュレーション済みURL
  // OFFICIAL_PHOTOS は配列(複数枚対応)なので、代表として1枚目の sourceUrl を使う
  // (同じ店の公式写真は基本的に同一の公式サイトから採っているため1件で十分)。
  const siteUrls = [];
  if (VENUE_LOGOS[v.id] && VENUE_LOGOS[v.id].siteUrl) siteUrls.push(VENUE_LOGOS[v.id].siteUrl);
  const officialPhotos = OFFICIAL_PHOTOS[v.id];
  if (officialPhotos && officialPhotos[0] && officialPhotos[0].sourceUrl) siteUrls.push(officialPhotos[0].sourceUrl);
  for (const su of siteUrls) {
    const h = linkHost(su);
    if (!h || seenHosts.has(h)) continue;
    seenHosts.add(h);
    links.push({ type: "website", url: su, label: OFFICIAL_LINK_LABELS.website, sub: h });
  }

  // (A) 公式SNS(sources のうち固定ホストのプラットフォームのみ)
  for (const s of v.sources || []) {
    const type = OFFICIAL_SNS_HOSTS[linkHost(s.url)];
    if (!type || seenTypes.has(type)) continue;
    seenTypes.add(type);
    links.push({ type, url: s.url, label: OFFICIAL_LINK_LABELS[type], sub: snsHandle(s.url) });
  }

  links.sort((a, b) => OFFICIAL_LINK_ORDER[a.type] - OFFICIAL_LINK_ORDER[b.type]);
  return links;
}

function officialLinksSectionHtml(v) {
  const links = officialLinksFor(v);
  if (links.length === 0) return "";
  const items = links
    .map(
      (l) =>
        `      <a class="official-link official-link-${l.type}" href="${escapeHtml(l.url)}" rel="nofollow noopener" target="_blank">
        <span class="official-link-ic">${OFFICIAL_LINK_ICONS[l.type]}</span>
        <span class="official-link-body"><span class="official-link-label">${escapeHtml(l.label)}</span>${l.sub ? `<span class="official-link-sub">${escapeHtml(l.sub)}</span>` : ""}</span>
        <span class="official-link-arrow" aria-hidden="true">↗</span>
      </a>`
    )
    .join("\n");
  return `
  <section class="info-section">
    <h2 class="section-heading"><span class="section-heading-icon">🌐</span>公式SNS・ホームページ</h2>
    <p class="small">この店舗が公式に発信しているアカウント・サイトです(当サイトとは別の運営です)。</p>
    <div class="official-links">
${items}
    </div>
  </section>`;
}

// ============================================================
// Googleマップ 地図表示(基本は外部リンク。一部店舗で iframe 埋め込みをテスト中)
//
// 【経緯】
// - 当初、キーレス地図iframe(www.google.com/maps/embed?pb=<自作base64>)を実装したが、
//   pb を住所の base64 で自作していたのは本物のGoogle形式(座標/場所ID)ではなく無効で、
//   品質管理部の実測で全件 404 + X-Frame-Options: SAMEORIGIN となり撤回した(2026-07-19)。
// - その後、全店舗で「Googleマップで開く」外部リンク(/maps/search/?api=1&query=...、
//   実測 HTTP 200)に一本化した。
//
// 【2026-07-20 地図iframe埋め込みの段階テスト → 2026-07-21 全店展開(社長判断)】
// maps.google.com/maps?q=<住所>&output=embed 形式(APIキー不要の消費者向けキーレス埋め込み。
// api=1 の外部リンクと同じ消費者向けGoogle Maps規約の系列)の iframe を、まず代表3店舗で
// テストし、社長が実機(スマホ/PC)で地図表示を確認済みとの判断を受けて、住所が番地まで
// 明確な全店舗(isMappableAddress が真の店舗)に展開する。住所が曖昧な店舗は従来どおり
// 外部リンクのみ。iframe が表示されない環境のフォールバックとして、iframe 直下に
// 「Googleマップで開く」外部リンクを全店で必ず残す。
//
// 【実測事実(curl、2026-07-20)】この output=embed URL は:
//   - 初段: HTTP 301 + X-Frame-Options: SAMEORIGIN、www.google.com/maps/embed?origin=mfe&pb=... へ
//     リダイレクト
//   - リダイレクト最終先: HTTP 200、X-Frame-Options ヘッダなし
//   ブラウザは通常リダイレクトの X-Frame-Options を無視し最終応答のみを評価するため実ブラウザでは
//   frameable になり得る。実ブラウザでの最終描画は、テスト3店舗について社長が実機で確認済み
//   (この形式の横展開は同じ挙動になる)。当開発環境(コマンドライン)では実描画は検証できない。
// ============================================================

// 住所から括弧内の注記(例: 「(西鉄久留米駅徒歩5分)」「(要確認)」)を除去する。
function stripAddressNotes(address) {
  if (!address) return "";
  return address.replace(/[（(][^）)]*[）)]/g, "").trim();
}

// 地図検索クエリに具体的な住所を使えるか(丁目・番地レベルの番号を含むか)を判定する。
function isMappableAddress(address) {
  const a = stripAddressNotes(address);
  if (!a) return false;
  if (/\d+[-‐−ー－]\d+/.test(a)) return true; // 25-43 のような番地
  if (/町\d/.test(a)) return true; // ○○町5 のような表記
  if (/\d+番/.test(a)) return true;
  return false;
}

// 「Googleマップで開く」外部リンク(Geoガイドラインが明示的に許可している
// 「View on Google Maps」ボタン相当)。住所が具体的ならその住所で、曖昧なら店名+地域で検索する。
function mapSearchLink(v) {
  const a = stripAddressNotes(v.address);
  const q = isMappableAddress(v.address) ? a : `${v.name} 久留米`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

// キーレス地図埋め込みURL(APIキー不要、消費者向け output=embed 形式)。
// クエリは「店名 住所」にして、住所だけの場合より特定店舗へ解決しやすくする。
// ベストエフォート(必ず出るとは限らない)。GOOGLE_MAPS_EMBED_KEY が未設定のときの
// フォールバックとして使う(ローカルビルドが退行なく通るように)。
function mapOutputEmbedUrl(name, address) {
  const a = stripAddressNotes(address);
  const q = `${name} ${a}`.trim();
  return `https://maps.google.com/maps?q=${encodeURIComponent(q)}&output=embed`;
}

// 地図埋め込みURLを返す。
// - GOOGLE_MAPS_EMBED_KEY がある(本番)場合: Maps Embed API の place モードを使う。
//   q=「店名 住所」で店舗ピンに解決し、地図枠内にGoogleのクチコミ★カード(店名・★評価・件数)を出す。
//   place_id は不要(q での解決を確認済み)。language/region で日本語・日本地域に寄せる。
// - キーが無い(ローカル/未設定)場合: 従来のキーレス output=embed 形式にフォールバックする(退行なし)。
// 住所が番地まで明確な店のみ呼ばれる(mapSectionHtml側で isMappableAddress で制御)。
function mapEmbedUrl(name, address) {
  const a = stripAddressNotes(address);
  const q = `${name} ${a}`.trim();
  if (GOOGLE_MAPS_EMBED_KEY) {
    return `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(GOOGLE_MAPS_EMBED_KEY)}&q=${encodeURIComponent(q)}&language=ja&region=JP`;
  }
  return mapOutputEmbedUrl(name, address);
}

function mapSectionHtml(v) {
  const searchLink = mapSearchLink(v);
  const label = isMappableAddress(v.address)
    ? "🗺 Googleマップで場所を見る ↗"
    : "🗺 Googleマップで場所を探す ↗";
  const addrNote = isMappableAddress(v.address)
    ? `<p class="small">住所: ${escapeHtml(stripAddressNotes(v.address))}(正確な位置・営業状況は店舗の公式情報でご確認ください)</p>`
    : "";

  // 住所が番地まで明確な店舗すべてに iframe 埋め込みを出す(住所が曖昧な店舗は外部リンクのみ)。
  const showEmbed = isMappableAddress(v.address);
  const embedHtml = showEmbed
    // referrerpolicy="origin": ブラウザが参照元としてオリジン(https://nattuuuzamiurai.github.io/)のみを送る。
    // Maps Embed APIキーのHTTPリファラー制限はオリジン(ルート)は許可するが深いパス(/kurume-bar-navi/venues/...)を
    // 弾く設定になっており、no-referrer-when-downgradeだと本番でフルパスが送られ403(not authorized)で地図が壊れる。
    // originに固定することで、どのページからでもオリジンのみが送られ制限を確実に通過する(実測: オリジン参照元=200)。
    ? `<div class="map-embed-wrap">
      <iframe src="${escapeHtml(mapEmbedUrl(v.name, v.address))}" title="${escapeHtml(v.name)}の地図(Googleマップ)" loading="lazy" style="border:0;" allowfullscreen referrerpolicy="origin"></iframe>
    </div>`
    : "";

  return `<div class="map-section">
    <h2 class="section-heading"><span class="section-heading-icon">🗺</span>地図・アクセス</h2>
    ${embedHtml}
    <p><a class="map-link-button" href="${escapeHtml(searchLink)}" rel="nofollow noopener" target="_blank">${label}</a></p>
    ${addrNote}
  </div>`;
}

// ============================================================
// 絞り込み(エリア・業態・タグ・営業時間・予算・支払い・喫煙を組み合わせるファセット絞り込みUI)
// ============================================================

// 店舗カード(および店舗ページ)に付与する機械可読な絞り込み用属性。
// data-open は「曜日,開始分,終了分」の3つ組をセミコロン区切りで並べたもの(深夜は24:00超=1440分超で表現)。
function venueFacetAttrs(v) {
  const attrs = [];
  const sched = parseSchedule(v.hours, v.closedDays);
  if (sched.parsed) {
    attrs.push(` data-open="${sched.slots.map((s) => `${s.day},${s.start},${s.end}`).join(";")}"`);
    if (sched.fuzzy) attrs.push(` data-open-fuzzy="1"`);
  }
  const buckets = budgetBucketsFor(v);
  if (buckets.length) attrs.push(` data-budget="${buckets.join(" ")}"`);
  const pay = paymentTokens(v.payment);
  if (pay.length) attrs.push(` data-pay="${pay.join(" ")}"`);
  const smoke = smokingToken(v.smoking);
  if (smoke) attrs.push(` data-smoke="${smoke}"`);
  if (isChargeFree(v.charge)) attrs.push(` data-charge="free"`);
  return attrs.join("");
}

// 追加ファセット(予算・支払い・喫煙・チャージ)の定義。値は venueFacetAttrs が出す属性値と対応する。
const EXTRA_FACETS = [
  {
    key: "budget",
    title: "予算(夜)",
    options: BUDGET_BUCKETS.map((b) => ({ value: b.value, label: b.label })),
    match: (v) => budgetBucketsFor(v),
  },
  {
    key: "pay",
    title: "支払い",
    options: [
      { value: "card", label: "カード可" },
      { value: "cashless", label: "キャッシュレス可" },
      { value: "cash", label: "現金のみ" },
    ],
    match: (v) => paymentTokens(v.payment),
  },
  {
    key: "smoke",
    title: "喫煙",
    options: [
      { value: "no", label: "禁煙" },
      { value: "mixed", label: "分煙" },
      { value: "yes", label: "喫煙可" },
    ],
    match: (v) => (smokingToken(v.smoking) ? [smokingToken(v.smoking)] : []),
  },
  {
    key: "charge",
    title: "チャージ",
    options: [{ value: "free", label: "お通し・チャージなし" }],
    match: (v) => (isChargeFree(v.charge) ? ["free"] : []),
  },
];

// 追加ファセットのチェックボックス群。該当0件の選択肢は出さない(押しても0件になる選択肢を減らす)。
function extraFacetHtml(venues, facet) {
  const counts = new Map();
  for (const v of venues) for (const val of facet.match(v)) counts.set(val, (counts.get(val) || 0) + 1);
  const items = facet.options
    .filter((o) => counts.get(o.value))
    .map(
      (o) =>
        `<label class="tag-filter-item"><input type="checkbox" data-facet="${facet.key}" value="${escapeHtml(o.value)}"> ${escapeHtml(o.label)}<span class="count">(${counts.get(o.value)})</span></label>`
    );
  if (items.length === 0) return "";
  return `<div class="facet-group">
  <p class="facet-group-title">${escapeHtml(facet.title)}で絞り込む</p>
  <div class="tag-filter-list">
${items.join("\n")}
  </div>
</div>`;
}

// 「今から行ける店」の絞り込みUI。曜日・時刻は既定で端末の現在時刻を使い、任意で変更できる。
function openNowFacetHtml(venues) {
  const withSchedule = venues.filter((v) => parseSchedule(v.hours, v.closedDays).parsed).length;
  if (withSchedule === 0) return "";
  const hourOptions = Array.from({ length: 24 }, (_, h) => `<option value="${h * 60}">${h}:00</option>`).join("");
  const dayOptions = ["日", "月", "火", "水", "木", "金", "土"]
    .map((d, i) => `<option value="${i}">${d}曜</option>`)
    .join("");
  return `<div class="facet-group facet-open">
  <label class="open-now-toggle"><input type="checkbox" data-facet="open" value="now"> <strong>🕒 いま営業中の店だけ</strong><span class="count">(営業時間が分かる${withSchedule}件が対象)</span></label>
  <div class="open-now-time" hidden>
    <span class="small">時間を指定:</span>
    <select class="open-day" aria-label="曜日">${dayOptions}</select>
    <select class="open-hour" aria-label="時刻">${hourOptions}</select>
    <button type="button" class="open-now-reset">今に戻す</button>
  </div>
</div>`;
}

// 与えられた店舗一覧から、指定した軸(area/category/tags)の件数を集計する。
function collectFacetCounts(venues, key) {
  const counts = new Map();
  for (const v of venues) {
    if (key === "tags") {
      for (const t of v.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    } else {
      const val = v[key];
      if (val) counts.set(val, (counts.get(val) || 0) + 1);
    }
  }
  return counts;
}

function collectTagCounts(venues) {
  const counts = collectFacetCounts(venues, "tags");
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"));
}

// facetGroupHtml: エリア/業態/タグそれぞれのチェックボックス群を生成する。
// idToLabel: {id: 表示名} のマップ(エリア名・業態名を出すため)。省略時はidをそのまま表示。
// collapsedIfLarge: 選択肢が多い軸を <details> アコーディオンにまとめる。
// openByDefault: そのアコーディオンを既定で開いた状態で出す(タグのように「押せると気づきにくい」
//                主要な軸は、中身が一目で見えるよう開いておく)。
function facetGroupHtml(facetKey, title, counts, idToLabel, collapsedIfLarge, openByDefault = false) {
  if (counts.size === 0) return "";
  const entries = [...counts.entries()].sort((a, b) => {
    if (idToLabel) return 0; // エリア/業態は元の並び順を維持
    return b[1] - a[1] || a[0].localeCompare(b[0], "ja");
  });
  const items = entries
    .map(([value, count]) => {
      const label = idToLabel ? idToLabel[value] || value : value;
      return `<label class="tag-filter-item"><input type="checkbox" data-facet="${facetKey}" value="${escapeHtml(value)}"> ${escapeHtml(label)}<span class="count">(${count})</span></label>`;
    })
    .join("\n");
  const inner = `<div class="tag-filter-list">
${items}
  </div>`;
  if (collapsedIfLarge && entries.length > 8) {
    // summary を「押せると一目で分かる」ピル型ボタン + シェブロンにする(見た目は assets/style.css)。
    // 既定のマーカー(三角)は list-style:none / ::marker で消し、自前のシェブロンを回転させる。
    const openAttr = openByDefault ? " open" : "";
    return `<details class="facet-group facet-accordion"${openAttr}>
  <summary class="facet-summary">
    <span class="facet-summary-label">${escapeHtml(title)}で絞り込む<span class="facet-summary-count">${entries.length}</span></span>
    <span class="facet-chevron" aria-hidden="true">▾</span>
  </summary>
  <p class="facet-hint small">タップして選択(複数選べます)</p>
  ${inner}
</details>`;
  }
  return `<div class="facet-group">
  <p class="facet-group-title">${escapeHtml(title)}で絞り込む</p>
  ${inner}
</div>`;
}

// filterWidgetHtml: 与えられた店舗一覧を対象に、area/category/tags の
// 3軸を組み合わせて絞り込めるUIを生成する。各軸は「このリストに実在する値」だけを
// 選択肢にし、選択肢が1種類以下の軸(常に同じ値になる=絞り込む意味がない)は表示しない
// (例: エリア別ページではエリア軸を出さない、業態別ページでは業態軸を出さない)。
function filterWidgetHtml(venues, venueListId, areas, categories) {
  const areaIdToLabel = Object.fromEntries(areas.map((a) => [a.id, a.name]));
  const categoryIdToLabel = Object.fromEntries(categories.map((c) => [c.id, c.name]));

  const areaCounts = collectFacetCounts(venues, "area");
  const categoryCounts = collectFacetCounts(venues, "category");
  const tagCounts = new Map(collectTagCounts(venues));

  const groups = [];
  const openHtml = openNowFacetHtml(venues);
  if (openHtml) groups.push(openHtml);
  if (areaCounts.size > 1) groups.push(facetGroupHtml("area", "エリア", areaCounts, areaIdToLabel, false));
  if (categoryCounts.size > 1) groups.push(facetGroupHtml("category", "業態", categoryCounts, categoryIdToLabel, false));
  for (const facet of EXTRA_FACETS) {
    const html = extraFacetHtml(venues, facet);
    if (html) groups.push(html);
  }
  // タグは「押せると気づきにくい」という指摘を受け、既定で開いた状態(open)にして中身を見せる。
  if (tagCounts.size > 0) groups.push(facetGroupHtml("tags", "タグ", tagCounts, null, true, true));

  if (groups.length === 0) return "";

  return `<div class="tag-filter" data-target="${venueListId}">
  <p class="tag-filter-title">条件で絞り込む <button type="button" class="tag-filter-reset">条件をクリア</button></p>
${groups.join("\n")}
  <p class="filter-result-count small"></p>
  <p class="filter-note small">営業時間・予算・支払い・喫煙の条件は、その項目の情報を確認できた店舗のみが対象です(情報が未取得の店舗は絞り込むと表示されません)。掲載内容は最新でない場合があります。</p>
</div>`;
}

// 絞り込みウィジェットを動かすクライアントサイドJS(外部ライブラリ不使用)。
// area・category・budget・pay・smoke は「選択した値のいずれかに一致(OR)」、tags は
// 「選択したタグをすべて含む(AND)」、軸をまたぐ場合はAND。
// 「いま営業中」は data-open(曜日,開始分,終了分)を端末の現在時刻(または指定時刻)と突き合わせる。
// 深夜営業(24:00超)は前日の枠として判定するため、前日の枠も +1440分 でチェックする。
// URLクエリ(?open=now&budget=2000-3000&pay=card ...)で初期条件を指定できる(トップからの導線用)。
const FILTER_SCRIPT = `<script>
(function () {
  function isOpenAt(card, day, minutes) {
    var raw = card.getAttribute('data-open');
    if (!raw) return false;
    var slots = raw.split(';');
    for (var i = 0; i < slots.length; i++) {
      var p = slots[i].split(',');
      var d = +p[0], s = +p[1], e = +p[2];
      if (d === day && minutes >= s && minutes < e) return true;
      if (d === (day + 6) % 7 && minutes + 1440 >= s && minutes + 1440 < e) return true;
    }
    return false;
  }
  document.querySelectorAll('.tag-filter').forEach(function (widget) {
    var targetId = widget.getAttribute('data-target');
    var list = document.getElementById(targetId);
    if (!list) return;
    var cards = list.querySelectorAll('.venue-card');
    var allInputs = widget.querySelectorAll('input[type=checkbox]');
    var countEl = widget.querySelector('.filter-result-count');
    var openBox = widget.querySelector('input[data-facet=open]');
    var timeWrap = widget.querySelector('.open-now-time');
    var daySel = widget.querySelector('.open-day');
    var hourSel = widget.querySelector('.open-hour');
    function setToNow() {
      var now = new Date();
      if (daySel) daySel.value = String(now.getDay());
      if (hourSel) hourSel.value = String(now.getHours() * 60);
    }
    setToNow();
    function selectedByFacet(facet) {
      return Array.prototype.filter.call(allInputs, function (c) {
        return c.checked && c.getAttribute('data-facet') === facet;
      }).map(function (c) { return c.value; });
    }
    function anyOf(card, attr, selected) {
      if (selected.length === 0) return true;
      var vals = (card.getAttribute(attr) || '').split(' ');
      for (var i = 0; i < selected.length; i++) if (vals.indexOf(selected[i]) !== -1) return true;
      return false;
    }
    function apply() {
      var selArea = selectedByFacet('area');
      var selCategory = selectedByFacet('category');
      var selTags = selectedByFacet('tags');
      var selBudget = selectedByFacet('budget');
      var selPay = selectedByFacet('pay');
      var selSmoke = selectedByFacet('smoke');
      var selCharge = selectedByFacet('charge');
      var openOn = openBox && openBox.checked;
      if (timeWrap) timeWrap.hidden = !openOn;
      var day = daySel ? +daySel.value : 0;
      var minutes = hourSel ? +hourSel.value : 0;
      if (openOn && !daySel) { var n = new Date(); day = n.getDay(); minutes = n.getHours() * 60 + n.getMinutes(); }
      var visible = 0;
      cards.forEach(function (card) {
        var area = card.getAttribute('data-area') || '';
        var category = card.getAttribute('data-category') || '';
        var tags = (card.getAttribute('data-tags') || '').split('|');
        var match =
          (selArea.length === 0 || selArea.indexOf(area) !== -1) &&
          (selCategory.length === 0 || selCategory.indexOf(category) !== -1) &&
          selTags.every(function (t) { return tags.indexOf(t) !== -1; }) &&
          anyOf(card, 'data-budget', selBudget) &&
          anyOf(card, 'data-pay', selPay) &&
          anyOf(card, 'data-smoke', selSmoke) &&
          anyOf(card, 'data-charge', selCharge) &&
          (!openOn || isOpenAt(card, day, minutes));
        card.style.display = match ? '' : 'none';
        if (match) visible++;
      });
      var anyChecked = Array.prototype.some.call(allInputs, function (c) { return c.checked; });
      if (countEl) countEl.textContent = anyChecked ? visible + '件該当(全' + cards.length + '件中)' : '';
    }
    allInputs.forEach(function (c) { c.addEventListener('change', apply); });
    if (daySel) daySel.addEventListener('change', apply);
    if (hourSel) hourSel.addEventListener('change', apply);
    var nowBtn = widget.querySelector('.open-now-reset');
    if (nowBtn) nowBtn.addEventListener('click', function (e) { e.preventDefault(); setToNow(); apply(); });
    var resetBtn = widget.querySelector('.tag-filter-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', function (e) {
        e.preventDefault();
        allInputs.forEach(function (c) { c.checked = false; });
        setToNow();
        apply();
      });
    }
    // URLクエリによる初期条件(トップページの「いま営業中」「予算で探す」などからの導線)
    var params = new URLSearchParams(window.location.search);
    var applied = false;
    ['open', 'area', 'category', 'budget', 'pay', 'smoke', 'charge', 'tags'].forEach(function (facet) {
      var raw = params.get(facet);
      if (!raw) return;
      raw.split(',').forEach(function (val) {
        Array.prototype.forEach.call(allInputs, function (c) {
          if (c.getAttribute('data-facet') === facet && c.value === val) { c.checked = true; applied = true; }
        });
      });
    });
    if (applied) apply();
  });
})();
</script>`;

// 【文言の根拠】
//   - 風営法22条1項5号: 接待飲食等営業者が18歳未満の者を「客として」営業所に立ち入らせることを**禁止**。
//     時間帯による例外があるのは2条1項5号営業(ゲームセンター等)で、接待飲食等営業には例外がない。
//     したがって「制限されます」は禁止の過小表現になるため「入店できません」とする。
//   - 20歳未満の飲酒禁止は店舗の業態を問わない(二十歳未満ノ者ノ飲酒ノ禁止ニ関スル法律1条)ため、
//     「酒類を提供する店舗では」という限定はかえって誤読を招く。
//   - 加えて風営法22条1項6号は、接待飲食等営業者が20歳未満の者に酒類・たばこを提供することを禁止している
//     (罰則あり)。読者にとっても店舗にとっても重要なので明記する。
//   - ただし「当該店舗が接待飲食等営業である」とは断定しない(当サイトは各店の許可状況を確認していない)。
//     「該当する店舗では」という条件形を維持する。
const AGE_RESTRICTION_NOTICE =
  "風営法上の接待飲食等営業に該当する店舗では、18歳未満の方は客として入店できません。" +
  "また、20歳未満の方の飲酒は法律で禁止されており、これらの店舗では20歳未満の方への酒類・たばこの提供も禁止されています。" +
  "入店可否・年齢確認の取り扱いは各店舗の定めによりますので、詳細は各店舗にご確認ください。";

const DISCLAIMER = `本サイトは福岡県久留米市・西鉄久留米駅周辺エリア(一番街・二番街・文化街周辺)の飲食店・ナイトライフ店舗を紹介する情報サイトです。掲載情報は店舗公式サイト・SNS、飲食店情報サイト、業界団体(組合)の公表情報など公開されている情報をもとに${BUILD_DATE}時点で作成した要約であり、内容の正確性・最新性を保証するものではありません。ご来店の際は、営業時間・定休日・料金等を各店舗の最新の公式情報でご確認ください。性風俗関連特殊営業に該当する業態は掲載対象外です。${AGE_RESTRICTION_NOTICE}店舗の写真・ロゴは、店舗ご自身の公式発信(公式サイト・公式Instagram)、またはホットペッパー グルメ Webサービス(リクルートが提供する公式API)を出典とするもののみを表示しています。写真および大半のロゴは提供元のサーバー上の画像を直接参照する形で表示しており(当サイトには保存していません)、一部の店舗ロゴのみ、各店の公式Instagramのプロフィール画像を出典として当サイトに保存(再ホスト)して表示しています(該当する店舗ページに出典の公式Instagramへのリンクを記載しています)。ホットペッパー グルメ由来の写真には「【画像提供：ホットペッパー グルメ】」を表示しています。それ以外の店舗の写真は各出典サイトでご覧いただけます(Instagram埋め込みや外部画像の参照の際は、お使いのブラウザが各社のサーバーと通信します)。本サイトに掲載している店舗名・ロゴ・商標は、各権利者に帰属します。当サイトは店舗を紹介する情報サイトであり、掲載店舗との間に提携・協賛・推奨・公認等の関係はありません。`;

// ============================================================
// 年齢制限の注意喚起(2026-07-30)
//
// スナック・キャバクラ・ラウンジ・クラブ・ガールズバーの公開開始にともない導入した。
// これらは風営法上の接待飲食等営業(1号営業)に該当しうる業態であり、該当する店舗では
// 18歳未満は客として入店できない。利用者が来店前に知っておくべき情報なので、対象カテゴリの
// 店舗ページ・カテゴリページに注記を出す(全ページ共通のフッター DISCLAIMER にも同旨を記載)。
//
// 【文言の方針】当サイトは各店舗が風営法上のどの営業区分の許可・届出で営業しているかを
// 確認しておらず、断定できる立場にない。そのため「この店は接待飲食等営業である」という
// 店舗個別の断定は書かず、「該当する店舗では制限される」という一般的な注意喚起にとどめ、
// 実際の入店可否は各店舗に確認するよう案内する。
// (レビュー部の運用: 各店舗の営業実態・適法性について当サイトが事実を主張しない)
// ============================================================
const NIGHTLIFE_CATEGORIES = new Set(["snack", "kyabakura", "lounge", "club", "girlsbar"]);


// 業態は NIGHTLIFE_CATEGORIES 外だが、当サイトが表示している料金体系(キャストドリンク等)から
// 年齢制限の注意喚起を出すべき店。業態そのものは店ご自身の表記が無いため変更しない。
const AGE_NOTICE_EXTRA_VENUE_IDS = new Set(["izakaya-nyanko-sakaba"]);

// 対象カテゴリ、または上記の個別指定のときだけ年齢制限の注記を返す(それ以外は空文字)。
function ageRestrictionNoticeHtml(categoryId, venueId) {
  if (!NIGHTLIFE_CATEGORIES.has(categoryId) && !AGE_NOTICE_EXTRA_VENUE_IDS.has(venueId)) return "";
  return `<p class="notice notice-age"><strong>年齢制限について</strong><br>${escapeHtml(AGE_RESTRICTION_NOTICE)}</p>`;
}

// 下部固定タブバー(モバイルのアプリ風ナビ。PCではCSSで非表示にしヘッダーナビを使う)。
// マップ相当の独立ページは無い(キーレス地図埋め込みは1店ずつのため全店ピンの集約地図を作れない)
// ため、4つ目のタブは「業態」にしている。
function tabbarHtml(activeTab) {
  const tabs = [
    { key: "home", href: url("/"), icon: "home", label: "ホーム" },
    { key: "search", href: url("/search/"), icon: "search", label: "さがす" },
    { key: "area", href: url("/areas/"), icon: "pin", label: "エリア" },
    { key: "category", href: url("/categories/"), icon: "grid", label: "業態" },
  ];
  return `<nav class="tabbar" aria-label="サイト内ナビゲーション">
${tabs
  .map(
    (t) =>
      `  <a class="tab${t.key === activeTab ? " on" : ""}" href="${t.href}"${t.key === activeTab ? ' aria-current="page"' : ""}><span class="tab-ic">${UI_ICONS[t.icon]}</span>${t.label}</a>`
  )
  .join("\n")}
</nav>`;
}

function layout({ title, description, pathname, bodyHtml, jsonLd, robotsNoindex, extraScript, activeTab, footerNote }) {
  const fullTitle = title ? `${title} | ${SITE_NAME}` : SITE_NAME;
  const canonical = absoluteUrl(pathname);
  const jsonLdScript = jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>`
    : "";
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${escapeHtml(fullTitle)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="#1b1e34">
<link rel="canonical" href="${canonical}">
${robotsNoindex ? '<meta name="robots" content="noindex">' : ""}
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(fullTitle)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
<link rel="stylesheet" href="${url("/assets/style.css")}">
${jsonLdScript}
</head>
<body>
<header class="site-header">
  <a class="site-title" href="${url("/")}">久留米<small>飲み屋</small>ナビ</a>
  <nav class="site-nav">
    <a href="${url("/search/")}">さがす</a>
    <a href="${url("/areas/")}">エリア</a>
    <a href="${url("/categories/")}">業態</a>
    <a href="${url("/tags/")}">タグ</a>
  </nav>
</header>
<main>
${bodyHtml}
</main>
<footer class="site-footer">
  <p>${escapeHtml(footerNote || DISCLAIMER)}</p>
  <p class="powered-by"><a href="https://webservice.recruit.co.jp/" rel="nofollow noopener" target="_blank">Powered by ホットペッパーグルメ Webサービス</a></p>
  <p><a href="${url("/about/")}">このサイトについて・掲載店舗の関係者の方へ</a></p>
  <p>&copy; ${SITE_NAME}</p>
</footer>
${tabbarHtml(activeTab)}
${CARD_OPEN_SCRIPT}
${extraScript || ""}
</body>
</html>
`;
}

// 予算(夜)を短いラベルに整形(カード用)。例: 「〜3,000円」「2,000〜3,000円」「4,000円〜」。
function budgetShort(v) {
  const b = parseBudget(v.budgetDinner);
  if (!b) return "";
  const y = (n) => n.toLocaleString("en-US");
  if (b.min === 0) return `〜${y(b.max)}円`;
  if (b.max >= 100000) return `${y(b.min)}円〜`;
  if (b.min === b.max) return `${y(b.min)}円`;
  return `${y(b.min)}〜${y(b.max)}円`;
}

// チャージ/お通しを短いラベルに整形(カード用)。金額が読めれば「チャージ◯円」等、
// 「なし」明言なら「お通しなし」。それ以外は空(カードを煩雑にしない)。
function chargeShort(v) {
  if (!v.charge) return "";
  if (isChargeFree(v.charge)) return "お通しなし";
  const t = normalizeText(v.charge);
  const m = t.match(/(チャージ|お通し|席料|サービス料)[^、。]{0,10}?(\d{2,5})\s*円/);
  if (m) {
    const kind = m[1] === "チャージ" ? "チャージ" : m[1] === "席料" ? "席料" : "お通し";
    return `${kind}${Number(m[2]).toLocaleString("en-US")}円`;
  }
  return "";
}

// カードの2行目に出すタグ(最大3個)。頻出タグには絵文字を添える。
const TAG_EMOJI = {
  "ダーツ": "🎯", "ビリヤード": "🎱", "カラオケ": "🎤", "昼カラオケ": "🎤",
  "生演奏/ライブ": "🎸", "音楽バー": "🎵", "DJ": "🎧", "スポーツ観戦": "📺",
  "スポーツ観戦バー": "📺", "シーシャあり": "💨", "ボードゲーム": "🎲",
  "個室あり": "🚪", "座敷": "🌱", "カウンター席あり": "🪑", "一人客歓迎": "🙋",
  "深夜営業": "🌙", "飲み放題あり": "🍺", "もつ鍋": "🍲", "焼き鳥": "🍢",
  "餃子": "🥟", "焼肉": "🥩", "海鮮/魚介": "🐟", "ワイン充実": "🍷",
  "カクテル充実": "🍸", "日本酒充実": "🍶", "焼酎": "🍶", "メイドカフェ": "☕",
};
function cardTagLineHtml(v) {
  const tags = (v.tags || []).slice(0, 3);
  if (tags.length === 0) return "";
  const inner = tags
    .map((t) => `${TAG_EMOJI[t] || ""}${escapeHtml(t)}`)
    .join(" ・ ");
  return `<span class="card-tagline">${inner}</span>`;
}

// カード内の営業中バッジ(クライアントサイドで端末時刻から判定して表示する。
// data-open がある店舗のみ。初期は hidden で、CARD_OPEN_SCRIPT が点灯させる)。
function cardOpenPillHtml(v) {
  const sched = parseSchedule(v.hours, v.closedDays);
  if (!sched.parsed) return "";
  return `<span class="pill pill-open" data-open-pill hidden>🟢 <span data-open-label>営業中</span></span>`;
}

// 一覧に並ぶ店舗カード(2026-07-23 デザイン刷新: アバター + 店名 + 要点チップ)。
// フィルタ機能のため class="venue-card" と data-* 属性は従来どおり維持する。
function venueCardHtml(v, categories, areas) {
  const cat = categories.find((c) => c.id === v.category);
  const area = areas.find((a) => a.id === v.area);
  const color = CATEGORY_COLORS[v.category] || "#9d8dff";
  const tags = v.tags || [];
  const tagsAttr = escapeHtml(tags.join("|"));

  const bShort = budgetShort(v);
  const cShort = chargeShort(v);
  const pills = [
    // 営業状況の裏付けが取れていない店は、一覧の時点で分かるようにする。
    // 店舗ページには注記が出るが、一覧では区別が付かず、業態によっては過半数が未確認になるため
    // (2026-07-30 時点でクラブ8店中5店・ラウンジ18店中10店)。
    // 掲載店を貶める表示にはしない。警告色は使わず、控えめなグレーの小さなチップに留める。
    UNVERIFIED_VENUE_IDS.has(v.id) ? `<span class="pill pill-unverified" title="当サイトでこの店舗の営業状況を確認できていません">営業状況未確認</span>` : "",
    cardOpenPillHtml(v),
    bShort ? `<span class="pill">${escapeHtml(bShort)}</span>` : "",
    `<span class="pill pill-area">${escapeHtml(area ? area.name : v.area)}</span>`,
    cShort ? `<span class="pill pill-charge">${escapeHtml(cShort)}</span>` : "",
  ]
    .filter(Boolean)
    .join("");

  return `<li class="venue-card" data-area="${escapeHtml(v.area)}" data-category="${escapeHtml(v.category)}" data-tags="${tagsAttr}"${venueFacetAttrs(v)} style="--cat-color:${color}">
  <a class="venue-card-link" href="${url(`/venues/${v.id}/`)}">
    ${venueIconSlotHtml(v, "card")}
    <span class="venue-card-body">
      <span class="venue-card-cat">${escapeHtml(categoryLabel(v, cat ? cat.name : v.category))}</span>
      <span class="venue-name">${escapeHtml(v.name)}</span>
      ${ratingCardHtml(v)}
      <span class="venue-card-pills">${pills}</span>
      ${cardTagLineHtml(v)}
    </span>
  </a>
</li>`;
}

// 一覧に店舗カードがあるページで、営業中バッジをクライアントサイドで点灯するスクリプト。
// data-open(曜日,開始分,終了分)を端末の現在時刻と突き合わせる(深夜跨ぎは前日枠で判定)。
const CARD_OPEN_SCRIPT = `<script>
(function () {
  var now = new Date();
  var day = now.getDay();
  var minutes = now.getHours() * 60 + now.getMinutes();
  function openAt(raw) {
    if (!raw) return false;
    var slots = raw.split(';');
    for (var i = 0; i < slots.length; i++) {
      var p = slots[i].split(',');
      var d = +p[0], s = +p[1], e = +p[2];
      if (d === day && minutes >= s && minutes < e) return true;
      if (d === (day + 6) % 7 && minutes + 1440 >= s && minutes + 1440 < e) return true;
    }
    return false;
  }
  document.querySelectorAll('.venue-card[data-open]').forEach(function (card) {
    var pill = card.querySelector('[data-open-pill]');
    if (!pill) return;
    if (openAt(card.getAttribute('data-open'))) {
      var fuzzy = card.getAttribute('data-open-fuzzy') === '1';
      var lbl = pill.querySelector('[data-open-label]');
      if (fuzzy && lbl) lbl.textContent = '営業中(終了時刻要確認)';
      pill.hidden = false;
    }
  });
})();
</script>`;

function renderTop(venues, areas, categories, guides) {
  const countBy = (fn) => venues.filter(fn).length;

  // 業態タイル(色・アイコン・件数の大きなタップ領域)。
  const catTiles = categories
    .map((c) => {
      const n = countBy((v) => v.category === c.id);
      const note = c.id === "izakaya" ? " ・ 焼肉/焼鳥も" : "";
      return `<a class="cat-tile" style="--cc:${CATEGORY_COLORS[c.id] || "#9d8dff"}" href="${url(`/categories/${c.id}/`)}">
    <span class="cat-tile-ic">${CATEGORY_ICONS[c.id] || ""}</span>
    <span class="cat-tile-nm">${escapeHtml(c.name)}</span>
    <span class="cat-tile-ct"><b>${n}</b> 軒${note}</span>
  </a>`;
    })
    .join("\n");

  // エリアタイル。
  const areaTiles = areas
    .map(
      (a) =>
        `<a class="area-tile" href="${url(`/areas/${a.id}/`)}">${uiIcon("pin", "area-tile-ic")}<span class="area-tile-nm">${escapeHtml(a.name)}</span><span class="count">${countBy((v) => v.area === a.id)}軒</span></a>`
    )
    .join("\n");

  // こだわりチップ(既存の絞り込みへの導線。/search/ がURLクエリを読んで初期条件を適用する)。
  const chip = (href, label) => `<a class="home-chip" href="${href}">${label}</a>`;
  const chips = [
    chip(url(`/search/?tags=${encodeURIComponent("ダーツ")}`), "🎯 ダーツ"),
    chip(url(`/search/?tags=${encodeURIComponent("個室あり")}`), "🚪 個室あり"),
    chip(url(`/search/?tags=${encodeURIComponent("深夜営業")}`), "🌙 深夜営業"),
    chip(url("/search/?pay=cash"), "💴 現金のみ"),
    chip(url("/search/?smoke=no"), "🚭 禁煙"),
    chip(url("/search/?charge=free"), "🍶 お通しなし"),
  ].join("\n");

  // 予算チップ。
  const budgetChips = BUDGET_BUCKETS.map((b) =>
    chip(url(`/search/?budget=${b.value}`), escapeHtml(b.label))
  ).join("\n");

  const openCount = countBy((v) => parseSchedule(v.hours, v.closedDays).parsed);
  // いま営業中の店数は端末時刻依存のためクライアントサイドで確定する。全店のスケジュールを
  // コンパクトに渡し、ヒーローの「◯軒」を書き換える(取得できない場合は固定文言にフォールバック)。
  const schedules = venues
    .map((v) => {
      const s = parseSchedule(v.hours, v.closedDays);
      return s.parsed ? s.slots.map((x) => `${x.day},${x.start},${x.end}`).join(";") : "";
    })
    .filter(Boolean);
  const openCountScript = `<script>
(function () {
  var data = ${JSON.stringify(schedules)};
  var now = new Date(), day = now.getDay(), min = now.getHours() * 60 + now.getMinutes();
  function openAt(raw){var a=raw.split(';');for(var i=0;i<a.length;i++){var p=a[i].split(','),d=+p[0],s=+p[1],e=+p[2];if(d===day&&min>=s&&min<e)return true;if(d===(day+6)%7&&min+1440>=s&&min+1440<e)return true;}return false;}
  var n = 0; for (var i = 0; i < data.length; i++) if (openAt(data[i])) n++;
  var el = document.getElementById('open-now-count');
  if (el) el.textContent = 'この時間に営業中 ・ ' + n + '軒';
})();
</script>`;

  const body = `
<section class="home-hero">
  <p class="home-eyebrow">📍 西鉄久留米・一番街 / 二番街 / 文化街</p>
  <h1>今夜、どこ飲む？</h1>
  <p class="home-sub">久留米の飲み屋 <strong>${venues.length}軒</strong> から、いま開いてる店・予算・こだわりで選ぶ。</p>
  <a class="open-cta" href="${url("/search/?open=now")}">
    <span class="open-cta-live"></span>
    <span class="open-cta-text"><b>いま開いてる店</b><span id="open-now-count">営業時間が分かる${openCount}軒から探す</span></span>
    <span class="open-cta-arrow">→</span>
  </a>
  <a class="home-searchbar" href="${url("/search/")}">🔍 エリア・業態・こだわりで探す</a>
</section>

<section class="home-sec">
  <div class="sec-title"><h2>業態から選ぶ</h2></div>
  <div class="cat-tiles">
${catTiles}
  </div>
</section>

<section class="home-sec">
  <div class="sec-title"><h2>予算から選ぶ</h2></div>
  <div class="home-chips">
${budgetChips}
  </div>
</section>

<section class="home-sec">
  <div class="sec-title"><h2>こだわりでサッと</h2><a href="${url("/search/")}">すべての条件 →</a></div>
  <div class="home-chips">
${chips}
  </div>
</section>

<section class="home-sec">
  <div class="sec-title"><h2>エリアから選ぶ</h2>${(guides || []).some((g) => !g.areaId) ? `<a href="${url("/guides/")}">エリアガイドを読む →</a>` : ""}</div>
  <div class="area-tiles">
${areaTiles}
  </div>
</section>

<section class="home-sec">
  <div class="sec-title"><h2>掲載店舗</h2><a href="${url("/categories/")}">すべて見る →</a></div>
  <ul class="venue-list">
${venues.slice(0, 8).map((v) => venueCardHtml(v, categories, areas)).join("\n")}
  </ul>
</section>
`;
  return layout({
    title: null,
    description:
      "福岡県久留米市・西鉄久留米駅周辺(一番街・二番街・文化街)の飲み屋を、いま営業中か・予算・カード可否・禁煙・お通しの有無まで組み合わせて探せる情報サイト。バー・居酒屋・コンカフェ・シーシャ・アミューズメントポーカーバー・スナック・キャバクラ・ラウンジ・クラブ・ガールズバーを掲載。",
    pathname: "/",
    bodyHtml: body,
    activeTab: "home",
    extraScript: openCountScript,
  });
}

// ============================================================
// エリアガイド記事(社長指示 2026-08-22「中身の質の底上げ」(2))
//
// 企画部・コンテンツ制作部が執筆した地元編集コンテンツ(content/guides/*.md)を
// /guides/{id}/ ページとして公開する。a0-hub.md は4エリアを比較する「ハブ」記事で
// /guides/ トップに、a1〜a4 は各エリアの個別ガイドとして /guides/{areaId}/ に対応させる
// (areaId は data/areas.json の area.id と同じ値を使い、エリアページとの相互リンクを単純にする)。
// ============================================================
const GUIDES = [
  { file: "a0-hub", slug: "", areaId: null, navLabel: "エリア比較ガイド" },
  { file: "a1-ichibangai", slug: "ichibangai", areaId: "ichibangai" },
  { file: "a2-nibangai", slug: "nibangai", areaId: "nibangai" },
  { file: "a3-bunkagai", slug: "bunkagai", areaId: "bunkagai" },
  { file: "a4-eki-shuhen", slug: "eki-shuhen", areaId: "eki-shuhen" },
];

function guidePathname(slug) {
  return slug ? `/guides/${slug}/` : "/guides/";
}

// content/guides/*.md を読み込み、GUIDES の並び順で { ...guide, title, description, bodyHtml } の配列を返す。
// ファイルが無い場合は警告してスキップする(ビルド自体は止めない。原稿が未着手のエリアがあっても
// サイトは成立するようにするため)。
function loadGuides() {
  const loaded = [];
  for (const g of GUIDES) {
    const filePath = path.join(GUIDES_DIR, `${g.file}.md`);
    if (!fs.existsSync(filePath)) {
      console.warn(`[warn] ガイド原稿が見つかりません: ${filePath}`);
      continue;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    // Markdown中のリンクURLを実際の出力先URLに変換する。
    //   - "./aN-xxx.md" 形式(記事間の相互リンク) → 対応する /guides/{slug}/
    //   - "/venues/..." 等サイト内絶対パス → BASE_PATH を付与
    //   - "http(s)://..." → 外部リンクとしてそのまま
    const resolveLink = (href) => {
      const mdMatch = href.match(/^\.\/(a\d-[a-z-]+)\.md$/);
      if (mdMatch) {
        const target = GUIDES.find((x) => x.file === mdMatch[1]);
        if (target) return { href: url(guidePathname(target.slug)) };
        console.warn(`[warn] ガイド内リンクの参照先が見つかりません: ${href}(${g.file}.md)`);
        return { href: "#" };
      }
      if (/^https?:\/\//i.test(href)) return { href };
      // それ以外(/venues/..., /about/ など)はサイト内絶対パスとして扱う。
      return { href: url(href) };
    };
    const { title, description, bodyHtml } = parseGuideMarkdown(raw, { resolveLink });
    loaded.push({ ...g, title, description, bodyHtml });
  }
  return loaded;
}

// エリアページ・店舗ページから、対応するエリアガイドへのリンクを出すための共通ヘルパー。
function guideLinkForArea(guides, areaId) {
  const g = guides.find((x) => x.areaId === areaId);
  if (!g) return "";
  return `<p class="guide-crosslink"><a href="${url(guidePathname(g.slug))}">📖 ${escapeHtml(g.title)} を読む →</a></p>`;
}

function renderGuideIndexPage(hubGuide, guides) {
  const areaGuides = guides.filter((g) => g.areaId);
  const body = `
<nav class="breadcrumb"><a href="${url("/")}">TOP</a> &gt; エリアガイド</nav>
<h1>${escapeHtml(hubGuide.title)}</h1>
<div class="guide-body">
${hubGuide.bodyHtml}
</div>
<section class="info-section">
  <h2 class="section-heading">エリア別ガイド一覧</h2>
  <ul class="link-list-detailed">
${areaGuides
  .map((g) => `    <li><a href="${url(guidePathname(g.slug))}"><strong>${escapeHtml(g.title)}</strong></a></li>`)
  .join("\n")}
  </ul>
</section>
`;
  return layout({
    title: hubGuide.title,
    description: hubGuide.description || hubGuide.title,
    pathname: guidePathname(hubGuide.slug),
    bodyHtml: body,
  });
}

function renderGuidePage(guide, area) {
  const breadcrumb = area
    ? `<nav class="breadcrumb"><a href="${url("/")}">TOP</a> &gt; <a href="${url("/guides/")}">エリアガイド</a> &gt; <a href="${url(`/areas/${area.id}/`)}">${escapeHtml(area.name)}</a></nav>`
    : `<nav class="breadcrumb"><a href="${url("/")}">TOP</a> &gt; <a href="${url("/guides/")}">エリアガイド</a></nav>`;
  const areaLinkHtml = area
    ? `<p class="guide-crosslink"><a href="${url(`/areas/${area.id}/`)}">📍 ${escapeHtml(area.name)}の店舗一覧を見る →</a></p>`
    : "";
  const body = `
${breadcrumb}
<h1>${escapeHtml(guide.title)}</h1>
<div class="guide-body">
${guide.bodyHtml}
</div>
${areaLinkHtml}
<p class="guide-crosslink"><a href="${url("/guides/")}">← エリアガイド一覧・4エリア比較に戻る</a></p>
`;
  return layout({
    title: guide.title,
    description: guide.description || guide.title,
    pathname: guidePathname(guide.slug),
    bodyHtml: body,
  });
}

function renderAreaIndex(areas, venues, guides) {
  const items = areas
    .map(
      (a) => `<li><a href="${url(`/areas/${a.id}/`)}"><strong>${escapeHtml(a.name)}</strong>(${venues.filter((v) => v.area === a.id).length}件)</a><p>${escapeHtml(a.summary)}</p></li>`
    )
    .join("\n");
  const hubGuide = (guides || []).find((g) => !g.areaId);
  const body = `
<h1>エリア一覧</h1>
<ul class="link-list-detailed">
${items}
</ul>
${hubGuide ? `<p class="guide-crosslink"><a href="${url("/guides/")}">📖 4エリアの違い・使い分けガイドを読む →</a></p>` : ""}
<p><a href="${url("/search/")}">エリア・業態・タグを組み合わせて絞り込む →</a></p>
`;
  return layout({
    title: "エリア一覧",
    description: "久留米飲み屋ナビが掲載する一番街・二番街・文化街・西鉄久留米駅周辺エリアの一覧。",
    pathname: "/areas/",
    bodyHtml: body,
    activeTab: "area",
  });
}

function renderCategoryIndex(categories, venues) {
  const items = categories
    .map(
      (c) => `<li><a class="category-link" href="${url(`/categories/${c.id}/`)}" style="--cat-color:${CATEGORY_COLORS[c.id] || "#9d8dff"}">${categoryIconHtml(c.id)}<span><strong>${escapeHtml(c.name)}</strong>(${venues.filter((v) => v.category === c.id).length}件)<br>${escapeHtml(c.summary)}</span></a></li>`
    )
    .join("\n");
  const body = `
<h1>業態一覧</h1>
<ul class="link-list-detailed category-index">
${items}
</ul>
<p><a href="${url("/search/")}">エリア・業態・タグを組み合わせて絞り込む →</a></p>
`;
  return layout({
    title: "業態一覧",
    description: "久留米飲み屋ナビが掲載するバー・居酒屋・コンカフェ・シーシャ・アミューズメントポーカーバー・スナック・キャバクラ・ラウンジ・クラブ・ガールズバーの一覧。",
    pathname: "/categories/",
    bodyHtml: body,
    activeTab: "category",
  });
}

function renderAreaPage(area, venues, categories, areas, guides) {
  const areaVenues = venues.filter((v) => v.area === area.id);
  const list = areaVenues.map((v) => venueCardHtml(v, categories, areas)).join("\n");
  const listId = "venue-list-area";
  const body = `
<nav class="breadcrumb"><a href="${url("/")}">TOP</a> &gt; <a href="${url("/areas/")}">エリア</a> &gt; ${escapeHtml(area.name)}</nav>
<h1>${escapeHtml(area.name)}の飲み屋一覧</h1>
<p>${escapeHtml(area.summary)}</p>
${guideLinkForArea(guides || [], area.id)}
${filterWidgetHtml(areaVenues, listId, areas, categories)}
<ul class="venue-list" id="${listId}">
${list || "<li>準備中です。</li>"}
</ul>
`;
  return layout({
    title: `${area.name}の飲み屋一覧`,
    description: `福岡県久留米市${area.name}エリアのバー・居酒屋・コンカフェ等の飲み屋一覧。${area.summary}`,
    pathname: `/areas/${area.id}/`,
    bodyHtml: body,
    extraScript: FILTER_SCRIPT,
    activeTab: "area",
  });
}

function renderCategoryPage(category, venues, areas, categories) {
  const catVenues = venues.filter((v) => v.category === category.id);
  const list = catVenues.map((v) => venueCardHtml(v, categories, areas)).join("\n");
  const listId = "venue-list-category";
  const body = `
<nav class="breadcrumb"><a href="${url("/")}">TOP</a> &gt; <a href="${url("/categories/")}">業態</a> &gt; ${escapeHtml(category.name)}</nav>
<h1>久留米・西鉄久留米駅周辺の${escapeHtml(category.name)}一覧</h1>
<p>${escapeHtml(category.summary)}</p>
${ageRestrictionNoticeHtml(category.id)}
${filterWidgetHtml(catVenues, listId, areas, categories)}
<ul class="venue-list" id="${listId}">
${list || "<li>準備中です。</li>"}
</ul>
`;
  return layout({
    title: `${category.name}一覧`,
    description: `福岡県久留米市・西鉄久留米駅周辺の${category.name}一覧。${category.summary}`,
    pathname: `/categories/${category.id}/`,
    bodyHtml: body,
    extraScript: FILTER_SCRIPT,
    activeTab: "category",
  });
}

function renderTagIndex(tagCounts) {
  const items = tagCounts
    .map(
      ([tag, count]) =>
        `<li><a href="${url(`/tags/${tagSlug(tag)}/`)}">${escapeHtml(tag)}<span class="count">(${count}件)</span></a></li>`
    )
    .join("\n");
  const body = `
<nav class="breadcrumb"><a href="${url("/")}">TOP</a> &gt; タグ</nav>
<h1>タグから探す</h1>
<p>ダーツ・カラオケなどの遊べる要素や、もつ鍋・焼肉などの料理ジャンル、個室の有無といった特徴からお店を探せます。</p>
<ul class="link-list">
${items}
</ul>
<p><a href="${url("/search/")}">エリア・業態・タグを組み合わせて絞り込む →</a></p>
`;
  return layout({
    title: "タグから探す",
    description: "久留米飲み屋ナビの店舗タグ一覧。ダーツ・カラオケ・個室あり・もつ鍋など、設備や料理ジャンルから店舗を絞り込めます。",
    pathname: "/tags/",
    bodyHtml: body,
  });
}

function renderTagPage(tag, venues, areas, categories) {
  const tagVenues = venues.filter((v) => (v.tags || []).includes(tag));
  const list = tagVenues.map((v) => venueCardHtml(v, categories, areas)).join("\n");
  const listId = "venue-list-tag";
  const body = `
<nav class="breadcrumb"><a href="${url("/")}">TOP</a> &gt; <a href="${url("/tags/")}">タグ</a> &gt; ${escapeHtml(tag)}</nav>
<h1>「${escapeHtml(tag)}」の店舗一覧</h1>
<p>「${escapeHtml(tag)}」のタグが付いている久留米・西鉄久留米駅周辺エリアの店舗 ${tagVenues.length}件です。</p>
${filterWidgetHtml(tagVenues, listId, areas, categories)}
<ul class="venue-list" id="${listId}">
${list || "<li>該当する店舗がありません。</li>"}
</ul>
`;
  return layout({
    title: `「${tag}」の店舗一覧`,
    description: `久留米・西鉄久留米駅周辺エリアで「${tag}」のタグが付いている店舗の一覧。`,
    pathname: `/tags/${tagSlug(tag)}/`,
    bodyHtml: body,
    extraScript: FILTER_SCRIPT,
  });
}

// エリア・業態・タグの3軸を同時に組み合わせて絞り込める統合の「探す」ページ。
function renderSearchPage(venues, areas, categories) {
  const list = venues.map((v) => venueCardHtml(v, categories, areas)).join("\n");
  const listId = "venue-list-search";
  const body = `
<nav class="breadcrumb"><a href="${url("/")}">TOP</a> &gt; 絞り込み検索</nav>
<h1>条件を組み合わせて久留米の飲み屋を探す</h1>
<p>いま営業中か・エリア・業態・予算・支払い方法・喫煙可否・お通しの有無・タグを、すべて組み合わせて絞り込めます(複数選択可)。</p>
${filterWidgetHtml(venues, listId, areas, categories)}
<ul class="venue-list" id="${listId}">
${list}
</ul>
`;
  return layout({
    title: "条件を組み合わせて探す(いま営業中・予算・カード可・禁煙)",
    description: "久留米・西鉄久留米駅周辺の飲み屋を、いま営業中・予算・支払い方法・喫煙可否・エリア・業態・タグを組み合わせて絞り込める検索ページ。",
    pathname: "/search/",
    bodyHtml: body,
    extraScript: FILTER_SCRIPT,
    activeTab: "search",
  });
}

const SCHEMA_DAYS = [
  "https://schema.org/Sunday",
  "https://schema.org/Monday",
  "https://schema.org/Tuesday",
  "https://schema.org/Wednesday",
  "https://schema.org/Thursday",
  "https://schema.org/Friday",
  "https://schema.org/Saturday",
];

function minutesToHHMM(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// パースできた営業時間を schema.org の OpeningHoursSpecification に変換する。
// 終了時刻が不明な枠(「〜LAST」等)は断定できないため出力しない。
function openingHoursSpec(v) {
  const sched = parseSchedule(v.hours, v.closedDays);
  if (!sched.parsed) return null;
  const groups = new Map();
  for (const s of sched.slots) {
    if (s.fuzzyEnd) continue;
    const key = `${s.start}-${s.end}`;
    if (!groups.has(key)) groups.set(key, { start: s.start, end: s.end, days: new Set() });
    groups.get(key).days.add(s.day);
  }
  if (groups.size === 0) return null;
  return [...groups.values()].map((g) => ({
    "@type": "OpeningHoursSpecification",
    dayOfWeek: [...g.days].sort().map((d) => SCHEMA_DAYS[d]),
    opens: minutesToHHMM(g.start),
    closes: minutesToHHMM(g.end),
  }));
}

function buildJsonLd(v, area, category) {
  const data = {
    "@context": "https://schema.org",
    "@type": category ? category.schemaType : "LocalBusiness",
    name: v.name,
    url: absoluteUrl(`/venues/${v.id}/`),
    address: {
      "@type": "PostalAddress",
      streetAddress: v.address || undefined,
      addressLocality: "久留米市",
      addressRegion: "福岡県",
      addressCountry: "JP",
    },
  };
  if (v.phone) data.telephone = v.phone;
  if (v.priceRange) data.priceRange = v.priceRange;
  else {
    // 構造化データ用に、予算(夜)の文字列から数値の範囲だけを取り出して整形する
    const b = parseBudget(v.budgetDinner);
    if (b) data.priceRange = b.min === 0 ? `〜${b.max}円` : b.min === b.max ? `${b.min}円` : `${b.min}〜${b.max}円`;
  }
  const spec = openingHoursSpec(v);
  if (spec) data.openingHoursSpecification = spec;
  return data;
}

// 店舗ページの「チャージ・お通し」ハイライト。
// 飲み屋で最も知りたい情報のひとつであり、かつGoogleマップでは分からない差別化要素のため、
// 店舗情報テーブルとは別に目立つブロックとして出す。「お通しなし」の明記もそれ自体が価値のある情報。
function chargeCalloutHtml(v) {
  if (!v.charge) return "";
  const free = isChargeFree(v.charge);
  return `<div class="charge-callout${free ? " charge-callout-free" : ""}">
    <p class="charge-callout-head"><span class="charge-callout-icon">${free ? "🎉" : "💴"}</span>チャージ・お通し${free ? "<span class=\"charge-badge\">なし</span>" : ""}</p>
    <p class="charge-callout-value">${escapeHtml(v.charge)}</p>
    <p class="small">料金は変更されることがあります。ご来店前に店舗の最新情報をご確認ください。</p>
  </div>`;
}

// 編集部コメント(EDITORIAL_NOTES にその店の記載がある場合のみ表示)。
function editorialNoteHtml(v) {
  const note = EDITORIAL_NOTES[v.id];
  if (!note) return "";
  return `<p class="venue-editorial-note">${escapeHtml(note)}</p>`;
}

// 店舗ページ上部に出す営業状況バッジ(端末の現在時刻で判定するためクライアントサイドで描画)。
const OPEN_NOW_BADGE_SCRIPT = `<script>
(function () {
  var el = document.getElementById('open-now-badge');
  if (!el) return;
  var raw = el.getAttribute('data-open');
  if (!raw) return;
  var now = new Date();
  var day = now.getDay();
  var minutes = now.getHours() * 60 + now.getMinutes();
  var open = false;
  raw.split(';').forEach(function (slot) {
    var p = slot.split(',');
    var d = +p[0], s = +p[1], e = +p[2];
    if (d === day && minutes >= s && minutes < e) open = true;
    if (d === (day + 6) % 7 && minutes + 1440 >= s && minutes + 1440 < e) open = true;
  });
  var fuzzy = el.getAttribute('data-open-fuzzy') === '1';
  el.textContent = open ? (fuzzy ? '営業中(終了時刻は要確認)' : '営業中') : '営業時間外';
  el.className = 'open-badge ' + (open ? 'open-badge-on' : 'open-badge-off');
  el.hidden = false;
})();
</script>`;

function renderVenuePage(v, area, category, allVenues, areas, categories, guides) {
  // 表示できる出典。求人媒体等(NON_PUBLISHABLE_SOURCE_RE)は data/venues.json の
  // internalSources に退避してあり、そもそも v.sources には入っていない。
  const shownSources = v.sources || [];
  const sourcesHtml = shownSources
    .map((s) => `<li><a href="${escapeHtml(s.url)}" rel="nofollow noopener" target="_blank">${escapeHtml(s.label)}</a></li>`)
    .join("\n");
  // 出典を1件も表示できない店(参照した情報源がすべて「店舗ページには出さない媒体」だった場合)は、
  // 空の <ul> を出さず、なぜリンクが無いのかを明示する。
  const sourcesBodyHtml =
    shownSources.length > 0
      ? `    <p class="small">上記の情報は下記の公開情報をもとにした要約です(${BUILD_DATE}時点)。最新の営業状況は各出典元、または店舗の公式サイト・SNSでご確認ください。</p>
    <ul class="sources">
${sourcesHtml}
    </ul>`
      : `    <p class="small">この店舗の情報は、当サイトが参照した公開情報をもとにした要約です(${BUILD_DATE}時点)。参照した情報源が、いずれも当サイトの掲載方針により店舗ページに掲載しない媒体だったため、この店舗については出典リンクを表示していません。最新の営業状況は店舗に直接ご確認ください。</p>`;

  const relatedInArea = allVenues
    .filter((x) => x.area === v.area && x.id !== v.id)
    .slice(0, 6)
    .map((x) => venueCardHtml(x, categories, areas))
    .join("\n");

  const sched = parseSchedule(v.hours, v.closedDays);
  const isUnverified = UNVERIFIED_VENUE_IDS.has(v.id);
  const unverifiedNotice = isUnverified
    ? `<p class="notice notice-unverified">⚠️ この店舗の営業状況を確認できていません。移転・閉店している可能性もあります。ご来店前に、最新の営業情報を出典元・店舗の公式情報で必ずご確認ください。</p>`
    : "";

  const photoSource = pickPhotoSource(v);
  const igEmbed = instagramEmbedHtml(v.id);
  const officialPhoto = officialPhotoHtml(v.id);
  // 写真(公式Instagram埋め込み or 公式サイト画像)を掲載している場合に表示する削除依頼案内。
  const photoRemovalNotice = `<p class="small photo-removal-notice">写真は店舗の公式発信(公式Instagram/公式サイト)を出典として掲載しています。掲載を希望されない店舗様は${contactFormLink("こちらのお問い合わせフォーム")}からご連絡ください。速やかに対応いたします。</p>`;
  const photoSectionHtml = igEmbed
    ? `<div class="photo-section">
    <h2 class="section-heading"><span class="section-heading-icon">📷</span>写真</h2>
    ${igEmbed}
    <p class="small">店舗公式アカウントのInstagram投稿を、Instagram公式の埋め込み機能で表示しています。${photoSource ? `他の写真は<a href="${escapeHtml(photoSource.url)}" rel="nofollow noopener" target="_blank">${escapeHtml(photoSource.label)}</a>でもご覧いただけます。` : ""}</p>
    ${photoRemovalNotice}
  </div>`
    : officialPhoto
    ? `<div class="photo-section">
    <h2 class="section-heading"><span class="section-heading-icon">📷</span>写真</h2>
    ${officialPhoto}
    ${photoRemovalNotice}
  </div>`
    : photoSource
    ? `<div class="photo-section">
    <a class="photo-link-button" href="${escapeHtml(photoSource.url)}" rel="nofollow noopener" target="_blank">📷 ${escapeHtml(photoSource.label)}で写真を見る ↗</a>
  </div>`
    : "";

  // 店舗情報を、アイコン付き2列カードグリッド(facts-grid)に整理する。
  // 値があるものだけ出す(営業時間は核情報なので常に出し、無ければ「情報準備中」)。
  const facts = [];
  facts.push({ icon: "clock", k: "営業時間", v: v.hours || "情報準備中(出典元でご確認ください)" });
  if (v.closedDays) facts.push({ icon: "cal", k: "定休日", v: v.closedDays });
  if (v.budgetDinner) facts.push({ icon: "yen", k: "予算(夜)", v: v.budgetDinner });
  if (v.budgetLunch) facts.push({ icon: "yen", k: "予算(昼)", v: v.budgetLunch });
  if (!v.budgetDinner && !v.budgetLunch && v.priceRange) facts.push({ icon: "yen", k: "価格帯", v: v.priceRange });
  if (v.seats) facts.push({ icon: "seat", k: "席数", v: v.seats });
  if (v.payment) facts.push({ icon: "card", k: "支払い", v: v.payment });
  if (v.smoking) facts.push({ icon: "smoke", k: "喫煙", v: v.smoking });
  if (v.reservation) facts.push({ icon: "check", k: "予約", v: v.reservation });
  if (v.phone) facts.push({ icon: "phone", k: "電話", v: v.phone });
  facts.push({ icon: "pin", k: "住所", v: v.address || "情報準備中" });
  if (v.walk) facts.push({ icon: "walk", k: "アクセス", v: v.walk });
  const factsGridHtml = `<div class="facts-grid">
${facts
  .map(
    (f) =>
      `    <div class="fact"><span class="fact-ic">${UI_ICONS[f.icon] || ""}</span><span class="fact-body"><span class="fact-k">${escapeHtml(f.k)}</span><span class="fact-v">${escapeHtml(f.v)}</span></span></div>`
  )
  .join("\n")}
  </div>`;

  const dtagsHtml = (v.tags || [])
    .map((t) => `<a class="dtag" href="${url(`/tags/${tagSlug(t)}/`)}">${escapeHtml(t)}</a>`)
    .join("");

  const body = `
<nav class="breadcrumb"><a href="${url("/")}">TOP</a> &gt; <a href="${url(`/areas/${area.id}/`)}">${escapeHtml(area.name)}</a> &gt; <a href="${url(`/categories/${category.id}/`)}">${escapeHtml(category.name)}</a> &gt; ${escapeHtml(v.name)}</nav>

<article class="venue-detail">
  <header class="venue-hero" style="--cat-color:${CATEGORY_COLORS[v.category] || "#9d8dff"};--cc:${CATEGORY_COLORS[v.category] || "#9d8dff"}">
    <div class="venue-hero-inner">
      ${venueIconSlotHtml(v, "hero")}
      <div class="venue-hero-text">
        <span class="venue-hero-cat">${escapeHtml(categoryLabel(v, category.name))}<span class="venue-hero-sep">・</span>${escapeHtml(area.name)}</span>
        <h1>${escapeHtml(v.name)}</h1>
        <div class="venue-hero-badges">
          ${sched.parsed ? `<span id="open-now-badge" class="open-badge" data-open="${sched.slots.map((s) => `${s.day},${s.start},${s.end}`).join(";")}"${sched.fuzzy ? ' data-open-fuzzy="1"' : ""} hidden></span>` : ""}
          <a class="pill pill-area" href="${url(`/areas/${area.id}/`)}">${escapeHtml(area.name)}</a>
          ${v.walk ? `<span class="pill">🚶 ${escapeHtml(v.walk)}</span>` : ""}
        </div>
      </div>
    </div>
  </header>
  ${editorialNoteHtml(v)}
  ${ratingHeroHtml(v)}
  ${venueLogoCreditHtml(v)}
  ${unverifiedNotice}

  ${venueHeroPhotoHtml(v)}

  ${chargeCalloutHtml(v)}

  <section class="info-section">
    <h2 class="section-heading"><span class="section-heading-icon">📋</span>店舗情報</h2>
    ${factsGridHtml}
    ${ageRestrictionNoticeHtml(v.category, v.id)}
  </section>

  ${dtagsHtml ? `<section class="info-section"><h2 class="section-heading"><span class="section-heading-icon">🏷</span>特徴・タグ</h2><div class="dtags">${dtagsHtml}</div></section>` : ""}

  ${officialLinksSectionHtml(v)}

  ${photoSectionHtml}

  ${mapSectionHtml(v)}

  <section class="info-section">
    <h2 class="section-heading"><span class="section-heading-icon">🔗</span>情報源</h2>
${sourcesBodyHtml}
  </section>

  <section class="info-section">
    <h2 class="section-heading"><span class="section-heading-icon">✉️</span>関係者の方へ</h2>
    <p>この店舗の情報に誤りがある、追加・修正をご希望の場合、または掲載を希望されない店舗様は${contactFormLink("こちらのお問い合わせフォーム")}からご連絡ください。速やかに対応いたします。</p>
  </section>
</article>

<section>
  <h2>${escapeHtml(area.name)}の他の店舗</h2>
  <ul class="venue-list">
${relatedInArea}
  </ul>
  ${guideLinkForArea(guides || [], area.id)}
</section>
`;

  const description = `${v.name}(福岡県久留米市${area.name}${v.walk ? "・" + v.walk : ""})の${category.name}情報。営業時間・アクセス・関連情報を掲載。`;

  return layout({
    title: `${v.name}(${area.name}) の営業時間・アクセス情報`,
    description,
    pathname: `/venues/${v.id}/`,
    bodyHtml: body,
    jsonLd: buildJsonLd(v, area, category),
    extraScript: (igEmbed ? INSTAGRAM_EMBED_SCRIPT : "") + (sched.parsed ? OPEN_NOW_BADGE_SCRIPT : ""),
  });
}

// about ページ専用のフッター注記。
//
// 【なぜ専用にするか(2026-08-22)】通常ページのフッターは共通 DISCLAIMER(掲載方針・出典・
// 商標帰属や提携関係の有無・年齢制限などをまとめた1段落)を表示する。about ページはその内容を
// 本文側で見出しごとに詳しく説明し直しているため、フッターにも同じ DISCLAIMER をそのまま出すと
// 同一ページ内で同じ趣旨の文(特に「提携・協賛・推奨・公認等の関係はない」旨)が繰り返される。
// 内容は削らず、about ページでは「本文で詳しく説明済み」であることだけをフッターで案内する形にして
// 重複を整理する(他の379ページのフッターは従来どおり DISCLAIMER 全文のまま変更しない)。
const ABOUT_FOOTER_NOTE =
  "掲載方針・情報源、写真・ロゴの出典、商標の帰属や提携関係の有無、年齢制限についてのご案内は、このページの本文でまとめて説明しています。";

function renderAboutPage() {
  const body = `
<h1>このサイトについて</h1>
<p class="about-lead">西鉄久留米・一番街 / 二番街 / 文化街エリアの飲み屋を紹介している「久留米飲み屋ナビ」です。運営者情報と、掲載にあたっての考え方をこのページにまとめました。</p>

<h2>運営者情報</h2>
<p>運営: エースハイ合同会社</p>

<h2>どんなサイトか</h2>
<p>久留米飲み屋ナビは、福岡県久留米市・西鉄久留米駅周辺(一番街・二番街・文化街周辺エリア)のバー・居酒屋・コンカフェ・シーシャ・アミューズメントポーカーバー・スナック・キャバクラ・ラウンジ・クラブ・ガールズバーなど、飲み屋を幅広く紹介する情報サイトです。</p>

<h2>掲載方針</h2>
<ul>
  <li>性風俗関連特殊営業(いわゆる「風俗」)は掲載対象外です。</li>
  <li>掲載情報は、店舗の公式サイト・SNS、飲食店情報サイト、業界団体(組合)の公表情報など、インターネット上に公開されている情報をもとに要約・作成しています。各店舗ページに情報源のリンクを掲載しています(参照した情報源が、当サイトの掲載方針により店舗ページに掲載しない媒体だけだった場合は、その旨を当該店舗ページに記載しています)。</li>
  <li>店舗の営業状況を当サイトで確認できていない場合は、その店舗ページに「営業状況を確認できていません」の注記を表示し、確認できていない営業時間・定休日は掲載していません。</li>
  <li>他サイトの文章・写真をそのまま転載(コピー・保存)することはしていません。店舗写真は、(1)店舗の公式サイト・公式Instagramなど<strong>店ご自身の公式発信</strong>、または(2)<strong>ホットペッパー グルメ Webサービス</strong>(リクルートが提供する公式API)を出典とし、いずれも提供元のサーバー上の画像を直接参照する形で表示しています(当サイトには保存していません)。ホットペッパー グルメ由来の写真には「【画像提供：ホットペッパー グルメ】」のクレジットと同サイトへのリンクを付けています。写真がない店舗は、業態を示す汎用アイコンを表示しています。</li>
  <li>店舗のロゴは、その店(またはチェーンの運営元)の公式サイト・公式Facebook、ホットペッパー グルメ Webサービス、または各店の公式Instagramに掲載されている画像を出典としています。多くは提供元のサーバー上の画像を直接参照する形で表示しています(当サイトのサーバーには保存していません)が、一部の店舗ロゴのみ、各店の公式Instagramのプロフィール画像を出典として当サイトに保存(再ホスト)して表示しています。いずれも出典元へのリンクを各店舗ページに記載しています。ロゴの掲載を希望されない場合は、下記の連絡先までお知らせください。</li>
  <li>営業時間・料金等は変更されることがあります。最新情報は各店舗の公式情報でご確認ください。</li>
</ul>

<h2>外部サービスの埋め込み・参照について</h2>
<p>本サイトの各店舗ページでは、Instagram公式の投稿埋め込み、Googleマップの地図埋め込み、各店の公式サイト画像・ホットペッパー グルメ Webサービスの画像の参照などを行っています。そのため、ページ閲覧時にお使いのブラウザから Instagram(Meta)・Google・リクルート(ホットペッパー グルメ)・各店の公式サイト等の外部サーバーへ通信が発生する場合があります。これら外部サービス側での情報の取り扱いは、各サービスのプライバシーポリシーに従います。</p>

<h2>商標・権利の帰属、および提携関係について</h2>
<p>本サイトに掲載している店舗名・ロゴ・商標は、各権利者に帰属します。当サイトは、公開されている情報をもとに店舗を紹介する情報サイトであり、<strong>掲載店舗との間に提携・協賛・推奨・公認等の関係は一切ありません</strong>。ロゴは、その店舗(またはチェーンの運営元)を識別しやすくする目的で、各店の公式サイト上の画像を参照して表示しているものであり、当サイトが各店舗から掲載の許諾や対価を受けていることを示すものではありません。</p>

<h2>掲載店舗の関係者の方へ</h2>
<p>当サイトへの掲載内容に誤りがある場合の修正依頼、掲載を希望されない場合の削除依頼については、${contactFormLink("こちらのお問い合わせフォーム")}からご連絡ください。速やかに対応いたします。</p>

<h2>年齢制限について</h2>
<p>${escapeHtml(AGE_RESTRICTION_NOTICE)}</p>
<p>当サイトは、各店舗が風営法上のどの営業区分で営業しているかを確認しているものではありません。スナック・キャバクラ・ラウンジ・クラブ・ガールズバーの各業態ページおよび店舗ページには、同じ注意喚起を表示しています。</p>
`;
  return layout({
    title: "このサイトについて",
    description: "久留米飲み屋ナビの運営者情報、掲載方針、情報源、掲載店舗の関係者の方向けのご案内。",
    pathname: "/about/",
    bodyHtml: body,
    footerNote: ABOUT_FOOTER_NOTE,
  });
}

function writeFile(relPath, content) {
  const fullPath = path.join(DIST_DIR, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

function build() {
  const allVenues = readJSON("venues.json");
  const areas = readJSON("areas.json");
  const allCategories = readJSON("categories.json");

  // 公開対象に絞り込む。非公開の判定は2種類あり、いずれも data/venues.json にはデータとして残すが
  // dist/ 配下にページを一切生成しない(リンクを隠すだけでなく、ファイル自体を作らない):
  //   (a) PUBLISHED_CATEGORIES 外のカテゴリ
  //   (b) 店舗単位の非公開指定 … PHASE2_VENUE_IDS
  // 2026-07-30 時点では (a)(b) いずれも該当0件(全カテゴリ・全店を公開)。仕組みは残してある。
  const venues = allVenues.filter(
    (v) => PUBLISHED_CATEGORIES.includes(v.category) && !PHASE2_VENUE_IDS.has(v.id)
  );
  const categories = allCategories.filter((c) => PUBLISHED_CATEGORIES.includes(c.id));
  const hiddenCount = allVenues.length - venues.length;

  // PHASE2_VENUE_IDS のタイポ・ID変更で「非公開にしたつもりが公開されている」事故を防ぐ整合性チェック。
  const allIds = new Set(allVenues.map((v) => v.id));
  const missingPhase2 = [...PHASE2_VENUE_IDS].filter((id) => !allIds.has(id));
  if (missingPhase2.length > 0) {
    console.warn(`[warn] PHASE2_VENUE_IDS にデータ上存在しないIDがあります: ${missingPhase2.join(", ")}`);
  }
  const missingUnverified = [...UNVERIFIED_VENUE_IDS].filter((id) => !allIds.has(id));
  if (missingUnverified.length > 0) {
    console.warn(`[warn] UNVERIFIED_VENUE_IDS にデータ上存在しないIDがあります: ${missingUnverified.join(", ")}`);
  }

  // 求人媒体等のURLが公開店の sources に紛れ込んでいないかのチェック。
  // README「削除・非掲載化の記録を残す」のルール: 求人サイト由来の情報は業態の分類の
  // 手がかりとして参照してよいが、店舗ページには出さない(= sources に載せない)。
  // 対象は求人媒体だけではない。出会い系マッチングアプリのオウンドメディア(happymail)や
  // ナイトワーク系ポータル(yoasobi-net)も、実店舗ページに「出典」として並べるとブランドを損ない、
  // 掲載店にとっても迷惑になるため公開してはいけない。
  // 2026-07-30: 接待を伴う業態を公開するにあたり、該当した83店のURLを sources から
  // data/venues.json の internalSources(ビルドで一切出力しない内部管理用のフィールド)へ退避した。
  const NON_PUBLISHABLE_SOURCE_RE = /(job-chocolat|menschocolat|picsastock|tainew|emily-job|pokepara-tainew|baitoru|indeed|gb-walker|hotworks|happymail|yoasobi-net)\./i;
  const nonPublishableLeaks = venues.filter((v) => (v.sources || []).some((s) => NON_PUBLISHABLE_SOURCE_RE.test(s.url)));
  if (nonPublishableLeaks.length > 0) {
    // warn ではなくビルドを止める。deploy.yml はビルド直後に無条件でデプロイするため、
    // 警告のままでは「ログを読み飛ばして公開してしまう」事故を防げない。
    throw new Error(
      `公開店の sources に、公開してはいけない媒体のURLがあります(公開前に外すこと): ${nonPublishableLeaks.map((v) => v.id).join(", ")}`
    );
  }
  // 上記の退避の結果、表示できる出典が1件も無くなった店。店舗ページ側では空の出典リストを出さず
  // 理由を明記する実装になっているが、件数は運用上の課題として毎回ログに出す
  // (別系統の出典を取得できたら sources に追加してこの件数を減らす)。
  const noShownSource = venues.filter((v) => (v.sources || []).length === 0);
  if (noShownSource.length > 0) {
    console.log(
      `[info] 表示できる出典が0件の公開店舗: ${noShownSource.length}件(店舗ページには理由を明記。別系統の出典が取得でき次第 sources に追加する): ${noShownSource
        .map((v) => v.id)
        .join(", ")}`
    );
  }

  const hiddenCategories = allCategories.filter((c) => !PUBLISHED_CATEGORIES.includes(c.id));
  // Google の営業状況(businessStatus)が「営業中でない」店を必ず目に入るようにする。
  // 自動で非掲載にはしない — place_id の誤マッチで別店の状態を拾っている可能性があるため、
  // 人が公式情報を確認してから掲載継続/削除を判断する。
  // 過去に閉店店舗を2度掲載した(poker-aa-aces=約4年前に閉店 / izakaya-sakuraya=改名により消滅)
  // 反省から、人力の確認に頼らず機械的に兆候を拾うための仕組み。
  const closedByGoogle = venues
    .map((v) => [v, VENUE_RATINGS[v.id]])
    .filter(([, r]) => r && r.businessStatus && r.businessStatus !== "OPERATIONAL");
  if (closedByGoogle.length > 0) {
    console.warn(
      `[warn] Google が営業中でないと返している掲載店が ${closedByGoogle.length}件あります(要確認。自動では非掲載にしません): ` +
        closedByGoogle.map(([v, r]) => `${v.id}(${r.businessStatus})`).join(", ")
    );
  }

  const phase2Published = [...PHASE2_VENUE_IDS].filter((id) => PUBLISHED_CATEGORIES.includes((allVenues.find((v) => v.id === id) || {}).category));
  console.log(
    `公開対象: ${venues.length}件 / 全データ: ${allVenues.length}件(非公開: ${hiddenCount}件 = ` +
      `非公開カテゴリ${hiddenCategories.length > 0 ? hiddenCategories.map((c) => c.name).join("・") : "なし"} + 店舗単位の非公開指定${phase2Published.length}件)`
  );

  // ロゴ登録の整合性チェック。
  // - broken: データ上に存在しないID(削除・ID変更で参照先が消えた)→ 要修正なので warn。
  // - hidden: データは在るが非公開(フェーズ2等)でページが生成されない→ 想定内なので info。
  const publishedIds = new Set(venues.map((v) => v.id));
  const brokenLogoIds = Object.keys(VENUE_LOGOS).filter((id) => !allIds.has(id));
  const hiddenLogoIds = Object.keys(VENUE_LOGOS).filter((id) => allIds.has(id) && !publishedIds.has(id));
  if (brokenLogoIds.length > 0) {
    console.warn(`[warn] VENUE_LOGOS にデータ上存在しないIDがあります: ${brokenLogoIds.join(", ")}`);
  }
  if (hiddenLogoIds.length > 0) {
    console.log(`[info] VENUE_LOGOS のうち非公開店舗の${hiddenLogoIds.length}件はロゴを表示しません: ${hiddenLogoIds.join(", ")}`);
  }
  // 公開店ごとに resolveVenueLogo で実際に出るロゴ種別を数える(表示と一致する単一の真実の源)。
  const logoCounts = { official: 0, "instagram-local": 0, hotpepper: 0 };
  for (const v of venues) {
    const logo = resolveVenueLogo(v);
    if (logo && logoCounts[logo.source] !== undefined) logoCounts[logo.source]++;
  }
  console.log(
    `ロゴ表示: 公式サイト ${logoCounts.official}件 + 公式Instagram(自サイト保存) ${logoCounts["instagram-local"]}件 + ホットペッパー ${logoCounts.hotpepper}件 = ${logoCounts.official + logoCounts["instagram-local"] + logoCounts.hotpepper}件`
  );
  // ロゴ画像が無い店(=看板ネームプレート=ネームタイルを出す店)の件数。
  const nameTileCount = venues.length - logoCounts.official - logoCounts["instagram-local"] - logoCounts.hotpepper;
  console.log(`ネームタイル(ロゴ画像なし・看板ネームプレート)表示: ${nameTileCount}件`);

  // Instagram投稿埋め込みの整合性チェック(VENUE_LOGOS と同じ考え方)。
  // - broken: データ上に存在しないID(店舗削除・ID変更で参照先が消えた孤立ID)→ 削除漏れなので warn。
  // - hidden: データは在るが非公開でページが生成されない→ 想定内なので info。
  const brokenEmbedIds = Object.keys(INSTAGRAM_POST_EMBEDS).filter((id) => !allIds.has(id));
  const hiddenEmbedIds = Object.keys(INSTAGRAM_POST_EMBEDS).filter((id) => allIds.has(id) && !publishedIds.has(id));
  if (brokenEmbedIds.length > 0) {
    console.warn(`[warn] INSTAGRAM_POST_EMBEDS にデータ上存在しないIDがあります: ${brokenEmbedIds.join(", ")}`);
  }
  if (hiddenEmbedIds.length > 0) {
    console.log(`[info] INSTAGRAM_POST_EMBEDS のうち非公開店舗の${hiddenEmbedIds.length}件は埋め込みを表示しません: ${hiddenEmbedIds.join(", ")}`);
  }

  // 公式SNS・ホームページのリンクを表示できた店舗数(公開対象のみ)。
  const officialLinkCount = venues.filter((v) => officialLinksFor(v).length > 0).length;
  console.log(`公式SNS・ホームページ表示: ${officialLinkCount}件`);

  // 絞り込み用の機械可読データの生成状況(パースできなかった文字列は目視で確認できるよう出力する)
  const withHours = venues.filter((v) => v.hours);
  const unparsedHours = withHours.filter((v) => !parseSchedule(v.hours, v.closedDays).parsed);
  console.log(
    `絞り込みデータ: 営業時間 ${withHours.length - unparsedHours.length}/${withHours.length}件をパース / ` +
      `予算 ${venues.filter((v) => budgetBucketsFor(v).length).length}件 / ` +
      `支払い ${venues.filter((v) => paymentTokens(v.payment).length).length}件 / ` +
      `喫煙 ${venues.filter((v) => smokingToken(v.smoking)).length}件 / ` +
      `お通し・チャージなし ${venues.filter((v) => isChargeFree(v.charge)).length}件`
  );
  if (unparsedHours.length > 0) {
    console.log(`[info] 営業時間をパースできず「営業中」絞り込みの対象外になった店舗: ${unparsedHours.map((v) => `${v.id}(${v.hours})`).join(", ")}`);
  }

  // クリーンビルド
  fs.rmSync(DIST_DIR, { recursive: true, force: true });

  // エリアガイド記事(社長指示 2026-08-22(2))。content/guides/*.md を読み込む。
  // トップページ・エリアページ・店舗ページいずれの相互リンクにも使うため、他の生成処理より前に読み込む。
  const guides = loadGuides();
  const hubGuide = guides.find((g) => !g.areaId);

  const urls = [];

  // トップページ
  writeFile("index.html", renderTop(venues, areas, categories, guides));
  urls.push("/");

  // about
  writeFile("about/index.html", renderAboutPage());
  urls.push("/about/");

  // 絞り込み検索(エリア・業態・タグを組み合わせ)
  writeFile("search/index.html", renderSearchPage(venues, areas, categories));
  urls.push("/search/");

  // エリアガイド記事のページを生成
  if (hubGuide) {
    writeFile("guides/index.html", renderGuideIndexPage(hubGuide, guides));
    urls.push("/guides/");
  }
  for (const g of guides.filter((x) => x.areaId)) {
    const area = areas.find((a) => a.id === g.areaId);
    writeFile(`guides/${g.slug}/index.html`, renderGuidePage(g, area));
    urls.push(`/guides/${g.slug}/`);
  }
  console.log(`エリアガイド: ${guides.length}件を /guides/ 配下に生成`);

  // エリア一覧・個別(店舗数・一覧は公開対象のみでカウント)
  writeFile("areas/index.html", renderAreaIndex(areas, venues, guides));
  urls.push("/areas/");
  for (const area of areas) {
    writeFile(`areas/${area.id}/index.html`, renderAreaPage(area, venues, categories, areas, guides));
    urls.push(`/areas/${area.id}/`);
  }

  // 業態一覧・個別(非公開カテゴリはそもそも一覧に含めず、ページも生成しない)
  writeFile("categories/index.html", renderCategoryIndex(categories, venues));
  urls.push("/categories/");
  for (const category of categories) {
    writeFile(`categories/${category.id}/index.html`, renderCategoryPage(category, venues, areas, categories));
    urls.push(`/categories/${category.id}/`);
  }

  // 店舗個別ページ(公開対象のみ生成。非公開店舗のHTMLファイルはdist/に一切作らない)
  for (const v of venues) {
    const area = areas.find((a) => a.id === v.area);
    const category = categories.find((c) => c.id === v.category);
    if (!area || !category) {
      console.warn(`[skip] ${v.id}: area or category not found`);
      continue;
    }
    writeFile(`venues/${v.id}/index.html`, renderVenuePage(v, area, category, venues, areas, categories, guides));
    urls.push(`/venues/${v.id}/`);
  }

  // タグ一覧・個別(ダーツ・カラオケ・もつ鍋等、設備/料理ジャンルからの絞り込み用ページ。
  // 公開対象の店舗が持つタグのみを対象にする)
  const tagCounts = collectTagCounts(venues);
  const slugSeen = new Map();
  for (const [tag] of tagCounts) {
    const slug = tagSlug(tag);
    if (slugSeen.has(slug)) {
      console.warn(`[warn] tag slug collision: "${tag}" と "${slugSeen.get(slug)}" が同じURL(${slug})になります`);
    }
    slugSeen.set(slug, tag);
  }
  if (tagCounts.length > 0) {
    writeFile("tags/index.html", renderTagIndex(tagCounts));
    urls.push("/tags/");
    for (const [tag] of tagCounts) {
      writeFile(`tags/${tagSlug(tag)}/index.html`, renderTagPage(tag, venues, areas, categories));
      urls.push(`/tags/${tagSlug(tag)}/`);
    }
  }

  // sitemap.xml
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${absoluteUrl(u)}</loc><lastmod>${BUILD_DATE}</lastmod></url>`).join("\n")}
</urlset>
`;
  writeFile("sitemap.xml", sitemap);

  // robots.txt
  writeFile(
    "robots.txt",
    `User-agent: *
Allow: /
Sitemap: ${absoluteUrl("/sitemap.xml")}
`
  );

  // .nojekyll (GitHub PagesがJekyll処理をスキップするために必要)
  writeFile(".nojekyll", "");

  // アセットのコピー
  const styleSrc = path.join(ASSETS_DIR, "style.css");
  if (fs.existsSync(styleSrc)) {
    writeFile("assets/style.css", fs.readFileSync(styleSrc, "utf-8"));
  }

  // Instagramロゴ(自サイト保存分・再ホスト)をコピー: assets/insta-logos/*.jpg → dist/assets/insta-logos/
  // writeFile は utf-8 前提でバイナリを壊すため、画像はバイナリのまま Buffer でコピーする。
  const instaLogosSrc = path.join(ASSETS_DIR, "insta-logos");
  if (fs.existsSync(instaLogosSrc)) {
    let copied = 0;
    for (const f of fs.readdirSync(instaLogosSrc)) {
      if (!/\.(jpe?g|png|webp)$/i.test(f)) continue;
      const dest = path.join(DIST_DIR, "assets", "insta-logos", f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, fs.readFileSync(path.join(instaLogosSrc, f)));
      copied++;
    }
    console.log(`[info] Instagramロゴ画像を ${copied} 件 dist/assets/insta-logos/ にコピーしました`);
  }

  console.log(`Built ${urls.length} pages into ${DIST_DIR}`);
}

build();
