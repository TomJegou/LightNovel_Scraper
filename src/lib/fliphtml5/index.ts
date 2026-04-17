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
};

export type FlipBook = {
  baseUrl: string;
  bookId: string;
  totalPageCount: number;
  pages: FlipPage[];
};

type RawPage = {
  n?: string[];
  t?: string;
};

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
 * Resolves a relative FlipHTML5 asset path against the book base URL.
 * Example: "./files/large/abc.webp" + "https://host/o/b/" -> "https://host/o/b/files/large/abc.webp"
 */
function resolveAsset(rel: string, baseUrl: string): string {
  const clean = rel.replace(/^\.\//, "");
  const resolved = new URL(clean, baseUrl).toString();
  if (!isAllowedUpstream(resolved)) {
    throw new Error("Decrypted payload referenced a disallowed host");
  }
  return resolved;
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

  const { response: res, body } = await boundedFetch(configUrl, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    },
    cache: "no-store",
    maxBytes: LIMITS.configMaxBytes,
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch config.js: HTTP ${res.status}`);
  }
  const configSrc = new TextDecoder("utf-8").decode(body);

  const bookConfigMatch = configSrc.match(/"bookConfig":"([^"]+)"/);
  const pagesMatch = configSrc.match(/"fliphtml5_pages":"([^"]+)"/);
  if (!pagesMatch) {
    throw new Error("fliphtml5_pages not found in config.js");
  }

  let totalPageCount = 0;
  if (bookConfigMatch) {
    const decoded = await deString(bookConfigMatch[1]);
    const end = decoded.lastIndexOf("}");
    if (end !== -1) {
      try {
        const obj = JSON.parse(decoded.slice(0, end + 1)) as {
          totalPageCount?: number | string;
        };
        totalPageCount = Number(obj.totalPageCount ?? 0) || 0;
      } catch {
        /* ignore, we'll derive from pages array */
      }
    }
  }

  const decodedPages = await deString(pagesMatch[1]);
  const arrEnd = decodedPages.lastIndexOf("]");
  if (arrEnd === -1) {
    throw new Error("Decrypted pages payload is malformed");
  }
  let rawPages: RawPage[];
  try {
    rawPages = JSON.parse(decodedPages.slice(0, arrEnd + 1)) as RawPage[];
  } catch (e) {
    throw new Error(`Failed to parse page array: ${(e as Error).message}`);
  }

  if (rawPages.length === 0) {
    throw new Error("No pages found for this book");
  }
  if (rawPages.length > LIMITS.maxPages) {
    throw new Error(
      `Book has ${rawPages.length} pages, which exceeds the ${LIMITS.maxPages} page limit`,
    );
  }

  if (!totalPageCount) totalPageCount = rawPages.length;

  const pad = Math.max(4, String(rawPages.length).length);
  const pages: FlipPage[] = rawPages.map((p, i) => {
    const n = Array.isArray(p.n) && p.n.length > 0 ? p.n[0] : null;
    const t = typeof p.t === "string" ? p.t : null;
    if (!n) {
      throw new Error(`Missing large image for page index ${i}`);
    }
    return {
      index: i,
      pageNumber: String(i + 1).padStart(pad, "0"),
      largeUrl: resolveAsset(n, baseUrl),
      thumbUrl: t ? resolveAsset(t, baseUrl) : resolveAsset(n, baseUrl),
    };
  });

  return { baseUrl, bookId, totalPageCount, pages };
}
