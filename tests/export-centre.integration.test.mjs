import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ExportService } = await import("../server/exports.ts");
const { createBackendApp } = await import("../server/http/backend.ts");
const { allowedMethodsForPath, routeContractForPath } = await import("../server/http/route-manifest.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("export service enforces current scope, state transitions, expiry, and bounded storage", async () => {
  const fixture = await makeContentFixture();
  const root = await mkdtemp(join(tmpdir(), "learning-export-centre-"));
  const clock = () => new Date("2026-09-20T12:00:00.000Z");
  try {
    const exports = new ExportService(fixture.db, root, clock);
    assert.throws(() => exports.listJobs(fixture.student), { code: "forbidden", status: 403 });
    assert.throws(() => exports.createJob(fixture.student, { reportType: "overview", format: "csv", filters: { courseId: fixture.course.id } }), { code: "forbidden", status: 403 });

    const queued = exports.createJob(fixture.teacher, { reportType: "overview", format: "csv", filters: { courseId: fixture.course.id } });
    assert.equal(queued.status, "queued");
    assert.equal(exports.listJobs(fixture.teacher).length, 1);
    const completed = await exports.runJob(fixture.teacher, queued.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.attempt_count, 1);
    assert.equal((await exports.runJob(fixture.teacher, queued.id)).status, "completed");
    assert.throws(() => exports.retryJob(fixture.teacher, queued.id), { code: "invalid_export_state" });

    const failed = exports.createJob(fixture.teacher, { reportType: "overview", format: "csv", filters: { courseId: fixture.course.id } });
    fixture.db.run("UPDATE export_jobs SET data_snapshot_json = ? WHERE id = ?", ["not-json", failed.id]);
    await assert.rejects(() => exports.runJob(fixture.teacher, failed.id));
    assert.equal(fixture.db.get("SELECT status FROM export_jobs WHERE id = ?", [failed.id]).status, "failed");
    fixture.db.run("UPDATE export_jobs SET data_snapshot_json = ? WHERE id = ?", ["{}", failed.id]);
    assert.equal(exports.retryJob(fixture.teacher, failed.id).status, "queued");
    assert.equal((await exports.runJob(fixture.teacher, failed.id)).status, "completed");

    const running = exports.createJob(fixture.teacher, { reportType: "overview", format: "csv", filters: { courseId: fixture.course.id } });
    fixture.db.run("UPDATE export_jobs SET status = 'running' WHERE id = ?", [running.id]);
    await assert.rejects(() => exports.runJob(fixture.teacher, running.id), { code: "invalid_export_state" });
    const cancelled = exports.createJob(fixture.teacher, { reportType: "overview", format: "csv", filters: { courseId: fixture.course.id } });
    fixture.db.run("UPDATE export_jobs SET status = 'cancelled' WHERE id = ?", [cancelled.id]);
    assert.throws(() => exports.retryJob(fixture.teacher, cancelled.id), { code: "invalid_export_state" });

    const expiredDownload = exports.createJob(fixture.teacher, { reportType: "overview", format: "csv", filters: { courseId: fixture.course.id } });
    await exports.runJob(fixture.teacher, expiredDownload.id);
    fixture.db.run("UPDATE export_jobs SET expires_at = ? WHERE id = ?", ["2026-09-19T12:00:00.000Z", expiredDownload.id]);
    await assert.rejects(() => exports.download(fixture.teacher, expiredDownload.id), { code: "export_expired", status: 410 });
    const expiredRun = exports.createJob(fixture.teacher, { reportType: "overview", format: "csv", filters: { courseId: fixture.course.id } });
    fixture.db.run("UPDATE export_jobs SET expires_at = ? WHERE id = ?", ["2026-09-19T12:00:00.000Z", expiredRun.id]);
    await assert.rejects(() => exports.runJob(fixture.teacher, expiredRun.id), { code: "export_expired", status: 410 });
    const expiredRetry = exports.createJob(fixture.teacher, { reportType: "overview", format: "csv", filters: { courseId: fixture.course.id } });
    fixture.db.run("UPDATE export_jobs SET status = 'failed', expires_at = ? WHERE id = ?", ["2026-09-19T12:00:00.000Z", expiredRetry.id]);
    assert.throws(() => exports.retryJob(fixture.teacher, expiredRetry.id), { code: "export_expired", status: 410 });

    const unsafe = exports.createJob(fixture.teacher, { reportType: "overview", format: "csv", filters: { courseId: fixture.course.id } });
    fixture.db.run("UPDATE export_jobs SET status = 'completed', storage_key = ?, sha256 = ? WHERE id = ?", ["../outside", "bad", unsafe.id]);
    await assert.rejects(() => exports.download(fixture.teacher, unsafe.id), { code: "invalid_storage_key" });

    const otherTeacher = fixture.education.createUser(fixture.admin, { role: "teacher", username: "scope-other-teacher", chineseName: "範圍外教師" });
    const other = { id: otherTeacher.user.id, role: "teacher" };
    assert.equal(exports.listJobs(other).length, 0);
    await assert.rejects(() => exports.runJob(other, queued.id), { code: "not_found", status: 404 });
    await assert.rejects(() => exports.download(other, queued.id), { code: "not_found", status: 404 });
    fixture.db.run("UPDATE courses SET owner_teacher_id = ? WHERE id = ?", [other.id, fixture.course.id]);
    fixture.db.run("UPDATE class_memberships SET status = 'archived' WHERE user_id = ?", [fixture.teacher.id]);
    assert.equal(exports.listJobs(fixture.teacher).length, 0);
    await assert.rejects(() => exports.runJob(fixture.teacher, queued.id), { code: "not_found", status: 404 });
    assert.throws(() => exports.retryJob(fixture.teacher, failed.id), { code: "not_found", status: 404 });
    await assert.rejects(() => exports.download(fixture.teacher, completed.id), { code: "not_found", status: 404 });
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("export retry HTTP contract is declared, method-safe, and student-proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "learning-export-http-"));
  const token = "export-http-test-token-1234567890";
  const app = createBackendApp({ internalToken: token, csrfRequired: true, exportRoot: root, storageRoot: join(root, "files"), backupRoot: join(root, "backups") });
  function request(path, options = {}, cookie = "") {
    const headers = new Headers(options.headers);
    headers.set("x-backend-token", token);
    if (cookie) headers.set("cookie", cookie);
    if (options.method && options.method !== "GET") headers.set("origin", "http://localhost");
    return new Request("http://localhost/api/v1" + path, { ...options, headers });
  }
  async function readyCookie(username, initialPassword, newPassword) {
    const first = await app.handle(request("/auth/login", { method: "POST", body: JSON.stringify({ username, password: initialPassword }) }));
    const firstCookie = first.headers.get("set-cookie").split(";", 1)[0];
    await app.handle(request("/auth/password", { method: "POST", body: JSON.stringify({ newPassword }) }, firstCookie));
    const login = await app.handle(request("/auth/login", { method: "POST", body: JSON.stringify({ username, password: newPassword }) }));
    return login.headers.get("set-cookie").split(";", 1)[0];
  }
  try {
    const adminRecord = app.services.education.createInitialAdmin({ username: "export-http-admin", chineseName: "管理員" });
    const admin = { id: adminRecord.user.id, role: "admin" };
    const teacherRecord = app.services.education.createUser(admin, { role: "teacher", username: "export-http-teacher", chineseName: "教師" });
    const teacher = { id: teacherRecord.user.id, role: "teacher" };
    const course = app.services.education.createCourse(teacher, { titleZh: "HTTP Export 課程" });
    const cookie = await readyCookie("export-http-teacher", teacherRecord.initialPassword, "Export-Http-Teacher-1!");
    const created = await app.handle(request("/exports", { method: "POST", body: JSON.stringify({ reportType: "overview", format: "csv", filters: { courseId: course.id } }) }, cookie));
    assert.equal(created.status, 201);
    const job = (await created.json()).job;
    app.services.db.run("UPDATE export_jobs SET data_snapshot_json = ? WHERE id = ?", ["not-json", job.id]);
    assert.equal((await app.handle(request(`/exports/${job.id}/run`, { method: "POST", body: "{}" }, cookie))).status, 500);
    const retry = await app.handle(request(`/exports/${job.id}/retry`, { method: "POST", body: "{}" }, cookie));
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).job.status, "queued");
    const invalidRetry = await app.handle(request(`/exports/${job.id}/retry`, { method: "POST", body: "{}" }, cookie));
    assert.equal(invalidRetry.status, 400);
    assert.equal((await invalidRetry.json()).error.code, "invalid_export_state");
    const wrongMethod = await app.handle(request(`/exports/${job.id}/retry`, { method: "OPTIONS" }, cookie));
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
    assert.deepEqual(routeContractForPath("/exports/export-1/retry").methods, ["POST"]);
    assert.deepEqual(allowedMethodsForPath("/exports/export-1/retry"), ["POST"]);
  } finally {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});
