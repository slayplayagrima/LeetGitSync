import type { HistoryPolicy, SyncRecord } from "../types";

export type DetectionDecision =
  /** Never seen: create a record and fetch details. */
  | { action: "create" }
  /** Known but still missing details (e.g. the tab reloaded mid-way): fetch them again. */
  | { action: "request_details" }
  /** Already handled or in progress: do nothing. */
  | { action: "ignore"; reason: string };

/**
 * Decides what to do when an accepted submission is reported. The submission id
 * is the deduplication key, so repeated status updates, re-renders and reloads
 * never queue the same submission twice.
 */
export function decideOnDetection(existing: SyncRecord | undefined, source: "auto" | "manual"): DetectionDecision {
  if (!existing) return { action: "create" };
  switch (existing.status) {
    case "synced":
      return { action: "ignore", reason: "Already synced." };
    case "syncing":
    case "ready":
      return { action: "ignore", reason: "Already queued." };
    case "detected":
    case "waiting_details":
      return { action: "request_details" };
    case "failed":
    case "needs_review":
      return source === "manual" ? { action: "request_details" } : { action: "ignore", reason: "Waiting for your retry." };
  }
}

/**
 * Finds an earlier synced record that already put this exact code at this
 * destination, so no request or commit is needed.
 *
 * With the "update" policy only the latest sync of that file counts, because an
 * older match may since have been overwritten by different code.
 */
export function findSyncedDuplicate(
  records: Record<string, SyncRecord>,
  candidate: Pick<SyncRecord, "submissionId" | "titleSlug" | "langSlug" | "path" | "codeHash">,
  policy: HistoryPolicy,
): SyncRecord | undefined {
  if (!candidate.codeHash) return undefined;
  const synced = Object.values(records).filter(
    (r) =>
      r.status === "synced" &&
      r.submissionId !== candidate.submissionId &&
      r.titleSlug === candidate.titleSlug &&
      r.langSlug === candidate.langSlug &&
      r.codeHash !== undefined,
  );
  if (policy === "separate") return synced.find((r) => r.codeHash === candidate.codeHash);
  const latestForPath = synced
    .filter((r) => r.path === candidate.path)
    .sort((a, b) => (b.syncedAt ?? 0) - (a.syncedAt ?? 0))[0];
  return latestForPath?.codeHash === candidate.codeHash ? latestForPath : undefined;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
