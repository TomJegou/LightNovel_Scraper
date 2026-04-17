# LightNovel Scraper

A small Next.js 16 application that extracts light novels published on
[FlipHTML5](https://online.fliphtml5.com/) and turns them into a mobile-friendly
reader, with optional bulk download as a ZIP archive.

The reader viewport on fliphtml5.com is not practical on phones, so this app
server-side scrapes each book, serves the pages through an image proxy, and
renders them in a clean, keyboard-navigable viewer.

> For personal and educational use only. Respect the copyright and the terms
> of service of the content you scrape.

## Features

- Paste a FlipHTML5 book URL and list every page (high-resolution `.webp`).
- Built-in image proxy to bypass hotlink protection and CORS.
- Dedicated reader route (`/read/[id]/[slug]?p=N`) with full-screen viewer,
  keyboard shortcuts (`←`, `→`, `Space`, `Esc`), thumbnail grid and
  native browser history (back button closes the reader).
- One-click download of the whole book as a `<slug>.zip` with pages
  numbered `0001.webp`, `0002.webp`, ...
- **Library & resume**: every scanned book is persisted in a small SQLite
  database; the home page shows a library grid and clicking a card resumes
  reading at the last page you viewed.
- Shareable deep links: `/read/1/the-eminence-in-shadow-vol-4?p=42`
  resolves the book from the DB, auto-corrects the slug if it drifted,
  and opens directly on the requested page.
- Fully server-side scraping, including WebAssembly-based config
  decryption (FlipHTML5 obfuscates image lists in `config.js`).
- Hardened for self-hosting: SSRF allowlist, request size/time limits,
  per-IP rate limiting, production-safe error messages.

## How it works

FlipHTML5 books expose a `javascript/config.js` file that contains two
Emscripten-obfuscated payloads:

- `bookConfig` — book metadata, used for the total page count.
- `fliphtml5_pages` — the ordered list of image hashes.

Both are decrypted on the server by running the original `deString.js`
WebAssembly module in an isolated Node `vm` context
(`src/lib/fliphtml5/decoder.ts`). Image URLs are then resolved against the
book's base URL and exposed through a typed API.

```
Home scan   ──► /api/resolve  ──► fetch <title> HTML ─► upsert book ─► id + slug
               /read/[id]/[slug]?p=N
Reader mount ──► /api/library/:id ──► baseUrl + last_page
             ──► /api/pages        ──► fetch config.js ─► WASM decrypt ─► pages[]
             ──► /api/library/:id  (PATCH, debounced) ─► persist last_page
Images       ──► /api/image        ──► allowlisted proxy to fliphtml5 CDN
ZIP          ──► /api/download     ──► parallel downloads ─► streamed ZIP
```

`/api/resolve` is intentionally lightweight: it only fetches the book's
HTML page to extract the title, so the home → reader redirect is fast
even on cold books. The full scrape (config.js + WASM decrypt) happens
once the reader route mounts, which keeps the home page responsive.

## Requirements

- Node.js **20.9+** (tested with Node 24).
- A FlipHTML5 book URL, e.g.
  `https://online.fliphtml5.com/<owner>/<book>/`.

## Local development

```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000), paste a book URL,
click **Scan**, and browse or download.

### Useful scripts

| Command          | Description                                      |
| ---------------- | ------------------------------------------------ |
| `npm run dev`    | Start the Next.js dev server                     |
| `npm run build`  | Production build (emits a `standalone` bundle)   |
| `npm run start`  | Run the production build locally                 |
| `npm run lint`   | Lint with ESLint                                  |

## Docker

The project ships with a multi-stage `Dockerfile` based on
`tomyj/my-env:node` (Debian trixie + Node 24) that leverages Next.js
**standalone** output to produce a minimal runtime image.

### Build & run with Docker

```bash
docker build -t lightnovel-scraper:latest .
docker run -d --name lightnovel-scraper -p 46460:3000 lightnovel-scraper:latest
```

### Build & run with Docker Compose

```bash
docker compose up --build -d
docker compose logs -f web
docker compose down
```

Once running, the app is available at
[http://localhost:46460](http://localhost:46460).

The compose file applies sensible hardening defaults: read-only root
filesystem (with a `/tmp` tmpfs), `no-new-privileges`, dropped capabilities,
and an HTTP healthcheck. The container runs as the non-root `nextjs` user
(uid/gid `999`).

> The app listens on port **3000 inside the container** (the `PORT`
> environment variable). Only the host publication port (`46460`) is
> exposed on the host. If you change the container's internal port, keep
> the healthcheck URL in `docker-compose.yml` in sync.

### Data persistence

The library/history is stored in a small SQLite database. In Docker the
container writes it to `/data/library.db`, which is mounted from the named
volume `lightnovel-data`. Everything else on the container runs on a
read-only root filesystem, so only this volume is writable.

- **Override the path** (dev or custom deployments):
  `LIBRARY_DB_PATH=/absolute/path/to/library.db`. Outside of Docker the
  default is `./data/library.db` relative to the working directory.
- **Backup** the database from a running container:
  ```bash
  docker cp lightnovel-scraper:/data/library.db ./library.db
  ```
- **Restore** a backup (container must be stopped first):
  ```bash
  docker compose cp ./library.db web:/data/library.db
  docker compose restart web
  ```
- **Reset** the entire library:
  ```bash
  docker compose down
  docker volume rm lightnovel_lightnovel-data
  docker compose up -d
  ```

There is no authentication; anyone who can reach the app can see and
modify the library. Keep the container behind a reverse proxy with auth
if you expose it publicly.

## API

All API routes run on the Node.js runtime (`export const runtime = "nodejs"`).

### `POST /api/resolve`

Lightweight resolver used by the home page. Validates the URL, fetches
only the book's HTML page to extract the title, and upserts a minimal
library entry (with `total_pages = 0` placeholder on first insert).

Request:

```json
{ "url": "https://online.fliphtml5.com/<owner>/<book>/" }
```

Response:

```json
{
  "id": 1,
  "baseUrl": "https://online.fliphtml5.com/<owner>/<book>/",
  "bookId": "<owner>/<book>",
  "title": "Book Title",
  "slug": "book-title",
  "totalPages": 0,
  "lastPage": 1
}
```

The home page uses `{ id, slug, lastPage }` to redirect to
`/read/[id]/[slug]?p=N`. Existing library entries are not clobbered:
`total_pages`, `last_page` and `first_seen_at` are preserved on conflict.

Rate limit: **30 req/min/IP**.

### `POST /api/pages`

Request:

```json
{ "url": "https://online.fliphtml5.com/<owner>/<book>/" }
```

Response:

```json
{
  "baseUrl": "https://online.fliphtml5.com/<owner>/<book>/",
  "bookId": "<owner>/<book>",
  "title": "Book Title",
  "slug": "book-title",
  "totalPageCount": 261,
  "pages": [
    {
      "index": 0,
      "pageNumber": "0001",
      "largeUrl": "https://online.fliphtml5.com/.../large/<hash>.webp",
      "thumbUrl": "https://online.fliphtml5.com/.../thumb/<hash>.webp"
    }
  ],
  "libraryId": 1,
  "lastPage": 1
}
```

The call also upserts the book into the server-side library so it shows
up on the home page. `libraryId` + `lastPage` are returned so the UI can
resume at the last-read page and later `PATCH` its progress.

Rate limit: **20 req/min/IP**.

### `GET /api/image?u=<encoded-url>`

Proxies a FlipHTML5 CDN image. The `u` parameter must point to a host in
the allowlist (`online.fliphtml5.com`, `static.fliphtml5.com`) over HTTPS.
Returns the binary with a safe, whitelisted `Content-Type` and
`X-Content-Type-Options: nosniff`.

Rate limit: **600 req/min/IP**.

### `POST /api/download`

Same body as `/api/pages`. Streams a ZIP archive named `<slug>.zip` that
contains the numbered pages (`0001.webp`, `0002.webp`, ...).

Rate limit: **4 req/min/IP**. Aggregate size is capped to protect the
server from abuse.

### `GET /api/library`

Returns the list of previously scanned books, sorted by most recent
access. Capped at 50 entries.

```json
{
  "entries": [
    {
      "id": 1,
      "baseUrl": "https://online.fliphtml5.com/<owner>/<book>/",
      "bookId": "<owner>/<book>",
      "title": "Book Title",
      "slug": "book-title",
      "totalPages": 261,
      "lastPage": 42,
      "firstSeenAt": 1734000000000,
      "lastReadAt": 1734100000000
    }
  ]
}
```

Rate limit: **120 req/min/IP**.

### `GET /api/library/:id`

Returns a single library entry by id. Used by the reader when it mounts
from a deep link and needs to resolve the book's `baseUrl` without
rescanning. Returns `200` + the entry, `404` if the id is unknown,
`400` if the id is malformed.

Rate limit: **120 req/min/IP**.

### `PATCH /api/library/:id`

Updates the `lastPage` cursor for a library entry. Body:

```json
{ "lastPage": 42 }
```

Values are clamped to `[1, totalPages]`. Rate limit: **300 req/min/IP**
(the reader debounces this, so real-world traffic is much lower).

### `DELETE /api/library/:id`

Removes an entry from the library. Returns `204` on success. Rate limit:
**60 req/min/IP**.

## Security

This app was designed with self-hosting in mind. A dedicated helper lives
at `src/lib/security.ts` and is reused by every route:

- **Strict host allowlist** for all outbound HTTPS traffic — blocks SSRF
  attempts like `http://127.0.0.1/`, `file://`, metadata endpoints, etc.
- **Bounded `fetch`** with a 20 s timeout and per-call byte limits
  (2 MiB for `config.js`, 10 MiB per image, 3 GiB aggregate for the ZIP).
- **Content-Type sanitization** on the image proxy: unknown MIME types
  fall back to `image/webp` and `nosniff` is always set.
- **Fixed-window rate limiter** per caller IP + route (in-memory; swap for
  Redis/Upstash for multi-instance deployments).
- **Production-safe errors** via `sanitizeError()` that logs details
  server-side but only exposes a generic message to clients.

> The decoder runs the original FlipHTML5 WASM inside a `vm.createContext`
> sandbox that still exposes `process`/`require` to the guest code.
> The WASM bundle is benign today, but if you deploy publicly consider
> restricting egress network access at the infrastructure layer and/or
> moving the decoder into a dedicated worker thread.

## Project layout

```
src/
├── app/
│   ├── api/
│   │   ├── download/route.ts          # ZIP download
│   │   ├── image/route.ts             # Image proxy
│   │   ├── library/route.ts           # Library listing (GET)
│   │   ├── library/[id]/route.ts      # Library entry (GET / PATCH / DELETE)
│   │   ├── pages/route.ts             # Full scrape + upsert
│   │   └── resolve/route.ts           # Lightweight title resolver (+ minimal upsert)
│   ├── read/[id]/[slug]/
│   │   ├── page.tsx                   # Full-screen reader + thumbnail grid
│   │   └── loading.tsx                # Skeleton shown during scrape
│   ├── layout.tsx                     # Root layout
│   ├── page.tsx                       # Home: URL input + library grid
│   └── globals.css
└── lib/
    ├── library.ts                     # SQLite persistence (better-sqlite3)
    ├── security.ts                    # Allowlist, bounded fetch, rate limit
    └── fliphtml5/
        ├── decoder.ts                 # WASM loader (vm sandbox)
        ├── deString.js                # Upstream Emscripten module (not modified)
        └── index.ts                   # Scraping pipeline
```

## License

Personal project, no license granted. Do not redistribute scraped content.
