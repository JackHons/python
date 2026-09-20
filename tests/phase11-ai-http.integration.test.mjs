import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createBackendApp } from "../server/http/backend.ts";

const token = "phase11-internal-token-123456789";
function request(path, method = "GET", body, cookie = "") {
  const headers = new Headers({ "x-backend-token": token });
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined) { headers.set("content-type", "application/json"); headers.set("origin", "http://localhost"); }
  return new Request("http://localhost/api/v1" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function json(response) { return response.json(); }
async function loginReady(app, username, initialPassword, newPassword) {
  const first = await app.handle(request("/auth/login", "POST", { username, password: initialPassword }));
  const cookie = first.headers.get("set-cookie").split(";", 1)[0];
  assert.equal((await app.handle(request("/auth/password", "POST", { newPassword }, cookie))).status, 200);
  return cookie;
}

test("AI and progressive hint HTTP routes enforce role, scope, masking, and student-safe projection", async () => {
  const app = createBackendApp({ internalToken: token, aiMasterKey: randomBytes(32).toString("base64") });
  try {
    const adminRecord = app.services.education.createInitialAdmin({ username: "phase11-admin", chineseName: "管理員" });
    const admin = { id: adminRecord.user.id, role: "admin" };
    const teacherRecord = app.services.education.createUser(admin, { role: "teacher", username: "phase11-teacher", chineseName: "教師" });
    const studentRecord = app.services.education.createUser(admin, { role: "student", username: "phase11-student", chineseName: "學生", studentNumber: "P1101" });
    const otherRecord = app.services.education.createUser(admin, { role: "student", username: "phase11-other", chineseName: "其他學生", studentNumber: "P1102" });
    const teacher = { id: teacherRecord.user.id, role: "teacher" };
    const student = { id: studentRecord.user.id, role: "student" };
    const other = { id: otherRecord.user.id, role: "student" };
    const [adminCookie, teacherCookie, studentCookie, otherCookie] = await Promise.all([
      loginReady(app, "phase11-admin", adminRecord.initialPassword, "Phase11-Admin-Strong-1!"),
      loginReady(app, "phase11-teacher", teacherRecord.initialPassword, "Phase11-Teacher-Strong-1!"),
      loginReady(app, "phase11-student", studentRecord.initialPassword, "Phase11-Student-Strong-1!"),
      loginReady(app, "phase11-other", otherRecord.initialPassword, "Phase11-Other-Strong-1!"),
    ]);

    const configuredResponse = await app.handle(request("/admin/ai/providers", "POST", { providerKey: "openai-compatible:http", displayName: "HTTP", apiBaseUrl: "http://127.0.0.1:9/v1", apiPath: "/chat/completions", timeoutMs: 1000, defaultModel: "http-model", apiKey: "http-secret", enabled: false }, adminCookie));
    assert.equal(configuredResponse.status, 200);
    const configured = await json(configuredResponse);
    assert.doesNotMatch(JSON.stringify(configured), /http-secret|encrypted_api_key/);
    assert.equal((await app.handle(request(`/admin/ai/providers/${configured.provider.id}/activate`, "POST", {}, adminCookie))).status, 200);
    assert.equal((await app.handle(request("/admin/ai/settings", "PATCH", { enabled: true, maxHintLayers: 2 }, adminCookie))).status, 200);
    assert.equal((await app.handle(request("/admin/ai/providers", "GET", undefined, teacherCookie))).status, 403);
    assert.equal((await app.handle(request("/admin/ai/settings", "GET", undefined, studentCookie))).status, 403);
    const course = app.services.education.createCourse(teacher, { titleZh: "Phase 11", joinCode: "PHASE11" });
    app.services.education.updateCourse(teacher, course.id, { status: "published" });
    app.services.education.joinCourseByCode(student, "PHASE11");
    app.services.education.joinCourseByCode(other, "PHASE11");
    const status = await json(await app.handle(request("/ai/status", "GET", undefined, studentCookie)));
    assert.deepEqual(status.status, { enabled: true, hintLevel: 0, maxHintLevel: 2 });
    assert.doesNotMatch(JSON.stringify(status), /remaining|quota|token|cost|provider|key|model/i);

    const question = app.services.questions.createQuestion(teacher, { courseId: course.id, type: "python_code", titleZh: "HTTP 提示", promptZh: "完成程式", starterCode: "" });
    app.services.questions.updateQuestion(teacher, question.id, { status: "published" });
    const assignment = app.services.assignments.createAssignment(teacher, { courseId: course.id, titleZh: "HTTP 功課" });
    app.services.assignments.addQuestion(teacher, assignment.id, question.id);
    app.services.assignments.updateAssignment(teacher, assignment.id, { status: "published" });
    const submission = app.services.assignments.beginSubmission(student, assignment.id);
    const saved = await app.handle(request(`/questions/${question.id}/hints`, "POST", { level: 1, contentZh: "先理解輸入。", source: "manual" }, teacherCookie));
    assert.equal(saved.status, 201);
    assert.equal((await app.handle(request(`/questions/${question.id}/hints`, "GET", undefined, studentCookie))).status, 403);
    const unlocked = await app.handle(request(`/submissions/${submission.id}/questions/${question.id}/hints/unlock`, "POST", { idempotencyKey: "http-one" }, studentCookie));
    assert.equal(unlocked.status, 200);
    assert.equal((await json(unlocked)).state.hintLevel, 1);
    assert.equal((await app.handle(request(`/submissions/${submission.id}/questions/${question.id}/hints`, "GET", undefined, otherCookie))).status, 404);
  } finally { app.close(); }
});
