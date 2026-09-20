import assert from "node:assert/strict";
import test from "node:test";

const { QuestionService, AssignmentService } = await import("../server/content.ts");
const { ExecutionService } = await import("../server/execution.ts");
const { SimilarityService } = await import("../server/similarity.ts");
const { DomainError } = await import("../server/errors.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("code similarity compares submitted code, persists teacher-review reports, and protects student scope", async () => {
  const fixture = await makeContentFixture();
  try {
    const secondRecord = fixture.education.createUser(fixture.admin, { role: "student", username: "fixture-second", chineseName: "第二學生", studentNumber: "S0002" });
    const secondStudent = { id: secondRecord.user.id, role: "student" };
    fixture.education.joinCourseByCode(secondStudent, "PYTEST1");
    const questions = new QuestionService(fixture.db);
    const assignments = new AssignmentService(fixture.db);
    const similarity = new SimilarityService(fixture.db);
    const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "python_code", titleZh: "相似度題", promptZh: "寫函式", starterCode: "", maxScore: 10 });
    questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
    const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, kind: "homework", titleZh: "相似度作業" });
    assignments.addQuestion(fixture.teacher, assignment.id, question.id);
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    const first = assignments.beginSubmission(fixture.student, assignment.id);
    const second = assignments.beginSubmission(secondStudent, assignment.id);
    assignments.saveAnswer(fixture.student, first.id, question.id, { answerText: "def add(value):\n    return value + 1\n" });
    assignments.saveAnswer(secondStudent, second.id, question.id, { answerText: "def total(number):\n    return number + 1\n" });
    const runner = new ExecutionService(fixture.db, { execute: async () => ({ stdout: "", stderr: "", exit_code: 0, timed_out: false, output_limited: false }) });
    runner.createCodeSnapshot(fixture.student, first.answers[0].id, "def add(value):\n    return value + 1\n", "submit");
    runner.createCodeSnapshot(secondStudent, second.answers[0].id, "def total(number):\n    return number + 1\n", "submit");
    assignments.submit(fixture.student, first.id);
    assignments.submit(secondStudent, second.id);

    const result = similarity.run(fixture.teacher, fixture.course.id, { assignmentId: assignment.id, threshold: 0.8 });
    assert.equal(result.comparedAnswers, 2);
    assert.equal(result.reports.length, 1);
    assert.equal(result.reports[0].status, "pending_review");
    assert.equal(result.reports[0].similarity, 1);
    assert.throws(() => similarity.list(fixture.student, fixture.course.id), (error) => error instanceof DomainError && error.code === "forbidden");
    const confirmed = similarity.review(fixture.teacher, result.reports[0].id, "confirmed", "教師已核對解法脈絡");
    assert.equal(confirmed.status, "confirmed");
    assert.equal(similarity.list(fixture.teacher, fixture.course.id, assignment.id)[0].review_comment, "教師已核對解法脈絡");
  } finally {
    await fixture.close();
  }
});
