import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Simple image proxy so the <img> tags in the browser don't get blocked by CORS /
 * hotlink protection on fliphtml5 assets, and so we keep all traffic origin-controlled.
 */
export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get("u");
  if (!target) {
    return new Response("Missing 'u' parameter", { status: 400 });
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return new Response("Invalid URL", { status: 400 });
  }
  if (!/fliphtml5\.com$/i.test(url.hostname)) {
    return new Response("Host not allowed", { status: 400 });
  }

  const upstream = await fetch(url.toString(), {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      referer: `${url.protocol}//${url.host}/`,
    },
    cache: "no-store",
  });
  if (!upstream.ok || !upstream.body) {
    return new Response(`Upstream error ${upstream.status}`, {
      status: upstream.status || 502,
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "image/webp",
      "cache-control": "public, max-age=3600",
    },
  });
}
