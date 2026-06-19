import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatServiceStatus,
  resolveCliProgramArguments,
  resolveServiceUpMode,
} from "../lib/service.js";

describe("addroid service mode helpers", () => {
  it("defaults resident services to shared mode", () => {
    assert.equal(resolveServiceUpMode({}, {}), "shared");
  });

  it("accepts separate-worker from explicit options or env", () => {
    assert.equal(resolveServiceUpMode({ mode: "separate-worker" }, {}), "separate-worker");
    assert.equal(
      resolveServiceUpMode({}, { ADDROID_SERVICE_UP_MODE: "separate_worker" }),
      "separate-worker"
    );
  });

  it("rejects unsupported resident-service modes", () => {
    assert.throws(
      () => resolveServiceUpMode({}, { ADDROID_SERVICE_UP_MODE: "cluster" }),
      /ADDROID_SERVICE_UP_MODE/
    );
  });

  it("adds --separate-worker to generated service up arguments", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-service-"));
    try {
      fs.mkdirSync(path.join(repo, "node_modules", ".bin"), { recursive: true });
      fs.mkdirSync(path.join(repo, "apps", "cli", "src"), { recursive: true });
      fs.writeFileSync(path.join(repo, "node_modules", ".bin", "tsx"), "", "utf8");
      fs.writeFileSync(path.join(repo, "apps", "cli", "src", "index.ts"), "", "utf8");

      const shared = await resolveCliProgramArguments(repo, "shared");
      assert.deepEqual(shared.slice(-2), [path.join(repo, "apps", "cli", "src", "index.ts"), "up"]);

      const separate = await resolveCliProgramArguments(repo, "separate-worker");
      assert.deepEqual(separate.slice(-3), [
        path.join(repo, "apps", "cli", "src", "index.ts"),
        "up",
        "--separate-worker",
      ]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("renders installed service up mode in status output", () => {
    const lines = formatServiceStatus({
      platform: "launchd",
      installed: true,
      running: true,
      mode: "separate-worker",
      pid: 123,
      unitPath: "/tmp/ai.addroid.service.plist",
    });
    assert.ok(lines.some((line) => line.includes("up mode") && line.includes("separate-worker")));
  });
});
