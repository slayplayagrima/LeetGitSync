import { toErrorInfo } from "../lib/errors";
import { log } from "../lib/log";
import type { ContentToWorker, PageToWorker, ToContent, WorkerMessage } from "../lib/messages";
import { chromeLocalStore, StateStore } from "../lib/storage";
import { SyncService, type SyncEvent } from "../lib/sync-service";
import { isValidSubmissionId, validateSettings } from "../lib/validation";
import type { Settings } from "../types";

const LEETCODE_ORIGIN = "https://leetcode.com";
const RETRY_ALARM = "leetgitsync-retry";
const TAB_KEY = "leetcodeTabs";
const SUBMISSION_TAB_KEY = "submissionTabs";

// Keep the token away from content scripts where Chrome supports it.
try {
  void chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => undefined);
} catch {
  // Older Chrome: content scripts here never read storage anyway.
}

const store = new StateStore(chromeLocalStore());
const service = new SyncService({
  store,
  notify: (event) => void handleEvent(event),
  scheduleWake: (when) => {
    void chrome.alarms.create(RETRY_ALARM, { when: Math.max(when, Date.now() + 30_000) });
  },
});

// ------------------------------------------------------------------ tabs

/** LeetCode tabs with a live content script, kept in session storage so a worker restart does not lose them. */
async function getTabs(): Promise<number[]> {
  const got = await chrome.storage.session.get(TAB_KEY);
  const tabs = got[TAB_KEY];
  return Array.isArray(tabs) ? tabs.filter((t): t is number => typeof t === "number") : [];
}

async function addTab(tabId: number): Promise<void> {
  const tabs = new Set(await getTabs());
  tabs.add(tabId);
  await chrome.storage.session.set({ [TAB_KEY]: [...tabs] });
}

async function removeTab(tabId: number): Promise<void> {
  const tabs = (await getTabs()).filter((t) => t !== tabId);
  await chrome.storage.session.set({ [TAB_KEY]: tabs });
}

async function rememberSubmissionTab(submissionId: string, tabId: number): Promise<void> {
  const got = await chrome.storage.session.get(SUBMISSION_TAB_KEY);
  const map = (got[SUBMISSION_TAB_KEY] as Record<string, number> | undefined) ?? {};
  map[submissionId] = tabId;
  const entries = Object.entries(map).slice(-50);
  await chrome.storage.session.set({ [SUBMISSION_TAB_KEY]: Object.fromEntries(entries) });
}

async function tabForSubmission(submissionId: string): Promise<number | undefined> {
  const got = await chrome.storage.session.get(SUBMISSION_TAB_KEY);
  const map = got[SUBMISSION_TAB_KEY] as Record<string, number> | undefined;
  return map?.[submissionId];
}

async function sendToTab(tabId: number, message: ToContent): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    await removeTab(tabId);
    return false;
  }
}

/** Asks any open LeetCode tab to read details for submissions still waiting on them. */
async function requestPendingDetails(): Promise<void> {
  const pending = await service.pendingDetailRequests();
  if (pending.length === 0) return;
  for (const tabId of await getTabs()) {
    let delivered = true;
    for (const p of pending) {
      delivered = await sendToTab(tabId, { type: "details:request", ...p });
      if (!delivered) break;
    }
    if (delivered) return;
  }
}

chrome.tabs.onRemoved.addListener((tabId) => void removeTab(tabId));

// ------------------------------------------------------------------ feedback

async function updateBadge(): Promise<void> {
  try {
    const state = await service.getPublicState();
    const syncing = state.records.some((r) => r.status === "syncing" || r.status === "waiting_details");
    if (state.counts.attention > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: "#C62828" });
      await chrome.action.setBadgeText({ text: String(Math.min(state.counts.attention, 99)) });
    } else if (syncing) {
      await chrome.action.setBadgeBackgroundColor({ color: "#1F6FEB" });
      await chrome.action.setBadgeText({ text: "…" });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch (err) {
    log.warn("Could not update badge", err);
  }
}

async function handleEvent(event: SyncEvent): Promise<void> {
  await updateBadge();
  if (!event.submissionId) return;
  const tabId = await tabForSubmission(event.submissionId);
  if (tabId !== undefined) await sendToTab(tabId, { type: "toast", kind: event.kind, message: event.message });
}

// ------------------------------------------------------------------ messages

function isFromLeetCode(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || !sender.url) return false;
  try {
    return new URL(sender.url).origin === LEETCODE_ORIGIN;
  } catch {
    return false;
  }
}

function isFromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

const FINE_GRAINED_TOKEN = /^github_pat_[A-Za-z0-9_]{20,255}$/;

async function handleContent(msg: ContentToWorker, tabId: number): Promise<unknown> {
  switch (msg.type) {
    case "content:hello": {
      await addTab(tabId);
      const pending = await service.pendingDetailRequests();
      return { ok: true, data: { pending } };
    }
    case "submission:accepted": {
      await addTab(tabId);
      await rememberSubmissionTab(msg.submissionId, tabId);
      const res = await service.reportAccepted({
        submissionId: msg.submissionId,
        titleSlug: msg.titleSlug,
        source: msg.source === "manual" ? "manual" : "auto",
      });
      await updateBadge();
      return { ok: true, data: res };
    }
    case "submission:details": {
      if (!isValidSubmissionId(msg.submissionId)) return { ok: false, error: "Invalid submission id." };
      await rememberSubmissionTab(msg.submissionId, tabId);
      await service.reportDetails(msg.submissionId, msg.result);
      await updateBadge();
      return { ok: true, data: undefined };
    }
  }
}

function connectionFieldsChanged(a: Settings, b: Settings): boolean {
  return a.owner !== b.owner || a.repo !== b.repo || a.branch !== b.branch;
}

async function handlePage(msg: PageToWorker): Promise<unknown> {
  switch (msg.type) {
    case "state:get":
      return { ok: true, data: await service.getPublicState() };
    case "settings:save": {
      const fieldErrors = validateSettings(msg.settings);
      if (Object.keys(fieldErrors).length) return { ok: false, error: "Some settings are invalid.", fieldErrors };
      const previous = await store.getSettings();
      await store.saveSettings(msg.settings);
      if (connectionFieldsChanged(previous, msg.settings)) await store.setConnection({ state: "unknown" });
      void service.processQueue().then(updateBadge);
      return { ok: true, data: undefined };
    }
    case "token:set": {
      const token = typeof msg.token === "string" ? msg.token.trim() : "";
      if (!FINE_GRAINED_TOKEN.test(token)) {
        return {
          ok: false,
          error: 'That does not look like a fine-grained personal access token (it should start with "github_pat_").',
        };
      }
      await store.setToken(token);
      await store.setConnection({ state: "unknown" });
      return { ok: true, data: undefined };
    }
    case "token:remove":
    case "github:disconnect":
      await store.removeToken();
      await store.setConnection({ state: "unknown", message: "Disconnected. No token is stored." });
      return { ok: true, data: undefined };
    case "connection:test":
      return { ok: true, data: await service.testConnection() };
    case "sync:retry": {
      const count = await service.retry(msg.submissionId);
      await requestPendingDetails();
      await updateBadge();
      return { ok: true, data: count };
    }
    case "history:clear":
      await service.clearHistory();
      await updateBadge();
      return { ok: true, data: undefined };
  }
}

const CONTENT_TYPES = new Set(["content:hello", "submission:accepted", "submission:details"]);

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const msg = raw as WorkerMessage;
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return false;

  let work: Promise<unknown>;
  if (CONTENT_TYPES.has(msg.type)) {
    if (!isFromLeetCode(sender)) return false;
    work = handleContent(msg as ContentToWorker, sender.tab!.id!);
  } else if (isFromExtensionPage(sender)) {
    work = handlePage(msg as PageToWorker);
  } else {
    return false;
  }

  work
    .then(sendResponse)
    .catch((err: unknown) => {
      const info = toErrorInfo(err);
      log.error(`Message ${msg.type} failed`, info.message);
      sendResponse({ ok: false, error: info.message });
    });
  return true;
});

// ------------------------------------------------------------------ lifecycle

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) void service.processQueue().then(updateBadge);
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") void chrome.runtime.openOptionsPage();
});

// Every time the worker starts, nothing is in flight in memory, so any record
// still marked "syncing" was interrupted. Recover it and pick up due retries.
void service.recover().then(updateBadge);
