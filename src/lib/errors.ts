import type { ErrorCode, SyncErrorInfo } from "../types";
import { redact } from "./redact";

export class SyncError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAt?: number;

  constructor(code: ErrorCode, message: string, options: { retryable?: boolean; retryAt?: number } = {}) {
    super(redact(message));
    this.name = "SyncError";
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    if (options.retryAt !== undefined) this.retryAt = options.retryAt;
  }

  toInfo(): SyncErrorInfo {
    const info: SyncErrorInfo = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.retryAt !== undefined) info.retryAt = this.retryAt;
    return info;
  }
}

/** Only transient failures are retried automatically. Auth and config problems need the user. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "network",
  "rate_limited",
  "server_error",
  "conflict",
  "details_unavailable",
]);

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE.has(code);
}

export function toErrorInfo(err: unknown): SyncErrorInfo {
  if (err instanceof SyncError) return err.toInfo();
  if (err instanceof TypeError) {
    // fetch() rejects with TypeError on network failure.
    return new SyncError("network", "Could not reach the server. Check your internet connection; the sync will retry.").toInfo();
  }
  if (err instanceof Error && err.name === "AbortError") {
    return new SyncError("network", "The request timed out. The sync will retry.").toInfo();
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "unknown", message: redact(message || "Unexpected error."), retryable: false };
}

export interface GitHubErrorContext {
  owner: string;
  repo: string;
  branch?: string;
  /** What the request was doing, used to choose the clearest message. */
  operation: "repo" | "branch" | "read" | "write";
}

function header(headers: Headers, name: string): string | null {
  try {
    return headers.get(name);
  } catch {
    return null;
  }
}

/** Translates a failed GitHub REST response into an actionable, credential-free error. */
export function mapGitHubError(
  status: number,
  headers: Headers,
  apiMessage: string,
  ctx: GitHubErrorContext,
  now: number = Date.now(),
): SyncError {
  const repo = `${ctx.owner}/${ctx.repo}`;
  const msg = apiMessage.toLowerCase();

  const remaining = header(headers, "x-ratelimit-remaining");
  const reset = Number(header(headers, "x-ratelimit-reset"));
  const retryAfter = Number(header(headers, "retry-after"));
  const rateLimited =
    status === 429 ||
    ((status === 403 || status === 429) && (remaining === "0" || msg.includes("rate limit")));
  if (rateLimited) {
    let retryAt = now + 60_000;
    if (Number.isFinite(retryAfter) && retryAfter > 0) retryAt = now + retryAfter * 1000;
    else if (Number.isFinite(reset) && reset > 0) retryAt = reset * 1000;
    const when = new Date(retryAt).toLocaleTimeString();
    return new SyncError("rate_limited", `GitHub rate limit reached. LeetGitSync will retry after ${when}.`, {
      retryAt,
    });
  }

  if (status === 401) {
    return new SyncError(
      "auth_invalid",
      "GitHub rejected the token (invalid, expired or revoked). Create a new fine-grained token and save it in Settings.",
    );
  }

  if (status === 403) {
    return new SyncError(
      "permission_denied",
      `The token cannot ${ctx.operation === "write" ? "write to" : "read"} ${repo}. In the token settings, make sure ${repo} is selected under Repository access and Contents is set to "Read and write".`,
    );
  }

  if (status === 404) {
    if (ctx.operation === "branch") {
      return new SyncError(
        "branch_not_found",
        `Branch "${ctx.branch ?? ""}" does not exist in ${repo}. Check the branch name in Settings.`,
      );
    }
    return new SyncError(
      "repo_not_found",
      `Repository ${repo} was not found, or the token is not allowed to see it. Check the owner and name in Settings and that the token includes this repository.`,
    );
  }

  if (status === 409) {
    if (msg.includes("empty")) {
      return new SyncError(
        "repo_empty",
        `${repo} has no commits yet. Add a README on GitHub (or push an initial commit) to create the "${ctx.branch ?? "main"}" branch, then retry.`,
      );
    }
    return new SyncError("conflict", "The branch changed while saving. LeetGitSync will retry with the latest version.");
  }

  if (status === 422) {
    if (msg.includes("fast forward") || msg.includes("fast-forward") || msg.includes("sha")) {
      return new SyncError("conflict", "The branch changed while saving. LeetGitSync will retry with the latest version.");
    }
    if (msg.includes("path") || msg.includes("name")) {
      return new SyncError("invalid_path", "GitHub rejected the file path. Adjust the folder or filename settings.");
    }
    return new SyncError("validation", `GitHub rejected the request: ${apiMessage || "validation failed"}.`, {
      retryable: false,
    });
  }

  if (status >= 500) {
    return new SyncError("server_error", `GitHub returned a server error (${status}). The sync will retry.`);
  }

  return new SyncError("unknown", `GitHub request failed with status ${status}${apiMessage ? `: ${apiMessage}` : ""}.`, {
    retryable: false,
  });
}

export const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 30 * 60_000;

/** Exponential backoff: 30s, 60s, 120s, ... capped at 30 minutes. */
export function backoffDelay(attempt: number): number {
  const exp = Math.max(0, attempt - 1);
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** exp);
}
