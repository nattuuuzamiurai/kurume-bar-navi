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

const DISCLAIMER = `本サイトは福岡県久留米市・西鉄久留米駅周辺エリア(一番街・二番街・文化街周辺)の飲食店・ナイトライフ店舗を紹介する情報サイトです。掲載情報は店舗公式サイト・SNS、飲食店情報サイト、業界団体(組合)の公表情報など公開されている情報をもとに${BUILD_DATE}時点で作成した要約であり、内容の正確性・最新性を保証するものではありません。ご来店の際は、営業時間・定休日・料金等を各店舗の最新の公式情報でご確認ください。性風俗関連特殊営業に該当する業態は掲載対象外です。20歳未満の方は、酒類提供業態・接待を伴う飲食店をご利用いただけません。`;

function layout({ title, description, pathname, bodyHtml, jsonLd, robotsNoindex }) {
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
</header>
<main>
${bodyHtml}
</main>
<footer class="site-footer">
  <p>${escapeHtml(DISCLAIMER)}</p>
  <p><a href="${url("/about/")}">このサイトについて・掲載店舗の関係者の方へ</a></p>
  <p>&copy; ${SITE_NAME}</p>
</footer>
</body>
</html>
`;
}

function venueCardHtml(v, categories, areas) {
  const cat = categories.find((c) => c.id === v.category);
  const area = areas.find((a) => a.id === v.area);
  return `<li class="venue-card">
  <a href="${url(`/venues/${v.id}/`)}">
    <span class="venue-name">${escapeHtml(v.name)}</span>
    <span class="venue-meta">${escapeHtml(cat ? cat.name : v.category)} / ${escapeHtml(area ? area.name : v.area)}${v.walk ? " / " + escapeHtml(v.walk) : ""}</span>
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
        `<li><a href="${url(`/categories/${c.id}/`)}">${escapeHtml(c.name)}<span class="count">(${venues.filter((v) => v.category === c.id).length}件)</span></a></li>`
    )
    .join("\n");
  const newest = venues.slice(0, 12).map((v) => venueCardHtml(v, categories, areas)).join("\n");

  const body = `
<section class="hero">
  <h1>久留米飲み屋ナビ</h1>
  <p>福岡県久留米市・西鉄久留米駅周辺(一番街・二番街・文化街)のバー・居酒屋・コンカフェ・シーシャ・アミューズメントポーカーバーなど、飲み屋を幅広くまとめた情報サイトです。現在 <strong>${venues.length}件</strong> の店舗情報を掲載しています。</p>
</section>

<section>
  <h2>エリアから探す</h2>
  <ul class="link-list">
${areaLinks}
  </ul>
</section>

<section>
  <h2>業態から探す</h2>
  <ul class="link-list">
${categoryLinks}
  </ul>
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
      (c) => `<li><a href="${url(`/categories/${c.id}/`)}"><strong>${escapeHtml(c.name)}</strong>(${venues.filter((v) => v.category === c.id).length}件)</a><p>${escapeHtml(c.summary)}</p></li>`
    )
    .join("\n");
  const body = `
<h1>業態一覧</h1>
<ul class="link-list-detailed">
${items}
</ul>
`;
  return layout({
    title: "業態一覧",
    description: "久留米飲み屋ナビが掲載するバー・居酒屋・コンカフェ・シーシャ・アミューズメントポーカーバーの一覧。",
    pathname: "/categories/",
    bodyHtml: body,
  });
}

function renderAreaPage(area, venues, categories, areas) {
  const list = venues
    .filter((v) => v.area === area.id)
    .map((v) => venueCardHtml(v, categories, areas))
    .join("\n");
  const body = `
<nav class="breadcrumb"><a href="${url("/")}">TOP</a> &gt; <a href="${url("/areas/")}">エリア</a> &gt; ${escapeHtml(area.name)}</nav>
<h1>${escapeHtml(area.name)}の飲み屋一覧</h1>
<p>${escapeHtml(area.summary)}</p>
<ul class="venue-list">
${list || "<li>準備中です。</li>"}
</ul>
`;
  return layout({
    title: `${area.name}の飲み屋一覧`,
    description: `福岡県久留米市${area.name}エリアのバー・居酒屋・コンカフェ等の飲み屋一覧。${area.summary}`,
    pathname: `/areas/${area.id}/`,
    bodyHtml: body,
  });
}

function renderCategoryPage(category, venues, areas, categories) {
  const list = venues
    .filter((v) => v.category === category.id)
    .map((v) => venueCardHtml(v, categories, areas))
    .join("\n");
  const body = `
<nav class="breadcrumb"><a href="${url("/")}">TOP</a> &gt; <a href="${url("/categories/")}">業態</a> &gt; ${escapeHtml(category.name)}</nav>
<h1>久留米・西鉄久留米駅周辺の${escapeHtml(category.name)}一覧</h1>
<p>${escapeHtml(category.summary)}</p>
<ul class="venue-list">
${list || "<li>準備中です。</li>"}
</ul>
`;
  return layout({
    title: `${category.name}一覧`,
    description: `福岡県久留米市・西鉄久留米駅周辺の${category.name}一覧。${category.summary}`,
    pathname: `/categories/${category.id}/`,
    bodyHtml: body,
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
  const tagsHtml = (v.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(" ");

  const relatedInArea = allVenues
    .filter((x) => x.area === v.area && x.id !== v.id)
    .slice(0, 6)
    .map((x) => venueCardHtml(x, categories, areas))
    .join("\n");

  const isNightBusiness = v.category === "snack" || v.category === "kyabakura";

  const body = `
<nav class="breadcrumb"><a href="${url("/")}">TOP</a> &gt; <a href="${url(`/areas/${area.id}/`)}">${escapeHtml(area.name)}</a> &gt; <a href="${url(`/categories/${category.id}/`)}">${escapeHtml(category.name)}</a> &gt; ${escapeHtml(v.name)}</nav>

<article class="venue-detail">
  <h1>${escapeHtml(v.name)}</h1>
  <p class="venue-meta">${escapeHtml(category.name)} / ${escapeHtml(area.name)}${v.walk ? " / " + escapeHtml(v.walk) : ""}</p>
  ${tagsHtml ? `<p class="tags">${tagsHtml}</p>` : ""}

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
  <li>他サイトの文章・写真をそのまま転載することはしていません。</li>
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
