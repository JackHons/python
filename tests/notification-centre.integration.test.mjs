import assert from "node:assert/strict";
import test from "node:test";

const { DomainError } = await import("../server/errors.ts");
const { AssignmentService, QuestionService } = await import("../server/content.ts");
const { NotificationService } = await import("../server/notifications.ts");
const { createBackendApp } = await import("../server/http/backend.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("announcement management is rechecked against current teacher scope", async () => {
  const fixture = await makeContentFixture();
  try {
    const service = new NotificationService(fixture.db);
    const announcement = service.createAnnouncement(fixture.teacher, { courseId: fixture.course.id, titleZh: "範圍公告", bodyZh: "內容" });
    assert.equal(service.listAnnouncements(fixture.teacher).some((item) => item.id === announcement.id), true);
    const otherTeacherRecord = fixture.education.createUser(fixture.admin, { role: "teacher", username: "scope-announcement-owner", chineseName: "另一位教師" });
    fixture.db.run("UPDATE courses SET owner_teacher_id = ? WHERE id = ?", [otherTeacherRecord.user.id, fixture.course.id]);
    fixture.db.run("UPDATE class_memberships SET status = 'archived' WHERE class_id = ? AND user_id = ? AND member_role = 'teacher'", [fixture.db.get("SELECT id FROM classes LIMIT 1").id, fixture.teacher.id]);
    assert.equal(service.listAnnouncements(fixture.teacher).some((item) => item.id === announcement.id), false);
    for (const operation of [() => service.updateAnnouncement(fixture.teacher, announcement.id, { courseId: fixture.course.id, titleZh: "改寫", bodyZh: "不可見" }), () => service.previewAnnouncement(fixture.teacher, announcement.id)]) {
      assert.throws(operation, (error) => error instanceof DomainError && error.code === "not_found" && error.status === 404);
    }
    assert.throws(() => service.publishAnnouncement(fixture.teacher, announcement.id, "revoked-publish"), (error) => error instanceof DomainError && error.code === "not_found" && error.status === 404);
  } finally {
    await fixture.close();
  }
});

test("announcement management and notification reads enforce role and recipient boundaries", async () => {
  const fixture = await makeContentFixture();
  try {
    const service = new NotificationService(fixture.db);
    const announcement = service.createAnnouncement(fixture.teacher, { courseId: fixture.course.id, titleZh: "角色公告", bodyZh: "內容" });
    const managementCalls = [
      () => service.listAnnouncements(fixture.student),
      () => service.createAnnouncement(fixture.student, { courseId: fixture.course.id, titleZh: "越權", bodyZh: "不可" }),
      () => service.updateAnnouncement(fixture.student, announcement.id, { courseId: fixture.course.id, titleZh: "越權", bodyZh: "不可" }),
      () => service.previewAnnouncement(fixture.student, announcement.id),
      () => service.publishAnnouncement(fixture.student, announcement.id, "student-publish"),
    ];
    for (const operation of managementCalls) assert.throws(operation, (error) => error instanceof DomainError && error.code === "forbidden" && error.status === 403);
    const published = service.publishAnnouncement(fixture.teacher, announcement.id, "recipient-read");
    const otherStudentRecord = fixture.education.createUser(fixture.admin, { role: "student", username: "other-notification-reader", chineseName: "另一位學生", studentNumber: "S0003" });
    assert.throws(() => service.markRead({ id: otherStudentRecord.user.id, role: "student" }, published.notificationIds[0]), (error) => error instanceof DomainError && error.code === "forbidden" && error.status === 403);
    assert.equal(fixture.db.get("SELECT read_at FROM notifications WHERE id = ?", [published.notificationIds[0]]).read_at, null);
  } finally {
    await fixture.close();
  }
});

test("notification events expose canonical student deep links", async () => {
  const fixture = await makeContentFixture();
  try {
    const assignments = new AssignmentService(fixture.db);
    const questions = new QuestionService(fixture.db);
    const service = new NotificationService(fixture.db);
    const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "short_answer", titleZh: "通知題目", promptZh: "回答" });
    questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
    const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "通知功課" });
    assignments.addQuestion(fixture.teacher, assignment.id, question.id);
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    service.notifyAssignmentPublished(fixture.teacher, assignment.id, "canonical-assignment");
    service.notifyDueReminder(fixture.teacher, assignment.id, "canonical-due");
    const submission = assignments.beginSubmission(fixture.student, assignment.id);
    assignments.saveAnswer(fixture.student, submission.id, question.id, { answerText: "答案" });
    assignments.submit(fixture.student, submission.id);
    assignments.grade(fixture.teacher, submission.id, { questionId: question.id, score: 1, feedback: "良好" });
    assignments.releaseGrade(fixture.teacher, submission.id);
    service.notifyGradeReleased(fixture.teacher, submission.id, "canonical-grade");
    assert.equal(fixture.db.get("SELECT link_path FROM notifications WHERE source_key = ?", ["canonical-assignment"]).link_path, `/student/courses/${fixture.course.id}/assignments/${assignment.id}`);
    assert.equal(fixture.db.get("SELECT link_path FROM notifications WHERE source_key = ?", ["canonical-due"]).link_path, `/student/courses/${fixture.course.id}/assignments/${assignment.id}`);
    assert.equal(fixture.db.get("SELECT link_path FROM notifications WHERE source_key = ?", ["canonical-grade"]).link_path, `/student/practice/${submission.id}`);
  } finally {
    await fixture.close();
  }
});

test("admin email HTTP routes reject teacher and student sessions", async () => {
  const token = "notification-email-rbac-token-123456";
  const app = createBackendApp({ internalToken: token, csrfRequired: true });
  const request = (path, method = "GET", body, cookie = "") => {
    const headers = new Headers({ "x-backend-token": token, origin: "http://localhost", "content-type": "application/json" });
    if (cookie) headers.set("cookie", cookie);
    return new Request("http://localhost/api/v1" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  async function readyCookie(username, initialPassword, nextPassword) {
    const login = await app.handle(request("/auth/login", "POST", { username, password: initialPassword }));
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    assert.equal((await app.handle(request("/auth/password", "POST", { newPassword: nextPassword }, cookie))).status, 200);
    return cookie;
  }
  try {
    const adminRecord = app.services.education.createInitialAdmin({ username: "notification-email-admin", chineseName: "通知管理員" });
    const admin = { id: adminRecord.user.id, role: "admin" };
    const teacher = app.services.education.createUser(admin, { role: "teacher", username: "notification-email-teacher", chineseName: "通知教師" });
    const student = app.services.education.createUser(admin, { role: "student", username: "notification-email-student", chineseName: "通知學生", studentNumber: "N0001" });
    const teacherCookie = await readyCookie("notification-email-teacher", teacher.initialPassword, "Notification-Teacher-Strong-1!");
    const studentCookie = await readyCookie("notification-email-student", student.initialPassword, "Notification-Student-Strong-1!");
    for (const cookie of [teacherCookie, studentCookie]) {
      assert.equal((await app.handle(request("/admin/email", "GET", undefined, cookie))).status, 403);
      assert.equal((await app.handle(request("/admin/email/settings", "GET", undefined, cookie))).status, 403);
      assert.equal((await app.handle(request("/admin/email/process", "POST", {}, cookie))).status, 403);
      assert.equal((await app.handle(request("/admin/email/delivery-1/retry", "POST", {}, cookie))).status, 403);
      assert.equal((await app.handle(request("/admin/email/delivery-1/cancel", "POST", {}, cookie))).status, 403);
    }
  } finally {
    app.close();
  }
});
