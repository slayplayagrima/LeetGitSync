/*
 * Content script for codeforces.com. Watches the signed-in user's recent
 * submissions through the official Codeforces API and reports accepted ones
 * to the service worker. It never sees the GitHub token.
 */

import {
  CodeforcesWatcher,
  codeforcesProblemNumber,
  codeforcesRecordId,
  codeforcesSlug,
  detectHandle,
  extractSourceFromHtml,
  submissionPagePath,
  toSubmissionDetails,
  type CodeforcesSubmission,
} from "../lib/codeforces";
import { toErrorInfo } from "../lib/errors";
import { codeforcesLangSlug } from "../lib/languages";
import { log } from "../lib/log";
import type { CodeforcesConfig, CodeforcesToWorker } from "../lib/messages";
import { showToast } from "./toast";

async function send<T = unknown>(message: CodeforcesToWorker): Promise<T | undefined> {
  try {
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch {
    // Extension reloaded: this script is orphaned until the page reloads.
    return undefined;
  }
}

async function fetchJson(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(path, { credentials: "same-origin", signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(path: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(path, { credentials: "same-origin", signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the accepted code from the submission page and hands it to the service worker. */
async function readAndReport(sub: CodeforcesSubmission): Promise<boolean> {
  const submissionId = codeforcesRecordId(sub.id);
  let result: Extract<CodeforcesToWorker, { type: "codeforces:details" }>["result"];
  try {
    const html = await fetchText(submissionPagePath(sub.contestId as number, sub.id));
    const source = extractSourceFromHtml(html, sub.id);
    result = source.ok
      ? { ok: true, details: toSubmissionDetails(sub, source.code, codeforcesLangSlug(sub.programmingLanguage)) }
      : { ok: false, error: { code: "details_unavailable", message: source.reason, retryable: false } };
  } catch (err) {
    const info = toErrorInfo(err);
    result = {
      ok: false,
      error: { code: "details_unavailable", message: `Could not open the submission page (${info.message})`, retryable: false },
    };
  }
  await send({ type: "codeforces:details", submissionId, result });
  return result.ok;
}

void (async () => {
  const res = await send<{ ok: boolean; data?: CodeforcesConfig }>({ type: "codeforces:hello" });
  const config = res?.ok ? res.data : undefined;
  if (!config?.enabled || config.sinceMs === undefined) return;

  const handle = config.handle || detectHandle(document);
  if (!handle) return; // Not signed in and no handle configured: nothing to watch.

  const watcher = new CodeforcesWatcher({
    handle,
    sinceMs: config.sinceMs,
    fetchJson,
    schedule: (fn, ms) => setTimeout(fn, ms),
    onError: (message) => log.warn(message),
    onAccepted: async (sub) => {
      const contestId = sub.contestId as number;
      const number = codeforcesProblemNumber(contestId, sub.problem.index);
      const reply = await send<{ ok: boolean; data?: { created: boolean; needDetails: boolean } }>({
        type: "codeforces:detected",
        submissionId: codeforcesRecordId(sub.id),
        titleSlug: codeforcesSlug(contestId, sub.problem.index),
        title: sub.problem.name,
        frontendId: number,
      });
      if (!reply?.ok || !reply.data?.needDetails) return;
      const ok = await readAndReport(sub);
      showToast(
        ok ? "info" : "error",
        ok
          ? `Accepted: ${number}. ${sub.problem.name}. Code read by LeetGitSync.`
          : `Accepted: ${number}, but its code could not be read. Open LeetGitSync for details.`,
      );
    },
  });
  await watcher.check();
})();
