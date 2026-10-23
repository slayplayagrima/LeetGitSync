/** Small, self-contained notification shown on the LeetCode page. Isolated in a shadow root. */

const STYLE = `
:host { all: initial; }
.wrap {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
  display: flex; flex-direction: column; gap: 8px; max-width: 360px;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.toast {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 10px 12px; border-radius: 10px;
  background: #16181d; color: #e8eaed; border: 1px solid #2c313a;
  box-shadow: 0 8px 24px rgba(0,0,0,.28);
  animation: in .18s ease-out;
}
.dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; flex: none; }
.success .dot { background: #3fb950; }
.info .dot { background: #58a6ff; }
.error .dot { background: #f85149; }
.body { flex: 1; min-width: 0; }
.title { font-weight: 600; margin-bottom: 2px; }
.msg { color: #c4c9d0; word-wrap: break-word; }
button {
  all: unset; cursor: pointer; color: #8b949e; font-size: 16px; line-height: 1; padding: 0 2px;
}
button:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px; border-radius: 4px; }
@keyframes in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
`;

let container: HTMLDivElement | null = null;

function ensureContainer(): HTMLDivElement {
  if (container?.isConnected) return container;
  const host = document.createElement("leetgitsync-toast");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  container = document.createElement("div");
  container.className = "wrap";
  container.setAttribute("role", "status");
  container.setAttribute("aria-live", "polite");
  root.append(style, container);
  document.documentElement.append(host);
  return container;
}

const TITLES = { success: "LeetGitSync", info: "LeetGitSync", error: "LeetGitSync: action needed" } as const;

export function showToast(kind: "success" | "info" | "error", message: string): void {
  const wrap = ensureContainer();
  const toast = document.createElement("div");
  toast.className = `toast ${kind}`;

  const dot = document.createElement("span");
  dot.className = "dot";
  const body = document.createElement("div");
  body.className = "body";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = TITLES[kind];
  const msg = document.createElement("div");
  msg.className = "msg";
  msg.textContent = message;
  body.append(title, msg);

  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => toast.remove());

  toast.append(dot, body, close);
  wrap.append(toast);
  while (wrap.childElementCount > 3) wrap.firstElementChild?.remove();
  setTimeout(() => toast.remove(), kind === "error" ? 12_000 : 6_000);
}
