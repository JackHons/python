import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";

const { AiAdminService, AiService, FakeAiProvider } = await import("../server/ai.ts");
const { DomainError } = await import("../server/errors.ts");
import { makeContentFixture } from "./content-helpers.mjs";

async function configure(fixture, options = {}, clock = () => new Date("2026-08-20T12:00:00.000Z")) {
  const adminService = new AiAdminService(fixture.db, new (await import("../server/ai.ts")).MasterKeyCipher(randomBytes(32)), clock);
  const providerConfig = adminService.configureProvider(fixture.admin, { providerKey: "fake", displayName: "Fake", defaultModel: "fake-model", apiKey: "secret", enabled: true });
  adminService.updateSettings(fixture.admin, {
    enabled: true,
    providerConfigId: providerConfig.id,
    studentDailyRequestLimit: options.studentRequests ?? 20,
    studentDailyTokenLimit: options.studentTokens ?? 1000,
    schoolDailyRequestLimit: options.schoolRequests ?? 100,
    schoolDailyTokenLimit: options.schoolTokens ?? 10000,
    saveConversations: options.saveConversations ?? false,
    conversationRetentionDays: options.retentionDays ?? 1,
    timezone: options.timezone ?? "Asia/Macau",
  });
  return { adminService, providerConfig, clock };
}

test("100 concurrent requests never exceed student or school limits", async () => {
  const fixture = await makeContentFixture();
  try {
    const { providerConfig, clock } = await configure(fixture, { studentRequests: 20, schoolRequests: 40 }, () => new Date("2026-08-20T12:00:00.000Z"));
    const provider = new FakeAiProvider(async () => ({ content: "hint", inputTokens: 1, outputTokens: 1, model: "fake-model" }));
    const ai = new AiService(fixture.db, provider, clock);
    const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => ai.request(fixture.student, { requestKey: "quota-" + index, purpose: "student_hint", task: "Explain the next step", estimatedTokens: 2 })));
    const successes = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(successes.length, 20);
    assert.equal(rejected.length, 80);
    assert.ok(rejected.every((result) => result.reason instanceof DomainError && result.reason.code === "ai_quota_exceeded"));
    assert.equal(provider.calls.length, 20);
    const userQuota = fixture.db.get("SELECT reserved_requests, completed_requests, reserved_tokens, used_tokens FROM ai_daily_quotas WHERE user_id = ?", [fixture.student.id]);
    const schoolQuota = fixture.db.get("SELECT reserved_requests, completed_requests, reserved_tokens, used_tokens FROM ai_school_daily_quotas");
    assert.deepEqual({ ...userQuota }, { reserved_requests: 0, completed_requests: 20, reserved_tokens: 0, used_tokens: 40 });
    assert.deepEqual({ ...schoolQuota }, { reserved_requests: 0, completed_requests: 20, reserved_tokens: 0, used_tokens: 40 });
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM ai_usage WHERE provider_config_id = ?", [providerConfig.id]).count, 20);
  } finally {
    await fixture.close();
  }
});

test("provider failure rolls back reservations and records only metadata", async () => {
  const fixture = await makeContentFixture();
  try {
    const { clock } = await configure(fixture, { studentRequests: 5, schoolRequests: 5 }, () => new Date("2026-08-20T12:00:00.000Z"));
    const provider = new FakeAiProvider(async () => { throw new DomainError("provider_busy", "Provider unavailable", 503); });
    const ai = new AiService(fixture.db, provider, clock);
    await assert.rejects(() => ai.request(fixture.student, { requestKey: "provider-failure", purpose: "student_hint", task: "Give a hint", estimatedTokens: 10 }), (error) => error instanceof DomainError && error.code === "provider_busy");
    const quota = fixture.db.get("SELECT reserved_requests, completed_requests, reserved_tokens, used_tokens FROM ai_daily_quotas WHERE user_id = ?", [fixture.student.id]);
    assert.deepEqual({ ...quota }, { reserved_requests: 0, completed_requests: 0, reserved_tokens: 0, used_tokens: 0 });
    assert.equal(fixture.db.get("SELECT status FROM ai_reservations WHERE reservation_key = 'provider-failure'").status, "rolled_back");
    assert.equal(fixture.db.get("SELECT status, error_code FROM ai_usage WHERE user_id = ?", [fixture.student.id]).status, "error");
    assert.equal(fixture.db.all("SELECT metadata_json FROM audit_logs").some((row) => String(row.metadata_json).includes("Give a hint")), false);
  } finally {
    await fixture.close();
  }
});

test("request key retries are idempotent and Asia/Macau date boundary is respected", async () => {
  const fixture = await makeContentFixture();
  try {
    let current = new Date("2026-08-20T15:59:00.000Z");
    const clock = () => current;
    const { clock: configuredClock } = await configure(fixture, { studentRequests: 1, schoolRequests: 10 }, clock);
    const provider = new FakeAiProvider(async () => ({ content: "once", inputTokens: 1, outputTokens: 1, model: "fake-model" }));
    const ai = new AiService(fixture.db, provider, configuredClock);
    const first = await ai.request(fixture.student, { requestKey: "same-key", purpose: "student_hint", task: "Hint", estimatedTokens: 2 });
    const replay = await ai.request(fixture.student, { requestKey: "same-key", purpose: "student_hint", task: "Different text is ignored", estimatedTokens: 2 });
    assert.equal(first.status, "success");
    assert.equal(replay.replay, true);
    assert.equal(provider.calls.length, 1);
    current = new Date("2026-08-20T16:00:00.000Z");
    const nextDay = await ai.request(fixture.student, { requestKey: "next-day", purpose: "student_hint", task: "Hint", estimatedTokens: 2 });
    assert.equal(nextDay.status, "success");
    const dates = fixture.db.all("SELECT usage_date FROM ai_daily_quotas ORDER BY usage_date");
    assert.deepEqual(dates.map((row) => row.usage_date), ["2026-08-20", "2026-08-21"]);
  } finally {
    await fixture.close();
  }
});
