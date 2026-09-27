import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { openLocalDatabase, assertDatabaseIntegrity } = await import("../server/db.ts");
const { EducationService } = await import("../server/education.ts");
const { BackupService } = await import("../server/backups.ts");

test("backup switch, manifest/checksum and isolated restore are exercised on a file database", async () => {
  const root = await mkdtemp(join(tmpdir(), "learning-backup-"));
  const databasePath = join(root, "school.sqlite");
  const assetsRoot = join(root, "storage");
  const backupRoot = join(root, "backups");
  const restoreRoot = join(root, "restore");
  const db = openLocalDatabase(databasePath);
  try {
    const education = new EducationService(db);
    const adminResult = education.createInitialAdmin({ username: "backup-admin", chineseName: "備份管理員" });
    const admin = { id: adminResult.user.id, role: "admin" };
    await mkdir(join(assetsRoot, "assets"), { recursive: true });
    await writeFile(join(assetsRoot, "assets", "ready.bin"), Buffer.from("ready asset"));
    await mkdir(join(assetsRoot, "previews", "11111111-1111-1111-1111-111111111111"), { recursive: true });
    await writeFile(
      join(assetsRoot, "previews", "11111111-1111-1111-1111-111111111111", "slide-1.png"),
      Buffer.from("preview asset"),
    );
    await mkdir(join(assetsRoot, "quarantine"), { recursive: true });
    await writeFile(join(assetsRoot, "quarantine", "should-not-backup.upload"), Buffer.from("secret temp"));
    const backups = new BackupService(db, { databasePath, sourceStorageRoot: assetsRoot, backupRoot, enabled: false, retentionDays: 1 });
    assert.equal((await backups.createBackup(admin, { trigger: "scheduled", scope: "full" })).skipped, true);
    backups.setEnabled(admin, true);
    const record = await backups.createBackup(admin, { trigger: "manual", scope: "full" });
    assert.equal(record.status, "verified");
    assert.equal((await backups.verify(admin, record.id)).valid, true);
    const restored = await backups.restore(admin, record.id, restoreRoot);
    assert.equal(restored.integrity.foreignKeys, 1);
    assert.equal(restored.integrity.integrity, "ok");
    const restoredDb = openLocalDatabase(join(restoreRoot, "database.sqlite"));
    assert.equal(assertDatabaseIntegrity(restoredDb).integrity, "ok");
    assert.equal(restoredDb.get("SELECT COUNT(*) AS count FROM users").count, 1);
    restoredDb.close();
    assert.equal((await readFile(join(restoreRoot, "assets", "ready.bin"))).toString(), "ready asset");
    assert.equal(
      (await readFile(join(restoreRoot, "previews", "11111111-1111-1111-1111-111111111111", "slide-1.png"))).toString(),
      "preview asset",
    );
    await assert.rejects(() => backups.restore(admin, record.id, databasePath), { code: "restore_target_current_db" });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
