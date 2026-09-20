import assert from "node:assert/strict";
import test from "node:test";
import { createBackendApp } from "../server/http/backend.ts";
import { ClassroomService } from "../server/classroom.ts";
import { AssignmentService, QuestionService } from "../server/content.ts";
import { makeContentFixture } from "./content-helpers.mjs";

const internalToken = "phase11-classroom-token-123456789";
function request(path, method = "GET", body, cookie = "") {
  const headers = new Headers({ "x-backend-token": internalToken });
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined) { headers.set("content-type", "application/json"); headers.set("origin", "http://localhost"); }
  return new Request("http://localhost/api/v1" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function payload(response) { return response.json(); }
async function loginReady(app, username, initialPassword, newPassword) {
  const first = await app.handle(request("/auth/login", "POST", { username, password: initialPassword }));
  const cookie = first.headers.get("set-cookie").split(";", 1)[0];
  assert.equal((await app.handle(request("/auth/password", "POST", { newPassword }, cookie))).status, 200);
  return cookie;
}

function createPublishedAssignment(fixture) {
  const questions = new QuestionService(fixture.db);
  const assignments = new AssignmentService(fixture.db);
  const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "short_answer", titleZh: "課堂答案", promptZh: "輸入答案", maxScore: 2 });
  questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
  const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "即時課堂功課" });
  assignments.addQuestion(fixture.teacher, assignment.id, question.id);
  assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
  return { assignments, assignment, question };
}

test("lock and ended classroom states guard every student write and preserve a read-only replay", async () => {
  const fixture = await makeContentFixture();
  try {
    const { assignments, assignment, question } = createPublishedAssignment(fixture);
    const classroom = new ClassroomService(fixture.db);
    const session = classroom.createSession(fixture.teacher, { courseId: fixture.course.id, title: "安全課堂" });
    const activity = classroom.createActivity(fixture.teacher, session.session.id, { title: "限時答題", assignmentId: assignment.id });
    classroom.startActivity(fixture.teacher, activity.id, "start-once");
    const submission = assignments.beginSubmission(fixture.student, assignment.id);
    assignments.saveAnswer(fixture.student, submission.id, question.id, { answerText: "before lock" });

    classroom.lockActivity(fixture.teacher, activity.id, "lock-once");
    assert.throws(() => assignments.saveAnswer(fixture.student, submission.id, question.id, { answerText: "blocked" }), { code: "activity_locked", status: 423 });
    assert.throws(() => assignments.submit(fixture.student, submission.id), { code: "activity_locked", status: 423 });

    classroom.reopenActivity(fixture.teacher, activity.id, "reopen-once");
    assignments.saveAnswer(fixture.student, submission.id, question.id, { answerText: "after unlock" });
    const ended = classroom.endSession(fixture.teacher, session.session.id, "end-once");
    assert.equal(ended.session.status, "ended");
    assert.throws(() => assignments.saveAnswer(fixture.student, submission.id, question.id, { answerText: "after end" }), { code: "classroom_ended", status: 423 });
    assert.throws(() => assignments.submit(fixture.student, submission.id), { code: "classroom_ended", status: 423 });
    assert.throws(() => classroom.createActivity(fixture.teacher, session.session.id, { title: "late activity" }), { code: "classroom_ended", status: 409 });

    const seenBefore = fixture.db.get("SELECT last_seen_at FROM classroom_participants WHERE session_id = ? AND user_id = ?", [session.session.id, fixture.student.id]).last_seen_at;
    const restored = classroom.heartbeat(fixture.student, session.session.id);
    const seenAfter = fixture.db.get("SELECT last_seen_at FROM classroom_participants WHERE session_id = ? AND user_id = ?", [session.session.id, fixture.student.id]).last_seen_at;
    assert.equal(restored.session.status, "ended");
    assert.equal(seenAfter, seenBefore);
    const replay = classroom.eventsSince(fixture.student, session.session.id, 0);
    assert.equal(replay.events.some((event) => event.eventType === "session.end"), true);
    assert.doesNotMatch(JSON.stringify(replay), new RegExp(fixture.student.id));
  } finally { await fixture.close(); }
});

test("classroom end and incremental event HTTP routes enforce RBAC, status codes, and safe projections", async () => {
  const app = createBackendApp({ internalToken });
  try {
    const adminRecord = app.services.education.createInitialAdmin({ username: "class-admin", chineseName: "管理員" });
    const admin = { id: adminRecord.user.id, role: "admin" };
    const teacherRecord = app.services.education.createUser(admin, { role: "teacher", username: "class-teacher", chineseName: "教師" });
    const otherTeacherRecord = app.services.education.createUser(admin, { role: "teacher", username: "other-teacher", chineseName: "其他教師" });
    const studentRecord = app.services.education.createUser(admin, { role: "student", username: "class-student", chineseName: "學生", studentNumber: "CL001" });
    const teacher = { id: teacherRecord.user.id, role: "teacher" };
    const student = { id: studentRecord.user.id, role: "student" };
    const [teacherCookie, otherTeacherCookie, studentCookie] = await Promise.all([
      loginReady(app, "class-teacher", teacherRecord.initialPassword, "Test-Teacher-Classroom-1!"),
      loginReady(app, "other-teacher", otherTeacherRecord.initialPassword, "Test-Other-Classroom-1!"),
      loginReady(app, "class-student", studentRecord.initialPassword, "Test-Student-Classroom-1!"),
    ]);
    const course = app.services.education.createCourse(teacher, { titleZh: "HTTP 課堂", joinCode: "HTTPCLASS" });
    app.services.education.updateCourse(teacher, course.id, { status: "published" });
    app.services.education.joinCourseByCode(student, "HTTPCLASS");

    const createdResponse = await app.handle(request("/classrooms", "POST", { courseId: course.id, title: "HTTP Live" }, teacherCookie));
    assert.equal(createdResponse.status, 201);
    const created = await payload(createdResponse);
    const sessionId = created.classroom.session.id;
    assert.equal((await app.handle(request(`/classrooms/${sessionId}/join`, "POST", {}, studentCookie))).status, 200);
    assert.equal((await app.handle(request(`/classrooms/${sessionId}/end`, "POST", { idempotencyKey: "http-end" }, otherTeacherCookie))).status, 403);
    const endedResponse = await app.handle(request(`/classrooms/${sessionId}/end`, "POST", { idempotencyKey: "http-end" }, teacherCookie));
    assert.equal(endedResponse.status, 200);
    assert.equal((await payload(endedResponse)).classroom.session.status, "ended");
    const replayResponse = await app.handle(request(`/classrooms/${sessionId}/events?since=0`, "GET", undefined, studentCookie));
    assert.equal(replayResponse.status, 200);
    const replay = await payload(replayResponse);
    assert.equal(replay.events.some((event) => event.eventType === "session.end"), true);
    assert.doesNotMatch(JSON.stringify(replay), new RegExp(student.id));
    assert.equal((await app.handle(request(`/classrooms/${sessionId}/events?since=-1`, "GET", undefined, teacherCookie))).status, 400);
    const wrongMethod = await app.handle(request(`/classrooms/${sessionId}/end`, "GET", undefined, teacherCookie));
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
  } finally { app.close(); }
});

test("classroom UI and typed client expose reachable list/detail, polling, controls, and read-only states", async () => {
  const { readFile } = await import("node:fs/promises");
  const [page, client] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/api-client.ts", import.meta.url), "utf8"),
  ]);
  for (const marker of ["/student/classrooms/", "/teacher/classrooms/", "joinClassroom", "heartbeatClassroom", "classroomEvents", "endClassroom", "解除鎖定", "匿名答案", "唯讀記錄"]) assert.match(page + client, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(page, /發布題目（待選擇課堂）|選擇活動後鎖定/);
});
