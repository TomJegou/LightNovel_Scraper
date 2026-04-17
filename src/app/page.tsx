"use client";

import { useCallback, useMemo, useState } from "react";

type FlipPage = {
  index: number;
  pageNumber: string;
  largeUrl: string;
  thumbUrl: string;
};

type FlipBook = {
  baseUrl: string;
  bookId: string;
  totalPageCount: number;
  pages: FlipPage[];
};

function proxied(url: string) {
  return `/api/image?u=${encodeURIComponent(url)}`;
}

export default function Home() {
  const [url, setUrl] = useState(
    "https://online.fliphtml5.com/eogmc/laiw/?1776439280#p=1",
  );
  const [book, setBook] = useState<FlipBook | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "downloading">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [useThumbs, setUseThumbs] = useState(true);

  const handleScan = useCallback(async () => {
    setStatus("loading");
    setError(null);
    setBook(null);
    try {
      const res = await fetch("/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const payload = (await res.json()) as FlipBook | { error: string };
      if (!res.ok) {
        throw new Error(
          "error" in payload ? payload.error : `HTTP ${res.status}`,
        );
      }
      setBook(payload as FlipBook);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatus("idle");
    }
  }, [url]);

  const handleDownload = useCallback(async () => {
    if (!book) return;
    setStatus("downloading");
    setError(null);
    try {
      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `${book.bookId.replace(/[^a-z0-9_-]/gi, "_")}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatus("idle");
    }
  }, [book, url]);

  const headline = useMemo(() => {
    if (!book) return null;
    return (
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-xl font-semibold text-zinc-100">{book.bookId}</h2>
        <span className="text-sm text-zinc-400">
          {book.totalPageCount} pages
        </span>
      </div>
    );
  }, [book]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans">
      <header className="border-b border-zinc-800/80 bg-zinc-900/60 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center gap-4">
          <div className="flex-1">
            <h1 className="text-lg font-semibold tracking-tight">
              FlipHTML5 Scraper
            </h1>
            <p className="text-xs text-zinc-400">
              Rip a book from{" "}
              <code className="text-zinc-300">online.fliphtml5.com</code> as
              numbered <code className="text-zinc-300">.webp</code> images.
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8 space-y-6">
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
          <label className="block text-sm font-medium text-zinc-300">
            Book URL
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://online.fliphtml5.com/<owner>/<book>/"
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
              spellCheck={false}
            />
            <button
              onClick={handleScan}
              disabled={status !== "idle" || !url.trim()}
              className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {status === "loading" ? "Scanning…" : "Scan"}
            </button>
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}
        </section>

        {book && (
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              {headline}
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-zinc-400">
                  <input
                    type="checkbox"
                    checked={useThumbs}
                    onChange={(e) => setUseThumbs(e.target.checked)}
                    className="h-3.5 w-3.5 accent-sky-500"
                  />
                  Preview thumbnails only
                </label>
                <button
                  onClick={handleDownload}
                  disabled={status !== "idle"}
                  className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {status === "downloading"
                    ? "Packaging ZIP…"
                    : "Download all as ZIP"}
                </button>
              </div>
            </div>

            <p className="text-xs text-zinc-500">
              Files will be named{" "}
              <code className="text-zinc-400">0001.webp</code>,{" "}
              <code className="text-zinc-400">0002.webp</code>, … matching the
              reading order.
            </p>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {book.pages.map((p) => (
                <a
                  key={p.index}
                  href={proxied(p.largeUrl)}
                  target="_blank"
                  rel="noreferrer"
                  className="group relative overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 aspect-[2/3] block"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={proxied(useThumbs ? p.thumbUrl : p.largeUrl)}
                    alt={`Page ${p.pageNumber}`}
                    loading="lazy"
                    className="absolute inset-0 h-full w-full object-cover transition group-hover:opacity-80"
                  />
                  <span className="absolute left-1 bottom-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-mono text-zinc-200">
                    {p.pageNumber}
                  </span>
                </a>
              ))}
            </div>
          </section>
        )}

        {!book && status === "idle" && (
          <section className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 p-8 text-center text-sm text-zinc-500">
            Paste a FlipHTML5 book URL above and click{" "}
            <span className="text-zinc-300">Scan</span> to load the pages.
          </section>
        )}
      </main>
    </div>
  );
}
