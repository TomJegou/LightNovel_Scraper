import "server-only";

import fs from "node:fs";
import path from "node:path";

import type { FlipBook, FlipPage } from "@/lib/fliphtml5";
import {
  boundedFetch,
  isAllowedUpstream,
  LIMITS,
} from "@/lib/security";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/** Page label as returned by FlipHTML5 (e.g. "0001"). */
const PAGE_LABEL_RE = /^[0-9]{1,6}$/;

export type CacheKind = "large" | "thumb" | "overlay";

/** File extension on disk for each cached asset. */
const EXT: Record<CacheKind, string> = {
  large: "webp",
  thumb: "webp",
  overlay: "svg",
};

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
 * Marker format:
 *   - legacy: plain integer = total page count (large + thumb only).
 *   - v2:    "<totalPages>:<totalAssets>" where totalAssets counts every
 *            expected file on disk (large + thumb + overlay for each page
 *            that exposes one). Switching to v2 lets us detect when a book
 *            previously cached without overlays needs to re-fetch the newly
 *            exposed `.svg` files.
 */
function parseMarker(raw: string): { pages: number; assets: number } | null {
  const trimmed = raw.trim();
  if (trimmed.includes(":")) {
    const [p, a] = trimmed.split(":");
    const pages = Number(p);
    const assets = Number(a);
    if (Number.isFinite(pages) && Number.isFinite(assets)) {
      return { pages, assets };
    }
    return null;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? { pages: n, assets: n * 2 } : null;
}

function isCacheComplete(
  libraryId: number,
  totalPages: number,
  expectedAssets?: number,
): boolean {
  if (!Number.isFinite(libraryId) || libraryId <= 0 || totalPages <= 0) {
    return false;
  }
  try {
    const raw = fs.readFileSync(completeMarkerPath(libraryId), "utf8");
    const m = parseMarker(raw);
    if (!m) return false;
    if (m.pages !== totalPages) return false;
    if (typeof expectedAssets === "number" && m.assets !== expectedAssets) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function downloadBytes(urlStr: string): Promise<Uint8Array> {
  const url = isAllowedUpstream(urlStr);
  if (!url) {
    throw new Error("Asset URL not on allowlist");
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

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Page labels (e.g. "0001") from `large/*.webp`, sorted by numeric order.
 */
function listSortedPageLabelsFromLargeDir(libraryId: number): string[] | null {
  const dir = subdir(libraryId, "large");
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const labels: string[] = [];
  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".webp")) continue;
    const label = name.slice(0, -".webp".length);
    if (!PAGE_LABEL_RE.test(label)) continue;
    labels.push(label);
  }
  if (labels.length === 0) return null;
  labels.sort((a, b) => Number(a) - Number(b));
  return labels;
}

/**
 * Reconstruct a `FlipBook` from disk when `.complete` matches and every
 * expected `large/` + `thumb/` file exists. Used when FlipHTML5 is down but
 * the reader still has a full local mirror.
 */
export function tryFlipBookFromDiskCache(
  libraryId: number,
  meta: {
    baseUrl: string;
    bookId: string;
    title: string | null;
    slug: string;
  },
): FlipBook | null {
  let markerRaw: string;
  try {
    markerRaw = fs.readFileSync(completeMarkerPath(libraryId), "utf8");
  } catch {
    return null;
  }
  const m = parseMarker(markerRaw);
  if (!m || m.pages <= 0 || m.pages > LIMITS.maxPages) return null;

  const labels = listSortedPageLabelsFromLargeDir(libraryId);
  if (!labels || labels.length !== m.pages) return null;

  const expectedOverlays = Math.max(0, m.assets - m.pages * 2);
  let overlayFileCount = 0;
  try {
    overlayFileCount = fs
      .readdirSync(subdir(libraryId, "overlay"))
      .filter((n) => n.toLowerCase().endsWith(".svg")).length;
  } catch {
    overlayFileCount = 0;
  }
  if (expectedOverlays > 0 && overlayFileCount !== expectedOverlays) {
    return null;
  }

  const base = meta.baseUrl.endsWith("/") ? meta.baseUrl : `${meta.baseUrl}/`;

  const pages: FlipPage[] = [];
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === undefined) return null;
    const largeDisk = path.join(subdir(libraryId, "large"), `${label}.webp`);
    const thumbDisk = path.join(subdir(libraryId, "thumb"), `${label}.webp`);
    if (!fileExists(largeDisk) || !fileExists(thumbDisk)) return null;

    const largeUrl = new URL(`files/large/${label}.webp`, base).toString();
    const thumbUrl = new URL(`files/thumb/${label}.webp`, base).toString();
    const page: FlipPage = {
      index: i,
      pageNumber: label,
      largeUrl,
      thumbUrl,
    };
    const overlayDisk = path.join(subdir(libraryId, "overlay"), `${label}.svg`);
    if (fileExists(overlayDisk)) {
      page.overlayUrl = new URL(`files/overlay/${label}.svg`, base).toString();
    }
    pages.push(page);
  }

  return {
    baseUrl: meta.baseUrl,
    bookId: meta.bookId,
    title: meta.title,
    slug: meta.slug,
    totalPageCount: m.pages,
    pages,
  };
}

function urlForKind(page: FlipPage, kind: CacheKind): string | null {
  if (kind === "large") return page.largeUrl;
  if (kind === "thumb") return page.thumbUrl;
  return page.overlayUrl ?? null;
}

function filePathFor(libraryId: number, page: FlipPage, kind: CacheKind): string {
  return path.join(subdir(libraryId, kind), `${page.pageNumber}.${EXT[kind]}`);
}

/**
 * Download every required asset (large + thumb for every page, plus overlay
 * SVG for pages that expose one) under `{BOOK_CACHE_DIR}/<libraryId>/<kind>/`.
 * Writes `.complete` only when every expected asset landed on disk.
 * Idempotent: existing files are kept so a retry only downloads what is missing.
 */
export async function ensureBookPagesOnDisk(
  libraryId: number,
  pages: FlipPage[],
): Promise<{ complete: boolean; saved: number; errors: string[] }> {
  if (!Number.isFinite(libraryId) || libraryId <= 0 || pages.length === 0) {
    return { complete: false, saved: 0, errors: ["invalid library or empty pages"] };
  }

  const expected =
    pages.length * 2 + pages.filter((p) => p.overlayUrl).length;

  if (isCacheComplete(libraryId, pages.length, expected)) {
    return { complete: true, saved: expected, errors: [] };
  }

  fs.mkdirSync(subdir(libraryId, "large"), { recursive: true });
  fs.mkdirSync(subdir(libraryId, "thumb"), { recursive: true });
  if (pages.some((p) => p.overlayUrl)) {
    fs.mkdirSync(subdir(libraryId, "overlay"), { recursive: true });
  }

  const work: WorkUnit[] = [];
  let alreadyOnDisk = 0;
  for (const page of pages) {
    if (!PAGE_LABEL_RE.test(page.pageNumber)) {
      return {
        complete: false,
        saved: 0,
        errors: [`invalid page label: ${page.pageNumber}`],
      };
    }
    const kinds: CacheKind[] = page.overlayUrl
      ? ["large", "thumb", "overlay"]
      : ["large", "thumb"];
    for (const kind of kinds) {
      if (fileExists(filePathFor(libraryId, page, kind))) {
        alreadyOnDisk++;
      } else {
        work.push({ kind, page });
      }
    }
  }

  const errors: string[] = [];
  let saved = alreadyOnDisk;
  let totalBytes = 0;
  let aborted = false;

  await runWithConcurrency(work, LIMITS.downloadConcurrency, async ({ kind, page }) => {
    if (aborted) return;
    const label = `${kind}:${page.pageNumber}`;
    const url = urlForKind(page, kind);
    if (!url) {
      errors.push(`${label}: missing source url`);
      return;
    }
    try {
      const buf = await downloadBytes(url);
      totalBytes += buf.byteLength;
      if (totalBytes > LIMITS.totalDownloadMaxBytes) {
        aborted = true;
        throw new Error("Total download size limit reached");
      }
      const filePath = filePathFor(libraryId, page, kind);
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

  const complete = saved === expected && errors.length === 0;
  if (complete) {
    await fs.promises.writeFile(
      completeMarkerPath(libraryId),
      `${pages.length}:${expected}`,
      "utf8",
    );
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
  if (!PAGE_LABEL_RE.test(pageLabel)) return null;
  const filePath = path.join(subdir(libraryId, kind), `${pageLabel}.${EXT[kind]}`);
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}
