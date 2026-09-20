import assert from "node:assert/strict";
import test from "node:test";

const { openLocalDatabase } = await import("../server/db.ts");
const { EducationService } = await import("../server/education.ts");
const { handleEducationApi } = await import("../server/education-api.ts");

test("framework-neutral API adapter uses httpOnly session cookie and server scope", async () => {
  const db = openLocalDatabase(":memory:");
  const service = new EducationService(db);
  const admin = service.createInitialAdmin({ username: "admin", chineseName: "管理員" });
  const teacher = service.createUser({ id: admin.user.id, role: "admin" }, { role: "teacher", username: "teacher", chineseName: "教師" });

  const login = await handleEducationApi(new Request("http://localhost/api/education/auth/login", { method: "POST", body: JSON.stringify({ username: "teacher", password: teacher.initialPassword }), headers: { "content-type": "application/json" } }), { service });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie") ?? "", /HttpOnly/);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const me = await handleEducationApi(new Request("http://localhost/api/education/me", { headers: { cookie } }), { service });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.role, "teacher");

  const created = await handleEducationApi(new Request("http://localhost/api/education/classes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "3A", academicYear: "2026" }) }), { service });
  assert.equal(created.status, 201);
  const classes = await handleEducationApi(new Request("http://localhost/api/education/classes", { headers: { cookie } }), { service });
  assert.equal((await classes.json()).classes.length, 1);
  db.close();
});

