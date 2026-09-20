import assert from "node:assert/strict";
import test from "node:test";

const { DomainError } = await import("../server/errors.ts");
const { AssignmentService, QuestionService } = await import("../server/content.ts");
const { NotificationService } = await import("../server/notifications.ts");
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
