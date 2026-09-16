import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Generic VS Code / Cursor `state.vscdb` ItemTable access.
 *
 * Both VS Code and Cursor (a VS Code fork) persist app state in an SQLite
 * `state.vscdb` whose `ItemTable(key TEXT, value BLOB)` is a key/value store.
 * These helpers are IDE-agnostic; the Cursor adapter builds on top. Prefer
 * node:sqlite (Node >= 22), fall back to the `sqlite3` CLI so the harness
 * works on Node 18 too. Both paths are zero-dependency.
 */

interface NodeSqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
}

interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  exec(sql: string): void;
  close(): void;
}

let nodeSqliteChecked = false;
let nodeSqliteCtor: (new (dbPath: string) => NodeSqliteDatabase) | null = null;

/** node:sqlite emits an ExperimentalWarning in some Node versions; load it
 * once and remember the outcome. */
async function loadNodeSqlite(): Promise<typeof nodeSqliteCtor> {
  if (nodeSqliteChecked) {
    return nodeSqliteCtor;
  }
  nodeSqliteChecked = true;
  try {
    const mod = (await import("node:sqlite")) as {
      DatabaseSync: new (dbPath: string) => NodeSqliteDatabase;
    };
    nodeSqliteCtor = mod.DatabaseSync;
  } catch {
    nodeSqliteCtor = null;
  }
  return nodeSqliteCtor;
}

interface SpawnResult {
  error: Error | undefined;
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Single sqlite3 CLI invocation (sync keeps the fallbacks simple; these
 * calls touch local files only). */
function sqlite3(
  dbPath: string,
  input: string,
  args: string[] = [],
): SpawnResult {
  const result = spawnSync("sqlite3", [dbPath, ...args], {
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    error: result.error,
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

/** Escape a JS string into a SQL string literal body (single quotes doubled). */
function sqlStringLiteral(value: string): string {
  return String(value).replace(/'/g, "''");
}

/** True for "no such table: ItemTable" errors — a missing ItemTable just
 * means no value was ever written; every other error must propagate. */
function isMissingTableError(error: unknown): boolean {
  return /no such table/i.test((error as Error | undefined)?.message ?? "");
}

export async function readItemTableValue(
  dbPath: string,
  key: string,
): Promise<string> {
  if (!dbPath || !existsSync(dbPath)) {
    return "";
  }

  const DatabaseSync = await loadNodeSqlite();
  if (DatabaseSync) {
    let db: NodeSqliteDatabase | undefined;
    try {
      db = new DatabaseSync(dbPath);
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = ?")
        .get(key) as Record<string, unknown> | undefined;
      const value = row?.value;
      if (value == null) {
        return "";
      }
      return typeof value === "string"
        ? value
        : new TextDecoder().decode(value as Buffer);
    } catch (error) {
      if (isMissingTableError(error)) {
        return "";
      }
      throw error;
    } finally {
      db?.close();
    }
  }

  const result = sqlite3(dbPath, "", [
    `SELECT value FROM ItemTable WHERE key='${sqlStringLiteral(key)}';`,
  ]);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (isMissingTableError({ message: result.stderr })) {
      return "";
    }
    throw new Error(`sqlite3 exited ${result.status}: ${result.stderr.trim()}`);
  }
  // Raw stdout is the value verbatim plus a trailing newline.
  return result.stdout.replace(/\n$/, "");
}

export async function ensureItemTable(dbPath: string): Promise<void> {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const ddl =
    "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);";
  const DatabaseSync = await loadNodeSqlite();
  if (DatabaseSync) {
    let db: NodeSqliteDatabase | undefined;
    try {
      db = new DatabaseSync(dbPath);
      db.exec(ddl);
    } finally {
      db?.close();
    }
    return;
  }
  const result = sqlite3(dbPath, ddl);
  if (result.error) {
    throw new Error(`sqlite3 failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`sqlite3 exited ${result.status}: ${result.stderr.trim()}`);
  }
}

export interface ItemTableMutation {
  op: "set" | "del";
  key: string;
  value?: string;
}

/** Apply multiple ItemTable mutations as a single atomic transaction, so a
 * failure partway can never leave the DB half-applied. */
export async function applyItemTableWrites(
  dbPath: string,
  mutations: ItemTableMutation[],
): Promise<void> {
  if (mutations.length === 0) {
    return;
  }

  const DatabaseSync = await loadNodeSqlite();
  if (DatabaseSync) {
    let db: NodeSqliteDatabase | undefined;
    try {
      db = new DatabaseSync(dbPath);
      const setStmt = db.prepare(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
      );
      const delStmt = db.prepare("DELETE FROM ItemTable WHERE key = ?");
      db.exec("BEGIN");
      try {
        for (const m of mutations) {
          if (m.op === "del") {
            delStmt.run(m.key);
          } else {
            setStmt.run(m.key, m.value ?? "");
          }
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    } finally {
      db?.close();
    }
    return;
  }

  // sqlite3 CLI fallback: batch all statements in one invocation. sqlite3
  // wraps the whole input in an implicit transaction, so it's atomic too.
  const sql = mutations
    .map((m) =>
      m.op === "del"
        ? `DELETE FROM ItemTable WHERE key='${sqlStringLiteral(m.key)}';`
        : `INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('${sqlStringLiteral(m.key)}', '${sqlStringLiteral(m.value ?? "")}');`,
    )
    .join("\n");
  const result = sqlite3(dbPath, sql);
  if (result.error) {
    throw new Error(`sqlite3 failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`sqlite3 exited ${result.status}: ${result.stderr.trim()}`);
  }
}
