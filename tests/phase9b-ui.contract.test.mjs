import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Phase 9B AI controls use typed live APIs and keep provider secrets server-side", async () => {
  const [page, client, backend, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/api-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../server/http/backend.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  for (const marker of ["AdminAiCentre", "TeacherAiReviewQueue", "TeacherHintManager", "requestAiHint", "maxHintLevel", "ai-hint-response", "新增／輪換金鑰", "未批准內容不會向學生發布", "設為唯一啟用"]) assert.ok(page.includes(marker), marker);
  for (const endpoint of ["/ai/status", "/admin/ai/providers", "/admin/ai/settings", "/ai-artifacts", "/hints/unlock", "/activate"]) assert.ok(client.includes(endpoint), endpoint);
  assert.ok(backend.includes("ConfiguredAiProvider"));
  assert.equal(page.includes("server-only-key"), false);
  assert.equal(client.includes("encrypted_api_key"), false);
  for (const selector of [".ai-hint-response", ".artifact-preview", ".admin-ai-centre"]) assert.ok(css.includes(selector), selector);
});

test("Phase 9B student hierarchy, real PPT viewer and teacher analytics are reachable typed UI slices", async () => {
  const [page, client, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/api-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  for (const marker of ["course-breadcrumbs", "unit-learning-grid", "MaterialPreview", "TeacherAnalyticsDashboard", "studentClassrooms", "解鎖第", "common-errors", "learning-time", "sortAssignmentsByDue", "upcomingReminders", "assignmentReminderLabel", "已逾期，可補交", "已關閉"]) assert.ok(page.includes(marker), marker);
  for (const marker of ["sortAssignmentsByDue", "reminder_state", "can_start"]) assert.ok(client.includes(marker), marker);
  for (const endpoint of ["/preview/slides/", "/preview/pdf", "/classrooms", "/analytics/"]) assert.ok(client.includes(endpoint), endpoint);
  for (const selector of [".course-breadcrumbs", ".unit-learning-grid", ".slide-viewer", ".analytics-filters", ".analytics-dashboard-grid"]) assert.ok(css.includes(selector), selector);
  assert.equal(page.includes("completed\") return L(\"轉換完成"), false);
});
