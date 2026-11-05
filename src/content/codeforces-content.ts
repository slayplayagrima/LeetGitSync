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
} from "../lib/codeforces";
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
      const reply = await send<{ ok: boolean; data?: { created: boolean } }>({
        type: "codeforces:detected",
        submissionId: codeforcesRecordId(sub.id),
        titleSlug: codeforcesSlug(contestId, sub.problem.index),
        title: sub.problem.name,
        frontendId: number,
      });
      if (reply?.ok && reply.data?.created) {
        showToast("info", `Accepted: ${number}. ${sub.problem.name}. Detected by LeetGitSync.`);
      }
    },
  });
  await watcher.check();
})();
