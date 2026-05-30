import { createServer, type IncomingMessage } from "node:http";
import { join, normalize, extname } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { openDb, insertLog, listLogs } from "./db.ts";

const PORT = Number(process.env.PORT ?? 12000);
const DB_PATH = process.env.LOGS_DRAIN_DB ?? "/data/logs.db";
const WEB_DIST =
  process.env.LOGS_DRAIN_WEB_DIST ??
  new URL("../../web/dist", import.meta.url).pathname;

const KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function contentType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

const db = openDb(DB_PATH);

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

async function serveStatic(pathname: string): Promise<Response> {
  // Normalize, strip leading slash, prevent path traversal
  const cleaned = normalize(pathname).replace(/^\/+/, "");
  if (cleaned.includes("..")) {
    return new Response("forbidden", { status: 403 });
  }
  const candidate = cleaned === "" ? "index.html" : cleaned;
  const fullPath = join(WEB_DIST, candidate);
  if (existsSync(fullPath) && !fullPath.endsWith("/")) {
    try {
      const bytes = await readFile(fullPath);
      return new Response(bytes, {
        headers: { "content-type": contentType(fullPath) },
      });
    } catch {
      // fall through to SPA fallback
    }
  }
  // SPA fallback
  const indexPath = join(WEB_DIST, "index.html");
  if (existsSync(indexPath)) {
    return new Response(await readFile(indexPath), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response("not found", { status: 404 });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

  // Health check
  if (pathname === "/api/health") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    try {
      db.prepare("SELECT 1").get();
    } catch (e) {
      return json(
        { status: "error", error: e instanceof Error ? e.message : String(e) },
        { status: 503 },
      );
    }
    return json({ status: "ok" });
  }

  // API: POST /api/logs/:key
  if (pathname.startsWith("/api/logs/")) {
    const key = decodeURIComponent(pathname.slice("/api/logs/".length));
    if (!KEY_RE.test(key)) {
      return json({ error: "invalid key" }, { status: 400 });
    }

    if (req.method === "POST") {
      const raw = await req.text();
      const message = raw.replace(/\r?\n+$/, "");
      if (message.length === 0) {
        return json({ error: "empty body" }, { status: 400 });
      }
      insertLog(db, key, message);
      return new Response(null, { status: 204 });
    }

    if (req.method === "GET") {
      const logs = listLogs(db, key);
      return json({ key, logs });
    }

    return new Response("method not allowed", { status: 405 });
  }

  // Disallow other /api/* paths
  if (pathname.startsWith("/api/")) {
    return json({ error: "not found" }, { status: 404 });
  }

  // Static + SPA fallback (only GET)
  if (req.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }
  return serveStatic(pathname);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const HOSTNAME = "0.0.0.0";

const server = createServer((nodeReq, nodeRes) => {
  void (async () => {
    const method = nodeReq.method ?? "GET";
    const host = nodeReq.headers.host ?? `${HOSTNAME}:${PORT}`;
    const url = `http://${host}${nodeReq.url ?? "/"}`;

    let body: Buffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      body = await readBody(nodeReq);
    }

    const request = new Request(url, {
      method,
      ...(body && body.length > 0 ? { body: new Uint8Array(body) } : {}),
    });

    let response: Response;
    try {
      response = await handle(request);
    } catch (e) {
      response = json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }

    nodeRes.statusCode = response.status;
    response.headers.forEach((value, name) => nodeRes.setHeader(name, value));
    const payload = Buffer.from(await response.arrayBuffer());
    nodeRes.end(method === "HEAD" ? undefined : payload);
  })().catch(() => {
    if (!nodeRes.headersSent) nodeRes.statusCode = 500;
    nodeRes.end();
  });
});

server.listen(PORT, HOSTNAME, () => {
  console.log(`logs-drain listening on http://${HOSTNAME}:${PORT}`);
  console.log(`  db:  ${DB_PATH}`);
  console.log(`  web: ${WEB_DIST}`);
});
