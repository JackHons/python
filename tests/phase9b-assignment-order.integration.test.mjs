import assert from "node:assert/strict";
import test from "node:test";

const { AssignmentService, QuestionService } = await import("../server/content.ts");
const { sortAssignmentsByDue } = await import("../app/lib/api-client.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("student assignments and cross-course page projection share nearest-due ordering and explicit inactive states", async () => {
  const fixture = await makeContentFixture();
  try {
    const clock = () => new Date("2026-08-23T12:00:00.000Z");
    const assignments = new AssignmentService(fixture.db, clock);
    const questions = new QuestionService(fixture.db, clock);
    const question = questions.createQuestion(fixture.teacher, {
      courseId: fixture.course.id,
      unitId: fixture.unit.id,
      type: "short_answer",
      titleZh: "排序測試題",
      promptZh: "回答",
      maxScore: 1,
    });
    questions.updateQuestion(fixture.teacher, question.id, { status: "published" });

    // Creation order deliberately differs from due order. This catches the
    // former publish_at/created_at ordering and cross-course flatMap bug.
    const specifications = [
      { key: "far", titleZh: "較遠截止", dueAt: "2026-08-30T12:00:00.000Z", status: "published" },
      { key: "none", titleZh: "沒有截止", dueAt: undefined, status: "published" },
      { key: "near", titleZh: "最近截止", dueAt: "2026-08-24T12:00:00.000Z", status: "published" },
      { key: "closed", titleZh: "已關閉", dueAt: "2026-08-22T12:00:00.000Z", status: "closed", allowLate: true },
      { key: "past", titleZh: "已逾期", dueAt: "2026-08-20T12:00:00.000Z", status: "published", allowLate: false },
      { key: "nearTwin", titleZh: "同時截止", dueAt: "2026-08-24T12:00:00.000Z", status: "published" },
    ];
    const ids = {};
    for (const specification of specifications) {
      const assignment = assignments.createAssignment(fixture.teacher, {
        courseId: fixture.course.id,
        unitId: fixture.unit.id,
        titleZh: specification.titleZh,
        dueAt: specification.dueAt,
        allowLate: specification.allowLate,
      });
      ids[specification.key] = assignment.id;
      assignments.addQuestion(fixture.teacher, assignment.id, question.id);
      assignments.updateAssignment(fixture.teacher, assignment.id, { status: specification.status });
    }

    const serverRows = assignments.listAssignments(fixture.student, fixture.course.id);
    const nearestIds = [ids.near, ids.nearTwin].sort((left, right) => left.localeCompare(right));
    assert.deepEqual(serverRows.map((item) => item.id), [ids.past, ids.closed, ...nearestIds, ids.far, ids.none]);
    assert.deepEqual(serverRows.map((item) => item.reminder_state), ["past_due", "closed", "upcoming", "upcoming", "upcoming", "no_due"]);
    assert.deepEqual(serverRows.map((item) => item.can_start), [0, 0, 1, 1, 1, 1]);
    assert.equal(serverRows.filter((item) => item.reminder_state === "upcoming")[0].id, nearestIds[0]);

    const pageRows = sortAssignmentsByDue([...serverRows].reverse());
    assert.deepEqual(pageRows.map((item) => item.id), serverRows.map((item) => item.id));
  } finally {
    await fixture.close();
  }
});
