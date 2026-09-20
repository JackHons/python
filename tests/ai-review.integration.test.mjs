import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";

const { AiAdminService, AiReviewService, AiService, FakeAiProvider, MasterKeyCipher } = await import("../server/ai.ts");
const { MaterialService, QuestionService, AssignmentService } = await import("../server/content.ts");
const { DomainError } = await import("../server/errors.ts");
import { makeContentFixture } from "./content-helpers.mjs";

async function configure(fixture, saveConversations, clock = () => new Date("2026-08-20T12:00:00.000Z")) {
  const adminService = new AiAdminService(fixture.db, new MasterKeyCipher(randomBytes(32)), clock);
  const provider = adminService.configureProvider(fixture.admin, { providerKey: "fake", displayName: "Fake", defaultModel: "fake", apiKey: "server-only-secret", enabled: true });
  adminService.updateSettings(fixture.admin, { enabled: true, providerConfigId: provider.id, studentDailyRequestLimit: 20, schoolDailyRequestLimit: 100, studentDailyTokenLimit: 1000, schoolDailyTokenLimit: 10000, saveConversations, conversationRetentionDays: 1, timezone: "Asia/Macau" });
  return { provider, clock };
}

test("conversation saving off never stores prompt or response body; saving on is scoped and cleanable", async () => {
  const fixture = await makeContentFixture();
  try {
    const { clock } = await configure(fixture, false);
    const provider = new FakeAiProvider(async () => ({ content: "ASSISTANT_SECRET_RESPONSE", inputTokens: 3, outputTokens: 4, model: "fake" }));
    const ai = new AiService(fixture.db, provider, clock);
    const conversation = ai.startConversation(fixture.student, fixture.course.id);
    await ai.request(fixture.student, { requestKey: "privacy-off", purpose: "student_hint", task: "Explain loop", questionPrompt: "Use a loop", studentCode: "print(1)", conversationId: conversation.id, estimatedTokens: 10 });
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM ai_messages").count, 0);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM ai_usage WHERE user_id = ?", [fixture.student.id]).count, 1);

    fixture.db.run("UPDATE ai_conversations SET last_message_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", conversation.id]);
    const cleaned = ai.cleanupExpired(fixture.admin);
    assert.equal(cleaned.deletedConversations, 1);

    const configured = await configure(fixture, true);
    const savedProvider = new FakeAiProvider(async () => ({ content: "saved response", inputTokens: 1, outputTokens: 1, model: "fake" }));
    const savedAi = new AiService(fixture.db, savedProvider, configured.clock);
    const savedConversation = savedAi.startConversation(fixture.student, fixture.course.id);
    await savedAi.request(fixture.student, { requestKey: "privacy-on", purpose: "student_hint", task: "Explain loop", conversationId: savedConversation.id, estimatedTokens: 5 });
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM ai_messages WHERE conversation_id = ?", [savedConversation.id]).count, 2);
    assert.equal(savedAi.listConversation(fixture.student, savedConversation.id).messages.length, 2);
  } finally {
    await fixture.close();
  }
});

test("AI artifacts require teacher review before student publication and scores remain separate", async () => {
  const fixture = await makeContentFixture();
  try {
    const review = new AiReviewService(fixture.db);
    const artifact = review.create(fixture.teacher, { artifactType: "feedback", courseId: fixture.course.id, content: { text: "AI feedback draft" }, studentId: fixture.student.id });
    assert.throws(() => review.getStudent(fixture.student, artifact.id), (error) => error instanceof DomainError && error.code === "not_found");
    assert.throws(() => review.publish(fixture.teacher, artifact.id), (error) => error instanceof DomainError && error.code === "invalid_review_transition");
    review.review(fixture.teacher, artifact.id, "approved", "Checked by teacher");
    const published = review.publish(fixture.teacher, artifact.id);
    assert.equal(published.status, "published");
    assert.deepEqual(review.getStudent(fixture.student, artifact.id).content, { text: "AI feedback draft" });

    const questions = new QuestionService(fixture.db);
    const assignments = new AssignmentService(fixture.db);
    const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "short_answer", titleZh: "評分題", promptZh: "回答", maxScore: 10 });
    questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
    const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "評分作業" });
    assignments.addQuestion(fixture.teacher, assignment.id, question.id);
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    const submission = assignments.beginSubmission(fixture.student, assignment.id);
    const scoreArtifact = review.create(fixture.teacher, { artifactType: "suggested_score", courseId: fixture.course.id, content: { score: 7, reason: "rubric-based" }, studentId: fixture.student.id, submissionAnswerId: submission.answers[0].id });
    review.review(fixture.teacher, scoreArtifact.id, "approved");
    review.publish(fixture.teacher, scoreArtifact.id);
    const confirmed = review.confirmSuggestedScore(fixture.teacher, scoreArtifact.id);
    assert.equal(confirmed.aiSuggestedScore, 7);
    assert.equal(confirmed.finalScore, null);
  } finally {
    await fixture.close();
  }
});

test("AI artifact generation covers summary, translation, feedback and score suggestion with review gates", async () => {
  const fixture = await makeContentFixture();
  try {
    const { clock } = await configure(fixture, false);
    const provider = new FakeAiProvider(async ({ messages }) => {
      const system = messages[0].content;
      if (system.includes("material summary")) return { content: JSON.stringify({ summaryZh: "迴圈會重複執行指定區塊。", summaryEn: "Loops repeat a block.", keyPoints: ["使用條件控制重複", "注意終止條件"] }), inputTokens: 4, outputTokens: 6, model: "fake" };
      if (system.includes("Translate")) return { content: JSON.stringify({ sourceLocale: "zh-Hant", translatedText: "Loops repeat a block." }), inputTokens: 4, outputTokens: 6, model: "fake" };
      if (system.includes("Suggest a fair score")) return { content: JSON.stringify({ score: 7, reason: "答案掌握主要概念，但缺少邊界條件說明。", rubricEvidence: ["概念正確", "例外情況不完整"] }), inputTokens: 4, outputTokens: 6, model: "fake" };
      return { content: JSON.stringify({ feedbackZh: "主要概念正確，請補充邊界條件。", feedbackEn: "The main concept is correct; add edge cases.", strengths: ["概念正確"], improvements: ["補充邊界條件"], nextStep: "加入一個空輸入測試" }), inputTokens: 4, outputTokens: 6, model: "fake" };
    });
    const ai = new AiService(fixture.db, provider, clock);
    const review = new AiReviewService(fixture.db, clock);
    const materials = new MaterialService(fixture.db, fixture.storage, clock);
    const material = await materials.createMaterial(fixture.teacher, fixture.unit.id, { kind: "web_content", titleZh: "Python 迴圈", bodyZh: "for 迴圈會重複執行區塊，必須注意終止條件。" });
    const summary = await review.generateArtifact(fixture.teacher, fixture.course.id, { artifactType: "material", requestKey: "summary-1", materialId: material.id }, ai);
    assert.equal(summary.status, "pending_review");
    assert.equal(summary.material_id, material.id);
    const replay = await review.generateArtifact(fixture.teacher, fixture.course.id, { artifactType: "material", requestKey: "summary-1", materialId: material.id }, ai);
    assert.equal(replay.id, summary.id);

    const translation = await review.generateArtifact(fixture.teacher, fixture.course.id, { artifactType: "translation", requestKey: "translation-1", materialId: material.id, targetLocale: "en" }, ai);
    review.review(fixture.teacher, translation.id, "approved");
    const publishedTranslation = review.publish(fixture.teacher, translation.id);
    assert.equal(publishedTranslation.status, "published");
    assert.equal(review.getStudent(fixture.student, translation.id).content.translatedText, "Loops repeat a block.");

    const questions = new QuestionService(fixture.db, clock);
    const assignments = new AssignmentService(fixture.db, clock);
    const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "short_answer", titleZh: "迴圈題", promptZh: "說明迴圈的終止條件", maxScore: 10 });
    questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
    const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "AI 評語測試" });
    assignments.addQuestion(fixture.teacher, assignment.id, question.id);
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    const draft = assignments.beginSubmission(fixture.student, assignment.id);
    assignments.saveAnswer(fixture.student, draft.id, question.id, { answerText: "只要條件成立就會繼續。" });
    const submitted = assignments.submit(fixture.student, draft.id);
    const answerId = submitted.answers[0].id;

    const feedback = await review.generateArtifact(fixture.teacher, fixture.course.id, { artifactType: "feedback", requestKey: "feedback-1", submissionAnswerId: answerId }, ai);
    assert.equal(feedback.student_id, fixture.student.id);
    assert.equal(feedback.submission_answer_id, answerId);
    review.review(fixture.teacher, feedback.id, "approved");
    review.publish(fixture.teacher, feedback.id);
    assert.equal(review.getStudent(fixture.student, feedback.id).content.feedbackZh, "主要概念正確，請補充邊界條件。");

    const suggested = await review.generateArtifact(fixture.teacher, fixture.course.id, { artifactType: "suggested_score", requestKey: "score-1", submissionAnswerId: answerId }, ai);
    assert.equal(suggested.status, "pending_review");
    review.review(fixture.teacher, suggested.id, "approved");
    review.publish(fixture.teacher, suggested.id);
    assert.throws(() => review.getStudent(fixture.student, suggested.id), (error) => error instanceof DomainError && error.code === "not_found");
    const confirmed = review.confirmSuggestedScore(fixture.teacher, suggested.id);
    assert.equal(confirmed.aiSuggestedScore, 7);
    assert.equal(confirmed.finalScore, null);
    assert.equal(provider.calls.length, 4);
    assert.equal(JSON.stringify(provider.calls).includes("測試學生"), false);
  } finally {
    await fixture.close();
  }
});

test("AI artifact generation fails closed on invalid provider JSON and cross-course targets", async () => {
  const fixture = await makeContentFixture();
  try {
    const { clock } = await configure(fixture, false);
    const invalidProvider = new FakeAiProvider(async () => ({ content: "not json", inputTokens: 1, outputTokens: 1, model: "fake" }));
    const ai = new AiService(fixture.db, invalidProvider, clock);
    const review = new AiReviewService(fixture.db, clock);
    assert.rejects(() => review.generateArtifact(fixture.teacher, fixture.course.id, { artifactType: "material", requestKey: "invalid-json", materialId: "missing-material" }, ai), (error) => error instanceof DomainError && error.code === "invalid_reference");
    const materials = new MaterialService(fixture.db, fixture.storage, clock);
    const material = await materials.createMaterial(fixture.teacher, fixture.unit.id, { kind: "web_content", titleZh: "教材", bodyZh: "內容" });
    await assert.rejects(() => review.generateArtifact(fixture.teacher, fixture.course.id, { artifactType: "material", requestKey: "invalid-json", materialId: material.id }, ai), (error) => error instanceof DomainError && error.code === "ai_artifact_invalid");
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM ai_artifacts").count, 0);
  } finally {
    await fixture.close();
  }
});
