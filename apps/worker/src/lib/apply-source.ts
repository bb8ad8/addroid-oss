// AdDroid OSS — execute_apply 用の operation manifest loader (apps/worker side).
//
// the current implementation 受入の "Apply a valid YAML change as PAUSED resources or a mocked
// equivalent in local tests" を満たすために、以下 2 つの動作モードを持つ:
//
//   - real: `ADDROID_OPS_REPO_LOCAL_DIR` が指すローカル checkout を使う。
//     承認済み PR の merge commit と、その first parent の差分だけを `next` /
//     `previous` として読み込む。Apply は PR 単位で独立し、過去/後続 PR の
//     operation manifest 差分を別PRの承認で巻き込まない。
//   - mocked: env が未設定の場合は `accounts: []` を返し、orchestrator 側で
//     `simulated` 状態に倒す。the current implementation の "mocked equivalent in local tests"
//     経路をこれで吸収する (UI/audit には source=unavailable を表示する)。
//
// regression fix: real モードでは `loadForApply` 呼び出し時に
// `AdsLoaderInput.context` の `headSha` / `repoId` を必ず検証する。
//   - 承認済み merge commit / parent commit / changed operations/*.json を解決できない、または
//   - 起動時に解決した workspace の opsRepoId が `context.repoId` と一致しない、
// 場合は fail-closed (source=unavailable) で返し、Meta mutation 経路に到達させない。
// これにより「承認済み PR の差分だけが Apply に流れる」契約 (gitops-only
// approved PR diff) を loader 境界でも保証する。
//
// 本ファイルは Prisma を import せず、ファイルシステム + git の HEAD 取得のみを
// 触る純粋境界。git 取得は execFile (引数固定, no shell) を使う。

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ApplyAction,
  AdsLoader,
  AdsLoaderInput,
  AdsLoadResult,
  GraphOperationAction,
  MetaCliOperationAction,
} from "@addroid/queue";
import { assertManagedStorageKey } from "./storage-key-validation.js";

const execFileAsync = promisify(execFile);

/** 40-char hex SHA1 (git のコミットハッシュ) を判定する。 */
function isFullSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

/**
 * `git -C <dir> rev-parse HEAD` を呼び、現在の HEAD コミットの 40-char hex を
 * 返す。git が無い / .git が無い / 何らかの失敗時は null を返す (fail-closed)。
 */
async function readGitHeadSha(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", dir, "rev-parse", "HEAD"],
      { timeout: 5_000, maxBuffer: 256 * 1024 },
    );
    const sha = stdout.trim().toLowerCase();
    return isFullSha(sha) ? sha : null;
  } catch {
    return null;
  }
}

async function gitCommitExists(dir: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["-C", dir, "cat-file", "-e", `${sha}^{commit}`],
      {
        timeout: 5_000,
        maxBuffer: 256 * 1024,
      },
    );
    return true;
  } catch {
    return false;
  }
}

async function readGitFirstParentSha(
  dir: string,
  sha: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", dir, "rev-parse", `${sha}^`],
      {
        timeout: 5_000,
        maxBuffer: 256 * 1024,
      },
    );
    const parent = stdout.trim().toLowerCase();
    return isFullSha(parent) ? parent : null;
  } catch {
    return null;
  }
}

async function readGitChangedFiles(
  dir: string,
  baseSha: string,
  headSha: string,
): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", dir, "diff", "--name-only", `${baseSha}..${headSha}`],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function changedOperationFiles(files: readonly string[]): string[] {
  return files
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => /^operations\/.+\.json$/.test(file));
}

async function materializeGitCommit(
  dir: string,
  sha: string,
): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const worktreeDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "addroid-apply-worktree-"),
  );
  let added = false;
  try {
    await execFileAsync(
      "git",
      ["-C", dir, "worktree", "add", "--detach", "--quiet", worktreeDir, sha],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    added = true;
    return {
      dir: worktreeDir,
      cleanup: async () => {
        if (added) {
          await execFileAsync(
            "git",
            ["-C", dir, "worktree", "remove", "--force", worktreeDir],
            { timeout: 30_000, maxBuffer: 1024 * 1024 },
          ).catch(() => undefined);
        }
        await fsp
          .rm(worktreeDir, { recursive: true, force: true })
          .catch(() => undefined);
      },
    };
  } catch (err) {
    await fsp
      .rm(worktreeDir, { recursive: true, force: true })
      .catch(() => undefined);
    throw err;
  }
}

export interface LocalDirAdsLoaderOptions {
  /** ops repo の checkout 絶対パス。null/未指定なら "no source" を返す。 */
  localDir: string | null;
  /**
   * このワーカーが管理する ops repo の `github_repos.id` (UUID)。
   * `loadForApply` は `AdsLoaderInput.context.repoId` がこの値と一致した
   * 場合だけ load を許可する。null/未指定なら repoId 検証はスキップせず
   * fail-closed する (= 別 ops repo の PR を localDir 経由で apply しない)。
   */
  expectedRepoId?: string | null;
  /**
   * テスト用の HEAD SHA リゾルバ差し替え点。本番では `git rev-parse HEAD` を
   * 呼び出すデフォルト実装を使う。
   */
  readHeadSha?: (dir: string) => Promise<string | null>;
  commitExists?: (dir: string, sha: string) => Promise<boolean>;
  readParentSha?: (dir: string, sha: string) => Promise<string | null>;
  readChangedFiles?: (
    dir: string,
    baseSha: string,
    headSha: string,
  ) => Promise<string[] | null>;
  materializeCommit?: (
    dir: string,
    sha: string,
  ) => Promise<{
    dir: string;
    cleanup: () => Promise<void>;
  }>;
}

export class LocalDirAdsLoader implements AdsLoader {
  private readonly localDir: string | null;
  private readonly expectedRepoId: string | null;
  private readonly readHeadSha: (dir: string) => Promise<string | null>;
  private readonly commitExists: (dir: string, sha: string) => Promise<boolean>;
  private readonly readParentSha: (
    dir: string,
    sha: string,
  ) => Promise<string | null>;
  private readonly readChangedFiles: (
    dir: string,
    baseSha: string,
    headSha: string,
  ) => Promise<string[] | null>;
  private readonly materializeCommit: (
    dir: string,
    sha: string,
  ) => Promise<{ dir: string; cleanup: () => Promise<void> }>;

  constructor(opts: LocalDirAdsLoaderOptions) {
    this.localDir = opts.localDir;
    this.expectedRepoId = opts.expectedRepoId ?? null;
    this.readHeadSha = opts.readHeadSha ?? readGitHeadSha;
    this.commitExists = opts.commitExists ?? gitCommitExists;
    this.readParentSha = opts.readParentSha ?? readGitFirstParentSha;
    this.readChangedFiles = opts.readChangedFiles ?? readGitChangedFiles;
    this.materializeCommit = opts.materializeCommit ?? materializeGitCommit;
  }

  async loadForApply(input: AdsLoaderInput): Promise<AdsLoadResult> {
    const { context } = input;
    if (!this.localDir || !fs.existsSync(this.localDir)) {
      return {
        source: "unavailable",
        detail:
          "ADDROID_OPS_REPO_LOCAL_DIR is not set (or path does not exist); falling back to simulated apply.",
        accounts: [],
      };
    }
    // 1) repoId guard: workspace に登録された ops repo と PR の repoId が
    //    一致しなければ "他リポジトリの状態を localDir 経由で適用してしまう"
    //    リスクを fail-closed で遮断する。
    if (!this.expectedRepoId) {
      return {
        source: "unavailable",
        detail:
          "ops repo id is not configured for the worker; refusing to apply local checkout without repo identity verification.",
        accounts: [],
      };
    }
    if (context.repoId !== this.expectedRepoId) {
      return {
        source: "unavailable",
        detail: `apply_job pr#${context.prNumber} targets repoId=${context.repoId}, but local checkout is bound to repoId=${this.expectedRepoId}; refusing to apply foreign repo state.`,
        accounts: [],
      };
    }
    // 2) mergeSha guard: approved PR が base branch に入った merge/squash/rebase
    //    commit と、その first parent の差分だけを load する。
    //    headSha は承認対象IDとして検証し、実際の next/previous は mergeSha 境界で読む。
    if (!isFullSha(context.headSha)) {
      return {
        source: "unavailable",
        detail: `apply_job pr#${context.prNumber} headSha is not a 40-char SHA (${context.headSha}); refusing to apply.`,
        accounts: [],
      };
    }
    const mergeSha = context.mergeSha?.toLowerCase() ?? null;
    if (!mergeSha || !isFullSha(mergeSha)) {
      return {
        source: "unavailable",
        detail: `apply_job pr#${context.prNumber} has no verified mergeSha; refusing to apply without the exact merged PR boundary.`,
        accounts: [],
      };
    }
    const head = await this.readHeadSha(this.localDir);
    if (!head) {
      return {
        source: "unavailable",
        detail: `cannot resolve git HEAD at ${this.localDir} (not a git checkout, or git unavailable); refusing to apply unverified ops repo state.`,
        accounts: [],
      };
    }
    const parentSha = await this.readParentSha(this.localDir, mergeSha);
    if (!parentSha) {
      return {
        source: "unavailable",
        detail: `cannot resolve parent commit for approved PR merge ${mergeSha}; refusing to apply without a PR-specific base state.`,
        accounts: [],
      };
    }
    if (!(await this.commitExists(this.localDir, mergeSha))) {
      return {
        source: "unavailable",
        detail: `approved PR merge ${mergeSha} is not available locally; refusing to apply without the exact merged PR diff.`,
        accounts: [],
      };
    }
    if (!(await this.commitExists(this.localDir, parentSha))) {
      return {
        source: "unavailable",
        detail: `parent commit ${parentSha} for approved PR merge ${mergeSha} is not available locally; refusing to apply without the exact merged PR diff.`,
        accounts: [],
      };
    }
    const changedFiles = await this.readChangedFiles(
      this.localDir,
      parentSha,
      mergeSha,
    );
    if (!changedFiles) {
      return {
        source: "unavailable",
        detail: `cannot resolve changed files for approved PR merge ${mergeSha}; refusing to apply without the exact merged PR diff.`,
        accounts: [],
      };
    }
    const operationFiles = changedOperationFiles(changedFiles);
    if (operationFiles.length === 0) {
      return {
        source: "unavailable",
        detail: `approved PR #${context.prNumber} does not change operations/*.json; no Meta apply actions are allowed for this PR.`,
        accounts: [],
      };
    }
    let loadDir = this.localDir;
    let cleanup: (() => Promise<void>) | null = null;
    if (head !== mergeSha) {
      const materialized = await this.materializeCommit(
        this.localDir,
        mergeSha,
      );
      loadDir = materialized.dir;
      cleanup = materialized.cleanup;
    }
    try {
      const directActions = await loadOperationActions(loadDir, operationFiles);
      if (directActions.length === 0) {
        return {
          source: "unavailable",
          detail: `approved PR #${context.prNumber} changed operation files, but no executable actions were found.`,
          accounts: [],
        };
      }
      return {
        source: "local_dir",
        detail: `loaded ${directActions.reduce((sum, item) => sum + item.actions.length, 0)} operation action(s) from approved PR #${context.prNumber}`,
        accounts: [],
        directActions,
      };
    } finally {
      await cleanup?.();
    }
  }
}

async function loadOperationActions(
  rootDir: string,
  files: readonly string[],
): Promise<Array<{ accountKey: string; actions: ApplyAction[] }>> {
  const grouped = new Map<string, ApplyAction[]>();
  for (const file of files) {
    const abs = path.join(rootDir, file);
    const text = await fsp.readFile(abs, "utf8");
    const parsed = JSON.parse(text) as unknown;
    const actions = normalizeOperationManifest(parsed);
    for (const action of actions) {
      const current = grouped.get(action.account) ?? [];
      current.push(action);
      grouped.set(action.account, current);
    }
  }
  return [...grouped.entries()].map(([accountKey, actions]) => ({
    accountKey,
    actions,
  }));
}

function normalizeOperationManifest(value: unknown): ApplyAction[] {
  if (!isRecord(value)) throw new Error("operation manifest must be an object");
  const accountKey = readString(value.accountKey);
  if (!accountKey) throw new Error("operation manifest accountKey is required");
  const rawActions = Array.isArray(value.actions) ? value.actions : [];
  if (rawActions.length === 0)
    throw new Error("operation manifest actions[] is required");
  if (value.version === 2) {
    return rawActions.map((raw) =>
      normalizeGraphOperationAction(accountKey, raw),
    );
  }
  return rawActions.map((raw) => normalizeOperationAction(accountKey, raw));
}

const GRAPH_OPERATION_KINDS = new Set<GraphOperationAction["kind"]>([
  "campaign.create",
  "campaign.update",
  "campaign.delete",
  "campaign.status",
  "adset.create",
  "adset.update",
  "adset.delete",
  "adset.status",
  "creative.create",
  "creative.update",
  "creative.delete",
  "ad.create",
  "ad.update",
  "ad.delete",
  "ad.status",
]);

function normalizeGraphOperationAction(
  accountKey: string,
  raw: unknown,
): ApplyAction {
  if (!isRecord(raw)) throw new Error("operation action must be an object");
  const kind = readString(raw.kind) as GraphOperationAction["kind"] | null;
  if (!kind || !GRAPH_OPERATION_KINDS.has(kind)) {
    throw new Error(`unsupported graph operation kind: ${kind ?? "(missing)"}`);
  }
  const payload = normalizeGraphOperationPayload(kind, raw);
  const storageKey = readString(payload.storageKey);
  if (storageKey) assertManagedStorageKey(storageKey);
  assertManagedCarouselCards(payload);
  const ref = readString(raw.ref) ?? undefined;
  const dependsOn = Array.isArray(raw.dependsOn)
    ? raw.dependsOn.filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      )
    : undefined;
  const entity = isRecord(raw.entity)
    ? (raw.entity as GraphOperationAction["entity"])
    : deriveGraphEntity(kind, ref, payload);
  return {
    kind,
    account: accountKey,
    ...(ref ? { ref } : {}),
    ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
    payload,
    ...(entity ? { entity } : {}),
    ...(raw.externalIdRequired === true ? { externalIdRequired: true } : {}),
  };
}

function normalizeGraphOperationPayload(
  kind: GraphOperationAction["kind"],
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const payload = isRecord(raw.payload) ? { ...raw.payload } : {};
  if (kind !== "creative.create") return payload;
  const creative = isRecord(payload.creative)
    ? payload.creative
    : isRecord(raw.creative)
      ? raw.creative
      : null;
  if (!creative) return payload;
  const type = readString(creative.type)?.toLowerCase();
  if (type !== "carousel") return payload;
  const cards = Array.isArray(creative.cards)
    ? creative.cards.map((card, index) => normalizeCarouselCard(card, index))
    : [];
  return {
    ...payload,
    mediaType: "carousel",
    type: "carousel",
    linkUrl:
      readString(creative.link_url) ??
      readString(creative.linkUrl) ??
      readString(payload.linkUrl) ??
      undefined,
    body:
      readString(creative.message) ??
      readString(payload.body) ??
      readString(payload.primaryText) ??
      undefined,
    primaryText:
      readString(creative.message) ??
      readString(payload.primaryText) ??
      readString(payload.body) ??
      undefined,
    cards,
  };
}

function normalizeCarouselCard(
  card: unknown,
  index: number,
): Record<string, unknown> {
  if (!isRecord(card))
    throw new Error(`carousel card ${index + 1} must be an object`);
  const storageRef =
    readString(card.storage_ref) ?? readString(card.storageRef);
  const storageKey =
    readString(card.storage_key) ??
    readString(card.storageKey) ??
    storageKeyFromStorageRef(storageRef);
  if (!storageKey)
    throw new Error(
      `carousel card ${index + 1} requires storage_ref or storageKey`,
    );
  assertManagedStorageKey(storageKey, `carousel card ${index + 1} storage_ref`);
  return {
    position: typeof card.position === "number" ? card.position : index + 1,
    storageKey,
    ...(storageRef ? { storageRef } : {}),
    headline: readString(card.headline) ?? "",
    ...(readString(card.description)
      ? { description: readString(card.description) }
      : {}),
    ...((readString(card.link_url) ?? readString(card.linkUrl))
      ? { linkUrl: readString(card.link_url) ?? readString(card.linkUrl) }
      : {}),
  };
}

function storageKeyFromStorageRef(value: string | null): string | null {
  if (!value) return null;
  const prefix = "storage://";
  if (!value.startsWith(prefix)) return value;
  return readString(value.slice(prefix.length));
}

function assertManagedCarouselCards(payload: Record<string, unknown>): void {
  const cards = Array.isArray(payload.cards) ? payload.cards : [];
  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i];
    if (!isRecord(card))
      throw new Error(`carousel card ${i + 1} must be an object`);
    const storageKey =
      readString(card.storageKey) ??
      storageKeyFromStorageRef(readString(card.storageRef));
    if (!storageKey)
      throw new Error(
        `carousel card ${i + 1} requires storageKey or storageRef`,
      );
    assertManagedStorageKey(storageKey, `carousel card ${i + 1} storageKey`);
  }
}

function deriveGraphEntity(
  kind: GraphOperationAction["kind"],
  ref: string | undefined,
  payload: Record<string, unknown>,
): GraphOperationAction["entity"] | undefined {
  const [nodeType, verb] = kind.split(".") as [string, string];
  if (
    nodeType !== "campaign" &&
    nodeType !== "adset" &&
    nodeType !== "ad" &&
    nodeType !== "creative"
  ) {
    return undefined;
  }
  const nodeKey =
    readString(payload[`${nodeType}Id`]) ??
    readString(payload.id) ??
    (ref ? ref.split(":").slice(1).join(":") : null);
  if (!nodeKey) return undefined;
  return {
    nodeType,
    nodeKey,
    displayName: readString(payload.name) ?? undefined,
    ...(nodeType === "adset"
      ? {
          parentNodeType: "campaign",
          parentNodeKey:
            readString(payload.campaignRef) ??
            readString(payload.campaignId) ??
            undefined,
        }
      : {}),
    ...(nodeType === "ad"
      ? {
          parentNodeType: "adset",
          parentNodeKey:
            readString(payload.adsetRef) ??
            readString(payload.adsetId) ??
            undefined,
        }
      : {}),
    status: normalizeEntityStatus(readString(payload.status)),
  };
}

function normalizeEntityStatus(value: string | null): string | undefined {
  const v = value?.trim().toLowerCase();
  if (v === "active" || v === "paused" || v === "archived") return v;
  if (v === "deleted") return "archived";
  return undefined;
}

function normalizeOperationAction(
  accountKey: string,
  raw: unknown,
): ApplyAction {
  if (!isRecord(raw)) throw new Error("operation action must be an object");
  const resource = readString(raw.resource);
  const verb = readString(raw.verb);
  const args = Array.isArray(raw.args)
    ? raw.args.filter((v): v is string => typeof v === "string")
    : [];
  if (!resource || !verb || args.length === 0) {
    throw new Error("operation action requires resource, verb and args[]");
  }
  assertManagedStorageFlagValues(args);
  const entity = isRecord(raw.entity)
    ? (raw.entity as MetaCliOperationAction["entity"])
    : undefined;
  const typed = legacySubmissionActionFromOperation({
    accountKey,
    resource,
    verb,
    args,
    entity,
  });
  if (typed) return typed;
  return {
    kind: "meta_cli_operation",
    account: accountKey,
    resource,
    verb,
    args,
    ...(entity ? { entity } : {}),
    ...(raw.externalIdRequired === true ? { externalIdRequired: true } : {}),
  };
}

function legacySubmissionActionFromOperation(input: {
  accountKey: string;
  resource: string;
  verb: string;
  args: string[];
  entity?: MetaCliOperationAction["entity"];
}): ApplyAction | null {
  const resource = input.resource.trim().toLowerCase();
  const verb = input.verb.trim().toLowerCase();
  if (resource === "creatives" && verb === "create") {
    return creativeSubmissionActionFromArgs(
      input.accountKey,
      input.args,
      input.entity,
    );
  }
  if (resource === "ads" && verb === "create") {
    return adSubmissionActionFromArgs(
      input.accountKey,
      input.args,
      input.entity,
    );
  }
  return null;
}

function creativeSubmissionActionFromArgs(
  accountKey: string,
  args: readonly string[],
  entity?: MetaCliOperationAction["entity"],
): ApplyAction | null {
  if (!matchesPrefix(args, ["ads", "creative", "create"])) return null;
  const storageKey = flagValue(args, "--image");
  if (!storageKey) return null;
  assertManagedStorageKey(storageKey, "--image");
  const creativeId = readString(entity?.nodeKey) ?? flagValue(args, "--name");
  const pageId = flagValue(args, "--page-id");
  const linkUrl = flagValue(args, "--link-url");
  if (!creativeId || !pageId || !linkUrl) return null;
  return {
    kind: "create_creative",
    account: accountKey,
    creativeId,
    name: flagValue(args, "--name") ?? creativeId,
    mediaType: "image",
    pageId,
    storageKey,
    body: flagValue(args, "--body") ?? undefined,
    title: flagValue(args, "--title") ?? undefined,
    linkUrl,
    description: flagValue(args, "--description") ?? undefined,
    callToAction: cliEnum(flagValue(args, "--call-to-action")),
    instagramUserId: flagValue(args, "--instagram-actor-id") ?? undefined,
    instagramAppLink: flagValue(args, "--instagram-app-link") ?? undefined,
  };
}

function adSubmissionActionFromArgs(
  accountKey: string,
  args: readonly string[],
  entity?: MetaCliOperationAction["entity"],
): ApplyAction | null {
  if (!matchesPrefix(args, ["ads", "ad", "create"])) return null;
  const adsetId = readString(args[3]);
  if (!adsetId) return null;
  const adId = readString(entity?.nodeKey) ?? flagValue(args, "--name");
  const creativeRef = creativeRefValue(flagValue(args, "--creative-id"));
  if (!adId || !creativeRef) return null;
  return {
    kind: "create_ad",
    account: accountKey,
    adsetId,
    adId,
    name: flagValue(args, "--name") ?? adId,
    creativeRef,
    initialState: cliEnum(flagValue(args, "--status")),
  };
}

function matchesPrefix(
  args: readonly string[],
  prefix: readonly string[],
): boolean {
  return prefix.every((part, index) => args[index] === part);
}

function flagValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  return readString(args[index + 1]);
}

function flagValues(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === flag) {
      const value = readString(args[i + 1]);
      if (value) out.push(value);
    }
  }
  return out;
}

function assertManagedStorageFlagValues(args: readonly string[]): void {
  for (const flag of ["--image", "--video", "--images", "--videos"]) {
    for (const value of flagValues(args, flag)) {
      assertManagedStorageKey(value, flag);
    }
  }
}

function cliEnum(value: string | null): string | undefined {
  return value ? value.trim().toUpperCase().replace(/-/g, "_") : undefined;
}

function creativeRefValue(value: string | null): string | null {
  if (!value) return null;
  const match = /^\{\{creative:([^}]+)\}\}$/.exec(value);
  return readString(match?.[1]) ?? value;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * env から `ADDROID_OPS_REPO_LOCAL_DIR` を読み、
 * `LocalDirAdsLoader` を構築する。worker 起動時に 1 度だけ呼ぶ。
 *
 * `expectedRepoId` は呼び出し側 (runtime.ts) が Prisma から
 * `workspace.opsRepoId` を取得して渡す。Apply は承認済み PR からしか流れないため、
 * opsRepoId が未設定の workspace では apply_jobs 自体が積まれない。
 */
export function createLocalDirAdsLoaderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { expectedRepoId?: string | null; localDir?: string | null } = {},
): LocalDirAdsLoader {
  const local =
    opts.localDir ?? (env.ADDROID_OPS_REPO_LOCAL_DIR?.trim() || null);
  return new LocalDirAdsLoader({
    localDir: local,
    expectedRepoId: opts.expectedRepoId ?? null,
  });
}
