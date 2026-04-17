"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

type LibraryEntry = {
  id: number;
  baseUrl: string;
  bookId: string;
  title: string | null;
  slug: string;
  totalPages: number;
  lastPage: number;
  firstSeenAt: number;
  lastReadAt: number;
};

type ResolveResponse = {
  id: number;
  slug: string;
  lastPage: number;
};

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.round(months / 12);
  return `${years}y ago`;
}

function errorMessageFromCode(code: string | null): string | null {
  switch (code) {
    case "not-found":
      return "That book is no longer in your library.";
    case "invalid-id":
      return "Invalid book reference.";
    default:
      return null;
  }
}

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [url, setUrl] = useState<string>("");
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [libraryLoaded, setLibraryLoaded] = useState(false);

  useEffect(() => {
    const code = searchParams?.get("error") ?? null;
    const msg = errorMessageFromCode(code);
    if (msg) setError(msg);
  }, [searchParams]);

  const refreshLibrary = useCallback(async () => {
    try {
      const res = await fetch("/api/library", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { entries: LibraryEntry[] };
      setLibrary(data.entries);
    } catch {
      // Non-fatal: library is a "nice to have" overlay on the home page.
    } finally {
      setLibraryLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  const handleScan = useCallback(async () => {
    const effective = url.trim();
    if (!effective) return;
    setResolving(true);
    setError(null);
    try {
      const res = await fetch("/api/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: effective }),
      });
      const payload = (await res.json()) as ResolveResponse | { error: string };
      if (!res.ok) {
        throw new Error(
          "error" in payload ? payload.error : `HTTP ${res.status}`,
        );
      }
      const data = payload as ResolveResponse;
      const page = data.lastPage > 0 ? data.lastPage : 1;
      router.push(`/read/${data.id}/${encodeURIComponent(data.slug)}?p=${page}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResolving(false);
    }
    // Note: on success we leave `resolving` true until unmount so the button
    // stays disabled while the route transition happens.
  }, [url, router]);

  const handleDeleteFromLibrary = useCallback(
    async (id: number) => {
      setLibrary((prev) => prev.filter((e) => e.id !== id));
      try {
        const res = await fetch(`/api/library/${id}`, { method: "DELETE" });
        if (!res.ok && res.status !== 404) {
          void refreshLibrary();
        }
      } catch {
        void refreshLibrary();
      }
    },
    [refreshLibrary],
  );

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
          <label
            htmlFor="book-url"
            className="block text-sm font-medium text-zinc-300"
          >
            Book URL
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              id="book-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://online.fliphtml5.com/<owner>/<book>/"
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !resolving && url.trim()) {
                  e.preventDefault();
                  void handleScan();
                }
              }}
            />
            <button
              onClick={() => void handleScan()}
              disabled={resolving || !url.trim()}
              className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {resolving ? "Resolving…" : "Scan"}
            </button>
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}
        </section>

        {library.length > 0 && (
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-lg font-semibold text-zinc-100">Library</h2>
              <span className="text-xs text-zinc-500">
                {library.length} book{library.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {library.map((entry) => {
                const displayTitle = entry.title ?? entry.bookId;
                const total = Math.max(1, entry.totalPages);
                const progressPct = Math.min(
                  100,
                  Math.round((entry.lastPage / total) * 100),
                );
                const page = entry.lastPage > 0 ? entry.lastPage : 1;
                return (
                  <div
                    key={entry.id}
                    className="group relative rounded-lg border border-zinc-800 bg-zinc-950 p-4 transition hover:border-sky-500/60"
                  >
                    <Link
                      href={`/read/${entry.id}/${encodeURIComponent(entry.slug)}?p=${page}`}
                      className="block w-full text-left focus:outline-none"
                      aria-label={`Resume ${displayTitle} at page ${entry.lastPage}`}
                    >
                      <h3 className="line-clamp-2 text-sm font-semibold text-zinc-100 group-hover:text-sky-300">
                        {displayTitle}
                      </h3>
                      {entry.title && (
                        <p className="mt-0.5 font-mono text-[10px] text-zinc-500">
                          {entry.bookId}
                        </p>
                      )}
                      <p className="mt-2 text-xs text-zinc-400">
                        Resume p.{" "}
                        <span className="text-zinc-200">{entry.lastPage}</span>{" "}
                        / {entry.totalPages || "?"}
                      </p>
                      <div className="mt-2 h-1 w-full overflow-hidden rounded bg-zinc-800">
                        <div
                          className="h-full bg-sky-500"
                          style={{ width: `${progressPct}%` }}
                        />
                      </div>
                      <p className="mt-2 text-[11px] text-zinc-500">
                        Last opened {formatRelative(entry.lastReadAt)}
                      </p>
                    </Link>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        void handleDeleteFromLibrary(entry.id);
                      }}
                      className="absolute right-2 top-2 rounded-md p-1 text-zinc-500 opacity-0 transition hover:bg-white/10 hover:text-red-300 focus:opacity-100 group-hover:opacity-100"
                      aria-label={`Remove ${displayTitle} from library`}
                      title="Remove from library"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {libraryLoaded && library.length === 0 && (
          <section className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 p-8 text-center text-sm text-zinc-500">
            Paste a FlipHTML5 book URL above and click{" "}
            <span className="text-zinc-300">Scan</span> to load your first book.
          </section>
        )}
      </main>
    </div>
  );
}
