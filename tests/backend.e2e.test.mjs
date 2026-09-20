import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackendApp } from "../server/http/backend.ts";

class FakeRunner {
  async execute() {
    return { stdout: "ok\n", stderr: "", exit_code: 0, timed_out: false, output_limited: false, duration_ms: 2 };
  }
}

function req(path, method = "GET", body, cookie = "") {
  const headers = new Headers({ "x-backend-token": "e2e-token" });
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined) { headers.set("content-type", "application/json"); headers.set("origin", "http://localhost"); }
  return new Request("http://localhost/api/v1" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function payload(response) { return await response.json(); }
async function call(app, path, method, body, cookie) {
  const response = await app.handle(req(path, method, body, cookie));
  const value = await payload(response);
  assert.ok(response.status < 400, method + " " + path + ": " + response.status + " " + JSON.stringify(value));
  return value;
}
async function login(app, username, password) {
  const response = await app.handle(req("/auth/login", "POST", { username, password }));
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";", 1)[0];
}
async function rawLogin(app, username, password) {
  const response = await app.handle(req("/auth/login", "POST", { username, password }));
  assert.equal(response.status, 200);
  return response;
}
async function changePassword(app, cookie, newPassword) {
  const response = await app.handle(req("/auth/password", "POST", { newPassword }, cookie));
  assert.equal(response.status, 200);
}

test("backend keeps identity and education data across app restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "python-learning-api-"));
  const databasePath = join(root, "learning.sqlite");
  const options = { databasePath, storageRoot: join(root, "storage"), exportRoot: join(root, "exports"), backupRoot: join(root, "backups"), internalToken: "e2e-token", runner: new FakeRunner() };
  const app = createBackendApp(options);
  const admin = app.services.education.createInitialAdmin({ username: "admin", chineseName: "管理員" });
  const adminFirstLogin = await rawLogin(app, "admin", admin.initialPassword);
  const adminFirstCookie = adminFirstLogin.headers.get("set-cookie").split(";", 1)[0];
  assert.equal((await app.handle(req("/admin/status", "GET", undefined, adminFirstCookie))).status, 428);
  await changePassword(app, adminFirstCookie, "Admin-Strong-Password-1!");
  const adminCookie = await login(app, "admin", "Admin-Strong-Password-1!");
  const teacher = await call(app, "/admin/users", "POST", { role: "teacher", username: "teacher", chineseName: "教師" }, adminCookie);
  const student = await call(app, "/admin/users", "POST", { role: "student", username: "student", chineseName: "學生", studentNumber: "S001" }, adminCookie);
  const teacherFirstLogin = await rawLogin(app, "teacher", teacher.initialPassword);
  const teacherFirstCookie = teacherFirstLogin.headers.get("set-cookie").split(";", 1)[0];
  assert.equal((await app.handle(req("/courses", "GET", undefined, teacherFirstCookie))).status, 428);
  await changePassword(app, teacherFirstCookie, "Teacher-Strong-Password-1!");
  const teacherCookie = await login(app, "teacher", "Teacher-Strong-Password-1!");
  const classData = await call(app, "/classes", "POST", { name: "初三A", academicYear: "2026" }, teacherCookie);
  await call(app, "/classes/" + classData.class.id + "/members", "POST", { userId: student.user.id }, teacherCookie);
  const course = await call(app, "/courses", "POST", { titleZh: "Python 核心", titleEn: "Python Core", joinCode: "PY-2026" }, teacherCookie);
  const courseId = course.course.id;
  await call(app, "/courses/" + courseId, "PATCH", { status: "published" }, teacherCookie);
  const packagePolicy = await call(app, "/courses/" + courseId + "/execution-policy", "PATCH", { allowedPackages: ["numpy"] }, teacherCookie);
  assert.deepEqual(packagePolicy.policy.allowedPackages, ["numpy"]);
  await call(app, "/courses/" + courseId + "/classes", "POST", { classId: classData.class.id }, teacherCookie);
  const unit = await call(app, "/courses/" + courseId + "/units", "POST", { titleZh: "輸出", titleEn: "Output" }, teacherCookie);
  await call(app, "/units/" + unit.unit.id, "PATCH", { status: "published" }, teacherCookie);
  const material = await call(app, "/units/" + unit.unit.id + "/materials", "POST", { kind: "web_content", titleZh: "第一頁", bodyZh: "print 基礎" }, teacherCookie);
  await call(app, "/materials/" + material.material.id, "PATCH", { status: "published" }, teacherCookie);
  const question = await call(app, "/questions", "POST", { courseId, unitId: unit.unit.id, type: "python_code", titleZh: "輸出 ok", promptZh: "請輸出 ok", starterCode: "print('ok')" }, teacherCookie);
  const questionId = question.question.id;
  await call(app, "/questions/" + questionId + "/test-cases", "POST", { visibility: "public", label: "公開", expectedOutput: "ok\n" }, teacherCookie);
  await call(app, "/questions/" + questionId + "/test-cases", "POST", { visibility: "hidden", label: "隱藏", inputJson: { canary: "HIDDEN_INPUT_CANARY" }, expectedOutput: "ok\n" }, teacherCookie);
  await call(app, "/questions/" + questionId, "PATCH", { status: "published" }, teacherCookie);
  const assignment = await call(app, "/assignments", "POST", { courseId, unitId: unit.unit.id, titleZh: "功課一", kind: "homework", maxAttempts: 1 }, teacherCookie);
  const assignmentId = assignment.assignment.id;
  await call(app, "/assignments/" + assignmentId + "/questions", "POST", { questionId }, teacherCookie);
  await call(app, "/assignments/" + assignmentId, "PATCH", { status: "published" }, teacherCookie);
  const studentFirstLogin = await rawLogin(app, "student", student.initialPassword);
  const studentFirstCookie = studentFirstLogin.headers.get("set-cookie").split(";", 1)[0];
  assert.equal((await app.handle(req("/courses", "GET", undefined, studentFirstCookie))).status, 428);
  await changePassword(app, studentFirstCookie, "Student-Strong-Password-1!");
  const studentCookie = await login(app, "student", "Student-Strong-Password-1!");
  const artifact = await call(app, "/ai/artifacts", "POST", { artifactType: "feedback", courseId, studentId: student.user.id, content: { hint: "AI_UNAPPROVED_CANARY" } }, teacherCookie);
  const unapproved = await app.handle(req("/ai/artifacts/" + artifact.artifact.id, "GET", undefined, studentCookie));
  assert.equal(unapproved.status, 404);
  await call(app, "/ai/artifacts/" + artifact.artifact.id + "/review", "POST", { decision: "approved" }, teacherCookie);
  await call(app, "/ai/artifacts/" + artifact.artifact.id + "/publish", "POST", {}, teacherCookie);
  const publishedArtifact = await call(app, "/ai/artifacts/" + artifact.artifact.id, "GET", undefined, studentCookie);
  assert.equal(publishedArtifact.artifact.content.hint, "AI_UNAPPROVED_CANARY");
  const studentCourses = await call(app, "/courses", "GET", undefined, studentCookie);
  assert.equal(studentCourses.courses.length, 1);
  const studentAssignments = await call(app, "/courses/" + courseId + "/assignments", "GET", undefined, studentCookie);
  assert.equal(studentAssignments.assignments.length, 1);
  const started = await call(app, "/assignments/" + assignmentId + "/submissions", "POST", {}, studentCookie);
  const submission = started.submission;
  const answer = submission.answers[0];
  const autosave = await call(app, "/submission-answers/" + answer.id + "/snapshots", "POST", { code: "print('ok')", source: "autosave" }, studentCookie);
  assert.equal(autosave.snapshot.source, "autosave");
  await call(app, "/submissions/" + submission.id + "/answers/" + answer.questionId, "PATCH", { answerText: "print('ok')" }, studentCookie);
  const run = await call(app, "/submission-answers/" + answer.id + "/grade", "POST", { code: "print('ok')" }, studentCookie);
  assert.equal(run.execution.status, "passed");
  assert.deepEqual(run.execution.limits.allowedPackages, ["numpy"]);
  assert.equal(JSON.stringify(run).includes("HIDDEN_INPUT_CANARY"), false);
  assert.equal(JSON.stringify(run).includes("HIDDEN_INPUT_CANARY"), false);
  await call(app, "/submissions/" + submission.id + "/submit", "POST", {}, studentCookie);
  const teacherSubmission = await call(app, "/submissions/" + submission.id, "GET", undefined, teacherCookie);
  assert.equal(teacherSubmission.submission.student_id, student.user.id);
  await call(app, "/submissions/" + submission.id + "/grade", "POST", { questionId, score: 1, feedback: "完成" }, teacherCookie);
  await call(app, "/submissions/" + submission.id + "/release-grade", "POST", {}, teacherCookie);
  const studentResult = await call(app, "/submissions/" + submission.id, "GET", undefined, studentCookie);
  assert.equal(JSON.stringify(studentResult).includes("HIDDEN_INPUT_CANARY"), false);
  assert.equal(JSON.stringify(studentResult).includes("HIDDEN_INPUT_CANARY"), false);
  const job = await call(app, "/exports", "POST", { reportType: "overview", format: "xlsx", filters: { courseId } }, teacherCookie);
  await call(app, "/exports/" + job.job.id + "/run", "POST", {}, teacherCookie);
  const exportResponse = await app.handle(req("/exports/" + job.job.id + "/download", "GET", undefined, teacherCookie));
  assert.equal(exportResponse.status, 200);
  assert.equal(exportResponse.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.ok((await exportResponse.arrayBuffer()).byteLength > 100);
  const classroom = await call(app, "/classrooms", "POST", { courseId, title: "即時課堂" }, teacherCookie);
  const activity = await call(app, "/classrooms/" + classroom.classroom.session.id + "/activities", "POST", { title: "即時題", assignmentId }, teacherCookie);
  await call(app, "/activities/" + activity.activity.id + "/transition", "POST", { transition: "start", idempotencyKey: "e2e-start" }, teacherCookie);
  const classroomState = await call(app, "/classrooms/" + classroom.classroom.session.id, "GET", undefined, teacherCookie);
  assert.equal(classroomState.classroom.activity.status, "active");
  app.close();
  const reopened = createBackendApp(options);
  const relogin = await reopened.handle(req("/auth/login", "POST", { username: "teacher", password: "Teacher-Strong-Password-1!" }));
  assert.equal(relogin.status, 200);
  const reopenedCourses = await call(reopened, "/courses", "GET", undefined, relogin.headers.get("set-cookie").split(";", 1)[0]);
  assert.equal(reopenedCourses.courses[0].title_zh, "Python 核心");
  reopened.close();
  await rm(root, { recursive: true, force: true });
});
