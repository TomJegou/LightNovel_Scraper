import { NextRequest } from "next/server";
import { deleteBook, updateLastPage } from "@/lib/library";
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

export async function PATCH(req: NextRequest, { params }: Params) {
  const rl = rateLimit(req, "library-patch", 300, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) {
    return Response.json({ error: "Invalid id" }, { status: 400 });
  }

  let body: { lastPage?: unknown };
  try {
    body = (await req.json()) as { lastPage?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const lastPage = body?.lastPage;
  if (
    typeof lastPage !== "number" ||
    !Number.isFinite(lastPage) ||
    lastPage < 1 ||
    lastPage > 100_000
  ) {
    return Response.json(
      { error: "Missing or invalid 'lastPage' field" },
      { status: 400 },
    );
  }

  try {
    const updated = updateLastPage(id, lastPage);
    if (!updated) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json(updated);
  } catch (e) {
    return Response.json(
      { error: sanitizeError(e, "Failed to update entry") },
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
