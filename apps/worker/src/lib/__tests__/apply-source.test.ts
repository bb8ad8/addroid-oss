// AdDroid OSS — apply-source LocalDirAdsLoader のユニットテスト (regression fix).
//
// loadForApply が AdsLoaderInput.context.headSha / context.repoId を実際に検証
// していること、approved PR の状態と一致しないときに fail-closed (source =
// unavailable, accounts: []) で返すことを確認する。git は呼ばず、`readHeadSha`
// を注入して制御する。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LocalDirAdsLoader } from "../apply-source.js";
import type { ApplyJobContext } from "@addroid/queue";

// ---- fixture helpers -------------------------------------------------

function writeFixture(files: Record<string, string>): {
  dir: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-apply-src-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const VALID_PROJECT = `version: 1
workspace:
  slug: default
  displayName: "Default Workspace"
`;
const VALID_CRON = `version: 1
schedules:
  - name: github_poll
    cron: "*/2 * * * *"
    enabled: true
`;
const VALID_OPERATION = `${JSON.stringify(
  {
    version: 1,
    accountKey: "primary",
    intent: "other",
    source: "test",
    actor: "test",
    rationale: null,
    createdAt: "2026-05-17T00:00:00.000Z",
    actions: [
      {
        resource: "campaign",
        verb: "update",
        args: ["ads", "campaign", "update", "120", "--status", "paused"],
      },
    ],
  },
  null,
  2,
)}\n`;
const CREATIVE_SUBMISSION_OPERATION = `${JSON.stringify(
  {
    version: 1,
    accountKey: "primary",
    intent: "other",
    source: "test",
    actor: "test",
    rationale: "submit generated creative",
    createdAt: "2026-05-20T00:00:00.000Z",
    actions: [
      {
        resource: "creatives",
        verb: "create",
        args: [
          "ads",
          "creative",
          "create",
          "--name",
          "Image variant 2 submission 9e73c01f",
          "--page-id",
          "281900655012835",
          "--image",
          "creative-submissions/primary/image-variant-2-submission-9e73c01f/asset.png",
          "--body",
          "body",
          "--title",
          "title",
          "--link-url",
          "http://instagram.com/shishasin2022kumamoto",
          "--description",
          "description",
          "--call-to-action",
          "view_instagram_profile",
          "--instagram-actor-id",
          "17841465387326763",
          "--instagram-app-link",
          "instagram://user?username=shishasin2022kumamoto&userid=65414107577",
        ],
        entity: {
          nodeType: "creative",
          nodeKey: "image-variant-2-submission-9e73c01f",
        },
        externalIdRequired: true,
      },
      {
        resource: "ads",
        verb: "create",
        args: [
          "ads",
          "ad",
          "create",
          "120228334025180756",
          "--name",
          "Image variant 2 ad submission 9e73c01f",
          "--creative-id",
          "{{creative:image-variant-2-submission-9e73c01f}}",
          "--status",
          "paused",
        ],
        entity: {
          nodeType: "ad",
          nodeKey: "image-variant-2-ad-submission-9e73c01f",
        },
        externalIdRequired: true,
      },
    ],
  },
  null,
  2,
)}\n`;

const CAROUSEL_SUBMISSION_OPERATION = `${JSON.stringify(
  {
    version: 2,
    accountKey: "primary",
    intent: "other",
    source: "test",
    actor: "test",
    rationale: "submit carousel creative",
    createdAt: "2026-06-13T00:00:00.000Z",
    actions: [
      {
        kind: "creative.create",
        ref: "creative:carousel-1",
        payload: {
          creativeId: "carousel-1",
          name: "Carousel 1",
          pageId: "281900655012835",
          creative: {
            type: "carousel",
            link_url: "https://example.com",
            message: "main message",
            cards: [
              {
                storage_ref:
                  "storage://creatives/primary/carousel-1/card-1.png",
                headline: "First card",
                description: "first",
                link_url: "https://example.com/1",
              },
              {
                storage_ref:
                  "storage://creatives/primary/carousel-1/card-2.png",
                headline: "Second card",
                description: "second",
              },
            ],
          },
        },
        entity: {
          nodeType: "creative",
          nodeKey: "carousel-1",
        },
        externalIdRequired: true,
      },
    ],
  },
  null,
  2,
)}\n`;

const HEAD_SHA = "deadbeefcafebabedeadbeefcafebabedeadbeef";
const MERGE_SHA = "2222222222222222222222222222222222222222";
const PARENT_SHA = "1111111111111111111111111111111111111111";
const REPO_ID = "repo-uuid-1";

function ctx(overrides: Partial<ApplyJobContext> = {}): ApplyJobContext {
  return {
    applyJobId: "apply-1",
    pullRequestId: "pr-row-1",
    prNumber: 42,
    headSha: HEAD_SHA,
    mergeSha: MERGE_SHA,
    htmlUrl: null,
    repoId: REPO_ID,
    ...overrides,
  };
}

function fixtureRepo(): { dir: string; cleanup: () => void } {
  return writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "operations/primary/status.json": VALID_OPERATION,
  });
}

function prDiffSeams(parentDir: string) {
  return {
    commitExists: async (_dir: string, sha: string) =>
      sha === MERGE_SHA || sha === PARENT_SHA,
    readParentSha: async (_dir: string, sha: string) =>
      sha === MERGE_SHA ? PARENT_SHA : null,
    readChangedFiles: async () => ["operations/primary/status.json"],
    materializeCommit: async (_dir: string, sha: string) => {
      assert.equal(sha, PARENT_SHA);
      return {
        dir: parentDir,
        cleanup: async () => undefined,
      };
    },
  };
}

// ---- happy path -----------------------------------------------------

test("loadForApply loads accounts when repoId and mergeSha both match", async () => {
  const current = fixtureRepo();
  const parent = fixtureRepo();
  try {
    const loader = new LocalDirAdsLoader({
      localDir: current.dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => MERGE_SHA,
      ...prDiffSeams(parent.dir),
    });
    const out = await loader.loadForApply({ context: ctx() });
    assert.equal(out.source, "local_dir");
    assert.equal(out.accounts.length, 0);
    assert.equal(out.directActions?.[0]?.accountKey, "primary");
    assert.equal(out.directActions?.[0]?.actions.length, 1);
  } finally {
    current.cleanup();
    parent.cleanup();
  }
});

// ---- mismatched headSha ---------------------------------------------

test("loadForApply fails closed when mergeSha is missing", async () => {
  const { dir, cleanup } = fixtureRepo();
  try {
    const loader = new LocalDirAdsLoader({
      localDir: dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => MERGE_SHA,
      ...prDiffSeams(dir),
    });
    const out = await loader.loadForApply({ context: ctx({ mergeSha: null }) });
    assert.equal(out.source, "unavailable");
    assert.equal(out.accounts.length, 0);
    assert.match(out.detail ?? "", /no verified mergeSha/);
  } finally {
    cleanup();
  }
});

test("loadForApply reads an approved PR merge from a materialized commit when main HEAD differs", async () => {
  const current = fixtureRepo();
  const merged = fixtureRepo();
  let cleanedMaterialized = false;
  try {
    const otherSha = "0000000000000000000000000000000000000000";
    const loader = new LocalDirAdsLoader({
      localDir: current.dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => otherSha,
      commitExists: async (_dir, sha) =>
        sha === MERGE_SHA || sha === PARENT_SHA,
      readParentSha: async (_dir, sha) =>
        sha === MERGE_SHA ? PARENT_SHA : null,
      readChangedFiles: async () => ["operations/primary/status.json"],
      materializeCommit: async (_dir, sha) => {
        assert.ok(sha === MERGE_SHA || sha === PARENT_SHA);
        return {
          dir: sha === MERGE_SHA ? merged.dir : current.dir,
          cleanup: async () => {
            cleanedMaterialized = true;
          },
        };
      },
    });
    const out = await loader.loadForApply({ context: ctx() });
    assert.equal(out.source, "local_dir");
    assert.equal(out.accounts.length, 0);
    assert.equal(out.directActions?.[0]?.accountKey, "primary");
    assert.equal(cleanedMaterialized, true);
    assert.match(out.detail ?? "", /loaded 1 operation action/);
  } finally {
    current.cleanup();
    merged.cleanup();
  }
});

test("loadForApply reads operations from the approved merge", async () => {
  const current = fixtureRepo();
  const merged = fixtureRepo();
  const parent = fixtureRepo();
  try {
    const loader = new LocalDirAdsLoader({
      localDir: current.dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => "0000000000000000000000000000000000000000",
      commitExists: async (_dir, sha) =>
        sha === MERGE_SHA || sha === PARENT_SHA,
      readParentSha: async (_dir, sha) =>
        sha === MERGE_SHA ? PARENT_SHA : null,
      readChangedFiles: async () => ["operations/primary/status.json"],
      materializeCommit: async (_dir, sha) => ({
        dir: sha === PARENT_SHA ? parent.dir : merged.dir,
        cleanup: async () => undefined,
      }),
    });
    const out = await loader.loadForApply({ context: ctx() });
    assert.equal(out.source, "local_dir");
    assert.equal(
      out.directActions?.[0]?.actions[0]?.kind,
      "meta_cli_operation",
    );
  } finally {
    current.cleanup();
    merged.cleanup();
    parent.cleanup();
  }
});

test("loadForApply adapts creative submission operation manifests to Graph apply actions", async () => {
  const current = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "operations/primary/creative.json": CREATIVE_SUBMISSION_OPERATION,
  });
  try {
    const loader = new LocalDirAdsLoader({
      localDir: current.dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => MERGE_SHA,
      commitExists: async (_dir, sha) =>
        sha === MERGE_SHA || sha === PARENT_SHA,
      readParentSha: async (_dir, sha) =>
        sha === MERGE_SHA ? PARENT_SHA : null,
      readChangedFiles: async () => ["operations/primary/creative.json"],
      materializeCommit: async () => ({
        dir: current.dir,
        cleanup: async () => undefined,
      }),
    });
    const out = await loader.loadForApply({ context: ctx() });
    const actions = out.directActions?.[0]?.actions ?? [];
    assert.equal(out.source, "local_dir");
    assert.equal(actions.length, 2);
    assert.equal(actions[0]?.kind, "create_creative");
    assert.equal(actions[1]?.kind, "create_ad");
    const creative = actions[0] as unknown as Record<string, unknown>;
    assert.equal(creative.creativeId, "image-variant-2-submission-9e73c01f");
    assert.equal(
      creative.storageKey,
      "creative-submissions/primary/image-variant-2-submission-9e73c01f/asset.png",
    );
    assert.equal(
      creative.linkUrl,
      "http://instagram.com/shishasin2022kumamoto",
    );
    assert.equal(creative.callToAction, "VIEW_INSTAGRAM_PROFILE");
    assert.equal(creative.instagramUserId, "17841465387326763");
    assert.equal(
      creative.instagramAppLink,
      "instagram://user?username=shishasin2022kumamoto&userid=65414107577",
    );
    const ad = actions[1] as unknown as Record<string, unknown>;
    assert.equal(ad.adsetId, "120228334025180756");
    assert.equal(ad.creativeRef, "image-variant-2-submission-9e73c01f");
    assert.equal(ad.initialState, "PAUSED");
  } finally {
    current.cleanup();
  }
});

test("loadForApply normalizes carousel creative operation manifests", async () => {
  const current = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "operations/primary/carousel.json": CAROUSEL_SUBMISSION_OPERATION,
  });
  try {
    const loader = new LocalDirAdsLoader({
      localDir: current.dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => MERGE_SHA,
      commitExists: async (_dir, sha) =>
        sha === MERGE_SHA || sha === PARENT_SHA,
      readParentSha: async (_dir, sha) =>
        sha === MERGE_SHA ? PARENT_SHA : null,
      readChangedFiles: async () => ["operations/primary/carousel.json"],
      materializeCommit: async () => ({
        dir: current.dir,
        cleanup: async () => undefined,
      }),
    });
    const out = await loader.loadForApply({ context: ctx() });
    const actions = out.directActions?.[0]?.actions ?? [];
    assert.equal(out.source, "local_dir");
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.kind, "creative.create");
    const payload = (actions[0] as { payload: Record<string, unknown> })
      .payload;
    assert.equal(payload.mediaType, "carousel");
    assert.equal(payload.linkUrl, "https://example.com");
    assert.equal(payload.primaryText, "main message");
    const cards = payload.cards as Array<Record<string, unknown>>;
    assert.equal(cards.length, 2);
    assert.equal(
      cards[0]?.storageKey,
      "creatives/primary/carousel-1/card-1.png",
    );
    assert.equal(cards[0]?.headline, "First card");
    assert.equal(cards[0]?.linkUrl, "https://example.com/1");
    assert.equal(
      cards[1]?.storageKey,
      "creatives/primary/carousel-1/card-2.png",
    );
  } finally {
    current.cleanup();
  }
});

test("loadForApply only returns operations whose files changed in the approved merge", async () => {
  const secondaryOperation = VALID_OPERATION.replace(
    '"accountKey": "primary"',
    '"accountKey": "secondary"',
  );
  const current = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "operations/primary/status.json": VALID_OPERATION,
    "operations/secondary/status.json": secondaryOperation,
  });
  const parent = writeFixture({
    ".addroid/project.yaml": VALID_PROJECT,
    "workflows/cron.yaml": VALID_CRON,
    "operations/primary/status.json": VALID_OPERATION,
    "operations/secondary/status.json": secondaryOperation,
  });
  try {
    const loader = new LocalDirAdsLoader({
      localDir: current.dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => MERGE_SHA,
      commitExists: async (_dir, sha) =>
        sha === MERGE_SHA || sha === PARENT_SHA,
      readParentSha: async (_dir, sha) =>
        sha === MERGE_SHA ? PARENT_SHA : null,
      readChangedFiles: async () => ["operations/primary/status.json"],
      materializeCommit: async () => ({
        dir: parent.dir,
        cleanup: async () => undefined,
      }),
    });
    const out = await loader.loadForApply({ context: ctx() });
    assert.equal(out.source, "local_dir");
    assert.deepEqual(
      out.directActions?.map((a) => a.accountKey),
      ["primary"],
    );
  } finally {
    current.cleanup();
    parent.cleanup();
  }
});

test("loadForApply returns unavailable when the approved merge has no operation manifest changes", async () => {
  const current = fixtureRepo();
  const parent = fixtureRepo();
  try {
    const loader = new LocalDirAdsLoader({
      localDir: current.dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => MERGE_SHA,
      commitExists: async (_dir, sha) =>
        sha === MERGE_SHA || sha === PARENT_SHA,
      readParentSha: async (_dir, sha) =>
        sha === MERGE_SHA ? PARENT_SHA : null,
      readChangedFiles: async () => ["README.md"],
      materializeCommit: async () => ({
        dir: parent.dir,
        cleanup: async () => undefined,
      }),
    });
    const out = await loader.loadForApply({ context: ctx() });
    assert.equal(out.source, "unavailable");
    assert.equal(out.accounts.length, 0);
    assert.match(out.detail ?? "", /does not change operations\/\*\.json/);
  } finally {
    current.cleanup();
    parent.cleanup();
  }
});

// ---- mismatched repoId ----------------------------------------------

test("loadForApply fails closed when context.repoId differs from configured ops repo", async () => {
  const { dir, cleanup } = fixtureRepo();
  try {
    const loader = new LocalDirAdsLoader({
      localDir: dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => MERGE_SHA,
      ...prDiffSeams(dir),
    });
    const out = await loader.loadForApply({
      context: ctx({ repoId: "some-other-repo" }),
    });
    assert.equal(out.source, "unavailable");
    assert.equal(out.accounts.length, 0);
    assert.match(out.detail ?? "", /foreign repo state/);
  } finally {
    cleanup();
  }
});

// ---- expectedRepoId not configured ----------------------------------

test("loadForApply fails closed when expectedRepoId is not configured but localDir is set", async () => {
  const { dir, cleanup } = fixtureRepo();
  try {
    const loader = new LocalDirAdsLoader({
      localDir: dir,
      expectedRepoId: null,
      readHeadSha: async () => MERGE_SHA,
      ...prDiffSeams(dir),
    });
    const out = await loader.loadForApply({ context: ctx() });
    assert.equal(out.source, "unavailable");
    assert.equal(out.accounts.length, 0);
    assert.match(out.detail ?? "", /ops repo id is not configured/);
  } finally {
    cleanup();
  }
});

// ---- localDir is not a git checkout ---------------------------------

test("loadForApply fails closed when git HEAD cannot be resolved", async () => {
  const { dir, cleanup } = fixtureRepo();
  try {
    const loader = new LocalDirAdsLoader({
      localDir: dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => null,
      ...prDiffSeams(dir),
    });
    const out = await loader.loadForApply({ context: ctx() });
    assert.equal(out.source, "unavailable");
    assert.equal(out.accounts.length, 0);
    assert.match(out.detail ?? "", /cannot resolve git HEAD/);
  } finally {
    cleanup();
  }
});

// ---- malformed headSha in context -----------------------------------

test("loadForApply fails closed when context.headSha is not a 40-char SHA", async () => {
  const { dir, cleanup } = fixtureRepo();
  try {
    const loader = new LocalDirAdsLoader({
      localDir: dir,
      expectedRepoId: REPO_ID,
      readHeadSha: async () => MERGE_SHA,
      ...prDiffSeams(dir),
    });
    const out = await loader.loadForApply({
      context: ctx({ headSha: "short" }),
    });
    assert.equal(out.source, "unavailable");
    assert.equal(out.accounts.length, 0);
    assert.match(out.detail ?? "", /not a 40-char SHA/);
  } finally {
    cleanup();
  }
});

// ---- localDir absent (mocked equivalent path) -----------------------

test("loadForApply returns unavailable (simulated path) when localDir is null", async () => {
  const loader = new LocalDirAdsLoader({
    localDir: null,
    expectedRepoId: REPO_ID,
    readHeadSha: async () => MERGE_SHA,
  });
  const out = await loader.loadForApply({ context: ctx() });
  assert.equal(out.source, "unavailable");
  assert.equal(out.accounts.length, 0);
  assert.match(out.detail ?? "", /ADDROID_OPS_REPO_LOCAL_DIR/);
});
