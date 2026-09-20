import assert from "node:assert/strict";
import test from "node:test";

const { QuestionService, AssignmentService } = await import("../server/content.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("repeated and concurrent start requests converge on one attempt and question set", async () => {
  const fixture = await makeContentFixture();
  try {
    const questions = new QuestionService(fixture.db);
    const assignments = new AssignmentService(fixture.db);
    const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "python_code", titleZh: "程式題", promptZh: "輸出結果", starterCode: "", solutionCode: "print(1)", maxScore: 5 });
    questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
    const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "提交測試", randomizeOrder: true, maxAttempts: 1 });
    assignments.addQuestion(fixture.teacher, assignment.id, question.id);
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    const [one, two, three] = await Promise.all([
      Promise.resolve().then(() => assignments.beginSubmission(fixture.student, assignment.id)),
      Promise.resolve().then(() => assignments.beginSubmission(fixture.student, assignment.id)),
      Promise.resolve().then(() => assignments.beginSubmission(fixture.student, assignment.id)),
    ]);
    assert.equal(one.id, two.id);
    assert.equal(two.id, three.id);
    assert.deepEqual(one.answers.map((answer) => answer.questionId), three.answers.map((answer) => answer.questionId));
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM submissions WHERE assignment_id = ? AND student_id = ?", [assignment.id, fixture.student.id]).count, 1);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM submission_answers WHERE submission_id = ?", [one.id]).count, 1);
    const snapshot = JSON.parse(fixture.db.get("SELECT question_snapshot_json FROM submission_answers WHERE submission_id = ?", [one.id]).question_snapshot_json);
    assert.equal(snapshot.testCases.length, 0);
    assert.equal("solutionCode" in one.answers[0].question, false);
  } finally {
    await fixture.close();
  }
});
