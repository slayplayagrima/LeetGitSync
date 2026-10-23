/** Lifecycle of a single accepted submission inside the local sync queue. */
export type SyncStatus =
  | "detected"
  | "waiting_details"
  | "ready"
  | "syncing"
  | "synced"
  | "failed"
  | "needs_review";

export type SyncMode = "auto" | "manual";

/** What to do when a later accepted submission for the same problem has different code. */
export type HistoryPolicy =
  /** Overwrite the main solution file; earlier versions stay in the Git history. */
  | "update"
  /** Keep every distinct submission as its own file next to the others. */
  | "separate";

export type FilenameStyle = "number-slug" | "slug" | "number-dot-slug";

export type ErrorCode =
  | "not_configured"
  | "auth_invalid"
  | "permission_denied"
  | "repo_not_found"
  | "repo_empty"
  | "branch_not_found"
  | "conflict"
  | "network"
  | "rate_limited"
  | "server_error"
  | "invalid_path"
  | "encoding"
  | "empty_code"
  | "details_unavailable"
  | "not_accepted"
  | "validation"
  | "unknown";

export interface SyncErrorInfo {
  code: ErrorCode;
  /** Human-readable, already redacted, with a next step where possible. */
  message: string;
  retryable: boolean;
  /** Epoch ms before which a retry is pointless (rate limits). */
  retryAt?: number;
}

/** Validated data about one submission, as returned by LeetCode for the signed-in user. */
export interface SubmissionDetails {
  submissionId: string;
  code: string;
  /** LeetCode language slug, e.g. "python3". */
  langSlug: string;
  /** LeetCode display name, e.g. "Python3". */
  langName: string;
  /** Epoch seconds as reported by LeetCode. */
  timestamp: number;
  statusCode: number;
  runtime?: string;
  memory?: string;
  titleSlug: string;
  questionId?: string;
  frontendId?: string;
  title?: string;
  difficulty?: string;
}

export interface SyncRecord {
  submissionId: string;
  titleSlug: string;
  title?: string;
  frontendId?: string;
  langSlug?: string;
  langName?: string;
  status: SyncStatus;
  source: "auto" | "manual";
  /** Set when the user asked for this sync (manual mode, "Sync now" or a retry). */
  userApproved?: boolean;
  detectedAt: number;
  updatedAt: number;
  syncedAt?: number;
  attempts: number;
  nextAttemptAt?: number;
  path?: string;
  metadataPath?: string;
  codeHash?: string;
  outcome?: "created" | "updated" | "unchanged";
  commitUrl?: string;
  /** Non-fatal note, e.g. the target branch is not the repository's default branch. */
  warning?: string;
  error?: SyncErrorInfo;
  /** Kept only until the record is synced, then dropped to keep local storage small. */
  details?: SubmissionDetails;
}

export interface Settings {
  owner: string;
  repo: string;
  branch: string;
  syncMode: SyncMode;
  historyPolicy: HistoryPolicy;
  /** Optional folder inside the repository that holds all language folders. */
  rootFolder: string;
  filenameStyle: FilenameStyle;
  /** Overrides for the default per-language folder names, keyed by folder key (e.g. "python"). */
  languageFolders: Record<string, string>;
  includeHeader: boolean;
  metadataSidecar: boolean;
}

export interface ConnectionState {
  state: "unknown" | "ok" | "error";
  checkedAt?: number;
  repoFullName?: string;
  defaultBranch?: string;
  isPrivate?: boolean;
  branchIsDefault?: boolean;
  message?: string;
  errorCode?: ErrorCode;
}

/** Summary sent to the popup and options page. Never contains the token or source code. */
export interface PublicState {
  settings: Settings;
  hasToken: boolean;
  connection: ConnectionState;
  records: PublicRecord[];
  counts: { synced: number; attention: number; pending: number };
}

export type PublicRecord = Omit<SyncRecord, "details">;
