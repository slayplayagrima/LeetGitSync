const TOKEN_PATTERNS: RegExp[] = [
  // Fine-grained personal access tokens.
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // Classic, OAuth, user-to-server, server-to-server and refresh tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  // Authorization header values.
  /\b(Bearer|token)\s+[A-Za-z0-9_\-.=]{16,}/gi,
];

/** Replaces anything that looks like a GitHub credential with a placeholder. */
export function redact(input: string): string {
  let out = input;
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === "string" && /^(bearer|token)$/i.test(prefix) ? `${prefix} [redacted]` : "[redacted]",
    );
  }
  return out;
}

/** Redacts a value of unknown type for logging. */
export function redactUnknown(value: unknown): string {
  if (value instanceof Error) return redact(`${value.name}: ${value.message}`);
  if (typeof value === "string") return redact(value);
  try {
    return redact(JSON.stringify(value));
  } catch {
    return "[unserializable]";
  }
}
