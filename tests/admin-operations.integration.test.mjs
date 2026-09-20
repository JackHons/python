import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBackendApp } from "../server/http/backend.ts";

const TOKEN = "internal-test-token-1234567890";

function request(path, options = {}, cookie = "") {
  const headers = new Headers(options.headers);
  headers.set("x-backend-token", TOKEN);
  if (cookie) headers.set("cookie", cookie);
  if (options.method && options.method !== "GET") headers.set("origin", "http://localhost");
  return new Request("http://localhost/api/v1" + path, { ...options, headers });
}

async function json(response) { return response.json(); }

async function readyAdmin(app, username, initialPassword) {
  const first = await app.handle(request("/auth/login", { method: "POST", body: JSON.stringify({ username, password: initialPassword }), headers: { "content-type": "application/json" } }));
  assert.equal(first.status, 200);
  const firstCookie = first.headers.get("set-cookie").split(";", 1)[0];
  const changed = await app.handle(request("/auth/password", { method: "POST", body: JSON.stringify({ newPassword: "Admin-Strong-Password-1!" }), headers: { "content-type": "application/json" } }, firstCookie));
  assert.equal(changed.status, 200);
  const login = await app.handle(request("/auth/login", { method: "POST", body: JSON.stringify({ username, password: "Admin-Strong-Password-1!" }), headers: { "content-type": "application/json" } }));
  assert.equal(login.status, 200);
  return login.headers.get("set-cookie").split(";", 1)[0];
}

async function readyUser(app, username, initialPassword, password) {
  const first = await app.handle(request("/auth/login", { method: "POST", body: JSON.stringify({ username, password: initialPassword }), headers: { "content-type": "application/json" } }));
  assert.equal(first.status, 200);
  const firstCookie = first.headers.get("set-cookie").split(";", 1)[0];
  const changed = await app.handle(request("/auth/password", { method: "POST", body: JSON.stringify({ newPassword: password }), headers: { "content-type": "application/json" } }, firstCookie));
  assert.equal(changed.status, 200);
  const login = await app.handle(request("/auth/login", { method: "POST", body: JSON.stringify({ username, password }), headers: { "content-type": "application/json" } }));
  assert.equal(login.status, 200);
  return login.headers.get("set-cookie").split(";", 1)[0];
}

test("admin backup and audit operations expose bounded HTTP flows and dedicated UI contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "learning-admin-operations-"));
  const app = createBackendApp({ internalToken: TOKEN, csrfRequired: true, databasePath: join(root, "school.sqlite"), storageRoot: join(root, "storage"), backupRoot: join(root, "backups") });
  try {
    const created = app.services.education.createInitialAdmin({ username: "operations-admin", chineseName: "操作台管理員" });
    const cookie = await readyAdmin(app, "operations-admin", created.initialPassword);
    const teacher = app.services.education.createUser({ id: created.user.id, role: "admin" }, { role: "teacher", username: "operations-teacher", chineseName: "操作台教師" });
    const student = app.services.education.createUser({ id: created.user.id, role: "admin" }, { role: "student", username: "operations-student", chineseName: "操作台學生", studentNumber: "OPS1" });
    const teacherCookie = await readyUser(app, "operations-teacher", teacher.initialPassword, "Teacher-Strong-Password-1!");
    const studentCookie = await readyUser(app, "operations-student", student.initialPassword, "Student-Strong-Password-1!");

    const initial = await app.handle(request("/admin/backups", {}, cookie));
    assert.equal(initial.status, 200);
    assert.equal((await json(initial)).settings.enabled, false);

    const enabled = await app.handle(request("/admin/backups", { method: "PATCH", body: JSON.stringify({ enabled: true }), headers: { "content-type": "application/json" } }, cookie));
    assert.equal(enabled.status, 200);
    assert.equal((await json(enabled)).settings.enabled, true);

    app.services.audit.record({ id: created.user.id, role: "admin" }, { action: "ui.audit.filter", entityType: "test", correlationId: "admin-ui-correlation", metadata: { safe: "shown", password: "must-not-leak" } });
    const audit = await app.handle(request("/admin/audit?action=ui.audit.filter&correlationId=admin-ui-correlation&limit=1", {}, cookie));
    assert.equal(audit.status, 200);
    const logs = (await json(audit)).logs;
    assert.equal(logs.length, 1);
    assert.equal(logs[0].request_id, "admin-ui-correlation");
    assert.match(logs[0].metadata_json, /\[redacted\]/);
    assert.doesNotMatch(logs[0].metadata_json, /must-not-leak/);

    const page = await readFile("app/page.tsx", "utf8");
    const apiClient = await readFile("app/lib/api-client.ts", "utf8");
    assert.match(page, /AdminBackupCentre/);
    assert.match(page, /AdminAuditCentre/);
    assert.doesNotMatch(page.slice(page.indexOf("function AdminBackupCentre"), page.indexOf("function AdminCentre")), /dangerouslySetInnerHTML/);
    assert.match(apiClient, /correlationId/);

    const createdBackup = await app.handle(request("/admin/backups", { method: "POST", body: JSON.stringify({ trigger: "manual", scope: "database" }), headers: { "content-type": "application/json" } }, cookie));
    assert.equal(createdBackup.status, 202);
    const backup = (await json(createdBackup)).backup;
    assert.equal(backup.scope, "database");
    const listed = await app.handle(request("/admin/backups", {}, cookie));
    assert.equal((await json(listed)).backups[0].trigger, "manual");
    const verified = await app.handle(request(`/admin/backups/${backup.id}/verify`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }, cookie));
    assert.equal(verified.status, 200);
    assert.equal((await json(verified)).verification.valid, true);

    const forbiddenRequests = [
      ["GET", "/admin/backups"],
      ["PATCH", "/admin/backups"],
      ["POST", "/admin/backups"],
      ["GET", "/admin/audit"],
      ["POST", `/admin/backups/${backup.id}/verify`],
    ];
    for (const actorCookie of [teacherCookie, studentCookie]) {
      for (const [method, path] of forbiddenRequests) {
        const response = await app.handle(request(path, { method, body: method === "PATCH" ? JSON.stringify({ enabled: false }) : method === "POST" ? JSON.stringify({ trigger: "manual", scope: "database" }) : undefined, headers: method === "GET" ? undefined : { "content-type": "application/json" } }, actorCookie));
        assert.equal(response.status, 403, `${method} ${path}`);
      }
    }

  } finally {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});
