import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const previewComponent = new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url);
const previewStyles = new URL("../app/_sites-preview/preview.css", import.meta.url);

async function dispatch(request, envOverrides = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    request,
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, NODE_ENV: "test", ALLOW_LEGACY_RUN: "true", ...envOverrides },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function render() {
  return dispatch(new Request("http://localhost/", { headers: { accept: "text/html" } }));
}

test("server-renders the Python learning workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>智學 Python｜校本編程學習平台<\/title>/i);
  assert.match(html, /正在驗證登入狀態|登入|Login/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Building your site/i);
});

test("removes starter assets and keeps product metadata", async () => {
  const [page, layout, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /MissionCentre/);
  assert.match(page, /PracticeWorkspace/);
  assert.match(page, /TeacherWorkspace/);
  assert.match(page, /TeacherLiveClass/);
  assert.match(page, /AdminCentre/);
  assert.match(page, /StudentCourses/);
  assert.match(page, /StudentResources/);
  assert.match(page, /learningApi\.materials/);
  assert.match(page, /learningApi\.joinCourse/);
  assert.match(page, /learningApi\.beginSubmission/);
  assert.match(page, /learningApi\.grade/);
  assert.match(page, /learningApi\.addTestCase/);
  assert.match(page, /TeacherContentEditor/);
  assert.match(page, /learningApi\.reorderAssignmentQuestions/);
  assert.match(page, /learningApi\.removeAssignmentQuestion/);
  assert.match(page, /learningApi\.uploadFile/);
  assert.match(page, /TeacherMaterialLibrary/);
  assert.match(page, /TeacherCourseMaterials/);
  assert.match(page, /learningApi\.availableFiles/);
  assert.match(page, /learningApi\.queueMaterialConversion/);
  assert.match(page, /下載原檔|Download original/);
  assert.match(page, /排隊轉成網頁教材|Queue web conversion/);
  assert.match(page, /MaterialPreview/);
  assert.doesNotMatch(page, /目前等待轉換服務|currently waiting for conversion service/);
  assert.match(page, /Program input/);
  assert.match(page, /multiple_choice/);
  assert.match(page, /file_upload/);
  assert.match(page, /public/);
  assert.match(page, /hidden/);
  assert.doesNotMatch(page, /下一階段|next phase|待接入|coming soon/i);
  assert.match(page, /逐層思路提示/);
  assert.match(page, /公開測試/);
  assert.match(page, /隱藏測試/);
  assert.doesNotMatch(page, /計算一週平均溫度|平均溫度：26\.4°C/);
  assert.match(page, /setLanguage/);
  for (const selector of ["login-screen", "login-intro", "login-card", "login-form", "empty-state", "teacher-workspace-grid", "join-course-form", "question-navigation", "content-editor", "editor-controls", "editor-form", "assignment-question-editor", "form-error", "data-list"]) {
    assert.match(page, new RegExp(`className=\\"[^\\"]*${selector}`), `page markup should include .${selector}`);
    assert.match(css, new RegExp(`\\.${selector}\\b`), `styles should include .${selector}`);
  }
  for (const selector of ["teacher-material-hub", "teacher-material-workspace", "material-library", "course-materials", "library-dropzone", "upload-progress", "upload-error", "asset-list", "material-form-grid", "file-metadata", "download-link"]) {
    assert.match(page, new RegExp(`className=\\"[^\\"]*${selector}`), `page markup should include .${selector}`);
    assert.match(css, new RegExp(`\\.${selector}\\b`), `styles should include .${selector}`);
  }
  assert.match(layout, /title:\s*"智學 Python｜校本編程學習平台"/);
  assert.match(layout, /lang="zh-Hant"/);
  assert.match(css, /@media \(max-width: 680px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
  assert.doesNotMatch(layout, /Starter Project|codex-preview/);
  await assert.rejects(access(previewComponent));
  await assert.rejects(access(previewStyles));
});

test("guards the Python Runner proxy before execution", async () => {
  const unsupported = await dispatch(
    new Request("http://localhost/api/run", {
      method: "POST",
      body: JSON.stringify({ code: "print(1)" }),
    }),
  );
  assert.equal(unsupported.status, 415);
  assert.equal(unsupported.headers.get("cache-control"), "no-store");

  const extraField = await dispatch(
    new Request("http://localhost/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "print(1)", role: "admin" }),
    }),
  );
  assert.equal(extraField.status, 400);
  assert.match(await extraField.text(), /unsupported fields/i);

  const unconfigured = await dispatch(
    new Request("http://localhost/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "print(1)" }),
    }),
  );
  assert.equal(unconfigured.status, 503);
  assert.match(await unconfigured.text(), /尚未配置/);
});

test("disables the legacy runner route in production", async () => {
  const response = await dispatch(new Request("http://localhost/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "print(1)" }) }), { NODE_ENV: "production", ALLOW_LEGACY_RUN: "false" });
  assert.equal(response.status, 404);
  assert.match(await response.text(), /legacy_route_disabled/);
});
