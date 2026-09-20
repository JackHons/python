import assert from "node:assert/strict";
import test from "node:test";

const { QuestionService, AssignmentService } = await import("../server/content.ts");
const { ExecutionService } = await import("../server/execution.ts");
import { makeContentFixture } from "./content-helpers.mjs";

async function createTwoQuestionAssignment(fixture) {
  const questions = new QuestionService(fixture.db);
  const assignments = new AssignmentService(fixture.db);
  const code = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "python_code", titleZh: "程式題", promptZh: "輸出 ok", starterCode: "", solutionCode: "print('ok')", maxScore: 10 });
  questions.addTestCase(fixture.teacher, code.id, { visibility: "public", inputJson: JSON.stringify("ok"), expectedOutput: "ok", comparisonMode: "exact", weight: 1 });
  questions.updateQuestion(fixture.teacher, code.id, { status: "published" });
  const short = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "short_answer", titleZh: "短答題", promptZh: "說明", maxScore: 5 });
  questions.updateQuestion(fixture.teacher, short.id, { status: "published" });
  const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "逐題批改測試", maxAttempts: 2, allowResubmit: true });
  assignments.addQuestion(fixture.teacher, assignment.id, code.id);
  assignments.addQuestion(fixture.teacher, assignment.id, short.id);
  assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
  return { questions, assignments, code, short, assignment };
}

test("teacher grading keeps multi-question state incomplete until every answer is confirmed", async () => {
  const fixture = await makeContentFixture();
  try {
    const { assignments, code, short, assignment } = await createTwoQuestionAssignment(fixture);
    const started = assignments.beginSubmission(fixture.student, assignment.id);
    const runner = { async execute() { return { stdout: "ok", stderr: "", exit_code: 0, timed_out: false, output_limited: false, duration_ms: 1 }; } };
    const execution = new ExecutionService(fixture.db, runner, { runnerVersion: "workflow-fixture" });
    const codeAnswer = started.answers.find((answer) => answer.questionId === code.id);
    const shortAnswer = started.answers.find((answer) => answer.questionId === short.id);
    assert.ok(codeAnswer);
    assert.ok(shortAnswer);

    await execution.grade(fixture.student, codeAnswer.id, "print('ok')");
    const preSubmitGrade = fixture.db.get("SELECT auto_score, max_score, status FROM grades WHERE submission_id = ?", [started.id]);
    assert.deepEqual({ ...preSubmitGrade }, { auto_score: 10, max_score: 15, status: "review_required" });

    assignments.saveAnswer(fixture.student, started.id, code.id, { answerText: "print('ok')" });
    assignments.saveAnswer(fixture.student, started.id, short.id, { answerText: "答案" });
    const submitted = assignments.submit(fixture.student, started.id);
    assert.equal(submitted.status, "submitted");
    assert.equal(submitted.maxScore, 15);
    assert.equal(submitted.gradeStatus, "review_required");
    const staffSubmitted = assignments.getSubmission(fixture.teacher, started.id);
    assert.deepEqual(staffSubmitted.answers.map((answer) => answer.reviewStatus), ["pending", "pending"]);

    assert.throws(() => assignments.releaseGrade(fixture.teacher, started.id), (error) => error?.code === "grade_not_ready" && error?.status === 409);
    assert.throws(() => assignments.grade(fixture.student, started.id, { questionId: code.id, score: 1 }), (error) => error?.status === 403);
    assert.throws(() => assignments.grade(fixture.teacher, started.id, { questionId: code.id, score: Number.NaN }), (error) => error?.code === "invalid_input");
    assert.throws(() => assignments.grade(fixture.teacher, started.id, { questionId: code.id, score: 11 }), (error) => error?.code === "invalid_input");

    const first = assignments.grade(fixture.teacher, started.id, { questionId: code.id, score: 9, feedback: "程式正確" });
    assert.equal(first.status, "grading");
    assert.equal(first.gradeStatus, "review_required");
    assert.equal(first.answers.find((answer) => answer.questionId === code.id).reviewStatus, "confirmed");
    assert.equal(first.answers.find((answer) => answer.questionId === short.id).reviewStatus, "pending");
    assert.throws(() => assignments.releaseGrade(fixture.teacher, started.id), (error) => error?.status === 409);

    const complete = assignments.grade(fixture.teacher, started.id, { questionId: short.id, score: 4, feedback: "回答完整" });
    assert.equal(complete.status, "graded");
    assert.equal(complete.gradeStatus, "confirmed");
    assert.equal(complete.totalScore, 13);
    const released = assignments.releaseGrade(fixture.teacher, started.id);
    assert.equal(released.status, "released");
    assert.equal(fixture.db.get("SELECT status FROM submissions WHERE id = ?", [started.id]).status, "returned");
    const releaseAgain = assignments.releaseGrade(fixture.teacher, started.id);
    assert.equal(releaseAgain.status, "released");
    assert.throws(() => assignments.grade(fixture.teacher, started.id, { questionId: code.id, score: 8 }), (error) => error?.code === "grade_locked" && error?.status === 409);

    const draft = assignments.beginSubmission(fixture.student, assignment.id);
    assert.throws(() => assignments.grade(fixture.teacher, draft.id, { questionId: code.id, score: 1 }), (error) => error?.code === "submission_not_submitted" && error?.status === 409);
    assert.throws(() => assignments.grade(fixture.teacher, started.id, { questionId: "missing-question", score: 1 }), (error) => error?.status === 409 || error?.status === 404);
  } finally {
    await fixture.close();
  }
});

test("grading projections are scoped, bounded and use immutable question context", async () => {
  const fixture = await makeContentFixture();
  try {
    const { assignments, code, assignment } = await createTwoQuestionAssignment(fixture);
    const started = assignments.beginSubmission(fixture.student, assignment.id);
    assignments.saveAnswer(fixture.student, started.id, code.id, { answerText: "print('safe')" });
    assignments.submit(fixture.student, started.id);
    const staffView = assignments.getSubmission(fixture.teacher, started.id);
    assert.equal(staffView.student.chineseName, "測試學生");
    assert.equal(staffView.answers.length, 2);
    assert.equal("question_snapshot_json" in staffView.answers[0], false);
    assert.equal(staffView.answers[0].question.maxScore, 10);
    assert.equal(staffView.answers[0].question.testCases.some((item) => item.visibility === "hidden"), false);
    assert.equal(JSON.stringify(staffView).includes("password"), false);

    const otherTeacherResult = fixture.education.createUser(fixture.admin, { role: "teacher", username: "other-grader", chineseName: "其他教師" });
    const otherTeacher = { id: otherTeacherResult.user.id, role: "teacher" };
    assert.throws(() => assignments.getSubmission(otherTeacher, started.id), (error) => error?.status === 404);
    assert.throws(() => assignments.getSubmission(fixture.student, started.id + "-other"), (error) => error?.status === 404);

    const beforeRelease = assignments.getSubmission(fixture.student, started.id);
    assert.equal(beforeRelease.answers[0].teacherFeedback, null);
    assert.equal("answerKey" in beforeRelease.answers[0].question, false);
    assignments.grade(fixture.teacher, started.id, { questionId: code.id, score: 8, feedback: "教師意見" });
    const second = staffView.answers.find((answer) => answer.questionId !== code.id);
    assignments.grade(fixture.teacher, started.id, { questionId: second.questionId, score: 4 });
    assignments.releaseGrade(fixture.teacher, started.id);
    const afterRelease = assignments.getSubmission(fixture.student, started.id);
    assert.equal(afterRelease.answers.find((answer) => answer.questionId === code.id).teacherFeedback, "教師意見");

    fixture.db.run("UPDATE courses SET owner_teacher_id = ? WHERE id = ?", [otherTeacher.id, fixture.course.id]);
    fixture.db.run("UPDATE class_memberships SET status = 'inactive' WHERE user_id = ?", [fixture.teacher.id]);
    assert.throws(() => assignments.getSubmission(fixture.teacher, started.id), (error) => error?.status === 404);
    assert.throws(() => assignments.releaseGrade(fixture.teacher, started.id), (error) => error?.status === 404);
  } finally {
    await fixture.close();
  }
});
