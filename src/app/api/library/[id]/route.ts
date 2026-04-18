import { NextRequest } from "next/server";
import { deleteBook, getBook } from "@/lib/library";
import { rateLimit, sanitizeError, tooManyRequests } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) return null;
  return n;
}

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const rl = rateLimit(req, "library-get", 120, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) {
    return Response.json({ error: "Invalid id" }, { status: 400 });
  }

  try {
    const entry = getBook(id);
    if (!entry) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json(entry);
  } catch (e) {
    return Response.json(
      { error: sanitizeError(e, "Failed to read entry") },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const rl = rateLimit(req, "library-delete", 60, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) {
    return Response.json({ error: "Invalid id" }, { status: 400 });
  }

  try {
    const ok = deleteBook(id);
    if (!ok) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  } catch (e) {
    return Response.json(
      { error: sanitizeError(e, "Failed to delete entry") },
      { status: 500 },
    );
  }
}
