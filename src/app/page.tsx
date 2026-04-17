"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type FlipPage = {
  index: number;
  pageNumber: string;
  largeUrl: string;
  thumbUrl: string;
};

type FlipBook = {
  baseUrl: string;
  bookId: string;
  title: string | null;
  slug: string;
  totalPageCount: number;
  pages: FlipPage[];
  libraryId: number | null;
  lastPage: number;
};

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

const APP_NAME = "FlipHTML5 Scraper";
const DEFAULT_URL = "https://online.fliphtml5.com/eogmc/laiw/";
const PROGRESS_DEBOUNCE_MS = 1500;

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

function proxied(url: string) {
  return `/api/image?u=${encodeURIComponent(url)}`;
}

function readInitialUrl(): string {
  if (typeof window === "undefined") return DEFAULT_URL;
  const fromQuery = new URL(window.location.href).searchParams.get("url");
  return fromQuery ?? DEFAULT_URL;
}

function readHashPage(): number | null {
  if (typeof window === "undefined") return null;
  const m = window.location.hash.match(/(?:^|[#&?])p=(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export default function Home() {
  const [url, setUrl] = useState<string>(DEFAULT_URL);
  const [book, setBook] = useState<FlipBook | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "downloading">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [useThumbs, setUseThumbs] = useState(true);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const [library, setLibrary] = useState<LibraryEntry[]>([]);

  const hasAutoScannedRef = useRef(false);
  const pendingHashPageRef = useRef<number | null>(null);
  const syncingFromUrlRef = useRef(false);
  const prevHashRef = useRef<string>("");
  const syncEnabledRef = useRef(false);
  const lastSentPageRef = useRef<number | null>(null);

  const refreshLibrary = useCallback(async () => {
    try {
      const res = await fetch("/api/library", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { entries: LibraryEntry[] };
      setLibrary(data.entries);
    } catch {
      // Non-fatal: library is a "nice to have" overlay on the home page.
    }
  }, []);

  const handleScan = useCallback(
    async (targetUrl?: string, resumePage?: number) => {
      const effective = (targetUrl ?? url).trim();
      if (!effective) return;
      syncEnabledRef.current = true;
      setStatus("loading");
      setError(null);
      setBook(null);
      lastSentPageRef.current = null;
      try {
        const res = await fetch("/api/pages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: effective }),
        });
        const payload = (await res.json()) as FlipBook | { error: string };
        if (!res.ok) {
          throw new Error(
            "error" in payload ? payload.error : `HTTP ${res.status}`,
          );
        }
        const fb = payload as FlipBook;
        // If the caller asked to resume at a specific page (library card
        // click), feed it through the existing hash-page pipeline so the
        // viewer opens on that page. Otherwise only trust the URL hash.
        if (resumePage && resumePage > 0) {
          pendingHashPageRef.current = resumePage;
        }
        setBook(fb);
        void refreshLibrary();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setStatus("idle");
      }
    },
    [url, refreshLibrary],
  );

  const handleOpenFromLibrary = useCallback(
    (entry: LibraryEntry) => {
      setUrl(entry.baseUrl);
      void handleScan(entry.baseUrl, entry.lastPage);
    },
    [handleScan],
  );

  const handleDeleteFromLibrary = useCallback(
    async (id: number) => {
      setLibrary((prev) => prev.filter((e) => e.id !== id));
      try {
        const res = await fetch(`/api/library/${id}`, { method: "DELETE" });
        if (!res.ok && res.status !== 404) {
          // Revert on unexpected failure.
          void refreshLibrary();
        }
      } catch {
        void refreshLibrary();
      }
    },
    [refreshLibrary],
  );

  useEffect(() => {
    const initialUrl = readInitialUrl();
    setUrl(initialUrl);
    pendingHashPageRef.current = readHashPage();
    prevHashRef.current = window.location.hash;

    void refreshLibrary();

    if (
      !hasAutoScannedRef.current &&
      new URL(window.location.href).searchParams.has("url")
    ) {
      hasAutoScannedRef.current = true;
      void handleScan(initialUrl);
    }
  }, [handleScan, refreshLibrary]);

  useEffect(() => {
    if (!book) return;
    const pending = pendingHashPageRef.current;
    if (pending !== null) {
      pendingHashPageRef.current = null;
      const clamped = Math.min(Math.max(1, pending), book.pages.length);
      setViewerIndex(clamped - 1);
    }
  }, [book]);

  useEffect(() => {
    if (!book) return;
    const onPopState = () => {
      syncingFromUrlRef.current = true;
      const hashPage = readHashPage();
      if (hashPage === null) {
        setViewerIndex(null);
      } else {
        const clamped = Math.min(Math.max(1, hashPage), book.pages.length);
        setViewerIndex(clamped - 1);
      }
      queueMicrotask(() => {
        syncingFromUrlRef.current = false;
      });
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("hashchange", onPopState);
    };
  }, [book]);

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
      a.download = `${book.slug}.zip`;
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
    const displayTitle = book.title ?? book.bookId;
    return (
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-xl font-semibold text-zinc-100">{displayTitle}</h2>
        {book.title && (
          <span className="font-mono text-xs text-zinc-500">
            {book.bookId}
          </span>
        )}
        <span className="text-sm text-zinc-400">
          {book.totalPageCount} pages
        </span>
      </div>
    );
  }, [book]);

  const openViewer = useCallback((index: number) => {
    setViewerIndex(index);
  }, []);
  const closeViewer = useCallback(() => setViewerIndex(null), []);
  const goPrev = useCallback(() => {
    setViewerIndex((i) => (i === null || i <= 0 ? i : i - 1));
  }, []);
  const goNext = useCallback(() => {
    if (!book) return;
    const last = book.pages.length - 1;
    setViewerIndex((i) => (i === null || i >= last ? i : i + 1));
  }, [book]);

  useEffect(() => {
    if (viewerIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        goNext();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeViewer();
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [viewerIndex, goPrev, goNext, closeViewer]);

  const currentPage =
    book && viewerIndex !== null ? book.pages[viewerIndex] : null;
  const hasPrev = viewerIndex !== null && viewerIndex > 0;
  const hasNext =
    !!book && viewerIndex !== null && viewerIndex < book.pages.length - 1;

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (book && currentPage) {
      const base = book.title ?? book.bookId;
      document.title = `${base} · p. ${Number(currentPage.pageNumber)} / ${book.pages.length}`;
    } else if (book) {
      document.title = `${book.title ?? book.bookId} · ${APP_NAME}`;
    } else {
      document.title = APP_NAME;
    }
  }, [book, currentPage]);

  // Debounced PATCH of last_page to the library whenever the reader advances.
  // Skips when the viewer is closed so we don't thrash the DB on close.
  useEffect(() => {
    if (!book || !book.libraryId || !currentPage) return;
    const libId = book.libraryId;
    const page = Number(currentPage.pageNumber);
    if (!Number.isFinite(page) || page < 1) return;
    if (lastSentPageRef.current === page) return;

    const handle = window.setTimeout(() => {
      lastSentPageRef.current = page;
      void fetch(`/api/library/${libId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lastPage: page }),
      }).catch(() => {
        // Progress saving is best-effort; ignore transient failures.
      });
    }, PROGRESS_DEBOUNCE_MS);

    return () => window.clearTimeout(handle);
  }, [book, currentPage]);

  // Sync the URL from app state: ?url=<book> and #p=<n>.
  // - `?url=` uses replaceState (typing in the input should not spam history).
  // - Opening the viewer (hash goes from empty to #p=N) uses pushState so the
  //   browser back button can close it.
  // - Navigating inside the viewer uses replaceState to avoid flooding history.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!syncEnabledRef.current) return;
    if (syncingFromUrlRef.current) return;
    // While we still have a pending hash page to consume (deep link on load),
    // don't touch the URL — we'd overwrite the user's #p=N before the viewer
    // has had a chance to open.
    if (pendingHashPageRef.current !== null) return;

    const current = new URL(window.location.href);

    if (book) {
      current.searchParams.set("url", url);
    } else {
      current.searchParams.delete("url");
    }

    const desiredHash =
      book && currentPage ? `#p=${Number(currentPage.pageNumber)}` : "";
    current.hash = desiredHash;

    const nextHref = current.toString();
    if (nextHref === window.location.href) return;

    // Opening the viewer = hash transitions from "" to "#p=N". In that case
    // push a new history entry so the browser back button closes the viewer.
    // Any other transition (navigating pages, closing, URL edits) replaces
    // the current entry to keep history clean.
    const prevHash = prevHashRef.current;
    const opened = desiredHash !== "" && prevHash === "";
    prevHashRef.current = desiredHash;

    if (opened) {
      window.history.pushState(null, "", nextHref);
    } else {
      window.history.replaceState(null, "", nextHref);
    }
  }, [book, currentPage, url]);

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
              onClick={() => handleScan()}
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
                <button
                  key={p.index}
                  type="button"
                  onClick={() => openViewer(p.index)}
                  className="group relative overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 aspect-2/3 block focus:outline-none focus:ring-2 focus:ring-sky-500"
                  aria-label={`Open page ${p.pageNumber}`}
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
                </button>
              ))}
            </div>
          </section>
        )}

        {!book && status === "idle" && library.length > 0 && (
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
                const progressPct = Math.round(
                  (entry.lastPage / Math.max(1, entry.totalPages)) * 100,
                );
                return (
                  <div
                    key={entry.id}
                    className="group relative rounded-lg border border-zinc-800 bg-zinc-950 p-4 transition hover:border-sky-500/60"
                  >
                    <button
                      type="button"
                      onClick={() => handleOpenFromLibrary(entry)}
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
                        / {entry.totalPages}
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
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
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

        {!book && status === "idle" && (
          <section className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 p-8 text-center text-sm text-zinc-500">
            Paste a FlipHTML5 book URL above and click{" "}
            <span className="text-zinc-300">Scan</span> to load the pages.
          </section>
        )}
      </main>

      {book && currentPage && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={`Page ${currentPage.pageNumber}`}
          onClick={closeViewer}
        >
          <div
            className="flex items-center justify-between px-4 py-3 text-sm text-zinc-300 border-b border-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="font-mono">
              {currentPage.pageNumber} / {book.pages.length}
            </span>
            <div className="flex items-center gap-2">
              <a
                href={proxied(currentPage.largeUrl)}
                target="_blank"
                rel="noreferrer"
                className="rounded-md px-2 py-1 text-xs text-zinc-300 hover:bg-white/10"
              >
                Open original
              </a>
              <button
                onClick={closeViewer}
                className="rounded-md px-2 py-1 text-xs text-zinc-300 hover:bg-white/10"
                aria-label="Close viewer"
              >
                Close (Esc)
              </button>
            </div>
          </div>

          <div
            className="relative flex-1 flex items-center justify-center overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={goPrev}
              disabled={!hasPrev}
              className="absolute left-2 sm:left-6 top-1/2 -translate-y-1/2 z-10 rounded-full bg-white/10 p-3 text-white transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-30"
              aria-label="Previous page"
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>

            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={currentPage.index}
              src={proxied(currentPage.largeUrl)}
              alt={`Page ${currentPage.pageNumber}`}
              className="max-h-full max-w-full object-contain select-none"
              draggable={false}
            />

            <button
              onClick={goNext}
              disabled={!hasNext}
              className="absolute right-2 sm:right-6 top-1/2 -translate-y-1/2 z-10 rounded-full bg-white/10 p-3 text-white transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-30"
              aria-label="Next page"
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>

          <div
            className="flex items-center justify-center gap-3 px-4 py-3 text-xs text-zinc-500 border-t border-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="hidden sm:inline">Arrow keys to navigate</span>
            <span className="hidden sm:inline">·</span>
            <span>Esc to close</span>
          </div>
        </div>
      )}
    </div>
  );
}
