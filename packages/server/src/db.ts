import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogRow = { id: number; ts: number; message: string };

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      key     TEXT    NOT NULL,
      message TEXT    NOT NULL,
      ts      INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS logs_key_id ON logs(key, id);`);
  return db;
}

export function insertLog(db: DatabaseSync, key: string, message: string): void {
  db.prepare("INSERT INTO logs (key, message, ts) VALUES (?, ?, ?)").run(
    key,
    message,
    Date.now(),
  );
}

export function listLogs(db: DatabaseSync, key: string): LogRow[] {
  return db
    .prepare("SELECT id, ts, message FROM logs WHERE key = ? ORDER BY id ASC")
    .all(key) as unknown[] as LogRow[];
}
