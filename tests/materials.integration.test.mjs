import assert from "node:assert/strict";
import test from "node:test";

const { DomainError } = await import("../server/errors.ts");
const { MaterialService } = await import("../server/content.ts");
import { makeContentFixture } from "./content-helpers.mjs";
import { minimalPptx } from "./zip-fixtures.mjs";

test("material uploads stay quarantined until released and conversion is an explicit job", async () => {
  const fixture = await makeContentFixture();
  try {
    const materials = new MaterialService(fixture.db, fixture.storage);
    const uploaded = await materials.quarantineUpload(fixture.teacher, {
      originalName: "lesson.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      bytes: minimalPptx(),
    });
    assert.equal(uploaded.status, "quarantined");
    assert.equal("storage_key" in uploaded, false);
    await assert.rejects(() => materials.createMaterial(fixture.teacher, fixture.unit.id, { kind: "slides", titleZh: "投影片", fileAssetId: uploaded.id }), (error) => error instanceof DomainError && error.code === "file_not_ready");
    await materials.releaseUpload(fixture.teacher, uploaded.id);
    const material = await materials.createMaterial(fixture.teacher, fixture.unit.id, { kind: "slides", titleZh: "投影片", fileAssetId: uploaded.id });
    await materials.updateMaterial(fixture.teacher, material.id, { status: "published" });
    const job = materials.createConversionJob(fixture.teacher, material.id);
    assert.equal(job.status, "queued");
    assert.equal(job.output_asset_id, null);
    assert.equal((materials.listMaterials(fixture.student, fixture.unit.id)).length, 1);
    const downloaded = await materials.downloadMaterial(fixture.student, material.id);
    assert.deepEqual(downloaded.bytes, minimalPptx());
    assert.equal(downloaded.filename, "lesson.pptx");
  } finally {
    await fixture.close();
  }
});

test("storage rejects traversal, MIME mismatch, and oversized uploads", async () => {
  const fixture = await makeContentFixture();
  try {
    const materials = new MaterialService(fixture.db, fixture.storage);
    await assert.rejects(() => materials.quarantineUpload(fixture.teacher, { originalName: "../secret.py", mimeType: "text/x-python", bytes: new Uint8Array([1]) }), (error) => error instanceof DomainError && error.code === "invalid_file_name");
    await assert.rejects(() => materials.quarantineUpload(fixture.teacher, { originalName: "lesson.pdf", mimeType: "text/plain", bytes: new Uint8Array([1]) }), (error) => error instanceof DomainError && error.code === "file_type_mismatch");
    await assert.rejects(() => materials.quarantineUpload(fixture.teacher, { originalName: "lesson.txt", mimeType: "text/plain", bytes: new Uint8Array(1025) }), (error) => error instanceof DomainError && error.code === "file_too_large");
    await assert.rejects(() => fixture.storage.read("assets/../quarantine/secret"), (error) => error instanceof DomainError && error.code === "invalid_storage_key");
  } finally {
    await fixture.close();
  }
});

test("student download is scoped to published course materials", async () => {
  const fixture = await makeContentFixture();
  try {
    const materials = new MaterialService(fixture.db, fixture.storage);
    const uploaded = await materials.quarantineUpload(fixture.teacher, { originalName: "notes.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("notes") });
    await materials.releaseUpload(fixture.teacher, uploaded.id);
    const material = await materials.createMaterial(fixture.teacher, fixture.unit.id, { kind: "document", titleZh: "筆記", fileAssetId: uploaded.id });
    await assert.rejects(() => materials.downloadMaterial(fixture.student, material.id), (error) => error instanceof DomainError && error.code === "not_found" && error.status === 404);
    assert.equal(materials.listMaterials(fixture.student, fixture.unit.id).length, 0);
  } finally {
    await fixture.close();
  }
});
