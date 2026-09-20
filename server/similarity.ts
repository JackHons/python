import { randomUUID } from "node:crypto";
import type { Actor } from "./education.ts";
import type { LocalDatabase } from "./db.ts";
import { DomainError } from "./errors.ts";

const STAFF = new Set(["admin", "teacher"]);
const PYTHON_KEYWORDS = new Set(["and", "as", "assert", "async", "await", "break", "case", "class", "continue", "def", "del", "elif", "else", "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "match", "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while", "with", "yield"]);
const MAX_COMPARISONS = 2000;
type SimilarityAnswerRow = { answer_id: string; student_id: string; assignment_id: string; course_id: string; code: string; student_name: string };

function now() { return new Date().toISOString(); }
function canManageCourse(db: LocalDatabase, actor: Actor, courseId: string) {
  if (actor.role === "admin") return true;
  if (actor.role !== "teacher") return false;
  return Boolean(db.get("SELECT 1 FROM courses c WHERE c.id = ? AND (c.owner_teacher_id = ? OR EXISTS (SELECT 1 FROM course_class_assignments cca JOIN class_memberships cm ON cm.class_id = cca.class_id WHERE cca.course_id = c.id AND cm.user_id = ? AND cm.member_role = 'teacher' AND cm.status = 'active'))", [courseId, actor.id, actor.id]));
}
function tokens(code: string) {
  const source = code.replace(/#[^\r\n]*/g, " ");
  const matches = source.match(/(?:==|!=|<=|>=|:=|->|\*\*|\/\/|[A-Za-z_]\w*|\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s])/g) ?? [];
  return matches.map((value) => {
    if (/^[A-Za-z_]\w*$/.test(value)) return PYTHON_KEYWORDS.has(value) ? value : "ID";
    if (/^\d/.test(value)) return "NUM";
    if (/^["']/.test(value)) return "STR";
    return value;
  });
}
function similarity(left: string, right: string) {
  const makeSet = (values: string[]) => new Set(values.length < 5 ? values.map((_, index) => values.slice(index, index + 1).join(" ")) : values.slice(0, -4).map((_, index) => values.slice(index, index + 5).join(" ")));
  const a = makeSet(tokens(left));
  const b = makeSet(tokens(right));
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export class SimilarityService {
  private readonly db: LocalDatabase;
  constructor(db: LocalDatabase) { this.db = db; }
  private scoped(actor: Actor, courseId: string) {
    if (!STAFF.has(actor.role) || !canManageCourse(this.db, actor, courseId)) throw new DomainError("forbidden", "Similarity reports require course staff permission", 403);
  }
  private report(id: string) {
    return this.db.get<Record<string, unknown>>(`SELECT csr.*, ua.chinese_name AS student_a_name, ua.student_number AS student_a_number, ub.chinese_name AS student_b_name, ub.student_number AS student_b_number,
      a.title_zh AS assignment_title FROM code_similarity_reports csr
      JOIN users ua ON ua.id = csr.student_a_id JOIN users ub ON ub.id = csr.student_b_id JOIN assignments a ON a.id = csr.assignment_id WHERE csr.id = ?`, [id]);
  }
  list(actor: Actor, courseId: string, assignmentId?: string) {
    this.scoped(actor, courseId);
    return this.db.all(`SELECT csr.*, ua.chinese_name AS student_a_name, ua.student_number AS student_a_number, ub.chinese_name AS student_b_name, ub.student_number AS student_b_number,
      a.title_zh AS assignment_title FROM code_similarity_reports csr
      JOIN users ua ON ua.id = csr.student_a_id JOIN users ub ON ub.id = csr.student_b_id JOIN assignments a ON a.id = csr.assignment_id
      WHERE csr.course_id = ? AND (? IS NULL OR csr.assignment_id = ?) ORDER BY csr.similarity DESC, csr.created_at DESC`, [courseId, assignmentId ?? null, assignmentId ?? null]);
  }
  run(actor: Actor, courseId: string, input: { assignmentId?: string; threshold?: number }) {
    this.scoped(actor, courseId);
    const threshold = input.threshold ?? 0.8;
    if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 0.99) throw new DomainError("invalid_input", "Similarity threshold must be between 0.5 and 0.99");
    if (input.assignmentId && !this.db.get("SELECT 1 FROM assignments WHERE id = ? AND course_id = ?", [input.assignmentId, courseId])) throw new DomainError("invalid_reference", "Assignment and course must match");
    const rows = this.db.all<SimilarityAnswerRow>(`SELECT sa.id AS answer_id, sa.student_id, sa.assignment_id, a.course_id, cs.code, u.chinese_name AS student_name
      FROM submission_answers sa JOIN submissions s ON s.id = sa.submission_id JOIN assignments a ON a.id = sa.assignment_id
      JOIN users u ON u.id = sa.student_id JOIN code_snapshots cs ON cs.id = (
        SELECT latest.id FROM code_snapshots latest WHERE latest.submission_answer_id = sa.id AND latest.source = 'submit' ORDER BY latest.sequence_number DESC, latest.created_at DESC LIMIT 1)
      WHERE a.course_id = ? AND s.status != 'draft' AND json_extract(sa.question_snapshot_json, '$.type') IN ('code_fill', 'python_code') AND (? IS NULL OR sa.assignment_id = ?)
      ORDER BY sa.assignment_id, sa.student_id, sa.id`, [courseId, input.assignmentId ?? null, input.assignmentId ?? null]);
    const possible = rows.reduce((sum, _, index) => sum + index, 0);
    if (possible > MAX_COMPARISONS) throw new DomainError("similarity_too_large", "Too many code pairs; narrow the assignment scope", 413);
    for (let left = 0; left < rows.length; left += 1) {
      for (let right = left + 1; right < rows.length; right += 1) {
        const a = rows[left];
        const b = rows[right];
        if (a.assignment_id !== b.assignment_id || a.student_id === b.student_id) continue;
        const score = similarity(a.code, b.code);
        if (score < threshold) continue;
        const [first, second] = a.answer_id < b.answer_id ? [a, b] : [b, a];
        const answerAId = first.answer_id;
        const answerBId = second.answer_id;
        const existing = this.db.get<{ id: string }>("SELECT id FROM code_similarity_reports WHERE assignment_id = ? AND answer_a_id = ? AND answer_b_id = ?", [a.assignment_id, answerAId, answerBId]);
        if (existing) this.db.run("UPDATE code_similarity_reports SET similarity = ?, updated_at = ? WHERE id = ?", [score, now(), existing.id]);
        else this.db.run("INSERT INTO code_similarity_reports (id, course_id, assignment_id, answer_a_id, answer_b_id, student_a_id, student_b_id, similarity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [randomUUID(), courseId, a.assignment_id, answerAId, answerBId, first.student_id, second.student_id, score]);
      }
    }
    return { threshold, comparedAnswers: rows.length, reports: this.list(actor, courseId, input.assignmentId) };
  }
  review(actor: Actor, reportId: string, decision: "confirmed" | "dismissed", comment?: string) {
    const report = this.db.get<{ course_id: string; status: string }>("SELECT course_id, status FROM code_similarity_reports WHERE id = ?", [reportId]);
    if (!report) throw new DomainError("not_found", "Similarity report not found", 404);
    this.scoped(actor, report.course_id);
    if (report.status !== "pending_review") throw new DomainError("invalid_review_transition", "Similarity report is already reviewed", 409);
    if (comment && comment.length > 2000) throw new DomainError("invalid_input", "Review comment is too long");
    this.db.run("UPDATE code_similarity_reports SET status = ?, reviewed_by_id = ?, review_comment = ?, reviewed_at = ?, updated_at = ? WHERE id = ?", [decision, actor.id, comment?.trim() || null, now(), now(), reportId]);
    return this.report(reportId);
  }
}
