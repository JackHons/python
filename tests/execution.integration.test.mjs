import assert from "node:assert/strict";
import test from "node:test";

const { QuestionService, AssignmentService } = await import("../server/content.ts");
const { ExecutionService } = await import("../server/execution.ts");
const { DomainError } = await import("../server/errors.ts");
import { makeContentFixture } from "./content-helpers.mjs";

function fakeRunner() {
  return {
    calls: [],
    async execute(input) {
      this.calls.push(input);
      return { stdout: this.calls.length === 1 ? "PUBLIC\n" : "wrong\n", stderr: "", exit_code: 0, timed_out: false, output_limited: false, duration_ms: 2 };
    },
  };
}

async function makeCodeAnswer(fixture) {
  const questions = new QuestionService(fixture.db);
  const assignments = new AssignmentService(fixture.db);
  const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "python_code", titleZh: "程式評分", promptZh: "輸出結果", starterCode: "", solutionCode: "print('PUBLIC')", maxScore: 10 });
  questions.addTestCase(fixture.teacher, question.id, { visibility: "public", label: "公開", inputJson: JSON.stringify("public\n"), expectedOutput: "PUBLIC\n", comparisonMode: "exact", weight: 1 });
  questions.addTestCase(fixture.teacher, question.id, { visibility: "hidden", label: "內部案例", inputJson: JSON.stringify("HIDDEN_CANARY_INPUT\n"), expectedOutput: "HIDDEN_CANARY_EXPECTED\n", comparisonMode: "exact", weight: 3 });
  questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
  const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "程式功課" });
  assignments.addQuestion(fixture.teacher, assignment.id, question.id);
  assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
  const submission = assignments.beginSubmission(fixture.student, assignment.id);
  return { question, assignments, submission };
}

test("execution records immutable code snapshots, run metadata, and fixed snapshot test results", async () => {
  const fixture = await makeContentFixture();
  try {
    const runner = fakeRunner();
    const execution = new ExecutionService(fixture.db, runner, { runnerVersion: "runner-test-1", runnerImage: "runner:test" });
    const { submission } = await makeCodeAnswer(fixture);
    const run = await execution.grade(fixture.student, submission.answers[0].id, "print('PUBLIC')", { pastedCharacterCount: 2 });
    assert.equal(run.status, "failed");
    assert.equal(run.runnerVersion, "runner-test-1");
    assert.equal(run.limits.maxOutputBytes, 65536);
    assert.equal(run.testResults.length, 2);
    assert.equal(run.testResults[0].status, "passed");
    assert.equal(run.testResults[1].status, "failed");
    const snapshot = fixture.db.get("SELECT * FROM code_snapshots WHERE id = ?", [run.snapshotId]);
    const storedRun = fixture.db.get("SELECT * FROM code_runs WHERE id = ?", [run.id]);
    assert.equal(snapshot.sha256, storedRun.code_sha256);
    assert.equal(storedRun.submission_answer_id, run.submissionAnswerId);
    assert.equal(storedRun.student_id, fixture.student.id);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM test_results WHERE code_run_id = ?", [run.id]).count, 2);
    const second = await execution.grade(fixture.student, submission.answers[0].id, "print('PUBLIC')", {});
    assert.notEqual(second.id, run.id);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM code_runs WHERE submission_answer_id = ?", [run.submissionAnswerId]).count, 2);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM code_snapshots WHERE submission_answer_id = ?", [run.submissionAnswerId]).count, 2);
  } finally {
    await fixture.close();
  }
});

test("execution is scoped to the submission answer owner", async () => {
  const fixture = await makeContentFixture();
  try {
    const execution = new ExecutionService(fixture.db, fakeRunner());
    const { submission } = await makeCodeAnswer(fixture);
    const other = fixture.education.createUser(fixture.admin, { role: "student", username: "other-execution-student", chineseName: "另一位學生", studentNumber: "S0002" });
    assert.throws(() => execution.createCodeSnapshot({ id: other.user.id, role: "student" }, submission.answers[0].id, "print(1)", "autosave"), (error) => error instanceof DomainError && error.code === "not_found" && error.status === 404);
  } finally {
    await fixture.close();
  }
});

test("student execution scope is rechecked after withdrawal and course archive", async () => {
  const fixture = await makeContentFixture();
  try {
    const runner = fakeRunner();
    const execution = new ExecutionService(fixture.db, runner);
    const { submission } = await makeCodeAnswer(fixture);
    const answerId = submission.answers[0].id;
    const run = await execution.execute(fixture.student, answerId, "print('PUBLIC')");
    const expect404 = (operation) => assert.throws(operation, (error) => error instanceof DomainError && error.code === "not_found" && error.status === 404);
    const expectAsync404 = async (operation) => assert.rejects(operation, (error) => error instanceof DomainError && error.code === "not_found" && error.status === 404);

    fixture.db.run("UPDATE course_enrollments SET status = 'inactive' WHERE course_id = ? AND student_id = ?", [fixture.course.id, fixture.student.id]);
    expect404(() => execution.createCodeSnapshot(fixture.student, answerId, "print(1)", "autosave"));
    await expectAsync404(() => execution.execute(fixture.student, answerId, "print(1)"));
    await expectAsync404(() => execution.grade(fixture.student, answerId, "print(1)"));
    expect404(() => execution.getRun(fixture.student, run.id));

    fixture.db.run("UPDATE course_enrollments SET status = 'active' WHERE course_id = ? AND student_id = ?", [fixture.course.id, fixture.student.id]);
    fixture.education.archiveCourse(fixture.teacher, fixture.course.id);
    expect404(() => execution.createCodeSnapshot(fixture.student, answerId, "print(1)", "autosave"));
    await expectAsync404(() => execution.execute(fixture.student, answerId, "print(1)"));
    await expectAsync404(() => execution.grade(fixture.student, answerId, "print(1)"));
    expect404(() => execution.getRun(fixture.student, run.id));
    assert.equal(runner.calls.length, 1);
  } finally {
    await fixture.close();
  }
});

test("runner saturation is returned as a retryable busy error", async () => {
  const fixture = await makeContentFixture();
  try {
    const { submission } = await makeCodeAnswer(fixture);
    const execution = new ExecutionService(fixture.db, {
      async execute() {
        throw new DomainError("runner_busy", "Python Runner is busy; retry later", 429);
      },
    });
    await assert.rejects(() => execution.grade(fixture.student, submission.answers[0].id, "print(1)"), (error) => error instanceof DomainError && error.code === "runner_busy" && error.status === 429);
  } finally {
    await fixture.close();
  }
});

test("execute forwards bounded stdin and grade exposes public details but hidden status only", async () => {
  const fixture = await makeContentFixture();
  try {
    const calls = [];
    const runner = { async execute(input) { calls.push(input); return { stdout: input.stdin.trim() + "\n", stderr: "", exit_code: 0, timed_out: false, output_limited: false, duration_ms: 1 }; } };
    const execution = new ExecutionService(fixture.db, runner);
    const { question, submission } = await makeCodeAnswer(fixture);
    const plain = await execution.execute(fixture.student, submission.answers[0].id, "print(input())", { stdin: "public\n" });
    assert.equal(calls[0].stdin, "public\n");
    assert.equal(plain.testResults.length, 0);
    const graded = await execution.grade(fixture.student, submission.answers[0].id, "print(input())");
    assert.equal(graded.testResults[0].expectedOutput, "PUBLIC\n");
    assert.equal("expectedOutput" in graded.testResults[1], false);
    assert.equal("inputJson" in graded.testResults[1], false);
    assert.equal(question.type, "python_code");
  } finally { await fixture.close(); }
});

test("course package policy is server-owned and forwarded to every Runner call", async () => {
  const fixture = await makeContentFixture();
  try {
    const calls = [];
    const runner = { async execute(input) { calls.push(input); return { stdout: "PUBLIC\n", stderr: "", exit_code: 0, timed_out: false, output_limited: false }; } };
    const execution = new ExecutionService(fixture.db, runner);
    const { submission } = await makeCodeAnswer(fixture);
    assert.deepEqual(execution.setPackagePolicy(fixture.teacher, fixture.course.id, ["numpy", "pandas", "matplotlib"]).allowedPackages, ["numpy", "pandas", "matplotlib"]);
    await execution.execute(fixture.student, submission.answers[0].id, "import numpy", { allowedPackages: ["flask"] });
    assert.deepEqual(calls[0].allowedPackages, ["numpy", "pandas", "matplotlib"]);
    assert.throws(() => execution.setPackagePolicy(fixture.teacher, fixture.course.id, ["flask"]), (error) => error instanceof DomainError && error.code === "package_not_allowed");
  } finally { await fixture.close(); }
});
