import type { SubmissionDetails } from "../types";
import type { LanguageInfo } from "./languages";

type UrlDetails = Pick<SubmissionDetails, "titleSlug" | "submissionId"> &
  Partial<Pick<SubmissionDetails, "platform" | "contestId" | "frontendId">>;

function codeforcesSection(contestId: number): string {
  return contestId >= 100000 ? "gym" : "contest";
}

/** The submission id people see on the site (Codeforces record ids carry a "cf-" prefix). */
export function displaySubmissionId(details: Pick<SubmissionDetails, "submissionId">): string {
  return details.submissionId.replace(/^cf-/, "");
}

export function problemUrl(details: UrlDetails): string {
  if (details.platform === "codeforces" && details.contestId !== undefined) {
    const index = (details.frontendId ?? "").slice(String(details.contestId).length);
    return `https://codeforces.com/${codeforcesSection(details.contestId)}/${details.contestId}/problem/${encodeURIComponent(index)}`;
  }
  return `https://leetcode.com/problems/${encodeURIComponent(details.titleSlug)}/`;
}

export function submissionUrl(details: UrlDetails): string {
  if (details.platform === "codeforces" && details.contestId !== undefined) {
    return `https://codeforces.com/${codeforcesSection(details.contestId)}/${details.contestId}/submission/${displaySubmissionId(details)}`;
  }
  return `https://leetcode.com/submissions/detail/${encodeURIComponent(details.submissionId)}/`;
}

export function formatTimestamp(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** Keeps header values on one line so they can never break out of the comment. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

const SITE_NAMES = ["LeetCode", "Codeforces"] as const;

export function buildHeader(details: SubmissionDetails, lang: LanguageInfo): string[] {
  const c = lang.comment;
  const end = lang.commentEnd ? ` ${lang.commentEnd}` : "";
  const site = details.platform === "codeforces" ? "Codeforces" : "LeetCode";
  const number = details.frontendId ? `${oneLine(details.frontendId)}. ` : "";
  const title = oneLine(details.title ?? details.titleSlug);
  const lines = [`${site} ${number}${title}`, problemUrl(details)];
  if (details.difficulty) lines.push(`Difficulty: ${oneLine(details.difficulty)}`);
  if (details.rating !== undefined) lines.push(`Rating: ${details.rating}`);
  lines.push(`Language: ${oneLine(details.langName || details.langSlug)}`);
  lines.push(`Submission: ${displaySubmissionId(details)}`);
  lines.push(`Submitted: ${formatTimestamp(details.timestamp)}`);
  const stats: string[] = [];
  if (details.runtime) stats.push(`Runtime: ${oneLine(details.runtime)}`);
  if (details.memory) stats.push(`Memory: ${oneLine(details.memory)}`);
  if (stats.length) lines.push(stats.join(", "));
  return lines.map((line) => `${c} ${line}${end}`);
}

/** File body: optional metadata header, one blank line, then the submitted code untouched. */
export function buildSolutionFile(
  details: SubmissionDetails,
  lang: LanguageInfo,
  includeHeader: boolean,
): string {
  const code = ensureTrailingNewline(details.code);
  if (!includeHeader) return code;
  return `${buildHeader(details, lang).join("\n")}\n\n${code}`;
}

/**
 * Recovers the submitted code from a file this extension wrote, whether or not
 * it has a header. The header always ends at the first blank line.
 */
export function extractCode(fileContent: string, lang: LanguageInfo): string {
  if (!SITE_NAMES.some((site) => fileContent.startsWith(`${lang.comment} ${site} `))) return fileContent;
  const end = fileContent.indexOf("\n\n");
  if (end === -1) return fileContent;
  const header = fileContent.slice(0, end).split("\n");
  if (!header.every((line) => line.startsWith(lang.comment))) return fileContent;
  return fileContent.slice(end + 2);
}

/** True when an existing file already holds exactly this submission's code. */
export function hasSameCode(existingFile: string, code: string, lang: LanguageInfo): boolean {
  return extractCode(existingFile, lang) === ensureTrailingNewline(code);
}

export function buildMetadataJson(details: SubmissionDetails, solutionPath: string): string {
  const meta = {
    problem: {
      number: details.frontendId ?? null,
      title: details.title ?? null,
      slug: details.titleSlug,
      difficulty: details.difficulty ?? null,
      ...(details.rating !== undefined ? { rating: details.rating } : {}),
      url: problemUrl(details),
    },
    site: details.platform === "codeforces" ? "codeforces" : "leetcode",
    submission: {
      id: displaySubmissionId(details),
      url: submissionUrl(details),
      submittedAt: new Date(details.timestamp * 1000).toISOString(),
      language: details.langName || details.langSlug,
      languageSlug: details.langSlug,
      runtime: details.runtime ?? null,
      memory: details.memory ?? null,
    },
    file: solutionPath,
  };
  return `${JSON.stringify(meta, null, 2)}\n`;
}
