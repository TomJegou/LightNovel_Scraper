import JSZip from "jszip";
import { NextRequest } from "next/server";
import { fetchBookPages } from "@/lib/fliphtml5";
import {
  boundedFetch,
  isAllowedUpstream,
  LIMITS,
  rateLimit,
  sanitizeError,
  tooManyRequests,
} from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

async function downloadAsset(assetUrl: string): Promise<Uint8Array> {
  const url = isAllowedUpstream(assetUrl);
  if (!url) {
    throw new Error("Asset URL not on allowlist");
  }
  const { response, body } = await boundedFetch(assetUrl, {
    headers: {
      "user-agent": USER_AGENT,
      referer: `${url.protocol}//${url.host}/`,
    },
    cache: "no-store",
    maxBytes: LIMITS.imageMaxBytes,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return body;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const current = i++;
      if (current >= items.length) return;
      await worker(items[current], current);
    }
  });
  await Promise.all(runners);
}

export async function POST(req: NextRequest) {
  const rl = rateLimit(req, "download", 4, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  let body: { url?: string };
  try {
    body = (await req.json()) as { url?: string };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const bookUrl = body?.url;
  if (!bookUrl || typeof bookUrl !== "string" || bookUrl.length > 1024) {
    return Response.json({ error: "Missing or invalid 'url' field" }, { status: 400 });
  }

  let book;
  try {
    book = await fetchBookPages(bookUrl);
  } catch (e) {
    return Response.json(
      { error: sanitizeError(e, "Failed to fetch book metadata") },
      { status: 400 },
    );
  }

  const zip = new JSZip();
  const failures: string[] = [];
  let totalBytes = 0;
  let aborted = false;

  await runWithConcurrency(book.pages, LIMITS.downloadConcurrency, async (page) => {
    if (aborted) return;
    try {
      const buf = await downloadAsset(page.largeUrl);
      totalBytes += buf.byteLength;
      if (totalBytes > LIMITS.totalDownloadMaxBytes) {
        aborted = true;
        throw new Error("Total download size limit reached");
      }
      zip.file(`${page.pageNumber}.webp`, buf);

      if (page.overlayUrl) {
        const svg = await downloadAsset(page.overlayUrl);
        totalBytes += svg.byteLength;
        if (totalBytes > LIMITS.totalDownloadMaxBytes) {
          aborted = true;
          throw new Error("Total download size limit reached");
        }
        zip.file(`${page.pageNumber}.svg`, svg);
      }
    } catch (e) {
      failures.push(`${page.pageNumber}: ${(e as Error).message}`);
    }
  });

  if (aborted) {
    return Response.json(
      { error: "Aggregate download exceeded the size limit" },
      { status: 413 },
    );
  }

  if (failures.length) {
    zip.file("_errors.txt", failures.join("\n"));
  }

  const internal = zip.generateInternalStream({
    type: "uint8array",
    streamFiles: true,
    compression: "STORE",
  });

  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      internal
        .on("data", (chunk: Uint8Array) => controller.enqueue(chunk))
        .on("error", (err: Error) => controller.error(err))
        .on("end", () => controller.close());
      internal.resume();
    },
    cancel() {
      internal.pause();
    },
  });

  const safeName = book.slug;
  return new Response(webStream, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${safeName}.zip"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
