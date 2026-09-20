import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";

const { AiAdminService, AiReviewService, AiService, FakeAiProvider, MasterKeyCipher } = await import("../server/ai.ts");
const { DomainError } = await import("../server/errors.ts");
const { QuestionService } = await import("../server/content.ts");
const { createBackendApp } = await import("../server/http/backend.ts");
import { makeContentFixture } from "./content-helpers.mjs";

async function configure(fixture, clock = () => new Date("2026-08-20T12:00:00.000Z")) {
  const adminService = new AiAdminService(fixture.db, new MasterKeyCipher(randomBytes(32)), clock);
  const provider = adminService.configureProvider(fixture.admin, { providerKey: "fake", displayName: "Fake", defaultModel: "fake", apiKey: "server-only-secret", enabled: true });
  adminService.updateSettings(fixture.admin, { enabled: true, providerConfigId: provider.id, studentDailyRequestLimit: 20, schoolDailyRequestLimit: 100, studentDailyTokenLimit: 10000, schoolDailyTokenLimit: 100000, saveConversations: false, timezone: "Asia/Macau" });
  return clock;
}

function response() {
  return JSON.stringify({
    type: "python_code", titleZh: "串列迴圈練習", titleEn: "List loop practice", promptZh: "請輸出串列中的每個元素。", promptEn: "Print every item in the list.",
    starterCode: "items = [1, 2, 3]\n", solutionCode: "items = [1, 2, 3]\nfor item in items:\n    print(item)",
    requiredConcepts: ["for 迴圈", "串列", "for 迴圈"], maxScore: 8,
    explanationZh: "使用 for 逐項走訪串列。", testCases: [
      { visibility: "public", label: "基本案例", inputJson: { items: [1, 2] }, expectedOutput: "1\n2", comparisonMode: "trimmed", weight: 1 },
      { visibility: "hidden", label: "隱藏案例", inputJson: { items: [3] }, expectedOutput: "3", comparisonMode: "trimmed", weight: 2 },
    ],
  });
}

test("AI question authoring requires review, materializes idempotently, and copies tests independently", async () => {
  const fixture = await makeContentFixture();
  try {
    const clock = await configure(fixture);
    const provider = new FakeAiProvider(async () => ({ content: response(), inputTokens: 20, outputTokens: 40, model: "fake" }));
    const ai = new AiService(fixture.db, provider, clock);
    const review = new AiReviewService(fixture.db, clock);
    const questions = new QuestionService(fixture.db, clock);

    const artifact = await review.generateQuestion(fixture.teacher, fixture.course.id, { requestKey: "author-1", type: "python_code", topic: "串列迴圈", concepts: ["for 迴圈", "串列"] }, ai);
    assert.equal(artifact.artifact_type, "question");
    assert.equal(artifact.status, "pending_review");
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM questions").count, 0);
    assert.equal(provider.calls.length, 1);
    assert.deepEqual(artifact.content.requiredConcepts, ["for 迴圈", "串列"]);

    const replay = await review.generateQuestion(fixture.teacher, fixture.course.id, { requestKey: "author-1", type: "python_code", topic: "不同描述", concepts: [] }, ai);
    assert.equal(replay.id, artifact.id);
    assert.equal(provider.calls.length, 1);
    assert.throws(() => review.publish(fixture.teacher, artifact.id), (error) => error instanceof DomainError && error.code === "authoring_materialization_required");

    review.review(fixture.teacher, artifact.id, "approved", "教師已核閱");
    const materialized = review.materializeQuestion(fixture.teacher, artifact.id);
    assert.equal(materialized.artifact.status, "published");
    assert.equal(materialized.question.status, "draft");
    assert.equal(materialized.question.sharing_scope, "private");
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM test_cases WHERE question_id = ?", [materialized.question.id]).count, 2);
    const materializedAgain = review.materializeQuestion(fixture.teacher, artifact.id);
    assert.equal(materializedAgain.question.id, materialized.question.id);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM questions").count, 1);
    assert.throws(() => review.getStudent(fixture.student, artifact.id), (error) => error instanceof DomainError && error.code === "not_found");

    const targetCourse = fixture.education.createCourse(fixture.teacher, { titleZh: "第二課程", joinCode: "PYTEST2" });
    fixture.education.updateCourse(fixture.teacher, targetCourse.id, { status: "published" });
    const targetUnit = fixture.education.createUnit(fixture.teacher, targetCourse.id, { titleZh: "第二單元" });
    fixture.education.updateUnit(fixture.teacher, targetUnit.id, { status: "published" });
    questions.updateQuestion(fixture.teacher, materialized.question.id, { status: "published", sharingScope: "school" });
    const library = questions.searchLibrary(fixture.teacher, targetCourse.id, { concept: "FOR 迴圈" });
    assert.equal(library.length, 1);
    assert.equal("answer_key_json" in library[0], false);
    assert.equal("solution_code" in library[0], false);
    const copied = questions.copyQuestion(fixture.teacher, materialized.question.id, { targetCourseId: targetCourse.id, targetUnitId: targetUnit.id });
    assert.notEqual(copied.id, materialized.question.id);
    assert.equal(copied.course_id, targetCourse.id);
    assert.equal(copied.status, "draft");
    assert.equal(copied.sharing_scope, "private");
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM test_cases WHERE question_id = ?", [copied.id]).count, 2);
    assert.notEqual(fixture.db.get("SELECT id FROM test_cases WHERE question_id = ? ORDER BY position LIMIT 1", [copied.id]).id, fixture.db.get("SELECT id FROM test_cases WHERE question_id = ? ORDER BY position LIMIT 1", [materialized.question.id]).id);

    const privateQuestion = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "short_answer", titleZh: "私人題目", promptZh: "私人內容", requiredConceptsJson: ["封閉"] });
    assert.equal(questions.searchLibrary(fixture.teacher, targetCourse.id, { q: "私人題目" }).length, 0);
    assert.throws(() => questions.copyQuestion(fixture.student, materialized.question.id, { targetCourseId: targetCourse.id }), (error) => error instanceof DomainError && error.code === "forbidden");
    assert.ok(privateQuestion.id);
  } finally {
    await fixture.close();
  }
});

test("malformed AI authoring output creates no artifact or question", async () => {
  const fixture = await makeContentFixture();
  try {
    const clock = await configure(fixture);
    const ai = new AiService(fixture.db, new FakeAiProvider(async () => ({ content: "not-json", inputTokens: 1, outputTokens: 1, model: "fake" })), clock);
    const review = new AiReviewService(fixture.db, clock);
    await assert.rejects(() => review.generateQuestion(fixture.teacher, fixture.course.id, { requestKey: "bad-json", type: "short_answer", topic: "錯誤格式" }, ai), (error) => error instanceof DomainError && error.code === "ai_question_invalid");
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM ai_artifacts").count, 0);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM questions").count, 0);
  } finally {
    await fixture.close();
  }
});

test("AI authoring and question library HTTP routes keep review and copy boundaries", async () => {
  const token = "authoring-http-token-123456789";
  const provider = new FakeAiProvider(async () => ({ content: response(), inputTokens: 10, outputTokens: 20, model: "fake" }));
  const app = createBackendApp({ internalToken: token, aiMasterKey: randomBytes(32).toString("base64"), aiProvider: provider });
  const request = (path, method = "GET", body, cookie = "") => {
    const headers = new Headers({ "x-backend-token": token });
    if (cookie) headers.set("cookie", cookie);
    if (body !== undefined) { headers.set("content-type", "application/json"); headers.set("origin", "http://localhost"); }
    return new Request("http://localhost/api/v1" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  const readyCookie = async (username, initialPassword, newPassword) => {
    const first = await app.handle(request("/auth/login", "POST", { username, password: initialPassword }));
    const cookie = first.headers.get("set-cookie").split(";", 1)[0];
    assert.equal((await app.handle(request("/auth/password", "POST", { newPassword }, cookie))).status, 200);
    return cookie;
  };
  try {
    const adminRecord = app.services.education.createInitialAdmin({ username: "authoring-admin", chineseName: "管理員" });
    const admin = { id: adminRecord.user.id, role: "admin" };
    const teacherRecord = app.services.education.createUser(admin, { role: "teacher", username: "authoring-teacher", chineseName: "教師" });
    const teacher = { id: teacherRecord.user.id, role: "teacher" };
    const teacherCookie = await readyCookie("authoring-teacher", teacherRecord.initialPassword, "Authoring-Teacher-Strong-1!");
    const adminService = new AiAdminService(app.services.db, new MasterKeyCipher(randomBytes(32)), () => new Date("2026-08-20T12:00:00.000Z"));
    const configured = adminService.configureProvider(admin, { providerKey: "fake", displayName: "Fake", defaultModel: "fake", apiKey: "server-key", enabled: true });
    adminService.updateSettings(admin, { enabled: true, providerConfigId: configured.id, studentDailyRequestLimit: 20, schoolDailyRequestLimit: 100, studentDailyTokenLimit: 10000, schoolDailyTokenLimit: 100000 });
    const course = app.services.education.createCourse(teacher, { titleZh: "HTTP 題庫", joinCode: "HTTPQ1" });
    app.services.education.updateCourse(teacher, course.id, { status: "published" });
    const generated = await app.handle(request(`/courses/${course.id}/ai-authoring/questions`, "POST", { requestKey: "http-author-1", type: "python_code", topic: "串列", concepts: ["串列"] }, teacherCookie));
    assert.equal(generated.status, 201);
    const artifact = (await generated.json()).artifact;
    assert.equal(artifact.status, "pending_review");
    const approved = await app.handle(request(`/ai/artifacts/${artifact.id}/review`, "POST", { decision: "approved" }, teacherCookie));
    assert.equal(approved.status, 200);
    const materialized = await app.handle(request(`/ai/artifacts/${artifact.id}/materialize-question`, "POST", {}, teacherCookie));
    assert.equal(materialized.status, 200);
    const question = (await materialized.json()).question;
    assert.equal(question.status, "draft");
    const listed = await app.handle(request(`/courses/${course.id}/questions`, "GET", undefined, teacherCookie));
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).questions.length, 1);
    const library = await app.handle(request(`/courses/${course.id}/question-library?q=${encodeURIComponent("串列")}`, "GET", undefined, teacherCookie));
    assert.equal(library.status, 200);
    assert.equal((await library.json()).questions.length, 1);
  } finally { app.close(); }
});
