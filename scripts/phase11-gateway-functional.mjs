import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const baseUrl = (process.env.BASE_URL ?? "http://127.0.0.1:3338").replace(/\/$/, "");
const origin = new URL(baseUrl).origin;
const composeProject = process.env.COMPOSE_PROJECT ?? "phase11-c2c-f6a1-final";
const restartServices = process.env.RESTART_SERVICES === "true";
const adminUsername = process.env.ADMIN_USERNAME ?? "admin-local";
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) throw new Error("ADMIN_PASSWORD is required and is never printed");

function session() { return { cookie: "" }; }

async function api(path, options = {}) {
  const method = options.method ?? "GET";
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.session?.cookie) headers.set("cookie", options.session.cookie);
  if (method !== "GET") headers.set("origin", options.origin ?? origin);
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie && options.session) options.session.cookie = setCookie.split(";", 1)[0];
  const bytes = new Uint8Array(await response.arrayBuffer());
  let data = null;
  if ((response.headers.get("content-type") ?? "").includes("application/json") && bytes.length) {
    data = JSON.parse(new TextDecoder().decode(bytes));
  }
  const expected = options.expected ?? 200;
  assert.equal(response.status, expected, `${method} ${path} expected ${expected}, got ${response.status}: ${JSON.stringify(data?.error ?? data)}`);
  return { response, data, bytes };
}

async function login(target, username, password) {
  return api("/auth/login", { method: "POST", body: { username, password }, session: target });
}

async function portalPage(path, roleSession, expected = 200) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: roleSession.cookie ? { cookie: roleSession.cookie } : {},
    redirect: "manual",
  });
  assert.equal(response.status, expected, `GET ${path} expected ${expected}, got ${response.status}`);
  if (expected === 200) assert.match(response.headers.get("content-type") ?? "", /text\/html/);
}

async function verifyPortalPages(paths, roleSession) {
  for (const path of paths) await portalPage(path, roleSession);
}

async function firstLogin(username, password, nextPassword) {
  const first = session();
  await login(first, username, password);
  await api("/courses", { session: first, expected: 428 });
  await api("/auth/password", { method: "POST", body: { newPassword: nextPassword }, session: first });
  const ready = session();
  await login(ready, username, nextPassword);
  return ready;
}

async function waitForGateway() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The gateway may still be restarting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Gateway did not become healthy after restart");
}

const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const teacherUsername = `teacher-${stamp}`;
const studentUsername = `student-${stamp}`;
const teacherPassword = `Teacher-${stamp}-Strong!`;
const studentPassword = `Student-${stamp}-Strong!`;
const adminPasswordReady = `Admin-${stamp}-Strong!`;
const admin = await firstLogin(adminUsername, adminPassword, adminPasswordReady);
await api("/admin/status", { session: admin, expected: 200 });

const teacherCreated = (await api("/admin/users", { method: "POST", body: { role: "teacher", username: teacherUsername, chineseName: "Compose 教師" }, session: admin, expected: 201 })).data;
const studentCreated = (await api("/admin/users", { method: "POST", body: { role: "student", username: studentUsername, chineseName: "Compose 學生", studentNumber: `S-${stamp}` }, session: admin, expected: 201 })).data;
const teacher = await firstLogin(teacherUsername, teacherCreated.initialPassword, teacherPassword);
const student = await firstLogin(studentUsername, studentCreated.initialPassword, studentPassword);

await verifyPortalPages([
  "/admin/dashboard", "/admin/users", "/admin/classes", "/admin/courses", "/admin/settings/ai",
  "/admin/settings", "/admin/backups", "/admin/audit", "/admin/email",
], admin);
await verifyPortalPages([
  "/teacher/dashboard", "/teacher/courses", "/teacher/materials", "/teacher/classes",
  "/teacher/announcements", "/teacher/exports", "/teacher/assessment", "/teacher/classrooms",
  "/teacher/analytics", "/teacher/analytics/ai", "/teacher/ai-review",
], teacher);
await verifyPortalPages([
  "/student/dashboard", "/student/courses", "/student/notifications", "/student/missions",
  "/student/practice", "/student/resources", "/student/classrooms",
], student);
await portalPage("/admin/dashboard", student, 403);
await portalPage("/teacher/dashboard", student, 403);
await portalPage("/student/dashboard", teacher, 403);

const classData = (await api("/classes", { method: "POST", body: { name: `Compose 班 ${stamp}`, academicYear: "2026" }, session: teacher, expected: 201 })).data.class;
await api(`/classes/${classData.id}/members`, { method: "POST", body: { userId: studentCreated.user.id }, session: teacher, expected: 201 });
const course = (await api("/courses", { method: "POST", body: { titleZh: `Compose Python ${stamp}`, titleEn: "Compose Python", joinCode: `PY-${stamp}` }, session: teacher, expected: 201 })).data.course;
await api(`/courses/${course.id}`, { method: "PATCH", body: { status: "published" }, session: teacher });
const policy = (await api(`/courses/${course.id}/execution-policy`, { method: "PATCH", body: { allowedPackages: ["numpy"] }, session: teacher })).data.policy;
assert.deepEqual(policy.allowedPackages, ["numpy"]);
await api(`/courses/${course.id}/classes`, { method: "POST", body: { classId: classData.id }, session: teacher, expected: 201 });
const unit = (await api(`/courses/${course.id}/units`, { method: "POST", body: { titleZh: "Compose 輸出", titleEn: "Compose Output" }, session: teacher, expected: 201 })).data.unit;
await api(`/units/${unit.id}`, { method: "PATCH", body: { status: "published" }, session: teacher });
const material = (await api(`/units/${unit.id}/materials`, { method: "POST", body: { kind: "web_content", titleZh: "Compose 第一頁", bodyZh: "print 基礎" }, session: teacher, expected: 201 })).data.material;
await api(`/materials/${material.id}`, { method: "PATCH", body: { status: "published" }, session: teacher });
const question = (await api("/questions", { method: "POST", body: { courseId: course.id, unitId: unit.id, type: "python_code", titleZh: "輸出 ok", promptZh: "請輸出 ok", starterCode: "print('ok')" }, session: teacher, expected: 201 })).data.question;
await api(`/questions/${question.id}/test-cases`, { method: "POST", body: { visibility: "public", label: "公開", expectedOutput: "ok\n" }, session: teacher, expected: 201 });
await api(`/questions/${question.id}/test-cases`, { method: "POST", body: { visibility: "hidden", label: "隱藏", inputJson: { canary: "HIDDEN_INPUT_CANARY" }, expectedOutput: "ok\n" }, session: teacher, expected: 201 });
await api(`/questions/${question.id}`, { method: "PATCH", body: { status: "published" }, session: teacher });
const assignment = (await api("/assignments", { method: "POST", body: { courseId: course.id, unitId: unit.id, titleZh: "Compose 功課", kind: "homework", maxAttempts: 1 }, session: teacher, expected: 201 })).data.assignment;
await api(`/assignments/${assignment.id}/questions`, { method: "POST", body: { questionId: question.id }, session: teacher, expected: 201 });
await api(`/assignments/${assignment.id}`, { method: "PATCH", body: { status: "published" }, session: teacher });

await verifyPortalPages([
  `/teacher/courses/${course.id}`,
  `/teacher/courses/${course.id}/units/${unit.id}/materials`,
  `/teacher/classes/${classData.id}`,
  `/teacher/assignments/${assignment.id}/submissions`,
  "/teacher/classrooms/route-smoke-session",
], teacher);
await verifyPortalPages([
  `/student/courses/${course.id}`,
  `/student/courses/${course.id}/units/${unit.id}`,
  `/student/courses/${course.id}/assignments/${assignment.id}`,
  "/student/classrooms/route-smoke-session",
], student);

const studentCourses = (await api("/courses", { session: student })).data.courses;
assert.equal(studentCourses.length, 1);
const studentAssignments = (await api(`/courses/${course.id}/assignments`, { session: student })).data.assignments;
assert.equal(studentAssignments.length, 1);
const submission = (await api(`/assignments/${assignment.id}/submissions`, { method: "POST", body: {}, session: student, expected: 201 })).data.submission;
await portalPage(`/student/practice/${submission.id}`, student);
const answer = submission.answers[0];
await api(`/submission-answers/${answer.id}/snapshots`, { method: "POST", body: { code: "print('ok')", source: "autosave" }, session: student, expected: 201 });
await api(`/submissions/${submission.id}/answers/${answer.questionId}`, { method: "PATCH", body: { answerText: "print('ok')" }, session: student });
const execution = (await api(`/submission-answers/${answer.id}/grade`, { method: "POST", body: { code: "print('ok')" }, session: student })).data.execution;
assert.equal(execution.status, "passed");
assert.deepEqual(execution.limits.allowedPackages, ["numpy"]);
assert.equal(JSON.stringify(execution).includes("HIDDEN_INPUT_CANARY"), false);
await api(`/submissions/${submission.id}/submit`, { method: "POST", body: {}, session: student });
await api(`/submissions/${submission.id}`, { session: teacher });
await api(`/submissions/${submission.id}/grade`, { method: "POST", body: { questionId: question.id, score: 1, feedback: "Compose 完成" }, session: teacher });
await api(`/submissions/${submission.id}/release-grade`, { method: "POST", body: {}, session: teacher });
const released = (await api(`/submissions/${submission.id}`, { session: student })).data.submission;
assert.equal(JSON.stringify(released).includes("HIDDEN_INPUT_CANARY"), false);

const exportJob = (await api("/exports", { method: "POST", body: { reportType: "overview", format: "xlsx", filters: { courseId: course.id } }, session: teacher, expected: 201 })).data.job;
await api(`/exports/${exportJob.id}/run`, { method: "POST", body: {}, session: teacher });
const exported = await api(`/exports/${exportJob.id}/download`, { session: teacher });
assert.equal(exported.response.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
assert.ok(exported.bytes.byteLength > 100);

await api("/admin/backups", { method: "PATCH", body: { enabled: true }, session: admin });
const backup = (await api("/admin/backups", { method: "POST", body: { trigger: "manual", scope: "full" }, session: admin, expected: 202 })).data.backup;
const verification = (await api(`/admin/backups/${backup.id}/verify`, { method: "POST", body: {}, session: admin })).data.verification;
assert.equal(verification.valid, true);
const audit = (await api("/admin/audit?limit=10", { session: admin })).data.logs;
assert.ok(audit.length > 0);

await api("/admin/audit", { session: student, expected: 403 });
const evil = await api(`/courses/${course.id}`, { method: "PATCH", body: { titleZh: "evil" }, session: teacher, origin: "http://evil.invalid", expected: 403 });
assert.equal(evil.data?.error?.code, "csrf_failed");
const wrongMethod = await api("/courses", { method: "DELETE", session: teacher, expected: 405 });
assert.match(wrongMethod.response.headers.get("allow") ?? "", /GET/);

if (restartServices) {
  execFileSync("docker", ["compose", "-p", composeProject, "restart", "backend", "gateway"], { stdio: "ignore" });
  await waitForGateway();
  const teacherAfterRestart = session();
  const studentAfterRestart = session();
  await login(teacherAfterRestart, teacherUsername, teacherPassword);
  await login(studentAfterRestart, studentUsername, studentPassword);
  assert.equal((await api("/courses", { session: teacherAfterRestart })).data.courses.length, 1);
  const persisted = (await api(`/submissions/${submission.id}`, { session: studentAfterRestart })).data.submission;
  assert.equal(persisted.id, submission.id);
  assert.equal(JSON.stringify(persisted).includes("HIDDEN_INPUT_CANARY"), false);
}

console.log(JSON.stringify({
  status: "PASS",
  flow: "admin -> teacher/student -> publish -> runner grade -> submit -> teacher release -> student result",
  backupAndAudit: true,
  exportBytes: exported.bytes.byteLength,
  hiddenCanaryExposed: false,
  csrfBoundary: evil.response.status === 403,
  wrongRoleBoundary: true,
  staticPortalPages: 27,
  dynamicPortalPages: 10,
  methodBoundary: wrongMethod.response.status === 405,
  restartPersistence: restartServices,
}, null, 2));
