"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
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
const PROGRESS_DEBOUNCE_MS = 1500;

function proxied(url: string) {
  return `/api/image?u=${encodeURIComponent(url)}`;
}

function parsePageParam(raw: string | null): number {
  if (!raw) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

export default function ReaderPage() {
  const params = useParams<{ id: string; slug: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();

  const idParam = params?.id ?? "";
  const slugParam = params?.slug ?? "";
  const id = Number(idParam);
  const idIsValid = Number.isFinite(id) && id > 0 && String(id) === idParam;

  const requestedPage = useMemo(
    () => parsePageParam(searchParams?.get("p") ?? null),
    [searchParams],
  );

  const [entry, setEntry] = useState<LibraryEntry | null>(null);
  const [book, setBook] = useState<FlipBook | null>(null);
  const [currentIndex, setCurrentIndex] = useState<number>(
    Math.max(0, requestedPage - 1),
  );
  const [status, setStatus] = useState<"bootstrapping" | "scanning" | "ready" | "downloading">(
    "bootstrapping",
  );
  const [error, setError] = useState<string | null>(null);

  const lastSentPageRef = useRef<number | null>(null);
  const hasAppliedInitialPageRef = useRef(false);

  // Bootstrap: fetch the library entry (cheap) then the full page list.
  useEffect(() => {
    if (!idIsValid) {
      router.replace("/?error=invalid-id");
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        setStatus("bootstrapping");
        setError(null);

        const libRes = await fetch(`/api/library/${id}`, { cache: "no-store" });
        if (cancelled) return;
        if (libRes.status === 404) {
          router.replace("/?error=not-found");
          return;
        }
        if (!libRes.ok) {
          throw new Error(`Library lookup failed (HTTP ${libRes.status})`);
        }
        const libEntry = (await libRes.json()) as LibraryEntry;
        if (cancelled) return;

        setEntry(libEntry);

        if (libEntry.slug && libEntry.slug !== slugParam) {
          const p = searchParams?.get("p");
          const qs = p ? `?p=${encodeURIComponent(p)}` : "";
          router.replace(
            `/read/${libEntry.id}/${encodeURIComponent(libEntry.slug)}${qs}`,
          );
          return;
        }

        setStatus("scanning");
        const pagesRes = await fetch("/api/pages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: libEntry.baseUrl }),
        });
        if (cancelled) return;
        const pagesPayload = (await pagesRes.json()) as
          | FlipBook
          | { error: string };
        if (!pagesRes.ok) {
          throw new Error(
            "error" in pagesPayload
              ? pagesPayload.error
              : `HTTP ${pagesRes.status}`,
          );
        }
        if (cancelled) return;
        const fb = pagesPayload as FlipBook;
        setBook(fb);
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("ready");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, idIsValid, router, slugParam, searchParams]);

  // Clamp the initial page to the book's actual range once we know the total.
  // We only do this once per book load so external navigation (history back
  // with a different ?p=) still re-syncs via the searchParams effect below.
  useEffect(() => {
    if (!book) return;
    if (hasAppliedInitialPageRef.current) return;
    hasAppliedInitialPageRef.current = true;
    const clamped = Math.min(
      Math.max(0, requestedPage - 1),
      book.pages.length - 1,
    );
    setCurrentIndex(clamped);
  }, [book, requestedPage]);

  // Also react to searchParams changes (back/forward button in the same reader).
  useEffect(() => {
    if (!book) return;
    if (!hasAppliedInitialPageRef.current) return;
    const clamped = Math.min(
      Math.max(0, requestedPage - 1),
      book.pages.length - 1,
    );
    setCurrentIndex((cur) => (cur === clamped ? cur : clamped));
  }, [book, requestedPage]);

  const currentPage = book ? book.pages[currentIndex] : null;
  const hasPrev = !!book && currentIndex > 0;
  const hasNext = !!book && currentIndex < book.pages.length - 1;

  const goPrev = useCallback(() => {
    setCurrentIndex((i) => (i <= 0 ? i : i - 1));
  }, []);
  const goNext = useCallback(() => {
    if (!book) return;
    const last = book.pages.length - 1;
    setCurrentIndex((i) => (i >= last ? i : i + 1));
  }, [book]);

  // Keyboard shortcuts + lock scroll while the reader is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        goNext();
      } else if (e.key === "Escape") {
        e.preventDefault();
        router.push("/");
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [goPrev, goNext, router]);

  // Sync ?p=N to the URL whenever currentIndex changes (replace, not push,
  // so page flips don't pile up history entries).
  useEffect(() => {
    if (!book || !entry) return;
    const page = Number(book.pages[currentIndex]?.pageNumber);
    if (!Number.isFinite(page) || page < 1) return;
    const currentParam = searchParams?.get("p");
    if (currentParam === String(page)) return;
    router.replace(
      `/read/${entry.id}/${encodeURIComponent(entry.slug)}?p=${page}`,
      { scroll: false },
    );
  }, [book, entry, currentIndex, router, searchParams]);

  // Debounced progress PATCH.
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
        // Best-effort; ignore transient failures.
      });
    }, PROGRESS_DEBOUNCE_MS);

    return () => window.clearTimeout(handle);
  }, [book, currentPage]);

  // Document title reflects current page for easy tab identification.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const base = book?.title ?? entry?.title ?? entry?.bookId ?? APP_NAME;
    if (book && currentPage) {
      document.title = `${base} · p. ${Number(currentPage.pageNumber)} / ${book.pages.length}`;
    } else {
      document.title = `${base} · ${APP_NAME}`;
    }
    return () => {
      document.title = APP_NAME;
    };
  }, [book, entry, currentPage]);

  const handleDownload = useCallback(async () => {
    if (!book) return;
    setStatus("downloading");
    setError(null);
    try {
      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: book.baseUrl }),
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
      setStatus("ready");
    }
  }, [book]);

  const closeReader = useCallback(() => {
    router.push("/");
  }, [router]);

  const displayTitle =
    book?.title ?? entry?.title ?? entry?.bookId ?? "Loading…";
  const totalPages = book?.pages.length ?? entry?.totalPages ?? 0;

  if (!idIsValid) {
    return null;
  }

  return (
    <div className="min-h-screen bg-black text-zinc-100 font-sans">
      {/* Top bar */}
      <div className="sticky top-0 z-40 border-b border-white/10 bg-black/70 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <Link
            href="/"
            className="rounded-md px-2 py-1 text-xs text-zinc-300 hover:bg-white/10"
          >
            ← Library
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-zinc-100">
              {displayTitle}
            </h1>
            {entry?.title && entry.bookId && (
              <p className="truncate font-mono text-[10px] text-zinc-500">
                {entry.bookId}
              </p>
            )}
          </div>
          <span className="font-mono text-xs text-zinc-400">
            {currentPage
              ? `${currentPage.pageNumber} / ${totalPages}`
              : totalPages
                ? `— / ${totalPages}`
                : "—"}
          </span>
          {book && (
            <button
              type="button"
              onClick={handleDownload}
              disabled={status === "downloading"}
              className="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {status === "downloading" ? "Packaging…" : "Download ZIP"}
            </button>
          )}
        </div>
        {error && (
          <div className="border-t border-red-500/40 bg-red-500/10 px-4 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
      </div>

      {/* Full-screen viewer */}
      <div className="relative flex min-h-[calc(100vh-56px)] items-center justify-center overflow-hidden">
        {status === "bootstrapping" || status === "scanning" || !currentPage ? (
          <div className="flex flex-col items-center gap-3 text-sm text-zinc-400">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-600 border-t-sky-400" />
            <span>
              {status === "bootstrapping"
                ? "Loading book…"
                : status === "scanning"
                  ? "Fetching pages…"
                  : "Preparing viewer…"}
            </span>
          </div>
        ) : (
          <>
            <button
              onClick={goPrev}
              disabled={!hasPrev}
              className="absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-30 sm:left-6"
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
              className="max-h-[calc(100vh-56px)] max-w-full select-none object-contain"
              draggable={false}
            />

            <button
              onClick={goNext}
              disabled={!hasNext}
              className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-30 sm:right-6"
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
          </>
        )}
      </div>

      {/* Thumbnail grid */}
      {book && (
        <div className="border-t border-white/10 bg-zinc-950">
          <div className="mx-auto max-w-6xl px-4 py-6">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-medium text-zinc-300">All pages</h2>
              <button
                type="button"
                onClick={closeReader}
                className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10"
              >
                Close (Esc)
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
              {book.pages.map((p) => {
                const active = p.index === currentIndex;
                return (
                  <button
                    key={p.index}
                    type="button"
                    onClick={() => setCurrentIndex(p.index)}
                    className={`group relative block aspect-2/3 overflow-hidden rounded-md border transition ${
                      active
                        ? "border-sky-500 ring-2 ring-sky-500/40"
                        : "border-zinc-800 hover:border-zinc-600"
                    }`}
                    aria-label={`Go to page ${p.pageNumber}`}
                    aria-current={active ? "page" : undefined}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={proxied(p.thumbUrl)}
                      alt={`Page ${p.pageNumber}`}
                      loading="lazy"
                      className="absolute inset-0 h-full w-full object-cover transition group-hover:opacity-80"
                    />
                    <span className="absolute left-1 bottom-1 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-zinc-200">
                      {p.pageNumber}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
