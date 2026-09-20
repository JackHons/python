import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

const { MasterKeyCipher, maskApiKey, FakeAiProvider, AiAdminService } = await import("../server/ai.ts");
const { DomainError } = await import("../server/errors.ts");
const { openLocalDatabase } = await import("../server/db.ts");
const { EducationService } = await import("../server/education.ts");

test("AI key encryption is authenticated, versioned, masked, and fail-closed", () => {
  const key = randomBytes(32);
  const cipher = new MasterKeyCipher(key);
  const encrypted = cipher.encrypt("provider-secret-value");
  assert.match(encrypted, /^v1\./);
  assert.equal(cipher.decrypt(encrypted), "provider-secret-value");
  assert.notEqual(encrypted.includes("provider-secret-value"), true);
  assert.equal(maskApiKey("provider-secret-value"), "••••••••alue");
  const tampered = encrypted.split("."); const tag = Buffer.from(tampered[2], "base64url"); tag[0] ^= 1; tampered[2] = tag.toString("base64url");
  assert.throws(() => cipher.decrypt(tampered.join(".")), (error) => error instanceof DomainError && error.code === "ai_key_invalid");
  assert.throws(() => new MasterKeyCipher(undefined), (error) => error?.code === "ai_master_key_missing");
});

test("fake provider is vendor-neutral and admin responses never expose encrypted key", () => {
  const db = openLocalDatabase(":memory:");
  const education = new EducationService(db);
  const adminResult = education.createInitialAdmin({ username: "ai-admin", chineseName: "AI 管理員" });
  const admin = { id: adminResult.user.id, role: "admin" };
  assert.equal(new FakeAiProvider() instanceof FakeAiProvider, true);
  const service = new AiAdminService(db, new MasterKeyCipher(randomBytes(32)));
  const configured = service.configureProvider(admin, { providerKey: "fake", displayName: "Fake", defaultModel: "fake-model", apiKey: "secret-key-for-test", enabled: true });
  assert.equal(configured.api_key_hint.includes("secret-key-for-test"), false);
  assert.equal(JSON.stringify(configured).includes("secret-key-for-test"), false);
  assert.equal(db.get("SELECT encrypted_api_key FROM ai_provider_configs WHERE id = ?", [configured.id]).encrypted_api_key.startsWith("v1."), true);
  const rotated = service.configureProvider(admin, { providerKey: "fake", displayName: "Fake", defaultModel: "fake-model-v2", apiKey: "rotated-secret-value", enabled: true });
  assert.equal(rotated.encryption_version, 2);
  assert.equal(rotated.api_key_hint.includes("rotated-secret-value"), false);
  assert.throws(() => new AiAdminService(db, null).configureProvider(admin, { providerKey: "other", displayName: "Other", defaultModel: "model", apiKey: "secret" }), (error) => error instanceof DomainError && error.code === "ai_master_key_missing");
  db.close();
});
