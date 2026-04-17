import { Readable } from "node:stream";
import JSZip from "jszip";
import { NextRequest } from "next/server";
import { fetchBookPages, FlipPage } from "@/lib/fliphtml5";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

async function downloadImage(page: FlipPage): Promise<ArrayBuffer> {
  const url = new URL(page.largeUrl);
  const res = await fetch(page.largeUrl, {
    headers: {
      "user-agent": USER_AGENT,
      referer: `${url.protocol}//${url.host}/`,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Page ${page.pageNumber}: HTTP ${res.status}`);
  }
  return res.arrayBuffer();
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
  let body: { url?: string };
  try {
    body = (await req.json()) as { url?: string };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const bookUrl = body?.url;
  if (!bookUrl || typeof bookUrl !== "string") {
    return Response.json({ error: "Missing 'url' field" }, { status: 400 });
  }

  let book;
  try {
    book = await fetchBookPages(bookUrl);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: 500 });
  }

  const zip = new JSZip();
  const failures: string[] = [];

  await runWithConcurrency(book.pages, 8, async (page) => {
    try {
      const buf = await downloadImage(page);
      zip.file(`${page.pageNumber}.webp`, buf);
    } catch (e) {
      failures.push(`${page.pageNumber}: ${(e as Error).message}`);
    }
  });

  if (failures.length) {
    zip.file("_errors.txt", failures.join("\n"));
  }

  const nodeStream = zip.generateNodeStream({
    type: "nodebuffer",
    streamFiles: true,
    compression: "STORE",
  });
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  const safeName = book.bookId.replace(/[^a-z0-9_-]/gi, "_");
  return new Response(webStream, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${safeName}.zip"`,
      "cache-control": "no-store",
    },
  });
}
