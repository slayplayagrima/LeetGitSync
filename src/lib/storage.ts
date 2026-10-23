import type { ConnectionState, Settings, SyncRecord } from "../types";

/** The subset of chrome.storage.local used here, so tests can supply an in-memory version. */
export interface KeyValueStore {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export const DEFAULT_SETTINGS: Settings = {
  owner: "slayplayagrima",
  repo: "leetcode-solutions",
  branch: "main",
  syncMode: "auto",
  historyPolicy: "update",
  rootFolder: "",
  filenameStyle: "number-slug",
  languageFolders: {},
  includeHeader: true,
  metadataSidecar: false,
};

const KEYS = {
  settings: "settings",
  token: "githubToken",
  records: "syncRecords",
  connection: "connection",
} as const;

/** Synced records beyond this count are pruned, oldest first. Pending and failed ones are always kept. */
export const MAX_HISTORY = 500;

export function chromeLocalStore(): KeyValueStore {
  return {
    get: (keys) => chrome.storage.local.get(keys),
    set: (items) => chrome.storage.local.set(items),
    remove: (keys) => chrome.storage.local.remove(keys),
  };
}

export class MemoryStore implements KeyValueStore {
  data = new Map<string, unknown>();
  async get(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
  }
  async remove(keys: string[]): Promise<void> {
    for (const k of keys) this.data.delete(k);
  }
}

export function mergeSettings(stored: unknown): Settings {
  const s = stored && typeof stored === "object" ? (stored as Partial<Settings>) : {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    languageFolders: { ...(s.languageFolders ?? {}) },
  };
}

export function pruneRecords(records: Record<string, SyncRecord>, max = MAX_HISTORY): Record<string, SyncRecord> {
  const all = Object.values(records);
  const synced = all.filter((r) => r.status === "synced").sort((a, b) => b.updatedAt - a.updatedAt);
  if (synced.length <= max) return records;
  const drop = new Set(synced.slice(max).map((r) => r.submissionId));
  return Object.fromEntries(Object.entries(records).filter(([id]) => !drop.has(id)));
}

/**
 * Durable state for the service worker. Record updates are serialized through
 * one promise chain so concurrent events cannot overwrite each other.
 */
export class StateStore {
  readonly #kv: KeyValueStore;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(kv: KeyValueStore) {
    this.#kv = kv;
  }

  async getSettings(): Promise<Settings> {
    const got = await this.#kv.get([KEYS.settings]);
    return mergeSettings(got[KEYS.settings]);
  }

  async saveSettings(settings: Settings): Promise<void> {
    await this.#kv.set({ [KEYS.settings]: settings });
  }

  async getToken(): Promise<string | undefined> {
    const got = await this.#kv.get([KEYS.token]);
    const token = got[KEYS.token];
    return typeof token === "string" && token !== "" ? token : undefined;
  }

  async setToken(token: string): Promise<void> {
    await this.#kv.set({ [KEYS.token]: token });
  }

  async removeToken(): Promise<void> {
    await this.#kv.remove([KEYS.token]);
  }

  async getConnection(): Promise<ConnectionState> {
    const got = await this.#kv.get([KEYS.connection]);
    const c = got[KEYS.connection];
    return c && typeof c === "object" ? (c as ConnectionState) : { state: "unknown" };
  }

  async setConnection(connection: ConnectionState): Promise<void> {
    await this.#kv.set({ [KEYS.connection]: connection });
  }

  async getRecords(): Promise<Record<string, SyncRecord>> {
    const got = await this.#kv.get([KEYS.records]);
    const r = got[KEYS.records];
    return r && typeof r === "object" ? (r as Record<string, SyncRecord>) : {};
  }

  /** Atomically read-modify-write the record map. */
  updateRecords<T>(fn: (records: Record<string, SyncRecord>) => T): Promise<T> {
    const run = this.#chain.then(async () => {
      const records = await this.getRecords();
      const result = fn(records);
      await this.#kv.set({ [KEYS.records]: pruneRecords(records) });
      return result;
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async clearRecords(): Promise<void> {
    await this.updateRecords((records) => {
      for (const id of Object.keys(records)) delete records[id];
    });
  }
}
