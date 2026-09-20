import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { AiAdminService, AiService, ConfiguredAiProvider, MasterKeyCipher } from "../server/ai.ts";
import { QuestionService, AssignmentService } from "../server/content.ts";
import { DomainError } from "../server/errors.ts";
import { makeContentFixture } from "./content-helpers.mjs";

test("AI providers have one explicit active selection, rotate masked keys, and never fall back", async () => {
  const fixture = await makeContentFixture();
  try {
    const admin = new AiAdminService(fixture.db, new MasterKeyCipher(randomBytes(32)));
    const first = admin.configureProvider(fixture.admin, { providerKey: "openai-compatible:primary", displayName: "Primary", apiBaseUrl: "http://127.0.0.1:9/v1", apiPath: "/chat/completions", timeoutMs: 1000, defaultModel: "model-a", apiKey: "first-secret-key", enabled: true });
    assert.match(first.api_key_hint, /^••••••••/);
    assert.doesNotMatch(JSON.stringify(first), /first-secret-key|encrypted_api_key/);
    admin.updateSettings(fixture.admin, { providerConfigId: first.id, enabled: true, maxHintLayers: 3 });

    const second = admin.configureProvider(fixture.admin, { providerKey: "openai-compatible:secondary", displayName: "Secondary", apiBaseUrl: "http://127.0.0.1:9/v1", defaultModel: "model-b", apiKey: "second-secret-key", enabled: true });
    const providers = admin.listProviders(fixture.admin);
    assert.equal(providers.filter((item) => item.enabled).length, 1);
    assert.equal(providers.find((item) => item.id === second.id).enabled, 1);
    assert.equal(providers.find((item) => item.id === first.id).enabled, 0);
    await assert.rejects(() => new ConfiguredAiProvider(fixture.db, admin).generate({ model: "ignored", messages: [{ role: "user", content: "test" }] }), (error) => error instanceof DomainError && error.code === "provider_unavailable");

    const activated = admin.activateProvider(fixture.admin, first.id);
    assert.equal(activated.enabled, 1);
    assert.equal(admin.getSettings(fixture.admin).enabled, 0);
    admin.updateSettings(fixture.admin, { enabled: true });
    const rotated = admin.configureProvider(fixture.admin, { providerKey: "openai-compatible:primary", displayName: "Primary", apiBaseUrl: "http://127.0.0.1:9/v1", defaultModel: "model-a2", apiKey: "rotated-secret-key", enabled: true });
    assert.equal(rotated.id, first.id);
    assert.ok(rotated.encryption_version > first.encryption_version);
    assert.doesNotMatch(JSON.stringify(rotated), /rotated-secret-key|encrypted_api_key/);
    admin.disableProvider(fixture.admin, first.id);
    assert.equal(admin.getSettings(fixture.admin).enabled, 0);
    assert.throws(() => admin.listProviders(fixture.teacher), (error) => error instanceof DomainError && error.code === "forbidden");
    assert.throws(() => admin.getSettings(fixture.student), (error) => error instanceof DomainError && error.code === "forbidden");
  } finally { await fixture.close(); }
});

test("student AI status exposes hint state only and never quota, cost, provider, token, or key data", async () => {
  const fixture = await makeContentFixture();
  try {
    const admin = new AiAdminService(fixture.db, new MasterKeyCipher(randomBytes(32)));
    const provider = admin.configureProvider(fixture.admin, { providerKey: "openai-compatible:status", displayName: "Status", apiBaseUrl: "http://127.0.0.1:9/v1", defaultModel: "status-model", apiKey: "status-secret", enabled: true });
    admin.updateSettings(fixture.admin, { providerConfigId: provider.id, enabled: true, studentDailyRequestLimit: 9, studentDailyTokenLimit: 99, maxHintLayers: 2 });
    const service = new AiService(fixture.db, new ConfiguredAiProvider(fixture.db, admin));
    const status = service.status(fixture.student);
    assert.deepEqual(status, { enabled: true, hintLevel: 0, maxHintLevel: 2 });
    assert.doesNotMatch(JSON.stringify(status), /remaining|quota|token|cost|provider|key|model/i);
    const teacherStatus = service.status(fixture.teacher);
    assert.equal(teacherStatus.enabled, true);
    assert.ok(Object.hasOwn(teacherStatus, "remainingRequests"));
  } finally { await fixture.close(); }
});

test("question hints require AI review and unlock exactly one approved layer with durable isolation", async () => {
  const fixture = await makeContentFixture();
  try {
    const questions = new QuestionService(fixture.db);
    const assignments = new AssignmentService(fixture.db);
    const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "python_code", titleZh: "提示題", promptZh: "完成函式", starterCode: "print('start')" });
    questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
    const manual = questions.saveHint(fixture.teacher, question.id, { level: 1, contentZh: "先找出輸入與輸出的關係。", contentEn: "Identify the input-output relationship first." });
    const aiDraft = questions.saveHint(fixture.teacher, question.id, { level: 2, contentZh: "檢查迴圈的範圍與累積變數。", contentEn: "Check the loop range and accumulator.", source: "ai" });
    assert.equal(manual.status, "approved");
    assert.equal(aiDraft.status, "draft");
    assert.throws(() => questions.saveHint(fixture.teacher, question.id, { level: 3, contentZh: "```python\nprint('完整答案')\n```", source: "ai" }), (error) => error instanceof DomainError && error.code === "unsafe_hint_content");
    const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "提示功課" });
    assignments.addQuestion(fixture.teacher, assignment.id, question.id);
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    const submission = assignments.beginSubmission(fixture.student, assignment.id);
    assert.deepEqual(questions.studentHintState(fixture.student, submission.id, question.id), { enabled: true, hintLevel: 0, maxHintLevel: 1, hints: [] });
    const first = questions.unlockNextHint(fixture.student, submission.id, question.id, "unlock-one");
    assert.equal(first.hintLevel, 1);
    assert.equal(first.hints[0].content_zh, "先找出輸入與輸出的關係。");
    assert.equal(questions.unlockNextHint(fixture.student, submission.id, question.id, "unlock-one").replay, true);
    assert.throws(() => questions.unlockNextHint(fixture.student, submission.id, question.id, "unlock-two-before-review"), (error) => error instanceof DomainError && error.code === "no_hint_available");
    questions.reviewHint(fixture.teacher, aiDraft.id, "approved");
    const second = questions.unlockNextHint(fixture.student, submission.id, question.id, "unlock-two");
    assert.equal(second.hintLevel, 2);
    assert.deepEqual(questions.studentHintState(fixture.student, submission.id, question.id).hints.map((item) => item.level), [1, 2]);

    const studentTwoRecord = fixture.education.createUser(fixture.admin, { role: "student", username: "hint-student-two", chineseName: "提示學生二", studentNumber: "HINT2" });
    const studentTwo = { id: studentTwoRecord.user.id, role: "student" };
    fixture.education.joinCourseByCode(studentTwo, "PYTEST1");
    const submissionTwo = assignments.beginSubmission(studentTwo, assignment.id);
    assert.equal(questions.studentHintState(studentTwo, submissionTwo.id, question.id).hintLevel, 0);
    assert.throws(() => questions.studentHintState(studentTwo, submission.id, question.id), (error) => error instanceof DomainError && error.code === "not_found");
    assert.doesNotMatch(JSON.stringify(second), /quota|remaining|token|provider|key|cost/i);
  } finally { await fixture.close(); }
});

test("100 idempotent requests and 40 students cannot duplicate or cross hint unlocks", async () => {
  const fixture = await makeContentFixture();
  try {
    const questions = new QuestionService(fixture.db);
    const assignments = new AssignmentService(fixture.db);
    const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "python_code", titleZh: "併發提示", promptZh: "完成程式", starterCode: "" });
    questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
    questions.saveHint(fixture.teacher, question.id, { level: 1, contentZh: "第一層" });
    questions.saveHint(fixture.teacher, question.id, { level: 2, contentZh: "第二層" });
    const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "併發功課" });
    assignments.addQuestion(fixture.teacher, assignment.id, question.id);
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    const firstSubmission = assignments.beginSubmission(fixture.student, assignment.id);
    const repeated = await Promise.all(Array.from({ length: 100 }, () => new Promise((resolve, reject) => setImmediate(() => {
      try { resolve(questions.unlockNextHint(fixture.student, firstSubmission.id, question.id, "same-click")); } catch (error) { reject(error); }
    }))));
    assert.equal(repeated.every((state) => state.hintLevel === 1), true);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM student_hint_unlocks WHERE student_id = ?", [fixture.student.id]).count, 1);

    const states = await Promise.all(Array.from({ length: 40 }, async (_, index) => {
      const record = fixture.education.createUser(fixture.admin, { role: "student", username: `hint-load-${index}`, chineseName: `提示負載${index}`, studentNumber: `HL${String(index).padStart(3, "0")}` });
      const actor = { id: record.user.id, role: "student" };
      fixture.education.joinCourseByCode(actor, "PYTEST1");
      const submission = assignments.beginSubmission(actor, assignment.id);
      await new Promise((resolve) => setImmediate(resolve));
      return questions.unlockNextHint(actor, submission.id, question.id, `student-${index}-one`);
    }));
    assert.equal(states.every((state) => state.hintLevel === 1 && state.hints.length === 1), true);
    assert.equal(fixture.db.get("SELECT COUNT(DISTINCT student_id) AS count FROM student_hint_unlocks WHERE student_id != ?", [fixture.student.id]).count, 40);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM student_hint_unlocks WHERE question_id = ?", [question.id]).count, 41);
  } finally { await fixture.close(); }
});
