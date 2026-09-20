import assert from "node:assert/strict";
import test from "node:test";

const { AssignmentService, QuestionService } = await import("../server/content.ts");
const { GamificationService } = await import("../server/gamification.ts");
const { DomainError } = await import("../server/errors.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("submission events drive idempotent XP, streaks, badges and leaderboard controls", async () => {
  const fixture = await makeContentFixture();
  let now = new Date("2026-09-20T10:00:00.000Z");
  const clock = () => new Date(now);
  try {
    const questions = new QuestionService(fixture.db, clock);
    const assignments = new AssignmentService(fixture.db, clock);
    const gamification = new GamificationService(fixture.db, clock);
    const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "short_answer", titleZh: "提交題", promptZh: "回答", maxScore: 10 });
    questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
    const createAssignment = (title) => {
      const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: title });
      assignments.addQuestion(fixture.teacher, assignment.id, question.id);
      assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
      return assignment;
    };
    const first = createAssignment("第一份提交");
    const firstSubmission = assignments.beginSubmission(fixture.student, first.id);
    assignments.submit(fixture.student, firstSubmission.id);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM gamification_events WHERE user_id = ?", [fixture.student.id]).count, 1);
    assert.equal(gamification.me(fixture.student, fixture.course.id).xp, 10);
    assert.equal(gamification.me(fixture.student, fixture.course.id).streak.current_streak, 1);
    assert.equal(gamification.me(fixture.student, fixture.course.id).badges.length, 2);

    // Replaying the same projection key cannot award XP twice.
    gamification.recordSubmission(fixture.student, fixture.course.id, firstSubmission.id);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM gamification_events WHERE user_id = ?", [fixture.student.id]).count, 1);

    now = new Date("2026-09-21T10:00:00.000Z");
    const second = createAssignment("第二份提交");
    assignments.submit(fixture.student, assignments.beginSubmission(fixture.student, second.id).id);
    now = new Date("2026-09-22T10:00:00.000Z");
    const third = createAssignment("第三份提交");
    assignments.submit(fixture.student, assignments.beginSubmission(fixture.student, third.id).id);
    const profile = gamification.me(fixture.student, fixture.course.id);
    assert.equal(profile.xp, 30);
    assert.equal(profile.streak.current_streak, 3);
    assert.equal(profile.badges.some((badge) => badge.badge_code === "streak_3"), true);

    const leaderboard = gamification.leaderboard(fixture.student, fixture.course.id);
    assert.equal(leaderboard.hidden, false);
    assert.equal(leaderboard.rows[0].student_id, fixture.student.id);
    assert.equal(leaderboard.rows[0].xp, 30);
    assert.throws(() => gamification.me(fixture.teacher), (error) => error instanceof DomainError && error.code === "forbidden");

    gamification.updateSettings(fixture.admin, { leaderboardEnabled: false, xpEnabled: false });
    assert.equal(gamification.leaderboard(fixture.student, fixture.course.id).hidden, true);
    assert.equal(gamification.me(fixture.student).xp, 0);
  } finally {
    await fixture.close();
  }
});
