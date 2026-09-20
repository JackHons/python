import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { makeContentFixture } from "./content-helpers.mjs";
import { createBackendApp } from "../server/http/backend.ts";

const { QuestionService } = await import("../server/content.ts");
const { DomainError } = await import("../server/errors.ts");
const { API_ROUTE_CONTRACTS, allowedMethodsForPath, routeContractForPath } = await import("../server/http/route-manifest.ts");
const { resolvePortalPath, safeReturnTo } = await import("../app/lib/portal-routes.ts");
const { hydratePortalDeepLink } = await import("../app/lib/deep-link-loader.ts");

test("canonical role routes are real files with stable deep-link contracts", async () => {
  const files = [
    "app/student/dashboard/page.tsx", "app/student/courses/page.tsx", "app/student/courses/[courseId]/page.tsx",
    "app/student/courses/[courseId]/units/[unitId]/page.tsx", "app/student/courses/[courseId]/assignments/[assignmentId]/page.tsx",
    "app/student/practice/[submissionId]/page.tsx", "app/student/classrooms/page.tsx", "app/student/classrooms/[sessionId]/page.tsx",
    "app/student/notifications/page.tsx",
    "app/teacher/dashboard/page.tsx", "app/teacher/courses/page.tsx", "app/teacher/courses/[courseId]/page.tsx",
    "app/teacher/courses/[courseId]/units/[unitId]/materials/page.tsx", "app/teacher/classes/page.tsx", "app/teacher/classes/[classId]/page.tsx",
    "app/teacher/assignments/[assignmentId]/submissions/page.tsx", "app/teacher/classrooms/page.tsx", "app/teacher/classrooms/[sessionId]/page.tsx",
    "app/teacher/announcements/page.tsx", "app/teacher/exports/page.tsx",
    "app/teacher/analytics/page.tsx", "app/teacher/analytics/ai/page.tsx", "app/teacher/ai-review/page.tsx",
    "app/admin/dashboard/page.tsx", "app/admin/users/page.tsx", "app/admin/classes/page.tsx", "app/admin/courses/page.tsx",
    "app/admin/settings/ai/page.tsx", "app/admin/settings/page.tsx", "app/admin/backups/page.tsx", "app/admin/audit/page.tsx",
    "app/admin/email/page.tsx",
    "app/dashboard/page.tsx", "app/courses/page.tsx", "app/classroom/page.tsx",
  ];
  await Promise.all(files.map((file) => access(join(process.cwd(), file))));
  assert.deepEqual(resolvePortalPath("/student/courses/course-1/units/unit-1"), { role: "student", section: "courses", params: ["student", "courses", "course-1", "units", "unit-1"] });
  assert.equal(resolvePortalPath("/teacher/analytics/ai")?.role, "teacher");
  assert.equal(resolvePortalPath("/admin/settings/ai")?.section, "ai-settings");
  assert.equal(resolvePortalPath("/student/notifications")?.section, "notifications");
  assert.equal(resolvePortalPath("/teacher/exports")?.section, "exports");
  assert.equal(safeReturnTo("https://evil.example/student/dashboard"), null);
  assert.equal(safeReturnTo("//evil.example"), null);
  assert.equal(safeReturnTo("/student/dashboard?from=login"), "/student/dashboard?from=login");
  const page = await readFile("app/page.tsx", "utf8");
  assert.match(page, /RoleSidebar[\s\S]*routeError/);
  assert.match(page, /usePathname\(\)[\s\S]*hydratePortalDeepLink\(routePath/);
  assert.match(page, /router\.push\(path\)/);
  assert.match(page, /function StudentNotifications/);
  assert.match(page, /learningApi\.markNotificationRead/);
  assert.match(page, /announcements: "\/teacher\/announcements"/);
  assert.match(page, /exports: "\/teacher\/exports"/);
  assert.match(page, /canonicalNotificationPath/);
  assert.match(page, /updateEmailSettings/);
  assert.match(page, /cancelEmail/);
  assert.match(page, /titleEn: titleEn/);
  assert.match(page, /publishAnnouncement\(selectedId, sendEmail\)/);
  assert.match(page, /TeacherExportCentre/);
  assert.match(page, /retryExport/);
  assert.doesNotMatch(page, /window\.history\.(pushState|replaceState)/);
});

test("typed deep-link hydration loads the addressed resource and rejects mismatched parents", async () => {
  const calls = [];
  const course = { id: "course-1", title_zh: "課程", title_en: null, status: "published" };
  const unit = { id: "unit-1", course_id: course.id, title_zh: "單元", title_en: null, position: 0, status: "published" };
  const assignment = { id: "assignment-1", course_id: course.id, unit_id: unit.id, kind: "homework", title_zh: "功課", title_en: null, status: "published", due_at: null, max_attempts: 1 };
  const submission = { id: "submission-1", assignment_id: assignment.id, status: "draft", attempt_number: 1, submitted_at: null, answers: [] };
  const api = {
    course: async (id) => { calls.push(["course", id]); return { course }; },
    units: async (id) => { calls.push(["units", id]); return { units: [unit] }; },
    materials: async (id) => { calls.push(["materials", id]); return { materials: [{ id: "material-1", unit_id: id }] }; },
    assignments: async (id) => { calls.push(["assignments", id]); return { assignments: [assignment] }; },
    assignment: async (id) => { calls.push(["assignment", id]); return { assignment }; },
    getSubmission: async (id) => { calls.push(["submission", id]); return { submission }; },
    assignmentSubmissions: async (id) => { calls.push(["submissions", id]); return { submissions: [{ id: "submitted-1" }] }; },
  };
  const studentUnit = await hydratePortalDeepLink("/student/courses/course-1/units/unit-1", api);
  assert.equal(studentUnit.kind, "student-unit");
  assert.equal(studentUnit.unit.id, "unit-1");
  assert.equal(studentUnit.materials[0].id, "material-1");
  const practice = await hydratePortalDeepLink("/student/practice/submission-1", api);
  assert.equal(practice.submission.id, "submission-1");
  const teacher = await hydratePortalDeepLink("/teacher/assignments/assignment-1/submissions", api);
  assert.equal(teacher.assignment.id, "assignment-1");
  assert.equal(teacher.submissions[0].id, "submitted-1");
  assert.ok(calls.some(([name, id]) => name === "materials" && id === "unit-1"));
  await assert.rejects(() => hydratePortalDeepLink("/student/courses/wrong-course/assignments/assignment-1", { ...api, course: async () => ({ course: { ...course, id: "wrong-course" } }) }), (error) => error.status === 404);
});

test("question known-id access is course scoped and unavailable resources are 404", async () => {
  const fixture = await makeContentFixture();
  try {
    const questions = new QuestionService(fixture.db);
    const otherTeacherRecord = fixture.education.createUser(fixture.admin, { role: "teacher", username: "routing-other-teacher", chineseName: "其他教師" });
    const otherTeacher = { id: otherTeacherRecord.user.id, role: "teacher" };
    const otherCourse = fixture.education.createCourse(otherTeacher, { titleZh: "其他課程", joinCode: "OTHER-ROUTE" });
    fixture.education.updateCourse(otherTeacher, otherCourse.id, { status: "published" });
    const question = questions.createQuestion(otherTeacher, { courseId: otherCourse.id, type: "short_answer", titleZh: "私有題目", promptZh: "回答" });
    questions.updateQuestion(otherTeacher, question.id, { status: "published" });
    assert.throws(() => questions.getStaffQuestion(fixture.teacher, question.id), (error) => error instanceof DomainError && error.code === "not_found" && error.status === 404);
    assert.throws(() => questions.listStudentQuestion(fixture.student, question.id), (error) => error instanceof DomainError && error.code === "not_found" && error.status === 404);
    assert.equal(questions.getStaffQuestion(fixture.admin, question.id).id, question.id);
  } finally {
    await fixture.close();
  }
});

test("question and hint known IDs become uniformly unavailable after their course is archived", async () => {
  const fixture = await makeContentFixture();
  try {
    const questions = new QuestionService(fixture.db);
    const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, unitId: fixture.unit.id, type: "python_code", titleZh: "封存題目", promptZh: "輸出 1", starterCode: "print(1)" });
    questions.addTestCase(fixture.teacher, question.id, { visibility: "public", expectedOutput: "1" });
    const manualHint = questions.saveHint(fixture.teacher, question.id, { level: 1, contentZh: "先執行程式。", source: "manual" });
    const draftHint = questions.saveHint(fixture.teacher, question.id, { level: 2, contentZh: "檢查輸出。", source: "ai" });
    questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
    assert.equal(questions.getStaffQuestion(fixture.teacher, question.id).id, question.id);
    assert.equal(questions.listStudentQuestion(fixture.student, question.id).id, question.id);
    fixture.education.archiveCourse(fixture.teacher, fixture.course.id);
    const expect404 = (operation) => assert.throws(operation, (error) => error instanceof DomainError && error.code === "not_found" && error.status === 404);
    for (const actor of [fixture.teacher, fixture.admin]) expect404(() => questions.getStaffQuestion(actor, question.id));
    expect404(() => questions.listStudentQuestion(fixture.student, question.id));
    expect404(() => questions.updateQuestion(fixture.teacher, question.id, { titleZh: "不可修改" }));
    expect404(() => questions.archiveQuestion(fixture.teacher, question.id));
    expect404(() => questions.addTestCase(fixture.teacher, question.id, { visibility: "hidden", expectedOutput: "2" }));
    expect404(() => questions.saveHint(fixture.teacher, question.id, { level: 3, contentZh: "不可新增", source: "manual" }));
    expect404(() => questions.listHints(fixture.teacher, question.id));
    expect404(() => questions.deleteHint(fixture.teacher, question.id, manualHint.level));
    expect404(() => questions.reviewHint(fixture.teacher, draftHint.id, "approved"));
  } finally {
    await fixture.close();
  }
});

test("course, unit, material and assignment known IDs conceal cross-scope and archived resources", async () => {
  const fixture = await makeContentFixture();
  try {
    const { MaterialService, AssignmentService } = await import("../server/content.ts");
    const materials = new MaterialService(fixture.db, fixture.storage);
    const assignments = new AssignmentService(fixture.db);
    const otherRecord = fixture.education.createUser(fixture.admin, { role: "teacher", username: "scope-other", chineseName: "其他教師" });
    const otherTeacher = { id: otherRecord.user.id, role: "teacher" };
    const otherCourse = fixture.education.createCourse(otherTeacher, { titleZh: "其他課程", joinCode: "OTHER-SCOPE" });
    fixture.education.updateCourse(otherTeacher, otherCourse.id, { status: "published" });
    const otherUnit = fixture.education.createUnit(otherTeacher, otherCourse.id, { titleZh: "私有單元" });
    fixture.education.updateUnit(otherTeacher, otherUnit.id, { status: "published" });
    const material = await materials.createMaterial(otherTeacher, otherUnit.id, { kind: "web_content", titleZh: "私有教材" });
    materials.updateMaterial(otherTeacher, material.id, { status: "published" });
    const assignment = assignments.createAssignment(otherTeacher, { courseId: otherCourse.id, unitId: otherUnit.id, titleZh: "私有功課" });
    const expect404 = (fn) => assert.throws(fn, (error) => error instanceof DomainError && error.status === 404 && error.code === "not_found");
    for (const actor of [fixture.student, fixture.teacher]) {
      expect404(() => fixture.education.getCourse(actor, otherCourse.id));
      expect404(() => fixture.education.listUnits(actor, otherCourse.id));
      expect404(() => materials.listMaterials(actor, otherUnit.id));
      expect404(() => assignments.getAssignment(actor, assignment.id));
    }
    await assert.rejects(() => materials.createMaterial(fixture.student, fixture.unit.id, { kind: "web_content", titleZh: "越權" }), (error) => error instanceof DomainError && error.status === 403);
    const archived = fixture.education.createCourse(fixture.teacher, { titleZh: "已封存" });
    fixture.education.archiveCourse(fixture.teacher, archived.id);
    expect404(() => fixture.education.getCourse(fixture.teacher, archived.id));
    expect404(() => fixture.education.listUnits(fixture.teacher, archived.id));
    expect404(() => assignments.listAssignments(fixture.teacher, archived.id));
  } finally { await fixture.close(); }
});

test("HTTP known-id projections return 404 across course scope while role violations remain 403", async () => {
  const token = "phase11-scope-http-token-123456";
  const app = createBackendApp({ internalToken: token, csrfRequired: true });
  const req = (path, method = "GET", body, cookie = "") => {
    const headers = new Headers({ "x-backend-token": token, origin: "http://localhost", "content-type": "application/json" });
    if (cookie) headers.set("cookie", cookie);
    return new Request("http://localhost/api/v1" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  async function readyCookie(username, initialPassword, nextPassword) {
    const first = await app.handle(req("/auth/login", "POST", { username, password: initialPassword }));
    const cookie = first.headers.get("set-cookie").split(";", 1)[0];
    assert.equal((await app.handle(req("/auth/password", "POST", { newPassword: nextPassword }, cookie))).status, 200);
    return cookie;
  }
  try {
    const adminRecord = app.services.education.createInitialAdmin({ username: "scope-http-admin", chineseName: "管理員" });
    const admin = { id: adminRecord.user.id, role: "admin" };
    const teacherOneRecord = app.services.education.createUser(admin, { role: "teacher", username: "scope-http-t1", chineseName: "教師一" });
    const teacherTwoRecord = app.services.education.createUser(admin, { role: "teacher", username: "scope-http-t2", chineseName: "教師二" });
    const studentRecord = app.services.education.createUser(admin, { role: "student", username: "scope-http-student", chineseName: "學生", studentNumber: "HTTP-S1" });
    const teacherOne = { id: teacherOneRecord.user.id, role: "teacher" };
    const student = { id: studentRecord.user.id, role: "student" };
    const course = app.services.education.createCourse(teacherOne, { titleZh: "範圍課程", joinCode: "HTTP-SCOPE" });
    app.services.education.updateCourse(teacherOne, course.id, { status: "published" });
    app.services.education.joinCourseByCode(student, "HTTP-SCOPE");
    const unit = app.services.education.createUnit(teacherOne, course.id, { titleZh: "範圍單元" });
    app.services.education.updateUnit(teacherOne, unit.id, { status: "published" });
    const material = await app.services.materials.createMaterial(teacherOne, unit.id, { kind: "web_content", titleZh: "範圍教材" });
    app.services.materials.updateMaterial(teacherOne, material.id, { status: "published" });
    const assignment = app.services.assignments.createAssignment(teacherOne, { courseId: course.id, unitId: unit.id, titleZh: "範圍功課" });
    const t2Cookie = await readyCookie("scope-http-t2", teacherTwoRecord.initialPassword, "Scope-Teacher-Two-Strong-1!");
    const studentCookie = await readyCookie("scope-http-student", studentRecord.initialPassword, "Scope-Student-Strong-1!");
    for (const path of [`/courses/${course.id}`, `/courses/${course.id}/units`, `/units/${unit.id}/materials`, `/assignments/${assignment.id}`]) {
      assert.equal((await app.handle(req(path, "GET", undefined, t2Cookie))).status, 404, `teacher cross-scope ${path}`);
    }
    assert.equal((await app.handle(req(`/units/${unit.id}/materials`, "POST", { kind: "web_content", titleZh: "越權" }, studentCookie))).status, 403);
    assert.equal((await app.handle(req(`/courses/${course.id}`, "GET", undefined, studentCookie))).status, 200);
    assert.equal((await app.handle(req(`/units/${unit.id}/materials`, "GET", undefined, studentCookie))).status, 200);
    assert.equal((await app.handle(req(`/assignments/${assignment.id}`, "GET", undefined, studentCookie))).status, 404, "draft assignments stay concealed");
  } finally { app.close(); }
});

test("route manifest distinguishes allowed methods and command POST endpoints", () => {
  assert.deepEqual(allowedMethodsForPath("/questions/q1"), ["GET", "PATCH", "DELETE"]);
  assert.deepEqual(allowedMethodsForPath("/courses/join"), ["POST"]);
  assert.deepEqual(allowedMethodsForPath("/classrooms/c1/events"), ["GET"]);
  assert.deepEqual(allowedMethodsForPath("/admin/ai/providers"), ["GET", "POST"]);
  assert.deepEqual(allowedMethodsForPath("/admin/ai/settings"), ["GET", "PATCH"]);
  assert.deepEqual(allowedMethodsForPath("/ai/status"), ["GET"]);
  assert.equal(API_ROUTE_CONTRACTS.find((route) => route.template === "/courses/join")?.command, true);
  const expectedPermissions = [
    ["/auth/login", "POST", ["anonymous", "student", "teacher", "admin"]],
    ["/auth/password", "POST", ["student", "teacher", "admin"]],
    ["/users", "GET", ["teacher", "admin"]],
    ["/students/import", "POST", ["teacher", "admin"]],
    ["/files", "GET", ["teacher", "admin"]],
    ["/files", "POST", ["student", "teacher", "admin"]],
    ["/courses", "GET", ["student", "teacher", "admin"]],
    ["/courses", "POST", ["teacher", "admin"]],
    ["/courses/course-1/execution-policy", "GET", ["student", "teacher", "admin"]],
    ["/courses/course-1/execution-policy", "PATCH", ["teacher", "admin"]],
    ["/assignments/assignment-1/submissions", "GET", ["teacher", "admin"]],
    ["/assignments/assignment-1/submissions", "POST", ["student"]],
    ["/submissions/submission-1/submit", "POST", ["student"]],
    ["/submissions/submission-1/grade", "POST", ["teacher", "admin"]],
    ["/submission-answers/answer-1/execute", "POST", ["student", "teacher", "admin"]],
    ["/submission-answers/answer-1/grade", "POST", ["student", "teacher", "admin"]],
    ["/submission-answers/answer-1/snapshots", "POST", ["student", "teacher", "admin"]],
  ];
  for (const [path, method, roles] of expectedPermissions) assert.deepEqual(routeContractForPath(path).permissionsByMethod[method], roles, `${method} ${path}`);
});

test("every declared route rejects an undeclared method before auth and preserves the exact Allow set", async () => {
  const token = "phase11-method-table-token-12345";
  const app = createBackendApp({ internalToken: token, csrfRequired: true });
  try {
    for (const contract of API_ROUTE_CONTRACTS) {
      const acceptedMethod = contract.methods[0];
      const headers = { "x-backend-token": token, "content-type": "application/json", origin: "http://localhost" };
      const accepted = await app.handle(new Request("http://localhost/api/v1" + contract.example, { method: acceptedMethod, headers, body: acceptedMethod === "GET" ? undefined : "{}" }));
      assert.notEqual(accepted.status, 405, `${acceptedMethod} ${contract.example} must reach its real auth/handler boundary`);
      const rejected = await app.handle(new Request("http://localhost/api/v1" + contract.example, { method: "OPTIONS", headers }));
      assert.equal(rejected.status, 405, `OPTIONS ${contract.example}`);
      assert.equal(rejected.headers.get("allow"), allowedMethodsForPath(contract.example).join(", "), contract.example);
    }
    const verifyAsGet = await app.handle(new Request("http://localhost/api/v1/admin/backups/backup-1/verify", { headers: { "x-backend-token": token } }));
    assert.equal(verifyAsGet.status, 405);
    assert.equal(verifyAsGet.headers.get("allow"), "POST");
  } finally { app.close(); }
});

test("legacy AI mutation aliases preserve method and body while advertising deprecation and sunset", async () => {
  const token = "phase11-routing-token-123456789";
  const app = createBackendApp({ internalToken: token, aiMasterKey: randomBytes(32).toString("base64") });
  function req(path, method, body, cookie = "") {
    const headers = new Headers({ "x-backend-token": token, "content-type": "application/json", "origin": "http://localhost" });
    if (cookie) headers.set("cookie", cookie);
    return new Request("http://localhost/api/v1" + path, { method, headers, body: JSON.stringify(body) });
  }
  try {
    const record = app.services.education.createInitialAdmin({ username: "routing-admin", chineseName: "管理員" });
    const login = await app.handle(req("/auth/login", "POST", { username: "routing-admin", password: record.initialPassword }));
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    await app.handle(req("/auth/password", "POST", { newPassword: "Routing-Test-Strong-1!" }, cookie));
    const legacy = await app.handle(req("/admin/ai-provider", "POST", { providerKey: "openai-compatible:legacy", displayName: "Legacy", apiBaseUrl: "http://127.0.0.1:9/v1", apiPath: "/chat/completions", timeoutMs: 1000, defaultModel: "legacy-model", apiKey: "legacy-test-key", enabled: false }, cookie));
    assert.equal(legacy.status, 200);
    assert.equal(legacy.headers.get("deprecation"), "true");
    assert.match(legacy.headers.get("sunset"), /2027/);
    assert.match(legacy.headers.get("link"), /\/api\/v1\/admin\/ai\/providers/);
    const wrongMethod = await app.handle(req("/admin/ai-provider", "PATCH", {}, cookie));
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
    const putTeacher = app.services.education.createUser({ id: record.user.id, role: "admin" }, { role: "teacher", username: "routing-put-teacher", chineseName: "相容教師" });
    const course = app.services.education.createCourse({ id: record.user.id, role: "admin" }, { titleZh: "PUT 相容課程", teacherId: putTeacher.user.id });
    const legacyPut = await app.handle(req(`/courses/${course.id}`, "PUT", { titleZh: "PUT 相容更新" }, cookie));
    assert.equal(legacyPut.status, 200);
    assert.equal(legacyPut.headers.get("deprecation"), "true");
    assert.match(legacyPut.headers.get("link"), new RegExp(`/api/v1/courses/${course.id}`));
    assert.match((await legacyPut.json()).course.title_zh, /PUT/);
  } finally { app.close(); }
});
