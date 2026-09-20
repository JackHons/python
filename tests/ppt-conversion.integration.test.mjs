import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { MaterialService } from "../server/content.ts";
import { MaterialConversionService } from "../server/conversion/service.ts";
import { DomainError } from "../server/errors.ts";
import { makeContentFixture } from "./content-helpers.mjs";

const fixturePath = process.env.PPTX_FIXTURE_PATH;
const fixtureSha = "1d9ef8a46d0672c59eca58b44d9cd3b54dd3e9a0cf34f8e98d686e8817805384";
const pptxMime = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

test("real PPTX conversion produces an authorized PDF and slide manifest without modifying the source", { timeout: 180_000 }, async (t) => {
  if (!fixturePath) { t.skip("PPTX_FIXTURE_PATH is not configured"); return; }
  try { await access(fixturePath); } catch { t.skip("real PPTX fixture is not available on this host"); return; }
  const fixture = await makeContentFixture({ maxBytes: 25 * 1024 * 1024 });
  try {
    const source = await readFile(fixturePath);
    assert.equal(createHash("sha256").update(source).digest("hex"), fixtureSha);
    const materials = new MaterialService(fixture.db, fixture.storage);
    const upload = await materials.quarantineUpload(fixture.teacher, { originalName: "python-basics.pptx", mimeType: pptxMime, bytes: source, purpose: "material_library" });
    await materials.releaseUpload(fixture.teacher, upload.id);
    const material = await materials.createMaterial(fixture.teacher, fixture.unit.id, { kind: "slides", titleZh: "Python 基礎", fileAssetId: upload.id });
    await materials.updateMaterial(fixture.teacher, material.id, { status: "published" });
    materials.createConversionJob(fixture.teacher, material.id);

    const converter = new MaterialConversionService(fixture.db, fixture.storage, { timeoutMs: 150_000, maxPages: 100, maxOutputBytes: 25 * 1024 * 1024, renderDpi: 96 });
    const completed = await converter.processOne();
    assert.equal(completed.status, "succeeded", completed.error_message);
    assert.ok(completed.page_count > 0);
    const status = materials.getConversionStatus(fixture.student, material.id);
    assert.equal(status.status, "succeeded");
    assert.equal(status.page_count, completed.page_count);
    assert.equal(status.error_message, null);

    const manifest = materials.previewManifest(fixture.student, material.id);
    assert.equal(manifest.pageCount, completed.page_count);
    assert.equal(manifest.slides.length, completed.page_count);
    assert.equal("storageKey" in manifest, false);
    const pdf = await materials.downloadPreviewPdf(fixture.student, material.id);
    assert.match(pdf.bytes.subarray(0, 5).toString(), /^%PDF-/);
    const firstSlide = await materials.downloadPreviewSlide(fixture.student, material.id, 1);
    assert.deepEqual([...firstSlide.bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const outsiderRecord = fixture.education.createUser(fixture.admin, { role: "student", username: "preview-outsider", chineseName: "旁聽學生", studentNumber: "OUT1" });
    const outsider = { id: outsiderRecord.user.id, role: "student" };
    assert.throws(() => materials.previewManifest(outsider, material.id), (error) => error instanceof DomainError && error.code === "not_found" && error.status === 404);
    assert.equal(createHash("sha256").update(await materials.downloadMaterial(fixture.student, material.id).then((item) => item.bytes)).digest("hex"), fixtureSha);
    assert.equal(createHash("sha256").update(await readFile(fixturePath)).digest("hex"), fixtureSha);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM file_assets WHERE id = ?", [completed.output_asset_id]).count, 1);
  } finally { await fixture.close(); }
});
