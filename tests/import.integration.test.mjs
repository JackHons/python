import assert from "node:assert/strict";
import test from "node:test";

const { openLocalDatabase, assertDatabaseIntegrity } = await import("../server/db.ts");
const { EducationService, parseStudentImportFile } = await import("../server/education.ts");

test("CSV and XLSX import validate all rows before one transaction", async () => {
  const db = openLocalDatabase(":memory:");
  const service = new EducationService(db);
  const admin = service.createInitialAdmin({ username: "admin", chineseName: "管理員" });
  const teacher = service.createUser({ id: admin.user.id, role: "admin" }, { role: "teacher", username: "teacher", chineseName: "教師" });
  const teacherActor = { id: teacher.user.id, role: "teacher" };
  const classRow = service.createClass(teacherActor, { name: "3A", academicYear: "2026" });

  const csv = parseStudentImportFile("students.csv", new TextEncoder().encode("學號,中文姓名,英文姓名,電郵\nS001,學生一,Student One,one@example.test\nS002,,Student Two,two@example.test\n"));
  const rejected = service.importStudents(teacherActor, csv, { classId: classRow.id });
  assert.equal(rejected.created.length, 0);
  assert.equal(rejected.errors.length, 1);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM users WHERE role = 'student'").count, 0);

  const valid = parseStudentImportFile("students.csv", new TextEncoder().encode("學號,中文姓名,班別\nS001,學生一,3A\nS002,學生二,3A\n"));
  const imported = service.importStudents(teacherActor, valid, { classId: classRow.id });
  assert.equal(imported.errors.length, 0);
  assert.equal(imported.created.length, 2);
  assert.ok(imported.created.every((item) => item.initialPassword.length >= 8));
  assert.equal(db.get("SELECT COUNT(*) AS count FROM class_memberships WHERE class_id = ? AND member_role = 'student'", [classRow.id]).count, 2);

  const XLSX = await import("xlsx");
  const sheet = XLSX.utils.aoa_to_sheet([["學號", "中文姓名"], ["S003", "學生三"]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Students");
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const excelRows = parseStudentImportFile("students.xlsx", bytes);
  assert.equal(excelRows[0].value.studentNumber, "S003");
  assert.throws(
    () => parseStudentImportFile("students.xlsx", new Uint8Array(25 * 1024 * 1024 + 1)),
    (error) => error.code === "invalid_import" && error.status === 400,
  );
  const wideHeader = ["學號", "中文姓名", ...Array.from({ length: 63 }, (_, index) => `extra-${index}`)].join(",");
  assert.throws(
    () => parseStudentImportFile("students.csv", new TextEncoder().encode(`${wideHeader}\nS004,學生四\n`)),
    (error) => error.code === "invalid_import" && error.status === 400,
  );

  const audit = db.all("SELECT metadata_json FROM audit_logs WHERE action = 'students.imported'");
  assert.ok(audit.length >= 1);
  assert.equal(audit.some((row) => String(row.metadata_json).includes("initialPassword")), false);
  assert.equal(assertDatabaseIntegrity(db).integrity, "ok");
  db.close();
});
