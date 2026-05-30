# logs-drain

A lightweight, self-hosted log collection and viewing service. Push log lines
over HTTP under arbitrary keys; view them in a browser at `/logs/<key>` with
live refresh and in-memory text filtering.

## Goals & non-goals

**Goals**
- Trivial to ingest from shell scripts / curl.
- One Docker container, one port, persistent SQLite on a mounted volume.
- Simple per-key log view with live refresh, substring filter, and clickable
  links.

**Non-goals**
- No authentication, no multi-tenancy.
- No paging, no streaming (SSE/WebSocket).
- No structured/JSON log parsing, no log levels, no aggregation.
- No retention or quota enforcement (operator manages disk).
- No key index page; keys are discovered out-of-band.

## Tech stack

- **Runtime:** Bun (monorepo, workspaces).
- **Backend:** Bun's built-in HTTP server, plain REST. SQLite via `bun:sqlite`
  (in-process, single file).
- **Frontend:** React + Tailwind, bundled with Bun.
- **Packaging:** One Docker image. Backend serves both the API and the built
  frontend static assets on a single port.

## Monorepo layout

```
/
├── package.json              # workspaces: ["packages/*"]
├── bun.lockb
├── Dockerfile
├── SPEC.md
└── packages/
    ├── server/               # Bun HTTP server + SQLite
    │   ├── package.json
    │   ├── src/
    │   │   ├── index.ts      # entry: HTTP server, routes
    │   │   ├── db.ts         # SQLite open + schema migration
    │   │   └── routes.ts     # ingest + query handlers
    │   └── tsconfig.json
    └── web/                  # React + Tailwind frontend
        ├── package.json
        ├── index.html
        ├── tailwind.config.ts
        ├── src/
        │   ├── main.tsx
        │   ├── App.tsx
        │   ├── LogsPage.tsx
        │   └── linkify.ts
        └── tsconfig.json
```

## Database

- Single SQLite file at `/data/logs.db` (volume mount point in the container).
- WAL mode enabled for concurrent reads during writes.
- One table:

```sql
CREATE TABLE IF NOT EXISTS logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  key     TEXT    NOT NULL,
  message TEXT    NOT NULL,
  ts      INTEGER NOT NULL   -- unix epoch milliseconds, server-assigned
);
CREATE INDEX IF NOT EXISTS logs_key_id ON logs(key, id);
```

Ordering uses `id` (monotonic insertion order); `ts` is for display only.

## HTTP API (REST)

Both endpoints are plain REST. No tRPC.

### `POST /api/logs/:key`

Append a single log line under `key`.

- **Request body:** raw `text/plain` — the entire body is the log message.
  Trailing newlines are stripped. Empty body → `400`.
- **Key validation:** `^[A-Za-z0-9._-]{1,128}$`. Invalid → `400`.
- **Behavior:** insert one row; `ts = Date.now()`.
- **Response:** `204 No Content` on success.

Example:
```sh
curl -X POST --data-binary 'something happened' \
     -H 'Content-Type: text/plain' \
     http://host:12000/api/logs/my-job
```

### `GET /api/logs/:key`

Return all logs for `key`, oldest first.

- **Response:** `application/json`
  ```json
  {
    "key": "my-job",
    "logs": [
      { "id": 1, "ts": 1716500000000, "message": "..." },
      { "id": 2, "ts": 1716500001000, "message": "..." }
    ]
  }
  ```
- No paging, no limit. Unknown key → `200` with empty `logs: []`.

### Static assets

Any other `GET` path serves the built frontend (`index.html` for SPA routes,
hashed JS/CSS from the bundle output). The server falls back to `index.html`
for unknown non-`/api/*` paths so `/logs/<key>` works on direct load and
refresh.

## Frontend

### Routing

- `/` — minimal page with a text input ("enter key") that navigates to
  `/logs/<key>` on submit. No key listing.
- `/logs/:key` — the log viewer.

Use a small client-side router (e.g. `react-router-dom` or a hand-rolled
`useState` on `location.pathname`). Pick whichever is lighter.

### Log viewer (`/logs/:key`)

Layout:

```
┌───────────────────────────────────────────────────────┐
│  logs-drain · my-job              [filter: _______]  │  ← sticky header
├───────────────────────────────────────────────────────┤
│  12:00:01.123  first log line                         │
│  12:00:02.456  another line with https://example.com  │  ← link clickable
│  ...                                                  │
│  12:05:11.789  newest line                            │  ← auto-scroll target
└───────────────────────────────────────────────────────┘
```

Behavior:

- **Fetch:** `GET /api/logs/:key` on mount and every **10 seconds**.
- **Order:** oldest at top, newest at bottom.
- **Auto-scroll:** after each fetch, scroll to the bottom **only if** the user
  was already at (or near) the bottom before the update (within ~40px). This
  preserves scroll position when the user has scrolled up to read.
- **Filter:** single text input in the header. Case-insensitive substring
  match against `message`. Filtering is purely client-side over the
  already-fetched array; no re-fetch on input change. Empty input shows all.
- **Timestamp display:** `HH:MM:SS.mmm` in the browser's local time, rendered
  in a fixed-width column to the left of each message.
- **Link detection:** detect `http://` and `https://` URLs in each message via
  a single regex pass, render them as `<a target="_blank" rel="noopener
  noreferrer">` with a visible underline / accent color. Plain text around
  them renders unchanged. Whitespace and line breaks within a message are
  preserved (`white-space: pre-wrap`, monospace font).
- **Empty state:** if `logs` is empty, show "no logs yet for `<key>`".
- **Error state:** if the fetch fails, show a small inline error banner but
  keep displaying the last successful data and keep polling.

### Styling

- Tailwind, dark theme by default (terminal-like). Monospace font for the log
  body. Minimal chrome.

## Docker

Single multi-stage image:

1. **build stage** — install deps, build the frontend bundle into
   `packages/web/dist/`.
2. **runtime stage** — copy `packages/server/`, the built `packages/web/dist/`,
   and `node_modules` (or use `bun install --production`).

Runtime:

- `EXPOSE 12000`
- `CMD ["bun", "run", "packages/server/src/index.ts"]`
- `VOLUME ["/data"]`
- Server listens on `0.0.0.0:12000`. Port is hardcoded to `12000` (no env
  override needed for v1).
- DB path hardcoded to `/data/logs.db`.

Run:
```sh
docker run -d -p 12000:12000 -v ./data:/data --name logs-drain logs-drain
```

## Out of scope (explicit)

- Auth, TLS termination (use a reverse proxy if needed).
- Bulk ingest endpoint (one POST per line is fine for v1).
- WebSocket / SSE live tail (10s polling is sufficient).
- Retention, rotation, vacuum.
- Search across keys.
- Exporting logs.
