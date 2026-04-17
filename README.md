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
- Full-screen viewer with keyboard shortcuts (`←`, `→`, `Space`, `Esc`).
- One-click download of the whole book as a `<bookId>.zip` with pages
  numbered `0001.webp`, `0002.webp`, ...
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
Browser ──► /api/pages    ──► fetch config.js ─► WASM decrypt ─► JSON
Browser ──► /api/image    ──► allowlisted proxy to fliphtml5 CDN
Browser ──► /api/download ──► parallel downloads ─► streamed ZIP
```

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

## API

All API routes run on the Node.js runtime (`export const runtime = "nodejs"`).

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
  "totalPageCount": 261,
  "pages": [
    {
      "index": 0,
      "pageNumber": "0001",
      "largeUrl": "https://online.fliphtml5.com/.../large/<hash>.webp",
      "thumbUrl": "https://online.fliphtml5.com/.../thumb/<hash>.webp"
    }
  ]
}
```

Rate limit: **20 req/min/IP**.

### `GET /api/image?u=<encoded-url>`

Proxies a FlipHTML5 CDN image. The `u` parameter must point to a host in
the allowlist (`online.fliphtml5.com`, `static.fliphtml5.com`) over HTTPS.
Returns the binary with a safe, whitelisted `Content-Type` and
`X-Content-Type-Options: nosniff`.

Rate limit: **600 req/min/IP**.

### `POST /api/download`

Same body as `/api/pages`. Streams a ZIP archive named `<bookId>.zip` that
contains the numbered pages (`0001.webp`, `0002.webp`, ...).

Rate limit: **4 req/min/IP**. Aggregate size is capped to protect the
server from abuse.

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
│   │   ├── download/route.ts   # ZIP download
│   │   ├── image/route.ts      # Image proxy
│   │   └── pages/route.ts      # Metadata endpoint
│   ├── layout.tsx              # Root layout
│   ├── page.tsx                # Reader UI
│   └── globals.css
└── lib/
    ├── security.ts             # Allowlist, bounded fetch, rate limit
    └── fliphtml5/
        ├── decoder.ts          # WASM loader (vm sandbox)
        ├── deString.js         # Upstream Emscripten module (not modified)
        └── index.ts            # Scraping pipeline
```

## License

Personal project, no license granted. Do not redistribute scraped content.
