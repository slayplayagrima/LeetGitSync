/*
 * Isolated-world content script for leetcode.com. Receives judge-status hints
 * from the page hook, confirms acceptance by reading the submission back from
 * LeetCode, and hands validated details to the service worker. It never sees
 * the GitHub token.
 */

import { AcceptedSubmissionTracker } from "../lib/detection";
import { toErrorInfo } from "../lib/errors";
import { LeetCodeClient, readCsrfCookie } from "../lib/leetcode-client";
import type { ContentToWorker, PageContext, ToContent } from "../lib/messages";
import { isValidSubmissionId, slugFromPath, submissionIdFromPath } from "../lib/validation";
import type { SubmissionDetails } from "../types";
import { showToast } from "./toast";

const client = new LeetCodeClient({
  origin: window.location.origin,
  getCsrfToken: () => readCsrfCookie(document.cookie),
});

/** Deduplicates repeated judge-status polls so each submission is handled once per page. */
const tracker = new AcceptedSubmissionTracker();
/** Detail fetches in flight, so duplicate requests share one fetch. */
const inFlight = new Map<string, Promise<void>>();
let lastAcceptedId: string | undefined;

async function send<T = unknown>(message: ContentToWorker): Promise<T | undefined> {
  try {
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch {
    // Extension reloaded or updated: this content script is orphaned until the page reloads.
    return undefined;
  }
}

function fetchAndReport(submissionId: string): Promise<void> {
  const existing = inFlight.get(submissionId);
  if (existing) return existing;
  const run = (async () => {
    try {
      const details = await client.getFullDetails(submissionId);
      await send({ type: "submission:details", submissionId, result: { ok: true, details } });
    } catch (err) {
      await send({ type: "submission:details", submissionId, result: { ok: false, error: toErrorInfo(err) } });
    } finally {
      inFlight.delete(submissionId);
    }
  })();
  inFlight.set(submissionId, run);
  return run;
}

async function onAccepted(submissionId: string, submittedSlug: string | undefined): Promise<void> {
  lastAcceptedId = submissionId;

  const titleSlug = submittedSlug ?? slugFromPath(window.location.pathname);
  if (!titleSlug) {
    showToast("error", "Accepted submission detected, but the problem could not be identified. Use “Sync this submission” in the extension popup.");
    return;
  }
  const res = await send<{ ok: boolean; data?: { needDetails: boolean; message: string } }>({
    type: "submission:accepted",
    submissionId,
    titleSlug,
    source: "auto",
  });
  if (!res?.ok || !res.data) {
    showToast("error", "Accepted submission detected, but LeetGitSync could not record it. Reload the page and try “Sync this submission”.");
    return;
  }
  if (res.data.needDetails) {
    showToast("info", "Accepted. Saving your solution to GitHub…");
    await fetchAndReport(submissionId);
  }
}

/** Explicit user request from the popup: read the submission first, then queue it under its real problem. */
async function manualSync(submissionId: string): Promise<{ ok: boolean; message: string }> {
  let details: SubmissionDetails;
  try {
    details = await client.getFullDetails(submissionId);
  } catch (err) {
    return { ok: false, message: toErrorInfo(err).message };
  }
  const res = await send<{ ok: boolean; data?: { needDetails: boolean; message: string } }>({
    type: "submission:accepted",
    submissionId,
    titleSlug: details.titleSlug,
    source: "manual",
  });
  if (!res?.ok || !res.data) return { ok: false, message: "The extension did not respond. Reload this page." };
  if (!res.data.needDetails) return { ok: true, message: res.data.message };
  await send({ type: "submission:details", submissionId, result: { ok: true, details } });
  return { ok: true, message: "Queued for sync." };
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const accepted = tracker.handle(event.data);
  if (accepted) void onAccepted(accepted.submissionId, accepted.titleSlug);
});

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const msg = raw as ToContent;
  switch (msg?.type) {
    case "toast":
      showToast(msg.kind, msg.message);
      return false;
    case "details:request":
      if (isValidSubmissionId(msg.submissionId)) void fetchAndReport(msg.submissionId);
      return false;
    case "page:context": {
      const context: PageContext = {
        hookActive: document.documentElement.hasAttribute("data-leetgitsync-hook"),
      };
      const slug = slugFromPath(window.location.pathname);
      const urlId = submissionIdFromPath(window.location.pathname);
      if (slug) context.titleSlug = slug;
      if (urlId) context.urlSubmissionId = urlId;
      if (lastAcceptedId) context.lastAcceptedId = lastAcceptedId;
      sendResponse(context);
      return false;
    }
    case "page:sync":
      if (!isValidSubmissionId(msg.submissionId)) {
        sendResponse({ ok: false, message: "Invalid submission id." });
        return false;
      }
      void manualSync(msg.submissionId).then(sendResponse);
      return true;
    default:
      return false;
  }
});

// Recover submissions whose details were never read (e.g. the tab reloaded mid-sync).
void (async () => {
  const res = await send<{ ok: boolean; data?: { pending: Array<{ submissionId: string }> } }>({ type: "content:hello" });
  for (const p of res?.data?.pending.slice(0, 5) ?? []) {
    if (isValidSubmissionId(p.submissionId)) await fetchAndReport(p.submissionId);
  }
})();
