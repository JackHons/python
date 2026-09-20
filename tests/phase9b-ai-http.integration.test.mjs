import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import test from "node:test";

const { AiAdminService, AiService, ConfiguredAiProvider, MasterKeyCipher, OpenAICompatibleProvider } = await import("../server/ai.ts");
const { DomainError } = await import("../server/errors.ts");
import { makeContentFixture } from "./content-helpers.mjs";

async function fakeProviderServer() {
  const calls = [];
  let responseMode = "ok";
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    if (responseMode === "timeout") { setTimeout(() => response.end(), 2000); return; }
    if (responseMode === "busy") { response.writeHead(429, { "content-type": "application/json" }); response.end('{"error":"busy"}'); return; }
    if (responseMode === "failed") { response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":"failed"}'); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ model: "server-model", choices: [{ message: { content: "Try tracing one loop iteration." } }], usage: { prompt_tokens: 7, completion_tokens: 5 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { calls, server, baseUrl: `http://127.0.0.1:${server.address().port}`, setMode: (value) => { responseMode = value; } };
}

test("configured backend AI provider performs real HTTP with server-only model/key and quota settlement", async () => {
  const fixture = await makeContentFixture();
  const fake = await fakeProviderServer();
  try {
    const secret = "phase9b-server-only-key";
    const admin = new AiAdminService(fixture.db, new MasterKeyCipher(randomBytes(32)));
    const configured = admin.configureProvider(fixture.admin, { providerKey: "openai-compatible", displayName: "Local contract", apiBaseUrl: fake.baseUrl, apiPath: "/custom/chat", timeoutMs: 1000, defaultModel: "server-policy-model", apiKey: secret, enabled: true });
    admin.updateSettings(fixture.admin, { enabled: true, providerConfigId: configured.id, assistantMode: "hints_only", studentDailyRequestLimit: 3, studentDailyTokenLimit: 100, schoolDailyRequestLimit: 10, schoolDailyTokenLimit: 1000, saveConversations: false });
    const ai = new AiService(fixture.db, new ConfiguredAiProvider(fixture.db, admin));
    const conversation = ai.startConversation(fixture.student, fixture.course.id);
    const result = await ai.request(fixture.student, { requestKey: "phase9b-real-http", purpose: "student_hint", task: "Help with the next step", model: "browser-forged-model", conversationId: conversation.id, estimatedTokens: 20 });
    const second = await ai.request(fixture.student, { requestKey: "phase9b-real-http-2", purpose: "student_hint", task: "Unlock next hint", conversationId: conversation.id, estimatedTokens: 20 });
    const third = await ai.request(fixture.student, { requestKey: "phase9b-real-http-3", purpose: "student_hint", task: "Unlock next hint", conversationId: conversation.id, estimatedTokens: 20 });
    assert.equal(result.content, "Try tracing one loop iteration.");
    assert.equal(fake.calls.length, 3);
    assert.equal(fake.calls[0].url, "/custom/chat");
    assert.equal(fake.calls[0].authorization, `Bearer ${secret}`);
    assert.equal(fake.calls[0].body.model, "server-policy-model");
    assert.match(fake.calls[0].body.messages[0].content, /Do not provide a complete answer/);
    assert.deepEqual([result.hintLevel, second.hintLevel, third.hintLevel], [1, 2, 3]);
    assert.deepEqual(fake.calls.map((call) => JSON.parse(call.body.messages[1].content).hintLevel), [1, 2, 3]);
    assert.equal(ai.startConversation(fixture.student, fixture.course.id).successful_hint_count, 3);
    const status = ai.status(fixture.student);
    assert.deepEqual(status, { enabled: true, hintLevel: 0, maxHintLevel: 3 });
    assert.doesNotMatch(JSON.stringify(status), /remaining|quota|token|cost|provider|key|model/i);
    const publicValues = JSON.stringify({ configured, settings: admin.getSettings(fixture.admin), providers: admin.listProviders(fixture.admin), result, status, audits: fixture.db.all("SELECT metadata_json FROM audit_logs") });
    assert.equal(publicValues.includes(secret), false);
    admin.disableProvider(fixture.admin, configured.id);
    await assert.rejects(() => ai.request(fixture.student, { requestKey: "phase9b-disabled", purpose: "student_hint", task: "hint", estimatedTokens: 5 }), (error) => error instanceof DomainError && error.code === "ai_disabled");
  } finally { fake.server.close(); await fixture.close(); }
});

test("OpenAI-compatible adapter maps 429, 5xx and timeout without exposing provider bodies", async () => {
  const fake = await fakeProviderServer();
  try {
    const provider = new OpenAICompatibleProvider(fake.baseUrl, "adapter-secret", "model", fetch, "/chat", 1000);
    fake.setMode("busy");
    await assert.rejects(() => provider.generate({ model: "model", messages: [{ role: "user", content: "hello" }] }), (error) => error instanceof DomainError && error.code === "provider_busy" && error.status === 429);
    fake.setMode("failed");
    await assert.rejects(() => provider.generate({ model: "model", messages: [{ role: "user", content: "hello" }] }), (error) => error instanceof DomainError && error.code === "provider_failed" && !error.message.includes("failed\""));
    fake.setMode("timeout");
    await assert.rejects(() => provider.generate({ model: "model", messages: [{ role: "user", content: "hello" }] }), (error) => error instanceof DomainError && error.code === "provider_timeout");
  } finally { fake.server.closeAllConnections?.(); fake.server.close(); }
});
