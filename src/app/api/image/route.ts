import { NextRequest } from "next/server";
import {
  boundedFetch,
  evictExpiredBuckets,
  isAllowedUpstream,
  LIMITS,
  pickSafeImageType,
  rateLimit,
  sanitizeError,
  tooManyRequests,
} from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

export async function GET(req: NextRequest) {
  const rl = rateLimit(req, "image", 600, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);
  evictExpiredBuckets();

  const target = req.nextUrl.searchParams.get("u");
  if (!target) {
    return new Response("Missing 'u' parameter", { status: 400 });
  }

  const url = isAllowedUpstream(target);
  if (!url) {
    return new Response("Host not allowed", { status: 400 });
  }

  try {
    const { response, body } = await boundedFetch(url.toString(), {
      headers: {
        "user-agent": USER_AGENT,
        referer: `${url.protocol}//${url.host}/`,
      },
      cache: "no-store",
      maxBytes: LIMITS.imageMaxBytes,
    });

    if (!response.ok) {
      return new Response(`Upstream error ${response.status}`, {
        status: response.status || 502,
      });
    }

    const contentType = pickSafeImageType(response.headers.get("content-type"));

    const payload = body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer;

    return new Response(payload, {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
        "cache-control": "public, max-age=3600",
      },
    });
  } catch (e) {
    return new Response(sanitizeError(e, "Upstream fetch failed"), {
      status: 502,
    });
  }
}
