// AdDroid OSS — creative-storage.ts tests (Implementation item).
//
// LocalDisk Storage Adapter と structurally 互換な fake adapter を tmp dir に
// 用意し、`persistCreativeAssets` が
//   creatives/<account_key>/<creative_id>/<asset_id>.<ext>
//   creatives/<account_key>/<creative_id>/metadata.json
// の layout で正しく書き出すことを検証する。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CreativeStorageInvalidIdError,
  CreativeStorageQaIncompleteError,
  DEFAULT_CREATIVE_QA_POLICY,
  MockImageProvider,
  evaluateCreativeQaBatch,
  persistCreativeAssets,
  type CreativeGenes,
  type CreativeStorageAdapter,
  type ImageGenerateResult,
  type ImageGeneratedAsset,
  type ImagePromptVariant,
} from "../index.js";

// ---------------------------------------------------------------------------
// Tiny LocalDisk-shaped adapter used by the tests. Mirrors the contract of
// `@addroid/config.LocalDiskStorage.write` (relative POSIX key, atomic mode 0o600
// behaviour is not required for the tests). Keeps llm-provider free of a hard
// dep on @addroid/config while exercising the same shape the real adapter has.
// ---------------------------------------------------------------------------

interface DiskStorage extends CreativeStorageAdapter {
  readonly root: string;
}

async function makeDiskStorage(): Promise<{ store: DiskStorage; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "addroid-creative-storage-"));
  const store: DiskStorage = {
    root,
    async write(key, data) {
      if (typeof key !== "string" || key.length === 0) {
        throw new Error("storage key must be non-empty");
      }
      if (key.startsWith("/") || key.includes("..")) {
        throw new Error(`unsafe key: ${key}`);
      }
      const abs = path.resolve(root, key);
      const rel = path.relative(root, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`escaped storage root: ${key}`);
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      if (typeof data === "string") {
        await fs.writeFile(abs, data, "utf8");
        return { path: abs, bytes: Buffer.byteLength(data, "utf8") };
      }
      await fs.writeFile(abs, data);
      return { path: abs, bytes: data.byteLength };
    },
  };
  return {
    store,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Generation fixture
// ---------------------------------------------------------------------------

async function fixtureGeneration(): Promise<ImageGenerateResult> {
  const provider = new MockImageProvider();
  return provider.generateImage({
    prompt: "operator-grade ad creative, calm indigo accent",
    purpose: "agent:image_prompt",
    variationConditions: [
      { width: 1080, height: 1080, variantKey: "feed_square" },
      { width: 1200, height: 628, variantKey: "feed_landscape" },
    ],
  });
}

/**
 * regression fix: persistCreativeAssets が per-asset QA を必須化したため、
 * テストフィクスチャで使う「許容されるサイズに対する pass する QA バッチ」を
 * 1 か所にまとめる。`evaluateCreativeQaBatch` は `@addroid/llm-provider` 公開関数
 * (production の `generateAndQaCreative` と同じ実装) なので、本ヘルパは production
 * の per-asset QA 出力 shape と完全に同形になる。
 *
 * regression fix: aggregator が「skipped blocking → qa_failed」を強制する
 * ようになったため、本ヘルパは `DEFAULT_CREATIVE_QA_POLICY` (= production
 * runtime と同じ非空 policy) を適用しつつ、forbidden_expression / brand_tone
 * が走るための haystack (= variant の prompt / styleNotes) も必ず付与する。
 * これにより「fixture が意図したとおり overall=qa_passed を返す」性質を
 * 保ちつつ、skipped 経由の素通りを排除できる。
 */
function passingQaForFixture(generation: ImageGenerateResult) {
  return evaluateCreativeQaBatch(
    generation.assets.map((a) => ({
      asset: a,
      variant: buildSafeVariantForAsset(a.variantKey, generation.meta.prompt),
    })),
    DEFAULT_CREATIVE_QA_POLICY
  );
}

/**
 * regression fix: forbidden_expression / brand_tone が `skipped` で倒れない
 * ように、generation の prompt をそのまま流用した安全な variant を作る。
 * `DEFAULT_CREATIVE_QA_POLICY` の forbidden term / forbidden tone と
 * 重ならない fixture 文字列であることを前提とする。
 */
function buildSafeVariantForAsset(
  variantKey: string,
  prompt: string
): ImagePromptVariant {
  return {
    variantKey,
    prompt,
    styleNotes: "minimalist, monochrome",
    negativePrompt: "logos, mascots",
  };
}

const PNG_SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function assertStartsWithPngSig(buf: Buffer): void {
  for (let i = 0; i < PNG_SIG.length; i += 1) {
    assert.equal(buf[i], PNG_SIG[i], `byte ${i} mismatch (not a PNG)`);
  }
}

// ---------------------------------------------------------------------------
// Path layout
// ---------------------------------------------------------------------------

test("persistCreativeAssets writes assets under creatives/<account_key>/<creative_id>/", async () => {
  const { store, cleanup } = await makeDiskStorage();
  try {
    const generation = await fixtureGeneration();
    const result = await persistCreativeAssets({
      storage: store,
      accountKey: "acme-co",
      creativeId: "creative_test_001",
      generation,
      qa: passingQaForFixture(generation),
      metadataCreatedAt: "2026-05-02T00:00:00.000Z",
    });

    assert.equal(result.creativeId, "creative_test_001");
    assert.equal(result.accountKey, "acme-co");
    assert.equal(result.baseStorageKey, "creatives/acme-co/creative_test_001");
    assert.equal(
      result.baseStorageRef,
      "storage://creatives/acme-co/creative_test_001"
    );
    assert.equal(result.assets.length, 2);

    for (const asset of result.assets) {
      assert.match(asset.assetId, /^asset_[0-9a-f]{12}$/, "asset_id is sha-derived");
      assert.equal(asset.filename, `${asset.assetId}.png`);
      assert.equal(
        asset.storageKey,
        `creatives/acme-co/creative_test_001/${asset.filename}`
      );
      assert.equal(
        asset.storageRef,
        `storage://creatives/acme-co/creative_test_001/${asset.filename}`
      );
      const onDisk = await fs.readFile(path.join(store.root, asset.storageKey));
      assert.equal(onDisk.length, asset.byteSize);
      assertStartsWithPngSig(onDisk);
    }

    assert.equal(
      result.metadata.storageKey,
      "creatives/acme-co/creative_test_001/metadata.json"
    );
    assert.equal(
      result.metadata.storageRef,
      "storage://creatives/acme-co/creative_test_001/metadata.json"
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Metadata content
// ---------------------------------------------------------------------------

test("persistCreativeAssets writes metadata.json that preserves prompt, provider, model, parameters, qa, genes, and linkage", async () => {
  const { store, cleanup } = await makeDiskStorage();
  try {
    const generation = await fixtureGeneration();
    // regression fix: 全 5 check が pass する non-empty policy + variant を
    // `passingQaForFixture` に集約済み。本テストは metadata.json が QA 結果を
    // 保持することを検証する目的なので、共通 helper を使って意図を統一する。
    const qa = passingQaForFixture(generation);
    const genes = {
      schemaVersion: 1,
      appealAxes: ["benefit", "feature"],
      tone: "calm",
      subjectType: "product",
      colorScheme: "brand_palette",
      layout: "single_focus",
      hasTextOverlay: false,
      hasCta: true,
      language: "ja",
    } satisfies CreativeGenes;
    const result = await persistCreativeAssets({
      storage: store,
      accountKey: "acme",
      creativeId: "creative_meta_001",
      generation,
      qa,
      genes,
      links: {
        aiRunId: "airun_image_001",
        imagePromptAiRunId: "airun_image_001",
        creativeQaAiRunId: "airun_qa_001",
        improvementRunId: "improve_001",
        pullRequestNumber: 42,
      },
      metadataCreatedAt: "2026-05-02T12:00:00.000Z",
    });

    const metadataAbs = path.join(store.root, result.metadata.storageKey);
    const raw = await fs.readFile(metadataAbs, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.creativeId, "creative_meta_001");
    assert.equal(parsed.accountKey, "acme");
    assert.equal(parsed.storageRef, "storage://creatives/acme/creative_meta_001");
    assert.equal(parsed.createdAt, "2026-05-02T12:00:00.000Z");
    assert.equal(parsed.provider, "mock");
    assert.equal(parsed.model, "placeholder-1080");
    assert.equal(parsed.prompt, generation.meta.prompt);
    assert.equal(parsed.generatedAt, generation.meta.generatedAt);
    assert.equal(parsed.requestId, generation.meta.requestId);
    assert.equal(parsed.variantCount, 2);

    const params = parsed.parameters as Record<string, unknown>;
    assert.equal(params.purpose, "agent:image_prompt");
    const conds = params.variationConditions as Array<Record<string, unknown>>;
    assert.equal(conds.length, 2);
    assert.equal(conds[0]!.variantKey, "feed_square");
    assert.equal(conds[1]!.variantKey, "feed_landscape");

    const assets = parsed.assets as Array<Record<string, unknown>>;
    assert.equal(assets.length, 2);
    for (const a of assets) {
      assert.match(String(a.assetId), /^asset_[0-9a-f]{12}$/);
      assert.equal(a.mimeType, "image/png");
      assert.equal(a.qaOverall, "qa_passed");
      assert.equal(
        a.storageRef,
        `storage://creatives/acme/creative_meta_001/${a.filename}`
      );
    }

    const qaDoc = parsed.qa as Record<string, unknown>;
    assert.equal(qaDoc.overall, "qa_passed");
    assert.equal(qaDoc.passingCount, 2);
    assert.equal(qaDoc.failingCount, 0);
    const qaAssets = qaDoc.assets as Array<Record<string, unknown>>;
    assert.equal(qaAssets.length, 2);
    const checks = qaAssets[0]!.checks as Array<Record<string, unknown>>;
    const checkKinds = checks.map((c) => c.kind).sort();
    assert.deepEqual(checkKinds, [
      "brand_tone",
      "dimensions",
      "forbidden_expression",
      "format",
      "quality",
    ]);
    assert.deepEqual(parsed.genes, genes);

    const links = parsed.links as Record<string, unknown>;
    assert.equal(links.aiRunId, "airun_image_001");
    assert.equal(links.imagePromptAiRunId, "airun_image_001");
    assert.equal(links.creativeQaAiRunId, "airun_qa_001");
    assert.equal(links.improvementRunId, "improve_001");
    assert.equal(links.pullRequestNumber, 42);
  } finally {
    await cleanup();
  }
});

// regression fix: per-asset QA は必須化された (UI design plan principle 25;
// the current implementation acceptance "Creative QA checks ... before PR attachment")。
// 「QA 未実施で persistCreativeAssets を呼ぶ」「QA バッチが部分的しかない」
// 「QA が空のまま PR 番号で linkage を試みる」のいずれも storage に何も書かず
// に CreativeStorageQaIncompleteError で reject される契約をここで固定する。

test("persistCreativeAssets rejects when qa is missing (no asset bytes are written)", async () => {
  const { store, cleanup } = await makeDiskStorage();
  try {
    const generation = await fixtureGeneration();
    let written = 0;
    const observingStore: CreativeStorageAdapter = {
      async write(key, data) {
        written += 1;
        return store.write(key, data);
      },
    };
    await assert.rejects(
      () =>
        persistCreativeAssets({
          storage: observingStore,
          accountKey: "acme",
          creativeId: "creative_no_qa",
          generation,
        }),
      (err) =>
        err instanceof CreativeStorageQaIncompleteError &&
        err.reason === "qa_missing"
    );
    assert.equal(written, 0, "must not write any bytes when QA is missing");
  } finally {
    await cleanup();
  }
});

test("persistCreativeAssets rejects when qa does not cover every generated asset", async () => {
  const { store, cleanup } = await makeDiskStorage();
  try {
    const generation = await fixtureGeneration();
    // QA only for the 1080x1080 variant; the 1200x628 variant is missing.
    const partial = evaluateCreativeQaBatch(
      generation.assets.slice(0, 1).map((a) => ({ asset: a })),
      {
        dimensions: {
          allowed: [{ width: 1080, height: 1080 }],
        },
      }
    );
    let written = 0;
    const observingStore: CreativeStorageAdapter = {
      async write(key, data) {
        written += 1;
        return store.write(key, data);
      },
    };
    await assert.rejects(
      () =>
        persistCreativeAssets({
          storage: observingStore,
          accountKey: "acme",
          creativeId: "creative_partial_qa",
          generation,
          qa: partial,
        }),
      (err) =>
        err instanceof CreativeStorageQaIncompleteError &&
        err.reason === "qa_assets_missing" &&
        err.missingVariantKeys.length === 1 &&
        err.missingVariantKeys[0] === "feed_landscape"
    );
    assert.equal(
      written,
      0,
      "must not write any bytes when QA is incomplete"
    );
  } finally {
    await cleanup();
  }
});

test("persistCreativeAssets rejects pullRequestNumber linkage when qa is missing", async () => {
  const { store, cleanup } = await makeDiskStorage();
  try {
    const generation = await fixtureGeneration();
    let written = 0;
    const observingStore: CreativeStorageAdapter = {
      async write(key, data) {
        written += 1;
        return store.write(key, data);
      },
    };
    await assert.rejects(
      () =>
        persistCreativeAssets({
          storage: observingStore,
          accountKey: "acme",
          creativeId: "creative_pr_no_qa",
          generation,
          links: { pullRequestNumber: 99 },
        }),
      (err) =>
        err instanceof CreativeStorageQaIncompleteError &&
        err.reason === "pr_link_without_qa"
    );
    assert.equal(written, 0);
  } finally {
    await cleanup();
  }
});

test("persistCreativeAssets rejects pullRequestNumber linkage when qa is incomplete", async () => {
  const { store, cleanup } = await makeDiskStorage();
  try {
    const generation = await fixtureGeneration();
    const partial = evaluateCreativeQaBatch(
      generation.assets.slice(0, 1).map((a) => ({ asset: a })),
      { dimensions: { allowed: [{ width: 1080, height: 1080 }] } }
    );
    let written = 0;
    const observingStore: CreativeStorageAdapter = {
      async write(key, data) {
        written += 1;
        return store.write(key, data);
      },
    };
    await assert.rejects(
      () =>
        persistCreativeAssets({
          storage: observingStore,
          accountKey: "acme",
          creativeId: "creative_pr_partial_qa",
          generation,
          qa: partial,
          links: { pullRequestNumber: 100 },
        }),
      (err) =>
        err instanceof CreativeStorageQaIncompleteError &&
        err.reason === "pr_link_without_qa"
    );
    assert.equal(written, 0);
  } finally {
    await cleanup();
  }
});

// regression fix: PR-linkage には「全 asset が 5 種の QA check kind を持つ」
// (the current implementation acceptance "Creative QA checks dimensions, format, quality,
// forbidden expressions, and brand-tone constraints before PR attachment") と、
// 「どの asset も qa_failed でない」を **storage 書き込み前に** 強制する。
// metadata.links.pullRequestNumber は本ゲートを通った後でしか焼かれない。

test("persistCreativeAssets rejects PR linkage when any asset is qa_failed (no bytes are written)", async () => {
  const { store, cleanup } = await makeDiskStorage();
  try {
    const generation = await fixtureGeneration();
    // dimensions allowlist に存在しないサイズだけを許容することで、両 variant
    // を blocking dimensions fail にする。aggregator は qa_failed を返す。
    const failingQa = evaluateCreativeQaBatch(
      generation.assets.map((a) => ({ asset: a })),
      { dimensions: { allowed: [{ width: 1, height: 1 }] } }
    );
    for (const a of failingQa.assets) {
      assert.equal(
        a.overall,
        "qa_failed",
        "fixture precondition: variants must aggregate to qa_failed for this gate test"
      );
    }
    let written = 0;
    const observingStore: CreativeStorageAdapter = {
      async write(key, data) {
        written += 1;
        return store.write(key, data);
      },
    };
    await assert.rejects(
      () =>
        persistCreativeAssets({
          storage: observingStore,
          accountKey: "acme",
          creativeId: "creative_pr_qa_failed",
          generation,
          qa: failingQa,
          links: { pullRequestNumber: 101 },
        }),
      (err) =>
        err instanceof CreativeStorageQaIncompleteError &&
        err.reason === "pr_link_with_qa_failed" &&
        err.missingVariantKeys.length === generation.assets.length
    );
    assert.equal(
      written,
      0,
      "must not write any bytes when PR linkage is rejected for qa_failed assets"
    );
  } finally {
    await cleanup();
  }
});

test("persistCreativeAssets rejects PR linkage when any asset is missing one of the 5 QA check kinds", async () => {
  const { store, cleanup } = await makeDiskStorage();
  try {
    const generation = await fixtureGeneration();
    // 正規 batch を組み立てたあと、最後の asset だけ check kinds を 4 種に削る
    // (forbidden_expression を欠落させる)。overall は触らないことで、
    // 「qa_failed ではないが check kind が不足している」状態を再現する。
    const qa = passingQaForFixture(generation);
    const tampered = {
      ...qa,
      assets: qa.assets.map((a, i) =>
        i === qa.assets.length - 1
          ? {
              ...a,
              checks: a.checks.filter((c) => c.kind !== "forbidden_expression"),
            }
          : a
      ),
    };
    let written = 0;
    const observingStore: CreativeStorageAdapter = {
      async write(key, data) {
        written += 1;
        return store.write(key, data);
      },
    };
    await assert.rejects(
      () =>
        persistCreativeAssets({
          storage: observingStore,
          accountKey: "acme",
          creativeId: "creative_pr_incomplete_checks",
          generation,
          qa: tampered,
          links: { pullRequestNumber: 102 },
        }),
      (err) =>
        err instanceof CreativeStorageQaIncompleteError &&
        err.reason === "pr_link_with_incomplete_check_kinds" &&
        err.missingVariantKeys.length === 1 &&
        err.missingVariantKeys[0] === generation.assets.at(-1)!.variantKey
    );
    assert.equal(
      written,
      0,
      "must not write any bytes when PR linkage is rejected for incomplete check kinds"
    );
  } finally {
    await cleanup();
  }
});

test("persistCreativeAssets allows PR linkage only when every asset has all 5 check kinds and none is qa_failed", async () => {
  const { store, cleanup } = await makeDiskStorage();
  try {
    const generation = await fixtureGeneration();
    const qa = passingQaForFixture(generation);
    for (const a of qa.assets) {
      assert.notEqual(a.overall, "qa_failed");
      const kinds = new Set(a.checks.map((c) => c.kind));
      assert.equal(kinds.size, 5, "fixture must produce all 5 check kinds");
    }
    const result = await persistCreativeAssets({
      storage: store,
      accountKey: "acme",
      creativeId: "creative_pr_link_ok",
      generation,
      qa,
      links: { pullRequestNumber: 103 },
      metadataCreatedAt: "2026-05-02T00:00:00.000Z",
    });
    const raw = await fs.readFile(
      path.join(store.root, result.metadata.storageKey),
      "utf8"
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const links = parsed.links as Record<string, unknown>;
    assert.equal(
      links.pullRequestNumber,
      103,
      "pullRequestNumber is allowed in metadata only after the PR-linkage gate passes"
    );
  } finally {
    await cleanup();
  }
});

test("persistCreativeAssets always returns non-null qaOverall on every persisted asset", async () => {
  const { store, cleanup } = await makeDiskStorage();
  try {
    const generation = await fixtureGeneration();
    const qa = passingQaForFixture(generation);
    const result = await persistCreativeAssets({
      storage: store,
      accountKey: "acme",
      creativeId: "creative_qa_required",
      generation,
      qa,
    });
    for (const asset of result.assets) {
      assert.notEqual(
        asset.qaOverall,
        null,
        "qaOverall must be a confirmed outcome when QA is required upstream"
      );
      assert.ok(
        asset.qaOverall === "qa_passed" ||
          asset.qaOverall === "qa_warned" ||
          asset.qaOverall === "qa_failed",
        `qaOverall must be one of the audited outcomes (got: ${String(asset.qaOverall)})`
      );
    }
    // metadata.json も per-asset の qaOverall を non-null で書く。
    const raw = await fs.readFile(
      path.join(store.root, result.metadata.storageKey),
      "utf8"
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const assets = parsed.assets as Array<Record<string, unknown>>;
    for (const a of assets) {
      assert.notEqual(a.qaOverall, null);
    }
    assert.notEqual(parsed.qa, null);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Determinism — same (creativeId, variantKey) ⇒ same asset_id ⇒ idempotent
// ---------------------------------------------------------------------------

test("persistCreativeAssets is idempotent for the same (creativeId, variantKey) pair", async () => {
  const { store, cleanup } = await makeDiskStorage();
  try {
    const gen1 = await fixtureGeneration();
    const r1 = await persistCreativeAssets({
      storage: store,
      accountKey: "acme",
      creativeId: "creative_idem",
      generation: gen1,
      qa: passingQaForFixture(gen1),
      metadataCreatedAt: "2026-05-02T00:00:00.000Z",
    });
    const gen2 = await fixtureGeneration();
    const r2 = await persistCreativeAssets({
      storage: store,
      accountKey: "acme",
      creativeId: "creative_idem",
      generation: gen2,
      qa: passingQaForFixture(gen2),
      metadataCreatedAt: "2026-05-02T00:00:00.000Z",
    });
    assert.deepEqual(
      r1.assets.map((a) => a.assetId),
      r2.assets.map((a) => a.assetId)
    );
    assert.deepEqual(
      r1.assets.map((a) => a.storageRef),
      r2.assets.map((a) => a.storageRef)
    );
  } finally {
    await cleanup();
  }
});

test("derived asset_id differs across creativeIds even for the same variantKey", async () => {
  const { store, cleanup } = await makeDiskStorage();
  try {
    const gen = await fixtureGeneration();
    const qa = passingQaForFixture(gen);
    const a = await persistCreativeAssets({
      storage: store,
      accountKey: "acme",
      creativeId: "creative_alpha",
      generation: gen,
      qa,
    });
    const b = await persistCreativeAssets({
      storage: store,
      accountKey: "acme",
      creativeId: "creative_beta",
      generation: gen,
      qa,
    });
    const aIds = a.assets.map((x) => x.assetId);
    const bIds = b.assets.map((x) => x.assetId);
    for (let i = 0; i < aIds.length; i += 1) {
      assert.notEqual(aIds[i], bIds[i], `asset_id collided for variant ${i}`);
    }
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// JPEG mapping
// ---------------------------------------------------------------------------

test("persistCreativeAssets uses .jpg extension for image/jpeg assets", async () => {
  const { store, cleanup } = await makeDiskStorage();
  try {
    const fakeJpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const fakeAsset: ImageGeneratedAsset = {
      variantKey: "v_jpg",
      bytes: fakeJpegBytes,
      mimeType: "image/jpeg",
      width: 1200,
      height: 628,
      byteSize: fakeJpegBytes.byteLength,
    };
    const gen: ImageGenerateResult = {
      assets: [fakeAsset],
      meta: {
        provider: "mock",
        model: "placeholder-1200x628",
        requestId: "test-jpeg",
        generatedAt: "2026-05-02T00:00:00.000Z",
        prompt: "jpeg variant",
        parameters: {
          variationConditions: [
            { width: 1200, height: 628, format: "jpeg", variantKey: "v_jpg" },
          ],
          purpose: null,
          variantCount: 1,
        },
        qaResult: null,
      },
      costUsd: 0,
    };
    const result = await persistCreativeAssets({
      storage: store,
      accountKey: "acme",
      creativeId: "creative_jpg",
      generation: gen,
      qa: evaluateCreativeQaBatch(
        gen.assets.map((a) => ({ asset: a })),
        {
          dimensions: { allowed: [{ width: 1200, height: 628 }] },
          format: { allowedMimeTypes: ["image/png", "image/jpeg"] },
        }
      ),
    });
    assert.equal(result.assets[0]!.filename.endsWith(".jpg"), true);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Path traversal / id validation
// ---------------------------------------------------------------------------

test("persistCreativeAssets rejects path-traversal accountKey", async () => {
  const { store, cleanup } = await makeDiskStorage();
  try {
    const generation = await fixtureGeneration();
    await assert.rejects(
      () =>
        persistCreativeAssets({
          storage: store,
          accountKey: "../etc",
          creativeId: "creative_abc",
          generation,
        }),
      (err) =>
        err instanceof CreativeStorageInvalidIdError && err.field === "accountKey"
    );
  } finally {
    await cleanup();
  }
});

test("persistCreativeAssets rejects path-traversal creativeId", async () => {
  const { store, cleanup } = await makeDiskStorage();
  try {
    const generation = await fixtureGeneration();
    await assert.rejects(
      () =>
        persistCreativeAssets({
          storage: store,
          accountKey: "acme",
          creativeId: "../escape",
          generation,
        }),
      (err) =>
        err instanceof CreativeStorageInvalidIdError && err.field === "creativeId"
    );
  } finally {
    await cleanup();
  }
});

test("persistCreativeAssets rejects empty accountKey / creativeId", async () => {
  const { store, cleanup } = await makeDiskStorage();
  try {
    const generation = await fixtureGeneration();
    await assert.rejects(
      () =>
        persistCreativeAssets({
          storage: store,
          accountKey: "",
          creativeId: "creative_x",
          generation,
        }),
      CreativeStorageInvalidIdError
    );
    await assert.rejects(
      () =>
        persistCreativeAssets({
          storage: store,
          accountKey: "acme",
          creativeId: "",
          generation,
        }),
      CreativeStorageInvalidIdError
    );
  } finally {
    await cleanup();
  }
});

test("persistCreativeAssets rejects variantKey that is not path-safe", async () => {
  const { store, cleanup } = await makeDiskStorage();
  try {
    const fakeBytes = Uint8Array.from([...PNG_SIG, 0, 0, 0, 0]);
    const gen: ImageGenerateResult = {
      assets: [
        {
          variantKey: "../../../etc/passwd",
          bytes: fakeBytes,
          mimeType: "image/png",
          width: 1080,
          height: 1080,
          byteSize: fakeBytes.byteLength,
        },
      ],
      meta: {
        provider: "mock",
        model: "placeholder-1080",
        requestId: "test-traversal",
        generatedAt: "2026-05-02T00:00:00.000Z",
        prompt: "x",
        parameters: {
          variationConditions: [
            { width: 1080, height: 1080, variantKey: "../../../etc/passwd" },
          ],
          purpose: null,
          variantCount: 1,
        },
        qaResult: null,
      },
      costUsd: 0,
    };
    // regression fix: persistCreativeAssets requires per-asset QA. Build a QA
    // batch keyed by the same (deliberately-unsafe) variantKey so the
    // QA-completeness gate is satisfied and the test still exercises the
    // variantKey traversal-rejection path that lives inside the asset loop.
    const qa = evaluateCreativeQaBatch(
      gen.assets.map((a) => ({ asset: a })),
      { dimensions: { allowed: [{ width: 1080, height: 1080 }] } }
    );
    await assert.rejects(
      () =>
        persistCreativeAssets({
          storage: store,
          accountKey: "acme",
          creativeId: "creative_x",
          generation: gen,
          qa,
        }),
      (err) =>
        err instanceof CreativeStorageInvalidIdError && err.field === "variantKey"
    );
  } finally {
    await cleanup();
  }
});
