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
  parseUserStatus,
  submissionFromPath,
  submissionPagePath,
  toSubmissionDetails,
  type CodeforcesSubmission,
} from "../lib/codeforces";
import { toErrorInfo } from "../lib/errors";
import { codeforcesLangSlug } from "../lib/languages";
import { log } from "../lib/log";
import type { CodeforcesConfig, CodeforcesToWorker, PageContext, ToContent } from "../lib/messages";
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

let config: CodeforcesConfig | undefined;

function detectedMessage(sub: CodeforcesSubmission, source: "auto" | "manual"): CodeforcesToWorker {
  const contestId = sub.contestId as number;
  return {
    type: "codeforces:detected",
    submissionId: codeforcesRecordId(sub.id),
    titleSlug: codeforcesSlug(contestId, sub.problem.index),
    title: sub.problem.name,
    frontendId: codeforcesProblemNumber(contestId, sub.problem.index),
    source,
  };
}

/** Explicit request from the popup to sync the submission open on this page. */
async function manualSync(contestId: number, id: number): Promise<{ ok: boolean; message: string }> {
  if (!config?.enabled) return { ok: false, message: "Turn on Codeforces in LeetGitSync settings first." };
  const handle = config.handle || detectHandle(document);
  if (!handle) return { ok: false, message: "Sign in on codeforces.com, or set your handle in LeetGitSync settings." };

  let subs;
  try {
    subs = parseUserStatus(
      await fetchJson(`/api/contest.status?contestId=${contestId}&handle=${encodeURIComponent(handle)}&from=1&count=200`),
    );
  } catch {
    return { ok: false, message: "Could not reach the Codeforces API. Try again in a moment." };
  }
  const sub = subs?.find((s) => s.id === id);
  if (!sub) return { ok: false, message: `This submission is not among ${handle}'s recent submissions in this contest.` };
  if (sub.verdict !== "OK") return { ok: false, message: "Only accepted submissions can be synced." };

  const reply = await send<{ ok: boolean; error?: string; data?: { needDetails: boolean; message?: string } }>(
    detectedMessage(sub, "manual"),
  );
  if (!reply?.ok || !reply.data) return { ok: false, message: reply?.error ?? "The extension did not respond. Reload this page." };
  if (!reply.data.needDetails) return { ok: true, message: reply.data.message ?? "Queued for sync." };
  const read = await readAndReport(sub);
  return read
    ? { ok: true, message: "Code read. Saving to GitHub…" }
    : { ok: false, message: "The code could not be read. Open LeetGitSync for details." };
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const msg = raw as ToContent;
  const current = submissionFromPath(window.location.pathname);
  switch (msg?.type) {
    case "toast":
      showToast(msg.kind, msg.message);
      return false;
    case "page:context": {
      const context: PageContext = { platform: "codeforces", hookActive: true, codeforcesEnabled: config?.enabled === true };
      if (current) context.urlSubmissionId = codeforcesRecordId(current.id);
      sendResponse(context);
      return false;
    }
    case "page:sync":
      if (!current || msg.submissionId !== codeforcesRecordId(current.id)) {
        sendResponse({ ok: false, message: "Open the submission's page on codeforces.com first." });
        return false;
      }
      void manualSync(current.contestId, current.id).then(sendResponse);
      return true;
    default:
      return false;
  }
});

void (async () => {
  const res = await send<{ ok: boolean; data?: CodeforcesConfig }>({ type: "codeforces:hello" });
  config = res?.ok ? res.data : undefined;
  if (!config?.enabled || config.sinceMs === undefined) return;

  const handle = config.handle || detectHandle(document);
  if (!handle) {
    // Not signed in and no handle configured: nothing to watch.
    await send({ type: "codeforces:status", ok: false, message: "Not signed in on codeforces.com, and no handle is set." });
    return;
  }

  const watcher = new CodeforcesWatcher({
    handle,
    sinceMs: config.sinceMs,
    fetchJson,
    schedule: (fn, ms) => setTimeout(fn, ms),
    onError: (message) => log.warn(message),
    onChecked: (ok, message) => void send({ type: "codeforces:status", handle, ok, ...(message ? { message } : {}) }),
    onAccepted: async (sub) => {
      const number = codeforcesProblemNumber(sub.contestId as number, sub.problem.index);
      const reply = await send<{ ok: boolean; data?: { created: boolean; needDetails: boolean } }>(detectedMessage(sub, "auto"));
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
