import assert from "node:assert/strict";
import test from "node:test";

const { QuestionService, AssignmentService } = await import("../server/content.ts");
const { ExecutionService } = await import("../server/execution.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("automatic grading reads only immutable snapshot test cases and updates the grade", async () => {
  const fixture = await makeContentFixture();
  try {
    const questions = new QuestionService(fixture.db);
    const assignments = new AssignmentService(fixture.db);
    const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "python_code", titleZh: "固定評分題", promptZh: "輸出", starterCode: "", solutionCode: "print(1)", maxScore: 12 });
    questions.addTestCase(fixture.teacher, question.id, { visibility: "public", inputJson: JSON.stringify("one"), expectedOutput: "ONE", comparisonMode: "exact", weight: 1 });
    questions.addTestCase(fixture.teacher, question.id, { visibility: "hidden", inputJson: JSON.stringify("two"), expectedOutput: "TWO_SECRET_CANARY", comparisonMode: "exact", weight: 1 });
    questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
    const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "固定評分功課" });
    assignments.addQuestion(fixture.teacher, assignment.id, question.id);
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    const submission = assignments.beginSubmission(fixture.student, assignment.id);
    const runner = {
      async execute(input) {
        return { stdout: input.stdin === "one" ? "ONE" : "TWO_SECRET_CANARY", stderr: "", exit_code: 0, timed_out: false, output_limited: false, duration_ms: 1 };
      },
    };
    const execution = new ExecutionService(fixture.db, runner, { runnerVersion: "grading-fixture" });
    const run = await execution.grade(fixture.student, submission.answers[0].id, "print(input())");
    assert.equal(run.status, "passed");
    assert.equal(run.testResults.length, 2);
    assert.equal(run.testResults[0].status, "passed");
    assert.equal(run.testResults[1].status, "passed");
    const grade = fixture.db.get("SELECT auto_score, final_score, max_score, status FROM grades WHERE submission_id = ?", [submission.id]);
    assert.equal(grade.auto_score, 12);
    assert.equal(grade.final_score, 12);
    assert.equal(grade.max_score, 12);
    assert.equal(grade.status, "review_required");
    const before = fixture.db.get("SELECT question_snapshot_json FROM submission_answers WHERE id = ?", [submission.answers[0].id]).question_snapshot_json;
    questions.updateQuestion(fixture.teacher, question.id, { titleZh: "題目後來改名", solutionCode: "print('other')" });
    const after = fixture.db.get("SELECT question_snapshot_json FROM submission_answers WHERE id = ?", [submission.answers[0].id]).question_snapshot_json;
    assert.equal(after, before);
  } finally {
    await fixture.close();
  }
});
