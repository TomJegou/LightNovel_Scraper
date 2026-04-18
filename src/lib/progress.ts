/**
 * Client-side reading progress stored in localStorage.
 *
 * Keyed on the library entry id (assigned server-side, stable across
 * renames). The store is shared across browser tabs of the same origin
 * (localStorage) so opening the same book in two tabs keeps the last
 * viewed page consistent. Completely opaque to the server.
 */

const STORAGE_KEY = "lightnovel-scraper.progress.v1";
const MAX_ENTRIES = 500;
const MAX_PAGE = 100_000;

export type ProgressEntry = {
  lastPage: number;
  updatedAt: number;
};

type Store = Record<string, ProgressEntry>;

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function sanitizeEntry(raw: unknown): ProgressEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const lastPage = Number(r.lastPage);
  const updatedAt = Number(r.updatedAt);
  if (!Number.isFinite(lastPage) || lastPage < 1 || lastPage > MAX_PAGE) return null;
  if (!Number.isFinite(updatedAt) || updatedAt < 0) return null;
  return { lastPage: Math.trunc(lastPage), updatedAt: Math.trunc(updatedAt) };
}

function readStore(): Store {
  if (!isBrowser()) return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!/^\d+$/.test(k)) continue;
      const entry = sanitizeEntry(v);
      if (entry) out[k] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  if (!isBrowser()) return;
  try {
    const keys = Object.keys(store);
    if (keys.length > MAX_ENTRIES) {
      // Keep only the most recently updated entries (LRU by updatedAt).
      const trimmed = keys
        .map((k) => [k, store[k]] as const)
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, MAX_ENTRIES);
      const next: Store = {};
      for (const [k, v] of trimmed) next[k] = v;
      store = next;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Quota exceeded or localStorage disabled — silently ignore.
  }
}

export function getProgress(libraryId: number): ProgressEntry | null {
  if (!Number.isFinite(libraryId) || libraryId <= 0) return null;
  const store = readStore();
  return store[String(libraryId)] ?? null;
}

export function setProgress(libraryId: number, page: number): void {
  if (!isBrowser()) return;
  if (!Number.isFinite(libraryId) || libraryId <= 0) return;
  if (!Number.isFinite(page) || page < 1 || page > MAX_PAGE) return;
  const store = readStore();
  store[String(libraryId)] = {
    lastPage: Math.trunc(page),
    updatedAt: Date.now(),
  };
  writeStore(store);
}

export function clearProgress(libraryId: number): void {
  if (!isBrowser()) return;
  const store = readStore();
  if (!(String(libraryId) in store)) return;
  delete store[String(libraryId)];
  writeStore(store);
}

export function listProgress(): Store {
  return readStore();
}
