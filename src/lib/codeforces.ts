/*
 * Codeforces support. Detection uses the official, documented public API
 * (https://codeforces.com/apiHelp/methods#user.status), which lists a user's
 * submissions with their verdicts. It is called from codeforces.com pages, at
 * most once per page load plus a short, bounded poll while a submission is
 * still being judged, well under the API's limit of one call per two seconds.
 */

import type { SubmissionDetails } from "../types";
import { ACCEPTED_STATUS_CODE, isValidCodeforcesHandle } from "./validation";

export interface CodeforcesSubmission {
  id: number;
  contestId?: number;
  creationTimeSeconds: number;
  problem: {
    contestId?: number;
    index: string;
    name: string;
    rating?: number;
    tags: string[];
  };
  programmingLanguage: string;
  /** Missing while the submission is queued; "TESTING" while it runs. */
  verdict?: string;
  timeConsumedMillis?: number;
  memoryConsumedBytes?: number;
}

const RECORD_PREFIX = "cf-";

/** Codeforces ids are namespaced so they can never collide with LeetCode ids. */
export function codeforcesRecordId(id: number | string): string {
  return `${RECORD_PREFIX}${id}`;
}

export function isCodeforcesRecordId(id: unknown): id is string {
  return typeof id === "string" && /^cf-\d{1,20}$/.test(id);
}

/** The numeric Codeforces submission id behind a record id. */
export function rawCodeforcesId(recordId: string): string {
  return recordId.startsWith(RECORD_PREFIX) ? recordId.slice(RECORD_PREFIX.length) : recordId;
}

/** Problem key used as the record's slug, e.g. contest 1850 problem A -> "1850-a". */
export function codeforcesSlug(contestId: number, index: string): string {
  return `${contestId}-${index}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

/** Display number, e.g. "1850A". */
export function codeforcesProblemNumber(contestId: number, index: string): string {
  return `${contestId}${index}`;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function parseSubmission(raw: unknown): CodeforcesSubmission | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const p = (s.problem ?? {}) as Record<string, unknown>;
  const id = num(s.id);
  const created = num(s.creationTimeSeconds);
  const index = str(p.index);
  const name = str(p.name);
  const lang = str(s.programmingLanguage);
  if (id === undefined || created === undefined || !index || !name || !lang) return null;

  const sub: CodeforcesSubmission = {
    id,
    creationTimeSeconds: created,
    problem: {
      index,
      name,
      tags: Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === "string") : [],
    },
    programmingLanguage: lang,
  };
  const contestId = num(s.contestId) ?? num(p.contestId);
  if (contestId !== undefined) {
    sub.contestId = contestId;
    sub.problem.contestId = contestId;
  }
  const rating = num(p.rating);
  if (rating !== undefined) sub.problem.rating = rating;
  const verdict = str(s.verdict);
  if (verdict) sub.verdict = verdict;
  const time = num(s.timeConsumedMillis);
  const memory = num(s.memoryConsumedBytes);
  if (time !== undefined) sub.timeConsumedMillis = time;
  if (memory !== undefined) sub.memoryConsumedBytes = memory;
  return sub;
}

/** Validates a `user.status` response. Malformed entries are dropped, never guessed. */
export function parseUserStatus(raw: unknown): CodeforcesSubmission[] | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { status?: unknown; result?: unknown };
  if (r.status !== "OK" || !Array.isArray(r.result)) return null;
  return r.result.map(parseSubmission).filter((s): s is CodeforcesSubmission => s !== null);
}

export function isFinalVerdict(verdict: string | undefined): boolean {
  return verdict !== undefined && verdict !== "TESTING";
}

function isSince(sub: CodeforcesSubmission, sinceMs: number): boolean {
  return sub.creationTimeSeconds * 1000 >= sinceMs;
}

/** Accepted submissions made after sync was turned on. Problems without a contest are skipped. */
export function selectNewAccepted(subs: CodeforcesSubmission[], sinceMs: number): CodeforcesSubmission[] {
  return subs.filter((s) => s.verdict === "OK" && s.contestId !== undefined && isSince(s, sinceMs));
}

/** True while a submission made after `sinceMs` is still queued or being judged. */
export function hasPending(subs: CodeforcesSubmission[], sinceMs: number): boolean {
  return subs.some((s) => isSince(s, sinceMs) && !isFinalVerdict(s.verdict));
}

/** Reads the signed-in handle from the Codeforces page header, if present. */
export function detectHandle(doc: Pick<Document, "querySelector">): string | undefined {
  const link = doc.querySelector('.lang-chooser a[href^="/profile/"]');
  const handle = link?.getAttribute("href")?.slice("/profile/".length);
  return isValidCodeforcesHandle(handle) ? handle : undefined;
}

export interface WatcherDeps {
  handle: string;
  sinceMs: number;
  /** GET a same-origin Codeforces API path and return parsed JSON. */
  fetchJson: (path: string) => Promise<unknown>;
  schedule: (fn: () => void, ms: number) => void;
  onAccepted: (sub: CodeforcesSubmission) => void | Promise<void>;
  onError?: (message: string) => void;
}

export const POLL_INTERVAL_MS = 5_000;
export const MAX_POLLS = 36;

/**
 * Checks the user's latest submissions once, and keeps checking every few
 * seconds (bounded) while one is still being judged. Each accepted submission
 * is reported at most once per watcher.
 */
export class CodeforcesWatcher {
  readonly #deps: WatcherDeps;
  readonly #reported = new Set<number>();
  #polls = 0;
  #running = false;

  constructor(deps: WatcherDeps) {
    this.#deps = deps;
  }

  get polls(): number {
    return this.#polls;
  }

  async check(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    let subs: CodeforcesSubmission[] | null = null;
    try {
      const path = `/api/user.status?handle=${encodeURIComponent(this.#deps.handle)}&from=1&count=10`;
      subs = parseUserStatus(await this.#deps.fetchJson(path));
      if (!subs) this.#deps.onError?.("Codeforces returned an unexpected response for your recent submissions.");
    } catch {
      this.#deps.onError?.("Could not reach the Codeforces API to check your submissions.");
    } finally {
      this.#running = false;
    }
    if (!subs) return;

    for (const sub of selectNewAccepted(subs, this.#deps.sinceMs)) {
      if (this.#reported.has(sub.id)) continue;
      this.#reported.add(sub.id);
      await this.#deps.onAccepted(sub);
    }

    if (hasPending(subs, this.#deps.sinceMs) && this.#polls < MAX_POLLS) {
      this.#polls++;
      this.#deps.schedule(() => void this.check(), POLL_INTERVAL_MS);
    }
  }
}

// ---------------------------------------------------------------- source code

/**
 * The submission page is the only place Codeforces exposes source code; the
 * API does not. The code sits in <pre id="program-source-text"> as escaped
 * text (syntax highlighting is applied later in the browser), so it can be
 * read from the raw HTML without running the page.
 */
export function submissionPagePath(contestId: number, id: number | string): string {
  const section = contestId >= 100000 ? "gym" : "contest";
  return `/${section}/${contestId}/submission/${id}`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

export type SourceResult = { ok: true; code: string } | { ok: false; reason: string };

/** Extracts the submitted code from a Codeforces submission page's HTML. */
export function extractSourceFromHtml(html: string, submissionId: number | string): SourceResult {
  if (/<title>\s*Just a moment/i.test(html) || html.includes("challenge-platform")) {
    return {
      ok: false,
      reason: "Codeforces showed a security check instead of the submission. Open codeforces.com, complete the check, then reload the page.",
    };
  }
  const match = /<pre[^>]*\bid=["']program-source-text["'][^>]*>([\s\S]*?)<\/pre>/i.exec(html);
  if (!match) {
    return {
      ok: false,
      reason: "The submission page did not include the source code. Make sure you are signed in on codeforces.com as the author.",
    };
  }
  if (!html.includes(String(submissionId))) {
    return { ok: false, reason: "Codeforces returned a page for a different submission." };
  }
  const raw = match[1] ?? "";
  if (/<[a-z]/i.test(raw)) {
    // Markup inside the code block means the page format changed; do not guess.
    return { ok: false, reason: "The submission page format has changed, so the code could not be read safely." };
  }
  const code = decodeHtmlEntities(raw).replace(/\r\n/g, "\n");
  if (code.trim() === "") return { ok: false, reason: "The submission page showed empty source code." };
  return { ok: true, code };
}

function formatMemory(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** Combines API metadata with the code read from the page into the shared details shape. */
export function toSubmissionDetails(sub: CodeforcesSubmission, code: string, langSlug: string): SubmissionDetails {
  const contestId = sub.contestId as number;
  const details: SubmissionDetails = {
    platform: "codeforces",
    submissionId: codeforcesRecordId(sub.id),
    code,
    langSlug,
    langName: sub.programmingLanguage,
    timestamp: sub.creationTimeSeconds,
    // Only "OK" verdicts reach this point; reuse the shared "accepted" status code.
    statusCode: sub.verdict === "OK" ? ACCEPTED_STATUS_CODE : -1,
    titleSlug: codeforcesSlug(contestId, sub.problem.index),
    frontendId: codeforcesProblemNumber(contestId, sub.problem.index),
    title: sub.problem.name,
    contestId,
  };
  if (sub.timeConsumedMillis !== undefined) details.runtime = `${sub.timeConsumedMillis} ms`;
  if (sub.memoryConsumedBytes !== undefined) details.memory = formatMemory(sub.memoryConsumedBytes);
  if (sub.problem.rating !== undefined) details.rating = sub.problem.rating;
  return details;
}
