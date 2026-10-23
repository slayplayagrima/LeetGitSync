import type { PageToWorker, Reply } from "../lib/messages";
import type { PublicRecord, PublicState } from "../types";

export async function callWorker<T>(message: PageToWorker): Promise<Reply<T>> {
  try {
    const res = (await chrome.runtime.sendMessage(message)) as Reply<T> | undefined;
    return res ?? { ok: false, error: "The extension did not respond. Try again." };
  } catch {
    return { ok: false, error: "The extension background is not running. Reload the extension in chrome://extensions." };
  }
}

export async function loadState(): Promise<PublicState | null> {
  const res = await callWorker<PublicState>({ type: "state:get" });
  return res.ok ? res.data : null;
}

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

export function statusLabel(r: PublicRecord, manualMode: boolean): { label: string; tone: Tone } {
  switch (r.status) {
    case "detected":
    case "waiting_details":
      return { label: "Reading submission", tone: "info" };
    case "ready":
      return manualMode && !r.userApproved ? { label: "Ready to sync", tone: "warning" } : { label: "Queued", tone: "info" };
    case "syncing":
      return { label: "Syncing solution", tone: "info" };
    case "synced":
      return r.outcome === "unchanged" ? { label: "Already synced", tone: "success" } : { label: "Synced", tone: "success" };
    case "needs_review":
      return r.error?.code === "details_unavailable"
        ? { label: "Details unavailable", tone: "danger" }
        : { label: "Manual review required", tone: "warning" };
    case "failed": {
      if (r.nextAttemptAt) return { label: r.error?.code === "rate_limited" ? "Rate limit reached" : "Retrying", tone: "warning" };
      const labels: Partial<Record<string, string>> = {
        auth_invalid: "GitHub authorization failed",
        permission_denied: "Permission denied",
        repo_not_found: "Repository not found",
        repo_empty: "Repository is empty",
        branch_not_found: "Branch not found",
        not_configured: "Setup needed",
        rate_limited: "Rate limit reached",
        network: "Network error",
        invalid_path: "Invalid file path",
      };
      return { label: labels[r.error?.code ?? ""] ?? "Sync failed", tone: "danger" };
    }
  }
}

export function problemLabel(r: Pick<PublicRecord, "frontendId" | "title" | "titleSlug">): string {
  return `${r.frontendId ? `${r.frontendId}. ` : ""}${r.title ?? r.titleSlug}`;
}

export function relativeTime(epochMs: number, now = Date.now()): string {
  const s = Math.round((now - epochMs) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(epochMs).toLocaleDateString();
}

/** Tiny element helper; text is always set via textContent, never parsed as HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; attrs?: Record<string, string> } = {},
  ...children: Array<Node | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  for (const child of children) if (child) node.append(child);
  return node;
}

export function chip(label: string, tone: Tone): HTMLSpanElement {
  return el("span", { className: `chip ${tone === "neutral" ? "" : tone}`.trim(), text: label });
}

export function repoUrl(owner: string, repo: string, branch?: string): string {
  const base = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return branch ? `${base}/tree/${branch.split("/").map(encodeURIComponent).join("/")}` : base;
}

export function fileUrl(owner: string, repo: string, branch: string, path: string): string {
  const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${enc(branch)}/${enc(path)}`;
}
