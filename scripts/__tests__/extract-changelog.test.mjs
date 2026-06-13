// scripts/extract-changelog.mjs の単体テスト (node:test)。
import test from "node:test";
import assert from "node:assert/strict";
import { extractChangelogSection } from "../extract-changelog.mjs";

const SAMPLE = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "- 新機能 A",
  "",
  "---",
  "",
  "## [0.2.0] - 2026-07-01",
  "",
  "### Added",
  "- 機能 B",
  "### Fixed",
  "- バグ C",
  "",
  "---",
  "",
  "## [0.1.0] - 2026-06-03",
  "",
  "- 初回リリース",
  "",
  "[0.2.0]: https://example.com/compare/v0.1.0...v0.2.0",
  "[0.1.0]: https://example.com/releases/tag/v0.1.0",
  "",
].join("\n");

test("名前付きバージョンのセクションを抽出する", () => {
  const out = extractChangelogSection(SAMPLE, "0.2.0");
  assert.match(out, /機能 B/);
  assert.match(out, /バグ C/);
  // 隣接セクションを含まない。
  assert.doesNotMatch(out, /新機能 A/);
  assert.doesNotMatch(out, /初回リリース/);
});

test("先頭の v 接頭辞を無視する", () => {
  const out = extractChangelogSection(SAMPLE, "v0.2.0");
  assert.match(out, /機能 B/);
});

test("Unreleased セクションも抽出できる", () => {
  const out = extractChangelogSection(SAMPLE, "Unreleased");
  assert.match(out, /新機能 A/);
  assert.doesNotMatch(out, /機能 B/);
});

test("末尾セクションはリンク参照行を含めない", () => {
  const out = extractChangelogSection(SAMPLE, "0.1.0");
  assert.match(out, /初回リリース/);
  assert.doesNotMatch(out, /https?:\/\//);
});

test("末尾の水平線と前後空行を除去する", () => {
  const out = extractChangelogSection(SAMPLE, "0.2.0");
  assert.doesNotMatch(out, /^---$/m);
  assert.equal(out, out.trim());
});

test("存在しないバージョンは例外", () => {
  assert.throws(() => extractChangelogSection(SAMPLE, "9.9.9"), /見つかりません/);
});

test("空バージョンは例外", () => {
  assert.throws(() => extractChangelogSection(SAMPLE, ""), /version/);
});
