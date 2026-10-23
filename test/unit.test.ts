import { describe, expect, it } from "vitest";
import { decideOnDetection, findSyncedDuplicate, sha256Hex } from "../src/lib/deduplication";
import { backoffDelay, isRetryable, mapGitHubError, SyncError, toErrorInfo } from "../src/lib/errors";
import { buildHeader, buildMetadataJson, buildSolutionFile, extractCode, hasSameCode } from "../src/lib/file-content";
import { buildBaseName, buildPaths, formatProblemNumber, isSafeFolder, normalizeTitle } from "../src/lib/filename";
import { decodeBase64Utf8, encodeBase64Utf8 } from "../src/lib/github-client";
import { getLanguage, isKnownLanguage } from "../src/lib/languages";
import { readCsrfCookie } from "../src/lib/leetcode-client";
import { redact } from "../src/lib/redact";
import { DEFAULT_SETTINGS } from "../src/lib/storage";
import {
  isValidBranch,
  parseCheckPayload,
  parseQuestion,
  parseSubmissionDetails,
  slugFromPath,
  submissionIdFromPath,
  validateSettings,
} from "../src/lib/validation";
import type { SubmissionDetails, SyncRecord } from "../src/types";

const details: SubmissionDetails = {
  submissionId: "1234567890",
  code: "class Solution:\n    def twoSum(self, nums, target):\n        # keep my comment\n        return []\n",
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
};

describe("title normalization", () => {
  it("lowercases and hyphenates", () => {
    expect(normalizeTitle("Two Sum")).toBe("two-sum");
    expect(normalizeTitle("Pow(x, n)")).toBe("pow-x-n");
    expect(normalizeTitle("  Reverse   Words in a String III ")).toBe("reverse-words-in-a-string-iii");
  });
  it("strips accents, apostrophes and unsafe characters", () => {
    expect(normalizeTitle("Café's Problem!")).toBe("cafes-problem");
    expect(normalizeTitle("../../etc/passwd")).toBe("etc-passwd");
    expect(normalizeTitle("两数之和")).toBe("");
  });
  it("caps length", () => {
    expect(normalizeTitle("a".repeat(300)).length).toBeLessThanOrEqual(100);
  });
});

describe("filename generation", () => {
  it("pads numeric problem numbers", () => {
    expect(formatProblemNumber("1")).toBe("0001");
    expect(formatProblemNumber("2534")).toBe("2534");
    expect(formatProblemNumber("LCP 01")).toBe("lcp-01");
    expect(formatProblemNumber(undefined)).toBeUndefined();
  });
  it("supports each style", () => {
    expect(buildBaseName("number-slug", "two-sum", "1")).toBe("0001-two-sum");
    expect(buildBaseName("number-dot-slug", "two-sum", "1")).toBe("0001.two-sum");
    expect(buildBaseName("slug", "two-sum", "1")).toBe("two-sum");
    expect(buildBaseName("number-slug", "two-sum", undefined)).toBe("two-sum");
  });
  it("builds default paths", () => {
    expect(buildPaths(DEFAULT_SETTINGS, details)).toEqual({
      path: "python/0001-two-sum.py",
      metadataPath: "metadata/python/0001-two-sum.json",
      folderKey: "python",
    });
  });
  it("honours root folder, overrides and the separate policy", () => {
    const s = { ...DEFAULT_SETTINGS, rootFolder: "/leetcode/", languageFolders: { python: "py3" }, historyPolicy: "separate" as const };
    expect(buildPaths(s, details).path).toBe("leetcode/py3/0001-two-sum/1234567890.py");
    expect(buildPaths(s, details).metadataPath).toBe("leetcode/metadata/py3/0001-two-sum/1234567890.json");
  });
  it("rejects unsafe folders", () => {
    expect(isSafeFolder("a/b")).toBe(true);
    expect(isSafeFolder("../x")).toBe(false);
    expect(isSafeFolder("a b")).toBe(false);
    expect(() => buildPaths({ ...DEFAULT_SETTINGS, rootFolder: "../evil" }, details)).toThrow();
  });
});

describe("language mapping", () => {
  it("maps common LeetCode languages", () => {
    expect(getLanguage("python3")).toMatchObject({ key: "python", extension: "py", comment: "#" });
    expect(getLanguage("cpp")).toMatchObject({ key: "cpp", extension: "cpp", comment: "//" });
    expect(getLanguage("golang")).toMatchObject({ key: "go", extension: "go" });
    expect(getLanguage("mysql")).toMatchObject({ key: "sql", extension: "sql", comment: "--" });
    expect(getLanguage("typescript").extension).toBe("ts");
  });
  it("keeps unknown languages instead of dropping them", () => {
    expect(isKnownLanguage("cobol")).toBe(false);
    expect(getLanguage("Cobol")).toMatchObject({ key: "cobol", extension: "txt" });
  });
});

describe("file content", () => {
  const py = getLanguage("python3");
  it("adds a header and preserves code exactly", () => {
    const file = buildSolutionFile(details, py, true);
    expect(file.startsWith("# LeetCode 1. Two Sum\n# https://leetcode.com/problems/two-sum/\n")).toBe(true);
    expect(file).toContain("# Submission: 1234567890");
    expect(file).toContain("# Runtime: 0 ms, Memory: 17.9 MB");
    expect(file.endsWith(`\n\n${details.code}`)).toBe(true);
  });
  it("omits stats it does not have", () => {
    const { runtime: _r, memory: _m, difficulty: _d, ...rest } = details;
    const header = buildHeader(rest, py).join("\n");
    expect(header).not.toContain("Runtime");
    expect(header).not.toContain("Difficulty");
  });
  it("round-trips through extractCode with or without header", () => {
    expect(extractCode(buildSolutionFile(details, py, true), py)).toBe(details.code);
    expect(extractCode(buildSolutionFile(details, py, false), py)).toBe(details.code);
    expect(hasSameCode(buildSolutionFile(details, py, true), details.code, py)).toBe(true);
    expect(hasSameCode(buildSolutionFile(details, py, true), details.code + "x", py)).toBe(false);
  });
  it("adds a trailing newline only when missing", () => {
    expect(buildSolutionFile({ ...details, code: "x = 1" }, py, false)).toBe("x = 1\n");
  });
  it("keeps header values on one line", () => {
    const header = buildHeader({ ...details, title: "Evil\nimport os" }, py);
    expect(header.every((l) => l.startsWith("#"))).toBe(true);
  });
  it("writes metadata JSON", () => {
    const meta = JSON.parse(buildMetadataJson(details, "python/0001-two-sum.py"));
    expect(meta.submission.id).toBe("1234567890");
    expect(meta.problem.url).toBe("https://leetcode.com/problems/two-sum/");
    expect(meta.file).toBe("python/0001-two-sum.py");
  });
});

describe("base64", () => {
  it("round-trips unicode", () => {
    const text = "# 注释 — émoji 🚀\nprint('hi')\n";
    expect(decodeBase64Utf8(encodeBase64Utf8(text))).toBe(text);
  });
  it("rejects non-UTF-8 content", () => {
    expect(() => decodeBase64Utf8(btoa("\xff\xfe\xfd"))).toThrow(SyncError);
  });
});

describe("token redaction", () => {
  it("removes fine-grained and classic tokens", () => {
    const fg = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
    expect(redact(`token is ${fg}`)).toBe("token is [redacted]");
    expect(redact("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("[redacted]");
    expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toBe("Authorization: Bearer [redacted]");
  });
  it("leaves ordinary text alone", () => {
    expect(redact("Synced 0001-two-sum.py")).toBe("Synced 0001-two-sum.py");
  });
  it("is applied to SyncError messages", () => {
    expect(new SyncError("unknown", "bad github_pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaa").message).toBe("bad [redacted]");
  });
});

describe("retry classification", () => {
  it("retries only transient failures", () => {
    for (const code of ["network", "rate_limited", "server_error", "conflict"] as const) expect(isRetryable(code)).toBe(true);
    for (const code of ["auth_invalid", "permission_denied", "repo_not_found", "branch_not_found", "validation"] as const) {
      expect(isRetryable(code)).toBe(false);
    }
  });
  it("backs off exponentially with a cap", () => {
    expect(backoffDelay(1)).toBe(30_000);
    expect(backoffDelay(2)).toBe(60_000);
    expect(backoffDelay(3)).toBe(120_000);
    expect(backoffDelay(20)).toBe(30 * 60_000);
  });
  it("classifies thrown values", () => {
    expect(toErrorInfo(new TypeError("Failed to fetch")).code).toBe("network");
    expect(toErrorInfo(new Error("boom"))).toMatchObject({ code: "unknown", retryable: false });
  });
});

describe("GitHub error mapping", () => {
  const ctx = { owner: "me", repo: "sols", branch: "main", operation: "write" as const };
  const h = (o: Record<string, string> = {}) => new Headers(o);
  it("maps status codes", () => {
    expect(mapGitHubError(401, h(), "Bad credentials", ctx).code).toBe("auth_invalid");
    expect(mapGitHubError(403, h(), "Resource not accessible by personal access token", ctx).code).toBe("permission_denied");
    expect(mapGitHubError(404, h(), "Not Found", ctx).code).toBe("repo_not_found");
    expect(mapGitHubError(404, h(), "Not Found", { ...ctx, operation: "branch" }).code).toBe("branch_not_found");
    expect(mapGitHubError(409, h(), "Git Repository is empty.", ctx).code).toBe("repo_empty");
    expect(mapGitHubError(422, h(), "Update is not a fast forward", ctx).code).toBe("conflict");
    expect(mapGitHubError(502, h(), "", ctx)).toMatchObject({ code: "server_error", retryable: true });
  });
  it("detects rate limits and when to retry", () => {
    const now = 1_000_000;
    const err = mapGitHubError(403, h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000" }), "API rate limit exceeded", ctx, now);
    expect(err.code).toBe("rate_limited");
    expect(err.retryAt).toBe(2_000_000);
    expect(mapGitHubError(429, h({ "retry-after": "60" }), "", ctx, now).retryAt).toBe(now + 60_000);
  });
  it("never echoes credentials", () => {
    const err = mapGitHubError(400, h(), "weird github_pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ctx);
    expect(err.message).not.toContain("github_pat_a");
  });
});

describe("validation", () => {
  it("validates settings", () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual({});
    const bad = validateSettings({ ...DEFAULT_SETTINGS, owner: "-x", repo: "a b", branch: "bad..branch", rootFolder: "../" });
    expect(Object.keys(bad).sort()).toEqual(["branch", "owner", "repo", "rootFolder"]);
  });
  it("validates branch names", () => {
    expect(isValidBranch("main")).toBe(true);
    expect(isValidBranch("feature/sync")).toBe(true);
    expect(isValidBranch("a..b")).toBe(false);
    expect(isValidBranch("x.lock")).toBe(false);
    expect(isValidBranch("has space")).toBe(false);
  });
  it("parses LeetCode submission details", () => {
    const raw = {
      data: {
        submissionDetails: {
          code: "print(1)",
          timestamp: 1700000000,
          statusCode: 10,
          runtimeDisplay: "3 ms",
          memoryDisplay: "16 MB",
          lang: { name: "python3", verboseName: "Python3" },
          question: { questionId: "1", titleSlug: "two-sum" },
        },
      },
    };
    const parsed = parseSubmissionDetails(raw, "42");
    expect(parsed).toEqual({
      ok: true,
      value: {
        submissionId: "42",
        code: "print(1)",
        langSlug: "python3",
        langName: "Python3",
        timestamp: 1700000000,
        statusCode: 10,
        runtime: "3 ms",
        memory: "16 MB",
        titleSlug: "two-sum",
        questionId: "1",
      },
    });
  });
  it("rejects incomplete submission details", () => {
    expect(parseSubmissionDetails({ data: { submissionDetails: null } }, "1").ok).toBe(false);
    expect(parseSubmissionDetails({ errors: [{ message: "x" }] }, "1").ok).toBe(false);
    expect(parseSubmissionDetails({ data: { submissionDetails: { code: "x", lang: { name: "python3" } } } }, "1").ok).toBe(false);
  });
  it("parses the public question query and checks the slug", () => {
    const raw = { data: { question: { questionFrontendId: "1", title: "Two Sum", titleSlug: "two-sum", difficulty: "Easy" } } };
    expect(parseQuestion(raw, "two-sum")).toEqual({ frontendId: "1", title: "Two Sum", difficulty: "Easy" });
    expect(parseQuestion(raw, "other")).toBeNull();
  });
  it("only treats a finished Accepted judge result as accepted", () => {
    const base = { submissionId: "99", state: "SUCCESS", statusCode: 10, statusMsg: "Accepted", finished: true };
    expect(parseCheckPayload(base)).toEqual({ submissionId: "99", finished: true, accepted: true });
    expect(parseCheckPayload({ ...base, state: "PENDING" })?.accepted).toBe(false);
    expect(parseCheckPayload({ ...base, state: "STARTED" })?.accepted).toBe(false);
    expect(parseCheckPayload({ ...base, statusCode: 11, statusMsg: "Wrong Answer" })?.accepted).toBe(false);
    expect(parseCheckPayload({ ...base, statusCode: 15, statusMsg: "Runtime Error" })?.accepted).toBe(false);
    expect(parseCheckPayload({ ...base, statusCode: 20, statusMsg: "Compile Error" })?.accepted).toBe(false);
    // v2 responses may omit status_msg.
    expect(parseCheckPayload({ submissionId: "99", state: "SUCCESS", statusCode: 10 })?.accepted).toBe(true);
    expect(parseCheckPayload({ submissionId: "99", state: "SUCCESS", statusCode: 11 })?.accepted).toBe(false);
    // "Run code" results use non-numeric ids and must never count.
    expect(parseCheckPayload({ ...base, submissionId: "runcode_1700000000.1_abc" })).toBeNull();
  });
  it("reads slugs and ids from URLs", () => {
    expect(slugFromPath("/problems/two-sum/description/")).toBe("two-sum");
    expect(slugFromPath("/problemset/")).toBeUndefined();
    expect(submissionIdFromPath("/problems/two-sum/submissions/1234/")).toBe("1234");
    expect(submissionIdFromPath("/submissions/detail/987/")).toBe("987");
    expect(submissionIdFromPath("/problems/two-sum/")).toBeUndefined();
  });
  it("reads the csrf cookie", () => {
    expect(readCsrfCookie("a=1; csrftoken=abc%3D; b=2")).toBe("abc=");
    expect(readCsrfCookie("a=1")).toBeUndefined();
  });
});

describe("deduplication", () => {
  const rec = (over: Partial<SyncRecord>): SyncRecord => ({
    submissionId: "1",
    titleSlug: "two-sum",
    status: "synced",
    source: "auto",
    detectedAt: 0,
    updatedAt: 0,
    attempts: 1,
    ...over,
  });
  it("uses the submission id as the key", () => {
    expect(decideOnDetection(undefined, "auto")).toEqual({ action: "create" });
    expect(decideOnDetection(rec({ status: "synced" }), "auto").action).toBe("ignore");
    expect(decideOnDetection(rec({ status: "syncing" }), "auto").action).toBe("ignore");
    expect(decideOnDetection(rec({ status: "waiting_details" }), "auto").action).toBe("request_details");
    expect(decideOnDetection(rec({ status: "failed" }), "auto").action).toBe("ignore");
    expect(decideOnDetection(rec({ status: "failed" }), "manual").action).toBe("request_details");
  });
  it("finds identical code already synced to the same file", async () => {
    const hash = await sha256Hex("code");
    const records = {
      "1": rec({ submissionId: "1", langSlug: "python3", path: "p.py", codeHash: hash, syncedAt: 1 }),
    };
    const candidate = { submissionId: "2", titleSlug: "two-sum", langSlug: "python3", path: "p.py", codeHash: hash };
    expect(findSyncedDuplicate(records, candidate, "update")?.submissionId).toBe("1");
    expect(findSyncedDuplicate(records, { ...candidate, langSlug: "cpp" }, "update")).toBeUndefined();
  });
  it("ignores an older match that was overwritten since (update policy)", async () => {
    const a = await sha256Hex("A");
    const b = await sha256Hex("B");
    const records = {
      "1": rec({ submissionId: "1", langSlug: "python3", path: "p.py", codeHash: a, syncedAt: 1 }),
      "2": rec({ submissionId: "2", langSlug: "python3", path: "p.py", codeHash: b, syncedAt: 2 }),
    };
    const candidate = { submissionId: "3", titleSlug: "two-sum", langSlug: "python3", path: "p.py", codeHash: a };
    expect(findSyncedDuplicate(records, candidate, "update")).toBeUndefined();
    expect(findSyncedDuplicate(records, candidate, "separate")?.submissionId).toBe("1");
  });
});
