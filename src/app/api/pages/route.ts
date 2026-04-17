import { NextRequest } from "next/server";
import { fetchBookPages } from "@/lib/fliphtml5";
import { rateLimit, sanitizeError, tooManyRequests } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rl = rateLimit(req, "pages", 20, 60_000);
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
    const book = await fetchBookPages(url);
    return Response.json(book);
  } catch (e) {
    return Response.json(
      { error: sanitizeError(e, "Failed to fetch book metadata") },
      { status: 400 },
    );
  }
}
