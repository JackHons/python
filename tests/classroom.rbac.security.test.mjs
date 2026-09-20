import assert from "node:assert/strict";
import test from "node:test";

const { ClassroomService } = await import("../server/classroom.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("only scoped teachers control a classroom and archived sessions are not readable", async () => {
  const fixture = await makeContentFixture();
  try {
    const classroom = new ClassroomService(fixture.db);
    const session = classroom.createSession(fixture.teacher, { courseId: fixture.course.id, title: "RBAC" });
    assert.throws(() => classroom.createSession(fixture.student, { courseId: fixture.course.id, title: "bad" }), { code: "forbidden" });
    fixture.db.run("UPDATE classroom_sessions SET status = 'archived' WHERE id = ?", [session.session.id]);
    assert.throws(() => classroom.getState(fixture.student, session.session.id), { code: "not_found" });
  } finally {
    await fixture.close();
  }
});
