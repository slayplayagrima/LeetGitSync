import { redactUnknown } from "./redact";

const PREFIX = "[LeetGitSync]";

/** Console logging that never prints credentials. Source code is never passed here. */
export const log = {
  info(message: string, ...extra: unknown[]): void {
    console.info(PREFIX, message, ...extra.map(redactUnknown));
  },
  warn(message: string, ...extra: unknown[]): void {
    console.warn(PREFIX, message, ...extra.map(redactUnknown));
  },
  error(message: string, ...extra: unknown[]): void {
    console.error(PREFIX, message, ...extra.map(redactUnknown));
  },
};
