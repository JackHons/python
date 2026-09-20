import { randomUUID } from "node:crypto";
import type { Actor } from "./education.ts";
import type { LocalDatabase } from "./db.ts";
import { DomainError } from "./errors.ts";

const STAFF = new Set(["admin", "teacher"]);
type Clock = () => Date;
function dateValue(clock: Clock) { return clock().toISOString().slice(0, 10); }
function yesterday(value: string) { const date = new Date(`${value}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() - 1); return date.toISOString().slice(0, 10); }
function canManageCourse(db: LocalDatabase, actor: Actor, courseId: string) {
  if (actor.role === "admin") return true;
  if (actor.role !== "teacher") return false;
  return Boolean(db.get("SELECT 1 FROM courses c WHERE c.id = ? AND (c.owner_teacher_id = ? OR EXISTS (SELECT 1 FROM course_class_assignments cca JOIN class_memberships cm ON cm.class_id = cca.class_id WHERE cca.course_id = c.id AND cm.user_id = ? AND cm.member_role = 'teacher' AND cm.status = 'active'))", [courseId, actor.id, actor.id]));
}

export class GamificationService {
  private readonly db: LocalDatabase;
  private readonly clock: Clock;
  constructor(db: LocalDatabase, clock: Clock = () => new Date()) { this.db = db; this.clock = clock; }
  settings(actor?: Actor) {
    if (actor && actor.role !== "admin") throw new DomainError("forbidden", "Administrator permission required", 403);
    return this.db.get("SELECT id, xp_enabled, badges_enabled, streaks_enabled, leaderboard_enabled, updated_at FROM gamification_settings WHERE id = 'global'") ?? { id: "global", xp_enabled: 1, badges_enabled: 1, streaks_enabled: 1, leaderboard_enabled: 1, updated_at: null };
  }
  updateSettings(actor: Actor, input: { xpEnabled?: boolean; badgesEnabled?: boolean; streaksEnabled?: boolean; leaderboardEnabled?: boolean }) {
    if (actor.role !== "admin") throw new DomainError("forbidden", "Administrator permission required", 403);
    this.db.run("INSERT INTO gamification_settings (id, xp_enabled, badges_enabled, streaks_enabled, leaderboard_enabled, updated_by_id, updated_at) VALUES ('global', ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET xp_enabled = excluded.xp_enabled, badges_enabled = excluded.badges_enabled, streaks_enabled = excluded.streaks_enabled, leaderboard_enabled = excluded.leaderboard_enabled, updated_by_id = excluded.updated_by_id, updated_at = excluded.updated_at", [input.xpEnabled === undefined ? 1 : input.xpEnabled ? 1 : 0, input.badgesEnabled === undefined ? 1 : input.badgesEnabled ? 1 : 0, input.streaksEnabled === undefined ? 1 : input.streaksEnabled ? 1 : 0, input.leaderboardEnabled === undefined ? 1 : input.leaderboardEnabled ? 1 : 0, actor.id, this.clock().toISOString()]);
    return this.settings(actor);
  }
  recordSubmission(actor: Actor, courseId: string, submissionId: string) {
    if (actor.role !== "student") return;
    const settings = this.settings();
    const eventKey = `submission:${submissionId}:completed`;
    const existing = this.db.get("SELECT id FROM gamification_events WHERE event_key = ?", [eventKey]);
    if (existing) return this.me(actor, courseId);
    const today = dateValue(this.clock);
    const xp = settings.xp_enabled ? 10 : 0;
    this.db.transaction(() => {
      this.db.run("INSERT INTO gamification_events (id, user_id, course_id, event_key, event_type, xp, metadata_json, occurred_at) VALUES (?, ?, ?, ?, 'submission_completed', ?, ?, ?)", [randomUUID(), actor.id, courseId, eventKey, xp, JSON.stringify({ submissionId }), this.clock().toISOString()]);
      if (settings.streaks_enabled) {
        const current = this.db.get<{ current_streak: number; longest_streak: number; last_activity_date: string | null }>("SELECT current_streak, longest_streak, last_activity_date FROM student_streaks WHERE user_id = ?", [actor.id]);
        const next = current?.last_activity_date === today ? Number(current.current_streak) : current?.last_activity_date === yesterday(today) ? Number(current.current_streak) + 1 : 1;
        this.db.run("INSERT INTO student_streaks (user_id, current_streak, longest_streak, last_activity_date, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET current_streak = excluded.current_streak, longest_streak = excluded.longest_streak, last_activity_date = excluded.last_activity_date, updated_at = excluded.updated_at", [actor.id, next, Math.max(next, Number(current?.longest_streak ?? 0)), today, this.clock().toISOString()]);
      }
      if (settings.badges_enabled) {
        const award = (code: string) => this.db.run("INSERT OR IGNORE INTO student_badges (id, user_id, course_id, badge_code, awarded_at) SELECT ?, ?, ?, code, ? FROM badge_definitions WHERE code = ? AND enabled = 1", [randomUUID(), actor.id, courseId, this.clock().toISOString(), code]);
        award("first_submission");
        award("course_finisher");
        const streak = this.db.get<{ current_streak: number }>("SELECT current_streak FROM student_streaks WHERE user_id = ?", [actor.id]);
        if ((streak?.current_streak ?? 0) >= 3) award("streak_3");
      }
    });
    return this.me(actor, courseId);
  }
  me(actor: Actor, courseId?: string) {
    if (actor.role !== "student") throw new DomainError("forbidden", "Student permission required", 403);
    if (courseId && !this.db.get("SELECT 1 FROM course_enrollments WHERE course_id = ? AND student_id = ? AND status = 'active'", [courseId, actor.id])) throw new DomainError("not_found", "Course not found", 404);
    const settings = this.settings();
    const xp = this.db.get<{ value: number }>(`SELECT COALESCE(SUM(xp), 0) AS value FROM gamification_events WHERE user_id = ? ${courseId ? "AND course_id = ?" : ""}`, courseId ? [actor.id, courseId] : [actor.id])?.value ?? 0;
    const streak = this.db.get("SELECT current_streak, longest_streak, last_activity_date FROM student_streaks WHERE user_id = ?", [actor.id]) ?? { current_streak: 0, longest_streak: 0, last_activity_date: null };
    const badges = settings.badges_enabled ? this.db.all("SELECT sb.badge_code, bd.title_zh, bd.title_en, bd.description_zh, bd.description_en, sb.course_id, sb.awarded_at FROM student_badges sb JOIN badge_definitions bd ON bd.code = sb.badge_code WHERE sb.user_id = ? AND (? IS NULL OR sb.course_id = ?) ORDER BY sb.awarded_at DESC", [actor.id, courseId ?? null, courseId ?? null]) : [];
    return { xp: settings.xp_enabled ? Number(xp) : 0, streak: settings.streaks_enabled ? streak : { current_streak: 0, longest_streak: 0, last_activity_date: null }, badges, settings: { xpEnabled: Boolean(settings.xp_enabled), badgesEnabled: Boolean(settings.badges_enabled), streaksEnabled: Boolean(settings.streaks_enabled), leaderboardEnabled: Boolean(settings.leaderboard_enabled) } };
  }
  leaderboard(actor: Actor, courseId: string) {
    if (actor.role === "student") {
      if (!this.db.get("SELECT 1 FROM course_enrollments WHERE course_id = ? AND student_id = ? AND status = 'active'", [courseId, actor.id])) throw new DomainError("not_found", "Course not found", 404);
    } else if (!STAFF.has(actor.role) || !canManageCourse(this.db, actor, courseId)) throw new DomainError("forbidden", "Leaderboard scope denied", 403);
    const settings = this.settings();
    if (!settings.leaderboard_enabled) return { hidden: true, rows: [] };
    const rows = this.db.all(`SELECT ce.student_id, u.chinese_name, u.english_name, u.student_number, COALESCE(SUM(ge.xp), 0) AS xp
      FROM course_enrollments ce JOIN users u ON u.id = ce.student_id LEFT JOIN gamification_events ge ON ge.user_id = ce.student_id AND ge.course_id = ce.course_id
      WHERE ce.course_id = ? AND ce.status = 'active' AND u.status = 'active' GROUP BY ce.student_id ORDER BY xp DESC, u.student_number, ce.student_id`, [courseId]);
    return { hidden: false, rows: rows.map((row, index) => ({ rank: index + 1, ...row })) };
  }
}
