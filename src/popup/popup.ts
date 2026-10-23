import type { PageContext, ToContent } from "../lib/messages";
import type { PublicRecord, PublicState } from "../types";
import {
  callWorker,
  chip,
  el,
  fileUrl,
  loadState,
  problemLabel,
  relativeTime,
  repoUrl,
  statusLabel,
} from "../ui/shared";

const main = document.getElementById("main") as HTMLElement;
const connectionChip = document.getElementById("connection") as HTMLSpanElement;
const retryFailedBtn = document.getElementById("retry-failed") as HTMLButtonElement;
const settingsBtn = document.getElementById("open-settings") as HTMLButtonElement;

let state: PublicState | null = null;
let page: { tabId: number; context: PageContext } | null = null;
let pageMessage: { text: string; tone: "error" | "ok" } | null = null;

settingsBtn.addEventListener("click", () => void chrome.runtime.openOptionsPage());
retryFailedBtn.addEventListener("click", async () => {
  retryFailedBtn.disabled = true;
  await callWorker({ type: "sync:retry" });
  await refresh();
});

function openTab(url: string): void {
  void chrome.tabs.create({ url });
  window.close();
}

async function readPageContext(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return;
    const message: ToContent = { type: "page:context" };
    const context = (await chrome.tabs.sendMessage(tab.id, message)) as PageContext | undefined;
    if (context && typeof context.hookActive === "boolean") page = { tabId: tab.id, context };
  } catch {
    // Not a LeetCode tab (no content script there).
    page = null;
  }
}

function renderConnection(s: PublicState): void {
  connectionChip.className = "chip";
  if (!s.hasToken) {
    connectionChip.textContent = "Not connected";
    connectionChip.classList.add("warning");
  } else if (s.connection.state === "ok") {
    connectionChip.textContent = "Connected";
    connectionChip.classList.add("success");
  } else if (s.connection.state === "error") {
    connectionChip.textContent = "Connection problem";
    connectionChip.classList.add("danger");
  } else {
    connectionChip.textContent = "Not tested";
  }
  connectionChip.title = s.connection.message ?? "";
}

function recordActions(r: PublicRecord, s: PublicState): HTMLElement | null {
  const actions = el("div", { className: "actions" });
  const manual = s.settings.syncMode === "manual";
  if (r.status === "ready" && manual && !r.userApproved) {
    const btn = el("button", { className: "btn btn-primary btn-small", text: "Sync now", attrs: { type: "button" } });
    btn.addEventListener("click", () => void retry(r.submissionId, btn));
    actions.append(btn);
  }
  if (r.status === "failed" || (r.status === "needs_review" && r.error?.code !== "not_accepted")) {
    const btn = el("button", { className: "btn btn-small", text: "Retry", attrs: { type: "button" } });
    btn.addEventListener("click", () => void retry(r.submissionId, btn));
    actions.append(btn);
  }
  if (r.status === "synced" && r.path) {
    const path = r.path;
    const btn = el("button", { className: "btn btn-small", text: "View file", attrs: { type: "button" } });
    btn.addEventListener("click", () => openTab(fileUrl(s.settings.owner, s.settings.repo, s.settings.branch, path)));
    actions.append(btn);
  }
  if (r.commitUrl) {
    const url = r.commitUrl;
    const btn = el("button", { className: "btn btn-small", text: "View commit", attrs: { type: "button" } });
    btn.addEventListener("click", () => openTab(url));
    actions.append(btn);
  }
  return actions.childElementCount ? actions : null;
}

async function retry(submissionId: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  await callWorker({ type: "sync:retry", submissionId });
  await refresh();
}

function latestCard(s: PublicState): HTMLElement {
  const r = s.records[0];
  const card = el("section", { className: "card", attrs: { "aria-label": "Most recent submission" } });
  card.append(el("h2", { text: "Most recent" }));
  if (!r) {
    card.append(
      el("p", { className: "detail muted", text: "Waiting for an accepted submission. Solve a problem on leetcode.com and submit it; accepted solutions sync automatically." }),
    );
    return card;
  }
  const { label, tone } = statusLabel(r, s.settings.syncMode === "manual");
  card.append(
    el("div", { className: "title-line" }, el("span", { className: "problem", text: problemLabel(r) }), chip(label, tone)),
    el("p", {
      className: "detail muted",
      text: [r.langName, `#${r.submissionId}`, relativeTime(r.updatedAt)].filter(Boolean).join(" · "),
    }),
  );
  if (r.status === "synced" && r.path) card.append(el("p", { className: "detail mono", text: r.path }));
  if (r.warning) card.append(el("p", { className: "warning", text: r.warning }));
  if (r.error) card.append(el("p", { className: "error", text: r.error.message }));
  if (r.status === "failed" && r.nextAttemptAt) {
    card.append(el("p", { className: "detail muted", text: `Next attempt ${new Date(r.nextAttemptAt).toLocaleTimeString()}.` }));
  }
  card.append(recordActions(r, s) ?? "");
  return card;
}

function pageCard(s: PublicState): HTMLElement | null {
  if (!page) return null;
  const { context, tabId } = page;
  const candidate = context.urlSubmissionId ?? context.lastAcceptedId;
  const card = el("section", { className: "card", attrs: { "aria-label": "This LeetCode page" } });
  card.append(el("h2", { text: "This page" }));
  if (!context.hookActive) {
    card.append(
      el("p", {
        className: "warning",
        text: "Automatic detection is not active on this tab. Reload the page; if it stays inactive, LeetCode's page may have changed. You can still sync manually from a submission's page.",
      }),
    );
  }
  if (!candidate) {
    card.append(
      el("p", {
        className: "detail muted",
        text: context.titleSlug
          ? "Submit a solution to sync it. To sync an earlier accepted submission, open it from the Submissions tab."
          : "Open a LeetCode problem to sync your accepted submissions.",
      }),
    );
  } else {
    const known = s.records.find((r) => r.submissionId === candidate);
    const already = known?.status === "synced";
    card.append(
      el("p", {
        className: "detail",
        text: already ? `Submission #${candidate} is already synced.` : `Submission #${candidate} is open on this page.`,
      }),
    );
    if (!already) {
      const btn = el("button", { className: "btn btn-primary btn-small", text: "Sync this accepted submission", attrs: { type: "button" } });
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Reading from LeetCode…";
        try {
          const message: ToContent = { type: "page:sync", submissionId: candidate };
          const res = (await chrome.tabs.sendMessage(tabId, message)) as { ok: boolean; message: string } | undefined;
          pageMessage = res ? { text: res.message, tone: res.ok ? "ok" : "error" } : { text: "No response from the page. Reload it and try again.", tone: "error" };
        } catch {
          pageMessage = { text: "Could not reach the LeetCode page. Reload it and try again.", tone: "error" };
        }
        await refresh();
      });
      card.append(el("div", { className: "actions" }, btn));
    }
  }
  if (pageMessage) {
    card.append(el("p", { className: pageMessage.tone === "error" ? "error" : "detail muted", text: pageMessage.text }));
  }
  return card;
}

function historyList(s: PublicState): HTMLElement | null {
  const items = s.records.slice(1, 7);
  if (!items.length) return null;
  const list = el("ul");
  for (const r of items) {
    const { label, tone } = statusLabel(r, s.settings.syncMode === "manual");
    list.append(
      el(
        "li",
        {},
        el("span", { className: "name", text: problemLabel(r), attrs: { title: r.error?.message ?? r.path ?? "" } }),
        el("span", { className: "meta", text: relativeTime(r.updatedAt) }),
        chip(label, tone),
      ),
    );
  }
  return el("section", { className: "history", attrs: { "aria-label": "Recent syncs" } }, el("h2", { text: "Recent" }), list);
}

function setupView(): HTMLElement {
  const btn = el("button", { className: "btn btn-primary", text: "Open settings", attrs: { type: "button" } });
  btn.addEventListener("click", () => void chrome.runtime.openOptionsPage());
  return el(
    "section",
    { className: "setup" },
    el("strong", { text: "Connect your GitHub repository" }),
    el(
      "ol",
      {},
      el("li", { text: "Create the destination repository on GitHub (with a README)." }),
      el("li", { text: "Create a fine-grained token limited to that repository with Contents: Read and write." }),
      el("li", { text: "Paste it in Settings and test the connection." }),
    ),
    btn,
  );
}

function render(s: PublicState): void {
  renderConnection(s);
  retryFailedBtn.disabled = !s.records.some((r) => r.status === "failed");
  main.replaceChildren();

  if (!s.hasToken) {
    main.append(setupView());
    return;
  }

  const { owner, repo, branch } = s.settings;
  const openRepo = el("button", { className: "btn btn-small", text: "Open repo ↗", attrs: { type: "button" } });
  openRepo.addEventListener("click", () => openTab(repoUrl(owner, repo, branch)));
  main.append(
    el(
      "div",
      { className: "repo-row" },
      el("span", { className: "repo" }, el("strong", { text: `${owner}/${repo}` }), el("span", { className: "muted", text: ` · ${branch}` })),
      openRepo,
    ),
  );

  const toggle = el("input", { attrs: { type: "checkbox", id: "auto-sync" } });
  toggle.checked = s.settings.syncMode === "auto";
  toggle.addEventListener("change", async () => {
    toggle.disabled = true;
    await callWorker({ type: "settings:save", settings: { ...s.settings, syncMode: toggle.checked ? "auto" : "manual" } });
    await refresh();
  });
  main.append(
    el(
      "div",
      { className: "toggle-row" },
      el(
        "label",
        { className: "switch", attrs: { for: "auto-sync" } },
        toggle,
        el("span", { text: "Automatic sync" }),
      ),
      el("span", { className: "hint muted", text: toggle.checked ? "Syncs when accepted" : "You confirm each sync" }),
    ),
  );

  main.append(latestCard(s));
  const pc = pageCard(s);
  if (pc) main.append(pc);

  main.append(
    el(
      "div",
      { className: "stats" },
      el("div", { className: "stat" }, el("span", { className: "value", text: String(s.counts.synced) }), el("span", { className: "label", text: "Submissions synced" })),
      el(
        "div",
        { className: `stat${s.counts.attention ? " attention" : ""}` },
        el("span", { className: "value", text: String(s.counts.attention) }),
        el("span", { className: "label", text: "Need attention" }),
      ),
    ),
  );

  const history = historyList(s);
  if (history) main.append(history);
}

async function refresh(): Promise<void> {
  const [next] = await Promise.all([loadState(), readPageContext()]);
  state = next;
  if (!state) {
    main.replaceChildren(el("p", { className: "error", text: "Could not load the extension state. Reload the extension in chrome://extensions." }));
    return;
  }
  render(state);
}

void refresh();

// Live updates while the popup is open (sync results land in storage).
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") void refresh();
});
