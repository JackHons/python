import assert from "node:assert/strict";
import test from "node:test";

const { DomainError } = await import("../server/errors.ts");
const { QuestionService, safeStudentQuestionProjection } = await import("../server/content.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("question service supports seven types and keeps hidden test data out of student projection", async () => {
  const fixture = await makeContentFixture();
  try {
    const questions = new QuestionService(fixture.db);
    const definitions = [
      ["multiple_choice", { optionsJson: ["A", "B"], answerKeyJson: { answer: "A" } }],
      ["fill_blank", { answerKeyJson: { answer: "x" } }],
      ["short_answer", { answerKeyJson: { rubric: "manual" } }],
      ["code_fill", { starterCode: "print()", solutionCode: "print(1)" }],
      ["python_code", { starterCode: "# code", solutionCode: "print(1)" }],
      ["file_upload", {}],
      ["project_upload", {}],
    ];
    const created = [];
    for (const [type, extra] of definitions) {
      const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, unitId: fixture.unit.id, type, titleZh: type + " 題目", promptZh: "請完成題目", ...extra });
      questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
      created.push(question.id);
    }
    assert.equal(created.length, 7);
    const codeQuestion = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "python_code", titleZh: "測試程式", promptZh: "輸出 1", starterCode: "", solutionCode: "print(1)", answerKeyJson: { secret: "answer" } });
    questions.addTestCase(fixture.teacher, codeQuestion.id, { visibility: "public", label: "公開", inputJson: { x: 1 }, expectedOutput: "1" });
    questions.addTestCase(fixture.teacher, codeQuestion.id, { visibility: "hidden", label: "隱藏", inputJson: { secret: 9 }, expectedOutput: "secret-output", weight: 7 });
    questions.updateQuestion(fixture.teacher, codeQuestion.id, { status: "published" });
    const projection = questions.listStudentQuestion(fixture.student, codeQuestion.id);
    assert.equal(projection.testCases.length, 1);
    assert.equal(projection.testCases[0].visibility, "public");
    assert.equal(projection.testCases[0].expectedOutput, "1");
    assert.equal("answerKeyJson" in projection, false);
    assert.equal(JSON.stringify(projection).includes("secret-output"), false);
    assert.equal(JSON.stringify(projection).includes("\"secret\":9"), false);

    const rubric = questions.createRubric(fixture.teacher, { courseId: fixture.course.id, titleZh: "程式評分準則" });
    questions.addRubricCriteria(fixture.teacher, rubric.id, { labelZh: "正確性", weightPercent: 50, maxScore: 50 });
    questions.addRubricCriteria(fixture.teacher, rubric.id, { labelZh: "可讀性", weightPercent: 50, maxScore: 50 });
    assert.equal(questions.activateRubric(fixture.teacher, rubric.id).status, "active");
    const invalidRubric = questions.createRubric(fixture.teacher, { courseId: fixture.course.id, titleZh: "未完成準則" });
    questions.addRubricCriteria(fixture.teacher, invalidRubric.id, { labelZh: "不足", weightPercent: 20, maxScore: 20 });
    assert.throws(() => questions.activateRubric(fixture.teacher, invalidRubric.id), (error) => error instanceof DomainError && error.code === "invalid_rubric");

    const unsafe = safeStudentQuestionProjection({ question_snapshot_json: JSON.stringify({ id: "q", type: "python_code", titleZh: "題目", promptZh: "提示", maxScore: 10, answerKeyJson: { answer: "x" }, testCases: [{ id: "hidden", visibility: "hidden", inputJson: { secret: 1 }, expectedOutput: "hidden", weight: 10 }, { id: "public", visibility: "public", inputJson: {}, expectedOutput: "ok", weight: 1 }] }) });
    assert.equal(unsafe.testCases.length, 1);
    assert.equal(JSON.stringify(unsafe).includes("hidden"), false);
  } finally {
    await fixture.close();
  }
});
