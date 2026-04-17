import { NextRequest } from "next/server";

/**
 * Strict allowlist of hosts we are willing to reach from the server.
 * Anything outside this set is refused up-front to mitigate SSRF.
 *
 * Note: this does NOT protect against DNS rebinding or DNS entries that
 * resolve to private/internal IPs. For a production deployment you should
 * additionally constrain egress network access at the infrastructure level.
 */
export const ALLOWED_UPSTREAM_HOSTS = new Set<string>([
  "online.fliphtml5.com",
  "static.fliphtml5.com",
]);

export function isAllowedUpstream(target: string): URL | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!ALLOWED_UPSTREAM_HOSTS.has(url.hostname.toLowerCase())) return null;
  return url;
}

export const ALLOWED_IMAGE_TYPES = new Set<string>([
  "image/webp",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
]);

export function pickSafeImageType(upstreamContentType: string | null): string {
  const raw = (upstreamContentType ?? "").split(";")[0].trim().toLowerCase();
  return ALLOWED_IMAGE_TYPES.has(raw) ? raw : "image/webp";
}

/**
 * Limits applied to every outbound request we make (proxy + scraper).
 */
export const LIMITS = {
  configMaxBytes: 2 * 1024 * 1024,
  imageMaxBytes: 10 * 1024 * 1024,
  totalDownloadMaxBytes: 3 * 1024 * 1024 * 1024,
  maxPages: 2000,
  fetchTimeoutMs: 20_000,
  downloadConcurrency: 6,
};

export async function boundedFetch(
  url: string,
  init: RequestInit & { maxBytes?: number } = {},
): Promise<{ response: Response; body: Uint8Array }> {
  const { maxBytes = LIMITS.imageMaxBytes, signal: userSignal, ...rest } = init;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Timeout")),
    LIMITS.fetchTimeoutMs,
  );
  if (userSignal) {
    if (userSignal.aborted) controller.abort(userSignal.reason);
    else userSignal.addEventListener("abort", () => controller.abort(userSignal.reason));
  }

  try {
    const response = await fetch(url, { ...rest, signal: controller.signal });
    if (!response.ok || !response.body) {
      return { response, body: new Uint8Array() };
    }

    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared && declared > maxBytes) {
      controller.abort(new Error("Payload too large"));
      throw new Error(`Upstream payload too large: ${declared} bytes`);
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel(new Error("Payload too large"));
        throw new Error(`Upstream payload exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }

    const body = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      body.set(c, offset);
      offset += c.byteLength;
    }
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/**
 * Very small in-memory fixed-window rate limiter, keyed by caller IP + route.
 * Good enough for a self-hosted single-instance deployment. For multi-instance
 * deployments, swap this for a shared store (Redis / Upstash / etc).
 */
export function rateLimit(
  req: NextRequest,
  route: string,
  limit: number,
  windowMs: number,
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const key = `${ip}::${route}`;
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }
  if (bucket.count >= limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }
  bucket.count += 1;
  return { ok: true };
}

export function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response("Too many requests", {
    status: 429,
    headers: { "retry-after": String(retryAfterSeconds) },
  });
}

const isProd = process.env.NODE_ENV === "production";

/**
 * Keeps the user-facing error message generic in production while preserving
 * the server-side log so we can still debug from the terminal.
 */
export function sanitizeError(
  e: unknown,
  fallback = "Unexpected server error",
): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (!isProd) return raw;
  console.error("[handler error]", raw);
  return fallback;
}

/**
 * Occasionally evict stale buckets so the map cannot grow unboundedly.
 * Called opportunistically by rateLimit consumers that are already hot.
 */
export function evictExpiredBuckets() {
  const now = Date.now();
  if (buckets.size < 512) return;
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}
