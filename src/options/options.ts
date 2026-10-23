import { buildPaths } from "../lib/filename";
import { DEFAULT_FOLDER_KEYS, folderKeyLabel } from "../lib/languages";
import type { SettingsErrors } from "../lib/validation";
import type { ConnectionState, FilenameStyle, HistoryPolicy, PublicState, Settings, SyncMode } from "../types";
import { callWorker, chip, el, fileUrl, loadState, problemLabel, relativeTime, statusLabel } from "../ui/shared";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const inputs = {
  owner: $<HTMLInputElement>("owner"),
  repo: $<HTMLInputElement>("repo"),
  branch: $<HTMLInputElement>("branch"),
  rootFolder: $<HTMLInputElement>("rootFolder"),
  filenameStyle: $<HTMLSelectElement>("filenameStyle"),
  includeHeader: $<HTMLInputElement>("includeHeader"),
  metadataSidecar: $<HTMLInputElement>("metadataSidecar"),
};
const langFoldersEl = $<HTMLDivElement>("language-folders");
const pathPreview = $<HTMLElement>("path-preview");
const saveMsg = $<HTMLSpanElement>("save-msg");
const tokenInput = $<HTMLInputElement>("token");
const tokenState = $<HTMLParagraphElement>("token-state");
const tokenMsg = $<HTMLParagraphElement>("token-msg");
const connectionBox = $<HTMLDivElement>("connection-status");
const historyBody = $<HTMLTableSectionElement>("history-body");

let state: PublicState | null = null;
let dirty = false;

function radioValue<T extends string>(name: string): T {
  return (document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? "") as T;
}

function setRadio(name: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

function setMessage(target: HTMLElement, text: string, tone: "ok" | "error" | "" = ""): void {
  target.textContent = text;
  target.className = `inline-msg ${tone}`.trim();
}

function readForm(): Settings {
  const base = state?.settings;
  const languageFolders: Record<string, string> = {};
  for (const input of langFoldersEl.querySelectorAll<HTMLInputElement>("input[data-key]")) {
    const key = input.dataset.key as string;
    const value = input.value.trim();
    if (value !== "" && value !== key) languageFolders[key] = value;
  }
  return {
    owner: inputs.owner.value.trim(),
    repo: inputs.repo.value.trim(),
    branch: inputs.branch.value.trim(),
    syncMode: radioValue<SyncMode>("syncMode") || base?.syncMode || "auto",
    historyPolicy: radioValue<HistoryPolicy>("historyPolicy") || base?.historyPolicy || "update",
    rootFolder: inputs.rootFolder.value.trim(),
    filenameStyle: inputs.filenameStyle.value as FilenameStyle,
    languageFolders,
    includeHeader: inputs.includeHeader.checked,
    metadataSidecar: inputs.metadataSidecar.checked,
  };
}

function fillForm(s: Settings): void {
  inputs.owner.value = s.owner;
  inputs.repo.value = s.repo;
  inputs.branch.value = s.branch;
  inputs.rootFolder.value = s.rootFolder;
  inputs.filenameStyle.value = s.filenameStyle;
  inputs.includeHeader.checked = s.includeHeader;
  inputs.metadataSidecar.checked = s.metadataSidecar;
  setRadio("syncMode", s.syncMode);
  setRadio("historyPolicy", s.historyPolicy);

  langFoldersEl.replaceChildren();
  for (const key of DEFAULT_FOLDER_KEYS) {
    const input = el("input", { attrs: { "data-key": key, autocomplete: "off", spellcheck: "false", placeholder: key } });
    input.value = s.languageFolders[key] ?? key;
    langFoldersEl.append(el("label", {}, el("span", { text: folderKeyLabel(key) }), input));
  }
  $("guide-repo").textContent = s.repo || "leetcode-solutions";
  updatePreview();
}

function updatePreview(): void {
  const s = readForm();
  try {
    const { path, metadataPath } = buildPaths(s, {
      titleSlug: "two-sum",
      frontendId: "1",
      langSlug: "python3",
      submissionId: "123456789",
    });
    pathPreview.textContent = s.metadataSidecar ? `${path}  +  ${metadataPath}` : path;
  } catch (err) {
    pathPreview.textContent = err instanceof Error ? err.message : "Invalid settings";
  }
}

function showFieldErrors(errors: SettingsErrors): void {
  for (const small of document.querySelectorAll<HTMLElement>(".field-error")) {
    const key = small.dataset.for as keyof SettingsErrors;
    small.textContent = errors[key] ?? "";
    const input = document.getElementById(key);
    if (input instanceof HTMLInputElement) input.setAttribute("aria-invalid", errors[key] ? "true" : "false");
  }
}

function renderConnection(s: PublicState): void {
  const c: ConnectionState = s.connection;
  connectionBox.className = "status-box";
  connectionBox.replaceChildren();
  if (!s.hasToken) {
    connectionBox.append(chip("Not connected", "warning"), document.createTextNode(c.message ?? "Add a token below to connect."));
    return;
  }
  if (c.state === "ok") {
    connectionBox.classList.add("ok");
    connectionBox.append(chip("Connected", "success"), document.createTextNode(c.message ?? ""));
  } else if (c.state === "error") {
    connectionBox.classList.add("error");
    connectionBox.append(chip("Connection problem", "danger"), document.createTextNode(c.message ?? ""));
  } else {
    connectionBox.append(chip("Not tested", "neutral"), document.createTextNode("A token is saved. Click “Test connection” to check access."));
  }
  if (c.checkedAt) {
    connectionBox.append(el("span", { className: "hint", text: `Checked ${relativeTime(c.checkedAt)}` }));
  }
}

function renderToken(s: PublicState): void {
  tokenState.textContent = s.hasToken
    ? "A token is saved in this browser. It is never shown again; paste a new one to replace it."
    : "No token saved.";
  $<HTMLButtonElement>("remove-token").disabled = !s.hasToken;
  $<HTMLButtonElement>("disconnect").disabled = !s.hasToken;
  $<HTMLButtonElement>("test-connection").disabled = !s.hasToken;
}

function renderHistory(s: PublicState): void {
  historyBody.replaceChildren();
  $<HTMLButtonElement>("retry-all").disabled = !s.records.some((r) => r.status === "failed");
  $<HTMLButtonElement>("clear-history").disabled = s.records.length === 0;
  if (!s.records.length) {
    historyBody.append(el("tr", { className: "empty-row" }, el("td", { text: "No submissions yet.", attrs: { colspan: "5" } })));
    return;
  }
  for (const r of s.records) {
    const { label, tone } = statusLabel(r, s.settings.syncMode === "manual");
    const problem = el("td", {}, el("span", { text: problemLabel(r) }), el("span", { className: "sub", text: `#${r.submissionId}` }));
    if (r.path) problem.append(el("span", { className: "sub mono", text: r.path }));
    if (r.error) problem.append(el("span", { className: "err", text: r.error.message }));
    if (r.warning) problem.append(el("span", { className: "warn", text: r.warning }));

    const actions = el("td", { className: "actions-cell" });
    const canRetry =
      r.status === "failed" ||
      (r.status === "needs_review" && r.error?.code !== "not_accepted") ||
      (r.status === "ready" && s.settings.syncMode === "manual" && !r.userApproved);
    if (canRetry) {
      const btn = el("button", {
        className: "btn btn-small",
        text: r.status === "ready" ? "Sync now" : "Retry",
        attrs: { type: "button" },
      });
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        await callWorker({ type: "sync:retry", submissionId: r.submissionId });
        await refresh(false);
      });
      actions.append(btn);
    }
    if (r.status === "synced" && r.path) {
      const a = el("a", {
        className: "btn btn-small",
        text: "View",
        attrs: { href: fileUrl(s.settings.owner, s.settings.repo, s.settings.branch, r.path), target: "_blank", rel: "noopener noreferrer" },
      });
      actions.append(a);
    }

    historyBody.append(
      el(
        "tr",
        {},
        problem,
        el("td", { text: r.langName ?? "—" }),
        el("td", {}, chip(label, tone)),
        el("td", { text: relativeTime(r.updatedAt), attrs: { title: new Date(r.updatedAt).toLocaleString() } }),
        actions,
      ),
    );
  }
}

async function refresh(refillForm: boolean): Promise<void> {
  const next = await loadState();
  if (!next) {
    setMessage(saveMsg, "Could not load settings. Reload the extension in chrome://extensions.", "error");
    return;
  }
  state = next;
  if (refillForm && !dirty) fillForm(next.settings);
  renderConnection(next);
  renderToken(next);
  renderHistory(next);
}

// ------------------------------------------------------------------ events

document.addEventListener("input", (e) => {
  if (e.target === tokenInput) return;
  dirty = true;
  setMessage(saveMsg, "Unsaved changes");
  updatePreview();
});
document.addEventListener("change", (e) => {
  if (e.target === tokenInput) return;
  dirty = true;
  setMessage(saveMsg, "Unsaved changes");
  updatePreview();
});

$("save-settings").addEventListener("click", async () => {
  const settings = readForm();
  const res = (await callWorker({ type: "settings:save", settings })) as
    | { ok: true }
    | { ok: false; error: string; fieldErrors?: SettingsErrors };
  if (res.ok) {
    dirty = false;
    showFieldErrors({});
    setMessage(saveMsg, "Settings saved.", "ok");
    await refresh(true);
  } else {
    showFieldErrors(res.fieldErrors ?? {});
    setMessage(saveMsg, res.error, "error");
  }
});

$("save-token").addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    setMessage(tokenMsg, "Paste a token first.", "error");
    return;
  }
  const res = await callWorker({ type: "token:set", token });
  tokenInput.value = "";
  if (!res.ok) {
    setMessage(tokenMsg, res.error, "error");
    return;
  }
  setMessage(tokenMsg, "Token saved. Testing the connection…", "ok");
  await refresh(false);
  if (dirty) {
    setMessage(tokenMsg, "Token saved. Save your settings, then test the connection.", "ok");
    return;
  }
  await testConnection();
  setMessage(tokenMsg, "Token saved.", "ok");
});

async function testConnection(): Promise<void> {
  const btn = $<HTMLButtonElement>("test-connection");
  btn.disabled = true;
  btn.textContent = "Testing…";
  await callWorker<ConnectionState>({ type: "connection:test" });
  btn.textContent = "Test connection";
  await refresh(false);
}

$("test-connection").addEventListener("click", () => {
  if (dirty) {
    setMessage(saveMsg, "Save your settings first, so the test uses them.", "error");
    return;
  }
  void testConnection();
});

$("remove-token").addEventListener("click", async () => {
  if (!confirm("Remove the stored GitHub token from this browser? Syncing stops until you add a new one.")) return;
  await callWorker({ type: "token:remove" });
  setMessage(tokenMsg, "Token removed. If it may have been exposed, also revoke it on GitHub.", "ok");
  await refresh(false);
});

$("disconnect").addEventListener("click", async () => {
  if (!confirm("Disconnect GitHub? This removes the stored token. Your repository and its files are not touched.")) return;
  await callWorker({ type: "github:disconnect" });
  setMessage(tokenMsg, "Disconnected. Revoke the token on GitHub if you no longer need it.", "ok");
  await refresh(false);
});

$("retry-all").addEventListener("click", async () => {
  await callWorker({ type: "sync:retry" });
  await refresh(false);
});

$("clear-history").addEventListener("click", async () => {
  if (!confirm("Clear the local sync history? Files already on GitHub are not affected. Submissions still in progress are kept.")) return;
  await callWorker({ type: "history:clear" });
  await refresh(false);
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") void refresh(false);
});

void refresh(true);
