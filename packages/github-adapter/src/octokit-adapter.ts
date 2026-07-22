// AdDroid OSS — OctokitGithubAdapter (real implementation skeleton).
//
// 本 adapter は GitHub の REST API を叩く本番経路だが、テストや UI ローカル動作で
// network を伴わないように、Octokit/fetch を直接保持せず `GithubApiClient` を
// dependency injection する。`createDefaultGithubApiClient` が `@octokit/rest` を
// 用いた既定実装を返す。
//
// 取扱方針:
//   - access token は `OAuthTokenStore` から取り出した ciphertext を `CryptoBoundary`
//     で都度復号する。プロセスメモリにはメソッド呼び出しのスコープでのみ存在させる。
//   - ハードコードされた owner/org を使わない。`bootstrapOpsRepo` は OAuth 接続済み
//     アカウント (GET /user.login) を owner として使う。
//   - GitHub branch protection には依存しない。AdDroid の対話型承認レコードを
//     apply の承認境界にするため、private repo / GitHub Free でも運用できる。

import { buildOpsTemplate, type OpsTemplateFile } from "@addroid/ops-template";
import {
  ADDROID_REQUIRED_SCOPES,
  buildAuthorizationUrl,
  exchangeCodeForToken,
  type ExchangedToken,
  type OAuthClientConfig,
} from "./oauth.js";
import type { OAuthTokenStore } from "./token-store.js";
import {
  GithubAdapterNotImplementedError,
  GithubAdapterUnauthenticatedError,
  GithubMergeFailedError,
  GithubOAuthStateMismatchError,
  type BootstrapOpsRepoInput,
  type BootstrapOpsRepoResult,
  type CreatePullRequestFile,
  type CreatePullRequestInput,
  type CreatePullRequestResult,
  type GithubAdapter,
  type MergePullRequestInput,
  type MergePullRequestResult,
  type OAuthConnection,
  type OpsRepoSpec,
  type PullRequestPollResult,
  type PullRequestSummary,
} from "./types.js";

/**
 * Encryption boundary — `@addroid/config` の `CryptoBoundary` と structurally 互換。
 * 直接 import せず `getCryptoBoundary()` 由来の値を渡してもらうことで、
 * github-adapter から config への依存を増やさない。
 */
export interface CryptoEncryptDecrypt {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

/**
 * GitHub API への薄い境界。Octokit を直接持たず、tests では fake を差し込む。
 * 本ファイル下部の `createDefaultGithubApiClient` が `@octokit/rest` 実装を返す。
 */
export interface GithubApiClient {
  getAuthenticatedUserLogin(): Promise<string>;
  createUserRepo(input: {
    name: string;
    isPrivate: boolean;
    defaultBranch: string;
  }): Promise<{ owner: string; name: string; defaultBranch: string }>;
  /**
   * template ファイルを 1 commit にまとめて push する。実装は Git Data API
   * (blob → tree → commit → ref update) を用いる。
   */
  commitTemplateFiles(input: {
    owner: string;
    repo: string;
    branch: string;
    message: string;
    files: OpsTemplateFile[];
  }): Promise<{ commitSha: string; filesCommitted: number }>;
  listPullRequests(input: {
    owner: string;
    repo: string;
    etag?: string;
  }): Promise<{
    status: number;
    etag?: string;
    lastModified?: string;
    pullRequests: PullRequestSummary[];
  }>;
  /**
   * `improvement_pr` workflow が組み立てた diff を新規 branch に commit し、
   * `baseRef` に対して PR を開く。
   *
   * - branch が既に存在する場合は呼び出し側で衝突を回避してから渡す前提。
   * - delete 指定のファイルは tree から取り除く (Git Data API の semantics)。
   */
  createPullRequest(input: {
    owner: string;
    repo: string;
    branch: string;
    baseRef: string;
    title: string;
    body: string;
    files: CreatePullRequestFile[];
    commitMessage: string;
  }): Promise<{ number: number; htmlUrl: string; headSha: string }>;
  /**
   * Web UI からのマージで使う。GitHub merge API (PUT
   * /repos/{owner}/{repo}/pulls/{number}/merge) を 1 度だけ呼ぶ。
   * `expectedHeadSha` を渡すと GitHub 側で sha 一致確認が行われ、
   * mismatch は 409 で返る。
   */
  mergePullRequest(input: {
    owner: string;
    repo: string;
    number: number;
    expectedHeadSha?: string;
    mergeMethod?: "merge" | "squash" | "rebase";
    commitTitle?: string;
    commitMessage?: string;
  }): Promise<{ sha: string; merged: boolean; message: string }>;
}

export interface OctokitGithubAdapterDeps {
  oauthClient?: OAuthClientConfig | null;
  tokenStore: OAuthTokenStore;
  crypto: CryptoEncryptDecrypt;
  /** test seam: `accessToken` を渡すと当該トークンの API client を返す。 */
  apiClientFactory: (accessToken: string) => GithubApiClient;
  /** test seam: 既定は `oauth.ts` の `exchangeCodeForToken`。 */
  exchangeCode?: typeof exchangeCodeForToken;
  /** test seam: state を保存する場所 (in-memory)。プロセス内 single-flight 想定。 */
  stateStore?: { remember(state: string): void; consume(state: string): boolean };
}

class InMemoryStateStore {
  private states = new Set<string>();
  remember(state: string) {
    this.states.add(state);
  }
  consume(state: string): boolean {
    return this.states.delete(state);
  }
}

export class OctokitGithubAdapter implements GithubAdapter {
  private readonly oauthClient: OAuthClientConfig | null;
  private readonly tokenStore: OAuthTokenStore;
  private readonly crypto: CryptoEncryptDecrypt;
  private readonly apiClientFactory: (accessToken: string) => GithubApiClient;
  private readonly exchangeCode: typeof exchangeCodeForToken;
  private readonly stateStore: { remember(state: string): void; consume(state: string): boolean };

  constructor(deps: OctokitGithubAdapterDeps) {
    this.oauthClient = deps.oauthClient ?? null;
    this.tokenStore = deps.tokenStore;
    this.crypto = deps.crypto;
    this.apiClientFactory = deps.apiClientFactory;
    this.exchangeCode = deps.exchangeCode ?? exchangeCodeForToken;
    this.stateStore = deps.stateStore ?? new InMemoryStateStore();
  }

  async beginOAuth(): Promise<{ authorizationUrl: string; state: string }> {
    if (!this.oauthClient) {
      throw new GithubAdapterNotImplementedError("beginOAuth");
    }
    const built = buildAuthorizationUrl({ client: this.oauthClient });
    this.stateStore.remember(built.state);
    return built;
  }

  async completeOAuth(params: { code: string; state: string }): Promise<OAuthConnection> {
    if (!this.oauthClient) {
      throw new GithubAdapterNotImplementedError("completeOAuth");
    }
    if (!this.stateStore.consume(params.state)) {
      throw new GithubOAuthStateMismatchError();
    }
    const exchanged: ExchangedToken = await this.exchangeCode({
      client: this.oauthClient,
      code: params.code,
    });
    // 平文 access token はここから先 process memory に残さない。
    const apiForLogin = this.apiClientFactory(exchanged.accessToken);
    const login = await apiForLogin.getAuthenticatedUserLogin();
    const accessTokenCiphertext = this.crypto.encrypt(exchanged.accessToken);
    const refreshTokenCiphertext = exchanged.refreshToken
      ? this.crypto.encrypt(exchanged.refreshToken)
      : null;
    const expiresAt = exchanged.expiresInSeconds
      ? new Date(Date.now() + exchanged.expiresInSeconds * 1000)
      : null;
    const connectedAt = new Date();
    const scopes = exchanged.grantedScopes.length
      ? exchanged.grantedScopes
      : [...ADDROID_REQUIRED_SCOPES];
    await this.tokenStore.saveOAuthToken({
      provider: "github",
      accountIdentifier: login,
      scopes,
      accessTokenCiphertext,
      refreshTokenCiphertext,
      expiresAt,
      connectedAt,
    });
    return {
      provider: "github",
      accountIdentifier: login,
      scopes,
      connectedAt: connectedAt.toISOString(),
    };
  }

  async bootstrapOpsRepo(input: BootstrapOpsRepoInput): Promise<BootstrapOpsRepoResult> {
    const api = await this.getAuthenticatedClient("bootstrap ops repo");
    const defaultBranch = input.defaultBranch ?? "main";
    const visibility = input.visibility ?? "private";
    const repo = await api.createUserRepo({
      name: input.desiredName,
      isPrivate: visibility === "private",
      defaultBranch,
    });
    // gh CLI 由来の OAuth token は workflow scope を持たないため、
    // .github/workflows/ を含む tree 作成は GitHub が 404 で拒否する。
    // Phase A では CI 検証 workflow を除外し、workflow scope 取得後に手動追加する。
    const files = buildBootstrapTemplateFiles(input).filter(
      (f) => !f.path.startsWith(".github/workflows/")
    );
    const commit = await api.commitTemplateFiles({
      owner: repo.owner,
      repo: repo.name,
      branch: repo.defaultBranch,
      message: "chore(addroid): bootstrap ops repository template",
      files,
    });
    return {
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      bootstrappedAt: new Date().toISOString(),
      filesCommitted: commit.filesCommitted,
    };
  }

  async createPullRequest(
    input: CreatePullRequestInput
  ): Promise<CreatePullRequestResult> {
    const api = await this.getAuthenticatedClient("create pull request");
    const baseRef = input.baseRef ?? input.spec.defaultBranch;
    const commitMessage = `chore(addroid): ${input.title}`.slice(0, 200);
    return api.createPullRequest({
      owner: input.spec.owner,
      repo: input.spec.name,
      branch: input.branchName,
      baseRef,
      title: input.title,
      body: input.body,
      files: input.files,
      commitMessage,
    });
  }

  async mergePullRequest(
    input: MergePullRequestInput
  ): Promise<MergePullRequestResult> {
    const api = await this.getAuthenticatedClient("merge pull request");
    return api.mergePullRequest({
      owner: input.spec.owner,
      repo: input.spec.name,
      number: input.number,
      ...(input.expectedHeadSha !== undefined
        ? { expectedHeadSha: input.expectedHeadSha }
        : {}),
      ...(input.mergeMethod !== undefined ? { mergeMethod: input.mergeMethod } : {}),
      ...(input.commitTitle !== undefined ? { commitTitle: input.commitTitle } : {}),
      ...(input.commitMessage !== undefined
        ? { commitMessage: input.commitMessage }
        : {}),
    });
  }

  async pollPullRequests(
    spec: OpsRepoSpec,
    prev: { etag?: string }
  ): Promise<PullRequestPollResult> {
    const api = await this.getAuthenticatedClient("poll pull requests");
    const result = await api.listPullRequests({
      owner: spec.owner,
      repo: spec.name,
      etag: prev.etag,
    });
    if (result.status === 304) {
      const out: PullRequestPollResult = {
        notModified: true,
        pullRequests: [],
      };
      if (result.etag !== undefined) out.etag = result.etag;
      else if (prev.etag !== undefined) out.etag = prev.etag;
      if (result.lastModified !== undefined) out.lastModified = result.lastModified;
      return out;
    }
    const out: PullRequestPollResult = {
      notModified: false,
      pullRequests: result.pullRequests,
    };
    if (result.etag !== undefined) out.etag = result.etag;
    if (result.lastModified !== undefined) out.lastModified = result.lastModified;
    return out;
  }

  private async getAuthenticatedClient(operation: string): Promise<GithubApiClient> {
    const token = await this.tokenStore.loadOAuthToken("github");
    if (!token) throw new GithubAdapterUnauthenticatedError(operation);
    const accessToken = this.crypto.decrypt(token.accessTokenCiphertext);
    return this.apiClientFactory(accessToken);
  }
}

function buildBootstrapTemplateFiles(input: BootstrapOpsRepoInput): OpsTemplateFile[] {
  return buildOpsTemplate({
    workspaceSlug: input.workspaceSlug,
    workspaceDisplayName: input.workspaceDisplayName,
    initialAccountKey: input.initialAccountKey,
    initialAccountDisplayName: input.initialAccountDisplayName,
  });
}

// ---------------------------------------------------------------------
// `@octokit/rest` を用いた既定 API client。
// ---------------------------------------------------------------------

/**
 * `@octokit/rest` を用いた本番向け API client を返す。テストや mock では
 * 別実装を `OctokitGithubAdapterDeps.apiClientFactory` に注入する。
 */
export async function createDefaultGithubApiClient(
  accessToken: string
): Promise<GithubApiClient> {
  // dynamic import で circular load と test bundling を避ける。
  const { Octokit } = await import("@octokit/rest");
  const userAgent = "addroid-oss/0.0";
  const octokit = new Octokit({ auth: accessToken, userAgent });
  return new OctokitApiClient(octokit);
}

/**
 * 同期構築版。Octokit を渡すコンストラクタ呼び出しでよい場面 (例: アプリ側で
 * 1 度だけ Octokit を import する) のために提供。
 */
export function wrapOctokitAsApiClient(octokit: unknown): GithubApiClient {
  return new OctokitApiClient(octokit as OctokitLike);
}

interface OctokitLike {
  request: (
    route: string,
    params?: Record<string, unknown>
  ) => Promise<{
    status: number;
    headers: Record<string, string | number | undefined>;
    data: unknown;
  }>;
  rest: {
    users: {
      getAuthenticated: () => Promise<{ data: { login: string } }>;
    };
    repos: {
      createForAuthenticatedUser: (params: {
        name: string;
        private: boolean;
        auto_init: boolean;
      }) => Promise<{ data: { name: string; default_branch: string; owner: { login: string } } }>;
      getContent: (params: {
        owner: string;
        repo: string;
        path: string;
        ref?: string;
      }) => Promise<{ data: unknown }>;
      updateBranchProtection: (params: {
        owner: string;
        repo: string;
        branch: string;
        required_status_checks: null;
        enforce_admins: boolean;
        required_pull_request_reviews: { required_approving_review_count: number } | null;
        restrictions: null;
      }) => Promise<unknown>;
    };
    git: {
      getRef: (params: {
        owner: string;
        repo: string;
        ref: string;
      }) => Promise<{ data: { object: { sha: string } } }>;
      getCommit: (params: {
        owner: string;
        repo: string;
        commit_sha: string;
      }) => Promise<{ data: { tree: { sha: string } } }>;
      createBlob: (params: {
        owner: string;
        repo: string;
        content: string;
        encoding: "utf-8";
      }) => Promise<{ data: { sha: string } }>;
      createTree: (params: {
        owner: string;
        repo: string;
        base_tree: string;
        tree: Array<
          | { path: string; mode: "100644"; type: "blob"; sha: string }
          | { path: string; mode: "100644"; type: "blob"; sha: null }
        >;
      }) => Promise<{ data: { sha: string } }>;
      createCommit: (params: {
        owner: string;
        repo: string;
        message: string;
        tree: string;
        parents: string[];
      }) => Promise<{ data: { sha: string } }>;
      updateRef: (params: {
        owner: string;
        repo: string;
        ref: string;
        sha: string;
        force?: boolean;
      }) => Promise<unknown>;
      createRef: (params: {
        owner: string;
        repo: string;
        ref: string;
        sha: string;
      }) => Promise<unknown>;
    };
    pulls: {
      create: (params: {
        owner: string;
        repo: string;
        title: string;
        head: string;
        base: string;
        body: string;
      }) => Promise<{
        data: { number: number; html_url: string; head: { sha: string } };
      }>;
      merge: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        sha?: string;
        merge_method?: "merge" | "squash" | "rebase";
        commit_title?: string;
        commit_message?: string;
      }) => Promise<{
        data: { sha: string; merged: boolean; message: string };
      }>;
    };
  };
}

async function retryOn404<T>(fn: () => Promise<T>, attempts = 5, delayMs = 2000): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 404) throw err;
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

class OctokitApiClient implements GithubApiClient {
  constructor(private readonly octokit: OctokitLike) {}

  async getAuthenticatedUserLogin(): Promise<string> {
    const res = await this.octokit.rest.users.getAuthenticated();
    return res.data.login;
  }

  async createUserRepo(input: {
    name: string;
    isPrivate: boolean;
    defaultBranch: string;
  }): Promise<{ owner: string; name: string; defaultBranch: string }> {
    // auto_init: true で空の README を作る。直後に template commit が overwrite する。
    try {
      const res = await this.octokit.rest.repos.createForAuthenticatedUser({
        name: input.name,
        private: input.isPrivate,
        auto_init: true,
      });
      return {
        owner: res.data.owner.login,
        name: res.data.name,
        defaultBranch: res.data.default_branch,
      };
    } catch (err) {
      // 422 name already exists: bootstrap 再実行の冪等化として既存 repo を再利用する。
      // 新規作成直後は Git Data API への伝播待ちで template commit が失敗し得るため、
      // この経路がないと再実行で詰む (bb8ad8/addroid-oss 未修正)
      if ((err as { status?: number }).status !== 422) throw err;
      const login = (await this.octokit.rest.users.getAuthenticated()).data.login;
      const res = await this.octokit.request("GET /repos/{owner}/{repo}", {
        owner: login,
        repo: input.name,
      });
      const data = res.data as {
        name: string;
        default_branch: string;
        owner: { login: string };
      };
      return {
        owner: data.owner.login,
        name: data.name,
        defaultBranch: data.default_branch,
      };
    }
  }

  async commitTemplateFiles(input: {
    owner: string;
    repo: string;
    branch: string;
    message: string;
    files: OpsTemplateFile[];
  }): Promise<{ commitSha: string; filesCommitted: number }> {
    const refRes = await this.octokit.rest.git.getRef({
      owner: input.owner,
      repo: input.repo,
      ref: `heads/${input.branch}`,
    });
    const parentCommitSha = refRes.data.object.sha;
    const commitRes = await this.octokit.rest.git.getCommit({
      owner: input.owner,
      repo: input.repo,
      commit_sha: parentCommitSha,
    });
    const baseTreeSha = commitRes.data.tree.sha;

    const blobShas: { path: string; sha: string }[] = [];
    for (const file of input.files) {
      const blob = await this.octokit.rest.git.createBlob({
        owner: input.owner,
        repo: input.repo,
        content: file.content,
        encoding: "utf-8",
      });
      blobShas.push({ path: file.path, sha: blob.data.sha });
    }

    // 新規作成直後の repo は Git Data API 側への伝播が遅れ、POST git/trees が
    // 一時的に 404 を返すことがあるためリトライする (bb8ad8/addroid-oss 未修正)
    const treeRes = await retryOn404(() =>
      this.octokit.rest.git.createTree({
        owner: input.owner,
        repo: input.repo,
        base_tree: baseTreeSha,
        tree: blobShas.map((b) => ({
          path: b.path,
          mode: "100644",
          type: "blob",
          sha: b.sha,
        })),
      })
    );

    const commitNew = await this.octokit.rest.git.createCommit({
      owner: input.owner,
      repo: input.repo,
      message: input.message,
      tree: treeRes.data.sha,
      parents: [parentCommitSha],
    });

    await this.octokit.rest.git.updateRef({
      owner: input.owner,
      repo: input.repo,
      ref: `heads/${input.branch}`,
      sha: commitNew.data.sha,
      force: false,
    });

    return { commitSha: commitNew.data.sha, filesCommitted: input.files.length };
  }

  async listPullRequests(input: {
    owner: string;
    repo: string;
    etag?: string;
  }): Promise<{
    status: number;
    etag?: string;
    lastModified?: string;
    pullRequests: PullRequestSummary[];
  }> {
    const headers: Record<string, string> = {};
    if (input.etag) headers["If-None-Match"] = input.etag;
    try {
      const res = await this.octokit.request(`GET /repos/{owner}/{repo}/pulls`, {
        owner: input.owner,
        repo: input.repo,
        state: "all",
        per_page: 50,
        sort: "updated",
        direction: "desc",
        headers,
      });
      const status = res.status;
      const etag = headerString(res.headers["etag"]) ?? headerString(res.headers["ETag"]);
      const lastModified = headerString(res.headers["last-modified"]);
      const data = Array.isArray(res.data) ? (res.data as Record<string, unknown>[]) : [];
      const pullRequests: PullRequestSummary[] = data.map((pr) => ({
        number: Number(pr["number"]),
        title: String(pr["title"] ?? ""),
        state: normalizeState(pr),
        headSha: String((pr["head"] as Record<string, unknown> | undefined)?.["sha"] ?? ""),
        baseRef: String((pr["base"] as Record<string, unknown> | undefined)?.["ref"] ?? "main"),
        htmlUrl: String(pr["html_url"] ?? ""),
        mergedAt: (pr["merged_at"] as string | null) ?? null,
        mergeSha: readOptionalString(pr["merge_commit_sha"]),
        mergedBy: readLogin(pr["merged_by"]),
      }));
      const out: {
        status: number;
        etag?: string;
        lastModified?: string;
        pullRequests: PullRequestSummary[];
      } = { status, pullRequests };
      if (etag !== undefined) out.etag = etag;
      if (lastModified !== undefined) out.lastModified = lastModified;
      return out;
    } catch (err) {
      // Octokit は 304 を error として throw する。明示的にキャッチして notModified を返す。
      const status = (err as { status?: number }).status;
      if (status === 304) {
        const headers = ((err as { response?: { headers?: Record<string, string | number | undefined> } })
          .response?.headers ?? {}) as Record<string, string | number | undefined>;
        const out: {
          status: number;
          etag?: string;
          lastModified?: string;
          pullRequests: PullRequestSummary[];
        } = { status: 304, pullRequests: [] };
        const etag = headerString(headers["etag"]) ?? headerString(headers["ETag"]);
        const lastModified = headerString(headers["last-modified"]);
        if (etag !== undefined) out.etag = etag;
        if (lastModified !== undefined) out.lastModified = lastModified;
        return out;
      }
      throw err;
    }
  }

  async createPullRequest(input: {
    owner: string;
    repo: string;
    branch: string;
    baseRef: string;
    title: string;
    body: string;
    files: CreatePullRequestFile[];
    commitMessage: string;
  }): Promise<{ number: number; htmlUrl: string; headSha: string }> {
    // baseRef の HEAD 取得 → blob/tree/commit/ref/PR を順に作る。
    const baseRefRes = await this.octokit.rest.git.getRef({
      owner: input.owner,
      repo: input.repo,
      ref: `heads/${input.baseRef}`,
    });
    const baseSha = baseRefRes.data.object.sha;
    const baseCommit = await this.octokit.rest.git.getCommit({
      owner: input.owner,
      repo: input.repo,
      commit_sha: baseSha,
    });
    const baseTreeSha = baseCommit.data.tree.sha;

    type TreeEntry =
      | { path: string; mode: "100644"; type: "blob"; sha: string }
      | { path: string; mode: "100644"; type: "blob"; sha: null };
    const treeEntries: TreeEntry[] = [];
    for (const file of input.files) {
      if (file.action === "delete") {
        treeEntries.push({
          path: file.path,
          mode: "100644",
          type: "blob",
          sha: null,
        });
        continue;
      }
      const content = extractAddedContentFromDiff(file.diff);
      const blob = await this.octokit.rest.git.createBlob({
        owner: input.owner,
        repo: input.repo,
        content,
        encoding: "utf-8",
      });
      treeEntries.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: blob.data.sha,
      });
    }

    const tree = await this.octokit.rest.git.createTree({
      owner: input.owner,
      repo: input.repo,
      base_tree: baseTreeSha,
      tree: treeEntries,
    });
    const commit = await this.octokit.rest.git.createCommit({
      owner: input.owner,
      repo: input.repo,
      message: input.commitMessage,
      tree: tree.data.sha,
      parents: [baseSha],
    });

    await this.octokit.rest.git.createRef({
      owner: input.owner,
      repo: input.repo,
      ref: `refs/heads/${input.branch}`,
      sha: commit.data.sha,
    });

    const pr = await this.octokit.rest.pulls.create({
      owner: input.owner,
      repo: input.repo,
      title: input.title,
      head: input.branch,
      base: input.baseRef,
      body: input.body,
    });

    return {
      number: pr.data.number,
      htmlUrl: pr.data.html_url,
      headSha: pr.data.head.sha,
    };
  }

  async mergePullRequest(input: {
    owner: string;
    repo: string;
    number: number;
    expectedHeadSha?: string;
    mergeMethod?: "merge" | "squash" | "rebase";
    commitTitle?: string;
    commitMessage?: string;
  }): Promise<{ sha: string; merged: boolean; message: string }> {
    try {
      const res = await this.octokit.rest.pulls.merge({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.number,
        ...(input.expectedHeadSha !== undefined ? { sha: input.expectedHeadSha } : {}),
        ...(input.mergeMethod !== undefined
          ? { merge_method: input.mergeMethod }
          : {}),
        ...(input.commitTitle !== undefined ? { commit_title: input.commitTitle } : {}),
        ...(input.commitMessage !== undefined
          ? { commit_message: input.commitMessage }
          : {}),
      });
      return {
        sha: res.data.sha,
        merged: res.data.merged,
        message: res.data.message,
      };
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      const message = err instanceof Error ? err.message : String(err);
      throw new GithubMergeFailedError(status, message);
    }
  }
}

/**
 * gitops agent が出した unified diff から、追加行だけを取り出してファイル本体を復元する。
 *
 * 簡易版: `+++`, `---`, `@@` 等のヘッダ / `-` で始まる削除行を除き、`+` 接頭辞を
 * 取り除いた行を順に並べる。コンテキスト行 (空白接頭辞) はそのまま採用する。
 * gitops agent の出力は「create / update のいずれも完全な新ファイル本体を `+` 行
 * で表現する」契約で、本関数はその前提に基づく。
 */
function extractAddedContentFromDiff(diff: string): string {
  const lines = diff.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("@@") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to")
    ) {
      continue;
    }
    if (line.startsWith("-")) continue;
    if (line.startsWith("+")) {
      out.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      out.push(line.slice(1));
    } else {
      out.push(line);
    }
  }
  // 末尾の空行を 1 行に揃える (POSIX text file convention)。
  while (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

function headerString(v: string | number | undefined): string | undefined {
  if (v === undefined) return undefined;
  return typeof v === "string" ? v : String(v);
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeState(pr: Record<string, unknown>): "open" | "closed" | "merged" {
  if (pr["merged_at"]) return "merged";
  const s = String(pr["state"] ?? "open");
  if (s === "closed") return "closed";
  return "open";
}

function readLogin(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const login = (value as Record<string, unknown>).login;
  return typeof login === "string" && login.trim() ? login : null;
}
