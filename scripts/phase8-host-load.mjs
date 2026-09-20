import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackendServer } from "../server/http/backend.ts";
import { hashPassword } from "../server/security.ts";

class FakeRunner {
  async execute() {
    return { stdout: "ok\n", stderr: "", exit_code: 0, timed_out: false, output_limited: false, duration_ms: 2 };
  }
}

const root = await mkdtemp(join(tmpdir(), "python-learning-load-"));
const token = "phase8-host-load-internal-token-123456";
const options = { databasePath: join(root, "learning.sqlite"), storageRoot: join(root, "storage"), exportRoot: join(root, "exports"), backupRoot: join(root, "backups"), internalToken: token, runner: new FakeRunner() };
const { app, server } = createBackendServer(options);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const base = "http://127.0.0.1:" + address.port;
const requestTimes = [];

function fixturePassword(username) {
  return "Load-" + username + "-Strong-Password-1!";
}
async function prepareFixture() {
  app.services.education.createInitialAdmin({ username: "load-admin", chineseName: "負載管理員" });
  const adminRow = app.services.db.get("SELECT id FROM users WHERE username = ?", ["load-admin"]);
  app.services.db.run("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", [hashPassword(fixturePassword("admin")), adminRow.id]);
  const adminActor = { id: adminRow.id, role: "admin" };
  const teacher = app.services.education.createUser(adminActor, { role: "teacher", username: "load-teacher", chineseName: "負載教師" });
  app.services.db.run("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", [hashPassword(fixturePassword("teacher")), teacher.user.id]);
  const teacherActor = { id: teacher.user.id, role: "teacher" };
  const students = [];
  for (let i = 1; i <= 40; i += 1) {
    const username = "load-student-" + String(i).padStart(2, "0");
    const student = app.services.education.createUser(adminActor, { role: "student", username, chineseName: "測試學生" + i, studentNumber: "L" + String(i).padStart(3, "0") });
    app.services.db.run("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", [hashPassword(fixturePassword(username)), student.user.id]);
    students.push({ ...student.user, username, password: fixturePassword(username) });
  }
  const course = app.services.education.createCourse(teacherActor, { titleZh: "負載測試課程", titleEn: "Load Test", joinCode: "LOAD-40" });
  app.services.education.updateCourse(teacherActor, course.id, { status: "published" });
  const unit = app.services.education.createUnit(teacherActor, course.id, { titleZh: "執行單元" });
  const material = await app.services.materials.createMaterial(teacherActor, unit.id, { kind: "web_content", titleZh: "負載教材", bodyZh: "print 基礎" });
  app.services.materials.updateMaterial(teacherActor, material.id, { status: "published" });
  const question = app.services.questions.createQuestion(teacherActor, { courseId: course.id, unitId: unit.id, type: "python_code", titleZh: "輸出 ok", promptZh: "輸出 ok", starterCode: "print('ok')", maxScore: 1 });
  app.services.questions.addTestCase(teacherActor, question.id, { visibility: "public", expectedOutput: "ok\n" });
  app.services.questions.addTestCase(teacherActor, question.id, { visibility: "hidden", inputJson: { canary: "HOST_HIDDEN_CANARY" }, expectedOutput: "ok\n" });
  const assignment = app.services.assignments.createAssignment(teacherActor, { courseId: course.id, unitId: unit.id, titleZh: "40 人作答", maxAttempts: 1 });
  app.services.assignments.addQuestion(teacherActor, assignment.id, question.id);
  app.services.assignments.updateAssignment(teacherActor, assignment.id, { status: "published" });
  for (const student of students) app.services.db.run("INSERT INTO course_enrollments (course_id, student_id, source) VALUES (?, ?, 'load_fixture')", [course.id, student.id]);
  return { course, unit, material, assignment, question, students };
}
async function api(path, method, body, cookie) {
  const headers = { "x-backend-token": token };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) { headers["content-type"] = "application/json"; headers.origin = base; }
  const started = performance.now();
  const response = await fetch(base + "/api/v1" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const elapsed = performance.now() - started;
  requestTimes.push(elapsed);
  const text = await response.text();
  let value = {};
  try { value = JSON.parse(text); } catch { value = { parseError: true }; }
  return { response, value, elapsed };
}
function cookieOf(result) {
  return result.response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}
const fixture = await prepareFixture();
const teacherLogin = await api("/auth/login", "POST", { username: "load-teacher", password: fixturePassword("teacher") });
const teacherCookie = cookieOf(teacherLogin);
const studentLogins = await Promise.all(fixture.students.map((student) => api("/auth/login", "POST", { username: student.username, password: student.password })));
const studentCookies = studentLogins.map(cookieOf);
const courseReads = await Promise.all(studentCookies.map((cookie) => api("/courses", "GET", undefined, cookie)));
const materialReads = await Promise.all(studentCookies.map((cookie) => api("/units/" + fixture.unit.id + "/materials", "GET", undefined, cookie)));
const attempts = await Promise.all(studentCookies.map((cookie) => api("/assignments/" + fixture.assignment.id + "/submissions", "POST", {}, cookie)));
const start = performance.now();
const results = await Promise.all(attempts.map(async (attempt, index) => {
  const answer = attempt.value.submission.answers[0];
  const grade = await api("/submission-answers/" + answer.id + "/grade", "POST", { code: "print('ok')" }, studentCookies[index]);
  const hiddenLeak = JSON.stringify(grade.value).includes("HOST_HIDDEN_CANARY");
  const submit = await api("/submissions/" + attempt.value.submission.id + "/submit", "POST", {}, studentCookies[index]);
  return { gradeStatus: grade.response.status, submitStatus: submit.response.status, hiddenLeak };
}));
const analytics = await api("/analytics/overview?courseId=" + encodeURIComponent(fixture.course.id), "GET", undefined, teacherCookie);
const sorted = [...requestTimes].sort((a, b) => a - b);
const percentile = (value) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] ?? 0;
const integrity = app.services.db.get("PRAGMA integrity_check");
const foreignKeys = app.services.db.get("PRAGMA foreign_keys");
const distinctRuns = app.services.db.get("SELECT COUNT(DISTINCT student_id) AS count FROM code_runs")?.count ?? 0;
const result = {
  scenario: "host-http-40-users",
  users: 40,
  totalRequests: requestTimes.length,
  gradeSubmitElapsedMs: Math.round((performance.now() - start) * 100) / 100,
  p50Ms: Math.round(percentile(0.5) * 100) / 100,
  p95Ms: Math.round(percentile(0.95) * 100) / 100,
  maxMs: Math.round(Math.max(...requestTimes) * 100) / 100,
  gradeStatuses: results.reduce((out, item) => { out[item.gradeStatus] = (out[item.gradeStatus] ?? 0) + 1; return out; }, {}),
  submitStatuses: results.reduce((out, item) => { out[item.submitStatus] = (out[item.submitStatus] ?? 0) + 1; return out; }, {}),
  hiddenCanaryLeaks: results.filter((item) => item.hiddenLeak).length,
  analyticsStatus: analytics.response.status,
  courseReadStatuses: courseReads.reduce((out, item) => { out[item.response.status] = (out[item.response.status] ?? 0) + 1; return out; }, {}),
  materialReadStatuses: materialReads.reduce((out, item) => { out[item.response.status] = (out[item.response.status] ?? 0) + 1; return out; }, {}),
  database: { integrity: integrity.integrity_check, foreignKeys: foreignKeys.foreign_keys, distinctRunStudents: distinctRuns },
  note: "Host HTTP + injected fake runner; Docker network/cgroup isolation and real AI quota are not measured here.",
};
await writeFile("docs/任務包/證據/phase8-host-load.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
server.close();
app.close();
await rm(root, { recursive: true, force: true });
