export interface LanguageInfo {
  /** Stable key used for the default folder name and for folder overrides. */
  key: string;
  label: string;
  extension: string;
  /** Line comment prefix used for the metadata header. */
  comment: string;
}

const PY: LanguageInfo = { key: "python", label: "Python", extension: "py", comment: "#" };
const SQL: LanguageInfo = { key: "sql", label: "SQL", extension: "sql", comment: "--" };

/** Keyed by the language slug LeetCode reports (`lang.name` in submission details). */
const LANGUAGES: Record<string, LanguageInfo> = {
  python3: PY,
  python: { ...PY, key: "python2", label: "Python 2" },
  pythondata: { ...PY, key: "pandas", label: "Pandas" },
  cpp: { key: "cpp", label: "C++", extension: "cpp", comment: "//" },
  c: { key: "c", label: "C", extension: "c", comment: "//" },
  java: { key: "java", label: "Java", extension: "java", comment: "//" },
  csharp: { key: "csharp", label: "C#", extension: "cs", comment: "//" },
  javascript: { key: "javascript", label: "JavaScript", extension: "js", comment: "//" },
  typescript: { key: "typescript", label: "TypeScript", extension: "ts", comment: "//" },
  php: { key: "php", label: "PHP", extension: "php", comment: "//" },
  swift: { key: "swift", label: "Swift", extension: "swift", comment: "//" },
  kotlin: { key: "kotlin", label: "Kotlin", extension: "kt", comment: "//" },
  dart: { key: "dart", label: "Dart", extension: "dart", comment: "//" },
  golang: { key: "go", label: "Go", extension: "go", comment: "//" },
  ruby: { key: "ruby", label: "Ruby", extension: "rb", comment: "#" },
  scala: { key: "scala", label: "Scala", extension: "scala", comment: "//" },
  rust: { key: "rust", label: "Rust", extension: "rs", comment: "//" },
  racket: { key: "racket", label: "Racket", extension: "rkt", comment: ";;" },
  erlang: { key: "erlang", label: "Erlang", extension: "erl", comment: "%" },
  elixir: { key: "elixir", label: "Elixir", extension: "ex", comment: "#" },
  bash: { key: "bash", label: "Bash", extension: "sh", comment: "#" },
  mysql: SQL,
  mssql: SQL,
  oraclesql: SQL,
  postgresql: SQL,
};

/** Default folder keys shown on the settings page, in display order. */
export const DEFAULT_FOLDER_KEYS: readonly string[] = [
  ...new Set(Object.values(LANGUAGES).map((l) => l.key)),
];

export function folderKeyLabel(key: string): string {
  return Object.values(LANGUAGES).find((l) => l.key === key)?.label ?? key;
}

/**
 * Maps a LeetCode language slug to file conventions. Unknown languages are kept
 * (never dropped) under their own slug with a plain-text extension.
 */
export function getLanguage(langSlug: string): LanguageInfo {
  const slug = langSlug.trim().toLowerCase();
  const known = LANGUAGES[slug];
  if (known) return known;
  const safe = slug.replace(/[^a-z0-9_-]/g, "") || "other";
  return { key: safe, label: langSlug || "Other", extension: "txt", comment: "#" };
}

export function isKnownLanguage(langSlug: string): boolean {
  return Object.prototype.hasOwnProperty.call(LANGUAGES, langSlug.trim().toLowerCase());
}
