/**
 * エリアガイド記事(content/guides/*.md)専用の、ごく小さいMarkdown→HTML変換ヘルパー。
 *
 * 【なぜ自作か】本プロジェクトは外部ライブラリ依存ゼロの静的サイトジェネレーター(build.js冒頭のコメント参照)。
 * 汎用Markdownパーサーではなく、content/guides/*.md で実際に使われている記法(見出し#/##/###、
 * 太字**、リンク[]()、表|...|、箇条書き-、段落)だけをサポートする最小実装にとどめる。
 *
 * 使い方: parseGuideMarkdown(rawMarkdown, { resolveLink }) を呼ぶと
 *   { title, description, bodyHtml } を返す。
 *   - title: 先頭の `# 見出し` から取得(ページの<title>・本文<h1>用)
 *   - description: `**メタディスクリプション(案)**: ...` の行から取得(meta descriptionに使う)
 *   - bodyHtml: それ以降(区切り線 `---` の次)の本文をHTML化したもの
 *
 * resolveLink(url) は、Markdown中のリンクURLを実際の出力URLに変換するための呼び出し元フック。
 * (例: "./a1-ichibangai.md" → "/kurume-bar-navi/guides/ichibangai/")
 */

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// インライン記法(太字・リンク)をHTML化する。呼び出し前にプレーンテキストとして escapeHtml 済みの
// 文字列を渡すこと(*, [, ], (, ) はエスケープされないのでMarkdown記法として引き続き認識できる)。
function inline(rawText, resolveLink) {
  let text = escapeHtml(rawText);

  // リンク: [表示テキスト](URL)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    const resolved = resolveLink(href);
    const isExternal = /^https?:\/\//i.test(resolved.href);
    const attrs = isExternal ? ' rel="nofollow noopener" target="_blank"' : "";
    return `<a href="${resolved.href}"${attrs}>${label}</a>`;
  });

  // 太字: **text**
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  return text;
}

function parseTableRow(line) {
  // 先頭・末尾の "|" を落とし、セルに分割する。
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function isTableSeparatorRow(line) {
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(line.trim());
}

function renderBody(bodyLines, resolveLink) {
  const html = [];
  let i = 0;
  while (i < bodyLines.length) {
    const line = bodyLines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    // 見出し
    const h3 = line.match(/^###\s+(.*)$/);
    const h2 = line.match(/^##\s+(.*)$/);
    const h1 = line.match(/^#\s+(.*)$/);
    if (h3) {
      html.push(`<h3>${inline(h3[1], resolveLink)}</h3>`);
      i++;
      continue;
    }
    if (h2) {
      html.push(`<h2>${inline(h2[1], resolveLink)}</h2>`);
      i++;
      continue;
    }
    if (h1) {
      html.push(`<h1>${inline(h1[1], resolveLink)}</h1>`);
      i++;
      continue;
    }

    // 区切り線(本文中に単独で出てきた場合は無視する)
    if (line.trim() === "---") {
      i++;
      continue;
    }

    // 表: 1行目がヘッダ行、2行目が区切り行(|---|---|)、以降がデータ行
    if (line.trim().startsWith("|") && i + 1 < bodyLines.length && isTableSeparatorRow(bodyLines[i + 1])) {
      const headerCells = parseTableRow(line);
      i += 2; // ヘッダ行 + 区切り行を消費
      const rows = [];
      while (i < bodyLines.length && bodyLines[i].trim().startsWith("|")) {
        rows.push(parseTableRow(bodyLines[i]));
        i++;
      }
      html.push(
        `<table class="md-table"><thead><tr>${headerCells
          .map((c) => `<th>${inline(c, resolveLink)}</th>`)
          .join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c, resolveLink)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`
      );
      continue;
    }

    // 箇条書き: 連続する "- " 行をまとめて <ul> にする
    if (line.trim().startsWith("- ")) {
      const items = [];
      while (i < bodyLines.length && bodyLines[i].trim().startsWith("- ")) {
        items.push(bodyLines[i].trim().slice(2));
        i++;
      }
      html.push(`<ul>${items.map((it) => `<li>${inline(it, resolveLink)}</li>`).join("")}</ul>`);
      continue;
    }

    // それ以外は段落(このプロジェクトの原稿では1論理行=1段落になっている)
    html.push(`<p>${inline(line.trim(), resolveLink)}</p>`);
    i++;
  }
  return html.join("\n");
}

function parseGuideMarkdown(raw, { resolveLink }) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  // 1行目: # タイトル
  const titleMatch = (lines[0] || "").match(/^#\s+(.*)$/);
  const title = titleMatch ? titleMatch[1].trim() : "";

  // メタディスクリプション行(**メタディスクリプション(案)**: ...)を探し、それ以降 "---" までを
  // 本文から除外する(社内向けの執筆メモであり、そのままページ本文には出さない)。
  let descIndex = -1;
  let dividerIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (descIndex === -1 && /^\*\*メタディスクリプション[^*]*\*\*[:：]/.test(lines[i])) {
      descIndex = i;
    }
    if (lines[i].trim() === "---") {
      dividerIndex = i;
      break;
    }
  }
  let description = "";
  if (descIndex !== -1) {
    description = lines[descIndex].replace(/^\*\*メタディスクリプション[^*]*\*\*[:：]\s*/, "").trim();
    // 万一 description 内にリンク記法等が混じっていても、meta descriptionはプレーンテキストで十分。
    description = description.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1");
  }

  const bodyStart = dividerIndex !== -1 ? dividerIndex + 1 : 1;
  const bodyLines = lines.slice(bodyStart);
  const bodyHtml = renderBody(bodyLines, resolveLink);

  return { title, description, bodyHtml };
}

module.exports = { parseGuideMarkdown };
