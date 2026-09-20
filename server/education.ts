import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import type { LocalDatabase } from "./db.ts";
import { DomainError } from "./errors.ts";
import { generateOpaqueToken, hashPassword, hashToken, verifyPassword } from "./security.ts";

export type Role = "admin" | "teacher" | "student";
export type Actor = { id: string; role: Role };

type UserRow = {
  id: string;
  role: Role;
  username: string;
  student_number: string | null;
  chinese_name: string;
  english_name: string | null;
  email: string | null;
  password_hash: string;
  must_change_password: number;
  preferred_locale: "zh-Hant" | "en";
  status: "active" | "suspended" | "archived";
  failed_login_count: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PublicUser = Omit<UserRow, "password_hash" | "student_number" | "must_change_password" | "failed_login_count" | "locked_until"> & {
  studentNumber: string | null;
  mustChangePassword: boolean;
};

export type StudentImportRow = {
  studentNumber: string;
  chineseName: string;
  englishName?: string;
  className?: string;
  email?: string;
};

export type StudentImportError = { row: number; field?: string; code: string; message: string };

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;

function nowIso(clock: () => Date) {
  return clock().toISOString().replace("T", " ").replace(".000Z", "");
}

function publicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    role: row.role,
    username: row.username,
    studentNumber: row.student_number,
    chinese_name: row.chinese_name,
    english_name: row.english_name,
    email: row.email,
    preferred_locale: row.preferred_locale,
    status: row.status,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    mustChangePassword: row.must_change_password === 1,
  };
}

function normaliseText(value: unknown) {
  return String(value ?? "").replace(/^\uFEFF/, "").trim();
}

function normaliseHeader(value: unknown) {
  return normaliseText(value).toLowerCase().replace(/[\s_-]+/g, "");
}

const IMPORT_FIELDS: Record<string, keyof StudentImportRow> = {
  學號: "studentNumber",
  studentnumber: "studentNumber",
  studentno: "studentNumber",
  username: "studentNumber",
  中文姓名: "chineseName",
  chinesename: "chineseName",
  姓名: "chineseName",
  英文姓名: "englishName",
  englishname: "englishName",
  班別: "className",
  class: "className",
  classname: "className",
  電郵: "email",
  電子郵件: "email",
  email: "email",
};

function rowsToImport(rows: unknown[][]) {
  const [header, ...body] = rows;
  if (!header || header.length === 0) {
    throw new DomainError("invalid_import", "Import file must contain a header row");
  }
  const mapped = header.map((value) => IMPORT_FIELDS[normaliseHeader(value)]);
  if (!mapped.includes("studentNumber") || !mapped.includes("chineseName")) {
    throw new DomainError("invalid_import", "Import requires student number and Chinese name columns");
  }
  return body.map((row, index) => {
    const result: Partial<StudentImportRow> = {};
    mapped.forEach((field, column) => {
      if (field) result[field] = normaliseText(row[column]);
    });
    return { row: index + 2, value: result as StudentImportRow };
  });
}

function parseCsvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === "," || char === "\t") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((value) => value.some((cellValue) => normaliseText(cellValue) !== ""));
}

export function parseStudentImportFile(filename: string, bytes: Uint8Array) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
    return rowsToImport(parseCsvRows(new TextDecoder("utf-8", { fatal: false }).decode(bytes)));
  }
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const workbook = XLSX.read(Buffer.from(bytes), { type: "buffer", cellDates: false });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!firstSheet) throw new DomainError("invalid_import", "Excel file does not contain a worksheet");
    return rowsToImport(XLSX.utils.sheet_to_json<unknown[]>(firstSheet, { header: 1, defval: "" }));
  }
  throw new DomainError("unsupported_import", "Only CSV, TSV, XLS and XLSX files are supported");
}

function validateImportRows(rows: Array<{ row: number; value: StudentImportRow }>) {
  const errors: StudentImportError[] = [];
  const seen = new Set<string>();
  for (const item of rows) {
    const value = item.value;
    if (!value.studentNumber) errors.push({ row: item.row, field: "studentNumber", code: "required", message: "Student number is required" });
    if (!value.chineseName) errors.push({ row: item.row, field: "chineseName", code: "required", message: "Chinese name is required" });
    if (value.studentNumber && seen.has(value.studentNumber)) errors.push({ row: item.row, field: "studentNumber", code: "duplicate", message: "Student number is duplicated in the import" });
    if (value.studentNumber) seen.add(value.studentNumber);
    if (value.email && !/^\S+@\S+\.\S+$/.test(value.email)) errors.push({ row: item.row, field: "email", code: "invalid", message: "Email address is invalid" });
  }
  return errors;
}

function isActive(value: string | null | undefined) {
  return value === "active";
}

function sameOrAfter(date: Date, value: string | null) {
  return !value || new Date(value.replace(" ", "T") + "Z").getTime() <= date.getTime();
}

export class EducationService {
  private readonly database: LocalDatabase;
  private readonly clock: () => Date;

  constructor(database: LocalDatabase, clock: () => Date = () => new Date()) {
    this.database = database;
    this.clock = clock;
  }

  private audit(actorId: string | null, action: string, entityType: string, entityId: string | null, result: "success" | "denied" | "failure", metadata: Record<string, unknown> = {}) {
    this.database.run(
      `INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, result, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), actorId, action, entityType, entityId, result, JSON.stringify(metadata)],
    );
  }

  private userById(id: string) {
    return this.database.get<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
  }

  private userByUsername(username: string) {
    return this.database.get<UserRow>("SELECT * FROM users WHERE username = ?", [username.trim()]);
  }

  private requireUser(id: string) {
    const user = this.userById(id);
    if (!user) throw new DomainError("not_found", "User not found", 404);
    return user;
  }

  private requireActor(actor: Actor) {
    const user = this.requireUser(actor.id);
    if (user.role !== actor.role || !isActive(user.status)) throw new DomainError("unauthorized", "Active session required", 401);
    return user;
  }

  private canManageClass(actor: Actor, classId: string) {
    this.requireActor(actor);
    if (actor.role === "admin") return true;
    return Boolean(this.database.get("SELECT 1 FROM class_memberships WHERE class_id = ? AND user_id = ? AND member_role = 'teacher' AND status = 'active'", [classId, actor.id]));
  }

  private canManageCourse(actor: Actor, courseId: string) {
    this.requireActor(actor);
    if (actor.role === "admin") return true;
    return Boolean(this.database.get(`
      SELECT 1 FROM courses c
      WHERE c.id = ? AND (
        c.owner_teacher_id = ? OR EXISTS (
          SELECT 1 FROM course_class_assignments cca
          JOIN class_memberships cm ON cm.class_id = cca.class_id
          WHERE cca.course_id = c.id AND cm.user_id = ? AND cm.member_role = 'teacher' AND cm.status = 'active'
        )
      )`, [courseId, actor.id, actor.id]));
  }

  private canViewCourse(actor: Actor, courseId: string) {
    this.requireActor(actor);
    if (actor.role === "admin") return true;
    if (actor.role === "teacher") return this.canManageCourse(actor, courseId);
    return Boolean(this.database.get("SELECT 1 FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id WHERE ce.course_id = ? AND ce.student_id = ? AND ce.status = 'active' AND c.status = 'published'", [courseId, actor.id]));
  }

  private assertManageActiveCourse(actor: Actor, courseId: string) {
    this.requireActor(actor);
    if (actor.role === "student") throw new DomainError("forbidden", "Staff permission required", 403);
    const active = this.database.get("SELECT 1 FROM courses WHERE id = ? AND status != 'archived'", [courseId]);
    if (!active || !this.canManageCourse(actor, courseId)) throw new DomainError("not_found", "Course not found", 404);
  }

  getCourse(actor: Actor, courseId: string) {
    this.requireActor(actor);
    const course = this.database.get<Record<string, unknown>>("SELECT id, owner_teacher_id, title_zh, title_en, description_zh, description_en, join_code, status, created_at, updated_at FROM courses WHERE id = ?", [courseId]);
    if (!course || course.status === "archived" || !this.canViewCourse(actor, courseId)) throw new DomainError("not_found", "Course not found", 404);
    if (actor.role === "student") return this.database.get("SELECT id, title_zh, title_en, description_zh, description_en, status, created_at, updated_at FROM courses WHERE id = ?", [courseId]);
    return course;
  }

  createInitialAdmin(input: { username: string; chineseName: string; englishName?: string; email?: string }) {
    const count = this.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM users")?.count ?? 0;
    if (count !== 0) {
      throw new DomainError("bootstrap_unavailable", "Initial administrator can only be created on an empty database", 409);
    }
    return this.createUserInternal({ ...input, role: "admin" }, null);
  }

  createUser(actor: Actor, input: { role: Role; username: string; chineseName: string; englishName?: string; email?: string; studentNumber?: string }) {
    this.requireActor(actor);
    if (actor.role !== "admin") throw new DomainError("forbidden", "Only administrators can create accounts", 403);
    if (input.role === "admin") throw new DomainError("forbidden", "Administrator accounts must be provisioned separately", 403);
    return this.createUserInternal(input, actor.id);
  }

  private createUserInternal(input: { role: Role; username: string; chineseName: string; englishName?: string; email?: string; studentNumber?: string }, actorId: string | null) {
    const username = normaliseText(input.username);
    const chineseName = normaliseText(input.chineseName);
    if (!username || !chineseName) throw new DomainError("invalid_input", "Username and Chinese name are required");
    const initialPassword = `P${generateOpaqueToken(9)}1!`;
    const id = randomUUID();
    const timestamp = nowIso(this.clock);
    this.database.run(`INSERT INTO users (id, role, username, student_number, chinese_name, english_name, email, password_hash, must_change_password, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)`, [id, input.role, username, normaliseText(input.studentNumber) || null, chineseName, normaliseText(input.englishName) || null, normaliseText(input.email) || null, hashPassword(initialPassword), timestamp, timestamp]);
    this.audit(actorId, "account.created", "user", id, "success", { role: input.role });
    const user = this.requireUser(id);
    return { user: publicUser(user), initialPassword };
  }

  login(username: string, password: string) {
    const user = this.userByUsername(username);
    if (!user || !isActive(user.status) || !sameOrAfter(this.clock(), user.locked_until) || !verifyPassword(password, user.password_hash)) {
      if (user && isActive(user.status) && sameOrAfter(this.clock(), user.locked_until)) {
        const failures = user.failed_login_count + 1;
        const lock = failures >= MAX_LOGIN_FAILURES ? new Date(this.clock().getTime() + LOCK_DURATION_MS).toISOString().replace("T", " ").replace(".000Z", "") : null;
        this.database.run("UPDATE users SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE id = ?", [failures, lock, nowIso(this.clock), user.id]);
      }
      this.audit(user?.id ?? null, "auth.login", "user", user?.id ?? null, "denied", { reason: "invalid_credentials" });
      throw new DomainError("invalid_credentials", "Username or password is incorrect", 401);
    }
    const token = generateOpaqueToken();
    const timestamp = nowIso(this.clock);
    this.database.transaction(() => {
      this.database.run("UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?", [timestamp, timestamp, user.id]);
      this.database.run("INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)", [randomUUID(), user.id, hashToken(token), new Date(this.clock().getTime() + SESSION_TTL_MS).toISOString(), timestamp]);
      this.audit(user.id, "auth.login", "user", user.id, "success");
    });
    return { token, user: publicUser({ ...user, failed_login_count: 0, locked_until: null, last_login_at: timestamp, updated_at: timestamp }) };
  }

  session(token: string): Actor & { user: PublicUser; sessionId: string } {
    const row = this.database.get<UserRow & { session_id: string; expires_at: string }>(`
      SELECT u.*, s.id AS session_id, s.expires_at
      FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`, [hashToken(token), this.clock().toISOString()]);
    if (!row || !isActive(row.status)) throw new DomainError("unauthorized", "Session is invalid or expired", 401);
    this.database.run("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?", [nowIso(this.clock), row.session_id]);
    return { id: row.id, role: row.role, user: publicUser(row), sessionId: row.session_id };
  }

  logout(token: string) {
    const session = this.database.get<{ id: string; user_id: string }>("SELECT id, user_id FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL", [hashToken(token)]);
    if (!session) return;
    this.database.run("UPDATE auth_sessions SET revoked_at = ? WHERE id = ?", [nowIso(this.clock), session.id]);
    this.audit(session.user_id, "auth.logout", "auth_session", session.id, "success");
  }

  changePassword(token: string, newPassword: string) {
    const session = this.session(token);
    const timestamp = nowIso(this.clock);
    this.database.run("UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?", [hashPassword(newPassword), timestamp, session.id]);
    this.audit(session.id, "auth.password_changed", "user", session.id, "success");
    return { user: publicUser({ ...this.requireUser(session.id), must_change_password: 0, updated_at: timestamp }) };
  }

  resetPassword(actor: Actor, userId: string) {
    this.requireActor(actor);
    const target = this.requireUser(userId);
    const allowed = actor.role === "admin" || (actor.role === "teacher" && target.role === "student" && Boolean(this.database.get("SELECT 1 FROM class_memberships mine JOIN class_memberships target ON target.class_id = mine.class_id WHERE mine.user_id = ? AND mine.member_role = 'teacher' AND mine.status = 'active' AND target.user_id = ? AND target.member_role = 'student' AND target.status = 'active'", [actor.id, target.id])));
    if (!allowed) {
      this.audit(actor.id, "auth.password_reset", "user", userId, "denied");
      throw new DomainError("forbidden", "You cannot reset this account", 403);
    }
    const initialPassword = `P${generateOpaqueToken(9)}1!`;
    this.database.transaction(() => {
      this.database.run("UPDATE users SET password_hash = ?, must_change_password = 1, failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?", [hashPassword(initialPassword), nowIso(this.clock), userId]);
      this.database.run("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [nowIso(this.clock), userId]);
      this.audit(actor.id, "auth.password_reset", "user", userId, "success");
    });
    return { user: publicUser({ ...target, must_change_password: 1 }), initialPassword };
  }

  listUsers(actor: Actor, options: { role?: Role; includeArchived?: boolean } = {}) {
    this.requireActor(actor);
    if (actor.role === "student") throw new DomainError("forbidden", "Staff permission required", 403);
    const role = options.role && ["admin", "teacher", "student"].includes(options.role) ? options.role : null;
    const statusClause = options.includeArchived ? "" : " AND u.status != 'archived'";
    const roleClause = role ? " AND u.role = ?" : "";
    const parameters: unknown[] = role ? [role] : [];
    const projection = "SELECT u.id, u.role, u.username, u.student_number, u.chinese_name, u.english_name, u.email, u.must_change_password, u.preferred_locale, u.status, u.last_login_at, u.created_at, u.updated_at FROM users u";
    if (actor.role === "admin") return this.database.all(`${projection} WHERE 1 = 1${statusClause}${roleClause} ORDER BY u.role, u.chinese_name, u.username`, parameters);
    if (role && role !== "student") return [];
    return this.database.all(`${projection} WHERE u.role = 'student'${statusClause} AND EXISTS (SELECT 1 FROM class_memberships mine JOIN class_memberships target ON target.class_id = mine.class_id WHERE mine.user_id = ? AND mine.member_role = 'teacher' AND mine.status = 'active' AND target.user_id = u.id AND target.member_role = 'student' AND target.status = 'active') ORDER BY u.chinese_name, u.username`, [actor.id]);
  }

  archiveUser(actor: Actor, userId: string) {
    this.requireActor(actor);
    if (actor.role !== "admin") throw new DomainError("forbidden", "Only administrators can archive accounts", 403);
    if (userId === actor.id) throw new DomainError("conflict", "You cannot archive your own account", 409);
    const target = this.requireUser(userId);
    if (target.role === "admin") throw new DomainError("forbidden", "Administrator accounts require a separate governance process", 403);
    const timestamp = nowIso(this.clock);
    this.database.transaction(() => {
      this.database.run("UPDATE users SET status = 'archived', updated_at = ? WHERE id = ?", [timestamp, userId]);
      this.database.run("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [timestamp, userId]);
      this.database.run("UPDATE class_memberships SET status = 'archived', left_at = ? WHERE user_id = ? AND status = 'active'", [timestamp, userId]);
      this.database.run("UPDATE course_enrollments SET status = 'archived', left_at = ? WHERE student_id = ? AND status = 'active'", [timestamp, userId]);
      this.audit(actor.id, "account.archived", "user", userId, "success", { role: target.role });
    });
    return publicUser({ ...target, status: "archived", updated_at: timestamp });
  }

  createClass(actor: Actor, input: { name: string; academicYear: string; gradeLevel?: string; teacherId?: string }) {
    this.requireActor(actor);
    if (actor.role !== "admin" && actor.role !== "teacher") throw new DomainError("forbidden", "Only staff can create classes", 403);
    if (actor.role === "teacher" && input.teacherId && input.teacherId !== actor.id) {
      throw new DomainError("forbidden", "Teachers cannot assign a different class owner", 403);
    }
    const teacherId = actor.role === "teacher" ? actor.id : input.teacherId;
    if (!teacherId || this.userById(teacherId)?.role !== "teacher") throw new DomainError("invalid_input", "A teacher owner is required");
    const id = randomUUID();
    this.database.transaction(() => {
      this.database.run("INSERT INTO classes (id, name, academic_year, grade_level, created_by_id) VALUES (?, ?, ?, ?, ?)", [id, normaliseText(input.name), normaliseText(input.academicYear), normaliseText(input.gradeLevel) || null, actor.id]);
      this.database.run("INSERT INTO class_memberships (class_id, user_id, member_role) VALUES (?, ?, 'teacher')", [id, teacherId]);
      this.audit(actor.id, "class.created", "class", id, "success");
    });
    return this.database.get("SELECT * FROM classes WHERE id = ?", [id]);
  }

  addClassMember(actor: Actor, classId: string, userId: string) {
    if (!this.canManageClass(actor, classId)) throw new DomainError("forbidden", "You cannot manage this class", 403);
    const target = this.requireUser(userId);
    if (target.role === "admin") throw new DomainError("invalid_input", "Administrators cannot be class members");
    this.database.run("INSERT INTO class_memberships (class_id, user_id, member_role) VALUES (?, ?, ?) ON CONFLICT(class_id, user_id) DO UPDATE SET status = 'active', left_at = NULL", [classId, userId, target.role]);
    this.audit(actor.id, "class.member_added", "class", classId, "success", { memberRole: target.role });
  }

  listClasses(actor: Actor) {
    this.requireActor(actor);
    if (actor.role === "admin") return this.database.all("SELECT * FROM classes WHERE status = 'active' ORDER BY academic_year DESC, name");
    return this.database.all("SELECT c.* FROM classes c JOIN class_memberships cm ON cm.class_id = c.id WHERE cm.user_id = ? AND cm.status = 'active' AND c.status = 'active' ORDER BY c.academic_year DESC, c.name", [actor.id]);
  }

  listClassMembers(actor: Actor, classId: string) {
    if (!this.canManageClass(actor, classId)) throw new DomainError("forbidden", "You cannot view this class", 403);
    const exists = this.database.get("SELECT 1 FROM classes WHERE id = ? AND status = 'active'", [classId]);
    if (!exists) throw new DomainError("not_found", "Class not found", 404);
    return this.database.all("SELECT u.id, u.role, u.username, u.student_number, u.chinese_name, u.english_name, u.email, u.must_change_password, u.status, cm.member_role, cm.joined_at FROM class_memberships cm JOIN users u ON u.id = cm.user_id WHERE cm.class_id = ? AND cm.status = 'active' AND u.status = 'active' ORDER BY CASE cm.member_role WHEN 'teacher' THEN 0 ELSE 1 END, u.chinese_name, u.username", [classId]);
  }

  updateClass(actor: Actor, classId: string, input: { name?: string; academicYear?: string; gradeLevel?: string }) {
    if (!this.canManageClass(actor, classId)) throw new DomainError("forbidden", "You cannot manage this class", 403);
    const current = this.database.get("SELECT * FROM classes WHERE id = ?", [classId]);
    if (!current) throw new DomainError("not_found", "Class not found", 404);
    this.database.run("UPDATE classes SET name = ?, academic_year = ?, grade_level = ?, updated_at = ? WHERE id = ?", [normaliseText(input.name) || current.name, normaliseText(input.academicYear) || current.academic_year, normaliseText(input.gradeLevel) || current.grade_level, nowIso(this.clock), classId]);
    this.audit(actor.id, "class.updated", "class", classId, "success");
    return this.database.get("SELECT * FROM classes WHERE id = ?", [classId]);
  }

  archiveClass(actor: Actor, classId: string) {
    if (!this.canManageClass(actor, classId)) throw new DomainError("forbidden", "You cannot manage this class", 403);
    this.database.transaction(() => {
      this.database.run("UPDATE classes SET status = 'archived', updated_at = ? WHERE id = ?", [nowIso(this.clock), classId]);
      this.database.run("UPDATE class_memberships SET status = 'archived', left_at = ? WHERE class_id = ? AND status = 'active'", [nowIso(this.clock), classId]);
      this.audit(actor.id, "class.archived", "class", classId, "success");
    });
  }

  createCourse(actor: Actor, input: { titleZh: string; titleEn?: string; descriptionZh?: string; descriptionEn?: string; joinCode?: string; teacherId?: string }) {
    this.requireActor(actor);
    if (actor.role !== "teacher" && actor.role !== "admin") throw new DomainError("forbidden", "Only staff can create courses", 403);
    const ownerTeacherId = actor.role === "teacher" ? actor.id : input.teacherId;
    if (!ownerTeacherId) throw new DomainError("invalid_input", "A teacher must create or own the course");
    if (this.userById(ownerTeacherId)?.role !== "teacher") throw new DomainError("invalid_input", "Course owner must be a teacher");
    const id = randomUUID();
    const joinCode = normaliseText(input.joinCode) || generateOpaqueToken(6).toUpperCase();
    this.database.run("INSERT INTO courses (id, owner_teacher_id, title_zh, title_en, description_zh, description_en, join_code) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, ownerTeacherId, normaliseText(input.titleZh), normaliseText(input.titleEn) || null, normaliseText(input.descriptionZh) || null, normaliseText(input.descriptionEn) || null, joinCode]);
    this.audit(actor.id, "course.created", "course", id, "success");
    return this.database.get("SELECT id, owner_teacher_id, title_zh, title_en, description_zh, description_en, join_code, status, created_at, updated_at FROM courses WHERE id = ?", [id]);
  }

  updateCourse(actor: Actor, courseId: string, input: { titleZh?: string; titleEn?: string; descriptionZh?: string; descriptionEn?: string; joinCode?: string; status?: "draft" | "published" | "archived" }) {
    this.assertManageActiveCourse(actor, courseId);
    const current = this.database.get("SELECT * FROM courses WHERE id = ?", [courseId]);
    if (!current) throw new DomainError("not_found", "Course not found", 404);
    const status = input.status ?? current.status;
    this.database.run("UPDATE courses SET title_zh = ?, title_en = ?, description_zh = ?, description_en = ?, join_code = ?, status = ?, published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END, updated_at = ? WHERE id = ?", [normaliseText(input.titleZh) || current.title_zh, normaliseText(input.titleEn) || current.title_en, normaliseText(input.descriptionZh) || current.description_zh, normaliseText(input.descriptionEn) || current.description_en, normaliseText(input.joinCode) || current.join_code, status, status, nowIso(this.clock), nowIso(this.clock), courseId]);
    this.audit(actor.id, "course.updated", "course", courseId, "success", { status });
    return this.database.get("SELECT * FROM courses WHERE id = ?", [courseId]);
  }

  archiveCourse(actor: Actor, courseId: string) {
    return this.updateCourse(actor, courseId, { status: "archived" });
  }

  assignClassToCourse(actor: Actor, courseId: string, classId: string) {
    this.assertManageActiveCourse(actor, courseId);
    if (!this.canManageClass(actor, classId)) throw new DomainError("not_found", "Class not found", 404);
    this.database.transaction(() => {
      this.database.run("INSERT INTO course_class_assignments (course_id, class_id, assigned_by_id) VALUES (?, ?, ?) ON CONFLICT(course_id, class_id) DO NOTHING", [courseId, classId, actor.id]);
      this.database.run(`INSERT INTO course_enrollments (course_id, student_id, source, source_class_id)
        SELECT ?, cm.user_id, 'class', cm.class_id FROM class_memberships cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.class_id = ? AND cm.member_role = 'student' AND cm.status = 'active' AND u.status = 'active'
        ON CONFLICT(course_id, student_id) DO UPDATE SET status = 'active', left_at = NULL`, [courseId, classId]);
      this.audit(actor.id, "course.class_assigned", "course", courseId, "success", { classId });
    });
  }

  listCourseClasses(actor: Actor, courseId: string) {
    this.assertManageActiveCourse(actor, courseId);
    return this.database.all("SELECT c.id, c.name, c.academic_year, c.grade_level, c.status, COUNT(CASE WHEN cm.member_role = 'student' AND cm.status = 'active' THEN 1 END) AS student_count FROM course_class_assignments cca JOIN classes c ON c.id = cca.class_id LEFT JOIN class_memberships cm ON cm.class_id = c.id WHERE cca.course_id = ? AND c.status = 'active' GROUP BY c.id ORDER BY c.academic_year DESC, c.name", [courseId]);
  }

  joinCourseByCode(actor: Actor, joinCode: string) {
    this.requireActor(actor);
    if (actor.role !== "student") throw new DomainError("forbidden", "Only students can join with a course code", 403);
    const course = this.database.get<{ id: string; status: string }>("SELECT id, status FROM courses WHERE join_code = ?", [normaliseText(joinCode)]);
    if (!course || course.status !== "published") throw new DomainError("not_found", "Course code is invalid", 404);
    this.database.run("INSERT INTO course_enrollments (course_id, student_id, source) VALUES (?, ?, 'join_code') ON CONFLICT(course_id, student_id) DO UPDATE SET status = 'active', left_at = NULL", [course.id, actor.id]);
    this.audit(actor.id, "course.joined", "course", course.id, "success", { source: "join_code" });
    return this.database.get("SELECT * FROM courses WHERE id = ?", [course.id]);
  }

  listCourses(actor: Actor) {
    this.requireActor(actor);
    if (actor.role === "admin") return this.database.all("SELECT * FROM courses WHERE status != 'archived' ORDER BY created_at DESC");
    if (actor.role === "teacher") return this.database.all(`SELECT DISTINCT c.* FROM courses c LEFT JOIN course_class_assignments cca ON cca.course_id = c.id LEFT JOIN class_memberships cm ON cm.class_id = cca.class_id WHERE c.status != 'archived' AND (c.owner_teacher_id = ? OR (cm.user_id = ? AND cm.member_role = 'teacher' AND cm.status = 'active')) ORDER BY c.created_at DESC`, [actor.id, actor.id]);
    return this.database.all("SELECT c.* FROM courses c JOIN course_enrollments ce ON ce.course_id = c.id WHERE ce.student_id = ? AND ce.status = 'active' AND c.status = 'published' ORDER BY c.created_at DESC", [actor.id]);
  }

  createUnit(actor: Actor, courseId: string, input: { titleZh: string; titleEn?: string; descriptionZh?: string; descriptionEn?: string; position?: number }) {
    this.assertManageActiveCourse(actor, courseId);
    const id = randomUUID();
    this.database.run("INSERT INTO units (id, course_id, title_zh, title_en, description_zh, description_en, position) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, courseId, normaliseText(input.titleZh), normaliseText(input.titleEn) || null, normaliseText(input.descriptionZh) || null, normaliseText(input.descriptionEn) || null, input.position ?? 0]);
    this.audit(actor.id, "unit.created", "unit", id, "success", { courseId });
    return this.database.get("SELECT * FROM units WHERE id = ?", [id]);
  }

  updateUnit(actor: Actor, unitId: string, input: { titleZh?: string; titleEn?: string; descriptionZh?: string; descriptionEn?: string; position?: number; status?: "draft" | "published" | "archived" }) {
    const current = this.database.get<{ course_id: string; title_zh: string; title_en: string | null; description_zh: string | null; description_en: string | null; position: number; status: string }>("SELECT * FROM units WHERE id = ?", [unitId]);
    if (!current) throw new DomainError("not_found", "Unit not found", 404);
    this.assertManageActiveCourse(actor, current.course_id);
    const status = input.status ?? current.status;
    this.database.run("UPDATE units SET title_zh = ?, title_en = ?, description_zh = ?, description_en = ?, position = ?, status = ?, published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END, updated_at = ? WHERE id = ?", [normaliseText(input.titleZh) || current.title_zh, normaliseText(input.titleEn) || current.title_en, normaliseText(input.descriptionZh) || current.description_zh, normaliseText(input.descriptionEn) || current.description_en, input.position ?? current.position, status, status, nowIso(this.clock), nowIso(this.clock), unitId]);
    this.audit(actor.id, "unit.updated", "unit", unitId, "success", { status });
    return this.database.get("SELECT * FROM units WHERE id = ?", [unitId]);
  }

  archiveUnit(actor: Actor, unitId: string) {
    const current = this.database.get<{ id: string; course_id: string }>("SELECT id, course_id FROM units WHERE id = ?", [unitId]);
    if (!current) throw new DomainError("not_found", "Unit not found", 404);
    this.assertManageActiveCourse(actor, current.course_id);
    const dependent = this.database.get<{ count: number }>("SELECT (SELECT COUNT(*) FROM materials WHERE unit_id = ? AND status != 'archived') + (SELECT COUNT(*) FROM questions WHERE unit_id = ? AND status != 'archived') + (SELECT COUNT(*) FROM assignments WHERE unit_id = ? AND status != 'archived') AS count", [unitId, unitId, unitId])?.count ?? 0;
    if (dependent > 0) throw new DomainError("dependency_conflict", "Unit still has active materials, questions or assignments", 409);
    return this.updateUnit(actor, unitId, { status: "archived" });
  }

  listUnits(actor: Actor, courseId: string) {
    this.getCourse(actor, courseId);
    const status = actor.role === "student" ? "status = 'published'" : "status != 'archived'";
    return this.database.all(`SELECT id, course_id, title_zh, title_en, description_zh, description_en, position, status, published_at, created_at, updated_at FROM units WHERE course_id = ? AND ${status} ORDER BY position, created_at`, [courseId]);
  }

  importStudents(actor: Actor, rows: Array<{ row: number; value: StudentImportRow }>, options: { classId?: string } = {}) {
    this.requireActor(actor);
    if (actor.role !== "admin" && actor.role !== "teacher") throw new DomainError("forbidden", "Only staff can import students", 403);
    const normalisedRows = rows.map((item) => ({
      row: item.row,
      value: {
        studentNumber: normaliseText(item.value.studentNumber),
        chineseName: normaliseText(item.value.chineseName),
        englishName: normaliseText(item.value.englishName),
        className: normaliseText(item.value.className),
        email: normaliseText(item.value.email),
      },
    }));
    const errors = validateImportRows(normalisedRows);
    if (options.classId && !this.canManageClass(actor, options.classId)) errors.push({ row: 0, field: "classId", code: "forbidden", message: "You cannot import into this class" });
    for (const item of normalisedRows) {
      if (item.value.studentNumber && this.database.get("SELECT 1 FROM users WHERE student_number = ?", [item.value.studentNumber])) errors.push({ row: item.row, field: "studentNumber", code: "duplicate", message: "Student number already exists" });
    }
    if (errors.length > 0) return { created: [], errors };
    const created: Array<{ id: string; studentNumber: string; initialPassword: string }> = [];
    this.database.transaction(() => {
      for (const item of normalisedRows) {
        const result = this.createUserInternal({ role: "student", username: item.value.studentNumber, studentNumber: item.value.studentNumber, chineseName: item.value.chineseName, englishName: item.value.englishName, email: item.value.email }, actor.id);
        created.push({ id: result.user.id, studentNumber: item.value.studentNumber, initialPassword: result.initialPassword });
        if (options.classId) this.database.run("INSERT INTO class_memberships (class_id, user_id, member_role) VALUES (?, ?, 'student')", [options.classId, result.user.id]);
      }
      this.audit(actor.id, "students.imported", "import", null, "success", { count: created.length, classId: options.classId ?? null });
    });
    return { created, errors: [] as StudentImportError[] };
  }
}
