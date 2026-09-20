import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Phase 9A role workspaces are wired to live typed APIs without static ready claims", async () => {
  const [page, client, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/api-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  for (const marker of ["TeacherClassManager", "TeacherAssignmentPolicy", "TeacherPackagePolicy", "TeacherGradingDesk", "oneTimePassword", "previewImport", "autosaveState", "recordPaste", "submission.scoreReleased", "Promise.all(courseResult.courses.map", "showScoreImmediately", "setShowScoreImmediately", "showTestResultsImmediately", "setShowTestResultsImmediately"]) assert.ok(page.includes(marker), marker);
  assert.match(page, /showScoreImmediately, showTestResultsImmediately/);
  for (const endpoint of ["/users", "/classes", "/students/import", "/reset-password", "/submissions/", "/snapshots"]) assert.ok(client.includes(endpoint), endpoint);
  for (const selector of [".one-time-secret", ".autosave-state", ".teacher-class-manager", ".assignment-policy", ".grading-desk"]) assert.ok(css.includes(selector), selector);
  assert.equal(page.includes("localStorage"), false);
  assert.equal(page.includes("setRole('student')"), false);
});
