import assert from "node:assert/strict";
import test from "node:test";

const { openLocalDatabase, assertDatabaseIntegrity } = await import("../server/db.ts");
const { EducationService } = await import("../server/education.ts");
const { DomainError } = await import("../server/errors.ts");

function setup() {
  const db = openLocalDatabase(":memory:");
  return { db, service: new EducationService(db) };
}

test("passwords, opaque sessions, first-login change and reset are server-side", () => {
  const { db, service } = setup();
  const admin = service.createInitialAdmin({ username: "admin", chineseName: "管理員" });
  const teacher = service.createUser({ id: admin.user.id, role: "admin" }, { role: "teacher", username: "teacher", chineseName: "教師" });

  const login = service.login("teacher", teacher.initialPassword);
  assert.notEqual(login.token, teacher.initialPassword);
  assert.equal(login.user.mustChangePassword, true);
  assert.equal(service.session(login.token).role, "teacher");

  service.changePassword(login.token, "A-strong-password-1");
  assert.equal(service.login("teacher", "A-strong-password-1").user.mustChangePassword, false);
  assert.throws(() => service.login("teacher", teacher.initialPassword), (error) => error instanceof DomainError && error.code === "invalid_credentials");

  const reset = service.resetPassword({ id: admin.user.id, role: "admin" }, teacher.user.id);
  assert.equal(reset.user.mustChangePassword, true);
  assert.throws(() => service.session(login.token), (error) => error instanceof DomainError && error.code === "unauthorized");

  const audit = db.all("SELECT action, metadata_json FROM audit_logs");
  assert.equal(audit.some((row) => String(row.metadata_json).includes(teacher.initialPassword)), false);
  assert.equal(assertDatabaseIntegrity(db).foreignKeys, 1);
  db.close();
});

test("failed logins are throttled without revealing account existence", () => {
  const { db, service } = setup();
  const admin = service.createInitialAdmin({ username: "admin", chineseName: "管理員" });
  const student = service.createUser({ id: admin.user.id, role: "admin" }, { role: "student", username: "student", chineseName: "學生", studentNumber: "S001" });
  for (let index = 0; index < 5; index += 1) assert.throws(() => service.login("student", "wrong-password"));
  assert.throws(() => service.login("student", student.initialPassword), (error) => error instanceof DomainError && error.code === "invalid_credentials");
  const row = db.get("SELECT failed_login_count, locked_until FROM users WHERE id = ?", [student.user.id]);
  assert.equal(row.failed_login_count, 5);
  assert.ok(row.locked_until);
  db.close();
});

