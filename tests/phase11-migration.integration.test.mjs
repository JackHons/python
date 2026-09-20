import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

function statements(sql) {
  return sql.split(/--> statement-breakpoint/g).map((item) => item.trim()).filter(Boolean);
}

test("0011 rolls back atomically, reapplies cleanly, and preserves SQLite integrity", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase11-migration-"));
  const path = join(root, "upgrade.sqlite");
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const names = (await readdir("drizzle")).filter((name) => /^00(0\d|10)_.*\.sql$/.test(name)).sort();
    assert.equal(names.at(-1)?.startsWith("0010_"), true);
    for (const name of names) {
      const sql = await readFile(join("drizzle", name), "utf8");
      db.exec("BEGIN IMMEDIATE");
      try { for (const statement of statements(sql)) db.exec(statement); db.exec("COMMIT"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('ai_settings') WHERE name = 'max_hint_layers'").get().count, 0);

    const migration = await readFile("drizzle/0011_nifty_vengeance.sql", "utf8");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements(migration)) db.exec(statement);
      throw new Error("prove-ddl-rollback");
    } catch (error) {
      db.exec("ROLLBACK");
      assert.match(String(error), /prove-ddl-rollback/);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'question_hints'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('ai_settings') WHERE name = 'max_hint_layers'").get().count, 0);

    db.exec("BEGIN IMMEDIATE");
    try { for (const statement of statements(migration)) db.exec(statement); db.exec("COMMIT"); }
    catch (error) { db.exec("ROLLBACK"); throw error; }
    assert.equal(db.prepare("SELECT dflt_value FROM pragma_table_info('ai_settings') WHERE name = 'max_hint_layers'").get().dflt_value, "3");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('question_hints', 'student_hint_unlocks')").get().count, 2);
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
