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

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DIST_DIR = path.join(ROOT, "dist");
const ASSETS_DIR = path.join(ROOT, "assets");

const SITE_NAME = "久留米飲み屋ナビ";
const SITE_URL = "https://nattuuuzamiurai.github.io/kurume-bar-navi";
const BASE_PATH = "/kurume-bar-navi";

// 連絡先(掲載内容の追加・修正・削除依頼の受付先)。
// TODO: 実運用開始前に、実際に受信・監視できる会社のメールアドレスへ差し替えること。
// 現時点ではプレースホルダーのため、本番公開前に必ず確認する。
const CONTACT_EMAIL = "kurume-bar-navi-info@example.com";

// 今回のフェーズで一般公開する業態(カテゴリID)のallowlist。
// スナック・キャバクラ(snack/kyabakura)は data/venues.json にはデータとして残すが、
// 社長判断によりフェーズ1では非公開とする(ページ自体を生成しない)。
// フェーズ2で公開解禁する場合はここに追加すればよい。
const PUBLISHED_CATEGORIES = ["bar", "izakaya", "concafe", "shisha", "poker"];

// カテゴリは公開対象だが、店舗単位でフェーズ2(非公開)にするID。
// 【フェーズ1/2の境界は「カテゴリ名」ではなく「実態(接待性)」で判定する】(レビュー部方針)。
// キャストが客席に付いて接客する/キャストドリンク・指名料・シングルチャージ等の接待型課金がある店は、
// 表向きのカテゴリが居酒屋・コンカフェであってもフェーズ2とする。
// スナック・キャバクラ23店とまったく同じ扱い(dist/・sitemap・検索・タグ・一覧・JSON-LDのどこにも
// 出さず、店名・IDも漏らさない)。データ自体は将来の判断のため残す。
const PHASE2_VENUE_IDS = new Set([
  // 実態がガールズバー業態。シングルチャージ+キャストドリンクの接待型課金(「居酒屋(中華)」表示は誤認を招く)。
  // ※付与されていた「中華」タグは、六ツ門町の別店舗 izakaya-nyanyan-chinese(本物の中華料理店)から
  //   混入した疑いがある。非公開化するため実害はないが、データ上のメモとしてここに残す。
  "izakaya-nyanko-sakaba",
  // 公式が「ガールズバー」表記。社長判断で暫定フェーズ2。
  "concafe-platinum-seven",
  // 店名自体が「ガールズバー&コンセプトカフェ」。社長判断で暫定フェーズ2。
  "concafe-axia",
]);

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
  "poker-ace-and-king",
  "shisha-0942",
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
const CATEGORY_COLORS = {
  bar: "#e8a33d",
  izakaya: "#e2574c",
  concafe: "#e07bb0",
  shisha: "#59c3a6",
  poker: "#7c6ce8",
  snack: "#c9a227",
  kyabakura: "#c9427a",
};

const CATEGORY_ICONS = {
  // カクテルグラス
  bar: `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 10h32l-14 16v14h8m-16 0h16m-8-14L8 10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="30" cy="14" r="1.8" fill="currentColor"/></svg>`,
  // 提灯(ちょうちん)
  izakaya: `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 4v6M24 38v6M14 10h20a4 4 0 014 4v14a10 10 0 01-10 10h-8A10 10 0 0110 28V14a4 4 0 014-4z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/><path d="M12 18h24M12 24h24M12 30h24" stroke="currentColor" stroke-width="1.5" opacity="0.6"/></svg>`,
  // カップ+湯気
  concafe: `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M10 18h22v10a10 10 0 01-10 10h-2a10 10 0 01-10-10V18z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/><path d="M32 20h4a5 5 0 010 10h-4" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M17 12c0-2 2-2 2-4M24 12c0-2 2-2 2-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  // シーシャ(水タバコ)
  shisha: `<svg viewBox="0 0 48 48" aria-hidden="true"><ellipse cx="24" cy="34" rx="10" ry="6" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M24 28V16m0 0c4 0 6-3 4-7-2 2-4 2-4-1" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M14 30c-4 2-6 6-4 10M34 30c4 2 6 6 4 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.7"/></svg>`,
  // スペード(カード/ポーカー)
  poker: `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 6c6 8 16 14 16 22a8 8 0 01-14 5c1 5 2 7 5 9H17c3-2 4-4 5-9a8 8 0 01-14-5c0-8 10-14 16-22z" fill="currentColor"/></svg>`,
  // スナック・キャバクラ(非公開カテゴリだが将来のフェーズ2用に用意)
  snack: `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="15" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M18 20c1-3 3-4 6-4s5 1 6 4M17 28h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>`,
  kyabakura: `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M12 34l4-16 8-6 8 6 4 16z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/><circle cx="24" cy="12" r="4" fill="currentColor"/></svg>`,
};

function categoryIconHtml(categoryId) {
  const icon = CATEGORY_ICONS[categoryId];
  if (!icon) return "";
  const color = CATEGORY_COLORS[categoryId] || "#e8a33d";
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
const INSTAGRAM_POST_EMBEDS = {
  "poker-ken": "https://www.instagram.com/p/DHUYDOMTOvi/",
  "poker-aa-aces": "https://www.instagram.com/p/CbkPsDWpeei/",
  "poker-ace-and-king": "https://www.instagram.com/p/DMzHAQgzjCE/",
  "shisha-aima": "https://www.instagram.com/p/DIYIdGqBCkm/",
  // 2026-07-19 追加。ロヂウラ酒八利の公式アカウント @rodiurasyuhari 自身が投稿した
  // パーマリンク。検索結果の投稿者表記(「33 likes, 0 comments - rodiurasyuhari on
  // May 8, 2025:」というInstagramの投稿者帰属フォーマット)で、投稿者が公式アカウント
  // @rodiurasyuhari 本人であることを確認済み(店舗紹介スニペットでも
  // 「ロヂウラ酒八利 豆津橋渡 (@rodiurasyuhari) 久留米の立ち飲み酒場」と一致確認)。
  "bar-rojiura-sakahari": "https://www.instagram.com/p/DJZZcLayobg/",
};

const INSTAGRAM_EMBED_SCRIPT = `<script async src="//www.instagram.com/embed.js"></script>`;

function instagramEmbedHtml(venueId) {
  const postUrl = INSTAGRAM_POST_EMBEDS[venueId];
  if (!postUrl) return "";
  return `<div class="instagram-embed-wrap">
  <blockquote class="instagram-media" data-instgrm-permalink="${escapeHtml(postUrl)}" data-instgrm-version="14"></blockquote>
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
const OFFICIAL_PHOTOS = {
  "bar-remember": {
    imageUrl: "https://static.wixstatic.com/media/d671d7_b6cf8175b8d54a8a886dbc8580952a06~mv2.png/v1/fit/w_2500,h_1330,al_c/d671d7_b6cf8175b8d54a8a886dbc8580952a06~mv2.png",
    sourceLabel: "Remember 公式サイト",
    sourceUrl: "https://www.kurume-remember.com/",
  },
  "bar-oshu-kitchen-alma": {
    imageUrl: "https://oshukitchen-alma.com/img/ogp.png",
    sourceLabel: "欧州キッチンアルマ 公式サイト",
    sourceUrl: "https://oshukitchen-alma.com/",
  },
  "izakaya-sumibi-sakagura-kita": {
    imageUrl: "https://www.sumibishuzo-kita.com/shared/img/shared/ogp.png",
    sourceLabel: "炭火酒蔵 喜多 公式サイト",
    sourceUrl: "https://www.sumibishuzo-kita.com/",
  },
  // 【2026-07-21 レビュー部の条件付きGOにより除外】bar-lampsquare は画像が cdn.r-corona.jp
  // (Recruit系CDN)上にあり、公式サイト自体が Recruit の店舗ページ作成サービス owst.jp
  // (RestaurantBOARD)製。Recruit は今回禁止対象にしたホットペッパーグルメの親会社であり、
  // 「クリーンな公式ソース限定」の線引きを濁すため対象外とした(写真なし=ビジュアルヒーローのまま)。
  "izakaya-kiseki-tebasaki": {
    imageUrl: "https://kiseteba.com/img/ogp.png",
    sourceLabel: "奇跡の手羽先 公式サイト",
    sourceUrl: "https://kiseteba.com/",
  },
};

function officialPhotoHtml(venueId) {
  const p = OFFICIAL_PHOTOS[venueId];
  if (!p) return "";
  return `<figure class="official-photo">
    <img src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.sourceLabel)}の写真" loading="lazy" referrerpolicy="no-referrer-when-downgrade">
    <figcaption class="small">提供: <a href="${escapeHtml(p.sourceUrl)}" rel="nofollow noopener" target="_blank">${escapeHtml(p.sourceLabel)}</a>(画像は公式サイトのものを直接参照して表示しています。当サイトに保存はしていません)</figcaption>
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
  "concafe-axia": {
    imageUrl: "https://anisongaxia.com/common/upload_data/anisongaxiacom/image/apple-touch-icon.png",
    siteLabel: "コンセプトカフェ AXIA 公式サイト",
    siteUrl: "https://anisongaxia.com/",
  },
  "concafe-platinum-seven": {
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

// 業態アイコンの枠(カード/ヒーロー)を描画する。ロゴが登録されている店舗はロゴ画像に差し替え、
// 読み込み失敗時は onerror で業態アイコンにフォールバックする。
// variant: "card" | "hero"
function venueIconSlotHtml(v, variant) {
  const cls = variant === "hero" ? "venue-hero-icon" : "venue-card-icon";
  const icon = rawCategoryIcon(v.category);
  const logo = VENUE_LOGOS[v.id];
  if (!logo) return `<span class="${cls}">${icon}</span>`;
  const bgClass = logo.bg === "dark" ? " has-logo-dark" : "";
  // onerror: ロゴ枠の装飾を外し、隠してある業態アイコンを表示する(画像が消えたまま空白になるのを防ぐ)。
  // 店舗ページでは、ロゴが出せなかったのに出典表記だけ残るのを防ぐため出典行も隠す。
  const onerror =
    "this.style.display='none';this.parentNode.classList.remove('has-logo','has-logo-dark');" +
    "var f=this.nextElementSibling;if(f){f.hidden=false;}" +
    (variant === "hero"
      ? "var c=document.getElementById('venue-logo-credit');if(c){c.hidden=true;}"
      : "");
  return `<span class="${cls} has-logo${bgClass}"><img class="venue-logo-img" src="${escapeHtml(logo.imageUrl)}" alt="${escapeHtml(v.name)}のロゴ" loading="lazy" decoding="async" referrerpolicy="no-referrer-when-downgrade" onerror="${onerror}"><span class="venue-logo-fallback" hidden>${icon}</span></span>`;
}

// 店舗ページに出す、ロゴの出典表記と削除依頼の案内(一覧カードには出さない)。
function venueLogoCreditHtml(v) {
  const logo = VENUE_LOGOS[v.id];
  if (!logo) return "";
  const subject = encodeURIComponent(`【${v.name}】ロゴ掲載について`);
  return `<p class="small logo-credit" id="venue-logo-credit">ロゴ画像: <a href="${escapeHtml(logo.siteUrl)}" rel="nofollow noopener" target="_blank">${escapeHtml(logo.siteLabel)}</a>のものを直接参照して表示しています(当サイトには保存していません)。掲載を希望されない店舗様は<a href="mailto:${CONTACT_EMAIL}?subject=${subject}">${escapeHtml(CONTACT_EMAIL)}</a>までご連絡ください。速やかに対応いたします。</p>`;
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

// キーレス地図埋め込みURL(APIキー不要、消費者向け output=embed 形式)。住所テキストから生成。
function mapOutputEmbedUrl(address) {
  const a = stripAddressNotes(address);
  return `https://maps.google.com/maps?q=${encodeURIComponent(a)}&output=embed`;
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
    ? `<div class="map-embed-wrap">
      <iframe src="${escapeHtml(mapOutputEmbedUrl(v.address))}" title="${escapeHtml(v.name)}の地図(Googleマップ)" loading="lazy" style="border:0;" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe>
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
function facetGroupHtml(facetKey, title, counts, idToLabel, collapsedIfLarge) {
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
    return `<details class="facet-group">
  <summary>${escapeHtml(title)}で絞り込む(${entries.length})</summary>
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
  if (tagCounts.size > 0) groups.push(facetGroupHtml("tags", "タグ", tagCounts, null, true));

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

const DISCLAIMER = `本サイトは福岡県久留米市・西鉄久留米駅周辺エリア(一番街・二番街・文化街周辺)の飲食店・ナイトライフ店舗を紹介する情報サイトです。掲載情報は店舗公式サイト・SNS、飲食店情報サイト、業界団体(組合)の公表情報など公開されている情報をもとに${BUILD_DATE}時点で作成した要約であり、内容の正確性・最新性を保証するものではありません。ご来店の際は、営業時間・定休日・料金等を各店舗の最新の公式情報でご確認ください。性風俗関連特殊営業に該当する業態は掲載対象外です。20歳未満の方は、酒類提供業態・接待を伴う飲食店をご利用いただけません。店舗の写真・ロゴは、店舗ご自身の公式発信(公式サイト・公式Instagram)を出典とするもののみを、提供元のサーバー上の画像を直接参照する形で表示しています(当サイトには保存していません)。それ以外の店舗の写真は各出典サイトでご覧いただけます(Instagram埋め込みや外部画像の参照の際は、お使いのブラウザが各社のサーバーと通信します)。本サイトに掲載している店舗名・ロゴ・商標は、各権利者に帰属します。当サイトは店舗を紹介する情報サイトであり、掲載店舗との間に提携・協賛・推奨・公認等の関係はありません。`;

function layout({ title, description, pathname, bodyHtml, jsonLd, robotsNoindex, extraScript }) {
  const fullTitle = title ? `${title} | ${SITE_NAME}` : SITE_NAME;
  const canonical = absoluteUrl(pathname);
  const jsonLdScript = jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>`
    : "";
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(fullTitle)}</title>
<meta name="description" content="${escapeHtml(description)}">
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
  <a class="site-title" href="${url("/")}">${escapeHtml(SITE_NAME)}</a>
  <p class="site-tagline">西鉄久留米駅周辺(一番街・二番街・文化街)の飲み屋まとめ</p>
  <nav class="site-nav">
    <a href="${url("/search/")}">絞り込み検索</a>
    <a href="${url("/areas/")}">エリア</a>
    <a href="${url("/categories/")}">業態</a>
    <a href="${url("/tags/")}">タグ</a>
  </nav>
</header>
<main>
${bodyHtml}
</main>
<footer class="site-footer">
  <p>${escapeHtml(DISCLAIMER)}</p>
  <p><a href="${url("/about/")}">このサイトについて・掲載店舗の関係者の方へ</a></p>
  <p>&copy; ${SITE_NAME}</p>
</footer>
${extraScript || ""}
</body>
</html>
`;
}

// 業態アイコンのSVGだけを返す(カード見出し・ヒーロー用。ラッパーdivなし)。
function rawCategoryIcon(categoryId) {
  return CATEGORY_ICONS[categoryId] || "";
}

function venueCardHtml(v, categories, areas) {
  const cat = categories.find((c) => c.id === v.category);
  const area = areas.find((a) => a.id === v.area);
  const color = CATEGORY_COLORS[v.category] || "#e8a33d";
  const tags = v.tags || [];
  const tagsAttr = escapeHtml(tags.join("|"));
  const tagsHtml = tags.length
    ? `<span class="venue-card-tags">${tags
        .slice(0, 3)
        .map((t) => `<span class="tag tag-small">${escapeHtml(t)}</span>`)
        .join(" ")}${tags.length > 3 ? `<span class="tag tag-small tag-more">+${tags.length - 3}</span>` : ""}</span>`
    : "";
  return `<li class="venue-card" data-area="${escapeHtml(v.area)}" data-category="${escapeHtml(v.category)}" data-tags="${tagsAttr}"${venueFacetAttrs(v)} style="--cat-color:${color}">
  <a href="${url(`/venues/${v.id}/`)}">
    <span class="venue-card-head">
      ${venueIconSlotHtml(v, "card")}
      <span class="venue-card-cat">${escapeHtml(categoryLabel(v, cat ? cat.name : v.category))}</span>
    </span>
    <span class="venue-card-body">
      <span class="venue-name">${escapeHtml(v.name)}</span>
      <span class="venue-meta">${escapeHtml(area ? area.name : v.area)}${v.walk ? " ・ " + escapeHtml(v.walk) : ""}</span>
      ${tagsHtml}
    </span>
  </a>
</li>`;
}

function renderTop(venues, areas, categories) {
  const areaLinks = areas
    .map(
      (a) =>
        `<li><a href="${url(`/areas/${a.id}/`)}">${escapeHtml(a.name)}<span class="count">(${venues.filter((v) => v.area === a.id).length}件)</span></a></li>`
    )
    .join("\n");
  const categoryLinks = categories
    .map(
      (c) =>
        `<li><a class="category-link" href="${url(`/categories/${c.id}/`)}" style="--cat-color:${CATEGORY_COLORS[c.id] || "#e8a33d"}">${categoryIconHtml(c.id)}<span>${escapeHtml(c.name)}<span class="count">(${venues.filter((v) => v.category === c.id).length}件)</span></span></a></li>`
    )
    .join("\n");
  const newest = venues.slice(0, 12).map((v) => venueCardHtml(v, categories, areas)).join("\n");

  // 「今すぐ探す」のショートカット。リンク先の /search/ はURLクエリを読んで初期条件を適用する。
  const countBy = (fn) => venues.filter(fn).length;
  const quickPick = (href, label, count, primary) =>
    `<a class="quick-pick${primary ? " quick-pick-primary" : ""}" href="${href}">${label}${count !== null ? `<span class="count">(${count})</span>` : ""}</a>`;
  const budgetChips = BUDGET_BUCKETS.map((b) =>
    quickPick(url(`/search/?budget=${b.value}`), escapeHtml(b.label), countBy((v) => budgetBucketsFor(v).includes(b.value)), false)
  ).join("\n");
  const conditionChips = [
    quickPick(url("/search/?charge=free"), "お通し・チャージなし", countBy((v) => isChargeFree(v.charge)), false),
    quickPick(url("/search/?pay=card"), "カード可", countBy((v) => paymentTokens(v.payment).includes("card")), false),
    quickPick(url("/search/?smoke=no"), "禁煙", countBy((v) => smokingToken(v.smoking) === "no"), false),
    quickPick(url("/search/?smoke=yes"), "喫煙可", countBy((v) => smokingToken(v.smoking) === "yes"), false),
    quickPick(url(`/search/?tags=${encodeURIComponent("個室あり")}`), "個室あり", countBy((v) => (v.tags || []).includes("個室あり")), false),
    quickPick(url(`/search/?tags=${encodeURIComponent("一人客歓迎")}`), "一人客歓迎", countBy((v) => (v.tags || []).includes("一人客歓迎")), false),
  ].join("\n");
  const openCount = countBy((v) => parseSchedule(v.hours, v.closedDays).parsed);

  const body = `
<section class="hero">
  <h1>久留米の飲み屋を「条件」で探す</h1>
  <p>福岡県久留米市・西鉄久留米駅周辺(一番街・二番街・文化街)のバー・居酒屋・コンカフェ・シーシャ・アミューズメントポーカーバー <strong>${venues.length}件</strong> を掲載。<strong>いま営業中か・予算・カードが使えるか・禁煙か・お通しの有無</strong>まで組み合わせて絞り込めます。</p>
  <a class="cta-button" href="${url("/search/?open=now")}">🕒 いま営業中の店を探す →</a>
  <p class="small">営業時間を確認できた${openCount}件が対象です(ご利用の端末の時刻で判定します)。</p>
</section>

<section class="quick-section">
  <h2>予算から探す</h2>
  <div class="quick-picks">
${budgetChips}
  </div>
</section>

<section class="quick-section">
  <h2>こだわり条件から探す</h2>
  <div class="quick-picks">
${conditionChips}
  </div>
  <p><a class="cta-button cta-button-sub" href="${url("/search/")}">エリア・業態・予算・条件を組み合わせて探す →</a></p>
</section>

<section>
  <h2>業態から探す</h2>
  <ul class="category-grid">
${categoryLinks}
  </ul>
</section>

<section>
  <h2>エリアから探す</h2>
  <ul class="link-list">
${areaLinks}
  </ul>
</section>

<section>
  <h2>タグから探す</h2>
  <p>ダーツ・カラオケ・個室あり・もつ鍋など、遊べる要素や料理ジャンルから絞り込めます。</p>
  <p><a href="${url("/tags/")}">タグ一覧を見る →</a></p>
</section>

<section>
  <h2>掲載店舗</h2>
  <ul class="venue-list">
${newest}
  </ul>
  <p><a href="${url("/categories/")}">すべての業態を見る →</a></p>
</section>
`;
  return layout({
    title: null,
    description:
      "福岡県久留米市・西鉄久留米駅周辺(一番街・二番街・文化街)の飲み屋を、いま営業中か・予算・カード可否・禁煙・お通しの有無まで組み合わせて探せる情報サイト。バー・居酒屋・コンカフェ・シーシャ・アミューズメントポーカーバーを掲載。",
    pathname: "/",
    bodyHtml: body,
  });
}

function renderAreaIndex(areas, venues) {
  const items = areas
    .map(
      (a) => `<li><a href="${url(`/areas/${a.id}/`)}"><strong>${escapeHtml(a.name)}</strong>(${venues.filter((v) => v.area === a.id).length}件)</a><p>${escapeHtml(a.summary)}</p></li>`
    )
    .join("\n");
  const body = `
<h1>エリア一覧</h1>
<ul class="link-list-detailed">
${items}
</ul>
<p><a href="${url("/search/")}">エリア・業態・タグを組み合わせて絞り込む →</a></p>
`;
  return layout({
    title: "エリア一覧",
    description: "久留米飲み屋ナビが掲載する一番街・二番街・文化街・西鉄久留米駅周辺エリアの一覧。",
    pathname: "/areas/",
    bodyHtml: body,
  });
}

function renderCategoryIndex(categories, venues) {
  const items = categories
    .map(
      (c) => `<li><a class="category-link" href="${url(`/categories/${c.id}/`)}" style="--cat-color:${CATEGORY_COLORS[c.id] || "#e8a33d"}">${categoryIconHtml(c.id)}<span><strong>${escapeHtml(c.name)}</strong>(${venues.filter((v) => v.category === c.id).length}件)<br>${escapeHtml(c.summary)}</span></a></li>`
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
    description: "久留米飲み屋ナビが掲載するバー・居酒屋・コンカフェ・シーシャ・アミューズメントポーカーバーの一覧。",
    pathname: "/categories/",
    bodyHtml: body,
  });
}

function renderAreaPage(area, venues, categories, areas) {
  const areaVenues = venues.filter((v) => v.area === area.id);
  const list = areaVenues.map((v) => venueCardHtml(v, categories, areas)).join("\n");
  const listId = "venue-list-area";
  const body = `
<nav class="breadcrumb"><a href="${url("/")}">TOP</a> &gt; <a href="${url("/areas/")}">エリア</a> &gt; ${escapeHtml(area.name)}</nav>
<h1>${escapeHtml(area.name)}の飲み屋一覧</h1>
<p>${escapeHtml(area.summary)}</p>
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

function renderVenuePage(v, area, category, allVenues, areas, categories) {
  const sourcesHtml = v.sources
    .map((s) => `<li><a href="${escapeHtml(s.url)}" rel="nofollow noopener" target="_blank">${escapeHtml(s.label)}</a></li>`)
    .join("\n");
  const tagsHtml = (v.tags || [])
    .map((t) => `<a class="tag" href="${url(`/tags/${tagSlug(t)}/`)}">${escapeHtml(t)}</a>`)
    .join(" ");

  const relatedInArea = allVenues
    .filter((x) => x.area === v.area && x.id !== v.id)
    .slice(0, 6)
    .map((x) => venueCardHtml(x, categories, areas))
    .join("\n");

  const isNightBusiness = v.category === "snack" || v.category === "kyabakura";
  const sched = parseSchedule(v.hours, v.closedDays);
  const isUnverified = UNVERIFIED_VENUE_IDS.has(v.id);
  const unverifiedNotice = isUnverified
    ? `<p class="notice notice-unverified">⚠️ この店舗の営業状況を確認できていません。移転・閉店している可能性もあります。ご来店前に、最新の営業情報を出典元・店舗の公式情報で必ずご確認ください。</p>`
    : "";

  const photoSource = pickPhotoSource(v);
  const igEmbed = instagramEmbedHtml(v.id);
  const officialPhoto = officialPhotoHtml(v.id);
  // 写真(公式Instagram埋め込み or 公式サイト画像)を掲載している場合に表示する削除依頼案内。
  const photoRemovalNotice = `<p class="small photo-removal-notice">写真は店舗の公式発信(公式Instagram/公式サイト)を出典として掲載しています。掲載を希望されない店舗様は<a href="mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`【${v.name}】写真掲載について`)}">${escapeHtml(CONTACT_EMAIL)}</a>までご連絡ください。速やかに対応いたします。</p>`;
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

  const body = `
<nav class="breadcrumb"><a href="${url("/")}">TOP</a> &gt; <a href="${url(`/areas/${area.id}/`)}">${escapeHtml(area.name)}</a> &gt; <a href="${url(`/categories/${category.id}/`)}">${escapeHtml(category.name)}</a> &gt; ${escapeHtml(v.name)}</nav>

<article class="venue-detail">
  <header class="venue-hero" style="--cat-color:${CATEGORY_COLORS[v.category] || "#e8a33d"}">
    ${venueIconSlotHtml(v, "hero")}
    <div class="venue-hero-text">
      <span class="venue-hero-cat">${escapeHtml(categoryLabel(v, category.name))}<span class="venue-hero-sep">・</span>${escapeHtml(area.name)}</span>
      <h1>${escapeHtml(v.name)}</h1>
      ${v.walk ? `<span class="venue-hero-walk">🚶 ${escapeHtml(v.walk)}</span>` : ""}
      ${sched.parsed ? `<span id="open-now-badge" class="open-badge" data-open="${sched.slots.map((s) => `${s.day},${s.start},${s.end}`).join(";")}"${sched.fuzzy ? ' data-open-fuzzy="1"' : ""} hidden></span>` : ""}
    </div>
  </header>
  ${venueLogoCreditHtml(v)}
  ${unverifiedNotice}
  ${tagsHtml ? `<p class="tags">${tagsHtml}</p>` : ""}

  ${chargeCalloutHtml(v)}

  ${photoSectionHtml}

  <section class="info-section">
    <h2 class="section-heading"><span class="section-heading-icon">📋</span>店舗情報</h2>
    <table class="venue-table">
      <tr><th>業態</th><td>${escapeHtml(categoryLabel(v, category.name))}</td></tr>
      <tr><th>エリア</th><td><a href="${url(`/areas/${area.id}/`)}">${escapeHtml(area.name)}</a></td></tr>
      <tr><th>住所</th><td>${escapeHtml(v.address || "情報準備中")}</td></tr>
      <tr><th>最寄駅からの目安</th><td>${escapeHtml(v.walk || "情報準備中")}</td></tr>
      <tr><th>営業時間</th><td>${escapeHtml(v.hours || "情報準備中(出典元でご確認ください)")}</td></tr>
      ${v.closedDays ? `<tr><th>定休日</th><td>${escapeHtml(v.closedDays)}</td></tr>` : ""}
      <tr><th>電話番号</th><td>${escapeHtml(v.phone || "情報準備中")}</td></tr>
      ${v.budgetDinner ? `<tr><th>予算(夜)</th><td>${escapeHtml(v.budgetDinner)}</td></tr>` : ""}
      ${v.budgetLunch ? `<tr><th>予算(昼)</th><td>${escapeHtml(v.budgetLunch)}</td></tr>` : ""}
      ${!v.budgetDinner && !v.budgetLunch ? `<tr><th>価格帯</th><td>${escapeHtml(v.priceRange || "情報準備中")}</td></tr>` : v.priceRange ? `<tr><th>価格帯</th><td>${escapeHtml(v.priceRange)}</td></tr>` : ""}
      ${v.charge ? `<tr><th>チャージ・お通し</th><td>${escapeHtml(v.charge)}</td></tr>` : ""}
      ${v.seats ? `<tr><th>席数</th><td>${escapeHtml(v.seats)}</td></tr>` : ""}
      ${v.payment ? `<tr><th>支払い方法</th><td>${escapeHtml(v.payment)}</td></tr>` : ""}
      ${v.smoking ? `<tr><th>喫煙</th><td>${escapeHtml(v.smoking)}</td></tr>` : ""}
      ${v.reservation ? `<tr><th>予約</th><td>${escapeHtml(v.reservation)}</td></tr>` : ""}
    </table>
    ${isNightBusiness ? '<p class="notice">接待を伴う飲食店です。20歳未満の方はご利用いただけません。</p>' : ""}
  </section>

  ${mapSectionHtml(v)}

  <section class="info-section">
    <h2 class="section-heading"><span class="section-heading-icon">🔗</span>情報源</h2>
    <p class="small">上記の情報は下記の公開情報をもとにした要約です(${BUILD_DATE}時点)。最新の営業状況は各出典元、または店舗の公式サイト・SNSでご確認ください。</p>
    <ul class="sources">
${sourcesHtml}
    </ul>
  </section>

  <section class="info-section">
    <h2 class="section-heading"><span class="section-heading-icon">✉️</span>関係者の方へ</h2>
    <p>この店舗の情報に誤りがある、追加・修正をご希望の場合、または掲載を希望されない場合は、下記メールアドレスまでご連絡ください。</p>
    <p><a href="mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`【${v.name}】情報の追加・修正について`)}">${escapeHtml(CONTACT_EMAIL)}</a></p>
  </section>
</article>

<section>
  <h2>${escapeHtml(area.name)}の他の店舗</h2>
  <ul class="venue-list">
${relatedInArea}
  </ul>
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

function renderAboutPage() {
  const body = `
<h1>このサイトについて</h1>
<p>久留米飲み屋ナビは、福岡県久留米市・西鉄久留米駅周辺(一番街・二番街・文化街周辺エリア)のバー・居酒屋・コンカフェ・シーシャ・アミューズメントポーカーバーなど、飲み屋を幅広く紹介する情報サイトです。</p>

<h2>掲載方針</h2>
<ul>
  <li>性風俗関連特殊営業(いわゆる「風俗」)は掲載対象外です。</li>
  <li>掲載情報は、店舗の公式サイト・SNS、飲食店情報サイト、業界団体(組合)の公表情報など、インターネット上に公開されている情報をもとに要約・作成しています。各ページに情報源のリンクを掲載しています。</li>
  <li>他サイトの文章・写真をそのまま転載することはしていません。写真は、店舗の公式サイト・公式Instagramなど<strong>店ご自身の公式発信のみ</strong>を出典として掲載しています(第三者のグルメサイト等の写真は使用していません)。写真がない店舗は、業態を示す汎用アイコンを表示しています。</li>
  <li>店舗のロゴについても、その店(またはチェーンの運営元)の公式サイトに掲載されているものだけを、公式サイト上の画像を直接参照する形で表示しています(当サイトのサーバーには保存していません)。掲載元へのリンクは各店舗ページに記載しています。ロゴの掲載を希望されない場合は、下記の連絡先までお知らせください。</li>
  <li>営業時間・料金等は変更されることがあります。最新情報は各店舗の公式情報でご確認ください。</li>
</ul>

<h2>外部サービスの埋め込み・参照について</h2>
<p>本サイトの各店舗ページでは、Instagram公式の投稿埋め込み、Googleマップの地図埋め込み、各店の公式サイト画像の参照などを行っています。そのため、ページ閲覧時にお使いのブラウザから Instagram(Meta)・Google・各店の公式サイト等の外部サーバーへ通信が発生する場合があります。これら外部サービス側での情報の取り扱いは、各サービスのプライバシーポリシーに従います。</p>

<h2>商標・権利の帰属、および提携関係がないことについて</h2>
<p>本サイトに掲載している店舗名・ロゴ・商標は、各権利者に帰属します。当サイトは、公開されている情報をもとに店舗を紹介する情報サイトであり、<strong>掲載店舗との間に提携・協賛・推奨・公認等の関係は一切ありません</strong>。ロゴは、その店舗(またはチェーンの運営元)を識別しやすくする目的で、各店の公式サイト上の画像を参照して表示しているものであり、当サイトが各店舗から掲載の許諾や対価を受けていることを示すものではありません。</p>

<h2>掲載店舗の関係者の方へ</h2>
<p>当サイトへの掲載内容に誤りがある場合の修正依頼、掲載を希望されない場合の削除依頼については、下記メールアドレスまでご連絡ください。</p>
<p><a href="mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("掲載内容について")}">${escapeHtml(CONTACT_EMAIL)}</a></p>

<h2>年齢確認について</h2>
<p>接待を伴う飲食店は、20歳未満の方はご利用いただけません。</p>
`;
  return layout({
    title: "このサイトについて",
    description: "久留米飲み屋ナビの掲載方針、情報源、掲載店舗の関係者の方向けのご案内。",
    pathname: "/about/",
    bodyHtml: body,
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

  // 公開対象に絞り込む。非公開は2種類あり、いずれも data/venues.json にはデータとして残すが
  // dist/ 配下にページを一切生成しない(リンクを隠すだけでなく、ファイル自体を作らない):
  //   (a) 非公開カテゴリ(スナック・キャバクラ) … PUBLISHED_CATEGORIES 外
  //   (b) 店舗単位のフェーズ2(接待性のある店) … PHASE2_VENUE_IDS
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

  const phase2Published = [...PHASE2_VENUE_IDS].filter((id) => PUBLISHED_CATEGORIES.includes((allVenues.find((v) => v.id === id) || {}).category));
  console.log(
    `公開対象: ${venues.length}件 / 全データ: ${allVenues.length}件(非公開: ${hiddenCount}件 = 非公開カテゴリ${allCategories
      .filter((c) => !PUBLISHED_CATEGORIES.includes(c.id))
      .map((c) => c.name)
      .join("・")} + 店舗単位フェーズ2${phase2Published.length}件)`
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
  const orphanLogoIds = brokenLogoIds;
  console.log(`ロゴ表示: ${Object.keys(VENUE_LOGOS).length - orphanLogoIds.length - hiddenLogoIds.length}件`);

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

  const urls = [];

  // トップページ
  writeFile("index.html", renderTop(venues, areas, categories));
  urls.push("/");

  // about
  writeFile("about/index.html", renderAboutPage());
  urls.push("/about/");

  // 絞り込み検索(エリア・業態・タグを組み合わせ)
  writeFile("search/index.html", renderSearchPage(venues, areas, categories));
  urls.push("/search/");

  // エリア一覧・個別(店舗数・一覧は公開対象のみでカウント)
  writeFile("areas/index.html", renderAreaIndex(areas, venues));
  urls.push("/areas/");
  for (const area of areas) {
    writeFile(`areas/${area.id}/index.html`, renderAreaPage(area, venues, categories, areas));
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
    writeFile(`venues/${v.id}/index.html`, renderVenuePage(v, area, category, venues, areas, categories));
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

  console.log(`Built ${urls.length} pages into ${DIST_DIR}`);
}

build();
