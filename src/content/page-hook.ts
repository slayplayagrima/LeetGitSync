/*
 * Runs in the LeetCode page's own JavaScript world (manifest "world": "MAIN")
 * so it can observe the responses LeetCode's app already receives while it
 * polls a submission's judge result. It never makes requests of its own,
 * never changes the responses, and has no access to extension APIs or the
 * GitHub token. It forwards only the few judge-status fields the extension
 * needs to the isolated content script via window.postMessage.
 *
 * Anything posted from here is treated as a hint only: the content script
 * confirms acceptance by reading the submission back from LeetCode.
 */

(() => {
  const MARK = "__leetgitsyncHook";
  const w = window as unknown as Record<string, unknown>;
  if (w[MARK]) return;
  w[MARK] = true;

  // LeetCode polls /submissions/detail/<id>/v2/check/ (older builds used /check/).
  const CHECK_RE = /\/submissions\/detail\/(\d{1,20})\/(?:v2\/)?check\/?(?:\?|$)/;
  const SUBMIT_RE = /\/problems\/([a-z0-9-]+)\/submit\/?(?:\?|$)/;

  function post(kind: string, payload: Record<string, unknown>): void {
    window.postMessage({ source: "leetgitsync-hook", kind, payload }, window.location.origin);
  }

  function inspect(url: string, body: unknown): void {
    if (!body || typeof body !== "object") return;
    const data = body as Record<string, unknown>;
    const check = CHECK_RE.exec(url);
    if (check) {
      post("check", {
        submissionId: check[1],
        state: typeof data.state === "string" ? data.state : undefined,
        statusCode: typeof data.status_code === "number" ? data.status_code : undefined,
        statusMsg: typeof data.status_msg === "string" ? data.status_msg : undefined,
        finished: data.finished === true,
      });
      return;
    }
    const submit = SUBMIT_RE.exec(url);
    if (submit && (typeof data.submission_id === "number" || typeof data.submission_id === "string")) {
      post("submitted", { titleSlug: submit[1], submissionId: String(data.submission_id) });
    }
  }

  function relevant(url: string): boolean {
    return CHECK_RE.test(url) || SUBMIT_RE.test(url);
  }

  function absolute(input: string | URL | Request): string {
    try {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new URL(raw, window.location.href).pathname;
    } catch {
      return "";
    }
  }

  const originalFetch = window.fetch;
  window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
    const promise = originalFetch.apply(this, args);
    const url = absolute(args[0]);
    if (relevant(url)) {
      promise
        .then((res) => (res.ok ? res.clone().json() : undefined))
        .then((body) => inspect(url, body))
        .catch(() => undefined);
    }
    return promise;
  } as typeof fetch;

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const urls = new WeakMap<XMLHttpRequest, string>();

  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    urls.set(this, absolute(args[1] as string | URL));
    return (originalOpen as (...a: unknown[]) => void).apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
    const url = urls.get(this) ?? "";
    if (relevant(url)) {
      this.addEventListener("load", () => {
        if (this.status < 200 || this.status >= 300) return;
        try {
          const body =
            this.responseType === "json"
              ? this.response
              : this.responseType === "" || this.responseType === "text"
                ? JSON.parse(this.responseText)
                : undefined;
          inspect(url, body);
        } catch {
          // Not JSON; ignore.
        }
      });
    }
    return (originalSend as (...a: unknown[]) => void).apply(this, args);
  } as typeof XMLHttpRequest.prototype.send;

  // Lets the isolated content script see that the hook is installed, even if it loads later.
  document.documentElement?.setAttribute("data-leetgitsync-hook", "1");
  post("ready", {});
})();
