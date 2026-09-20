import assert from "node:assert/strict";
import test from "node:test";

const { AuditService } = await import("../server/audit.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("audit metadata is correlated and centrally redacted", async () => {
  const fixture = await makeContentFixture();
  try {
    const audit = new AuditService(fixture.db);
    const result = audit.record(fixture.admin, { action: "security.test", entityType: "test", metadata: { password: "P-secret", token: "Bearer abc", apiKey: "sk-test-canary-123456789", hiddenTest: "hidden-answer-canary", answer: "full-answer-canary", safeCount: 4 }, correlationId: "corr-audit-1" });
    assert.equal(result.correlationId, "corr-audit-1");
    const row = audit.list(fixture.admin, { correlationId: "corr-audit-1" })[0];
    assert.equal(row.request_id, "corr-audit-1");
    assert.equal(row.metadata_json.includes("P-secret"), false);
    assert.equal(row.metadata_json.includes("hidden-answer-canary"), false);
    assert.equal(row.metadata_json.includes("full-answer-canary"), false);
    assert.equal(row.metadata_json.includes("safeCount"), true);
  } finally {
    await fixture.close();
  }
});

