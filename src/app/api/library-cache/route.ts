import { NextRequest } from "next/server";
import { readCachedPage, type CacheKind } from "@/lib/book-cache";
import { getBook } from "@/lib/library";
import {
  pickSafeImageType,
  rateLimit,
  sanitizeError,
  tooManyRequests,
} from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_LABEL_RE = /^[0-9]{1,6}$/;

function parseKind(raw: string | null): CacheKind | null {
  if (raw === "large" || raw === "thumb") return raw;
  if (raw === null || raw === "") return "large";
  return null;
}

export async function GET(req: NextRequest) {
  const rl = rateLimit(req, "library-cache", 600, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const idRaw = req.nextUrl.searchParams.get("id");
  const page = req.nextUrl.searchParams.get("page");
  const kind = parseKind(req.nextUrl.searchParams.get("kind"));

  if (!idRaw || !/^\d+$/.test(idRaw)) {
    return new Response("Invalid id", { status: 400 });
  }
  const libraryId = Number(idRaw);
  if (!Number.isInteger(libraryId) || libraryId <= 0) {
    return new Response("Invalid id", { status: 400 });
  }
  if (!page || !PAGE_LABEL_RE.test(page)) {
    return new Response("Invalid page", { status: 400 });
  }
  if (kind === null) {
    return new Response("Invalid kind (use large or thumb)", { status: 400 });
  }

  try {
    const entry = getBook(libraryId);
    if (!entry) {
      return new Response("Not found", { status: 404 });
    }
    const n = Number(page);
    if (!Number.isFinite(n) || n < 1) {
      return new Response("Invalid page", { status: 400 });
    }
    if (entry.totalPages > 0 && n > entry.totalPages) {
      return new Response("Page out of range", { status: 400 });
    }

    const buf = readCachedPage(libraryId, page, kind);
    if (!buf) {
      return new Response("Not cached", { status: 404 });
    }

    const payload = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;

    return new Response(payload, {
      status: 200,
      headers: {
        "content-type": pickSafeImageType("image/webp"),
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
        "cache-control": "public, max-age=86400, immutable",
      },
    });
  } catch (e) {
    return new Response(sanitizeError(e, "Failed to read cache"), {
      status: 500,
    });
  }
}
