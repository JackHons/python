import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";

const { AiAdminService, AiService, FakeAiProvider, MasterKeyCipher } = await import("../server/ai.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("AI provider payload is minimized and excludes names, email, tokens, hidden cases, and answer keys", async () => {
  const fixture = await makeContentFixture();
  try {
    const adminService = new AiAdminService(fixture.db, new MasterKeyCipher(randomBytes(32)));
    const providerConfig = adminService.configureProvider(fixture.admin, { providerKey: "fake", displayName: "Fake", defaultModel: "fake", apiKey: "server-key-not-for-prompt", enabled: true });
    adminService.updateSettings(fixture.admin, { enabled: true, providerConfigId: providerConfig.id, studentDailyRequestLimit: 5, schoolDailyRequestLimit: 5, saveConversations: false });
    const provider = new FakeAiProvider(async () => ({ content: "hint", inputTokens: 1, outputTokens: 1, model: "fake" }));
    const ai = new AiService(fixture.db, provider);
    await ai.request(fixture.student, {
      requestKey: "minimal-payload",
      purpose: "student_hint",
      task: "Explain the next step",
      questionPrompt: "Use a loop",
      studentCode: "for x in values: print(x)",
      runnerFeedback: "public test failed",
      studentName: "不應傳送",
      email: "student@example.test",
      hiddenInput: "HIDDEN_CASE_SECRET",
      answerKey: "STANDARD_ANSWER",
      token: "server-key-not-for-prompt",
      estimatedTokens: 10,
    });
    const payload = JSON.stringify(provider.calls[0]);
    assert.equal(payload.includes("不應傳送"), false);
    assert.equal(payload.includes("student@example.test"), false);
    assert.equal(payload.includes("HIDDEN_CASE_SECRET"), false);
    assert.equal(payload.includes("STANDARD_ANSWER"), false);
    assert.equal(payload.includes("server-key-not-for-prompt"), false);
    assert.match(payload, /Explain the next step/);
  } finally {
    await fixture.close();
  }
});
