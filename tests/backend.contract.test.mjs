import test from "node:test";
import assert from "node:assert/strict";
import { createBackendApp } from "../server/http/backend.ts";
import { minimalPptx, storedZip } from "./zip-fixtures.mjs";

function request(path, options = {}, cookie = "") {
  const headers = new Headers(options.headers);
  headers.set("x-backend-token", "internal-test-token-1234567890");
  if (cookie) headers.set("cookie", cookie);
  if (options.method && options.method !== "GET") headers.set("origin", "http://localhost");
  return new Request("http://localhost/api/v1" + path, { ...options, headers });
}
async function json(response) { return await response.json(); }

test("backend enforces internal token, same-origin mutation and session role", async () => {
  const app = createBackendApp({ internalToken: "internal-test-token-1234567890", csrfRequired: true, production: true });
  const admin = app.services.education.createInitialAdmin({ username: "admin", chineseName: "管理員" });
  const missingToken = await app.handle(new Request("http://localhost/api/v1/me"));
  assert.equal(missingToken.status, 401);
  assert.ok(missingToken.headers.get("x-request-id"));
  const csrf = await app.handle(new Request("http://localhost/api/v1/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: admin.initialPassword }), headers: { "content-type": "application/json", "x-backend-token": "internal-test-token-1234567890", origin: "https://evil.example" } }));
  assert.equal(csrf.status, 403);
  assert.ok(csrf.headers.get("x-request-id"));
  const firstLogin = await app.handle(request("/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: admin.initialPassword }), headers: { "content-type": "application/json" } }));
  const firstCookie = firstLogin.headers.get("set-cookie").split(";", 1)[0];
  assert.equal((await app.handle(request("/admin/status", {}, firstCookie))).status, 428);
  await app.handle(request("/auth/password", { method: "POST", body: JSON.stringify({ newPassword: "Admin-Strong-Password-1!" }), headers: { "content-type": "application/json" } }, firstCookie));
  const login = await app.handle(request("/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "Admin-Strong-Password-1!" }), headers: { "content-type": "application/json" } }));
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.match(login.headers.get("set-cookie") ?? "", /Secure/);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const me = await app.handle(request("/me", {}, cookie));
  assert.equal(me.status, 200);
  assert.equal((await json(me)).user.role, "admin");
  const createdStudent = await app.handle(request("/admin/users", { method: "POST", body: JSON.stringify({ role: "student", username: "student", chineseName: "學生" }), headers: { "content-type": "application/json" } }, cookie));
  assert.equal(createdStudent.status, 201);
  const studentRecord = await json(createdStudent);
  const studentLogin = await app.handle(request("/auth/login", { method: "POST", body: JSON.stringify({ username: "student", password: studentRecord.initialPassword }), headers: { "content-type": "application/json" } }));
  const studentCookie = studentLogin.headers.get("set-cookie").split(";", 1)[0];
  await app.handle(request("/auth/password", { method: "POST", body: JSON.stringify({ newPassword: "Student-Strong-Password-1!" }), headers: { "content-type": "application/json" } }, studentCookie));
  const changedStudentLogin = await app.handle(request("/auth/login", { method: "POST", body: JSON.stringify({ username: "student", password: "Student-Strong-Password-1!" }), headers: { "content-type": "application/json" } }));
  const readyStudentCookie = changedStudentLogin.headers.get("set-cookie").split(";", 1)[0];
  const forgedRole = await app.handle(request("/admin/status", {}, readyStudentCookie));
  assert.equal(forgedRole.status, 403);
  const status = await app.handle(request("/admin/status", {}, cookie));
  assert.equal(status.status, 200);
  assert.doesNotMatch(JSON.stringify(await json(status)), /internal-test-token|\/.*sqlite/);
  const listed = await app.handle(request("/users?role=student", {}, cookie));
  assert.equal(listed.status, 200);
  assert.equal((await json(listed)).users.length, 1);
  const reset = await app.handle(request(`/users/${studentRecord.user.id}/reset-password`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }, cookie));
  assert.equal(reset.status, 200);
  assert.equal(typeof (await json(reset)).initialPassword, "string");
  assert.equal((await app.handle(request("/courses", {}, readyStudentCookie))).status, 401);
  app.close();
});

test("session cookie Secure policy keeps production safe and permits explicit local HTTP override", async () => {
  const productionApp = createBackendApp({ internalToken: "internal-test-token-1234567890", production: true, sessionCookieSecure: true });
  const productionAdmin = productionApp.services.education.createInitialAdmin({ username: "cookie-production", chineseName: "管理員" });
  const productionLogin = await productionApp.handle(request("/auth/login", { method: "POST", body: JSON.stringify({ username: "cookie-production", password: productionAdmin.initialPassword }), headers: { "content-type": "application/json" } }));
  const productionCookie = productionLogin.headers.get("set-cookie") ?? "";
  assert.match(productionCookie, /HttpOnly/);
  assert.match(productionCookie, /SameSite=Lax/);
  assert.match(productionCookie, /Path=\//);
  assert.match(productionCookie, /Secure/);
  productionApp.close();

  const localApp = createBackendApp({ internalToken: "internal-test-token-1234567890", production: true, sessionCookieSecure: false });
  const localAdmin = localApp.services.education.createInitialAdmin({ username: "cookie-local", chineseName: "管理員" });
  const localLogin = await localApp.handle(request("/auth/login", { method: "POST", body: JSON.stringify({ username: "cookie-local", password: localAdmin.initialPassword }), headers: { "content-type": "application/json" } }));
  const localCookie = localLogin.headers.get("set-cookie") ?? "";
  assert.match(localCookie, /HttpOnly/);
  assert.match(localCookie, /SameSite=Lax/);
  assert.match(localCookie, /Path=\//);
  assert.doesNotMatch(localCookie, /Secure/);
  localApp.close();
});

test("invalid session cookie Secure policy fails closed", () => {
  const previous = process.env.SESSION_COOKIE_SECURE;
  process.env.SESSION_COOKIE_SECURE = "invalid";
  try {
    assert.throws(() => createBackendApp({ internalToken: "internal-test-token-1234567890", production: false }), /SESSION_COOKIE_SECURE/);
  } finally {
    if (previous === undefined) delete process.env.SESSION_COOKIE_SECURE;
    else process.env.SESSION_COOKIE_SECURE = previous;
  }
});

test("protected route matrix fails closed without a session and never exposes secrets", async () => {
  const app = createBackendApp({ internalToken: "internal-test-token-1234567890", csrfRequired: true });
  app.services.education.createInitialAdmin({ username: "admin", chineseName: "管理員" });
  for (const path of ["/courses", "/notifications", "/analytics/overview", "/admin/status", "/admin/audit", "/admin/backups"]) {
    const response = await app.handle(request(path));
    assert.equal(response.status, 401, path);
    const body = JSON.stringify(await json(response));
    assert.doesNotMatch(body, /password|token|sqlite|\/Users|\/tmp/i);
    assert.ok(response.headers.get("x-request-id"));
  }
  const wrongToken = await app.handle(new Request("http://localhost/api/v1/courses", { headers: { "x-backend-token": "wrong-token" } }));
  assert.equal(wrongToken.status, 401);
  assert.ok(wrongToken.headers.get("x-request-id"));
  app.close();
});

test("production backend fails closed when its internal token is missing or too short", () => {
  assert.throws(() => createBackendApp({ production: true, internalToken: "" }), /BACKEND_INTERNAL_TOKEN/);
  assert.throws(() => createBackendApp({ production: true, internalToken: "too-short" }), /BACKEND_INTERNAL_TOKEN/);
});

test("material library HTTP routes validate base64 and keep student and storage boundaries closed", async () => {
  const app = createBackendApp({ internalToken: "internal-test-token-1234567890", csrfRequired: true });
  try {
    const adminCreated = app.services.education.createInitialAdmin({ username: "library-admin", chineseName: "管理員" });
    const adminLogin = await app.handle(request("/auth/login", { method: "POST", body: JSON.stringify({ username: "library-admin", password: adminCreated.initialPassword }), headers: { "content-type": "application/json" } }));
    const adminCookie = adminLogin.headers.get("set-cookie").split(";", 1)[0];
    await app.handle(request("/auth/password", { method: "POST", body: JSON.stringify({ newPassword: "Library-Admin-Strong-1!" }), headers: { "content-type": "application/json" } }, adminCookie));
    const admin = { id: adminCreated.user.id, role: "admin" };
    const teacher = app.services.education.createUser(admin, { role: "teacher", username: "library-teacher", chineseName: "教師" });
    const student = app.services.education.createUser(admin, { role: "student", username: "library-student", chineseName: "學生", studentNumber: "LIB1" });
    async function readyCookie(username, initialPassword, newPassword) {
      const first = await app.handle(request("/auth/login", { method: "POST", body: JSON.stringify({ username, password: initialPassword }), headers: { "content-type": "application/json" } }));
      const cookie = first.headers.get("set-cookie").split(";", 1)[0];
      await app.handle(request("/auth/password", { method: "POST", body: JSON.stringify({ newPassword }), headers: { "content-type": "application/json" } }, cookie));
      return cookie;
    }
    const teacherCookie = await readyCookie("library-teacher", teacher.initialPassword, "Library-Teacher-Strong-1!");
    const studentCookie = await readyCookie("library-student", student.initialPassword, "Library-Student-Strong-1!");
    const invalid = await app.handle(request("/files", { method: "POST", body: JSON.stringify({ originalName: "x.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", contentBase64: "not-base64", purpose: "material_library" }), headers: { "content-type": "application/json" } }, teacherCookie));
    assert.equal(invalid.status, 400);
    assert.equal((await json(invalid)).error.code, "invalid_base64");
    const uploadedResponse = await app.handle(request("/files", { method: "POST", body: JSON.stringify({ originalName: "lesson.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", contentBase64: minimalPptx().toString("base64"), purpose: "material_library" }), headers: { "content-type": "application/json" } }, teacherCookie));
    assert.equal(uploadedResponse.status, 201);
    const uploaded = await json(uploadedResponse);
    assert.equal("storage_key" in uploaded.asset, false);
    assert.equal((await app.handle(request(`/files/${uploaded.asset.id}/release`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }, teacherCookie))).status, 200);
    const courseResponse = await app.handle(request("/courses", { method: "POST", body: JSON.stringify({ titleZh: "教材轉換測試" }), headers: { "content-type": "application/json" } }, teacherCookie));
    assert.equal(courseResponse.status, 201);
    const course = await json(courseResponse);
    const unitResponse = await app.handle(request(`/courses/${course.course.id}/units`, { method: "POST", body: JSON.stringify({ titleZh: "投影片" }), headers: { "content-type": "application/json" } }, teacherCookie));
    assert.equal(unitResponse.status, 201);
    const unit = await json(unitResponse);
    const materialResponse = await app.handle(request(`/units/${unit.unit.id}/materials`, { method: "POST", body: JSON.stringify({ kind: "slides", titleZh: "第二章", fileAssetId: uploaded.asset.id }), headers: { "content-type": "application/json" } }, teacherCookie));
    assert.equal(materialResponse.status, 201);
    const material = await json(materialResponse);
    const queuedResponse = await app.handle(request(`/materials/${material.material.id}/conversion`, { method: "POST", body: JSON.stringify({ kind: "ppt_to_web" }), headers: { "content-type": "application/json" } }, teacherCookie));
    assert.equal(queuedResponse.status, 202);
    const queued = await json(queuedResponse);
    assert.equal(queued.job.status, "queued");
    const conversionResponse = await app.handle(request(`/materials/${material.material.id}/conversion`, {}, teacherCookie));
    assert.equal(conversionResponse.status, 200);
    const conversion = await json(conversionResponse);
    assert.deepEqual({ status: conversion.job.status, output: conversion.job.output_asset_id, started: conversion.job.started_at, finished: conversion.job.finished_at }, { status: "queued", output: null, started: null, finished: null });
    assert.equal("updated_at" in conversion.job, false);
    assert.equal("completed_at" in conversion.job, false);
    const available = await app.handle(request("/files?scope=available", {}, teacherCookie));
    assert.equal(available.status, 200);
    assert.equal((await json(available)).assets.length, 1);
    assert.doesNotMatch(JSON.stringify(await json(await app.handle(request("/files?scope=available", {}, teacherCookie)))), /storage_key|quarantine\//i);
    assert.equal((await app.handle(request("/files?scope=available", {}, studentCookie))).status, 403);
    assert.equal((await app.handle(request(`/files/${uploaded.asset.id}`, { method: "DELETE", body: "{}", headers: { "content-type": "application/json" } }, studentCookie))).status, 403);
    const referencedDelete = await app.handle(request(`/files/${uploaded.asset.id}`, { method: "DELETE", body: "{}", headers: { "content-type": "application/json" } }, teacherCookie));
    assert.equal(referencedDelete.status, 409);
    const disposableBytes = storedZip({ "[Content_Types].xml": "disposable", "_rels/.rels": "disposable", "ppt/presentation.xml": "disposable" });
    const disposableResponse = await app.handle(request("/files", { method: "POST", body: JSON.stringify({ originalName: "disposable.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", contentBase64: disposableBytes.toString("base64"), purpose: "material_library" }), headers: { "content-type": "application/json" } }, teacherCookie));
    const disposable = await json(disposableResponse);
    await app.handle(request(`/files/${disposable.asset.id}/release`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }, teacherCookie));
    const deleted = await app.handle(request(`/files/${disposable.asset.id}`, { method: "DELETE", body: "{}", headers: { "content-type": "application/json" } }, teacherCookie));
    assert.equal(deleted.status, 200);
    assert.equal((await json(deleted)).asset.status, "deleted");
  } finally { app.close(); }
});

test("unexpected upload service failures return a request id and emit only redacted structured diagnostics", async () => {
  const events = [];
  const app = createBackendApp({ internalToken: "internal-test-token-1234567890", csrfRequired: true, logger: (event) => events.push(event) });
  try {
    const created = app.services.education.createInitialAdmin({ username: "log-admin", chineseName: "管理員" });
    const login = await app.handle(request("/auth/login", { method: "POST", body: JSON.stringify({ username: "log-admin", password: created.initialPassword }), headers: { "content-type": "application/json" } }));
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    await app.handle(request("/auth/password", { method: "POST", body: JSON.stringify({ newPassword: "Log-Admin-Strong-Password-1!" }), headers: { "content-type": "application/json" } }, cookie));
    app.services.materials.quarantineUpload = async () => { const error = new Error("EACCES storage failed token=super-secret /data/storage/private/file.pptx"); error.code = "EACCES"; throw error; };
    const response = await app.handle(request("/files", { method: "POST", body: JSON.stringify({ originalName: "lesson.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", contentBase64: minimalPptx().toString("base64"), purpose: "material_library" }), headers: { "content-type": "application/json" } }, cookie));
    assert.equal(response.status, 500);
    assert.ok(response.headers.get("x-request-id"));
    assert.equal((await json(response)).error.code, "internal_error");
    assert.equal(events.length, 1);
    assert.equal(events[0].stage, "file_quarantine");
    assert.equal(events[0].actorId, created.user.id);
    const diagnostic = JSON.stringify(events[0]);
    assert.doesNotMatch(diagnostic, /super-secret|\/data\/storage|file\.pptx/);
    assert.match(diagnostic, /\[redacted\]|\[path\]/);
  } finally { app.close(); }
});
