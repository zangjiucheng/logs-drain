# logs-drain

A tiny self-hosted log sink. POST log lines under a key, browse them at
`/logs/<key>` with live refresh, substring filter, and clickable URLs.

See [`SPEC.md`](./SPEC.md) for the full design.

## Run

### Docker

```sh
docker run -d --name logs-drain \
  -p 12000:12000 \
  -v "$PWD/data:/data" \
  pegasis0/logs-drain:latest
```

Then open <http://localhost:12000>.

### Docker Compose

```yaml
services:
  logs-drain:
    image: pegasis0/logs-drain:latest
    container_name: logs-drain
    restart: unless-stopped
    ports:
      - "12000:12000"
    volumes:
      - ./data:/data
```

```sh
docker compose up -d
```

### Build from source

```sh
docker build -t pegasis0/logs-drain:latest .
```

## Adding logs from the command line

Each log line is one `POST` with the message as the raw request body. The key
goes in the URL path.

**A single line:**

```sh
curl -X POST --data-binary 'something happened' \
     -H 'Content-Type: text/plain' \
     http://localhost:12000/api/logs/my-job
```

**A line built from a variable:**

```sh
curl -X POST --data-binary "deploy finished at $(date -Iseconds)" \
     -H 'Content-Type: text/plain' \
     http://localhost:12000/api/logs/deploys
```

**A multi-line message in one entry** (newlines are preserved in the UI):

```sh
curl -X POST --data-binary $'first line\nsecond line\nthird line' \
     -H 'Content-Type: text/plain' \
     http://localhost:12000/api/logs/my-job
```

**Tail a local file into logs-drain, one line per entry:**

```sh
tail -F /var/log/myapp.log | while IFS= read -r line; do
  curl -sS -X POST --data-binary "$line" \
       -H 'Content-Type: text/plain' \
       http://localhost:12000/api/logs/myapp
done
```

**Pipe command output into a key as it runs:**

```sh
./long-running-job 2>&1 | while IFS= read -r line; do
  curl -sS -X POST --data-binary "$line" \
       -H 'Content-Type: text/plain' \
       http://localhost:12000/api/logs/long-running-job
done
```

A small reusable helper:

```sh
log() {
  local key="$1"; shift
  curl -sS -X POST --data-binary "$*" \
       -H 'Content-Type: text/plain' \
       "http://localhost:12000/api/logs/$key"
}

log my-job "starting work"
log my-job "done in 1.2s"
```

Keys must match `^[A-Za-z0-9._-]{1,128}$`. A successful POST returns `204 No
Content`.

## Downloading logs from the command line

`GET /api/logs/<key>` returns all logs for the key, oldest first, as JSON.

**Raw JSON:**

```sh
curl -sS http://localhost:12000/api/logs/my-job
```

**Just the messages, one per line** (requires `jq`):

```sh
curl -sS http://localhost:12000/api/logs/my-job | jq -r '.logs[].message'
```

**Timestamped, in local time:**

```sh
curl -sS http://localhost:12000/api/logs/my-job \
  | jq -r '.logs[] | "\(.ts/1000 | strftime("%Y-%m-%d %H:%M:%S")) \(.message)"'
```

**Save to a file:**

```sh
curl -sS http://localhost:12000/api/logs/my-job \
  | jq -r '.logs[].message' > my-job.log
```

**Follow new logs (poll every 2s, print only what's new):**

```sh
seen=0
while sleep 2; do
  curl -sS http://localhost:12000/api/logs/my-job \
    | jq -r --argjson seen "$seen" \
        '.logs | map(select(.id > $seen)) | (.[] | .message), (.[-1].id // $seen)' \
    | { while IFS= read -r line; do
          last=$line
          [ -n "$prev" ] && printf '%s\n' "$prev"
          prev=$line
        done
        seen=$last
      }
done
```

For most "tail" use cases it's simpler to just open the browser — the UI
auto-refreshes every 10 seconds.

## API summary

| Method | Path             | Body         | Response                              |
| ------ | ---------------- | ------------ | ------------------------------------- |
| POST   | `/api/logs/:key` | `text/plain` | `204 No Content`                      |
| GET    | `/api/logs/:key` | —            | `{ key, logs: [{id, ts, message}] }`  |
| GET    | `/api/health`    | —            | `{ status: "ok" }` (200) or 503       |

`ts` is unix epoch milliseconds (server-assigned at insert time). The image
also exposes a Docker `HEALTHCHECK` against `/api/health`, so
`docker ps` and orchestrators see the container's true readiness.
