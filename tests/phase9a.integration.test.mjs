import assert from "node:assert/strict";
import test from "node:test";

const { DomainError } = await import("../server/errors.ts");
const { AssignmentService, MaterialService, QuestionService } = await import("../server/content.ts");
const { ExecutionService } = await import("../server/execution.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("draft and archived content stays outside every student known-id projection", async () => {
  const fixture = await makeContentFixture();
  try {
    const materials = new MaterialService(fixture.db, fixture.storage);
    const assignments = new AssignmentService(fixture.db);
    const questions = new QuestionService(fixture.db);
    const draftUnit = fixture.education.createUnit(fixture.teacher, fixture.course.id, { titleZh: "草稿單元" });
    const material = await materials.createMaterial(fixture.teacher, draftUnit.id, { kind: "web_content", titleZh: "草稿教材" });
    const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, unitId: draftUnit.id, type: "short_answer", titleZh: "草稿題", promptZh: "回答" });
    const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, unitId: draftUnit.id, titleZh: "草稿功課" });
    assignments.addQuestion(fixture.teacher, assignment.id, question.id);
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    assert.equal(fixture.education.listUnits(fixture.student, fixture.course.id).some((item) => item.id === draftUnit.id), false);
    assert.throws(() => materials.listMaterials(fixture.student, draftUnit.id), (error) => error instanceof DomainError && error.code === "not_found" && error.status === 404);
    assert.equal(assignments.listAssignments(fixture.student, fixture.course.id).some((item) => item.id === assignment.id), false);
    assert.throws(() => assignments.beginSubmission(fixture.student, assignment.id), (error) => error instanceof DomainError && error.code === "not_found" && error.status === 404);
    assert.equal(material.status ?? "draft", "draft");
  } finally { await fixture.close(); }
});

test("assignment clock policies enforce schedule, late work, attempt limits and release boundaries", async () => {
  const fixture = await makeContentFixture();
  try {
    let current = new Date("2026-08-23T10:00:00.000Z");
    const clock = () => current;
    const assignments = new AssignmentService(fixture.db, clock);
    const questions = new QuestionService(fixture.db);
    const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "short_answer", titleZh: "政策題", promptZh: "回答", answerKeyJson: { answer: "A" }, maxScore: 10 });
    questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
    const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "政策功課", publishAt: "2026-08-23T11:00:00.000Z", dueAt: "2026-08-23T12:00:00.000Z", answerReleaseAt: "2026-08-24T10:00:00.000Z", maxAttempts: 2, allowLate: false, allowResubmit: true, showScoreImmediately: false, showTestResultsImmediately: false });
    assignments.addQuestion(fixture.teacher, assignment.id, question.id);
    assignments.updateAssignment(fixture.teacher, assignment.id, { showScoreImmediately: true, showTestResultsImmediately: true });
    assignments.updateAssignment(fixture.teacher, assignment.id, { showScoreImmediately: false, showTestResultsImmediately: false });
    const roundTripPolicy = assignments.listAssignments(fixture.teacher, fixture.course.id).find((item) => item.id === assignment.id);
    assert.equal(roundTripPolicy.show_score_immediately, 0);
    assert.equal(roundTripPolicy.show_test_results_immediately, 0);
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    assert.equal(assignments.listAssignments(fixture.student, fixture.course.id).some((item) => item.id === assignment.id), false);
    assert.throws(() => assignments.beginSubmission(fixture.student, assignment.id), (error) => error instanceof DomainError && error.code === "assignment_unavailable");
    current = new Date("2026-08-23T11:30:00.000Z");
    const first = assignments.beginSubmission(fixture.student, assignment.id);
    assignments.saveAnswer(fixture.student, first.id, question.id, { answerText: "A" });
    assignments.submit(fixture.student, first.id);
    assignments.grade(fixture.teacher, first.id, { questionId: question.id, score: 8, feedback: "教師評語" });
    const beforeRelease = assignments.getSubmission(fixture.student, first.id);
    assert.equal(beforeRelease.totalScore, null);
    assert.equal(beforeRelease.answersReleased, false);
    assert.equal(beforeRelease.answers[0].teacherFeedback, null);
    assignments.releaseGrade(fixture.teacher, first.id);
    const released = assignments.getSubmission(fixture.student, first.id);
    assert.equal(released.totalScore, 8);
    assert.equal(released.answers[0].teacherFeedback, "教師評語");
    const second = assignments.beginSubmission(fixture.student, assignment.id);
    assignments.submit(fixture.student, second.id);
    assert.throws(() => assignments.beginSubmission(fixture.student, assignment.id), (error) => error instanceof DomainError && error.code === "attempt_limit");
    current = new Date("2026-08-24T10:01:00.000Z");
    assert.equal(assignments.getSubmission(fixture.student, first.id).answersReleased, true);
    assignments.updateAssignment(fixture.teacher, assignment.id, { publishAt: null, dueAt: null, answerReleaseAt: null });
    const updated = assignments.listAssignments(fixture.teacher, fixture.course.id).find((item) => item.id === assignment.id);
    assert.equal(updated.publish_at, null);
    assert.equal(updated.due_at, null);
  } finally { await fixture.close(); }
});

test("account listing is scoped and reset/archive revokes every active session", async () => {
  const fixture = await makeContentFixture();
  try {
    const otherTeacherResult = fixture.education.createUser(fixture.admin, { role: "teacher", username: "phase9-other-teacher", chineseName: "其他教師" });
    const otherStudentResult = fixture.education.createUser(fixture.admin, { role: "student", username: "phase9-other-student", chineseName: "其他學生", studentNumber: "P9002" });
    const otherTeacher = { id: otherTeacherResult.user.id, role: "teacher" };
    assert.equal(fixture.education.listUsers(fixture.teacher, { role: "student" }).some((user) => user.id === fixture.student.id), true);
    assert.equal(fixture.education.listUsers(otherTeacher, { role: "student" }).length, 0);
    const password = otherStudentResult.initialPassword;
    const login = fixture.education.login("phase9-other-student", password);
    fixture.education.resetPassword(fixture.admin, otherStudentResult.user.id);
    assert.throws(() => fixture.education.session(login.token), (error) => error instanceof DomainError && error.code === "unauthorized");
    const teacherLogin = fixture.education.login("phase9-other-teacher", otherTeacherResult.initialPassword);
    fixture.education.archiveUser(fixture.admin, otherTeacher.id);
    assert.throws(() => fixture.education.session(teacherLogin.token), (error) => error instanceof DomainError && error.code === "unauthorized");
    assert.equal(fixture.education.listUsers(fixture.admin).some((user) => user.id === otherTeacher.id), false);
  } finally { await fixture.close(); }
});

test("hidden test results obey server release policy", async () => {
  const fixture = await makeContentFixture();
  try {
    let current = new Date("2026-08-23T10:00:00.000Z");
    const questions = new QuestionService(fixture.db);
    const assignments = new AssignmentService(fixture.db, () => current);
    const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "python_code", titleZh: "程式題", promptZh: "輸出", starterCode: "print('OK')", maxScore: 5 });
    questions.addTestCase(fixture.teacher, question.id, { visibility: "hidden", inputJson: JSON.stringify("SECRET_INPUT"), expectedOutput: "OK", weight: 1 });
    questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
    const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "延遲測試", answerReleaseAt: "2026-08-24T10:00:00.000Z", showTestResultsImmediately: false });
    assignments.addQuestion(fixture.teacher, assignment.id, question.id);
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    const submission = assignments.beginSubmission(fixture.student, assignment.id);
    const runner = { async execute(input) { return { stdout: "OK", stderr: "", exit_code: 0, timed_out: false, output_limited: false, allowedPackages: input.allowedPackages }; } };
    const execution = new ExecutionService(fixture.db, runner, { clock: () => current });
    const run = await execution.grade(fixture.student, submission.answers[0].id, "print('OK')");
    assert.equal(run.testResultsReleased, false);
    assert.deepEqual(run.testResults, []);
    current = new Date("2026-08-24T10:01:00.000Z");
    const after = execution.getRun(fixture.student, run.id);
    assert.equal(after.testResultsReleased, true);
    assert.equal(after.testResults[0].status, "passed");
    assert.equal("expectedOutput" in after.testResults[0], false);
  } finally { await fixture.close(); }
});
