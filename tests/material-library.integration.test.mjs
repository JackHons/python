import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { MaterialService } from "../server/content.ts";
import { DomainError } from "../server/errors.ts";
import { makeContentFixture } from "./content-helpers.mjs";
import { minimalPptx, storedZip } from "./zip-fixtures.mjs";

const fixturePath = process.env.PPTX_FIXTURE_PATH;
const fixtureSha = "1d9ef8a46d0672c59eca58b44d9cd3b54dd3e9a0cf34f8e98d686e8817805384";
const pptxMime = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

test("real PPTX is released once, deduplicated, reused across courses and downloaded byte-for-byte", async (t) => {
  if (!fixturePath) { t.skip("PPTX_FIXTURE_PATH is not configured"); return; }
  try { await access(fixturePath); } catch { t.skip("PPTX_FIXTURE_PATH is unavailable"); return; }
  const fixture = await makeContentFixture({ maxBytes: 25 * 1024 * 1024 });
  try {
    const bytes = await readFile(fixturePath);
    assert.equal(bytes.byteLength, 2_572_119);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), fixtureSha);
    const service = new MaterialService(fixture.db, fixture.storage);
    const upload = await service.quarantineUpload(fixture.teacher, { originalName: "python_ch02_basics.pptx", mimeType: pptxMime, bytes, purpose: "material_library" });
    assert.equal(upload.status, "quarantined");
    const ready = await service.releaseUpload(fixture.teacher, upload.id);
    assert.equal(ready.status, "ready");
    const repeated = await service.quarantineUpload(fixture.teacher, { originalName: "renamed-copy.pptx", mimeType: pptxMime, bytes, purpose: "material_library" });
    assert.equal(repeated.id, upload.id);
    assert.equal(repeated.deduplicated, true);

    const secondCourse = fixture.education.createCourse(fixture.teacher, { titleZh: "Python 第二班", joinCode: "PYLIB2" });
    fixture.education.updateCourse(fixture.teacher, secondCourse.id, { status: "published" });
    const secondUnit = fixture.education.createUnit(fixture.teacher, secondCourse.id, { titleZh: "第二單元" });
    fixture.education.updateUnit(fixture.teacher, secondUnit.id, { status: "published" });
    const secondStudentRecord = fixture.education.createUser(fixture.admin, { role: "student", username: "fixture-student-two", chineseName: "測試學生二", studentNumber: "S0002" });
    const secondStudent = { id: secondStudentRecord.user.id, role: "student" };
    fixture.education.joinCourseByCode(secondStudent, "PYLIB2");

    const materialA = await service.createMaterial(fixture.teacher, fixture.unit.id, { kind: "slides", titleZh: "基礎投影片", fileAssetId: upload.id, allowDownload: true, position: 2 });
    const materialB = await service.createMaterial(fixture.teacher, secondUnit.id, { kind: "slides", titleZh: "重用投影片", fileAssetId: upload.id, allowDownload: true });
    assert.equal(service.listMaterials(fixture.student, fixture.unit.id).length, 0);
    await service.updateMaterial(fixture.teacher, materialA.id, { status: "published" });
    await service.updateMaterial(fixture.teacher, materialB.id, { status: "published" });
    const job = service.createConversionJob(fixture.teacher, materialA.id);
    assert.equal(job.status, "queued");
    const studentA = service.listMaterials(fixture.student, fixture.unit.id)[0];
    const studentB = service.listMaterials(secondStudent, secondUnit.id)[0];
    assert.equal(studentA.file_name, "python_ch02_basics.pptx");
    assert.equal(studentA.conversion_status, "queued");
    assert.equal(studentB.file_asset_id, upload.id);
    const [downloadA, downloadB] = await Promise.all([service.downloadMaterial(fixture.student, materialA.id), service.downloadMaterial(secondStudent, materialB.id)]);
    assert.equal(createHash("sha256").update(downloadA.bytes).digest("hex"), fixtureSha);
    assert.equal(createHash("sha256").update(downloadB.bytes).digest("hex"), fixtureSha);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM file_assets WHERE sha256 = ?", [fixtureSha]).count, 1);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM materials WHERE file_asset_id = ?", [upload.id]).count, 2);
    assert.equal(JSON.stringify(studentA).includes("storage_key"), false);
  } finally { await fixture.close(); }
});

test("private library assets remain owner-only until deliberately shared with school teachers", async () => {
  const fixture = await makeContentFixture();
  try {
    const service = new MaterialService(fixture.db, fixture.storage);
    const teacherTwoRecord = fixture.education.createUser(fixture.admin, { role: "teacher", username: "fixture-teacher-two", chineseName: "測試教師二" });
    const teacherTwo = { id: teacherTwoRecord.user.id, role: "teacher" };
    const course = fixture.education.createCourse(teacherTwo, { titleZh: "教師二課程" });
    const unit = fixture.education.createUnit(teacherTwo, course.id, { titleZh: "單元" });
    const upload = await service.quarantineUpload(fixture.teacher, { originalName: "lesson.pptx", mimeType: pptxMime, bytes: minimalPptx(), purpose: "material_library", libraryScope: "private" });
    await service.releaseUpload(fixture.teacher, upload.id);
    assert.equal(service.listAvailableLibraryAssets(teacherTwo).length, 0);
    await assert.rejects(() => service.createMaterial(teacherTwo, unit.id, { kind: "slides", titleZh: "不可用", fileAssetId: upload.id }), (error) => error instanceof DomainError && error.code === "forbidden");
    assert.throws(() => service.updateLibraryScope(teacherTwo, upload.id, "school"), (error) => error instanceof DomainError && error.code === "forbidden");
    service.updateLibraryScope(fixture.teacher, upload.id, "school");
    assert.equal(service.listAvailableLibraryAssets(teacherTwo).length, 1);
    const material = await service.createMaterial(teacherTwo, unit.id, { kind: "slides", titleZh: "全校共享", fileAssetId: upload.id });
    assert.equal(material.file_asset_id, upload.id);
    assert.throws(() => service.listAvailableLibraryAssets(fixture.student), (error) => error instanceof DomainError && error.code === "forbidden");
  } finally { await fixture.close(); }
});

test("published references pin immutable versions until a teacher explicitly upgrades", async () => {
  const fixture = await makeContentFixture({ maxBytes: 4096 });
  try {
    const service = new MaterialService(fixture.db, fixture.storage);
    const v1Bytes = minimalPptx();
    const v2Bytes = storedZip({ "[Content_Types].xml": "<Types version='2'/>", "_rels/.rels": "<Relationships/>", "ppt/presentation.xml": "<p:presentation version='2'/>", "ppt/slides/slide1.xml": "<slide/>" });
    const v1 = await service.quarantineUpload(fixture.teacher, { originalName: "lesson-v1.pptx", mimeType: pptxMime, bytes: v1Bytes, purpose: "material_library" });
    assert.equal(v1.libraryScope, "school");
    await service.releaseUpload(fixture.teacher, v1.id);
    const material = await service.createMaterial(fixture.teacher, fixture.unit.id, { kind: "slides", titleZh: "固定版本教材", fileAssetId: v1.id, bindingMode: "reference" });
    await service.updateMaterial(fixture.teacher, material.id, { status: "published" });

    const v2 = await service.quarantineUpload(fixture.teacher, { originalName: "lesson-v2.pptx", mimeType: pptxMime, bytes: v2Bytes, purpose: "material_library", previousAssetId: v1.id });
    assert.equal(v2.versionNumber, 2);
    assert.equal(v2.rootAssetId, v1.id);
    await service.releaseUpload(fixture.teacher, v2.id);
    const pinned = service.listMaterials(fixture.teacher, fixture.unit.id).find((item) => item.id === material.id);
    assert.equal(pinned.file_asset_id, v1.id);
    assert.equal(pinned.file_version_number, 1);
    assert.equal(pinned.update_available, 1);
    assert.deepEqual((await service.downloadMaterial(fixture.student, material.id)).bytes, v1Bytes);

    const teacherTwoRecord = fixture.education.createUser(fixture.admin, { role: "teacher", username: "fixture-version-teacher", chineseName: "版本教師" });
    const teacherTwo = { id: teacherTwoRecord.user.id, role: "teacher" };
    await assert.rejects(() => service.quarantineUpload(teacherTwo, { originalName: "hijack.pptx", mimeType: pptxMime, bytes: v2Bytes, purpose: "material_library", previousAssetId: v1.id }), (error) => error instanceof DomainError && error.code === "forbidden");

    service.upgradeMaterialAsset(fixture.teacher, material.id);
    const upgraded = service.listMaterials(fixture.teacher, fixture.unit.id).find((item) => item.id === material.id);
    assert.equal(upgraded.file_asset_id, v2.id);
    assert.equal(upgraded.file_version_number, 2);
    assert.equal(upgraded.update_available, 0);
    assert.deepEqual((await service.downloadMaterial(fixture.student, material.id)).bytes, v2Bytes);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM file_assets WHERE id IN (?, ?)", [v1.id, v2.id]).count, 2);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM material_asset_versions WHERE root_asset_id = ?", [v1.id]).count, 2);
  } finally { await fixture.close(); }
});

test("release rejects forged office, PDF and ZIP payloads while preserving quarantine", async () => {
  const fixture = await makeContentFixture();
  try {
    const service = new MaterialService(fixture.db, fixture.storage);
    const cases = [
      { name: "fake.pptx", mime: pptxMime, bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04]) },
      { name: "fake.pdf", mime: "application/pdf", bytes: new TextEncoder().encode("%PDF-not-finished") },
      { name: "fake.zip", mime: "application/zip", bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04]) },
      { name: "fake.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: storedZip({ "[Content_Types].xml": "x", "_rels/.rels": "x" }) },
    ];
    for (const item of cases) {
      const upload = await service.quarantineUpload(fixture.teacher, { originalName: item.name, mimeType: item.mime, bytes: item.bytes, purpose: "material_library" });
      await assert.rejects(() => service.releaseUpload(fixture.teacher, upload.id), (error) => error instanceof DomainError && error.code === "invalid_file_signature");
      assert.equal(fixture.db.get("SELECT status FROM file_assets WHERE id = ?", [upload.id]).status, "quarantined");
    }
  } finally { await fixture.close(); }
});

test("student download remains blocked for draft, quarantined and no-download materials", async () => {
  const fixture = await makeContentFixture();
  try {
    const service = new MaterialService(fixture.db, fixture.storage);
    const quarantined = await service.quarantineUpload(fixture.teacher, { originalName: "queued.pptx", mimeType: pptxMime, bytes: minimalPptx(), purpose: "material_library" });
    await assert.rejects(() => service.createMaterial(fixture.teacher, fixture.unit.id, { kind: "slides", titleZh: "隔離中", fileAssetId: quarantined.id }), (error) => error instanceof DomainError && error.code === "file_not_ready");
    const ready = await service.releaseUpload(fixture.teacher, quarantined.id);
    const material = await service.createMaterial(fixture.teacher, fixture.unit.id, { kind: "slides", titleZh: "不可下載", fileAssetId: ready.id, allowDownload: false });
    await assert.rejects(() => service.downloadMaterial(fixture.student, material.id), (error) => error instanceof DomainError && error.code === "download_unavailable");
    await service.updateMaterial(fixture.teacher, material.id, { status: "published" });
    await assert.rejects(() => service.downloadMaterial(fixture.student, material.id), (error) => error instanceof DomainError && error.code === "download_unavailable");
  } finally { await fixture.close(); }
});
