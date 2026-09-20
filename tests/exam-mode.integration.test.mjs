import assert from "node:assert/strict";
import test from "node:test";

const { MaterialService, QuestionService, AssignmentService } = await import("../server/content.ts");
const { ExamService } = await import("../server/exam.ts");
const { AiService, FakeAiProvider } = await import("../server/ai.ts");
const { DomainError } = await import("../server/errors.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("exam mode applies server resource guards and records idempotent tab events", async () => {
  const fixture = await makeContentFixture();
  try {
    const materials = new MaterialService(fixture.db, fixture.storage);
    const questions = new QuestionService(fixture.db);
    const assignments = new AssignmentService(fixture.db);
    const exams = new ExamService(fixture.db);
    const ai = new AiService(fixture.db, new FakeAiProvider());
    const material = await materials.createMaterial(fixture.teacher, fixture.unit.id, { kind: "web_content", titleZh: "考試教材", bodyZh: "不應在考試中讀取" });
    materials.updateMaterial(fixture.teacher, material.id, { status: "published" });
    const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "short_answer", titleZh: "考試題", promptZh: "回答", maxScore: 10 });
    questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
    const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, kind: "exam", titleZh: "第一次考試", examMode: true });
    assignments.addQuestion(fixture.teacher, assignment.id, question.id);
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published", examMode: true });
    const submission = assignments.beginSubmission(fixture.student, assignment.id);

    assert.throws(() => fixture.education.listUnits(fixture.student, fixture.course.id), (error) => error instanceof DomainError && error.code === "exam_mode_restriction");
    assert.throws(() => materials.listMaterials(fixture.student, fixture.unit.id), (error) => error instanceof DomainError && error.code === "exam_mode_restriction");
    assert.throws(() => ai.startConversation(fixture.student, fixture.course.id), (error) => error instanceof DomainError && error.code === "exam_mode_restriction");
    assert.throws(() => questions.studentHintState(fixture.student, submission.id, question.id), (error) => error instanceof DomainError && error.code === "exam_mode_restriction");

    const firstEvent = exams.recordEvent(fixture.student, submission.id, { eventType: "tab_hidden", idempotencyKey: "tab-1", pagePath: "/student/practice/" + submission.id, payload: { visibilityState: "hidden" } });
    const replay = exams.recordEvent(fixture.student, submission.id, { eventType: "tab_hidden", idempotencyKey: "tab-1", pagePath: "/student/practice/" + submission.id });
    assert.equal(firstEvent.replay, false);
    assert.equal(replay.replay, true);
    assert.equal(exams.listEvents(fixture.student, submission.id).length, 1);
    assert.equal(exams.listEvents(fixture.teacher, submission.id).length, 1);

    const second = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, kind: "exam", titleZh: "第二次考試", examMode: true });
    assignments.addQuestion(fixture.teacher, second.id, question.id);
    assignments.updateAssignment(fixture.teacher, second.id, { status: "published", examMode: true });
    assert.throws(() => assignments.beginSubmission(fixture.student, second.id), (error) => error instanceof DomainError && error.code === "exam_in_progress");
    assert.throws(() => assignments.updateAssignment(fixture.teacher, assignment.id, { examMode: false }), (error) => error instanceof DomainError && error.code === "exam_in_progress");

    assignments.submit(fixture.student, submission.id);
    assert.equal(materials.listMaterials(fixture.student, fixture.unit.id).length, 1);
  } finally {
    await fixture.close();
  }
});
