import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";

const { AiAdminService, AiReviewService, AiService, FakeAiProvider, MasterKeyCipher } = await import("../server/ai.ts");
const { QuestionService, AssignmentService } = await import("../server/content.ts");
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
