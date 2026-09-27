import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { openLocalDatabase } = await import("../server/db.ts");
const { EducationService } = await import("../server/education.ts");
const { LocalFileStorage } = await import("../server/storage.ts");
const { MaterialService } = await import("../server/content.ts");

const workspace = resolve(process.cwd());
const fixturePath = process.env.PPTX_FIXTURE_PATH;
const sourceProject = process.env.SOURCE_COMPOSE_PROJECT ?? "phase11-deploy-20260921";
const converterContainer = `${sourceProject}-converter-1`;
const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const workerContainer = `phase11-pptx-${stamp}`;
const evidencePath = resolve(workspace, "docs/移植交接/c2c_7b4e_pptx_conversion_smoke.txt");

function docker(args, options = {}) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function bindPath(value) { return value.replaceAll("\\", "/"); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function wait(ms) { return new Promise((resolveWait) => setTimeout(resolveWait, ms)); }
function parseJsonOutput(value) {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* Find JSON after runtime warnings. */ }
  }
  throw new Error("Expected JSON output from converter verification helper");
}

function evidence(report) {
  return [
    "Phase 11 real PPTX converter-container smoke",
    `status=${report.status}`,
    `fixture_available=${report.fixtureAvailable === true}`,
    `source_sha256=${report.sourceSha256 ?? "not-recorded"}`,
    `converter_image=${report.converterImage ?? "not-recorded"}`,
    `conversion_status=${report.conversionStatus ?? "not-run"}`,
    `page_count=${report.pageCount ?? "not-recorded"}`,
    `pdf_magic=${report.pdfMagic ?? "not-recorded"}`,
    `first_slide_png=${report.firstSlidePng === true}`,
    `student_preview_authorized=${report.studentPreviewAuthorized === true}`,
    `outsider_denied=${report.outsiderDenied === true}`,
    `source_unchanged=${report.sourceUnchanged === true}`,
    `worker_cleanup=${report.workerCleanup === true}`,
    "secrets_logged=false",
    report.error ? `error=${report.error}` : "error=none",
    "",
  ].join("\n");
}

const report = { status: "BLOCKED", fixtureAvailable: false, workerCleanup: false };
let root;
let worker;
let dbVolume;
let storageVolume;

try {
  if (!fixturePath) throw new Error("PPTX_FIXTURE_PATH is required");
  await access(fixturePath);
  report.fixtureAvailable = true;
  const source = await readFile(fixturePath);
  report.sourceSha256 = sha256(source);

  root = await mkdtemp(join(tmpdir(), "phase11-pptx-conversion-"));
  const databaseDirectory = join(root, "db");
  const storageDirectory = join(root, "storage");
  await mkdir(databaseDirectory, { recursive: true });
  await mkdir(storageDirectory, { recursive: true });
  const databasePath = join(databaseDirectory, "learning.sqlite");
  const db = openLocalDatabase(databasePath);
  let teacher;
  let student;
  let materialId;
  try {
    const education = new EducationService(db);
    const adminResult = education.createInitialAdmin({ username: "pptx-admin", chineseName: "PPTX 管理員" });
    const admin = { id: adminResult.user.id, role: "admin" };
    const teacherResult = education.createUser(admin, { role: "teacher", username: "pptx-teacher", chineseName: "PPTX 教師" });
    const studentResult = education.createUser(admin, { role: "student", username: "pptx-student", chineseName: "PPTX 學生", studentNumber: "PPTX1" });
    teacher = { id: teacherResult.user.id, role: "teacher" };
    student = { id: studentResult.user.id, role: "student" };
    const classRow = education.createClass(admin, { name: "PPTX 測試班", academicYear: "2026", teacherId: teacher.id });
    education.addClassMember(admin, classRow.id, student.id);
    const course = education.createCourse(teacher, { titleZh: "PPTX 轉換測試", joinCode: "PPTX01" });
    education.updateCourse(teacher, course.id, { status: "published" });
    education.assignClassToCourse(teacher, course.id, classRow.id);
    const unit = education.createUnit(teacher, course.id, { titleZh: "投影片單元" });
    education.updateUnit(teacher, unit.id, { status: "published" });
    const storage = new LocalFileStorage(storageDirectory, 25 * 1024 * 1024);
    const materials = new MaterialService(db, storage);
    const uploaded = await materials.quarantineUpload(teacher, {
      originalName: "python-basics.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      bytes: source,
      purpose: "material_library",
    });
    await materials.releaseUpload(teacher, uploaded.id);
    const material = await materials.createMaterial(teacher, unit.id, { kind: "slides", titleZh: "Python 基礎", fileAssetId: uploaded.id });
    await materials.updateMaterial(teacher, material.id, { status: "published" });
    materials.createConversionJob(teacher, material.id);
    materialId = material.id;
  } finally {
    db.close();
  }

  report.converterImage = process.env.CONVERTER_IMAGE ?? docker(["inspect", "--format", "{{.Config.Image}}", converterContainer]);
  dbVolume = `${workerContainer}-db`;
  storageVolume = `${workerContainer}-storage`;
  docker(["volume", "create", dbVolume]);
  docker(["volume", "create", storageVolume]);
  docker([
    "run", "--rm", "--network", "none", "--user", "0:0",
    "-v", `${dbVolume}:/data/db`,
    "-v", `${bindPath(databaseDirectory)}:/seed/db:ro`,
    "-v", `${storageVolume}:/data/storage`,
    "-v", `${bindPath(storageDirectory)}:/seed/storage:ro`,
    report.converterImage,
    "node", "-e", "require('node:fs').cpSync('/seed/db', '/data/db', { recursive: true, force: true }); require('node:fs').cpSync('/seed/storage', '/data/storage', { recursive: true, force: true });",
  ]);
  worker = spawn("docker", [
    "run", "--rm", "--name", workerContainer, "--network", "none", "--user", "0:0",
    "-e", "DATABASE_PATH=/data/db/learning.sqlite",
    "-e", "STORAGE_ROOT=/data/storage",
    "-e", "CONVERTER_TIMEOUT_MS=150000",
    "-e", "CONVERTER_MAX_PAGES=100",
    "-e", "CONVERTER_MAX_OUTPUT_BYTES=26214400",
    "-e", "CONVERTER_RENDER_DPI=96",
    "-v", `${dbVolume}:/data/db`,
    "-v", `${storageVolume}:/data/storage`,
    report.converterImage,
  ], { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
  let workerStderr = "";
  worker.stderr.on("data", (chunk) => { workerStderr = `${workerStderr}${chunk.toString()}`.slice(-2048); });
  let workerExit = null;
  worker.once("exit", (code, signal) => { workerExit = { code, signal }; });

  let conversion;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      conversion = parseJsonOutput(docker(["exec", "-e", `MATERIAL_ID=${materialId}`, workerContainer, "node", "--experimental-strip-types", "--input-type=module", "-e", "import { openLocalDatabase } from './server/db.ts'; const db=openLocalDatabase(process.env.DATABASE_PATH); console.log(JSON.stringify(db.get('SELECT status, page_count, output_asset_id, error_message FROM material_conversion_jobs WHERE material_id = ?', [process.env.MATERIAL_ID]))); db.close();"]));
    } catch {
      if (workerExit) throw new Error(`converter worker exited before completion (${workerExit.code ?? workerExit.signal ?? "unknown"}) ${workerStderr.replace(/[\r\n]+/g, " ").slice(-180)}`);
    }
    if (conversion?.status === "succeeded" || conversion?.status === "failed") break;
    await wait(1000);
  }
  assert.equal(conversion?.status, "succeeded", conversion?.error_message ?? "converter did not finish");
  report.conversionStatus = conversion.status;
  report.pageCount = conversion.page_count;
  assert.ok(conversion.output_asset_id);

  const verification = parseJsonOutput(docker([
    "run", "--rm", "--network", "none", "--user", "0:0", "--volumes-from", workerContainer,
    "-e", "DATABASE_PATH=/data/db/learning.sqlite",
    "-e", "STORAGE_ROOT=/data/storage",
    "-e", `MATERIAL_ID=${materialId}`,
    "-e", `STUDENT_ID=${student.id}`,
    report.converterImage,
    "node", "--experimental-strip-types", "--input-type=module", "-e", "import { openLocalDatabase } from './server/db.ts'; import { LocalFileStorage } from './server/storage.ts'; import { MaterialService } from './server/content.ts'; const db=openLocalDatabase(process.env.DATABASE_PATH); try { const materials=new MaterialService(db,new LocalFileStorage(process.env.STORAGE_ROOT,26214400)); const student={id:process.env.STUDENT_ID,role:'student'}; const manifest=materials.previewManifest(student,process.env.MATERIAL_ID); let outsiderDenied=false; try { materials.previewManifest({id:'outsider',role:'student'},process.env.MATERIAL_ID); } catch (error) { outsiderDenied=error?.code==='not_found'; } const pdf=await materials.downloadPreviewPdf(student,process.env.MATERIAL_ID); const slide=await materials.downloadPreviewSlide(student,process.env.MATERIAL_ID,1); console.log(JSON.stringify({pageCount:manifest.pageCount,pdfMagic:pdf.bytes.subarray(0,5).toString(),firstSlidePng:slide.bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),outsiderDenied})); } finally { db.close(); }",
  ]));
  assert.equal(verification.pageCount, conversion.page_count);
  report.pageCount = verification.pageCount;
  report.pdfMagic = verification.pdfMagic;
  report.firstSlidePng = verification.firstSlidePng === true;
  report.studentPreviewAuthorized = true;
  report.outsiderDenied = verification.outsiderDenied === true;
  assert.equal(report.pdfMagic, "%PDF-");
  assert.equal(report.firstSlidePng, true);
  assert.equal(report.outsiderDenied, true);
  assert.equal(sha256(await readFile(fixturePath)), report.sourceSha256);
  report.sourceUnchanged = true;
  report.status = "PASS";
} catch (error) {
  report.status = error?.code === "ENOENT" || error?.code === "docker_command_failed" ? "BLOCKED" : "FAIL";
  report.error = error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 260) : "unknown failure";
} finally {
  if (worker && worker.exitCode === null) {
    try { docker(["stop", "--time", "10", workerContainer], { timeout: 30000 }); } catch { /* Cleanup is verified below. */ }
  }
  try {
    report.workerCleanup = docker(["ps", "-a", "--filter", `name=${workerContainer}`, "-q"]) === "";
  } catch { report.workerCleanup = false; }
  for (const volume of [dbVolume, storageVolume]) {
    if (!volume) continue;
    try { docker(["volume", "rm", volume]); } catch { report.workerCleanup = false; }
  }
  if (root) await rm(root, { recursive: true, force: true });
  await import("node:fs/promises").then(({ writeFile }) => writeFile(evidencePath, evidence(report), { mode: 0o600 }));
}

console.log(evidence(report));
if (report.status !== "PASS") process.exitCode = 1;
