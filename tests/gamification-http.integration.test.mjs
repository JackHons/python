import assert from "node:assert/strict";
import test from "node:test";
import { createBackendApp } from "../server/http/backend.ts";

const token = "gamification-http-token-123456";
function request(path, method = "GET", body, cookie = "") {
  const headers = new Headers({ "x-backend-token": token });
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined) { headers.set("content-type", "application/json"); headers.set("origin", "http://localhost"); }
  return new Request("http://localhost/api/v1" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function loginReady(app, username, initialPassword, newPassword) {
  const first = await app.handle(request("/auth/login", "POST", { username, password: initialPassword }));
  const cookie = first.headers.get("set-cookie").split(";", 1)[0];
  assert.equal((await app.handle(request("/auth/password", "POST", { newPassword }, cookie))).status, 200);
  return cookie;
}

test("gamification HTTP routes expose student-safe profile and admin switches", async () => {
  const app = createBackendApp({ internalToken: token });
  try {
    const adminRecord = app.services.education.createInitialAdmin({ username: "game-http-admin", chineseName: "管理員" });
    const admin = { id: adminRecord.user.id, role: "admin" };
    const teacherRecord = app.services.education.createUser(admin, { role: "teacher", username: "game-http-teacher", chineseName: "教師" });
    const studentRecord = app.services.education.createUser(admin, { role: "student", username: "game-http-student", chineseName: "學生", studentNumber: "GH1101" });
    const teacher = { id: teacherRecord.user.id, role: "teacher" };
    const student = { id: studentRecord.user.id, role: "student" };
    const [adminCookie, teacherCookie, studentCookie] = await Promise.all([
      loginReady(app, "game-http-admin", adminRecord.initialPassword, "Game-Http-Admin-1!"),
      loginReady(app, "game-http-teacher", teacherRecord.initialPassword, "Game-Http-Teacher-1!"),
      loginReady(app, "game-http-student", studentRecord.initialPassword, "Game-Http-Student-1!"),
    ]);
    const course = app.services.education.createCourse(teacher, { titleZh: "遊戲化 HTTP", joinCode: "GAMEHTTP" });
    app.services.education.updateCourse(teacher, course.id, { status: "published" });
    app.services.education.joinCourseByCode(student, "GAMEHTTP");
    const question = app.services.questions.createQuestion(teacher, { courseId: course.id, type: "short_answer", titleZh: "提交", promptZh: "回答", maxScore: 10 });
    app.services.questions.updateQuestion(teacher, question.id, { status: "published" });
    const assignment = app.services.assignments.createAssignment(teacher, { courseId: course.id, titleZh: "遊戲化提交" });
    app.services.assignments.addQuestion(teacher, assignment.id, question.id);
    app.services.assignments.updateAssignment(teacher, assignment.id, { status: "published" });
    const submission = app.services.assignments.beginSubmission(student, assignment.id);
    app.services.assignments.submit(student, submission.id);

    const profile = await app.handle(request("/gamification/me", "GET", undefined, studentCookie));
    assert.equal(profile.status, 200);
    assert.equal((await profile.json()).gamification.xp, 10);
    const leaderboard = await app.handle(request(`/courses/${course.id}/leaderboard`, "GET", undefined, studentCookie));
    assert.equal(leaderboard.status, 200);
    assert.equal((await leaderboard.json()).leaderboard.rows[0].xp, 10);
    assert.equal((await app.handle(request("/gamification/me", "GET", undefined, teacherCookie))).status, 403);
    assert.equal((await app.handle(request("/admin/gamification/settings", "GET", undefined, studentCookie))).status, 403);
    const settings = await app.handle(request("/admin/gamification/settings", "PATCH", { leaderboardEnabled: false }, adminCookie));
    assert.equal(settings.status, 200);
    assert.equal((await settings.json()).settings.leaderboard_enabled, 0);
    assert.equal((await app.handle(request(`/courses/${course.id}/leaderboard`, "GET", undefined, studentCookie))).status, 200);
  } finally { app.close(); }
});
