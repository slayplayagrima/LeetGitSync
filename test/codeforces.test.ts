import { describe, expect, it } from "vitest";
import {
  CodeforcesWatcher,
  decodeHtmlEntities,
  extractSourceFromHtml,
  submissionFromPath,
  submissionPagePath,
  toSubmissionDetails,
  MAX_POLLS,
  codeforcesProblemNumber,
  codeforcesRecordId,
  codeforcesSlug,
  detectHandle,
  hasPending,
  isCodeforcesRecordId,
  parseUserStatus,
  rawCodeforcesId,
  selectNewAccepted,
} from "../src/lib/codeforces";
import { MemoryStore, StateStore } from "../src/lib/storage";
import { SyncService } from "../src/lib/sync-service";
import { codeforcesLangSlug } from "../src/lib/languages";
import { FakeGitHub } from "./fake-github";

const SINCE = 1_700_000_000_000;
const AFTER = SINCE / 1000 + 60;
const BEFORE = SINCE / 1000 - 60;

/** Shape copied from a real public `contest.status` response (fields trimmed). */
function sub(id: number, verdict: string | undefined, created = AFTER, extra: Record<string, unknown> = {}) {
  return {
    id,
    contestId: 1850,
    creationTimeSeconds: created,
    relativeTimeSeconds: 2147483647,
    problem: { contestId: 1850, index: "D", name: "Balanced Round", type: "PROGRAMMING", rating: 900, tags: ["greedy"] },
    author: { contestId: 1850, members: [{ handle: "someone" }], participantType: "PRACTICE" },
    programmingLanguage: "C++17 (GCC 7-32)",
    ...(verdict ? { verdict } : {}),
    testset: "TESTS",
    passedTestCount: 10,
    timeConsumedMillis: 93,
    memoryConsumedBytes: 1638400,
    ...extra,
  };
}

const ok = (...result: unknown[]) => ({ status: "OK", result });

describe("Codeforces ids and names", () => {
  it("namespaces ids", () => {
    expect(codeforcesRecordId(396447161)).toBe("cf-396447161");
    expect(isCodeforcesRecordId("cf-396447161")).toBe(true);
    expect(isCodeforcesRecordId("396447161")).toBe(false);
    expect(rawCodeforcesId("cf-12")).toBe("12");
  });
  it("builds problem keys", () => {
    expect(codeforcesSlug(1850, "A")).toBe("1850-a");
    expect(codeforcesSlug(1850, "F1")).toBe("1850-f1");
    expect(codeforcesProblemNumber(1850, "F1")).toBe("1850F1");
  });
});

describe("user.status parsing", () => {
  it("reads valid submissions", () => {
    const [s] = parseUserStatus(ok(sub(1, "OK")))!;
    expect(s).toMatchObject({
      id: 1,
      contestId: 1850,
      verdict: "OK",
      programmingLanguage: "C++17 (GCC 7-32)",
      problem: { index: "D", name: "Balanced Round", rating: 900, tags: ["greedy"] },
      timeConsumedMillis: 93,
      memoryConsumedBytes: 1638400,
    });
  });
  it("rejects failed responses and drops malformed entries", () => {
    expect(parseUserStatus({ status: "FAILED", comment: "handle: User not found" })).toBeNull();
    expect(parseUserStatus("nope")).toBeNull();
    expect(parseUserStatus(ok({ id: "x" }, sub(2, "OK")))!.map((s) => s.id)).toEqual([2]);
  });
});

describe("selecting what to sync", () => {
  const subs = parseUserStatus(
    ok(sub(1, "OK"), sub(2, "WRONG_ANSWER"), sub(3, "OK", BEFORE), sub(4, "TESTING"), sub(5, undefined), sub(6, "OK", AFTER, { contestId: undefined, problem: { index: "A", name: "No contest" } })),
  )!;
  it("keeps only accepted submissions made after sync was turned on", () => {
    expect(selectNewAccepted(subs, SINCE).map((s) => s.id)).toEqual([1]);
  });
  it("notices submissions still being judged", () => {
    expect(hasPending(subs, SINCE)).toBe(true);
    expect(hasPending(subs.filter((s) => s.id < 4), SINCE)).toBe(false);
  });
});

describe("handle detection", () => {
  it("reads the signed-in handle from the page header", () => {
    const doc = { querySelector: () => ({ getAttribute: () => "/profile/tourist" }) } as unknown as Document;
    expect(detectHandle(doc)).toBe("tourist");
    expect(detectHandle({ querySelector: () => null } as unknown as Document)).toBeUndefined();
  });
});

describe("CodeforcesWatcher", () => {
  function harness(responses: unknown[]) {
    const reported: number[] = [];
    const scheduled: Array<() => void> = [];
    const paths: string[] = [];
    const w = new CodeforcesWatcher({
      handle: "me",
      sinceMs: SINCE,
      fetchJson: async (path) => {
        paths.push(path);
        return responses[Math.min(paths.length - 1, responses.length - 1)];
      },
      schedule: (fn) => scheduled.push(fn),
      onAccepted: (s) => void reported.push(s.id),
    });
    return { w, reported, scheduled, paths };
  }

  it("asks the official API for the user's 10 latest submissions", async () => {
    const h = harness([ok()]);
    await h.w.check();
    expect(h.paths).toEqual(["/api/user.status?handle=me&from=1&count=10"]);
    expect(h.scheduled).toHaveLength(0);
  });

  it("polls while judging and reports the accepted result once", async () => {
    const h = harness([ok(sub(7, "TESTING")), ok(sub(7, "TESTING")), ok(sub(7, "OK"))]);
    await h.w.check();
    expect(h.reported).toEqual([]);
    while (h.scheduled.length) {
      h.scheduled.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(h.reported).toEqual([7]);
    await h.w.check(); // a later check of the same list
    expect(h.reported).toEqual([7]);
  });

  it("never reports wrong answers", async () => {
    const h = harness([ok(sub(8, "WRONG_ANSWER"), sub(9, "COMPILATION_ERROR"))]);
    await h.w.check();
    expect(h.reported).toEqual([]);
  });

  it("stops polling after a bounded number of checks", async () => {
    const h = harness([ok(sub(10, "TESTING"))]);
    await h.w.check();
    let rounds = 0;
    while (h.scheduled.length && rounds < 100) {
      h.scheduled.shift()!();
      await new Promise((r) => setTimeout(r, 0));
      rounds++;
    }
    expect(rounds).toBe(MAX_POLLS);
  });

  it("survives API errors without reporting anything", async () => {
    const errors: string[] = [];
    const w = new CodeforcesWatcher({
      handle: "me",
      sinceMs: SINCE,
      fetchJson: async () => {
        throw new TypeError("offline");
      },
      schedule: () => {},
      onAccepted: () => {
        throw new Error("should not be called");
      },
      onError: (m) => errors.push(m),
    });
    await w.check();
    expect(errors).toHaveLength(1);
  });
});

describe("recording detected Codeforces submissions", () => {
  async function service() {
    const store = new StateStore(new MemoryStore());
    return { store, svc: new SyncService({ store, now: () => SINCE }) };
  }
  const input = { submissionId: "cf-396447161", titleSlug: "1850-d", title: "Balanced Round", frontendId: "1850D" };

  it("records a submission once, separate from LeetCode", async () => {
    const { store, svc } = await service();
    expect(await svc.reportCodeforcesDetected(input)).toEqual({ created: true, needDetails: true });
    // Seen again before its code was read: still one record, and it asks for the code again.
    expect(await svc.reportCodeforcesDetected(input)).toEqual({ created: false, needDetails: true });
    const records = await store.getRecords();
    expect(Object.keys(records)).toEqual(["cf-396447161"]);
    expect(records["cf-396447161"]).toMatchObject({ platform: "codeforces", status: "waiting_details", frontendId: "1850D" });
  });

  it("rejects ids that are not Codeforces ids", async () => {
    const { svc } = await service();
    expect(await svc.reportCodeforcesDetected({ ...input, submissionId: "12345" })).toEqual({ created: false, needDetails: false });
  });

  it("does not hand Codeforces submissions to LeetCode tabs", async () => {
    const { svc } = await service();
    await svc.reportCodeforcesDetected(input);
    await svc.reportAccepted({ submissionId: "555", titleSlug: "two-sum", source: "auto" });
    expect((await svc.pendingDetailRequests()).map((p) => p.submissionId)).toEqual(["555"]);
    expect((await svc.pendingDetailRequests("codeforces")).map((p) => p.submissionId)).toEqual(["cf-396447161"]);
  });
});

const CODE = '#include <bits/stdc++.h>\nusing namespace std;\nint main() {\n    string s = "a&b";\n    cout << (1 < 2 && 3 > 2) << \'\\n\';\n}\n';

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Mirrors the structure of a Codeforces submission page (trimmed). */
function page(id: number, body: string): string {
  return `<!DOCTYPE html><html><head><title>Submission #${id} - Codeforces</title></head><body>
<div class="datatable"><table><tr><th>#</th></tr><tr><td><a href="/contest/1850/submission/${id}">${id}</a></td></tr></table></div>
<pre id="program-source-text" class="prettyprint lang-cpp linenums program-source" style="padding: 0.5em;">${body}</pre>
</body></html>`;
}

describe("reading Codeforces source code", () => {
  it("builds the submission page path for contests and gyms", () => {
    expect(submissionPagePath(1850, 202)).toBe("/contest/1850/submission/202");
    expect(submissionPagePath(104000, 7)).toBe("/gym/104000/submission/7");
  });
  it("decodes HTML entities", () => {
    expect(decodeHtmlEntities("a &lt;b&gt; &amp; &quot;c&quot; &#39;d&#39; &#x41;")).toBe(`a <b> & "c" 'd' A`);
    expect(decodeHtmlEntities("&unknown;")).toBe("&unknown;");
  });
  it("recovers the exact code from the page", () => {
    expect(extractSourceFromHtml(page(202, escape(CODE)), 202)).toEqual({ ok: true, code: CODE });
  });
  it("normalizes Windows line endings only", () => {
    const res = extractSourceFromHtml(page(202, escape("a\r\nb\r\n")), 202);
    expect(res).toEqual({ ok: true, code: "a\nb\n" });
  });
  it("refuses Cloudflare pages, missing code, wrong pages and changed formats", () => {
    expect(extractSourceFromHtml("<html><head><title>Just a moment...</title></head></html>", 202).ok).toBe(false);
    expect(extractSourceFromHtml("<html><body>Login required</body></html>", 202).ok).toBe(false);
    expect(extractSourceFromHtml(page(999, escape(CODE)), 202).ok).toBe(false);
    expect(extractSourceFromHtml(page(202, "<ol><li>int x;</li></ol>"), 202).ok).toBe(false);
    expect(extractSourceFromHtml(page(202, "   "), 202).ok).toBe(false);
  });
  it("combines API metadata and code into submission details", () => {
    const [s] = parseUserStatus(ok(sub(202, "OK")))!;
    expect(toSubmissionDetails(s!, CODE, codeforcesLangSlug(s!.programmingLanguage))).toEqual({
      platform: "codeforces",
      submissionId: "cf-202",
      code: CODE,
      langSlug: "cpp",
      langName: "C++17 (GCC 7-32)",
      timestamp: AFTER,
      statusCode: 10,
      titleSlug: "1850-d",
      frontendId: "1850D",
      title: "Balanced Round",
      contestId: 1850,
      runtime: "93 ms",
      memory: "1.6 MB",
      rating: 900,
    });
  });
});

describe("saving Codeforces solutions to GitHub", () => {
  async function setup(over: Record<string, unknown> = {}) {
    const gh = new FakeGitHub();
    const store = new StateStore(new MemoryStore());
    await store.saveSettings({ ...(await store.getSettings()), owner: gh.owner, repo: gh.repo, codeforcesEnabled: true, ...over });
    await store.setToken(gh.token);
    const svc = new SyncService({ store, fetch: gh.fetch, now: () => SINCE });
    return { gh, store, svc };
  }
  async function deliver(svc: SyncService, id: number, code = CODE, verdict = "OK") {
    const rid = `cf-${id}`;
    await svc.reportCodeforcesDetected({ submissionId: rid, titleSlug: "1850-d", title: "Balanced Round", frontendId: "1850D" });
    const [s] = parseUserStatus(ok(sub(id, verdict)))!;
    await svc.reportDetails(rid, { ok: true, details: toSubmissionDetails(s!, code, "cpp") });
  }

  it("commits the exact code under codeforces/<language>/ with a Codeforces header", async () => {
    const { gh, store, svc } = await setup();
    await deliver(svc, 202);
    const record = (await store.getRecords())["cf-202"]!;
    expect(record).toMatchObject({ status: "synced", outcome: "created", path: "codeforces/cpp/1850D-balanced-round.cpp" });
    expect(record.details).toBeUndefined();
    expect(gh.userCommits.map((c) => c.message)).toEqual(["Add Codeforces 1850D. Balanced Round (C++17 (GCC 7-32))"]);
    const file = gh.fileAt("codeforces/cpp/1850D-balanced-round.cpp")!;
    expect(file.split("\n").slice(0, 8)).toEqual([
      "// Codeforces 1850D. Balanced Round",
      "// https://codeforces.com/contest/1850/problem/D",
      "// Rating: 900",
      "// Language: C++17 (GCC 7-32)",
      "// Submission: 202",
      `// Submitted: ${new Date(AFTER * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}`,
      "// Runtime: 93 ms, Memory: 1.6 MB",
      "",
    ]);
    expect(file.endsWith(`\n\n${CODE}`)).toBe(true);
  });

  it("does not commit again for the same code, and updates for new code", async () => {
    const { gh, store, svc } = await setup();
    await deliver(svc, 202);
    await deliver(svc, 203);
    expect((await store.getRecords())["cf-203"]).toMatchObject({ status: "synced", outcome: "unchanged" });
    expect(gh.userCommits).toHaveLength(1);
    await deliver(svc, 204, CODE.replace("a&b", "faster"));
    expect((await store.getRecords())["cf-204"]).toMatchObject({ outcome: "updated" });
    expect(gh.userCommits.map((c) => c.message)[1]).toBe("Update Codeforces 1850D. Balanced Round (C++17 (GCC 7-32))");
  });

  it("keeps LeetCode files where they were", async () => {
    const { gh, svc } = await setup();
    await deliver(svc, 202);
    expect([...gh.head().tree.keys()].sort()).toEqual(["README.md", "codeforces/cpp/1850D-balanced-round.cpp"]);
  });

  it("uses the configured folder, metadata sidecar and separate-file policy", async () => {
    const { gh, svc } = await setup({ codeforcesFolder: "cf", metadataSidecar: true, historyPolicy: "separate" });
    await deliver(svc, 202);
    expect(gh.fileAt("cf/cpp/1850D-balanced-round/202.cpp")).toBeDefined();
    const meta = JSON.parse(gh.fileAt("metadata/cf/cpp/1850D-balanced-round/202.json")!);
    expect(meta).toMatchObject({ site: "codeforces", problem: { rating: 900 }, submission: { id: "202", url: "https://codeforces.com/contest/1850/submission/202" } });
    expect(gh.userCommits).toHaveLength(1);
  });

  it("waits for confirmation in manual mode", async () => {
    const { gh, store, svc } = await setup({ syncMode: "manual" });
    await deliver(svc, 202);
    expect((await store.getRecords())["cf-202"]!.status).toBe("ready");
    expect(gh.userCommits).toHaveLength(0);
    await svc.retry("cf-202");
    expect((await store.getRecords())["cf-202"]!.status).toBe("synced");
  });

  it("marks unreadable code for review instead of guessing", async () => {
    const store = new StateStore(new MemoryStore());
    const svc = new SyncService({ store, now: () => SINCE });
    await svc.reportCodeforcesDetected({ submissionId: "cf-202", titleSlug: "1850-d", title: "Balanced Round", frontendId: "1850D" });
    await svc.reportDetails("cf-202", { ok: false, error: { code: "details_unavailable", message: "security check", retryable: false } });
    expect((await store.getRecords())["cf-202"]).toMatchObject({ status: "needs_review", error: { code: "details_unavailable" } });
  });
});

describe("syncing a Codeforces submission from its page", () => {
  it("reads the submission from page URLs", () => {
    expect(submissionFromPath("/contest/1850/submission/202")).toEqual({ contestId: 1850, id: 202 });
    expect(submissionFromPath("/gym/104000/submission/7/")).toEqual({ contestId: 104000, id: 7 });
    expect(submissionFromPath("/problemset/submission/1850/202")).toEqual({ contestId: 1850, id: 202 });
    expect(submissionFromPath("/contest/1850/my")).toBeUndefined();
  });

  const input = { submissionId: "cf-202", titleSlug: "1850-d", title: "Balanced Round", frontendId: "1850D" };

  it("creates an approved record for a manual request, even outside the automatic window", async () => {
    const store = new StateStore(new MemoryStore());
    const svc = new SyncService({ store, now: () => SINCE });
    expect(await svc.reportCodeforcesDetected({ ...input, source: "manual" })).toEqual({ created: true, needDetails: true });
    expect((await store.getRecords())["cf-202"]).toMatchObject({ source: "manual", userApproved: true, status: "waiting_details" });
  });

  it("retries a submission that needed review", async () => {
    const store = new StateStore(new MemoryStore());
    const svc = new SyncService({ store, now: () => SINCE });
    await svc.reportCodeforcesDetected(input);
    await svc.reportDetails("cf-202", { ok: false, error: { code: "details_unavailable", message: "x", retryable: false } });
    expect(await svc.reportCodeforcesDetected({ ...input, source: "manual" })).toEqual({ created: false, needDetails: true });
    const r = (await store.getRecords())["cf-202"]!;
    expect(r.status).toBe("waiting_details");
    expect(r.error).toBeUndefined();
  });

  it("reports an already synced submission without doing anything", async () => {
    const gh = new FakeGitHub();
    const store = new StateStore(new MemoryStore());
    await store.saveSettings({ ...(await store.getSettings()), owner: gh.owner, repo: gh.repo, codeforcesEnabled: true });
    await store.setToken(gh.token);
    const svc = new SyncService({ store, fetch: gh.fetch, now: () => SINCE });
    await svc.reportCodeforcesDetected(input);
    const [s] = parseUserStatus(ok(sub(202, "OK")))!;
    await svc.reportDetails("cf-202", { ok: true, details: toSubmissionDetails(s!, CODE, "cpp") });
    expect(await svc.reportCodeforcesDetected({ ...input, source: "manual" })).toEqual({
      created: false,
      needDetails: false,
      message: "Already synced.",
    });
    expect(gh.userCommits).toHaveLength(1);
  });
});

describe("Codeforces check status", () => {
  it("reports each check's outcome", async () => {
    const seen: Array<[boolean, string | undefined]> = [];
    const make = (fetchJson: () => Promise<unknown>) =>
      new CodeforcesWatcher({
        handle: "me",
        sinceMs: SINCE,
        fetchJson,
        schedule: () => {},
        onAccepted: () => {},
        onChecked: (okay, message) => void seen.push([okay, message]),
      });
    await make(async () => ok()).check();
    await make(async () => ({ status: "FAILED" })).check();
    await make(async () => {
      throw new TypeError("offline");
    }).check();
    expect(seen.map(([okay]) => okay)).toEqual([true, false, false]);
    expect(seen[2]![1]).toMatch(/Could not reach/);
  });

  it("is stored and included in the state shown to the settings page", async () => {
    const store = new StateStore(new MemoryStore());
    const svc = new SyncService({ store, now: () => SINCE });
    expect((await svc.getPublicState()).codeforces).toBeUndefined();
    await store.setCodeforcesStatus({ handle: "me", checkedAt: SINCE, ok: true });
    expect((await svc.getPublicState()).codeforces).toEqual({ handle: "me", checkedAt: SINCE, ok: true });
  });
});
