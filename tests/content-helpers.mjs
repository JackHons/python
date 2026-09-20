import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { openLocalDatabase } = await import("../server/db.ts");
const { EducationService } = await import("../server/education.ts");
const { LocalFileStorage } = await import("../server/storage.ts");

export async function makeContentFixture(options = {}) {
  const db = openLocalDatabase(":memory:");
  const education = new EducationService(db);
  const adminResult = education.createInitialAdmin({ username: "fixture-admin", chineseName: "測試管理員" });
  const admin = { id: adminResult.user.id, role: "admin" };
  const teacherResult = education.createUser(admin, { role: "teacher", username: "fixture-teacher", chineseName: "測試教師" });
  const studentResult = education.createUser(admin, { role: "student", username: "fixture-student", chineseName: "測試學生", studentNumber: "S0001" });
  const teacher = { id: teacherResult.user.id, role: "teacher" };
  const student = { id: studentResult.user.id, role: "student" };
  const classRow = education.createClass(admin, { name: "測試班", academicYear: "2026", teacherId: teacher.id });
  education.addClassMember(admin, classRow.id, student.id);
  const course = education.createCourse(teacher, { titleZh: "Python 測試課程", joinCode: "PYTEST1" });
  education.updateCourse(teacher, course.id, { status: "published" });
  education.assignClassToCourse(teacher, course.id, classRow.id);
  const unit = education.createUnit(teacher, course.id, { titleZh: "第一單元" });
  education.updateUnit(teacher, unit.id, { status: "published" });
  const directory = await mkdtemp(join(tmpdir(), "learning-platform-content-"));
  const storage = new LocalFileStorage(directory, options.maxBytes ?? 1024);
  return {
    db,
    education,
    admin,
    teacher,
    student,
    course,
    unit,
    storage,
    async close() {
      db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
