import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const base = process.env.PHASE8_WEB_URL ?? "http://127.0.0.1:3000";
const internal = base + "/api/v1";
const credentialsPath = process.env.PHASE8_ADMIN_CREDENTIALS ?? ".local-secrets/admin.json";
const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
const canary = "CONTAINER_HIDDEN_CANARY";
const secretStrings = new Set([credentials.initialPassword]);
const timings = [];
const randomPassword = (label) => `${label}-${randomBytes(18).toString("base64url")}!`;

function cookieOf(response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}
async function api(path, method = "GET", body, cookie = "") {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers.origin = base;
  }
  const started = performance.now();
  const response = await fetch(internal + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const elapsed = performance.now() - started;
  timings.push(elapsed);
  const text = await response.text();
  let value = {};
  try { value = JSON.parse(text); } catch { value = { parseError: true }; }
  return { response, value, elapsed };
}
async function expect(path, method, body, cookie) {
  const result = await api(path, method, body, cookie);
  if (result.response.status >= 400) throw new Error(`${method} ${path} returned ${result.response.status}`);
  return result.value;
}
async function login(username, password) {
  const result = await api("/auth/login", "POST", { username, password });
  if (result.response.status !== 200) throw new Error(`login failed ${result.response.status}`);
  return cookieOf(result.response);
}
async function changePassword(cookie, password) {
  await expect("/auth/password", "POST", { newPassword: password }, cookie);
}
async function readyLogin(username, initialPassword, finalPassword) {
  const first = await login(username, initialPassword);
  const blocked = await api("/courses", "GET", undefined, first);
  if (blocked.response.status !== 428) throw new Error("first-password gate was not enforced");
  await changePassword(first, finalPassword);
  return login(username, finalPassword);
}
async function retryGrade(answerId, code, cookie) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await api(`/submission-answers/${answerId}/grade`, "POST", { code }, cookie);
    if (result.response.status !== 429) return result;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 50 * (attempt + 1))));
  }
  throw new Error("runner retry budget exhausted");
}
function hasSecret(value) {
  const text = JSON.stringify(value);
  return [...secretStrings].some((secret) => secret && text.includes(secret)) || text.includes(canary);
}
const fixture = { studentUsers: [], submissions: [] };
let cleanupError;
try {
  const adminFinalPassword = randomPassword("LoadAdmin");
  secretStrings.add(adminFinalPassword);
  const adminCookie = await readyLogin(credentials.username, credentials.initialPassword, adminFinalPassword);
  const teacherRecord = (await expect("/admin/users", "POST", { role: "teacher", username: "container-teacher", chineseName: "負載教師" }, adminCookie));
  const teacherFinalPassword = randomPassword("LoadTeacher");
  secretStrings.add(teacherRecord.initialPassword);
  secretStrings.add(teacherFinalPassword);
  const teacherCookie = await readyLogin("container-teacher", teacherRecord.initialPassword, teacherFinalPassword);
  for (let i = 1; i <= 40; i += 1) {
    const username = `container-student-${String(i).padStart(2, "0")}`;
    const student = await expect("/admin/users", "POST", { role: "student", username, chineseName: `測試學生${i}`, studentNumber: `C${String(i).padStart(3, "0")}` }, adminCookie);
    fixture.studentUsers.push({ id: student.user.id, username, initialPassword: student.initialPassword, password: randomPassword(`LoadStudent${String(i).padStart(2, "0")}`) });
  }
  const classData = await expect("/classes", "POST", { name: "容器負載班", academicYear: "2026" }, teacherCookie);
  const classId = classData.class.id;
  for (const student of fixture.studentUsers) await expect(`/classes/${classId}/members`, "POST", { userId: student.id }, teacherCookie);
  const courseData = await expect("/courses", "POST", { titleZh: "容器 40 人課程", titleEn: "Container Load", joinCode: "CONTAINER-40" }, teacherCookie);
  const courseId = courseData.course.id;
  await expect(`/courses/${courseId}`, "PATCH", { status: "published" }, teacherCookie);
  await expect(`/courses/${courseId}/classes`, "POST", { classId }, teacherCookie);
  const unitData = await expect(`/courses/${courseId}/units`, "POST", { titleZh: "執行單元", titleEn: "Execution" }, teacherCookie);
  const unitId = unitData.unit.id;
  const materialData = await expect(`/units/${unitId}/materials`, "POST", { kind: "web_content", titleZh: "容器教材", bodyZh: "print 基礎" }, teacherCookie);
  await expect(`/materials/${materialData.material.id}`, "PATCH", { status: "published" }, teacherCookie);
  const questionData = await expect("/questions", "POST", { courseId, unitId, type: "python_code", titleZh: "輸出 ok", promptZh: "輸出 ok", starterCode: "print('ok')" }, teacherCookie);
  const questionId = questionData.question.id;
  await expect(`/questions/${questionId}/test-cases`, "POST", { visibility: "public", expectedOutput: "ok\n" }, teacherCookie);
  await expect(`/questions/${questionId}/test-cases`, "POST", { visibility: "hidden", inputJson: { canary }, expectedOutput: "ok\n" }, teacherCookie);
  await expect(`/questions/${questionId}`, "PATCH", { status: "published" }, teacherCookie);
  const assignmentData = await expect("/assignments", "POST", { courseId, unitId, titleZh: "容器作業", kind: "homework", maxAttempts: 1 }, teacherCookie);
  const assignmentId = assignmentData.assignment.id;
  await expect(`/assignments/${assignmentId}/questions`, "POST", { questionId }, teacherCookie);
  await expect(`/assignments/${assignmentId}`, "PATCH", { status: "published" }, teacherCookie);
  const studentCookies = [];
  for (const student of fixture.studentUsers) {
    const cookie = await readyLogin(student.username, student.initialPassword, student.password);
    studentCookies.push(cookie);
    secretStrings.add(student.initialPassword);
    secretStrings.add(student.password);
    await expect("/courses", "GET", undefined, cookie);
    await expect(`/units/${unitId}/materials`, "GET", undefined, cookie);
  }
  const starts = await Promise.all(studentCookies.map((cookie) => expect(`/assignments/${assignmentId}/submissions`, "POST", {}, cookie)));
  const results = await Promise.all(starts.map(async (started, index) => {
    const answer = started.submission.answers[0];
    const grade = await retryGrade(answer.id, "print('ok')", studentCookies[index]);
    const gradeSafe = !hasSecret(grade.value);
    const submitted = await expect(`/submissions/${started.submission.id}/submit`, "POST", {}, studentCookies[index]);
    return { gradeStatus: grade.response.status, submitStatus: submitted ? 200 : 500, gradeSafe, submissionId: started.submission.id };
  }));
  const analytics = await expect(`/analytics/overview?courseId=${encodeURIComponent(courseId)}`, "GET", undefined, teacherCookie);
  const responseText = JSON.stringify(results) + JSON.stringify(analytics);
  if (responseText.includes(canary)) throw new Error("hidden canary leaked in container load response");
  const sorted = [...timings].sort((a, b) => a - b);
  const percentile = (value) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] ?? 0;
  const report = {
    scenario: "compose-web-backend-runner-40-users",
    users: 40,
    courseReads: 40,
    materialReads: 40,
    gradeStatuses: results.reduce((out, item) => { out[item.gradeStatus] = (out[item.gradeStatus] ?? 0) + 1; return out; }, {}),
    submitStatuses: results.reduce((out, item) => { out[item.submitStatus] = (out[item.submitStatus] ?? 0) + 1; return out; }, {}),
    hiddenCanaryLeaks: results.filter((item) => !item.gradeSafe).length,
    p50Ms: Math.round(percentile(0.5) * 100) / 100,
    p95Ms: Math.round(percentile(0.95) * 100) / 100,
    maxMs: Math.round(Math.max(...timings) * 100) / 100,
    note: "Real host -> web proxy -> backend container -> runner container. AI is production fail-closed because no external provider is configured; host fake-provider quota tests are separate.",
  };
  await writeFile("docs/任務包/證據/phase8b-compose-load.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  try {
    execFileSync(process.execPath, ["scripts/provision-local-admin.mjs", "--rotate"], {
      cwd: process.cwd(),
      env: { ...process.env, LOCAL_ADMIN_CONFIRM: "PROVISION_LOCAL_ADMIN" },
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    cleanupError = new Error("fixture cleanup failed; inspect backend health before reuse");
  }
}
if (cleanupError) throw cleanupError;
