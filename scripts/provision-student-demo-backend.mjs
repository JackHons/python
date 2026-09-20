import { randomUUID } from "node:crypto";
import { createBackendApp } from "../server/http/backend.ts";
import { generateOpaqueToken, hashPassword } from "../server/security.ts";

if (process.env.LOCAL_STUDENT_DEMO_CONFIRM !== "PROVISION_STUDENT_DEMO") throw new Error("Set LOCAL_STUDENT_DEMO_CONFIRM=PROVISION_STUDENT_DEMO");

const app = createBackendApp({ databasePath: process.env.DATABASE_PATH });
const db = app.services.db;
const education = app.services.education;
const materials = app.services.materials;
const questions = app.services.questions;
const assignments = app.services.assignments;
const now = new Date().toISOString().replace("T", " ").replace(".000Z", "");
const adminRow = db.get("SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1");
if (!adminRow) throw new Error("An active administrator is required before provisioning the student demo");
const admin = { id: adminRow.id, role: "admin" };
const generatedPassword = `D${generateOpaqueToken(28)}!`;
const demoUsername = "student-demo";
const joinCode = "DEMO-PYTHON";

try {
  let teacherRow = db.get("SELECT id FROM users WHERE role = 'teacher' AND status = 'active' ORDER BY created_at LIMIT 1");
  if (!teacherRow) {
    const teacher = education.createUser(admin, { role: "teacher", username: "teacher-demo", chineseName: "示範教師", englishName: "Demo Teacher" });
    teacherRow = { id: teacher.user.id };
  }

  const existingStudent = db.get("SELECT id, role FROM users WHERE username = ?", [demoUsername]);
  if (existingStudent && existingStudent.role !== "student") throw new Error("student-demo is already used by a non-student account");
  let studentId = existingStudent?.id;
  db.transaction(() => {
    if (!studentId) {
      studentId = randomUUID();
      db.run(`INSERT INTO users (id, role, username, student_number, chinese_name, english_name, email, password_hash, must_change_password, status, created_at, updated_at)
        VALUES (?, 'student', ?, ?, ?, ?, NULL, ?, 0, 'active', ?, ?)`, [studentId, demoUsername, "DEMO-STUDENT", "示範學生", "Demo Student", hashPassword(generatedPassword), now, now]);
    } else {
      db.run("UPDATE users SET password_hash = ?, must_change_password = 0, status = 'active', failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?", [hashPassword(generatedPassword), now, studentId]);
      db.run("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [now, studentId]);
    }
  });
  const student = { id: studentId, role: "student" };
  const teacher = { id: teacherRow.id, role: "teacher" };

  let course = db.get("SELECT * FROM courses WHERE join_code = ?", [joinCode]);
  if (!course) course = education.createCourse(admin, { teacherId: teacher.id, titleZh: "Python 示範課程", titleEn: "Python Demo Course", descriptionZh: "示範 Python 輸入、輸出及測試案例。", descriptionEn: "A short demo of Python input, output, and test cases.", joinCode });
  else education.updateCourse(admin, course.id, { titleZh: "Python 示範課程", titleEn: "Python Demo Course", descriptionZh: "示範 Python 輸入、輸出及測試案例。", descriptionEn: "A short demo of Python input, output, and test cases.", status: "published" });
  course = db.get("SELECT * FROM courses WHERE id = ?", [course.id]);
  if (!course) throw new Error("Demo course was not persisted");
  education.updateCourse(admin, course.id, { status: "published" });
  db.run("INSERT INTO course_enrollments (course_id, student_id, source) VALUES (?, ?, 'demo') ON CONFLICT(course_id, student_id) DO UPDATE SET status = 'active', left_at = NULL", [course.id, student.id]);

  let unit = db.get("SELECT * FROM units WHERE course_id = ? AND title_zh = ? ORDER BY created_at LIMIT 1", [course.id, "Python 入門示範"]);
  if (!unit) unit = education.createUnit(admin, course.id, { titleZh: "Python 入門示範", titleEn: "Python Demo Basics", descriptionZh: "由 input() 到第一個測試案例。", descriptionEn: "From input() to your first test case.", position: 0 });
  education.updateUnit(admin, unit.id, { status: "published" });

  let material = db.get("SELECT * FROM materials WHERE unit_id = ? AND title_zh = ? ORDER BY created_at LIMIT 1", [unit.id, "Input 與輸出"]);
  if (!material) material = await materials.createMaterial(admin, unit.id, { kind: "web_content", titleZh: "Input 與輸出", titleEn: "Input and output", bodyZh: "使用 input() 讀取資料，再用 print() 顯示結果。試試輸入 3 並輸出它的平方。", bodyEn: "Read data with input(), then print the result. Try reading 3 and printing its square." });
  await materials.updateMaterial(admin, material.id, { status: "published" });

  let question = db.get("SELECT * FROM questions WHERE course_id = ? AND title_zh = ? ORDER BY created_at LIMIT 1", [course.id, "計算輸入數字的平方"]);
  if (!question) question = questions.createQuestion(admin, { courseId: course.id, unitId: unit.id, type: "python_code", titleZh: "計算輸入數字的平方", titleEn: "Square an input number", promptZh: "請讀取一個整數並輸出它的平方。", promptEn: "Read an integer and print its square.", starterCode: "n = int(input())\n# 在這裡完成程式\n", solutionCode: "n = int(input())\nprint(n * n)", maxScore: 10 });
  const testCount = db.get("SELECT COUNT(*) AS count FROM test_cases WHERE question_id = ?", [question.id])?.count ?? 0;
  if (testCount === 0) {
    questions.addTestCase(admin, question.id, { visibility: "public", label: "公開案例：3", inputJson: "3\n", expectedOutput: "9", position: 0 });
    questions.addTestCase(admin, question.id, { visibility: "hidden", label: "隱藏案例", inputJson: "5\n", expectedOutput: "25", position: 1 });
  }
  questions.updateQuestion(admin, question.id, { status: "published" });

  let assignment = db.get("SELECT * FROM assignments WHERE course_id = ? AND title_zh = ? ORDER BY created_at LIMIT 1", [course.id, "Python 平方練習"]);
  if (!assignment) assignment = assignments.createAssignment(admin, { courseId: course.id, unitId: unit.id, titleZh: "Python 平方練習", titleEn: "Python square practice", instructionsZh: "完成程式後執行公開案例，再提交功課。", instructionsEn: "Complete the program, run the public case, then submit.", maxAttempts: 3, allowResubmit: true });
  const linked = db.get("SELECT 1 FROM assignment_items WHERE assignment_id = ? AND question_id = ?", [assignment.id, question.id]);
  if (!linked) assignments.addQuestion(admin, assignment.id, question.id, 0);
  assignments.updateAssignment(admin, assignment.id, { status: "published" });

  db.run("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, result, metadata_json) VALUES (?, ?, 'local.student_demo.provisioned', 'user', ?, 'success', ?)", [randomUUID(), admin.id, student.id, JSON.stringify({ demoOnly: true, username: demoUsername, courseId: course.id, assignmentId: assignment.id })]);
  console.log(JSON.stringify({ username: demoUsername, initialPassword: generatedPassword, mustChangePassword: false, courseId: course.id, assignmentId: assignment.id, joinCode }));
} finally {
  app.close();
}
