import type {
  ConnectionState,
  PublicRecord,
  PublicState,
  Settings,
  SubmissionDetails,
  SyncErrorInfo,
  SyncRecord,
} from "../types";
import { decideOnDetection, findSyncedDuplicate, sha256Hex } from "./deduplication";
import { backoffDelay, MAX_ATTEMPTS, SyncError, toErrorInfo } from "./errors";
import { buildMetadataJson, buildSolutionFile, hasSameCode } from "./file-content";
import { buildPaths } from "./filename";
import { GitHubClient, type FetchLike, type FileToWrite } from "./github-client";
import { getLanguage } from "./languages";
import { log } from "./log";
import type { StateStore } from "./storage";
import { ACCEPTED_STATUS_CODE, isValidSlug, isValidSubmissionId, validateSettings } from "./validation";

export interface SyncEvent {
  kind: "success" | "info" | "error";
  message: string;
  submissionId?: string;
}

export interface SyncServiceDeps {
  store: StateStore;
  fetch?: FetchLike;
  now?: () => number;
  /** Called for user-visible outcomes (toast on the LeetCode tab, badge). */
  notify?: (event: SyncEvent) => void;
  /** Asks the platform to wake the worker at `when` to process retries. */
  scheduleWake?: (when: number) => void;
}

const COMMIT_CONFLICT_TRIES = 3;
const ACTIVE: ReadonlySet<SyncRecord["status"]> = new Set(["detected", "waiting_details", "ready", "syncing"]);

function toPublic(r: SyncRecord): PublicRecord {
  const { details: _details, ...rest } = r;
  return rest;
}

function describe(details: Pick<SubmissionDetails, "frontendId" | "title" | "titleSlug">): string {
  return `${details.frontendId ? `${details.frontendId}. ` : ""}${details.title ?? details.titleSlug}`;
}

export class SyncService {
  readonly #store: StateStore;
  readonly #fetch: FetchLike | undefined;
  readonly #now: () => number;
  readonly #notify: (event: SyncEvent) => void;
  readonly #scheduleWake: (when: number) => void;
  #processing: Promise<void> | null = null;
  #rerun = false;

  constructor(deps: SyncServiceDeps) {
    this.#store = deps.store;
    this.#fetch = deps.fetch;
    this.#now = deps.now ?? Date.now;
    this.#notify = deps.notify ?? (() => {});
    this.#scheduleWake = deps.scheduleWake ?? (() => {});
  }

  // ---------------------------------------------------------------- detection

  /** An accepted submission was observed on LeetCode. Returns whether details should be fetched. */
  async reportAccepted(input: {
    submissionId: string;
    titleSlug: string;
    source: "auto" | "manual";
  }): Promise<{ needDetails: boolean; message: string }> {
    if (!isValidSubmissionId(input.submissionId) || !isValidSlug(input.titleSlug)) {
      return { needDetails: false, message: "Ignored an invalid submission report." };
    }
    const now = this.#now();
    return this.#store.updateRecords((records) => {
      const existing = records[input.submissionId];
      const decision = decideOnDetection(existing, input.source);
      if (decision.action === "ignore") return { needDetails: false, message: decision.reason };
      if (decision.action === "create" || !existing) {
        records[input.submissionId] = {
          submissionId: input.submissionId,
          titleSlug: input.titleSlug,
          status: "waiting_details",
          source: input.source,
          userApproved: input.source === "manual",
          detectedAt: now,
          updatedAt: now,
          attempts: 0,
        };
      } else {
        existing.status = "waiting_details";
        existing.updatedAt = now;
        if (input.source === "manual") {
          existing.userApproved = true;
          existing.attempts = 0;
        }
        delete existing.error;
      }
      return { needDetails: true, message: "Reading the accepted submission from LeetCode." };
    });
  }

  /** The content script fetched (or failed to fetch) details for a waiting submission. */
  async reportDetails(
    submissionId: string,
    result: { ok: true; details: SubmissionDetails } | { ok: false; error: SyncErrorInfo },
  ): Promise<void> {
    const now = this.#now();
    const outcome = await this.#store.updateRecords((records) => {
      const record = records[submissionId];
      if (!record || (record.status !== "waiting_details" && record.status !== "detected")) return "stale";
      record.updatedAt = now;
      if (!result.ok) {
        record.status = "needs_review";
        record.error = { ...result.error, retryable: false };
        return "unavailable";
      }
      const d = result.details;
      record.langSlug = d.langSlug;
      record.langName = d.langName;
      if (d.title) record.title = d.title;
      if (d.frontendId) record.frontendId = d.frontendId;

      if (d.submissionId !== submissionId) {
        record.status = "needs_review";
        record.error = { code: "validation", message: "LeetCode returned a different submission than requested.", retryable: false };
        return "review";
      }
      if (d.titleSlug !== record.titleSlug) {
        record.status = "needs_review";
        record.error = {
          code: "validation",
          message: `This submission belongs to "${d.titleSlug}", not the problem it was detected on. Check it on LeetCode, then sync it manually.`,
          retryable: false,
        };
        return "review";
      }
      if (d.statusCode !== ACCEPTED_STATUS_CODE) {
        record.status = "needs_review";
        record.error = { code: "not_accepted", message: "LeetCode reports this submission as not accepted, so it was not saved.", retryable: false };
        return "review";
      }
      if (d.code.trim() === "") {
        record.status = "needs_review";
        record.error = { code: "empty_code", message: "LeetCode returned empty source code for this submission, so nothing was saved.", retryable: false };
        return "review";
      }
      record.details = d;
      record.status = "ready";
      delete record.error;
      return "ready";
    });

    if (outcome === "unavailable" && !result.ok) {
      this.#notify({ kind: "error", message: `Submission details unavailable: ${result.error.message}`, submissionId });
    } else if (outcome === "review") {
      this.#notify({ kind: "error", message: "This submission needs manual review. Open LeetGitSync for details.", submissionId });
    }
    if (outcome === "ready") await this.processQueue();
  }

  /** Submissions whose details still need to be read from a LeetCode tab (e.g. after a reload). */
  async pendingDetailRequests(): Promise<Array<{ submissionId: string; titleSlug: string }>> {
    const records = await this.#store.getRecords();
    return Object.values(records)
      .filter((r) => r.status === "waiting_details" || r.status === "detected")
      .map((r) => ({ submissionId: r.submissionId, titleSlug: r.titleSlug }));
  }

  // ---------------------------------------------------------------- queue

  /** Resets work interrupted by a service-worker shutdown. Safe because every sync re-checks GitHub first. */
  async recover(): Promise<void> {
    await this.#store.updateRecords((records) => {
      for (const r of Object.values(records)) {
        if (r.status === "syncing") {
          r.status = "ready";
          r.updatedAt = this.#now();
        }
      }
    });
    await this.processQueue();
  }

  /** Processes due work one record at a time. Concurrent calls coalesce into one run. */
  processQueue(): Promise<void> {
    if (this.#processing) {
      this.#rerun = true;
      return this.#processing;
    }
    this.#processing = (async () => {
      try {
        do {
          this.#rerun = false;
          await this.#drain();
        } while (this.#rerun);
      } finally {
        this.#processing = null;
      }
    })();
    return this.#processing;
  }

  async #drain(): Promise<void> {
    const settings = await this.#store.getSettings();
    for (;;) {
      const now = this.#now();
      const records = await this.#store.getRecords();
      const due = Object.values(records)
        .filter((r) => this.#isDue(r, settings, now))
        .sort((a, b) => a.detectedAt - b.detectedAt)[0];
      if (!due) break;
      await this.#syncOne(due.submissionId);
    }
    await this.#scheduleNextRetry();
  }

  #isDue(r: SyncRecord, settings: Settings, now: number): boolean {
    if (!r.details) return false;
    const approved = settings.syncMode === "auto" || r.userApproved === true;
    if (r.status === "ready") return approved;
    if (r.status === "failed") return approved && r.error?.retryable === true && r.nextAttemptAt !== undefined && r.nextAttemptAt <= now;
    return false;
  }

  async #scheduleNextRetry(): Promise<void> {
    const records = await this.#store.getRecords();
    const next = Object.values(records)
      .filter((r) => r.status === "failed" && r.error?.retryable && r.nextAttemptAt !== undefined)
      .map((r) => r.nextAttemptAt as number)
      .sort((a, b) => a - b)[0];
    if (next !== undefined) this.#scheduleWake(next);
  }

  async #patch(id: string, fn: (r: SyncRecord) => void): Promise<SyncRecord | undefined> {
    return this.#store.updateRecords((records) => {
      const r = records[id];
      if (!r) return undefined;
      fn(r);
      r.updatedAt = this.#now();
      return structuredClone(r);
    });
  }

  async #syncOne(id: string): Promise<void> {
    const record = await this.#patch(id, (r) => {
      r.status = "syncing";
      r.attempts += 1;
      delete r.nextAttemptAt;
    });
    if (!record?.details) return;
    const details = record.details;

    try {
      const result = await this.#write(record, details);
      await this.#patch(id, (r) => {
        r.status = "synced";
        r.syncedAt = this.#now();
        r.outcome = result.outcome;
        r.path = result.path;
        r.codeHash = result.codeHash;
        if (result.metadataPath) r.metadataPath = result.metadataPath;
        if (result.commitUrl) r.commitUrl = result.commitUrl;
        if (result.warning) r.warning = result.warning;
        else delete r.warning;
        delete r.error;
        delete r.details;
      });
      const what = describe(details);
      this.#notify({
        kind: "success",
        submissionId: id,
        message:
          result.outcome === "unchanged"
            ? `${what} is already in GitHub with the same code. No new commit was made.`
            : `${what} saved to GitHub (${result.path}).`,
      });
    } catch (err) {
      const info = toErrorInfo(err);
      const updated = await this.#patch(id, (r) => {
        r.error = info;
        if (info.code === "not_accepted" || info.code === "empty_code" || info.code === "encoding") {
          r.status = "needs_review";
          return;
        }
        r.status = "failed";
        if (info.retryable && r.attempts < MAX_ATTEMPTS) {
          r.nextAttemptAt = Math.max(this.#now() + backoffDelay(r.attempts), info.retryAt ?? 0);
        } else {
          r.error = { ...info, retryable: false };
        }
      });
      log.warn(`Sync failed for submission ${id}: ${info.code}`, info.message);
      const retrying = updated?.nextAttemptAt !== undefined;
      this.#notify({
        kind: "error",
        submissionId: id,
        message: retrying ? `${info.message} (attempt ${updated?.attempts ?? 1} of ${MAX_ATTEMPTS})` : info.message,
      });
    }
  }

  async #client(settings: Settings): Promise<GitHubClient> {
    const token = await this.#store.getToken();
    if (!token) {
      throw new SyncError("not_configured", "No GitHub token is saved. Open Settings and add a fine-grained token.", {
        retryable: false,
      });
    }
    const invalid = Object.values(validateSettings(settings))[0];
    if (invalid) throw new SyncError("not_configured", `Settings need attention: ${invalid}`, { retryable: false });
    const opts: ConstructorParameters<typeof GitHubClient>[0] = { token, owner: settings.owner, repo: settings.repo };
    if (this.#fetch) opts.fetch = this.#fetch;
    return new GitHubClient(opts);
  }

  async #write(
    record: SyncRecord,
    details: SubmissionDetails,
  ): Promise<{
    outcome: "created" | "updated" | "unchanged";
    path: string;
    metadataPath?: string;
    codeHash: string;
    commitUrl?: string;
    warning?: string;
  }> {
    if (details.statusCode !== ACCEPTED_STATUS_CODE) {
      throw new SyncError("not_accepted", "LeetCode reports this submission as not accepted, so it was not saved.");
    }
    if (details.code.trim() === "") {
      throw new SyncError("empty_code", "LeetCode returned empty source code for this submission, so nothing was saved.");
    }

    const settings = await this.#store.getSettings();
    const lang = getLanguage(details.langSlug);
    let paths;
    try {
      paths = buildPaths(settings, details);
    } catch (err) {
      throw new SyncError("invalid_path", err instanceof Error ? err.message : "Invalid file path.", { retryable: false });
    }
    const codeHash = await sha256Hex(details.code);

    const records = await this.#store.getRecords();
    const duplicate = findSyncedDuplicate(
      records,
      { submissionId: record.submissionId, titleSlug: details.titleSlug, langSlug: details.langSlug, path: paths.path, codeHash },
      settings.historyPolicy,
    );
    if (duplicate) {
      return { outcome: "unchanged", path: duplicate.path ?? paths.path, codeHash };
    }

    const client = await this.#client(settings);
    const repo = await client.getRepo();
    const warning =
      repo.defaultBranch === settings.branch
        ? undefined
        : `Saved to "${settings.branch}", which is not the default branch ("${repo.defaultBranch}"). GitHub only counts commits on the default branch toward your contribution graph.`;

    for (let attempt = 1; ; attempt++) {
      // Re-read the remote file each time so a retry after a lost response never commits twice.
      const existing = await client.getFile(paths.path, settings.branch);
      if (existing?.content != null && hasSameCode(existing.content, details.code, lang)) {
        return { outcome: "unchanged", path: paths.path, codeHash, ...(warning ? { warning } : {}) };
      }

      const files: FileToWrite[] = [
        { path: paths.path, content: buildSolutionFile(details, lang, settings.includeHeader) },
      ];
      if (settings.metadataSidecar) {
        files.push({ path: paths.metadataPath, content: buildMetadataJson(details, paths.path) });
      }
      const verb = existing ? "Update" : "Add";
      const message = `${verb} ${describe(details)} (${details.langName})`;

      try {
        const commit = await client.commitFiles(settings.branch, files, message);
        return {
          outcome: existing ? "updated" : "created",
          path: paths.path,
          ...(settings.metadataSidecar ? { metadataPath: paths.metadataPath } : {}),
          codeHash,
          commitUrl: commit.commitUrl,
          ...(warning ? { warning } : {}),
        };
      } catch (err) {
        if (err instanceof SyncError && err.code === "conflict" && attempt < COMMIT_CONFLICT_TRIES) continue;
        throw err;
      }
    }
  }

  // ---------------------------------------------------------------- user actions

  /** Marks a record (or all failed ones) for another attempt, resetting the retry budget. */
  async retry(submissionId?: string): Promise<number> {
    const count = await this.#store.updateRecords((records) => {
      let n = 0;
      for (const r of Object.values(records)) {
        if (submissionId && r.submissionId !== submissionId) continue;
        const retryable = r.status === "failed" || (submissionId !== undefined && (r.status === "needs_review" || r.status === "ready"));
        if (!retryable) continue;
        if (r.status === "needs_review" && r.error?.code === "not_accepted") continue;
        r.userApproved = true;
        r.attempts = 0;
        delete r.nextAttemptAt;
        delete r.error;
        r.status = r.details ? "ready" : "waiting_details";
        r.updatedAt = this.#now();
        n++;
      }
      return n;
    });
    await this.processQueue();
    return count;
  }

  async clearHistory(): Promise<void> {
    await this.#store.updateRecords((records) => {
      for (const [id, r] of Object.entries(records)) if (!ACTIVE.has(r.status)) delete records[id];
    });
  }

  async testConnection(): Promise<ConnectionState> {
    const settings = await this.#store.getSettings();
    const checkedAt = this.#now();
    let connection: ConnectionState;
    try {
      const client = await this.#client(settings);
      const repo = await client.getRepo();
      await client.getBranchHead(settings.branch);
      const branchIsDefault = repo.defaultBranch === settings.branch;
      let message = `Connected to ${repo.fullName} (${repo.isPrivate ? "private" : "public"}). Branch "${settings.branch}" exists.`;
      if (!branchIsDefault) {
        message += ` Note: the default branch is "${repo.defaultBranch}"; only commits there count toward your contribution graph.`;
      }
      if (repo.canPush === false) {
        message += " Your account cannot push to this repository.";
      }
      connection = {
        state: repo.canPush === false ? "error" : "ok",
        checkedAt,
        repoFullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
        isPrivate: repo.isPrivate,
        branchIsDefault,
        message,
      };
    } catch (err) {
      const info = toErrorInfo(err);
      connection = { state: "error", checkedAt, message: info.message, errorCode: info.code };
    }
    await this.#store.setConnection(connection);
    return connection;
  }

  async getPublicState(): Promise<PublicState> {
    const [settings, token, connection, records] = await Promise.all([
      this.#store.getSettings(),
      this.#store.getToken(),
      this.#store.getConnection(),
      this.#store.getRecords(),
    ]);
    const list = Object.values(records).sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      settings,
      hasToken: token !== undefined,
      connection,
      records: list.map(toPublic),
      counts: {
        synced: list.filter((r) => r.status === "synced").length,
        attention: list.filter((r) => r.status === "needs_review" || (r.status === "failed" && !r.nextAttemptAt)).length,
        pending: list.filter((r) => ACTIVE.has(r.status) || (r.status === "failed" && r.nextAttemptAt !== undefined)).length,
      },
    };
  }
}
