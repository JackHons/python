/* eslint-disable @typescript-eslint/no-explicit-any -- notification and mail projections vary by event type. */
import { randomUUID } from "node:crypto";
import type { Actor } from "../education.ts";
import type { LocalDatabase } from "../db.ts";
import { DomainError } from "../errors.ts";

type Clock = () => Date;
type NotificationType = "announcement" | "assignment_published" | "due_reminder" | "late_notice" | "grade_released" | "system";
export type MailMessage = { deliveryId: string; to: string; subject: string; body: string };
export interface Mailer {
  send(message: MailMessage): Promise<{ providerMessageId: string }>;
  configure?(config: { host: string; port: number; tlsMode: "none" | "starttls" | "tls"; username?: string; password?: string; from: string; timeoutMs?: number }): void;
  settings?(): { host: string; port: number; tlsMode: "none" | "starttls" | "tls"; username: string; from: string; passwordConfigured: boolean };
}
type SecretCipher = { encrypt(value: string): string; decrypt(value: string): string };

export class EmailDeliveryError extends Error {
  readonly code: "temporary" | "bounced" | "disabled";
  constructor(code: "temporary" | "bounced" | "disabled", message: string) { super(message); this.code = code; }
}

export class FakeMailer implements Mailer {
  readonly messages: MailMessage[] = [];
  private failures: EmailDeliveryError[] = [];
  failNext(error: EmailDeliveryError) { this.failures.push(error); }
  async send(message: MailMessage) {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.messages.push({ ...message });
    return { providerMessageId: `fake-${message.deliveryId}` };
  }
}

function now(clock: Clock) { return clock().toISOString(); }
function json(value: unknown) { return JSON.stringify(value ?? {}); }
function requireRow<T>(row: T | undefined, message: string) { if (!row) throw new DomainError("not_found", message, 404); return row; }
function audit(db: LocalDatabase, actorId: string | null, action: string, entityType: string, entityId: string | null, result: "success" | "denied" | "failure", metadata: Record<string, unknown> = {}) {
  db.run("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, result, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)", [randomUUID(), actorId, action, entityType, entityId, result, json(metadata)]);
}
function staff(actor: Actor) { if (actor.role !== "admin" && actor.role !== "teacher") throw new DomainError("forbidden", "Staff permission required", 403); }
function safeBody(value: string) {
  return String(value ?? "")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/(?:api[_ -]?key|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1: [redacted]")
    .replace(/hidden[-_ ]?test[-_ ]?[A-Za-z0-9_-]*/gi, "[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]");
}

export class NotificationService {
  private readonly db: LocalDatabase;
  private readonly clock: Clock;
  private readonly mailer: Mailer;
  private readonly secretCipher: SecretCipher | null;
  private emailEnabled: boolean;
  private readonly maxAttempts: number;
  constructor(db: LocalDatabase, clock: Clock = () => new Date(), options: { mailer?: Mailer; emailEnabled?: boolean; maxAttempts?: number; secretCipher?: SecretCipher | null } = {}) {
    this.db = db;
    this.clock = clock;
    this.mailer = options.mailer ?? new FakeMailer();
    this.secretCipher = options.secretCipher ?? null;
    this.emailEnabled = options.emailEnabled !== false;
    this.maxAttempts = Math.max(1, Math.min(10, options.maxAttempts ?? 3));
    const stored = this.db.get<{ value_json: string }>("SELECT value_json FROM system_settings WHERE key = 'email.smtp'");
    if (stored && this.mailer.configure) {
      try {
        const value = JSON.parse(stored.value_json) as Record<string, unknown>;
        const encryptedPassword = String(value.encryptedPassword ?? "");
        const password = encryptedPassword ? this.secretCipher?.decrypt(encryptedPassword) : undefined;
        if (encryptedPassword && !password) throw new Error("email_secret_unavailable");
        this.mailer.configure({ host: String(value.host ?? ""), port: Number(value.port), tlsMode: value.tlsMode as "none" | "starttls" | "tls", username: String(value.username ?? "") || undefined, password, from: String(value.from ?? ""), timeoutMs: Number(value.timeoutMs ?? 10000) });
        this.emailEnabled = value.enabled === true;
      } catch { this.emailEnabled = false; }
    }
  }

  emailSettings(actor: Actor) {
    if (actor.role !== "admin") throw new DomainError("forbidden", "Administrator permission required", 403);
    const settings = this.mailer.settings?.();
    return { enabled: this.emailEnabled, configured: Boolean(settings?.host && settings?.from), host: settings?.host ?? "", port: settings?.port ?? 0, tlsMode: settings?.tlsMode ?? "none", username: settings?.username ?? "", from: settings?.from ?? "", passwordConfigured: settings?.passwordConfigured ?? false };
  }

  configureEmail(actor: Actor, input: { enabled: boolean; host: string; port: number; tlsMode: "none" | "starttls" | "tls"; username?: string; password?: string; from: string; timeoutMs?: number }) {
    if (actor.role !== "admin") throw new DomainError("forbidden", "Administrator permission required", 403);
    if (!this.mailer.configure) throw new DomainError("smtp_unavailable", "SMTP adapter is unavailable", 503);
    const current = this.db.get<{ value_json: string }>("SELECT value_json FROM system_settings WHERE key = 'email.smtp'");
    const previous = current ? JSON.parse(current.value_json) as Record<string, unknown> : {};
    let encryptedPassword = String(previous.encryptedPassword ?? "");
    let password: string | undefined;
    if (input.password) {
      if (!this.secretCipher) throw new DomainError("email_master_key_missing", "Server master key is required before saving SMTP credentials", 503);
      encryptedPassword = this.secretCipher.encrypt(input.password);
      password = input.password;
    } else if (encryptedPassword) {
      if (!this.secretCipher) throw new DomainError("email_master_key_missing", "Server master key is required before using SMTP credentials", 503);
      password = this.secretCipher.decrypt(encryptedPassword);
    }
    const value = { enabled: Boolean(input.enabled), host: input.host, port: Number(input.port), tlsMode: input.tlsMode, username: input.username ?? "", encryptedPassword, from: input.from, timeoutMs: Number(input.timeoutMs ?? 10000) };
    this.mailer.configure({ host: value.host, port: value.port, tlsMode: value.tlsMode, username: value.username || undefined, password, from: value.from, timeoutMs: value.timeoutMs });
    this.db.run("INSERT INTO system_settings (key, value_json, sensitivity, updated_by_id) VALUES ('email.smtp', ?, 'encrypted_secret', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, sensitivity = 'encrypted_secret', updated_by_id = excluded.updated_by_id, updated_at = CURRENT_TIMESTAMP", [JSON.stringify(value), actor.id]);
    this.emailEnabled = value.enabled;
    audit(this.db, actor.id, "email.smtp_configured", "email_settings", "global", "success", { enabled: value.enabled, host: value.host, port: value.port, tlsMode: value.tlsMode, passwordConfigured: Boolean(encryptedPassword) });
    return this.emailSettings(actor);
  }

  setEmailEnabled(actor: Actor, enabled: boolean) {
    if (actor.role !== "admin") throw new DomainError("forbidden", "Administrator permission required", 403);
    this.emailEnabled = Boolean(enabled);
    const stored = this.db.get<{ value_json: string }>("SELECT value_json FROM system_settings WHERE key = 'email.smtp'");
    if (stored) {
      const value = JSON.parse(stored.value_json) as Record<string, unknown>;
      value.enabled = this.emailEnabled;
      this.db.run("UPDATE system_settings SET value_json = ?, updated_by_id = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'email.smtp'", [JSON.stringify(value), actor.id]);
    }
    audit(this.db, actor.id, "email.settings_updated", "email_settings", "global", "success", { enabled: this.emailEnabled });
    return { enabled: this.emailEnabled };
  }

  private canManageClass(actor: Actor, classId: string) {
    if (actor.role === "admin") return true;
    return actor.role === "teacher" && Boolean(this.db.get("SELECT 1 FROM class_memberships WHERE class_id = ? AND user_id = ? AND member_role = 'teacher' AND status = 'active'", [classId, actor.id]));
  }
  private canManageCourse(actor: Actor, courseId: string) {
    if (actor.role === "admin") return true;
    return actor.role === "teacher" && Boolean(this.db.get("SELECT 1 FROM courses c WHERE c.id = ? AND (c.owner_teacher_id = ? OR EXISTS (SELECT 1 FROM course_class_assignments cca JOIN class_memberships cm ON cm.class_id = cca.class_id WHERE cca.course_id = c.id AND cm.user_id = ? AND cm.member_role = 'teacher' AND cm.status = 'active'))", [courseId, actor.id, actor.id]));
  }
  private requireActive(actor: Actor) {
    const user = this.db.get<{ role: string; status: string }>("SELECT role, status FROM users WHERE id = ?", [actor.id]);
    if (!user || user.role !== actor.role || user.status !== "active") throw new DomainError("unauthorized", "Active session required", 401);
  }

  createAnnouncement(actor: Actor, input: { courseId?: string; classId?: string; titleZh: string; titleEn?: string; bodyZh: string; bodyEn?: string; publishAt?: string; expiresAt?: string }) {
    staff(actor);
    this.requireActive(actor);
    if ((input.courseId ? 1 : 0) + (input.classId ? 1 : 0) !== 1) throw new DomainError("invalid_input", "Choose exactly one announcement audience");
    if (input.courseId && !this.canManageCourse(actor, input.courseId)) throw new DomainError("forbidden", "You cannot announce to this course", 403);
    if (input.classId && !this.canManageClass(actor, input.classId)) throw new DomainError("forbidden", "You cannot announce to this class", 403);
    if (!String(input.titleZh ?? "").trim() || !String(input.bodyZh ?? "").trim()) throw new DomainError("invalid_input", "Announcement title and body are required");
    const id = randomUUID();
    this.db.run("INSERT INTO announcements (id, author_id, course_id, class_id, title_zh, title_en, body_zh, body_en, status, publish_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)", [id, actor.id, input.courseId ?? null, input.classId ?? null, String(input.titleZh).trim(), input.titleEn?.trim() || null, String(input.bodyZh).trim(), input.bodyEn?.trim() || null, input.publishAt ?? null, input.expiresAt ?? null]);
    audit(this.db, actor.id, "announcement.created", "announcement", id, "success", { courseId: input.courseId ?? null, classId: input.classId ?? null });
    return this.db.get("SELECT * FROM announcements WHERE id = ?", [id]);
  }

  private canManageAnnouncement(actor: Actor, announcement: Record<string, any>) {
    return actor.role === "admin"
      || (announcement.course_id && this.canManageCourse(actor, announcement.course_id))
      || (announcement.class_id && this.canManageClass(actor, announcement.class_id));
  }

  listAnnouncements(actor: Actor, options: { status?: "draft" | "published" | "archived" } = {}) {
    staff(actor);
    const rows = actor.role === "admin"
      ? this.db.all<Record<string, any>>("SELECT * FROM announcements WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC", [options.status ?? null, options.status ?? null])
      : this.db.all<Record<string, any>>("SELECT a.* FROM announcements a WHERE (? IS NULL OR a.status = ?) AND (EXISTS (SELECT 1 FROM courses c WHERE c.id = a.course_id AND (c.owner_teacher_id = ? OR EXISTS (SELECT 1 FROM course_class_assignments cca JOIN class_memberships cm ON cm.class_id = cca.class_id WHERE cca.course_id = c.id AND cm.user_id = ? AND cm.member_role = 'teacher' AND cm.status = 'active'))) OR EXISTS (SELECT 1 FROM class_memberships cm WHERE cm.class_id = a.class_id AND cm.user_id = ? AND cm.member_role = 'teacher' AND cm.status = 'active')) ORDER BY a.created_at DESC", [options.status ?? null, options.status ?? null, actor.id, actor.id, actor.id]);
    return rows.map((row) => ({ ...row, recipient_count: this.recipients({ courseId: row.course_id ?? undefined, classId: row.class_id ?? undefined }).length }));
  }

  updateAnnouncement(actor: Actor, announcementId: string, input: { courseId?: string; classId?: string; titleZh: string; titleEn?: string; bodyZh: string; bodyEn?: string; publishAt?: string; expiresAt?: string }) {
    staff(actor);
    this.requireActive(actor);
    const current = requireRow<Record<string, any>>(this.db.get("SELECT * FROM announcements WHERE id = ?", [announcementId]), "Announcement not found");
    if (!this.canManageAnnouncement(actor, current)) throw new DomainError("not_found", "Announcement not found", 404);
    if (current.status !== "draft") throw new DomainError("invalid_announcement_state", "Only draft announcements can be edited");
    if ((input.courseId ? 1 : 0) + (input.classId ? 1 : 0) !== 1) throw new DomainError("invalid_input", "Choose exactly one announcement audience");
    if (input.courseId && !this.canManageCourse(actor, input.courseId)) throw new DomainError("forbidden", "You cannot announce to this course", 403);
    if (input.classId && !this.canManageClass(actor, input.classId)) throw new DomainError("forbidden", "You cannot announce to this class", 403);
    if (!String(input.titleZh ?? "").trim() || !String(input.bodyZh ?? "").trim()) throw new DomainError("invalid_input", "Announcement title and body are required");
    this.db.run("UPDATE announcements SET course_id = ?, class_id = ?, title_zh = ?, title_en = ?, body_zh = ?, body_en = ?, publish_at = ?, expires_at = ?, updated_at = ? WHERE id = ?", [input.courseId ?? null, input.classId ?? null, String(input.titleZh).trim(), input.titleEn?.trim() || null, String(input.bodyZh).trim(), input.bodyEn?.trim() || null, input.publishAt ?? null, input.expiresAt ?? null, now(this.clock), announcementId]);
    audit(this.db, actor.id, "announcement.updated", "announcement", announcementId, "success", { courseId: input.courseId ?? null, classId: input.classId ?? null });
    return this.db.get("SELECT * FROM announcements WHERE id = ?", [announcementId]);
  }

  previewAnnouncement(actor: Actor, announcementId: string) {
    staff(actor);
    const announcement = requireRow<Record<string, any>>(this.db.get("SELECT * FROM announcements WHERE id = ?", [announcementId]), "Announcement not found");
    if (!this.canManageAnnouncement(actor, announcement)) throw new DomainError("not_found", "Announcement not found", 404);
    const recipients = this.recipients({ courseId: announcement.course_id ?? undefined, classId: announcement.class_id ?? undefined });
    return { announcement, recipientCount: recipients.length, emailCount: recipients.filter((recipient) => Boolean(recipient.email)).length };
  }

  private recipients(input: { courseId?: string; classId?: string; recipientIds?: string[] }) {
    if (input.recipientIds?.length) {
      const placeholders = input.recipientIds.map(() => "?").join(",");
      return this.db.all<{ id: string; email: string | null }>(`SELECT id, email FROM users WHERE status = 'active' AND id IN (${placeholders})`, input.recipientIds);
    }
    if (input.courseId) return this.db.all<{ id: string; email: string | null }>("SELECT u.id, u.email FROM users u JOIN course_enrollments ce ON ce.student_id = u.id WHERE ce.course_id = ? AND ce.status = 'active' AND u.status = 'active'", [input.courseId]);
    return this.db.all<{ id: string; email: string | null }>("SELECT u.id, u.email FROM users u JOIN class_memberships cm ON cm.user_id = u.id WHERE cm.class_id = ? AND cm.member_role = 'student' AND cm.status = 'active' AND u.status = 'active'", [input.classId]);
  }

  private createForRecipients(actor: Actor | null, input: { courseId?: string; classId?: string; recipientIds?: string[]; eventKey: string; type: NotificationType; title: string; body: string; linkPath?: string; announcementId?: string; sendEmail?: boolean }) {
    const recipients = this.recipients(input);
    const body = safeBody(input.body);
    const created: string[] = [];
    this.db.transaction(() => {
      for (const recipient of recipients) {
        const id = randomUUID();
        const result = this.db.run("INSERT OR IGNORE INTO notifications (id, recipient_id, announcement_id, type, title, body, link_path, source_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [id, recipient.id, input.announcementId ?? null, input.type, safeBody(input.title), body, input.linkPath ?? null, input.eventKey]);
        if (!Number(result.changes ?? 0)) continue;
        created.push(id);
        if (recipient.email && input.sendEmail !== false && this.emailEnabled) {
          const emailId = randomUUID();
          this.db.run("INSERT INTO email_deliveries (id, notification_id, recipient_email, status, subject, body, next_attempt_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)", [emailId, id, recipient.email, safeBody(input.title), body, now(this.clock)]);
        } else if (recipient.email && input.sendEmail !== false) {
          this.db.run("INSERT INTO email_deliveries (id, notification_id, recipient_email, status, subject, body, last_error_code) VALUES (?, ?, ?, 'suppressed', ?, ?, 'email_disabled')", [emailId(), id, recipient.email, safeBody(input.title), body]);
        }
      }
    });
    audit(this.db, actor?.id ?? null, "notification.event_created", "notification_event", input.eventKey, "success", { type: input.type, recipientCount: created.length, emailEnabled: this.emailEnabled });
    return { eventKey: input.eventKey, notificationIds: created, recipientCount: recipients.length };
  }

  publishAnnouncement(actor: Actor, announcementId: string, eventKeyOrOptions: string | { sendEmail?: boolean } = `announcement:${announcementId}:published`, options: { sendEmail?: boolean } = {}) {
    staff(actor);
    const announcement = requireRow<Record<string, any>>(this.db.get("SELECT * FROM announcements WHERE id = ?", [announcementId]), "Announcement not found");
    if ((announcement.course_id && !this.canManageCourse(actor, announcement.course_id)) || (announcement.class_id && !this.canManageClass(actor, announcement.class_id))) throw new DomainError("forbidden", "You cannot publish this announcement", 403);
    if (announcement.status === "archived") throw new DomainError("invalid_announcement_state", "Archived announcements cannot be published");
    const eventKey = typeof eventKeyOrOptions === "string" ? eventKeyOrOptions : `announcement:${announcementId}:published`;
    const publishOptions = typeof eventKeyOrOptions === "string" ? options : eventKeyOrOptions;
    if (announcement.status !== "published") this.db.run("UPDATE announcements SET status = 'published', publish_at = COALESCE(publish_at, ?), updated_at = ? WHERE id = ?", [now(this.clock), now(this.clock), announcementId]);
    return this.createForRecipients(actor, { courseId: announcement.course_id ?? undefined, classId: announcement.class_id ?? undefined, eventKey, type: "announcement", title: announcement.title_zh, body: announcement.body_zh, announcementId, sendEmail: publishOptions.sendEmail });
  }

  notifyCourseEvent(actor: Actor, input: { courseId: string; eventKey: string; type: Exclude<NotificationType, "announcement">; title: string; body: string; linkPath?: string }) {
    staff(actor);
    if (!this.canManageCourse(actor, input.courseId)) throw new DomainError("forbidden", "You cannot notify this course", 403);
    return this.createForRecipients(actor, input);
  }

  notifyAssignmentPublished(actor: Actor, assignmentId: string, eventKey = `assignment:${assignmentId}:published`) {
    const assignment = requireRow<Record<string, any>>(this.db.get("SELECT id, course_id, title_zh FROM assignments WHERE id = ?", [assignmentId]), "Assignment not found");
    return this.notifyCourseEvent(actor, { courseId: assignment.course_id, eventKey, type: "assignment_published", title: "新功課已發布", body: `功課：${assignment.title_zh}`, linkPath: `/student/courses/${assignment.course_id}/assignments/${assignment.id}` });
  }

  notifyDueReminder(actor: Actor, assignmentId: string, eventKey = `assignment:${assignmentId}:due-reminder`) {
    const assignment = requireRow<Record<string, any>>(this.db.get("SELECT id, course_id, title_zh, due_at FROM assignments WHERE id = ?", [assignmentId]), "Assignment not found");
    return this.notifyCourseEvent(actor, { courseId: assignment.course_id, eventKey, type: "due_reminder", title: "功課即將截止", body: `功課：${assignment.title_zh}${assignment.due_at ? `，截止時間：${assignment.due_at}` : ""}`, linkPath: `/student/courses/${assignment.course_id}/assignments/${assignment.id}` });
  }

  notifyGradeReleased(actor: Actor, submissionId: string, eventKey = `submission:${submissionId}:grade-released`) {
    const submission = requireRow<Record<string, any>>(this.db.get("SELECT s.student_id, a.course_id, a.title_zh FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = ?", [submissionId]), "Submission not found");
    staff(actor);
    if (!this.canManageCourse(actor, submission.course_id)) throw new DomainError("forbidden", "You cannot release this grade", 403);
    const recipient = this.db.get<{ id: string; email: string | null }>("SELECT u.id, u.email FROM users u JOIN course_enrollments ce ON ce.student_id = u.id WHERE u.id = ? AND ce.course_id = ? AND ce.status = 'active' AND u.status = 'active'", [submission.student_id, submission.course_id]);
    if (!recipient) throw new DomainError("not_found", "Student not found", 404);
    return this.createForRecipients(actor, { courseId: submission.course_id, recipientIds: [submission.student_id], eventKey, type: "grade_released", title: "成績已發布", body: `功課「${submission.title_zh}」的成績已可查看。`, linkPath: `/student/practice/${submissionId}` });
  }

  notifyLateNotice(actor: Actor, courseId: string, eventKey: string, title = "逾期提交通知", body = "你的功課已逾期提交。", linkPath?: string, studentId?: string) {
    if (!studentId) return this.notifyCourseEvent(actor, { courseId, eventKey, type: "late_notice", title, body, linkPath });
    staff(actor);
    if (!this.canManageCourse(actor, courseId)) throw new DomainError("forbidden", "You cannot notify this course", 403);
    const enrolled = this.db.get("SELECT 1 FROM course_enrollments WHERE course_id = ? AND student_id = ? AND status = 'active'", [courseId, studentId]);
    if (!enrolled) throw new DomainError("not_found", "Student is not enrolled in this course", 404);
    return this.createForRecipients(actor, { courseId, recipientIds: [studentId], eventKey, type: "late_notice", title, body, linkPath });
  }

  listNotifications(actor: Actor, options: { unreadOnly?: boolean; limit?: number } = {}) {
    this.requireActive(actor);
    const limit = Math.max(1, Math.min(100, options.limit ?? 50));
    return this.db.all("SELECT id, type, title, body, link_path, read_at, created_at FROM notifications WHERE recipient_id = ? AND (? = 0 OR read_at IS NULL) ORDER BY created_at DESC LIMIT ?", [actor.id, options.unreadOnly ? 1 : 0, limit]);
  }
  markRead(actor: Actor, notificationId: string) {
    this.requireActive(actor);
    const notification = requireRow<{ recipient_id: string }>(this.db.get("SELECT recipient_id FROM notifications WHERE id = ?", [notificationId]), "Notification not found");
    if (notification.recipient_id !== actor.id) throw new DomainError("forbidden", "You cannot update this notification", 403);
    this.db.run("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?", [now(this.clock), notificationId]);
    return this.db.get("SELECT id, read_at FROM notifications WHERE id = ?", [notificationId]);
  }

  listDeliveries(actor: Actor, options: { status?: string } = {}) {
    if (actor.role !== "admin") throw new DomainError("forbidden", "Administrator permission required", 403);
    return this.db.all("SELECT id, notification_id, recipient_email, status, provider_message_id, attempt_count, next_attempt_at, last_error_code, created_at, sent_at, cancelled_at, bounced_at FROM email_deliveries WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC", [options.status ?? null, options.status ?? null]);
  }

  async processEmailQueue(options: { now?: Date; limit?: number } = {}) {
    const current = options.now ?? this.clock();
    const currentIso = current.toISOString();
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    this.db.run("UPDATE email_deliveries SET status = 'failed', next_attempt_at = ?, last_error_code = 'worker_recovered' WHERE status = 'sending' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?", [currentIso, currentIso]);
    const rows = this.db.all<Record<string, any>>("SELECT * FROM email_deliveries WHERE (status = 'queued' OR (status = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)) ORDER BY created_at LIMIT ?", [currentIso, limit]);
    const results: Array<{ id: string; status: string }> = [];
    for (const row of rows) {
      const claimUntil = new Date(current.getTime() + 15 * 60_000).toISOString();
      const claimed = this.db.run("UPDATE email_deliveries SET status = 'sending', next_attempt_at = ? WHERE id = ? AND (status = 'queued' OR (status = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?))", [claimUntil, row.id, currentIso]);
      if (!Number(claimed.changes ?? 0)) continue;
      if (!this.emailEnabled) {
        this.db.run("UPDATE email_deliveries SET status = 'suppressed', last_error_code = 'email_disabled', next_attempt_at = NULL WHERE id = ?", [row.id]);
        results.push({ id: row.id, status: "suppressed" });
        continue;
      }
      const attempt = Number(row.attempt_count ?? 0) + 1;
      try {
        const message = await this.mailer.send({ deliveryId: row.id, to: row.recipient_email, subject: row.subject ?? "學習平台通知", body: row.body ?? "" });
        this.db.run("UPDATE email_deliveries SET status = 'sent', provider_message_id = ?, attempt_count = ?, next_attempt_at = NULL, sent_at = ? WHERE id = ?", [message.providerMessageId, attempt, currentIso, row.id]);
        results.push({ id: row.id, status: "sent" });
      } catch (error) {
        const code = error instanceof EmailDeliveryError ? error.code : "temporary";
        if (code === "bounced") {
          this.db.run("UPDATE email_deliveries SET status = 'bounced', attempt_count = ?, next_attempt_at = NULL, last_error_code = 'bounced', bounced_at = ? WHERE id = ?", [attempt, currentIso, row.id]);
          results.push({ id: row.id, status: "bounced" });
        } else if (code === "disabled") {
          this.db.run("UPDATE email_deliveries SET status = 'suppressed', attempt_count = ?, next_attempt_at = NULL, last_error_code = 'email_disabled' WHERE id = ?", [attempt, row.id]);
          results.push({ id: row.id, status: "suppressed" });
        } else if (attempt >= this.maxAttempts) {
          this.db.run("UPDATE email_deliveries SET status = 'failed', attempt_count = ?, next_attempt_at = NULL, last_error_code = 'temporary_failure' WHERE id = ?", [attempt, row.id]);
          results.push({ id: row.id, status: "failed" });
        } else {
          const delay = [60_000, 300_000, 1_800_000][Math.min(attempt - 1, 2)];
          this.db.run("UPDATE email_deliveries SET status = 'failed', attempt_count = ?, next_attempt_at = ?, last_error_code = 'temporary_failure' WHERE id = ?", [attempt, new Date(current.getTime() + delay).toISOString(), row.id]);
          results.push({ id: row.id, status: "failed" });
        }
      }
    }
    return results;
  }

  retryDelivery(actor: Actor, deliveryId: string) {
    if (actor.role !== "admin") throw new DomainError("forbidden", "Administrator permission required", 403);
    const row = requireRow<{ status: string }>(this.db.get("SELECT status FROM email_deliveries WHERE id = ?", [deliveryId]), "Email delivery not found");
    if (row.status !== "failed") throw new DomainError("invalid_delivery_state", "Only failed email deliveries can be retried");
    this.db.run("UPDATE email_deliveries SET status = 'queued', next_attempt_at = ?, last_error_code = NULL WHERE id = ?", [now(this.clock), deliveryId]);
    return this.db.get("SELECT id, status, attempt_count, next_attempt_at FROM email_deliveries WHERE id = ?", [deliveryId]);
  }
  cancelDelivery(actor: Actor, deliveryId: string) {
    if (actor.role !== "admin") throw new DomainError("forbidden", "Administrator permission required", 403);
    const row = requireRow<{ status: string }>(this.db.get("SELECT status FROM email_deliveries WHERE id = ?", [deliveryId]), "Email delivery not found");
    if (!["queued", "failed"].includes(row.status)) throw new DomainError("invalid_delivery_state", "This email cannot be cancelled");
    this.db.run("UPDATE email_deliveries SET status = 'cancelled', next_attempt_at = NULL, cancelled_at = ? WHERE id = ?", [now(this.clock), deliveryId]);
    return this.db.get("SELECT id, status, cancelled_at FROM email_deliveries WHERE id = ?", [deliveryId]);
  }
}

function emailId() { return randomUUID(); }
