import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const XLSX = await import("xlsx");
const { ExportService } = await import("../server/exports.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("Excel export is a real parseable file with snapshot metadata and formula-injection protection", async () => {
  const fixture = await makeContentFixture();
  const root = await mkdtemp(join(tmpdir(), "learning-export-"));
  try {
    fixture.db.run("UPDATE courses SET title_zh = '=CMD(1)' WHERE id = ?", [fixture.course.id]);
    const exports = new ExportService(fixture.db, root);
    const job = exports.createJob(fixture.teacher, { reportType: "overview", format: "xlsx", filters: { courseId: fixture.course.id }, correlationId: "corr-export-1" });
    const completed = await exports.runJob(fixture.teacher, job.id);
    assert.equal(completed.status, "completed");
    assert.match(completed.sha256, /^[a-f0-9]{64}$/);
    const file = await exports.download(fixture.teacher, job.id);
    assert.equal(Buffer.from(file.bytes).subarray(0, 2).toString(), "PK");
    const workbook = XLSX.read(Buffer.from(file.bytes), { type: "buffer" });
    assert.deepEqual(workbook.SheetNames, ["_metadata", "data"]);
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets.data);
    assert.equal(rows[0].courseTitle, "'=CMD(1)");
    assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets._metadata, { header: 1 })[0][1], "v1");
    assert.equal(file.snapshotAt, completed.snapshot_at);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
