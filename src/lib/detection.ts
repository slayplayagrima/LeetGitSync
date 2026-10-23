import { isValidSlug, isValidSubmissionId, parseCheckPayload } from "./validation";

export interface AcceptedEvent {
  submissionId: string;
  /** Slug from the submit request, when it was observed. */
  titleSlug?: string;
}

/**
 * Turns the stream of messages from the page hook into at most one
 * "accepted" event per submission id. LeetCode polls the judge result many
 * times and may re-render; everything after the first accepted result is
 * ignored. Pending, failed and "Run code" results never produce an event.
 */
export class AcceptedSubmissionTracker {
  readonly #handled = new Set<string>();
  readonly #slugs = new Map<string, string>();

  handle(data: unknown): AcceptedEvent | null {
    if (!data || typeof data !== "object") return null;
    const msg = data as { source?: unknown; kind?: unknown; payload?: unknown };
    if (msg.source !== "leetgitsync-hook") return null;

    if (msg.kind === "submitted") {
      const p = msg.payload as { titleSlug?: unknown; submissionId?: unknown } | undefined;
      if (isValidSubmissionId(p?.submissionId) && isValidSlug(p?.titleSlug)) {
        this.#slugs.set(p.submissionId, p.titleSlug);
        if (this.#slugs.size > 100) this.#slugs.delete(this.#slugs.keys().next().value as string);
      }
      return null;
    }

    if (msg.kind !== "check") return null;
    const result = parseCheckPayload(msg.payload);
    if (!result?.accepted || this.#handled.has(result.submissionId)) return null;
    this.#handled.add(result.submissionId);
    const titleSlug = this.#slugs.get(result.submissionId);
    return titleSlug ? { submissionId: result.submissionId, titleSlug } : { submissionId: result.submissionId };
  }
}
