import { file } from "bun";
import { join, normalize } from "node:path";
import { existsSync } from "node:fs";
import { openDb, insertLog, listLogs } from "./db.ts";

const PORT = 12000;
const DB_PATH = process.env.LOGS_DRAIN_DB ?? "/data/logs.db";
const WEB_DIST =
  process.env.LOGS_DRAIN_WEB_DIST ??
  new URL("../../web/dist", import.meta.url).pathname;

const KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;

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
    const f = file(fullPath);
    if (await f.exists()) return new Response(f);
  }
  // SPA fallback
  const indexPath = join(WEB_DIST, "index.html");
  if (existsSync(indexPath)) {
    return new Response(file(indexPath), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response("not found", { status: 404 });
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
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
  },
});

console.log(`logs-drain listening on http://${server.hostname}:${server.port}`);
console.log(`  db:  ${DB_PATH}`);
console.log(`  web: ${WEB_DIST}`);
