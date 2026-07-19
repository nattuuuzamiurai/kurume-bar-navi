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
// Googleマップへの外部リンク(iframe埋め込みは不採用)
//
// 【2026-07-19 品質管理部指摘を受けて方針修正】
// 当初はキーレスの地図iframe埋め込み(www.google.com/maps/embed?pb=...)を実装したが、
// これを撤回した。撤回理由:
//  (1) pb パラメータを「!1m2!2m1!1z + base64url(住所)」で自作していたが、これは本物の
//      Google の pb 形式(座標や場所IDを含む)ではない。APIキー無しでは住所からジオコーディング
//      できないため、この方式では正しい地図を確実に表示できず、環境によっては 404 になる
//      (品質管理部の実測で全件 404 + X-Frame-Options: SAMEORIGIN が確認された。開発環境の
//      curl では 200 が返る場合もあり、応答が不安定で信頼できない)。
//  (2) 代替として「maps.google.com/maps?q=<住所>&output=embed」も実測したが、これは初段が
//      HTTP 301 + X-Frame-Options: SAMEORIGIN を返し(最終リダイレクト先のみ 200 かつ XFO なし)、
//      「HTTP 200 かつ X-Frame-Options なし」を単体では満たさない。ブラウザは通常リダイレクトの
//      XFO を無視して最終応答のみを評価するため実ブラウザでは frameable になり得るが、
//      当環境(コマンドライン)では実ブラウザでの最終描画までは検証できない。
//
// 検証できない埋め込みを残さないという方針(品質管理部の指示)に従い、iframe埋め込みは採用せず、
// 全店舗で「Googleマップで開く」外部リンク(/maps/search/?api=1&query=... )に一本化した。
// このリンクは実測で HTTP 200 を確認済み(外部リンク=新規タブで開くため iframe ではなく、
// X-Frame-Options の制約は無関係)。GeoガイドラインもテキストやボタンでのGoogleマップリンク
// (「View on Google Maps」)を明示的に許可している。
//
// 規約面(リンク・埋め込みともに消費者向けGoogle Maps規約+Geoガイドラインの範囲で、
// Places APIのdirectory禁止条項=Platform ToS固有 は非適用)の整理は据え置き。今回は
// 技術的に確実に動くリンク方式に限定して実装する。
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

function mapSectionHtml(v) {
  const searchLink = mapSearchLink(v);
  const label = isMappableAddress(v.address)
    ? "🗺 Googleマップで場所を見る ↗"
    : "🗺 Googleマップで場所を探す ↗";
  return `<div class="map-section">
    <h2>地図・アクセス</h2>
    <p><a class="map-link-button" href="${escapeHtml(searchLink)}" rel="nofollow noopener" target="_blank">${label}</a></p>
    ${isMappableAddress(v.address) ? `<p class="small">住所: ${escapeHtml(stripAddressNotes(v.address))}(正確な位置・営業状況は店舗の公式情報でご確認ください)</p>` : ""}
  </div>`;
}

// ============================================================
// 絞り込み(エリア・業態・タグを横断して組み合わせられるファセット絞り込みUI)
// ============================================================

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
  if (areaCounts.size > 1) groups.push(facetGroupHtml("area", "エリア", areaCounts, areaIdToLabel, false));
  if (categoryCounts.size > 1) groups.push(facetGroupHtml("category", "業態", categoryCounts, categoryIdToLabel, false));
  if (tagCounts.size > 0) groups.push(facetGroupHtml("tags", "タグ", tagCounts, null, true));

  if (groups.length === 0) return "";

  return `<div class="tag-filter" data-target="${venueListId}">
  <p class="tag-filter-title">絞り込む <button type="button" class="tag-filter-reset">条件をクリア</button></p>
${groups.join("\n")}
  <p class="filter-result-count small"></p>
</div>`;
}

// 絞り込みウィジェットを動かすクライアントサイドJS(外部ライブラリ不使用)。
// area・category は「選択した値のいずれかに一致(OR)」、tags は「選択したタグを
// すべて含む(AND)」で絞り込む。3軸をまたぐ場合はAND(エリアAND業態ANDタグ)。
const FILTER_SCRIPT = `<script>
(function () {
  document.querySelectorAll('.tag-filter').forEach(function (widget) {
    var targetId = widget.getAttribute('data-target');
    var list = document.getElementById(targetId);
    if (!list) return;
    var cards = list.querySelectorAll('.venue-card');
    var allInputs = widget.querySelectorAll('input[type=checkbox]');
    var countEl = widget.querySelector('.filter-result-count');
    function selectedByFacet(facet) {
      return Array.prototype.filter.call(allInputs, function (c) {
        return c.checked && c.getAttribute('data-facet') === facet;
      }).map(function (c) { return c.value; });
    }
    function apply() {
      var selArea = selectedByFacet('area');
      var selCategory = selectedByFacet('category');
      var selTags = selectedByFacet('tags');
      var visible = 0;
      cards.forEach(function (card) {
        var area = card.getAttribute('data-area') || '';
        var category = card.getAttribute('data-category') || '';
        var tags = (card.getAttribute('data-tags') || '').split('|');
        var areaMatch = selArea.length === 0 || selArea.indexOf(area) !== -1;
        var categoryMatch = selCategory.length === 0 || selCategory.indexOf(category) !== -1;
        var tagsMatch = selTags.every(function (t) { return tags.indexOf(t) !== -1; });
        var match = areaMatch && categoryMatch && tagsMatch;
        card.style.display = match ? '' : 'none';
        if (match) visible++;
      });
      var anyChecked = Array.prototype.some.call(allInputs, function (c) { return c.checked; });
      if (countEl) countEl.textContent = anyChecked ? visible + '件表示中(全' + cards.length + '件中)' : '';
    }
    allInputs.forEach(function (c) { c.addEventListener('change', apply); });
    var resetBtn = widget.querySelector('.tag-filter-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', function (e) {
        e.preventDefault();
        allInputs.forEach(function (c) { c.checked = false; });
        apply();
      });
    }
  });
})();
</script>`;

const DISCLAIMER = `本サイトは福岡県久留米市・西鉄久留米駅周辺エリア(一番街・二番街・文化街周辺)の飲食店・ナイトライフ店舗を紹介する情報サイトです。掲載情報は店舗公式サイト・SNS、飲食店情報サイト、業界団体(組合)の公表情報など公開されている情報をもとに${BUILD_DATE}時点で作成した要約であり、内容の正確性・最新性を保証するものではありません。ご来店の際は、営業時間・定休日・料金等を各店舗の最新の公式情報でご確認ください。性風俗関連特殊営業に該当する業態は掲載対象外です。20歳未満の方は、酒類提供業態・接待を伴う飲食店をご利用いただけません。店舗の実写真は掲載しておらず、写真は各出典サイトまたはInstagram公式埋め込みでご覧いただけます(Instagram埋め込みをご利用の場合、お使いのブラウザがInstagram社のサーバーと通信します)。`;

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

function venueCardHtml(v, categories, areas) {
  const cat = categories.find((c) => c.id === v.category);
  const area = areas.find((a) => a.id === v.area);
  const tags = v.tags || [];
  const tagsAttr = escapeHtml(tags.join("|"));
  const tagsHtml = tags.length
    ? `<span class="venue-card-tags">${tags
        .slice(0, 4)
        .map((t) => `<span class="tag tag-small">${escapeHtml(t)}</span>`)
        .join(" ")}${tags.length > 4 ? `<span class="tag tag-small tag-more">+${tags.length - 4}</span>` : ""}</span>`
    : "";
  return `<li class="venue-card" data-area="${escapeHtml(v.area)}" data-category="${escapeHtml(v.category)}" data-tags="${tagsAttr}">
  <a href="${url(`/venues/${v.id}/`)}">
    ${categoryIconHtml(v.category)}
    <span class="venue-card-body">
      <span class="venue-name">${escapeHtml(v.name)}</span>
      <span class="venue-meta">${escapeHtml(cat ? cat.name : v.category)} / ${escapeHtml(area ? area.name : v.area)}${v.walk ? " / " + escapeHtml(v.walk) : ""}</span>
    </span>
  </a>
  ${tagsHtml}
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

  const body = `
<section class="hero">
  <h1>久留米飲み屋ナビ</h1>
  <p>福岡県久留米市・西鉄久留米駅周辺(一番街・二番街・文化街)のバー・居酒屋・コンカフェ・シーシャ・アミューズメントポーカーバーなど、飲み屋を幅広くまとめた情報サイトです。現在 <strong>${venues.length}件</strong> の店舗情報を掲載しています。</p>
  <a class="cta-button" href="${url("/search/")}">エリア・業態・タグで絞り込んで探す →</a>
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
      "福岡県久留米市・西鉄久留米駅周辺(一番街・二番街・文化街)のバー・居酒屋・コンカフェ・シーシャ・アミューズメントポーカーバーなど飲み屋を網羅する情報サイト。",
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
<h1>エリア・業態・タグで探す</h1>
<p>エリア・業態・タグを組み合わせて、条件に合うお店を絞り込めます(複数選択可)。</p>
${filterWidgetHtml(venues, listId, areas, categories)}
<ul class="venue-list" id="${listId}">
${list}
</ul>
`;
  return layout({
    title: "エリア・業態・タグで探す",
    description: "久留米飲み屋ナビの全店舗を、エリア・業態・タグを組み合わせて絞り込める検索ページ。",
    pathname: "/search/",
    bodyHtml: body,
    extraScript: FILTER_SCRIPT,
  });
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
  return data;
}

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

  const photoSource = pickPhotoSource(v);
  const igEmbed = instagramEmbedHtml(v.id);
  const photoSectionHtml = igEmbed
    ? `<div class="photo-section">
    <h2>写真</h2>
    ${igEmbed}
    <p class="small">Instagram公式の埋め込み機能で表示しています。${photoSource ? `他の写真は<a href="${escapeHtml(photoSource.url)}" rel="nofollow noopener" target="_blank">${escapeHtml(photoSource.label)}</a>でもご覧いただけます。` : ""}</p>
  </div>`
    : photoSource
    ? `<div class="photo-section">
    <a class="photo-link-button" href="${escapeHtml(photoSource.url)}" rel="nofollow noopener" target="_blank">📷 ${escapeHtml(photoSource.label)}で写真を見る ↗</a>
  </div>`
    : "";

  const body = `
<nav class="breadcrumb"><a href="${url("/")}">TOP</a> &gt; <a href="${url(`/areas/${area.id}/`)}">${escapeHtml(area.name)}</a> &gt; <a href="${url(`/categories/${category.id}/`)}">${escapeHtml(category.name)}</a> &gt; ${escapeHtml(v.name)}</nav>

<article class="venue-detail">
  <div class="venue-detail-header" style="--cat-color:${CATEGORY_COLORS[v.category] || "#e8a33d"}">
    ${categoryIconHtml(v.category)}
    <div>
      <h1>${escapeHtml(v.name)}</h1>
      <p class="venue-meta">${escapeHtml(category.name)} / ${escapeHtml(area.name)}${v.walk ? " / " + escapeHtml(v.walk) : ""}</p>
    </div>
  </div>
  ${tagsHtml ? `<p class="tags">${tagsHtml}</p>` : ""}

  ${photoSectionHtml}

  <table class="venue-table">
    <tr><th>業態</th><td>${escapeHtml(category.name)}</td></tr>
    <tr><th>エリア</th><td><a href="${url(`/areas/${area.id}/`)}">${escapeHtml(area.name)}</a></td></tr>
    <tr><th>住所</th><td>${escapeHtml(v.address || "情報準備中")}</td></tr>
    <tr><th>最寄駅からの目安</th><td>${escapeHtml(v.walk || "情報準備中")}</td></tr>
    <tr><th>営業時間</th><td>${escapeHtml(v.hours || "情報準備中(出典元でご確認ください)")}</td></tr>
    <tr><th>電話番号</th><td>${escapeHtml(v.phone || "情報準備中")}</td></tr>
    <tr><th>価格帯</th><td>${escapeHtml(v.priceRange || "情報準備中")}</td></tr>
  </table>

  ${isNightBusiness ? '<p class="notice">接待を伴う飲食店です。20歳未満の方はご利用いただけません。</p>' : ""}

  ${mapSectionHtml(v)}

  <h2>情報源</h2>
  <p class="small">上記の情報は下記の公開情報をもとにした要約です(${BUILD_DATE}時点)。最新の営業状況は各出典元、または店舗の公式サイト・SNSでご確認ください。</p>
  <ul class="sources">
${sourcesHtml}
  </ul>

  <h2>関係者の方へ</h2>
  <p>この店舗の情報に誤りがある、追加・修正をご希望の場合、または掲載を希望されない場合は、下記メールアドレスまでご連絡ください。</p>
  <p><a href="mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`【${v.name}】情報の追加・修正について`)}">${escapeHtml(CONTACT_EMAIL)}</a></p>
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
    extraScript: igEmbed ? INSTAGRAM_EMBED_SCRIPT : "",
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
  <li>他サイトの文章・写真をそのまま転載することはしていません。店舗の写真は掲載せず、業態を示す汎用アイコンを表示しています。写真をご覧になりたい場合は、各店舗ページの「写真を見る」ボタンから出典サイトへ、またはInstagram公式の埋め込み(利用可能な店舗のみ)でご覧いただけます。</li>
  <li>営業時間・料金等は変更されることがあります。最新情報は各店舗の公式情報でご確認ください。</li>
</ul>

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

  // 公開対象(PUBLISHED_CATEGORIES)のみに絞り込む。
  // 非公開の業態(スナック・キャバクラ等)は data/venues.json にはデータとして残るが、
  // dist/ 配下にページを一切生成しない(リンクを隠すだけでなく、ファイル自体を作らない)。
  const venues = allVenues.filter((v) => PUBLISHED_CATEGORIES.includes(v.category));
  const categories = allCategories.filter((c) => PUBLISHED_CATEGORIES.includes(c.id));
  const hiddenCount = allVenues.length - venues.length;
  console.log(
    `公開対象: ${venues.length}件 / 全データ: ${allVenues.length}件(非公開: ${hiddenCount}件、カテゴリ: ${allCategories
      .filter((c) => !PUBLISHED_CATEGORIES.includes(c.id))
      .map((c) => c.name)
      .join("・")})`
  );

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
