import { describe, expect, it } from "vitest";
import {
  CodeforcesWatcher,
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
    expect(await svc.reportCodeforcesDetected(input)).toEqual({ created: true });
    expect(await svc.reportCodeforcesDetected(input)).toEqual({ created: false });
    const records = await store.getRecords();
    expect(Object.keys(records)).toEqual(["cf-396447161"]);
    expect(records["cf-396447161"]).toMatchObject({ platform: "codeforces", status: "detected", frontendId: "1850D" });
  });

  it("rejects ids that are not Codeforces ids", async () => {
    const { svc } = await service();
    expect(await svc.reportCodeforcesDetected({ ...input, submissionId: "12345" })).toEqual({ created: false });
  });

  it("does not hand Codeforces submissions to LeetCode tabs", async () => {
    const { svc } = await service();
    await svc.reportCodeforcesDetected(input);
    await svc.reportAccepted({ submissionId: "555", titleSlug: "two-sum", source: "auto" });
    expect((await svc.pendingDetailRequests()).map((p) => p.submissionId)).toEqual(["555"]);
    expect((await svc.pendingDetailRequests("codeforces")).map((p) => p.submissionId)).toEqual(["cf-396447161"]);
  });
});
