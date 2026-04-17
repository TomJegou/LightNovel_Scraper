import { NextRequest } from "next/server";
import { fetchBookPages } from "@/lib/fliphtml5";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = (await req.json()) as { url?: string };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const url = body?.url;
  if (!url || typeof url !== "string") {
    return Response.json({ error: "Missing 'url' field" }, { status: 400 });
  }

  try {
    const book = await fetchBookPages(url);
    return Response.json(book);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: 500 });
  }
}
