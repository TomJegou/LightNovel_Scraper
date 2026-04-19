import {
  ALLOWED_UPSTREAM_HOSTS,
  boundedFetch,
  isAllowedUpstream,
  LIMITS,
} from "@/lib/security";
import { deString } from "./decoder";

export type FlipPage = {
  index: number;
  pageNumber: string;
  largeUrl: string;
  thumbUrl: string;
  /**
   * Optional SVG overlay rendered on top of `largeUrl` by the FlipHTML5
   * player (typically the text layer for text-heavy books whose webp
   * contains only the illustration). We cache it alongside the webp and
   * let the browser stack them in the reader so the embedded `@font-face`
   * rules in the SVG are honored.
   */
  overlayUrl?: string;
};

export type FlipBook = {
  baseUrl: string;
  bookId: string;
  title: string | null;
  slug: string;
  totalPageCount: number;
  pages: FlipPage[];
};

/**
 * Convert a human title into a filesystem-safe kebab-case slug.
 * Falls back to the provided fallback (bookId) if the title yields nothing.
 */
export function slugify(title: string | null | undefined, fallback: string): string {
  const source = (title ?? "").normalize("NFKD");
  const cleaned = source
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (cleaned.length > 0) return cleaned;
  return fallback.replace(/[^a-z0-9_-]/gi, "_");
}

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

export async function fetchBookTitle(baseUrl: string): Promise<string | null> {
  try {
    const { response, body } = await boundedFetch(baseUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      },
      cache: "no-store",
      maxBytes: LIMITS.configMaxBytes,
    });
    if (!response.ok) return null;
    const html = new TextDecoder("utf-8").decode(body);
    const m = html.match(TITLE_RE);
    if (!m) return null;
    const raw = decodeHtmlEntities(m[1]).replace(/\s+/g, " ").trim();
    return raw.length > 0 ? raw.slice(0, 200) : null;
  } catch {
    return null;
  }
}

type RawPage = {
  n?: string[];
  t?: string;
};

type HtmlConfig = {
  bookConfig?: string;
  fliphtml5_pages?: string | RawPage[];
  [key: string]: unknown;
};

type BookConfig = {
  totalPageCount?: number | string;
  largePath?: string | string[];
  normalPath?: string | string[];
  thumbPath?: string | string[];
  [key: string]: unknown;
};

/**
 * Pick the directory that matches the layout of `n`:
 * - `n` with one entry  → the first (and only) dir applies.
 * - `n` with several entries ([webp, svg, …]) → the i-th dir.
 * Falls back to the generic "large" dir if `normalPath` is missing/misshapen.
 */
function pickPathFor(
  index: number,
  normalPath: string | string[] | undefined,
  largePath: string | string[] | undefined,
): string | null {
  if (Array.isArray(normalPath)) {
    const candidate = normalPath[index] ?? normalPath[0];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  } else if (typeof normalPath === "string" && normalPath.length > 0) {
    return normalPath;
  }
  if (Array.isArray(largePath)) {
    const candidate = largePath[0];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  } else if (typeof largePath === "string" && largePath.length > 0) {
    return largePath;
  }
  return null;
}

function pickThumbPath(thumbPath: string | string[] | undefined): string | null {
  if (typeof thumbPath === "string" && thumbPath.length > 0) return thumbPath;
  if (Array.isArray(thumbPath)) {
    const candidate = thumbPath[0];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

/**
 * Normalize a FlipHTML5 book URL into the canonical base.
 * Accepts any of:
 *   https://online.fliphtml5.com/eogmc/laiw/
 *   https://online.fliphtml5.com/eogmc/laiw/?1776439280#p=1
 *   https://online.fliphtml5.com/eogmc/laiw/index.html
 */
export function normalizeBookUrl(input: string): { baseUrl: string; bookId: string } {
  const trimmed = input.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }

  if (u.protocol !== "https:" || !ALLOWED_UPSTREAM_HOSTS.has(u.hostname.toLowerCase())) {
    throw new Error(`Unsupported host: ${u.hostname}`);
  }

  const segments = u.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error(
      "URL does not look like a FlipHTML5 book (expected /<owner>/<book>/...).",
    );
  }
  const [owner, book] = segments;
  if (!/^[a-z0-9_-]{1,64}$/i.test(owner) || !/^[a-z0-9_-]{1,64}$/i.test(book)) {
    throw new Error("URL contains unexpected characters in owner/book segments.");
  }
  const baseUrl = `${u.protocol}//${u.host}/${owner}/${book}/`;
  return { baseUrl, bookId: `${owner}/${book}` };
}

/**
 * Resolves a FlipHTML5 asset path against a base URL.
 * - If `rel` already looks like a path (contains "/"), we resolve it directly
 *   against `baseUrl` (stripping an optional "./" prefix).
 * - Otherwise `rel` is a bare filename and we prepend `fallbackDir`
 *   (e.g. "files/large/") from bookConfig.
 */
function resolveAsset(
  rel: string,
  baseUrl: string,
  fallbackDir: string | null,
): string {
  const clean = rel.replace(/^\.\//, "");
  const hasPath = clean.includes("/");
  const relative = hasPath
    ? clean
    : `${(fallbackDir ?? "").replace(/^\.\//, "").replace(/\/?$/, "/")}${clean}`;
  const resolved = new URL(relative, baseUrl).toString();
  if (!isAllowedUpstream(resolved)) {
    throw new Error("Decrypted payload referenced a disallowed host");
  }
  return resolved;
}

function extractHtmlConfig(src: string): HtmlConfig {
  const start = src.indexOf("{");
  const end = src.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("config.js does not expose an htmlConfig object");
  }
  try {
    return JSON.parse(src.slice(start, end + 1)) as HtmlConfig;
  } catch (e) {
    throw new Error(`Failed to parse htmlConfig JSON: ${(e as Error).message}`);
  }
}

function parseTrailingJson<T>(text: string, closer: "}" | "]"): T | null {
  const end = text.lastIndexOf(closer);
  if (end === -1) return null;
  try {
    return JSON.parse(text.slice(0, end + 1)) as T;
  } catch {
    return null;
  }
}

/**
 * Fetches and decrypts the book metadata, returning the ordered list of pages.
 */
export async function fetchBookPages(inputUrl: string): Promise<FlipBook> {
  const { baseUrl, bookId } = normalizeBookUrl(inputUrl);

  const configUrl = new URL("javascript/config.js", baseUrl).toString();
  if (!isAllowedUpstream(configUrl)) {
    throw new Error("Resolved config URL is not on the allowlist");
  }

  const [configResult, title] = await Promise.all([
    boundedFetch(configUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      },
      cache: "no-store",
      maxBytes: LIMITS.configMaxBytes,
    }),
    fetchBookTitle(baseUrl),
  ]);

  const { response: res, body } = configResult;
  if (!res.ok) {
    throw new Error(`Failed to fetch config.js: HTTP ${res.status}`);
  }
  const configSrc = new TextDecoder("utf-8").decode(body);
  const htmlConfig = extractHtmlConfig(configSrc);

  let bookConfig: BookConfig = {};
  if (typeof htmlConfig.bookConfig === "string" && htmlConfig.bookConfig.length > 0) {
    const decoded = await deString(htmlConfig.bookConfig);
    bookConfig = parseTrailingJson<BookConfig>(decoded, "}") ?? {};
  }

  let rawPages: RawPage[] | null = null;
  const fp = htmlConfig.fliphtml5_pages;
  if (typeof fp === "string" && fp.length > 0) {
    const decodedPages = await deString(fp);
    rawPages = parseTrailingJson<RawPage[]>(decodedPages, "]");
    if (!rawPages) {
      throw new Error("Decrypted pages payload is malformed");
    }
  } else if (Array.isArray(fp)) {
    rawPages = fp;
  } else {
    throw new Error("fliphtml5_pages not found in config.js");
  }

  if (rawPages.length === 0) {
    throw new Error("No pages found for this book");
  }
  if (rawPages.length > LIMITS.maxPages) {
    throw new Error(
      `Book has ${rawPages.length} pages, which exceeds the ${LIMITS.maxPages} page limit`,
    );
  }

  const totalPageCount =
    Number(bookConfig.totalPageCount ?? 0) || rawPages.length;
  const thumbDir = pickThumbPath(bookConfig.thumbPath);

  const pad = Math.max(4, String(rawPages.length).length);
  const pages: FlipPage[] = rawPages.map((p, i) => {
    // `n` can be a single-element array (legacy format) or a multi-element
    // array where each entry corresponds to a different asset kind:
    //   n[0] = webp (background illustration) — always renderable
    //   n[1] = svg (text layer) — optional overlay composed client-side by
    //          the official player. When present, we flatten it onto the
    //          webp so our cache stays one file per page.
    const nArr = Array.isArray(p.n) ? p.n : [];
    const firstImage = typeof nArr[0] === "string" ? nArr[0] : null;
    const overlay =
      typeof nArr[1] === "string" && /\.svg(?:[?#]|$)/i.test(nArr[1])
        ? nArr[1]
        : null;
    const t = typeof p.t === "string" ? p.t : null;
    if (!firstImage) {
      throw new Error(`Missing large image for page index ${i}`);
    }
    const largeDir = pickPathFor(0, bookConfig.normalPath, bookConfig.largePath);
    const overlayDir = overlay
      ? pickPathFor(1, bookConfig.normalPath, bookConfig.largePath)
      : null;
    const page: FlipPage = {
      index: i,
      pageNumber: String(i + 1).padStart(pad, "0"),
      largeUrl: resolveAsset(firstImage, baseUrl, largeDir),
      thumbUrl: t
        ? resolveAsset(t, baseUrl, thumbDir)
        : resolveAsset(firstImage, baseUrl, largeDir),
    };
    if (overlay) {
      page.overlayUrl = resolveAsset(overlay, baseUrl, overlayDir);
    }
    return page;
  });

  const slug = slugify(title, bookId);

  return { baseUrl, bookId, title, slug, totalPageCount, pages };
}
