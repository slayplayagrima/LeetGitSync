import type { FilenameStyle, Settings, SubmissionDetails } from "../types";
import { getLanguage } from "./languages";

/**
 * Turns a LeetCode title or slug into a lowercase, hyphen-separated, ASCII-only
 * name that is safe as a file name on every platform.
 */
export function normalizeTitle(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
}

/** Zero-pads numeric problem numbers ("1" -> "0001"); normalizes anything else. */
export function formatProblemNumber(frontendId: string | undefined): string | undefined {
  if (!frontendId) return undefined;
  const trimmed = frontendId.trim();
  if (/^\d+$/.test(trimmed)) return trimmed.padStart(4, "0");
  const normalized = normalizeTitle(trimmed);
  return normalized || undefined;
}

export function buildBaseName(
  style: FilenameStyle,
  titleSlug: string,
  frontendId: string | undefined,
): string {
  const slug = normalizeTitle(titleSlug);
  if (!slug) throw new Error("Problem slug is empty after normalization.");
  const num = formatProblemNumber(frontendId);
  if (!num || style === "slug") return slug;
  return style === "number-dot-slug" ? `${num}.${slug}` : `${num}-${slug}`;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** True when `folder` is empty or a relative path of safe segments (no "..", no leading slash). */
export function isSafeFolder(folder: string): boolean {
  if (folder === "") return true;
  return folder
    .split("/")
    .every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..");
}

export function cleanFolder(folder: string): string {
  return folder.trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

function join(...parts: string[]): string {
  return parts.filter((p) => p !== "").join("/");
}

export interface SolutionPaths {
  path: string;
  metadataPath: string;
  folderKey: string;
}

export function buildPaths(
  settings: Pick<Settings, "rootFolder" | "filenameStyle" | "languageFolders" | "historyPolicy">,
  details: Pick<SubmissionDetails, "titleSlug" | "frontendId" | "langSlug" | "submissionId">,
): SolutionPaths {
  const lang = getLanguage(details.langSlug);
  const root = cleanFolder(settings.rootFolder);
  const folder = cleanFolder(settings.languageFolders[lang.key] ?? lang.key);
  if (!isSafeFolder(root) || !isSafeFolder(folder) || folder === "") {
    throw new Error(`Folder name "${join(root, folder)}" contains characters that are not allowed.`);
  }
  const base = buildBaseName(settings.filenameStyle, details.titleSlug, details.frontendId);
  const id = details.submissionId;
  if (!/^\d+$/.test(id)) throw new Error("Submission id must be numeric.");

  const path =
    settings.historyPolicy === "separate"
      ? join(root, folder, base, `${id}.${lang.extension}`)
      : join(root, folder, `${base}.${lang.extension}`);
  const metadataPath =
    settings.historyPolicy === "separate"
      ? join(root, "metadata", folder, base, `${id}.json`)
      : join(root, "metadata", folder, `${base}.json`);
  return { path, metadataPath, folderKey: lang.key };
}
