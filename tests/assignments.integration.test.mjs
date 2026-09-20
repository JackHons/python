import assert from "node:assert/strict";
import test from "node:test";

const { DomainError } = await import("../server/errors.ts");
const { QuestionService, AssignmentService } = await import("../server/content.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("beginning an assignment freezes selection, order, and question snapshot", async () => {
  const fixture = await makeContentFixture();
  try {
    const questions = new QuestionService(fixture.db);
    const assignmentService = new AssignmentService(fixture.db);
    const questionIds = [];
    for (let i = 1; i <= 3; i += 1) {
      const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, unitId: fixture.unit.id, type: "multiple_choice", titleZh: "題目 " + i, promptZh: "選擇答案", optionsJson: ["A", "B"], answerKeyJson: { answer: "A" }, maxScore: i });
      questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
      questionIds.push(question.id);
    }
    const assignment = assignmentService.createAssignment(fixture.teacher, { courseId: fixture.course.id, unitId: fixture.unit.id, titleZh: "隨機練習", randomizeOrder: true, questionSelectionCount: 2, allowResubmit: true, maxAttempts: 2 });
    for (const questionId of questionIds) assignmentService.addQuestion(fixture.teacher, assignment.id, questionId);
    assignmentService.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    const first = assignmentService.beginSubmission(fixture.student, assignment.id);
    const second = assignmentService.beginSubmission(fixture.student, assignment.id);
    assert.equal(first.id, second.id);
    assert.equal(first.answers.length, 2);
    assert.deepEqual(first.answers.map((answer) => answer.questionId), second.answers.map((answer) => answer.questionId));
    assert.ok(first.answers.every((answer) => answer.question && !("answerKeyJson" in answer.question)));
    const frozenTitle = first.answers[0].question.titleZh;
    questions.updateQuestion(fixture.teacher, first.answers[0].questionId, { titleZh: "原題已修改" });
    const afterEdit = assignmentService.getSubmission(fixture.student, first.id);
    assert.equal(afterEdit.answers[0].question.titleZh, frozenTitle);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM submission_answers WHERE submission_id = ?", [first.id]).count, 2);
  } finally {
    await fixture.close();
  }
});

test("submission and grading are scoped, transactional, and support immutable answers", async () => {
  const fixture = await makeContentFixture();
  try {
    const questions = new QuestionService(fixture.db);
    const assignmentService = new AssignmentService(fixture.db);
    const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "short_answer", titleZh: "簡答題", promptZh: "回答", answerKeyJson: { rubric: "manual" }, maxScore: 10 });
    questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
    const assignment = assignmentService.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "課後功課", allowLate: false });
    assignmentService.addQuestion(fixture.teacher, assignment.id, question.id);
    assignmentService.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    const draft = assignmentService.beginSubmission(fixture.student, assignment.id);
    assignmentService.saveAnswer(fixture.student, draft.id, question.id, { answerText: "我的答案" });
    const submitted = assignmentService.submit(fixture.student, draft.id);
    assert.equal(submitted.status, "submitted");
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM grades WHERE submission_id = ?", [draft.id]).count, 1);
    assert.equal(submitted.answers[0].answerText, "我的答案");
    const graded = assignmentService.grade(fixture.teacher, draft.id, { questionId: question.id, score: 8, feedback: "良好" });
    assert.equal(graded.status, "graded");
    assert.equal(graded.answers[0].final_score, 8);
    const released = assignmentService.releaseGrade(fixture.teacher, draft.id);
    assert.equal(released.status, "released");
    assert.throws(() => assignmentService.saveAnswer(fixture.student, draft.id, question.id, { answerText: "不應可修改" }), (error) => error instanceof DomainError && error.code === "submission_locked");
  } finally {
    await fixture.close();
  }
});

test("invalid publication and duplicate starts leave no partial submission", async () => {
  const fixture = await makeContentFixture();
  try {
    const assignmentService = new AssignmentService(fixture.db);
    const assignment = assignmentService.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "空作業" });
    assert.throws(() => assignmentService.updateAssignment(fixture.teacher, assignment.id, { status: "published" }), (error) => error instanceof DomainError && error.code === "invalid_assignment");
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM submissions WHERE assignment_id = ?", [assignment.id]).count, 0);
  } finally {
    await fixture.close();
  }
});

test("assignment question management supports reorder, removal, totals and dependency conflicts", async () => {
  const fixture = await makeContentFixture();
  try {
    const questions = new QuestionService(fixture.db);
    const assignments = new AssignmentService(fixture.db);
    const created = [1, 2, 3].map((n) => questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "short_answer", titleZh: `Q${n}`, promptZh: "回答", maxScore: n }));
    const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "可編輯功課" });
    created.forEach((question, position) => assignments.addQuestion(fixture.teacher, assignment.id, question.id, position));
    assert.equal(assignments.listAssignmentQuestions(fixture.teacher, assignment.id).totalScore, 6);
    const afterMiddleRemoval = assignments.removeQuestion(fixture.teacher, assignment.id, created[1].id);
    assert.deepEqual(afterMiddleRemoval.map((item) => item.question_id), [created[0].id, created[2].id]);
    assert.deepEqual(afterMiddleRemoval.map((item) => item.position), [0, 1]);
    assignments.addQuestion(fixture.teacher, assignment.id, created[1].id, 2);
    const reordered = assignments.reorderQuestions(fixture.teacher, assignment.id, [{ questionId: created[2].id, position: 0 }, { questionId: created[0].id, position: 1, scoreOverride: 5 }, { questionId: created[1].id, position: 2 }]);
    assert.deepEqual(reordered.map((item) => item.question_id), [created[2].id, created[0].id, created[1].id]);
    const repeatedReorder = assignments.reorderQuestions(fixture.teacher, assignment.id, [{ questionId: created[2].id, position: 0 }, { questionId: created[0].id, position: 1, scoreOverride: 5 }, { questionId: created[1].id, position: 2 }]);
    assert.deepEqual(repeatedReorder.map((item) => item.position), [0, 1, 2]);
    questions.updateQuestion(fixture.teacher, created[0].id, { status: "published" });
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    assignments.beginSubmission(fixture.student, assignment.id);
    const beforeDependencyConflict = assignments.listAssignmentQuestions(fixture.teacher, assignment.id).items;
    assert.throws(() => assignments.removeQuestion(fixture.teacher, assignment.id, created[1].id), (error) => error instanceof DomainError && error.code === "dependency_conflict");
    assert.deepEqual(assignments.listAssignmentQuestions(fixture.teacher, assignment.id).items.map((item) => ({ question_id: item.question_id, position: item.position })), beforeDependencyConflict.map((item) => ({ question_id: item.question_id, position: item.position })));
    assert.throws(() => questions.archiveQuestion(fixture.teacher, created[0].id), (error) => error instanceof DomainError && error.code === "dependency_conflict");
  } finally { await fixture.close(); }
});

test("all non-code answer shapes and released file references are saved without exposing answer keys", async () => {
  const fixture = await makeContentFixture();
  try {
    const questions = new QuestionService(fixture.db);
    const assignments = new AssignmentService(fixture.db);
    const types = ["multiple_choice", "fill_blank", "short_answer", "file_upload", "project_upload"];
    const created = types.map((type) => questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type, titleZh: type, promptZh: "回答", optionsJson: type === "multiple_choice" ? ["A", "B"] : undefined, maxScore: 1 }));
    const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "多題型" });
    created.forEach((question) => assignments.addQuestion(fixture.teacher, assignment.id, question.id));
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    const submission = assignments.beginSubmission(fixture.student, assignment.id);
    fixture.db.run("INSERT INTO file_assets (id, uploaded_by_id, storage_key, original_name, mime_type, byte_size, status) VALUES (?, ?, ?, ?, ?, ?, 'ready')", ["released-asset", fixture.student.id, "assets/released-asset.bin", "answer.py", "text/x-python", 4]);
    assignments.saveAnswer(fixture.student, submission.id, created[0].id, { answerText: "A", answerJson: { value: "A" } });
    assignments.saveAnswer(fixture.student, submission.id, created[1].id, { answerText: "填充" });
    assignments.saveAnswer(fixture.student, submission.id, created[3].id, { fileAssetId: "released-asset" });
  } finally { await fixture.close(); }
});
