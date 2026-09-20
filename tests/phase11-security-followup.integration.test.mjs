import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { AiAdminService, AiService, FakeAiProvider, MasterKeyCipher } from "../server/ai.ts";
import { ClassroomService } from "../server/classroom.ts";
import { AssignmentService, MaterialService, QuestionService } from "../server/content.ts";
import { DomainError } from "../server/errors.ts";
import { makeContentFixture } from "./content-helpers.mjs";
import { minimalPptx, storedZip } from "./zip-fixtures.mjs";

const expect404 = (operation) => assert.throws(operation, (error) => error instanceof DomainError && error.status === 404 && error.code === "not_found");

function publishedExercise(fixture) {
  const questions = new QuestionService(fixture.db);
  const assignments = new AssignmentService(fixture.db);
  const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "short_answer", titleZh: "安全題", promptZh: "回答" });
  questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
  questions.saveHint(fixture.teacher, question.id, { level: 1, contentZh: "先找關鍵字。", source: "manual" });
  const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "安全功課" });
  assignments.addQuestion(fixture.teacher, assignment.id, question.id);
  assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published", aiAssistantEnabled: true });
  return { questions, assignments, question, assignment };
}

test("unlocked hints are immutable and student submission/hint views recheck enrollment and course state", async () => {
  const fixture = await makeContentFixture();
  try {
    const { questions, assignments, question, assignment } = publishedExercise(fixture);
    const submission = assignments.beginSubmission(fixture.student, assignment.id);
    const unlocked = questions.unlockNextHint(fixture.student, submission.id, question.id, "unlock-immutable");
    assert.equal(unlocked.hintLevel, 1);
    assert.throws(() => questions.saveHint(fixture.teacher, question.id, { level: 1, contentZh: "改寫內容", source: "manual" }), (error) => error instanceof DomainError && error.code === "hint_immutable" && error.status === 409);
    assert.throws(() => questions.saveHint(fixture.teacher, question.id, { level: 1, contentZh: "AI 草稿", source: "ai" }), (error) => error instanceof DomainError && error.code === "hint_immutable" && error.status === 409);
    assert.equal(questions.studentHintState(fixture.student, submission.id, question.id).hints[0].content_zh, "先找關鍵字。");

    fixture.db.run("UPDATE course_enrollments SET status = 'inactive' WHERE course_id = ? AND student_id = ?", [fixture.course.id, fixture.student.id]);
    expect404(() => assignments.getSubmission(fixture.student, submission.id));
    expect404(() => questions.studentHintState(fixture.student, submission.id, question.id));
    fixture.db.run("UPDATE course_enrollments SET status = 'active' WHERE course_id = ? AND student_id = ?", [fixture.course.id, fixture.student.id]);
    fixture.education.archiveCourse(fixture.teacher, fixture.course.id);
    expect404(() => assignments.getSubmission(fixture.student, submission.id));
    expect404(() => questions.studentHintState(fixture.student, submission.id, question.id));
  } finally { await fixture.close(); }
});

test("classroom idempotency is transaction-stable across 100 replays and access is revoked with course scope", async () => {
  const fixture = await makeContentFixture();
  try {
    const classrooms = new ClassroomService(fixture.db);
    const session = classrooms.createSession(fixture.teacher, { courseId: fixture.course.id, title: "交易課堂" });
    classrooms.joinSession(fixture.student, session.session.id);
    const activities = await Promise.all(Array.from({ length: 100 }, () => Promise.resolve().then(() => classrooms.createActivity(fixture.teacher, session.session.id, { title: "同一活動", idempotencyKey: "activity-100" }))));
    assert.equal(new Set(activities.map((item) => item.id)).size, 1);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM classroom_events WHERE session_id = ? AND idempotency_key = 'activity-100'", [session.session.id]).count, 1);
    const activityId = activities[0].id;
    const started = await Promise.all(Array.from({ length: 100 }, () => Promise.resolve().then(() => classrooms.startActivity(fixture.teacher, activityId, "start-100"))));
    assert.equal(new Set(started.map((item) => item.session.version)).size, 1);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM classroom_events WHERE session_id = ? AND idempotency_key = 'start-100'", [session.session.id]).count, 1);
    const ended = await Promise.all(Array.from({ length: 40 }, () => Promise.resolve().then(() => classrooms.endSession(fixture.teacher, session.session.id, "end-40"))));
    assert.equal(ended.every((item) => item.session.status === "ended"), true);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM classroom_events WHERE session_id = ? AND idempotency_key = 'end-40'", [session.session.id]).count, 1);

    fixture.education.archiveCourse(fixture.teacher, fixture.course.id);
    expect404(() => classrooms.getState(fixture.teacher, session.session.id));
    expect404(() => classrooms.getState(fixture.student, session.session.id));
    expect404(() => classrooms.heartbeat(fixture.student, session.session.id));
  } finally { await fixture.close(); }
});

test("AI conversations and requests recheck published course enrollment", async () => {
  const fixture = await makeContentFixture();
  try {
    const ai = new AiService(fixture.db, new FakeAiProvider());
    const conversation = ai.startConversation(fixture.student, fixture.course.id);
    fixture.db.run("UPDATE course_enrollments SET status = 'inactive' WHERE course_id = ? AND student_id = ?", [fixture.course.id, fixture.student.id]);
    expect404(() => ai.status(fixture.student));
    expect404(() => ai.listConversation(fixture.student, conversation.id));
    await assert.rejects(() => ai.request(fixture.student, { requestKey: "inactive-course", purpose: "student_hint", task: "提示", conversationId: conversation.id }), (error) => error instanceof DomainError && error.status === 404);
    fixture.db.run("UPDATE course_enrollments SET status = 'active' WHERE course_id = ? AND student_id = ?", [fixture.course.id, fixture.student.id]);
    fixture.education.archiveCourse(fixture.teacher, fixture.course.id);
    expect404(() => ai.status(fixture.student));
    expect404(() => ai.startConversation(fixture.student, fixture.course.id));
    expect404(() => ai.listConversation(fixture.student, conversation.id));
    await assert.rejects(() => ai.request(fixture.student, { requestKey: "archived-course", purpose: "student_hint", task: "提示", conversationId: conversation.id }), (error) => error instanceof DomainError && error.status === 404);
  } finally { await fixture.close(); }
});

test("AI requests recheck assignment, question, and unit scope before provider use", async () => {
  const fixture = await makeContentFixture();
  try {
    const { questions, assignments, question, assignment } = publishedExercise(fixture);
    const admin = new AiAdminService(fixture.db, new MasterKeyCipher(randomBytes(32)));
    const providerConfig = admin.configureProvider(fixture.admin, { providerKey: "openai-compatible:scope", displayName: "Scope", apiBaseUrl: "http://127.0.0.1:9/v1", defaultModel: "scope-model", apiKey: "scope-secret", enabled: true });
    admin.updateSettings(fixture.admin, { providerConfigId: providerConfig.id, enabled: true });
    const provider = new FakeAiProvider();
    const ai = new AiService(fixture.db, provider);

    const assignmentConversation = ai.startConversation(fixture.student, fixture.course.id, assignment.id, question.id);
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "draft" });
    await assert.rejects(() => ai.request(fixture.student, { requestKey: "assignment-draft", purpose: "student_hint", task: "提示", conversationId: assignmentConversation.id }), (error) => error instanceof DomainError && error.code === "not_found" && error.status === 404);
    assert.equal(provider.calls.length, 0);
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    assignments.archiveAssignment(fixture.teacher, assignment.id);
    await assert.rejects(() => ai.request(fixture.student, { requestKey: "assignment-archived", purpose: "student_hint", task: "提示", conversationId: assignmentConversation.id }), (error) => error instanceof DomainError && error.code === "not_found" && error.status === 404);
    assert.equal(provider.calls.length, 0);

    const archivedQuestion = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, unitId: fixture.unit.id, type: "short_answer", titleZh: "封存題", promptZh: "回答" });
    questions.updateQuestion(fixture.teacher, archivedQuestion.id, { status: "published" });
    const questionConversation = ai.startConversation(fixture.student, fixture.course.id, undefined, archivedQuestion.id);
    questions.updateQuestion(fixture.teacher, archivedQuestion.id, { status: "archived" });
    await assert.rejects(() => ai.request(fixture.student, { requestKey: "question-archived", purpose: "student_hint", task: "提示", conversationId: questionConversation.id }), (error) => error instanceof DomainError && error.code === "not_found" && error.status === 404);
    assert.equal(provider.calls.length, 0);

    const unitQuestion = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, unitId: fixture.unit.id, type: "short_answer", titleZh: "單元題", promptZh: "回答" });
    questions.updateQuestion(fixture.teacher, unitQuestion.id, { status: "published" });
    const unitConversation = ai.startConversation(fixture.student, fixture.course.id, undefined, unitQuestion.id);
    fixture.db.run("UPDATE units SET status = 'archived' WHERE id = ?", [fixture.unit.id]);
    await assert.rejects(() => ai.request(fixture.student, { requestKey: "question-unit-archived", purpose: "student_hint", task: "提示", conversationId: unitConversation.id }), (error) => error instanceof DomainError && error.code === "not_found" && error.status === 404);
    assert.equal(provider.calls.length, 0);
  } finally { await fixture.close(); }
});

test("file deletion is owner/admin-only, rejects references, and material versions cannot branch", async () => {
  const fixture = await makeContentFixture();
  try {
    const materials = new MaterialService(fixture.db, fixture.storage);
    const teacherTwoRecord = fixture.education.createUser(fixture.admin, { role: "teacher", username: "delete-other", chineseName: "其他教師" });
    const teacherTwo = { id: teacherTwoRecord.user.id, role: "teacher" };
    const orphan = await materials.quarantineUpload(fixture.teacher, { originalName: "orphan.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes: minimalPptx(), purpose: "material_library" });
    await materials.releaseUpload(fixture.teacher, orphan.id);
    await assert.rejects(() => materials.deleteFileAsset(teacherTwo, orphan.id), (error) => error instanceof DomainError && error.status === 403);
    assert.equal((await materials.deleteFileAsset(fixture.teacher, orphan.id)).status, "deleted");

    const root = await materials.quarantineUpload(fixture.teacher, { originalName: "v1.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes: storedZip({ "[Content_Types].xml": "1", "_rels/.rels": "1", "ppt/presentation.xml": "1" }), purpose: "material_library" });
    await materials.releaseUpload(fixture.teacher, root.id);
    const versionTwo = await materials.quarantineUpload(fixture.teacher, { originalName: "v2.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes: storedZip({ "[Content_Types].xml": "2", "_rels/.rels": "2", "ppt/presentation.xml": "2" }), purpose: "material_library", previousAssetId: root.id });
    await materials.releaseUpload(fixture.teacher, versionTwo.id);
    await assert.rejects(() => materials.quarantineUpload(fixture.teacher, { originalName: "branch.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes: storedZip({ "[Content_Types].xml": "3", "_rels/.rels": "3", "ppt/presentation.xml": "3" }), purpose: "material_library", previousAssetId: root.id }), (error) => error instanceof DomainError && error.code === "version_conflict" && error.status === 409);
    const material = await materials.createMaterial(fixture.teacher, fixture.unit.id, { kind: "slides", titleZh: "引用教材", fileAssetId: versionTwo.id, bindingMode: "reference" });
    await materials.updateMaterial(fixture.teacher, material.id, { status: "published" });
    await assert.rejects(() => materials.deleteFileAsset(fixture.teacher, versionTwo.id), (error) => error instanceof DomainError && error.code === "dependency_conflict" && error.status === 409);
  } finally { await fixture.close(); }
});
