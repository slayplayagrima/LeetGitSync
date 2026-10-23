import { mapGitHubError, SyncError, type GitHubErrorContext } from "./errors";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const TIMEOUT_MS = 20_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  /** Present when GitHub reports it; reflects the account's role, not the token's scope. */
  canPush?: boolean;
}

export interface RemoteFile {
  sha: string;
  /** Decoded UTF-8 text, or null when GitHub did not return the content (very large files). */
  content: string | null;
}

export interface FileToWrite {
  path: string;
  content: string;
}

export interface CommitResult {
  commitSha: string;
  commitUrl: string;
}

export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SyncError("encoding", "An existing file in the repository is not valid UTF-8 text, so it was left untouched.", {
      retryable: false,
    });
  }
}

/**
 * Minimal GitHub REST client for one repository. The token is only ever placed
 * in the Authorization header of requests to api.github.com.
 */
export class GitHubClient {
  readonly owner: string;
  readonly repo: string;
  readonly #token: string;
  readonly #fetch: FetchLike;

  constructor(opts: { token: string; owner: string; repo: string; fetch?: FetchLike }) {
    this.#token = opts.token;
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  get #repoPath(): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  async #request<T>(
    method: string,
    path: string,
    ctx: Omit<GitHubErrorContext, "owner" | "repo">,
    body?: unknown,
    allow404 = false,
  ): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      const init: RequestInit = {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.#token}`,
          "X-GitHub-Api-Version": API_VERSION,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      res = await this.#fetch(`${API}${path}`, init);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new SyncError("network", "GitHub did not respond in time. The sync will retry.");
      }
      throw new SyncError("network", "Could not reach GitHub. Check your internet connection; the sync will retry.");
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      let apiMessage = "";
      try {
        const data: unknown = await res.json();
        if (data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string") {
          apiMessage = (data as { message: string }).message;
        }
      } catch {
        // Non-JSON error body; the status code is enough.
      }
      throw mapGitHubError(res.status, res.headers, apiMessage, { owner: this.owner, repo: this.repo, ...ctx });
    }
    if (res.status === 204) return null;
    try {
      return (await res.json()) as T;
    } catch {
      throw new SyncError("server_error", "GitHub returned a response that could not be read. The sync will retry.");
    }
  }

  async getRepo(): Promise<RepoInfo> {
    const data = await this.#request<Record<string, unknown>>("GET", this.#repoPath, { operation: "repo" });
    if (!data || typeof data.full_name !== "string" || typeof data.default_branch !== "string") {
      throw new SyncError("unknown", "GitHub returned unexpected repository data.", { retryable: false });
    }
    const info: RepoInfo = {
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      isPrivate: data.private === true,
    };
    const perms = data.permissions as Record<string, unknown> | undefined;
    if (perms && typeof perms.push === "boolean") info.canPush = perms.push;
    return info;
  }

  /** Throws `branch_not_found` (or `repo_empty`) when the branch cannot be written to. */
  async getBranchHead(branch: string): Promise<string> {
    const data = await this.#request<{ object?: { sha?: unknown } }>(
      "GET",
      `${this.#repoPath}/git/ref/heads/${encodePath(branch)}`,
      { operation: "branch", branch },
    );
    const sha = data?.object?.sha;
    if (typeof sha !== "string") {
      throw new SyncError("branch_not_found", `Branch "${branch}" could not be read.`, { retryable: false });
    }
    return sha;
  }

  async getFile(path: string, branch: string): Promise<RemoteFile | null> {
    const data = await this.#request<unknown>(
      "GET",
      `${this.#repoPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
      { operation: "read", branch },
      undefined,
      true,
    );
    if (data === null) return null;
    if (Array.isArray(data) || typeof data !== "object") {
      throw new SyncError("invalid_path", `"${path}" is a folder in the repository, not a file. Change the filename settings.`, {
        retryable: false,
      });
    }
    const file = data as { type?: unknown; sha?: unknown; content?: unknown; encoding?: unknown };
    if (file.type !== "file" || typeof file.sha !== "string") {
      throw new SyncError("invalid_path", `"${path}" exists in the repository but is not a regular file.`, {
        retryable: false,
      });
    }
    const content =
      file.encoding === "base64" && typeof file.content === "string" ? decodeBase64Utf8(file.content) : null;
    return { sha: file.sha, content };
  }

  /**
   * Writes all files in a single commit using the Git Data API, then moves the
   * branch with a non-forced update. If the branch moved meanwhile, GitHub
   * rejects the update and nothing changes, so the caller can safely retry.
   */
  async commitFiles(branch: string, files: FileToWrite[], message: string): Promise<CommitResult> {
    if (files.length === 0) throw new Error("Nothing to commit.");
    const write = { operation: "write" as const, branch };

    const headSha = await this.getBranchHead(branch);
    const headCommit = await this.#request<{ tree?: { sha?: unknown } }>(
      "GET",
      `${this.#repoPath}/git/commits/${headSha}`,
      write,
    );
    const baseTree = headCommit?.tree?.sha;
    if (typeof baseTree !== "string") throw new SyncError("server_error", "Could not read the latest commit on the branch.");

    const tree = await this.#request<{ sha?: unknown }>("POST", `${this.#repoPath}/git/trees`, write, {
      base_tree: baseTree,
      tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
    });
    if (typeof tree?.sha !== "string") throw new SyncError("server_error", "GitHub did not return the new file tree.");

    const commit = await this.#request<{ sha?: unknown; html_url?: unknown }>(
      "POST",
      `${this.#repoPath}/git/commits`,
      write,
      { message, tree: tree.sha, parents: [headSha] },
    );
    if (typeof commit?.sha !== "string") throw new SyncError("server_error", "GitHub did not return the new commit.");

    await this.#request("PATCH", `${this.#repoPath}/git/refs/heads/${encodePath(branch)}`, write, {
      sha: commit.sha,
      force: false,
    });

    const commitUrl =
      typeof commit.html_url === "string"
        ? commit.html_url
        : `https://github.com/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/commit/${commit.sha}`;
    return { commitSha: commit.sha, commitUrl };
  }
}
