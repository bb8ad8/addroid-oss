#!/usr/bin/env node
// AdDroid OSS — CHANGELOG セクション抽出。
//
// 目的:
//   `CHANGELOG.md` (Keep a Changelog 形式) から特定バージョンのセクションだけを取り出し、
//   GitHub Release の本文として使えるようにする。CHANGELOG を source of truth に保ったまま、
//   タグ push をトリガーにした release ワークフロー (.github/workflows/release.yml) と、
//   手動の `gh release create` の両方から再利用する。
//
// 使い方:
//   node scripts/extract-changelog.mjs <version>
//     <version> 例: "0.2.0" / "v0.2.0" / "Unreleased"
//   先頭の "v" は無視する。`## [<version>]` の見出しから次の `## [` 見出し直前までを返す。
//
// 終了コード:
//   0  該当セクションを stdout に出力
//   1  CHANGELOG が読めない / 該当バージョンが見つからない (stderr にエラー)
//
// 依存ゼロ (Node 標準のみ)。CHANGELOG のリンク参照 ([x.y.z]: https://...) 行は除外する。

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function repoRoot() {
  // scripts/ の 1 つ上がリポジトリルート。
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function extractChangelogSection(markdown, rawVersion) {
  const version = String(rawVersion ?? "").trim().replace(/^v/i, "");
  if (!version) throw new Error("version を指定してください (例: 0.2.0 / Unreleased)");

  const lines = markdown.split("\n");
  // `## [<version>]` で始まる見出しを探す (後続に " - 2026-..." 等が付いてもよい)。
  const headingRe = /^##\s+\[([^\]]+)\]/;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(headingRe);
    if (m && m[1].trim().toLowerCase() === version.toLowerCase()) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    throw new Error(`CHANGELOG にバージョン "[${version}]" のセクションが見つかりません。`);
  }
  // 次の `## [` 見出しまで (= 次バージョン)。
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (headingRe.test(lines[i])) {
      end = i;
      break;
    }
  }
  // 見出し行自身は除き、本文だけを返す。`---` 区切りとリンク参照行を除去し、前後の空行を trim。
  const body = lines
    .slice(start + 1, end)
    .filter((line) => !/^\[[^\]]+\]:\s+https?:\/\//.test(line)) // リンク参照行
    .join("\n")
    .replace(/\n?-{3,}\s*$/g, "") // 末尾の水平線
    .trim();
  return body;
}

function main(argv) {
  const version = argv[0];
  if (!version) {
    process.stderr.write("usage: node scripts/extract-changelog.mjs <version>\n");
    return 1;
  }
  let markdown;
  try {
    markdown = readFileSync(path.join(repoRoot(), "CHANGELOG.md"), "utf8");
  } catch (err) {
    process.stderr.write(`CHANGELOG.md を読み込めません: ${err.message}\n`);
    return 1;
  }
  try {
    const section = extractChangelogSection(markdown, version);
    if (!section) {
      process.stderr.write(`バージョン "${version}" のセクションは空でした。\n`);
      return 1;
    }
    process.stdout.write(section + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
}

// 直接実行されたときだけ CLI として動かす (テストからは extractChangelogSection を import)。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
