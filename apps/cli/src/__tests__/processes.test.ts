import test from "node:test";
import assert from "node:assert/strict";

import { formatRss, readProcessRssKb } from "../lib/processes.js";

test("readProcessRssKb returns current process RSS when ps is available", async (t) => {
  if (process.platform === "win32") {
    t.skip("ps RSS lookup is not available on Windows");
    return;
  }

  const rss = await readProcessRssKb(process.pid);
  if (rss === null) assert.fail("expected current process RSS to be readable");
  assert.ok(rss > 0, `expected positive RSS, got ${rss}`);
});

test("readProcessRssKb returns null for a missing process", async () => {
  const rss = await readProcessRssKb(999_999_999);
  assert.equal(rss, null);
});

test("formatRss formats kilobytes for status output", () => {
  assert.equal(formatRss(null), null);
  assert.equal(formatRss(512), "0.5 MB");
  assert.equal(formatRss(2048), "2.0 MB");
});
