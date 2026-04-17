import { NextRequest } from "next/server";
import { fetchBookTitle, normalizeBookUrl, slugify } from "@/lib/fliphtml5";
import { upsertMinimal } from "@/lib/library";
import { rateLimit, sanitizeError, tooManyRequests } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lightweight book resolver used by the home page to get { id, slug }
 * before redirecting to /read/[id]/[slug]. Unlike /api/pages, this does
 * NOT fetch or decrypt config.js — it only fetches the book's HTML page
 * to extract the title, so we can stay cheap and responsive.
 */
export async function POST(req: NextRequest) {
  const rl = rateLimit(req, "resolve", 30, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  let body: { url?: string };
  try {
    body = (await req.json()) as { url?: string };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const url = body?.url;
  if (!url || typeof url !== "string" || url.length > 1024) {
    return Response.json({ error: "Missing or invalid 'url' field" }, { status: 400 });
  }

  try {
    const { baseUrl, bookId } = normalizeBookUrl(url);
    const title = await fetchBookTitle(baseUrl);
    const slug = slugify(title, bookId);

    const entry = upsertMinimal({ baseUrl, bookId, title, slug });

    return Response.json({
      id: entry.id,
      baseUrl: entry.baseUrl,
      bookId: entry.bookId,
      title: entry.title,
      slug: entry.slug,
      totalPages: entry.totalPages,
      lastPage: entry.lastPage,
    });
  } catch (e) {
    return Response.json(
      { error: sanitizeError(e, "Failed to resolve book") },
      { status: 400 },
    );
  }
}
