# syntax=docker/dockerfile:1.7

# ---------- deps ----------
# Install all deps (incl. dev) so Next can build.
FROM tomyj/my-env:node AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- build ----------
# Build the Next.js app in "standalone" mode.
FROM tomyj/my-env:node AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- runtime ----------
# Minimal runtime image: only the standalone server, static assets,
# public/ and the WASM decoder (loaded at runtime via fs.readFileSync).
FROM tomyj/my-env:node AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Non-root system user (Debian-based base image uses shadow-utils).
# UID/GID 999 stays below SYS_UID_MAX to satisfy the Debian convention.
RUN groupadd --system --gid 999 nodejs \
 && useradd  --system --uid 999 --gid nodejs --home-dir /app --shell /usr/sbin/nologin nextjs

# Next's standalone output already traces runtime dependencies, including
# src/lib/fliphtml5/deString.js which is read via fs.readFileSync at runtime.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# Writable directory for the SQLite library DB. Mounted as a Docker volume
# in production so data survives container rebuilds.
RUN mkdir -p /data && chown nextjs:nodejs /data
ENV LIBRARY_DB_PATH=/data/library.db

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
