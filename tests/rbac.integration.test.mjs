import assert from "node:assert/strict";
import test from "node:test";

const { openLocalDatabase, assertDatabaseIntegrity } = await import("../server/db.ts");
const { EducationService } = await import("../server/education.ts");
const { DomainError } = await import("../server/errors.ts");

test("class and course scope is enforced on the server and assignment is idempotent", () => {
  const db = openLocalDatabase(":memory:");
  const service = new EducationService(db);
  const admin = service.createInitialAdmin({ username: "admin", chineseName: "管理員" });
  const adminActor = { id: admin.user.id, role: "admin" };
  const teacherOne = service.createUser(adminActor, { role: "teacher", username: "teacher-one", chineseName: "教師一" });
  const teacherTwo = service.createUser(adminActor, { role: "teacher", username: "teacher-two", chineseName: "教師二" });
  const studentOne = service.createUser(adminActor, { role: "student", username: "student-one", chineseName: "學生一", studentNumber: "S001" });
  const studentTwo = service.createUser(adminActor, { role: "student", username: "student-two", chineseName: "學生二", studentNumber: "S002" });
  const teacherOneActor = { id: teacherOne.user.id, role: "teacher" };
  const teacherTwoActor = { id: teacherTwo.user.id, role: "teacher" };
  const classOne = service.createClass(teacherOneActor, { name: "3A", academicYear: "2026" });
  const classTwo = service.createClass(teacherTwoActor, { name: "3B", academicYear: "2026" });
  service.addClassMember(teacherOneActor, classOne.id, studentOne.user.id);
  service.addClassMember(teacherTwoActor, classTwo.id, studentTwo.user.id);
  assert.deepEqual(service.listClasses(teacherOneActor).map((item) => item.id), [classOne.id]);
  assert.throws(() => service.addClassMember(teacherOneActor, classTwo.id, studentOne.user.id), (error) => error instanceof DomainError && error.code === "forbidden");

  const courseOne = service.createCourse(teacherOneActor, { titleZh: "Python 基礎", joinCode: "PY-ONE" });
  const courseTwo = service.createCourse(teacherTwoActor, { titleZh: "Python 進階", joinCode: "PY-TWO" });
  assert.deepEqual(service.listCourses(teacherOneActor).map((item) => item.id), [courseOne.id]);
  service.assignClassToCourse(teacherOneActor, courseOne.id, classOne.id);
  service.assignClassToCourse(teacherOneActor, courseOne.id, classOne.id);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM course_enrollments WHERE course_id = ?", [courseOne.id]).count, 1);

  service.updateCourse(teacherOneActor, courseOne.id, { status: "published", titleEn: "Python Basics" });
  service.joinCourseByCode({ id: studentTwo.user.id, role: "student" }, "PY-ONE");
  assert.equal(service.listCourses({ id: studentTwo.user.id, role: "student" }).length, 1);
  assert.throws(() => service.listUnits({ id: studentOne.user.id, role: "student" }, courseTwo.id), (error) => error instanceof DomainError && error.code === "not_found" && error.status === 404);

  assert.throws(() => service.createClass(teacherOneActor, { name: "bad", academicYear: "2026", teacherId: studentOne.user.id }), (error) => error instanceof DomainError && error.code === "forbidden");
  assert.equal(assertDatabaseIntegrity(db).violations.length, 0);
  db.close();
});
