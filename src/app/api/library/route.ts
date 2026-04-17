import { NextRequest } from "next/server";
import { listBooks } from "@/lib/library";
import { rateLimit, sanitizeError, tooManyRequests } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rl = rateLimit(req, "library-list", 120, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  try {
    const entries = listBooks(50);
    return Response.json({ entries });
  } catch (e) {
    return Response.json(
      { error: sanitizeError(e, "Failed to read library") },
      { status: 500 },
    );
  }
}
