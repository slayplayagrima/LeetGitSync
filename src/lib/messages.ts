import type { ConnectionState, PublicState, Settings, SubmissionDetails, SyncErrorInfo } from "../types";
import type { SettingsErrors } from "./validation";

/** Messages a LeetCode content script may send to the service worker. */
export type ContentToWorker =
  | { type: "content:hello" }
  | { type: "submission:accepted"; submissionId: string; titleSlug: string; source: "auto" | "manual" }
  | {
      type: "submission:details";
      submissionId: string;
      result: { ok: true; details: SubmissionDetails } | { ok: false; error: SyncErrorInfo };
    };

/** Messages only extension pages (popup, options) may send. */
export type PageToWorker =
  | { type: "state:get" }
  | { type: "settings:save"; settings: Settings }
  | { type: "token:set"; token: string }
  | { type: "token:remove" }
  | { type: "github:disconnect" }
  | { type: "connection:test" }
  | { type: "sync:retry"; submissionId?: string }
  | { type: "history:clear" };

export type WorkerMessage = ContentToWorker | PageToWorker;

/** Messages the service worker or popup sends to a LeetCode tab. */
export type ToContent =
  | { type: "toast"; kind: "success" | "info" | "error"; message: string }
  | { type: "details:request"; submissionId: string; titleSlug: string }
  | { type: "page:context" }
  | { type: "page:sync"; submissionId: string };

export interface PageContext {
  titleSlug?: string;
  /** Submission id in the URL (e.g. /problems/x/submissions/123/). */
  urlSubmissionId?: string;
  /** Most recent accepted submission seen on this tab. */
  lastAcceptedId?: string;
  hookActive: boolean;
}

export type Reply<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

export type StateReply = Reply<PublicState>;
export type SaveSettingsReply = Reply<undefined> | { ok: false; error: string; fieldErrors: SettingsErrors };
export type ConnectionReply = Reply<ConnectionState>;
