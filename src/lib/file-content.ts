import type { SubmissionDetails } from "../types";
import type { LanguageInfo } from "./languages";

export function problemUrl(titleSlug: string): string {
  return `https://leetcode.com/problems/${encodeURIComponent(titleSlug)}/`;
}

export function submissionUrl(submissionId: string): string {
  return `https://leetcode.com/submissions/detail/${encodeURIComponent(submissionId)}/`;
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

export function buildHeader(details: SubmissionDetails, lang: LanguageInfo): string[] {
  const c = lang.comment;
  const number = details.frontendId ? `${oneLine(details.frontendId)}. ` : "";
  const title = oneLine(details.title ?? details.titleSlug);
  const lines = [
    `${c} LeetCode ${number}${title}`,
    `${c} ${problemUrl(details.titleSlug)}`,
  ];
  if (details.difficulty) lines.push(`${c} Difficulty: ${oneLine(details.difficulty)}`);
  lines.push(`${c} Language: ${oneLine(details.langName || details.langSlug)}`);
  lines.push(`${c} Submission: ${details.submissionId}`);
  lines.push(`${c} Submitted: ${formatTimestamp(details.timestamp)}`);
  const stats: string[] = [];
  if (details.runtime) stats.push(`Runtime: ${oneLine(details.runtime)}`);
  if (details.memory) stats.push(`Memory: ${oneLine(details.memory)}`);
  if (stats.length) lines.push(`${c} ${stats.join(", ")}`);
  return lines;
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
  const headerStart = `${lang.comment} LeetCode `;
  if (!fileContent.startsWith(headerStart)) return fileContent;
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
      url: problemUrl(details.titleSlug),
    },
    submission: {
      id: details.submissionId,
      url: submissionUrl(details.submissionId),
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
