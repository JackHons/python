import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy";
import * as schema from "../db/schema.ts";

type Row = Record<string, unknown>;

const MIGRATION_DIR = resolve(process.cwd(), "drizzle");

function inputValues(values: readonly unknown[]): SQLInputValue[] {
  return values.map((value) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      ArrayBuffer.isView(value)
    ) {
      return value as SQLInputValue;
    }
    throw new TypeError("SQLite parameters must be primitive values or buffers");
  });
}

function migrationFiles() {
  return readdirSync(MIGRATION_DIR)
    .filter((file) => /^\d+_.*\.sql$/.test(file))
    .sort()
    .map((file) => ({ name: file.replace(/\.sql$/, ""), path: resolve(MIGRATION_DIR, file) }));
}

function migrationStatements(path: string) {
  return readFileSync(path, "utf8")
    .split(/--> statement-breakpoint/g)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function migrationHash(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export class LocalDatabase {
  readonly native: DatabaseSync;

  constructor(native: DatabaseSync) {
    this.native = native;
  }

  exec(sql: string) {
    return this.native.exec(sql);
  }

  run(sql: string, params: readonly unknown[] = []) {
    return this.native.prepare(sql).run(...inputValues(params));
  }

  get<T extends Row = Row>(sql: string, params: readonly unknown[] = []) {
    return this.native.prepare(sql).get(...inputValues(params)) as T | undefined;
  }

  all<T extends Row = Row>(sql: string, params: readonly unknown[] = []) {
    return this.native.prepare(sql).all(...inputValues(params)) as T[];
  }

  transaction<T>(callback: () => T): T {
    this.native.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.native.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.native.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }

  close() {
    this.native.close();
  }
}

function tableExists(database: LocalDatabase, tableName: string) {
  return Boolean(
    database.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      [tableName],
    ),
  );
}

function hasCompleteBaseline(database: LocalDatabase) {
  const required = ["users", "auth_sessions", "classes", "courses", "units", "audit_logs"];
  return required.every((tableName) => tableExists(database, tableName));
}

export function migrate(database: LocalDatabase) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const files = migrationFiles();
  files.forEach((file, index) => {
    const existing = database.get<{ checksum: string }>(
      "SELECT checksum FROM app_migrations WHERE name = ?",
      [file.name],
    );
    const checksum = migrationHash(file.path);
    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error(`Migration checksum mismatch for ${file.name}`);
      }
      return;
    }

    // A database created by the original Drizzle migration may not have the
    // local bookkeeping row. Mark only the known baseline as applied, then
    // continue with newer non-destructive migrations.
    if (index === 0 && hasCompleteBaseline(database)) {
      database.run("INSERT INTO app_migrations (name, checksum) VALUES (?, ?)", [file.name, checksum]);
      return;
    }

    database.transaction(() => {
      for (const statement of migrationStatements(file.path)) database.exec(statement);
      database.run("INSERT INTO app_migrations (name, checksum) VALUES (?, ?)", [file.name, checksum]);
    });
  });
}

export function openLocalDatabase(path = process.env.DATABASE_PATH ?? ":memory:") {
  const native = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    timeout: 5000,
  });
  const database = new LocalDatabase(native);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") database.exec("PRAGMA journal_mode = WAL;");
  migrate(database);
  return database;
}

/**
 * Drizzle-compatible local adapter. Domain services use the explicit
 * transaction wrapper above, while queries can still use the existing
 * `db/schema.ts` definitions through Drizzle's sqlite-proxy driver.
 */
export function getDrizzle(database: LocalDatabase) {
  return drizzleProxy(
    async (sql, params, method) => {
      const values = inputValues(params);
      if (method === "run") {
        database.native.prepare(sql).run(...values);
        return { rows: [] };
      }
      const rows = database.native.prepare(sql).all(...values) as Row[];
      if (method === "get") return { rows: rows.slice(0, 1) };
      if (method === "values") return { rows: rows.map((row) => Object.values(row)) };
      return { rows };
    },
    { schema },
  );
}

export function assertDatabaseIntegrity(database: LocalDatabase) {
  const foreignKeys = database.get<{ foreign_keys: number }>("PRAGMA foreign_keys");
  const integrity = database.get<{ integrity_check: string }>("PRAGMA integrity_check");
  const violations = database.all("PRAGMA foreign_key_check");
  if (foreignKeys?.foreign_keys !== 1) throw new Error("SQLite foreign_keys pragma is disabled");
  if (integrity?.integrity_check !== "ok") throw new Error("SQLite integrity check failed");
  if (violations.length > 0) throw new Error("SQLite foreign_key_check found violations");
  return { foreignKeys: foreignKeys.foreign_keys, integrity: integrity.integrity_check, violations };
}
