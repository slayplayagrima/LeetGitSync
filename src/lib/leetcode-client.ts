import type { SubmissionDetails } from "../types";
import { SyncError } from "./errors";
import { parseQuestion, parseSubmissionDetails, type QuestionInfo } from "./validation";

/*
 * LeetCode does not publish a documented API. This module uses the same
 * GraphQL endpoint the leetcode.com web app uses for the signed-in user:
 *   - submissionDetails(submissionId)  -> code, language, status, problem slug
 *   - question(titleSlug)              -> problem number, title, difficulty
 * All requests are same-origin from a leetcode.com page, at most a few per
 * accepted submission. If LeetCode changes these, only this file and the
 * parsers in validation.ts need updating.
 */

const SUBMISSION_DETAILS_QUERY = `query submissionDetails($submissionId: Int!) {
  submissionDetails(submissionId: $submissionId) {
    code
    timestamp
    statusCode
    runtimeDisplay
    memoryDisplay
    lang { name verboseName }
    question { questionId titleSlug }
  }
}`;

const QUESTION_QUERY = `query questionTitle($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    questionFrontendId
    title
    titleSlug
    difficulty
  }
}`;

const TIMEOUT_MS = 15_000;
const MAX_TRIES = 3;

export interface LeetCodeClientOptions {
  /** Base origin, normally https://leetcode.com. */
  origin: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Reads LeetCode's CSRF cookie, which its GraphQL endpoint expects as a header. */
  getCsrfToken?: () => string | undefined;
  sleep?: (ms: number) => Promise<void>;
}

export function readCsrfCookie(cookieString: string): string | undefined {
  for (const part of cookieString.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "csrftoken") return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export class LeetCodeClient {
  readonly #origin: string;
  readonly #fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly #getCsrf: () => string | undefined;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(opts: LeetCodeClientOptions) {
    this.#origin = opts.origin;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#getCsrf = opts.getCsrfToken ?? (() => undefined);
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async #graphql(operationName: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
    let lastError: SyncError | undefined;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const csrf = this.#getCsrf();
        if (csrf) headers["x-csrftoken"] = csrf;
        const res = await this.#fetch(`${this.#origin}/graphql/`, {
          method: "POST",
          headers,
          body: JSON.stringify({ operationName, query, variables }),
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          lastError = new SyncError("details_unavailable", `LeetCode is busy (HTTP ${res.status}).`);
        } else if (!res.ok) {
          throw new SyncError(
            "details_unavailable",
            `LeetCode refused the request (HTTP ${res.status}). Make sure you are signed in on leetcode.com.`,
            { retryable: false },
          );
        } else {
          return await res.json();
        }
      } catch (err) {
        if (err instanceof SyncError && !err.retryable) throw err;
        lastError =
          err instanceof SyncError
            ? err
            : new SyncError("details_unavailable", "Could not reach LeetCode to read the submission.");
      } finally {
        clearTimeout(timer);
      }
      if (attempt < MAX_TRIES) await this.#sleep(1000 * 2 ** (attempt - 1));
    }
    throw lastError ?? new SyncError("details_unavailable", "Could not read the submission from LeetCode.");
  }

  async getSubmissionDetails(submissionId: string): Promise<SubmissionDetails> {
    const raw = await this.#graphql("submissionDetails", SUBMISSION_DETAILS_QUERY, {
      submissionId: Number(submissionId),
    });
    const parsed = parseSubmissionDetails(raw, submissionId);
    if (!parsed.ok) throw new SyncError("details_unavailable", parsed.reason, { retryable: false });
    return parsed.value;
  }

  /** Problem number/title are optional extras; failures here never block a sync. */
  async getQuestion(titleSlug: string): Promise<QuestionInfo | null> {
    try {
      const raw = await this.#graphql("questionTitle", QUESTION_QUERY, { titleSlug });
      return parseQuestion(raw, titleSlug);
    } catch {
      return null;
    }
  }

  /** Submission details enriched with problem number, title and difficulty when available. */
  async getFullDetails(submissionId: string): Promise<SubmissionDetails> {
    const details = await this.getSubmissionDetails(submissionId);
    const question = await this.getQuestion(details.titleSlug);
    if (question?.frontendId) details.frontendId = question.frontendId;
    if (question?.title) details.title = question.title;
    if (question?.difficulty) details.difficulty = question.difficulty;
    return details;
  }
}
