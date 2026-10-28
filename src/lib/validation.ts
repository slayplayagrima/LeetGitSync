import type { FilenameStyle, HistoryPolicy, Settings, SubmissionDetails, SyncMode } from "../types";
import { cleanFolder, isSafeFolder } from "./filename";

/** LeetCode's status code for an accepted submission. */
export const ACCEPTED_STATUS_CODE = 10;

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,150}$/;

export function isValidSubmissionId(id: unknown): id is string {
  return typeof id === "string" && /^\d{1,20}$/.test(id);
}

export function isValidCodeforcesHandle(handle: unknown): handle is string {
  return typeof handle === "string" && /^[A-Za-z0-9_.-]{3,24}$/.test(handle);
}

export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === "string" && SLUG_RE.test(slug);
}

/** Git ref-name rules that matter for a branch typed by hand. */
export function isValidBranch(branch: string): boolean {
  if (!branch || branch.length > 250) return false;
  if (branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".") || branch.startsWith("-")) return false;
  if (branch.includes("..") || branch.includes("//") || branch.includes("@{") || branch === "@") return false;
  if (/[\x00-\x20~^:?*[\\\x7f]/.test(branch)) return false;
  return branch.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

export type SettingsErrors = Partial<Record<keyof Settings | "languageFolders", string>>;

export function validateSettings(s: Settings): SettingsErrors {
  const errors: SettingsErrors = {};
  if (!OWNER_RE.test(s.owner)) errors.owner = "Use a GitHub username or organization (letters, numbers and hyphens).";
  if (!REPO_RE.test(s.repo) || s.repo === "." || s.repo === "..") {
    errors.repo = "Use a repository name made of letters, numbers, '.', '-' or '_'.";
  }
  if (!isValidBranch(s.branch)) errors.branch = "This is not a valid branch name.";
  if (!isSafeFolder(cleanFolder(s.rootFolder))) {
    errors.rootFolder = "Use folder names made of letters, numbers, '.', '-' or '_', separated by '/'.";
  }
  for (const [key, folder] of Object.entries(s.languageFolders)) {
    const cleaned = cleanFolder(folder);
    if (cleaned === "" || !isSafeFolder(cleaned)) {
      errors.languageFolders = `The folder for "${key}" is empty or contains characters that are not allowed.`;
      break;
    }
  }
  if (s.codeforcesHandle !== "" && !isValidCodeforcesHandle(s.codeforcesHandle)) {
    errors.codeforcesHandle = "Use your Codeforces handle (3–24 letters, digits, '_', '-' or '.').";
  }
  const cfFolder = cleanFolder(s.codeforcesFolder);
  if (cfFolder === "" || !isSafeFolder(cfFolder)) {
    errors.codeforcesFolder = "Use a folder name made of letters, numbers, '.', '-' or '_'.";
  }
  if (!(["auto", "manual"] as SyncMode[]).includes(s.syncMode)) errors.syncMode = "Unknown sync mode.";
  if (!(["update", "separate"] as HistoryPolicy[]).includes(s.historyPolicy)) errors.historyPolicy = "Unknown policy.";
  if (!(["number-slug", "slug", "number-dot-slug"] as FilenameStyle[]).includes(s.filenameStyle)) {
    errors.filenameStyle = "Unknown filename style.";
  }
  return errors;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Validates LeetCode's `submissionDetails` GraphQL response. Field names were
 * checked against the live schema; values are still validated defensively.
 */
export function parseSubmissionDetails(raw: unknown, submissionId: string): ParseResult<SubmissionDetails> {
  const root = obj(raw);
  if (!root) return { ok: false, reason: "LeetCode returned an unreadable response." };
  if (Array.isArray(root.errors) && root.errors.length) {
    return { ok: false, reason: "LeetCode rejected the submission-details request. Its API may have changed." };
  }
  const node = obj(obj(root.data)?.submissionDetails);
  if (!node) {
    return {
      ok: false,
      reason: "LeetCode did not return details for this submission. Make sure you are signed in on leetcode.com.",
    };
  }

  const code = typeof node.code === "string" ? node.code : undefined;
  const lang = obj(node.lang);
  const question = obj(node.question);
  const langSlug = str(lang?.name);
  const titleSlug = str(question?.titleSlug);
  const timestamp = Number(node.timestamp);
  const statusCode = Number(node.statusCode);

  if (code === undefined) return { ok: false, reason: "The submission details did not include source code." };
  if (!langSlug) return { ok: false, reason: "The submission details did not include a language." };
  if (!titleSlug || !isValidSlug(titleSlug)) return { ok: false, reason: "The submission details did not include a valid problem." };
  if (!Number.isFinite(timestamp) || timestamp <= 0) return { ok: false, reason: "The submission details had no valid timestamp." };
  if (!Number.isFinite(statusCode)) return { ok: false, reason: "The submission details had no status." };

  const details: SubmissionDetails = {
    submissionId,
    code,
    langSlug,
    langName: str(lang?.verboseName) ?? langSlug,
    timestamp,
    statusCode,
    titleSlug,
  };
  const runtime = str(node.runtimeDisplay);
  const memory = str(node.memoryDisplay);
  const questionId = str(question?.questionId);
  if (runtime) details.runtime = runtime;
  if (memory) details.memory = memory;
  if (questionId) details.questionId = questionId;
  return { ok: true, value: details };
}

export interface QuestionInfo {
  frontendId?: string;
  title?: string;
  difficulty?: string;
}

/** Validates LeetCode's public `question(titleSlug)` GraphQL response. */
export function parseQuestion(raw: unknown, titleSlug: string): QuestionInfo | null {
  const q = obj(obj(obj(raw)?.data)?.question);
  if (!q || q.titleSlug !== titleSlug) return null;
  const info: QuestionInfo = {};
  const frontendId = str(q.questionFrontendId);
  const title = str(q.title);
  const difficulty = str(q.difficulty);
  if (frontendId) info.frontendId = frontendId;
  if (title) info.title = title;
  if (difficulty) info.difficulty = difficulty;
  return info;
}

export interface CheckResult {
  submissionId: string;
  finished: boolean;
  accepted: boolean;
}

/**
 * Interprets the payload the page hook relays from LeetCode's
 * `/submissions/detail/<id>/v2/check/` (or legacy `/check/`) polling. Only a finished judge result with
 * the Accepted status counts; pending, wrong-answer, error and "Run code"
 * results never do.
 */
export function parseCheckPayload(raw: unknown): CheckResult | null {
  const p = obj(raw);
  if (!p) return null;
  const submissionId = typeof p.submissionId === "string" ? p.submissionId : undefined;
  if (!isValidSubmissionId(submissionId)) return null;
  const state = p.state;
  const finished = state === "SUCCESS" || p.finished === true;
  // The v2 endpoint may omit status_msg; status_code 10 is authoritative. Acceptance is
  // re-confirmed from the submission record before anything is saved.
  const accepted =
    state === "SUCCESS" &&
    Number(p.statusCode) === ACCEPTED_STATUS_CODE &&
    (p.statusMsg === undefined || p.statusMsg === "Accepted");
  return { submissionId, finished, accepted };
}

/** Extracts the problem slug from a LeetCode URL path such as /problems/two-sum/description/. */
export function slugFromPath(pathname: string): string | undefined {
  const match = /^\/problems\/([a-z0-9-]+)(?:\/|$)/.exec(pathname);
  return match?.[1] && isValidSlug(match[1]) ? match[1] : undefined;
}

/** Extracts a submission id from /problems/<slug>/submissions/<id>/ or /submissions/detail/<id>/. */
export function submissionIdFromPath(pathname: string): string | undefined {
  const match = /\/submissions\/(?:detail\/)?(\d{1,20})(?:\/|$)/.exec(pathname);
  return match?.[1];
}
