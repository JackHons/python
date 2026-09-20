import assert from "node:assert/strict";
import test from "node:test";

const { QuestionService, AssignmentService } = await import("../server/content.ts");
const { ExecutionService } = await import("../server/execution.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("hidden test input, expected output, weight, trace and stderr never reach student projection", async () => {
  const fixture = await makeContentFixture();
  try {
    const questions = new QuestionService(fixture.db);
    const assignments = new AssignmentService(fixture.db);
    const canary = "HIDDEN_SECRET_CANARY_91c4";
    const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "python_code", titleZh: "安全投影", promptZh: "執行", starterCode: "", solutionCode: "print(1)", maxScore: 5 });
    questions.addTestCase(fixture.teacher, question.id, { visibility: "public", inputJson: JSON.stringify("public"), expectedOutput: "ok", comparisonMode: "exact" });
    questions.addTestCase(fixture.teacher, question.id, { visibility: "hidden", inputJson: JSON.stringify(canary), expectedOutput: canary + "-expected", comparisonMode: "exact", weight: 99 });
    questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
    const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "安全投影功課" });
    assignments.addQuestion(fixture.teacher, assignment.id, question.id);
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    const submission = assignments.beginSubmission(fixture.student, assignment.id);
    const execution = new ExecutionService(fixture.db, {
      async execute(input) {
        return { stdout: "wrong", stderr: input.stdin === "public" ? "" : canary + "-stderr-trace", exit_code: 0, timed_out: false, output_limited: false, duration_ms: 1 };
      },
    });
    const run = await execution.grade(fixture.student, submission.answers[0].id, "print(input())");
    const studentPayload = execution.getRun(fixture.student, run.id);
    assert.equal(studentPayload.testResults.length, 2);
    assert.equal(studentPayload.testResults[1].status, "failed");
    assert.equal(studentPayload.testResults[1].errorCode, "test_failed");
    assert.equal(JSON.stringify(studentPayload).includes(canary), false);
    assert.equal("expectedOutput" in studentPayload.testResults[1], false);
    assert.equal("inputJson" in studentPayload.testResults[1], false);
    assert.equal("scoreAwarded" in studentPayload.testResults[1], false);
    const internal = fixture.db.get("SELECT test_case_snapshot_json FROM test_results WHERE code_run_id = ? AND test_case_id = (SELECT id FROM test_cases WHERE question_id = ? AND visibility = 'hidden')", [run.id, question.id]);
    assert.equal(internal.test_case_snapshot_json.includes(canary), true);
  } finally {
    await fixture.close();
  }
});
