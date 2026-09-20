import assert from "node:assert/strict";
import test from "node:test";

const { ClassroomService } = await import("../server/classroom.ts");
const { QuestionService, AssignmentService } = await import("../server/content.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("classroom state is versioned, replayable after reconnect, and transitions are idempotent", async () => {
  const fixture = await makeContentFixture();
  try {
    const classrooms = new ClassroomService(fixture.db);
    const session = classrooms.createSession(fixture.teacher, { courseId: fixture.course.id, title: "即時 Python 課堂" });
    classrooms.joinSession(fixture.student, session.session.id);
    const activity = classrooms.createActivity(fixture.teacher, session.session.id, { title: "輸出練習", prompt: { zh: "請輸出 1" } });
    const first = classrooms.startActivity(fixture.teacher, activity.id, "event-start-1");
    const replay = classrooms.startActivity(fixture.teacher, activity.id, "event-start-1");
    assert.equal(first.session.version, replay.session.version);
    assert.equal(replay.activity.status, "active");
    const locked = classrooms.lockActivity(fixture.teacher, activity.id, "event-lock-1");
    assert.equal(locked.activity.status, "locked");
    const studentState = classrooms.getState(fixture.student, session.session.id);
    assert.equal(studentState.session.version, locked.session.version);
    assert.equal(JSON.stringify(studentState).includes(fixture.student.id), false);
    assert.equal(JSON.stringify(studentState).includes("測試學生"), false);
    const replayed = classrooms.eventsSince(fixture.student, session.session.id, 0);
    assert.equal(replayed.serverVersion, locked.session.version);
    assert.equal(replayed.events.some((event) => event.eventType === "activity.lock"), true);
  } finally {
    await fixture.close();
  }
});

test("teacher gets anonymous progress while students receive only aggregate state", async () => {
  const fixture = await makeContentFixture();
  try {
    const questions = new QuestionService(fixture.db);
    const assignments = new AssignmentService(fixture.db);
    const question = questions.createQuestion(fixture.teacher, { courseId: fixture.course.id, type: "short_answer", titleZh: "答案", promptZh: "輸入", maxScore: 2 });
    questions.updateQuestion(fixture.teacher, question.id, { status: "published" });
    const assignment = assignments.createAssignment(fixture.teacher, { courseId: fixture.course.id, titleZh: "課堂題" });
    assignments.addQuestion(fixture.teacher, assignment.id, question.id);
    assignments.updateAssignment(fixture.teacher, assignment.id, { status: "published" });
    const session = new ClassroomService(fixture.db).createSession(fixture.teacher, { courseId: fixture.course.id, title: "進度" });
    const classroom = new ClassroomService(fixture.db);
    classroom.createActivity(fixture.teacher, session.session.id, { title: "答題", assignmentId: assignment.id, anonymousAnswers: true });
    const submission = assignments.beginSubmission(fixture.student, assignment.id);
    assignments.saveAnswer(fixture.student, submission.id, question.id, { answerText: "答案內容" });
    assignments.submit(fixture.student, submission.id);
    const teacherState = classroom.getState(fixture.teacher, session.session.id);
    assert.equal(teacherState.progress.submitted, 1);
    assert.equal(teacherState.anonymousAnswers[0].answerText, "答案內容");
    assert.equal("studentId" in teacherState.anonymousAnswers[0], false);
    const studentState = classroom.joinSession(fixture.student, session.session.id);
    assert.equal("anonymousAnswers" in studentState, false);
    assert.equal(studentState.progress.selfStatus, "submitted");
  } finally {
    await fixture.close();
  }
});
