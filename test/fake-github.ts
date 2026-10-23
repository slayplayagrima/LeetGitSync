import { encodeBase64Utf8 } from "../src/lib/github-client";

interface Commit {
  sha: string;
  tree: Map<string, string>;
  message: string;
  parents: string[];
}

type Failure = { status: number; body?: unknown; headers?: Record<string, string> } | "network";

/**
 * In-memory stand-in for the parts of the GitHub REST API the extension uses.
 * Lets tests count commits and inject failures without touching real GitHub.
 */
export class FakeGitHub {
  owner = "me";
  repo = "solutions";
  defaultBranch = "main";
  token = "github_pat_TESTTOKEN_0123456789abcdefghijklmnop";
  isPrivate = true;
  empty = false;
  commits = new Map<string, Commit>();
  branches = new Map<string, string>();
  trees = new Map<string, Map<string, string>>();
  requests: Array<{ method: string; path: string; auth: string | null }> = [];
  /** Queue of failures keyed by "METHOD pathPrefix"; each entry is consumed once. */
  failures: Array<{ match: (method: string, path: string) => boolean; failure: Failure }> = [];
  /** When set, the next PATCH to the ref moves the branch first, simulating a concurrent push. */
  raceOnce = false;
  #n = 0;

  constructor() {
    const root: Commit = { sha: this.#id("c"), tree: new Map([["README.md", "# solutions\n"]]), message: "init", parents: [] };
    this.commits.set(root.sha, root);
    this.branches.set(this.defaultBranch, root.sha);
  }

  #id(prefix: string): string {
    this.#n += 1;
    return `${prefix}${String(this.#n).padStart(39, "0")}`;
  }

  /** Commits made by the extension that are actually on the default branch (orphans excluded). */
  get userCommits(): Commit[] {
    const out: Commit[] = [];
    let sha: string | undefined = this.branches.get(this.defaultBranch);
    while (sha) {
      const c: Commit = this.commits.get(sha)!;
      if (c.message !== "init" && c.message !== "external") out.unshift(c);
      sha = c.parents[0];
    }
    return out;
  }

  head(branch = this.defaultBranch): Commit {
    return this.commits.get(this.branches.get(branch)!)!;
  }

  fileAt(path: string, branch = this.defaultBranch): string | undefined {
    return this.head(branch).tree.get(path);
  }

  failNext(method: string, pathIncludes: string, failure: Failure): void {
    this.failures.push({ match: (m, p) => m === method && p.includes(pathIncludes), failure });
  }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    this.requests.push({ method, path: url.pathname, auth: headers.get("authorization") });

    if (url.origin !== "https://api.github.com") throw new Error(`Unexpected host ${url.origin}`);
    const idx = this.failures.findIndex((f) => f.match(method, url.pathname));
    if (idx !== -1) {
      const { failure } = this.failures.splice(idx, 1)[0]!;
      if (failure === "network") throw new TypeError("Failed to fetch");
      return json(failure.status, failure.body ?? { message: "error" }, failure.headers);
    }
    if (headers.get("authorization") !== `Bearer ${this.token}`) return json(401, { message: "Bad credentials" });

    const base = `/repos/${this.owner}/${this.repo}`;
    if (!url.pathname.startsWith(base)) return json(404, { message: "Not Found" });
    const rest = decodeURIComponent(url.pathname.slice(base.length));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;

    if (method === "GET" && rest === "") {
      return json(200, {
        full_name: `${this.owner}/${this.repo}`,
        default_branch: this.defaultBranch,
        private: this.isPrivate,
        permissions: { admin: true, push: true, pull: true },
      });
    }
    if (method === "GET" && rest.startsWith("/git/ref/heads/")) {
      if (this.empty) return json(409, { message: "Git Repository is empty." });
      const sha = this.branches.get(rest.slice("/git/ref/heads/".length));
      return sha ? json(200, { object: { sha } }) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && rest.startsWith("/contents/")) {
      const path = rest.slice("/contents/".length);
      const ref = url.searchParams.get("ref") ?? this.defaultBranch;
      const sha = this.branches.get(ref);
      if (!sha) return json(404, { message: "No commit found for the ref" });
      const content = this.commits.get(sha)!.tree.get(path);
      if (content === undefined) return json(404, { message: "Not Found" });
      return json(200, { type: "file", sha: `blob-${path}`, encoding: "base64", content: encodeBase64Utf8(content) });
    }
    if (method === "GET" && rest.startsWith("/git/commits/")) {
      const commit = this.commits.get(rest.slice("/git/commits/".length));
      if (!commit) return json(404, { message: "Not Found" });
      const treeSha = this.#id("t");
      this.trees.set(treeSha, new Map(commit.tree));
      return json(200, { sha: commit.sha, tree: { sha: treeSha } });
    }
    if (method === "POST" && rest === "/git/trees") {
      const baseTree = this.trees.get(body.base_tree);
      if (!baseTree) return json(422, { message: "Invalid base_tree" });
      const tree = new Map(baseTree);
      for (const entry of body.tree) tree.set(entry.path, entry.content);
      const sha = this.#id("t");
      this.trees.set(sha, tree);
      return json(201, { sha });
    }
    if (method === "POST" && rest === "/git/commits") {
      const tree = this.trees.get(body.tree);
      if (!tree) return json(422, { message: "Invalid tree" });
      const sha = this.#id("c");
      this.commits.set(sha, { sha, tree, message: body.message, parents: body.parents });
      return json(201, { sha, html_url: `https://github.com/${this.owner}/${this.repo}/commit/${sha}` });
    }
    if (method === "PATCH" && rest.startsWith("/git/refs/heads/")) {
      const branch = rest.slice("/git/refs/heads/".length);
      if (this.raceOnce) {
        this.raceOnce = false;
        const current = this.head(branch);
        const sha = this.#id("c");
        this.commits.set(sha, { sha, tree: new Map(current.tree), message: "external", parents: [current.sha] });
        this.branches.set(branch, sha);
      }
      const target = this.commits.get(body.sha);
      const current = this.branches.get(branch);
      if (!target || !current) return json(422, { message: "Reference does not exist" });
      if (!body.force && !target.parents.includes(current)) return json(422, { message: "Update is not a fast forward" });
      this.branches.set(branch, target.sha);
      return json(200, { object: { sha: target.sha } });
    }
    return json(404, { message: `Unhandled ${method} ${rest}` });
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
