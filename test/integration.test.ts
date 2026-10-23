import { beforeEach, describe, expect, it } from "vitest";
import { AcceptedSubmissionTracker } from "../src/lib/detection";
import { LeetCodeClient } from "../src/lib/leetcode-client";
import { MemoryStore, StateStore } from "../src/lib/storage";
import { SyncService, type SyncEvent } from "../src/lib/sync-service";
import type { Settings, SubmissionDetails, SyncRecord } from "../src/types";
import { FakeGitHub } from "./fake-github";

const CODE_A = "class Solution:\n    def twoSum(self, nums, target):\n        seen = {}\n        return []\n";
const CODE_B = "class Solution:\n    def twoSum(self, nums, target):\n        # faster\n        return [0, 1]\n";

function details(id: string, code = CODE_A, over: Partial<SubmissionDetails> = {}): SubmissionDetails {
  return {
    submissionId: id,
    code,
    langSlug: "python3",
    langName: "Python3",
    timestamp: 1_760_000_000,
    statusCode: 10,
    runtime: "0 ms",
    memory: "17.9 MB",
    titleSlug: "two-sum",
    frontendId: "1",
    title: "Two Sum",
    difficulty: "Easy",
    ...over,
  };
}

interface Harness {
  gh: FakeGitHub;
  kv: MemoryStore;
  store: StateStore;
  service: SyncService;
  events: SyncEvent[];
  wakes: number[];
  clock: { now: number };
  fetch: typeof FakeGitHub.prototype.fetch;
}

async function setup(opts: { settings?: Partial<Settings>; token?: string | null; fetch?: Harness["fetch"] } = {}): Promise<Harness> {
  const gh = new FakeGitHub();
  const kv = new MemoryStore();
  const store = new StateStore(kv);
  const clock = { now: 1_700_000_000_000 };
  await store.saveSettings({ ...(await store.getSettings()), owner: gh.owner, repo: gh.repo, branch: "main", ...opts.settings });
  if (opts.token !== null) await store.setToken(opts.token ?? gh.token);
  const events: SyncEvent[] = [];
  const wakes: number[] = [];
  const fetch = opts.fetch ?? gh.fetch;
  const service = new SyncService({
    store,
    fetch,
    now: () => clock.now,
    notify: (e) => events.push(e),
    scheduleWake: (w) => wakes.push(w),
  });
  return { gh, kv, store, service, events, wakes, clock, fetch };
}

async function accept(h: Harness, id: string, d: SubmissionDetails = details(id)): Promise<SyncRecord> {
  const r = await h.service.reportAccepted({ submissionId: id, titleSlug: d.titleSlug, source: "auto" });
  if (r.needDetails) await h.service.reportDetails(id, { ok: true, details: d });
  return (await h.store.getRecords())[id]!;
}

describe("accepted submission detection", () => {
  it("emits one event per accepted submission and ignores everything else", () => {
    const t = new AcceptedSubmissionTracker();
    const hook = (kind: string, payload: unknown) => ({ source: "leetgitsync-hook", kind, payload });
    const check = (state: string, statusCode?: number, statusMsg?: string) =>
      hook("check", { submissionId: "555", state, statusCode, statusMsg, finished: state === "SUCCESS" });

    expect(t.handle(hook("submitted", { titleSlug: "two-sum", submissionId: "555" }))).toBeNull();
    expect(t.handle(check("PENDING"))).toBeNull();
    expect(t.handle(check("STARTED"))).toBeNull();
    expect(t.handle(check("SUCCESS", 10, "Accepted"))).toEqual({ submissionId: "555", titleSlug: "two-sum" });
    // Re-render / repeated poll of the same result.
    expect(t.handle(check("SUCCESS", 10, "Accepted"))).toBeNull();
    // Wrong answers and foreign messages never count.
    expect(t.handle(hook("check", { submissionId: "556", state: "SUCCESS", statusCode: 11, statusMsg: "Wrong Answer" }))).toBeNull();
    expect(t.handle({ source: "someone-else", kind: "check", payload: {} })).toBeNull();
    expect(t.handle("garbage")).toBeNull();
  });
});

describe("submission-detail retrieval", () => {
  const detailsResponse = {
    data: {
      submissionDetails: {
        code: CODE_A,
        timestamp: 1_760_000_000,
        statusCode: 10,
        runtimeDisplay: "0 ms",
        memoryDisplay: "17.9 MB",
        lang: { name: "python3", verboseName: "Python3" },
        question: { questionId: "1", titleSlug: "two-sum" },
      },
    },
  };
  const questionResponse = {
    data: { question: { questionFrontendId: "1", title: "Two Sum", titleSlug: "two-sum", difficulty: "Easy" } },
  };

  it("reads the exact submission and enriches it with problem info", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new LeetCodeClient({
      origin: "https://leetcode.com",
      getCsrfToken: () => "csrf123",
      sleep: async () => {},
      fetch: async (url, init = {}) => {
        calls.push({ url, init });
        const body = JSON.parse(String(init.body));
        return new Response(JSON.stringify(body.operationName === "submissionDetails" ? detailsResponse : questionResponse), { status: 200 });
      },
    });
    const d = await client.getFullDetails("777");
    expect(d).toMatchObject({ submissionId: "777", code: CODE_A, titleSlug: "two-sum", frontendId: "1", title: "Two Sum", statusCode: 10 });
    expect(calls[0]!.url).toBe("https://leetcode.com/graphql/");
    expect(calls[0]!.init.credentials).toBe("same-origin");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-csrftoken"]).toBe("csrf123");
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(JSON.parse(String(calls[0]!.init.body)).variables).toEqual({ submissionId: 777 });
  });

  it("retries transient failures a bounded number of times", async () => {
    let n = 0;
    const client = new LeetCodeClient({
      origin: "https://leetcode.com",
      sleep: async () => {},
      fetch: async () => {
        n++;
        return new Response("busy", { status: 503 });
      },
    });
    await expect(client.getSubmissionDetails("1")).rejects.toMatchObject({ code: "details_unavailable" });
    expect(n).toBe(3);
  });

  it("fails clearly when signed out or the schema changed", async () => {
    const client = new LeetCodeClient({
      origin: "https://leetcode.com",
      sleep: async () => {},
      fetch: async () => new Response(JSON.stringify({ data: { submissionDetails: null } }), { status: 200 }),
    });
    await expect(client.getSubmissionDetails("1")).rejects.toMatchObject({ code: "details_unavailable", retryable: false });
  });
});

describe("sync pipeline", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });

  it("creates a new file in one commit with the exact code", async () => {
    const r = await accept(h, "1001");
    expect(r.status).toBe("synced");
    expect(r.outcome).toBe("created");
    expect(r.path).toBe("python/0001-two-sum.py");
    expect(r.details).toBeUndefined();
    expect(h.gh.userCommits).toHaveLength(1);
    expect(h.gh.userCommits[0]!.message).toBe("Add 1. Two Sum (Python3)");
    const file = h.gh.fileAt("python/0001-two-sum.py")!;
    expect(file.endsWith(`\n\n${CODE_A}`)).toBe(true);
    expect(file).toContain("# Submission: 1001");
    expect(h.events.at(-1)?.kind).toBe("success");
  });

  it("sends the token only to api.github.com, as a Bearer header", async () => {
    await accept(h, "1001");
    expect(h.gh.requests.length).toBeGreaterThan(0);
    for (const req of h.gh.requests) expect(req.auth).toBe(`Bearer ${h.gh.token}`);
    const state = JSON.stringify(await h.service.getPublicState());
    expect(state).not.toContain(h.gh.token);
    expect(state).not.toContain(CODE_A);
  });

  it("does not commit twice for the same submission (re-render, reload, repeat report)", async () => {
    await accept(h, "1001");
    const again = await h.service.reportAccepted({ submissionId: "1001", titleSlug: "two-sum", source: "auto" });
    expect(again.needDetails).toBe(false);
    await h.service.processQueue();
    expect(h.gh.userCommits).toHaveLength(1);
  });

  it("does not commit when a new submission has identical code", async () => {
    await accept(h, "1001");
    const before = h.gh.requests.length;
    const r = await accept(h, "1002");
    expect(r).toMatchObject({ status: "synced", outcome: "unchanged" });
    expect(h.gh.userCommits).toHaveLength(1);
    expect(h.gh.requests.length).toBe(before); // decided locally, no API calls
  });

  it("checks GitHub before writing even without local history", async () => {
    await accept(h, "1001");
    await h.service.clearHistory();
    const r = await accept(h, "1001");
    expect(r).toMatchObject({ status: "synced", outcome: "unchanged" });
    expect(h.gh.userCommits).toHaveLength(1);
  });

  it("updates the file when later code differs (update policy)", async () => {
    await accept(h, "1001");
    const r = await accept(h, "1002", details("1002", CODE_B));
    expect(r.outcome).toBe("updated");
    expect(h.gh.userCommits).toHaveLength(2);
    expect(h.gh.userCommits[1]!.message).toBe("Update 1. Two Sum (Python3)");
    expect(h.gh.fileAt("python/0001-two-sum.py")!.endsWith(CODE_B)).toBe(true);
  });

  it("keeps separate files per distinct submission (separate policy)", async () => {
    h = await setup({ settings: { historyPolicy: "separate" } });
    await accept(h, "1001");
    await accept(h, "1002", details("1002", CODE_B));
    const same = await accept(h, "1003", details("1003", CODE_A));
    expect(same.outcome).toBe("unchanged");
    expect(h.gh.fileAt("python/0001-two-sum/1001.py")).toBeDefined();
    expect(h.gh.fileAt("python/0001-two-sum/1002.py")).toBeDefined();
    expect(h.gh.fileAt("python/0001-two-sum/1003.py")).toBeUndefined();
    expect(h.gh.userCommits).toHaveLength(2);
  });

  it("writes the metadata sidecar in the same commit", async () => {
    h = await setup({ settings: { metadataSidecar: true } });
    await accept(h, "1001");
    expect(h.gh.userCommits).toHaveLength(1);
    const meta = JSON.parse(h.gh.fileAt("metadata/python/0001-two-sum.json")!);
    expect(meta.submission.id).toBe("1001");
  });

  it("supports several languages for one problem", async () => {
    await accept(h, "1001");
    const r = await accept(h, "1002", details("1002", "class Solution {};\n", { langSlug: "cpp", langName: "C++" }));
    expect(r.path).toBe("cpp/0001-two-sum.cpp");
    expect(h.gh.fileAt("cpp/0001-two-sum.cpp")!.startsWith("// LeetCode 1. Two Sum")).toBe(true);
    expect(h.gh.userCommits).toHaveLength(2);
  });

  it("never saves a submission LeetCode does not report as accepted", async () => {
    const r = await accept(h, "1001", details("1001", CODE_A, { statusCode: 11 }));
    expect(r.status).toBe("needs_review");
    expect(r.error?.code).toBe("not_accepted");
    expect(h.gh.requests).toHaveLength(0);
  });

  it("flags details that belong to a different problem", async () => {
    await h.service.reportAccepted({ submissionId: "1001", titleSlug: "add-two-numbers", source: "auto" });
    await h.service.reportDetails("1001", { ok: true, details: details("1001") });
    const r = (await h.store.getRecords())["1001"]!;
    expect(r.status).toBe("needs_review");
    expect(h.gh.requests).toHaveLength(0);
  });

  it("marks unavailable details for manual review instead of guessing", async () => {
    await h.service.reportAccepted({ submissionId: "1001", titleSlug: "two-sum", source: "auto" });
    await h.service.reportDetails("1001", {
      ok: false,
      error: { code: "details_unavailable", message: "Could not read it.", retryable: true },
    });
    const r = (await h.store.getRecords())["1001"]!;
    expect(r.status).toBe("needs_review");
    expect(h.gh.requests).toHaveLength(0);
  });

  it("reports an invalid token without retrying", async () => {
    h = await setup({ token: "github_pat_WRONGWRONGWRONGWRONGWRONG" });
    const r = await accept(h, "1001");
    expect(r.status).toBe("failed");
    expect(r.error).toMatchObject({ code: "auth_invalid", retryable: false });
    expect(r.nextAttemptAt).toBeUndefined();
    expect(h.wakes).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain("WRONGWRONG");
  });

  it("reports missing write permission without escalating", async () => {
    h.gh.failNext("POST", "/git/trees", { status: 403, body: { message: "Resource not accessible by personal access token" } });
    const r = await accept(h, "1001");
    expect(r.error).toMatchObject({ code: "permission_denied", retryable: false });
    expect(h.gh.userCommits).toHaveLength(0);
  });

  it("asks for setup when no token is stored", async () => {
    h = await setup({ token: null });
    const r = await accept(h, "1001");
    expect(r.error?.code).toBe("not_configured");
    expect(h.gh.requests).toHaveLength(0);
  });

  it("explains an empty repository", async () => {
    h.gh.empty = true;
    const r = await accept(h, "1001");
    expect(r.error?.code).toBe("repo_empty");
  });

  it("warns when the branch is not the default branch", async () => {
    h.gh.branches.set("solutions", h.gh.branches.get("main")!);
    await h.store.saveSettings({ ...(await h.store.getSettings()), branch: "solutions" });
    const r = await accept(h, "1001");
    expect(r.status).toBe("synced");
    expect(r.warning).toContain("not the default branch");
  });

  it("retries after a network interruption with backoff, then succeeds once", async () => {
    h.gh.failNext("POST", "/git/trees", "network");
    const r = await accept(h, "1001");
    expect(r.status).toBe("failed");
    expect(r.error).toMatchObject({ code: "network", retryable: true });
    expect(r.nextAttemptAt).toBe(h.clock.now + 30_000);
    expect(h.wakes).toContain(h.clock.now + 30_000);

    await h.service.processQueue(); // not due yet
    expect(h.gh.userCommits).toHaveLength(0);

    h.clock.now += 31_000;
    await h.service.processQueue();
    const after = (await h.store.getRecords())["1001"]!;
    expect(after.status).toBe("synced");
    expect(h.gh.userCommits).toHaveLength(1);
  });

  it("does not create a second commit when the response to a successful write was lost", async () => {
    let dropped = false;
    const lossy: Harness["fetch"] = async (url, init) => {
      const res = await h.gh.fetch(url, init);
      if (!dropped && init?.method === "PATCH") {
        dropped = true;
        throw new TypeError("Failed to fetch");
      }
      return res;
    };
    h = await setup({ fetch: (url, init) => lossy(url, init) });
    // `lossy` must use the new harness's fake.
    const r = await accept(h, "1001");
    expect(r.status).toBe("failed");
    expect(h.gh.userCommits).toHaveLength(1);

    h.clock.now += 60_000;
    await h.service.processQueue();
    const after = (await h.store.getRecords())["1001"]!;
    expect(after).toMatchObject({ status: "synced", outcome: "unchanged" });
    expect(h.gh.userCommits).toHaveLength(1);
  });

  it("recovers from a branch that moved during the write", async () => {
    h.gh.raceOnce = true;
    const r = await accept(h, "1001");
    expect(r.status).toBe("synced");
    expect(h.gh.userCommits).toHaveLength(1);
  });

  it("stops retrying after the maximum number of attempts", async () => {
    for (let i = 0; i < 10; i++) h.gh.failNext("POST", "/git/trees", { status: 502 });
    await accept(h, "1001");
    for (let i = 0; i < 6; i++) {
      h.clock.now += 60 * 60_000;
      await h.service.processQueue();
    }
    const r = (await h.store.getRecords())["1001"]!;
    expect(r.status).toBe("failed");
    expect(r.attempts).toBe(5);
    expect(r.nextAttemptAt).toBeUndefined();
    expect(r.error?.retryable).toBe(false);
  });

  it("waits until the rate limit resets", async () => {
    const reset = Math.floor(h.clock.now / 1000) + 3600;
    h.gh.failNext("GET", `/repos/${h.gh.owner}/${h.gh.repo}`, {
      status: 403,
      body: { message: "API rate limit exceeded" },
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    });
    const r = await accept(h, "1001");
    expect(r.error?.code).toBe("rate_limited");
    expect(r.nextAttemptAt).toBe(reset * 1000);
  });

  it("lets the user retry a failed sync", async () => {
    h = await setup({ token: "github_pat_WRONGWRONGWRONGWRONGWRONG" });
    await accept(h, "1001");
    await h.store.setToken(h.gh.token);
    expect(await h.service.retry()).toBe(1);
    expect((await h.store.getRecords())["1001"]!.status).toBe("synced");
  });

  it("holds submissions in manual mode until the user confirms", async () => {
    h = await setup({ settings: { syncMode: "manual" } });
    const r = await accept(h, "1001");
    expect(r.status).toBe("ready");
    expect(h.gh.requests).toHaveLength(0);
    await h.service.retry("1001");
    expect((await h.store.getRecords())["1001"]!.status).toBe("synced");
  });

  it("recovers an interrupted sync after a service-worker restart", async () => {
    const interrupted: SyncRecord = {
      submissionId: "1001",
      titleSlug: "two-sum",
      status: "syncing",
      source: "auto",
      detectedAt: h.clock.now,
      updatedAt: h.clock.now,
      attempts: 1,
      details: details("1001"),
    };
    await h.store.updateRecords((records) => {
      records["1001"] = interrupted;
    });
    // A fresh service instance over the same storage, as after a worker restart.
    const restarted = new SyncService({ store: new StateStore(h.kv), fetch: h.gh.fetch, now: () => h.clock.now });
    await restarted.recover();
    expect((await h.store.getRecords())["1001"]!.status).toBe("synced");
    expect(h.gh.userCommits).toHaveLength(1);
  });

  it("resumes detail fetching for submissions interrupted by a reload", async () => {
    await h.service.reportAccepted({ submissionId: "1001", titleSlug: "two-sum", source: "auto" });
    expect(await h.service.pendingDetailRequests()).toEqual([{ submissionId: "1001", titleSlug: "two-sum" }]);
    // The reloaded page reports again; still only one record and it still needs details.
    const again = await h.service.reportAccepted({ submissionId: "1001", titleSlug: "two-sum", source: "auto" });
    expect(again.needDetails).toBe(true);
    await h.service.reportDetails("1001", { ok: true, details: details("1001") });
    expect(await h.service.pendingDetailRequests()).toEqual([]);
    expect(h.gh.userCommits).toHaveLength(1);
  });

  it("tests the connection and reports branch problems", async () => {
    expect(await h.service.testConnection()).toMatchObject({ state: "ok", repoFullName: "me/solutions", branchIsDefault: true });
    await h.store.saveSettings({ ...(await h.store.getSettings()), branch: "nope" });
    expect(await h.service.testConnection()).toMatchObject({ state: "error", errorCode: "branch_not_found" });
    expect(h.gh.userCommits).toHaveLength(0);
  });

  it("clearing local history keeps in-progress work and never touches GitHub", async () => {
    await accept(h, "1001");
    await h.service.reportAccepted({ submissionId: "2002", titleSlug: "two-sum", source: "auto" });
    const commitsBefore = h.gh.userCommits.length;
    await h.service.clearHistory();
    const records = await h.store.getRecords();
    expect(Object.keys(records)).toEqual(["2002"]);
    expect(h.gh.userCommits.length).toBe(commitsBefore);
    expect(h.gh.fileAt("python/0001-two-sum.py")).toBeDefined();
  });
});
