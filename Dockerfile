# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14-alpine AS build
WORKDIR /app

COPY package.json bun.lock* ./
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/

RUN bun install --frozen-lockfile

COPY packages/server ./packages/server
COPY packages/web ./packages/web

RUN bun run build:web


FROM oven/bun:1.3.14-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Server source (no build step needed — Bun runs TS directly)
COPY --from=build /app/packages/server ./packages/server
# Built web assets
COPY --from=build /app/packages/web/dist ./packages/web/dist
# node_modules for runtime deps (currently none, but future-proof)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 12000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:12000/api/health | grep -q '"ok"' || exit 1

CMD ["bun", "run", "packages/server/src/index.ts"]
