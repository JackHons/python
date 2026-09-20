import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ExportService } = await import("../server/exports.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("PDF export is a parseable PDF with report metadata and scope protection", async () => {
  const fixture = await makeContentFixture();
  const root = await mkdtemp(join(tmpdir(), "learning-pdf-"));
  try {
    const exports = new ExportService(fixture.db, root);
    const job = exports.createJob(fixture.teacher, { reportType: "compareCourses", format: "pdf", filters: { courseId: fixture.course.id } });
    await exports.runJob(fixture.teacher, job.id);
    const file = await exports.download(fixture.teacher, job.id);
    const text = new TextDecoder().decode(file.bytes);
    assert.equal(text.startsWith("%PDF-1.4"), true);
    assert.equal(text.includes("SnapshotAt"), true);
    assert.equal(text.includes("Asia/Macau"), true);
    assert.equal(text.includes("%%EOF"), true);
    await assert.rejects(() => exports.download(fixture.student, job.id), { code: "forbidden" });
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
