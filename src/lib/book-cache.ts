import "server-only";

import fs from "node:fs";
import path from "node:path";

import type { FlipPage } from "@/lib/fliphtml5";
import {
  boundedFetch,
  isAllowedUpstream,
  LIMITS,
} from "@/lib/security";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/** Page label as returned by FlipHTML5 (e.g. "0001"). */
const PAGE_LABEL_RE = /^[0-9]{1,6}$/;

export type CacheKind = "large" | "thumb";

function resolveCacheRoot(): string {
  const fromEnv = process.env.BOOK_CACHE_DIR?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return path.join(process.cwd(), "data", "book-cache");
}

export function cacheDirForBook(libraryId: number): string {
  return path.join(resolveCacheRoot(), String(libraryId));
}

function subdir(libraryId: number, kind: CacheKind): string {
  return path.join(cacheDirForBook(libraryId), kind);
}

function completeMarkerPath(libraryId: number): string {
  return path.join(cacheDirForBook(libraryId), ".complete");
}

/**
 * Marker format: plain integer = total page count when **both** `large/` and
 * `thumb/` trees are complete for that many pages.
 */
export function isCacheComplete(libraryId: number, totalPages: number): boolean {
  if (!Number.isFinite(libraryId) || libraryId <= 0 || totalPages <= 0) {
    return false;
  }
  try {
    const raw = fs.readFileSync(completeMarkerPath(libraryId), "utf8").trim();
    const n = Number(raw);
    return Number.isFinite(n) && n === totalPages;
  } catch {
    return false;
  }
}

async function downloadImage(urlStr: string): Promise<Uint8Array> {
  const url = isAllowedUpstream(urlStr);
  if (!url) {
    throw new Error("Image URL not on allowlist");
  }
  const { response, body } = await boundedFetch(urlStr, {
    headers: {
      "user-agent": USER_AGENT,
      referer: `${url.protocol}//${url.host}/`,
    },
    cache: "no-store",
    maxBytes: LIMITS.imageMaxBytes,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return body;
}

type WorkUnit = { kind: CacheKind; page: FlipPage };

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const current = i++;
      if (current >= items.length) return;
      await worker(items[current]);
    }
  });
  await Promise.all(runners);
}

/**
 * Download every large and thumb `.webp` into
 * `{BOOK_CACHE_DIR}/<libraryId>/large/<page>.webp` and
 * `{BOOK_CACHE_DIR}/<libraryId>/thumb/<page>.webp`, then write `.complete`
 * only when **all** 2×N transfers succeeded. Idempotent when the marker
 * already matches `pages.length`.
 */
export async function ensureBookPagesOnDisk(
  libraryId: number,
  pages: FlipPage[],
): Promise<{ complete: boolean; saved: number; errors: string[] }> {
  if (!Number.isFinite(libraryId) || libraryId <= 0 || pages.length === 0) {
    return { complete: false, saved: 0, errors: ["invalid library or empty pages"] };
  }

  if (isCacheComplete(libraryId, pages.length)) {
    return { complete: true, saved: pages.length * 2, errors: [] };
  }

  const root = cacheDirForBook(libraryId);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(subdir(libraryId, "large"), { recursive: true });
  fs.mkdirSync(subdir(libraryId, "thumb"), { recursive: true });

  const work: WorkUnit[] = [];
  for (const page of pages) {
    if (!PAGE_LABEL_RE.test(page.pageNumber)) {
      return {
        complete: false,
        saved: 0,
        errors: [`invalid page label: ${page.pageNumber}`],
      };
    }
    work.push({ kind: "large", page });
    work.push({ kind: "thumb", page });
  }

  const errors: string[] = [];
  let saved = 0;
  let totalBytes = 0;
  let aborted = false;

  await runWithConcurrency(work, LIMITS.downloadConcurrency, async ({ kind, page }) => {
    if (aborted) return;
    const urlStr = kind === "large" ? page.largeUrl : page.thumbUrl;
    const label = `${kind}:${page.pageNumber}`;
    try {
      const buf = await downloadImage(urlStr);
      totalBytes += buf.byteLength;
      if (totalBytes > LIMITS.totalDownloadMaxBytes) {
        aborted = true;
        throw new Error("Total download size limit reached");
      }
      const filePath = path.join(subdir(libraryId, kind), `${page.pageNumber}.webp`);
      const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, filePath);
      saved++;
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
    }
  });

  if (aborted) {
    return { complete: false, saved, errors };
  }

  const expected = pages.length * 2;
  const complete = saved === expected && errors.length === 0;
  if (complete) {
    await fs.promises.writeFile(completeMarkerPath(libraryId), String(pages.length), "utf8");
  }

  return { complete, saved, errors };
}

/** Best-effort removal of all cached files for a library id. */
export function removeBookCache(libraryId: number): void {
  if (!Number.isFinite(libraryId) || libraryId <= 0) return;
  try {
    fs.rmSync(cacheDirForBook(libraryId), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export function readCachedPage(
  libraryId: number,
  pageLabel: string,
  kind: CacheKind,
): Buffer | null {
  if (!Number.isFinite(libraryId) || libraryId <= 0) return null;
  if (kind !== "large" && kind !== "thumb") return null;
  if (!PAGE_LABEL_RE.test(pageLabel)) return null;
  const filePath = path.join(subdir(libraryId, kind), `${pageLabel}.webp`);
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}
