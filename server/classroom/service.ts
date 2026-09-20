/* eslint-disable @typescript-eslint/no-explicit-any -- SQLite projections are deliberately role-specific. */
import { randomUUID } from "node:crypto";
import type { Actor } from "../education.ts";
import type { LocalDatabase } from "../db.ts";
import { DomainError } from "../errors.ts";

type Clock = () => Date;
type ActivityStatus = "draft" | "active" | "paused" | "locked" | "reopened" | "ended";
type Transition = "start" | "pause" | "lock" | "reopen" | "end";
const STAFF = new Set(["admin", "teacher"]);

function now(clock: Clock) { return clock().toISOString(); }
function json(value: unknown) { return JSON.stringify(value ?? {}); }
function requireRow<T>(row: T | undefined, message: string) {
  if (!row) throw new DomainError("not_found", message, 404);
  return row;
}
function audit(db: LocalDatabase, actorId: string | null, action: string, entityType: string, entityId: string | null, result: "success" | "denied" | "failure", metadata: Record<string, unknown> = {}) {
  db.run("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, result, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)", [randomUUID(), actorId, action, entityType, entityId, result, json(metadata)]);
}
function canManageCourse(db: LocalDatabase, actor: Actor, courseId: string) {
  if (actor.role === "admin") return true;
  if (actor.role !== "teacher") return false;
  return Boolean(db.get("SELECT 1 FROM courses c WHERE c.id = ? AND (c.owner_teacher_id = ? OR EXISTS (SELECT 1 FROM course_class_assignments cca JOIN class_memberships cm ON cm.class_id = cca.class_id WHERE cca.course_id = c.id AND cm.user_id = ? AND cm.member_role = 'teacher' AND cm.status = 'active'))", [courseId, actor.id, actor.id]));
}
function isEnrolled(db: LocalDatabase, courseId: string, userId: string) {
  return Boolean(db.get("SELECT 1 FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id WHERE ce.course_id = ? AND ce.student_id = ? AND ce.status = 'active' AND c.status = 'published'", [courseId, userId]));
}
function isPublishedCourse(db: LocalDatabase, courseId: string) {
  return Boolean(db.get("SELECT 1 FROM courses WHERE id = ? AND status = 'published'", [courseId]));
}
function nextStatus(current: ActivityStatus, transition: Transition): ActivityStatus {
  const allowed: Record<Transition, ActivityStatus[]> = {
    start: ["draft", "paused", "reopened"],
    pause: ["active", "reopened"],
    lock: ["active", "paused", "reopened"],
    reopen: ["locked"],
    end: ["draft", "active", "paused", "locked", "reopened"],
  };
  if (!allowed[transition].includes(current)) throw new DomainError("invalid_activity_transition", `Cannot ${transition} an activity from ${current}`);
  if (transition === "start") return "active";
  if (transition === "reopen") return "reopened";
  if (transition === "pause") return "paused";
  if (transition === "lock") return "locked";
  return "ended";
}

export class ClassroomService {
  private readonly db: LocalDatabase;
  private readonly clock: Clock;
  constructor(db: LocalDatabase, clock: Clock = () => new Date()) { this.db = db; this.clock = clock; }

  private actor(actor: Actor) {
    const user = this.db.get<{ role: string; status: string }>("SELECT role, status FROM users WHERE id = ?", [actor.id]);
    if (!user || user.role !== actor.role || user.status !== "active") throw new DomainError("unauthorized", "Active session required", 401);
  }

  private session(sessionId: string) {
    return requireRow<Record<string, any>>(this.db.get("SELECT * FROM classroom_sessions WHERE id = ?", [sessionId]), "Classroom session not found");
  }

  private activity(activityId: string) {
    return requireRow<Record<string, any>>(this.db.get("SELECT * FROM classroom_activities WHERE id = ?", [activityId]), "Classroom activity not found");
  }

  private manage(actor: Actor, courseId: string) {
    this.actor(actor);
    if (!isPublishedCourse(this.db, courseId)) throw new DomainError("not_found", "Course not found", 404);
    if (!STAFF.has(actor.role) || !canManageCourse(this.db, actor, courseId)) throw new DomainError("forbidden", "You cannot manage this course", 403);
  }

  private view(actor: Actor, sessionId: string) {
    this.actor(actor);
    const session = this.session(sessionId);
    if (session.status === "archived" || !isPublishedCourse(this.db, session.course_id)) throw new DomainError("not_found", "Classroom session not found", 404);
    const teacher = STAFF.has(actor.role);
    if (teacher) {
      if (!canManageCourse(this.db, actor, session.course_id)) throw new DomainError("forbidden", "You cannot view this classroom", 403);
    } else {
      if (!isEnrolled(this.db, session.course_id, actor.id)) throw new DomainError("not_found", "Classroom session not found", 404);
      const participant = this.db.get("SELECT 1 FROM classroom_participants WHERE session_id = ? AND user_id = ? AND status = 'active'", [sessionId, actor.id]);
      if (!participant) throw new DomainError("forbidden", "Join the classroom before viewing it", 403);
    }
    const activities = this.db.all<Record<string, any>>("SELECT * FROM classroom_activities WHERE session_id = ? ORDER BY created_at, id", [sessionId]);
    const activity = activities[activities.length - 1] ?? null;
    const events = this.db.all<Record<string, any>>("SELECT id, session_id, activity_id, version, event_type, payload_json, created_at FROM classroom_events WHERE session_id = ? ORDER BY version", [sessionId]);
    const eventProjection = events.map((event) => teacher ? { ...event, payload: JSON.parse(event.payload_json) } : { id: event.id, sessionId: event.session_id, activityId: event.activity_id, version: event.version, eventType: event.event_type, createdAt: event.created_at });
    const participantRows = this.db.all<Record<string, any>>("SELECT cp.user_id, cp.participant_role, cp.status, cp.last_seen_at, u.chinese_name, u.english_name FROM classroom_participants cp JOIN users u ON u.id = cp.user_id WHERE cp.session_id = ? AND cp.status = 'active' ORDER BY cp.joined_at", [sessionId]);
    const participants = teacher
      ? participantRows.map((row) => ({ userId: row.user_id, role: row.participant_role, status: row.status, lastSeenAt: row.last_seen_at, chineseName: row.chinese_name, englishName: row.english_name }))
      : { activeCount: participantRows.filter((row) => row.participant_role === "student").length, self: participantRows.find((row) => row.user_id === actor.id)?.last_seen_at ?? null };
    const progress = activity?.assignment_id ? this.progress(actor, activity.assignment_id, session.course_id) : null;
    const anonymousAnswers = teacher && activity?.anonymous_answers && activity.assignment_id ? this.anonymousAnswers(activity.assignment_id) : undefined;
    return {
      session: { id: session.id, courseId: session.course_id, title: session.title, status: session.status, version: session.version, startedAt: session.started_at, endedAt: session.ended_at },
      activity: activity ? { id: activity.id, assignmentId: activity.assignment_id, title: activity.title, promptJson: activity.prompt_json ? JSON.parse(activity.prompt_json) : null, status: activity.status, version: activity.version, anonymousAnswers: Boolean(activity.anonymous_answers), startedAt: activity.started_at, endedAt: activity.ended_at } : null,
      participants,
      progress,
      ...(anonymousAnswers ? { anonymousAnswers } : {}),
      events: eventProjection,
    };
  }

  private progress(actor: Actor, assignmentId: string, courseId: string) {
    const total = this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM course_enrollments WHERE course_id = ? AND status = 'active'", [courseId])?.count ?? 0;
    const submitted = this.db.get<{ count: number }>("SELECT COUNT(DISTINCT s.student_id) AS count FROM submissions s WHERE s.assignment_id = ? AND s.status != 'draft'", [assignmentId])?.count ?? 0;
    if (STAFF.has(actor.role)) return { submitted, total, completionRate: total ? submitted / total : 0 };
    const self = this.db.get<{ status: string }>("SELECT status FROM submissions WHERE assignment_id = ? AND student_id = ? ORDER BY attempt_number DESC LIMIT 1", [assignmentId, actor.id]);
    return { selfStatus: self?.status ?? "not_started", submitted, total };
  }

  private anonymousAnswers(assignmentId: string) {
    const rows = this.db.all<Record<string, any>>("SELECT sa.answer_text, sa.answer_json, sa.question_id, sa.position FROM submission_answers sa JOIN submissions s ON s.id = sa.submission_id WHERE s.assignment_id = ? AND s.status != 'draft' ORDER BY sa.question_id, sa.position, sa.id", [assignmentId]);
    return rows.map((row, index) => ({ anonymousId: `Learner ${index + 1}`, questionId: row.question_id, position: row.position, answerText: row.answer_text, answerJson: row.answer_json ? JSON.parse(row.answer_json) : null }));
  }

  createSession(actor: Actor, input: { courseId: string; title: string }) {
    this.manage(actor, input.courseId);
    if (!String(input.title ?? "").trim()) throw new DomainError("invalid_input", "Classroom title is required");
    const id = randomUUID();
    this.db.transaction(() => {
      this.db.run("INSERT INTO classroom_sessions (id, course_id, created_by_id, title, status, version, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?)", [id, input.courseId, actor.id, String(input.title).trim(), now(this.clock), now(this.clock), now(this.clock)]);
      this.db.run("INSERT INTO classroom_participants (session_id, user_id, participant_role, status, last_seen_at) VALUES (?, ?, 'teacher', 'active', ?)", [id, actor.id, now(this.clock)]);
      const students = this.db.all<{ student_id: string }>("SELECT student_id FROM course_enrollments WHERE course_id = ? AND status = 'active'", [input.courseId]);
      students.forEach((row) => this.db.run("INSERT OR IGNORE INTO classroom_participants (session_id, user_id, participant_role, status) VALUES (?, ?, 'student', 'active')", [id, row.student_id]));
      this.db.run("INSERT INTO classroom_events (id, session_id, version, event_type, actor_id, idempotency_key, payload_json, created_at) VALUES (?, ?, 1, 'session.created', ?, ?, ?, ?)", [randomUUID(), id, actor.id, `session:${id}:created`, json({ sessionId: id, serverVersion: 1 }), now(this.clock)]);
      this.db.run("UPDATE classroom_sessions SET version = 1, updated_at = ? WHERE id = ?", [now(this.clock), id]);
    });
    audit(this.db, actor.id, "classroom.session_created", "classroom_session", id, "success", { courseId: input.courseId });
    return this.view(actor, id);
  }

  listSessions(actor: Actor, courseId: string) {
    this.actor(actor);
    if (!isPublishedCourse(this.db, courseId)) throw new DomainError("not_found", "Course not found", 404);
    if (STAFF.has(actor.role)) this.manage(actor, courseId);
    else if (actor.role !== "student") throw new DomainError("forbidden", "Student permission required", 403);
    else if (!isEnrolled(this.db, courseId, actor.id)) throw new DomainError("not_found", "Course not found", 404);
    return this.db.all("SELECT id, course_id, title, status, version, started_at, ended_at, created_at FROM classroom_sessions WHERE course_id = ? AND status != 'archived' ORDER BY created_at DESC", [courseId]);
  }

  createActivity(actor: Actor, sessionId: string, input: { title: string; assignmentId?: string; prompt?: unknown; anonymousAnswers?: boolean; idempotencyKey?: string }) {
    const session = this.session(sessionId);
    this.manage(actor, session.course_id);
    if (!String(input.title ?? "").trim()) throw new DomainError("invalid_input", "Activity title is required");
    if (input.assignmentId) {
      const assignment = requireRow<{ course_id: string }>(this.db.get("SELECT course_id FROM assignments WHERE id = ?", [input.assignmentId]), "Assignment not found");
      if (assignment.course_id !== session.course_id) throw new DomainError("invalid_reference", "Activity assignment must belong to the same course");
    }
    const id = randomUUID();
    const key = input.idempotencyKey?.trim() || `activity:${id}:created`;
    const outcome = this.db.transaction(() => {
      const existing = input.idempotencyKey ? this.db.get<{ activity_id: string }>("SELECT activity_id FROM classroom_events WHERE session_id = ? AND idempotency_key = ?", [sessionId, key]) : undefined;
      if (existing?.activity_id) return { activity: this.db.get("SELECT * FROM classroom_activities WHERE id = ?", [existing.activity_id]), replay: true };
      const currentSession = this.session(sessionId);
      if (currentSession.status === "ended") throw new DomainError("classroom_ended", "Ended classrooms are read-only", 409);
      this.db.run("INSERT INTO classroom_activities (id, session_id, course_id, assignment_id, created_by_id, title, prompt_json, anonymous_answers, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, sessionId, session.course_id, input.assignmentId ?? null, actor.id, String(input.title).trim(), input.prompt === undefined ? null : json(input.prompt), input.anonymousAnswers === false ? 0 : 1, now(this.clock), now(this.clock)]);
      const version = (this.db.get<{ version: number }>("SELECT version FROM classroom_sessions WHERE id = ?", [sessionId])?.version ?? 0) + 1;
      this.db.run("UPDATE classroom_sessions SET version = ?, updated_at = ? WHERE id = ?", [version, now(this.clock), sessionId]);
      this.db.run("INSERT INTO classroom_events (id, session_id, activity_id, version, event_type, actor_id, idempotency_key, payload_json, created_at) VALUES (?, ?, ?, ?, 'activity.created', ?, ?, ?, ?)", [randomUUID(), sessionId, id, version, actor.id, key, json({ activityId: id, serverVersion: version }), now(this.clock)]);
      return { activity: this.db.get("SELECT * FROM classroom_activities WHERE id = ?", [id]), replay: false };
    });
    if (!outcome.replay) audit(this.db, actor.id, "classroom.activity_created", "classroom_activity", id, "success", { sessionId, assignmentId: input.assignmentId ?? null });
    return outcome.activity;
  }

  transitionActivity(actor: Actor, activityId: string, transition: Transition, idempotencyKey: string) {
    const activity = this.activity(activityId);
    this.manage(actor, activity.course_id);
    if (!String(idempotencyKey ?? "").trim()) throw new DomainError("invalid_input", "Idempotency key is required");
    const session = this.session(activity.session_id);
    const outcome = this.db.transaction(() => {
      const existing = this.db.get<{ id: string }>("SELECT id FROM classroom_events WHERE session_id = ? AND idempotency_key = ?", [session.id, idempotencyKey]);
      if (existing) return { replay: true, status: activity.status as ActivityStatus };
      const currentSession = this.session(session.id);
      if (currentSession.status === "ended") throw new DomainError("classroom_ended", "Ended classrooms are read-only", 409);
      const current = requireRow<Record<string, any>>(this.db.get("SELECT * FROM classroom_activities WHERE id = ?", [activityId]), "Classroom activity not found");
      const next = nextStatus(current.status as ActivityStatus, transition);
      const event = randomUUID();
      const version = (this.db.get<{ version: number }>("SELECT version FROM classroom_sessions WHERE id = ?", [session.id])?.version ?? 0) + 1;
      this.db.run("UPDATE classroom_activities SET status = ?, version = version + 1, started_at = CASE WHEN ? = 'active' AND started_at IS NULL THEN ? ELSE started_at END, ended_at = CASE WHEN ? = 'ended' THEN ? ELSE ended_at END, updated_at = ? WHERE id = ?", [next, next, now(this.clock), next, now(this.clock), now(this.clock), activityId]);
      this.db.run("UPDATE classroom_sessions SET version = ?, updated_at = ? WHERE id = ?", [version, now(this.clock), session.id]);
      this.db.run("INSERT INTO classroom_events (id, session_id, activity_id, version, event_type, actor_id, idempotency_key, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [event, session.id, activityId, version, `activity.${transition}`, actor.id, idempotencyKey, json({ activityId, status: next, serverVersion: version }), now(this.clock)]);
      return { replay: false, status: next };
    });
    if (!outcome.replay) audit(this.db, actor.id, `classroom.activity_${transition}`, "classroom_activity", activityId, "success", { sessionId: session.id, status: outcome.status });
    return this.view(actor, session.id);
  }

  startActivity(actor: Actor, activityId: string, key: string) { return this.transitionActivity(actor, activityId, "start", key); }
  pauseActivity(actor: Actor, activityId: string, key: string) { return this.transitionActivity(actor, activityId, "pause", key); }
  lockActivity(actor: Actor, activityId: string, key: string) { return this.transitionActivity(actor, activityId, "lock", key); }
  reopenActivity(actor: Actor, activityId: string, key: string) { return this.transitionActivity(actor, activityId, "reopen", key); }
  endActivity(actor: Actor, activityId: string, key: string) { return this.transitionActivity(actor, activityId, "end", key); }

  endSession(actor: Actor, sessionId: string, idempotencyKey: string) {
    const session = this.session(sessionId);
    this.manage(actor, session.course_id);
    if (!String(idempotencyKey ?? "").trim()) throw new DomainError("invalid_input", "Idempotency key is required");
    this.db.transaction(() => {
      const existing = this.db.get("SELECT id FROM classroom_events WHERE session_id = ? AND idempotency_key = ?", [sessionId, idempotencyKey]);
      if (!existing) {
        const version = (this.db.get<{ version: number }>("SELECT version FROM classroom_sessions WHERE id = ?", [sessionId])?.version ?? 0) + 1;
        this.db.run("UPDATE classroom_sessions SET status = 'ended', version = ?, ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ?", [version, now(this.clock), now(this.clock), sessionId]);
        this.db.run("UPDATE classroom_activities SET status = CASE WHEN status = 'ended' THEN status ELSE 'ended' END, ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE session_id = ?", [now(this.clock), now(this.clock), sessionId]);
        this.db.run("INSERT INTO classroom_events (id, session_id, version, event_type, actor_id, idempotency_key, payload_json, created_at) VALUES (?, ?, ?, 'session.end', ?, ?, ?, ?)", [randomUUID(), sessionId, version, actor.id, idempotencyKey, json({ sessionId, status: "ended", serverVersion: version }), now(this.clock)]);
      }
    });
    return this.view(actor, sessionId);
  }
  endClassroom(actor: Actor, sessionId: string, idempotencyKey: string) { return this.endSession(actor, sessionId, idempotencyKey); }

  joinSession(actor: Actor, sessionId: string) {
    this.actor(actor);
    const session = this.session(sessionId);
    if (!isPublishedCourse(this.db, session.course_id) || session.status === "archived") throw new DomainError("not_found", "Classroom session not found", 404);
    if (actor.role !== "student") throw new DomainError("forbidden", "Only enrolled students can join this classroom", 403);
    if (!isEnrolled(this.db, session.course_id, actor.id)) throw new DomainError("not_found", "Classroom session not found", 404);
    if (session.status === "ended") return this.view(actor, sessionId);
    this.db.run("INSERT INTO classroom_participants (session_id, user_id, participant_role, status, last_seen_at) VALUES (?, ?, 'student', 'active', ?) ON CONFLICT(session_id, user_id) DO UPDATE SET status = 'active', last_seen_at = excluded.last_seen_at", [sessionId, actor.id, now(this.clock)]);
    return this.view(actor, sessionId);
  }

  heartbeat(actor: Actor, sessionId: string) {
    this.actor(actor);
    const session = this.session(sessionId);
    if (!isPublishedCourse(this.db, session.course_id) || session.status === "archived") throw new DomainError("not_found", "Classroom session not found", 404);
    if (actor.role === "student" && !isEnrolled(this.db, session.course_id, actor.id)) throw new DomainError("not_found", "Classroom session not found", 404);
    if (session.status === "ended") return this.view(actor, sessionId);
    if (actor.role === "student") this.db.run("UPDATE classroom_participants SET last_seen_at = ?, status = 'active' WHERE session_id = ? AND user_id = ?", [now(this.clock), sessionId, actor.id]);
    return this.view(actor, sessionId);
  }
  getSession(actor: Actor, sessionId: string) {
    return this.view(actor, sessionId);
  }

  getState(actor: Actor, sessionId: string) { return this.view(actor, sessionId); }
  eventsSince(actor: Actor, sessionId: string, version = 0) {
    const state = this.view(actor, sessionId);
    return { serverVersion: state.session.version, events: state.events.filter((event: any) => event.version > version) };
  }
}
