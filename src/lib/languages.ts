export interface LanguageInfo {
  /** Stable key used for the default folder name and for folder overrides. */
  key: string;
  label: string;
  extension: string;
  /** Line comment prefix used for the metadata header. */
  comment: string;
  /** Closing marker for languages without line comments, e.g. OCaml's "*)". */
  commentEnd?: string;
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
  haskell: { key: "haskell", label: "Haskell", extension: "hs", comment: "--" },
  ocaml: { key: "ocaml", label: "OCaml", extension: "ml", comment: "(*", commentEnd: "*)" },
  pascal: { key: "pascal", label: "Pascal", extension: "pas", comment: "//" },
  perl: { key: "perl", label: "Perl", extension: "pl", comment: "#" },
  d: { key: "d", label: "D", extension: "d", comment: "//" },
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

/**
 * Maps a Codeforces `programmingLanguage` string (e.g. "C++17 (GCC 7-32)",
 * "PyPy 3-64", "Java 21") to the language slugs used above.
 */
export function codeforcesLangSlug(programmingLanguage: string): string {
  const l = programmingLanguage.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/c\+\+|g\+\+|clang\+\+/, "cpp"],
    [/c#|mono|\.net/, "csharp"],
    [/pypy 2|python 2/, "python"],
    [/pypy|python/, "python3"],
    [/kotlin/, "kotlin"],
    [/java(?!script)/, "java"],
    [/typescript/, "typescript"],
    [/javascript|node\.js|\bv8\b/, "javascript"],
    [/rust/, "rust"],
    [/^go\b|golang/, "golang"],
    [/ruby/, "ruby"],
    [/scala/, "scala"],
    [/php/, "php"],
    [/haskell/, "haskell"],
    [/ocaml/, "ocaml"],
    [/pascal|delphi/, "pascal"],
    [/perl/, "perl"],
    [/swift/, "swift"],
    [/dart/, "dart"],
    [/^d\b|\bdmd\b|\bldc\b/, "d"],
    [/gnu c\b|gnu c11|^c11|^c\b|\bc \(/, "c"],
  ];
  for (const [re, slug] of rules) if (re.test(l)) return slug;
  return l.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "other";
}
