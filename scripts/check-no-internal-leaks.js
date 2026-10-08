#!/usr/bin/env node
/**
 * 公開配信ファイル(dist/ 配下。GitHub Pages で訪問者に直接配信される)に、
 * 社内の意思決定プロセスの詳細(誰が・どの部署が・どういう内部事情で判断したか)が
 * 書き込まれていないかを自動検知する。
 *
 * 背景: 会社ワークスペースの CLAUDE.md が定める方針により、ソースコード・ドキュメント
 * には「社内の判断・指示の詳細な中身」を書き込まない。dist/ はビルド成果物で <script src>
 * 等により訪問者へ直接配信されるため、ここに混入すると view-source なしでも誰でも読める。
 * この検知は最終防衛線であり、そもそもソース側(scripts/・data/・README.md 等)で
 * 混入させないことが基本。
 *
 * 使い方: `node scripts/build.js && node scripts/check-no-internal-leaks.js`
 * 検知した場合は exit code 1 で失敗する(CIでデプロイをブロックする想定)。
 */
const fs = require("fs");
const path = require("path");

const DIST_DIR = path.join(__dirname, "..", "dist");

// 禁止パターン: 社内の役割名・意思決定プロセスを示す語。
// 役割名そのもの(「社長」等)は dist に出る理由が無いため、誤検知のリスクは低い。
const BANNED_PATTERNS = [
  /社長/,
  /経営管理オフィス/,
  /企画部/,
  /開発部/,
  /品質管理部/,
  /レビュー部/,
  /マーケティング部/,
  /人事部/,
  /\bwaive\b/i,
  /絶対条件/,
  /PR\s*#\d+/, // 内部PR番号
];

const SCAN_EXTENSIONS = new Set([".html", ".js", ".json", ".css", ".xml", ".txt"]);

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error(
      `[check-no-internal-leaks] ${DIST_DIR} が存在しません。先に \`node scripts/build.js\` を実行してください。`
    );
    process.exit(1);
  }

  const files = walk(DIST_DIR);
  const violations = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const pattern of BANNED_PATTERNS) {
        if (pattern.test(lines[i])) {
          violations.push({
            file: path.relative(DIST_DIR, file),
            line: i + 1,
            pattern: pattern.toString(),
            snippet: lines[i].trim().slice(0, 160),
          });
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      `[check-no-internal-leaks] 公開配信ファイルに社内プロセスを示す記述が ${violations.length} 件見つかりました:`
    );
    for (const v of violations) {
      console.error(`  dist/${v.file}:${v.line} (${v.pattern}) -> ${v.snippet}`);
    }
    console.error(
      "[check-no-internal-leaks] ソース側(scripts/・data/・content/ 等)の記述を見直してください。"
    );
    process.exit(1);
  }

  console.log(
    `[check-no-internal-leaks] OK: dist/ 配下 ${files.length} ファイルに禁止パターンの混入なし。`
  );
}

main();
