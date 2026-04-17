export default function Loading() {
  return (
    <div className="min-h-screen bg-black text-zinc-100 font-sans">
      <div className="sticky top-0 z-40 border-b border-white/10 bg-black/70 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <div className="h-6 w-20 animate-pulse rounded-md bg-white/5" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="h-4 w-1/2 animate-pulse rounded bg-white/10" />
            <div className="h-3 w-24 animate-pulse rounded bg-white/5" />
          </div>
          <div className="h-5 w-16 animate-pulse rounded bg-white/5" />
          <div className="h-7 w-28 animate-pulse rounded-md bg-white/5" />
        </div>
      </div>

      <div className="flex min-h-[calc(100vh-56px)] items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-sm text-zinc-400">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-sky-400" />
          <span>Loading book…</span>
        </div>
      </div>
    </div>
  );
}
