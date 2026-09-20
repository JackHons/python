import assert from "node:assert/strict";
import test from "node:test";

const { AnalyticsService } = await import("../server/analytics.ts");
const { QuestionService, AssignmentService } = await import("../server/content.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("analytics is scope-first, covers progress/question/errors/history/time and has explicit missing-data contracts", async () => {
  const fixture = await makeContentFixture();
  try {
    const questions = new QuestionService(fixture.db);
    const assignments = new AssignmentService(fixture.db);
    const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "short_answer", titleZh: "平均數", promptZh: "輸入答案", maxScore: 2 });
    questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
    const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "第一次功課" });
    assignments.addQuestion(fixture.teacher, assignment.id, question.id);
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    const submission = assignments.beginSubmission(fixture.student, assignment.id);
    assignments.saveAnswer(fixture.student, submission.id, question.id, { answerText: "42" });
    assignments.submit(fixture.student, submission.id);
    assignments.grade(fixture.teacher, submission.id, { questionId: question.id, score: 2 });
    const analytics = new AnalyticsService(fixture.db);
    const overview = analytics.overview(fixture.teacher, { courseId: fixture.course.id });
    assert.equal(overview.data.students.length, 1);
    assert.equal(overview.data.students[0].assignmentsCompleted, 1);
    assert.equal(overview.scope.courseId, fixture.course.id);
    assert.equal(analytics.questionAccuracy(fixture.teacher, { courseId: fixture.course.id }).data.questions.length, 1);
    assert.equal(analytics.commonErrors(fixture.teacher, { courseId: fixture.course.id }).missingData.length > 0, true);
    assert.equal(analytics.codeHistory(fixture.student, { courseId: fixture.course.id }).scope.studentId, fixture.student.id);
    assert.equal(analytics.learningTime(fixture.student, { courseId: fixture.course.id }).data.sessions.length, 0);
    assert.equal(analytics.aiUsage(fixture.student, { courseId: fixture.course.id }).data.usage.length, 0);
    assert.equal(JSON.stringify(overview).includes("測試學生"), true);
    assert.equal(analytics.overview(fixture.teacher, { courseId: fixture.course.id, studentId: fixture.student.id }).data.students.length, 1);
    const outsider = fixture.education.createUser(fixture.admin, { role: "student", username: "analytics-outsider", chineseName: "範圍外學生", studentNumber: "OUT-AN" });
    assert.throws(() => analytics.overview(fixture.teacher, { courseId: fixture.course.id, studentId: outsider.user.id }), { code: "forbidden" });
    const studentOverview = analytics.overview(fixture.student, { courseId: fixture.course.id });
    assert.equal(JSON.stringify(studentOverview).includes(fixture.teacher.id), false);
    assert.throws(() => analytics.overview(fixture.student, { courseId: fixture.course.id, studentId: fixture.teacher.id }), { code: "forbidden" });
  } finally {
    await fixture.close();
  }
});
