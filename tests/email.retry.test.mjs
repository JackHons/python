import assert from "node:assert/strict";
import test from "node:test";

const { NotificationService, FakeMailer, EmailDeliveryError } = await import("../server/notifications.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("email queue retries with bounded backoff and handles bounce/cancel/disabled", async () => {
  const fixture = await makeContentFixture();
  try {
    fixture.db.run("UPDATE users SET email = 'student@example.edu' WHERE id = ?", [fixture.student.id]);
    const mailer = new FakeMailer();
    const service = new NotificationService(fixture.db, () => new Date("2026-08-20T02:00:00.000Z"), { mailer, maxAttempts: 2 });
    service.createAnnouncement(fixture.teacher, { courseId: fixture.course.id, titleZh: "通知", bodyZh: "不要把 hidden-test-canary 或 sk-secret-value 傳送給學生" });
    const announcement = fixture.db.get("SELECT id FROM announcements ORDER BY created_at DESC LIMIT 1");
    const result = service.publishAnnouncement(fixture.teacher, announcement.id, "mail-event-1");
    const delivery = fixture.db.get("SELECT * FROM email_deliveries WHERE notification_id = ?", [result.notificationIds[0]]);
    mailer.failNext(new EmailDeliveryError("temporary", "offline"));
    const first = await service.processEmailQueue();
    assert.equal(first[0].status, "failed");
    const retryAt = fixture.db.get("SELECT next_attempt_at FROM email_deliveries WHERE id = ?", [delivery.id]).next_attempt_at;
    const second = await service.processEmailQueue({ now: new Date(retryAt) });
    assert.equal(second[0].status, "sent");
    assert.equal(mailer.messages[0].body.includes("hidden-test-canary"), false);
    assert.equal(mailer.messages[0].body.includes("sk-secret-value"), false);
    const bounce = service.createAnnouncement(fixture.teacher, { courseId: fixture.course.id, titleZh: "退信", bodyZh: "內容" });
    service.publishAnnouncement(fixture.teacher, bounce.id, "mail-event-bounce");
    mailer.failNext(new EmailDeliveryError("bounced", "invalid mailbox"));
    const bounceResult = await service.processEmailQueue();
    assert.equal(bounceResult.at(-1).status, "bounced");
    const disabled = new NotificationService(fixture.db, () => new Date("2026-08-20T02:00:00.000Z"), { emailEnabled: false });
    const cancelled = disabled.createAnnouncement(fixture.teacher, { courseId: fixture.course.id, titleZh: "停用", bodyZh: "內容" });
    const cancelledResult = disabled.publishAnnouncement(fixture.teacher, cancelled.id, "mail-event-disabled");
    const suppressed = fixture.db.get("SELECT * FROM email_deliveries WHERE notification_id = ?", [cancelledResult.notificationIds[0]]);
    assert.equal(suppressed.status, "suppressed");
    const pending = service.createAnnouncement(fixture.teacher, { courseId: fixture.course.id, titleZh: "取消", bodyZh: "內容" });
    const pendingResult = service.publishAnnouncement(fixture.teacher, pending.id, "mail-event-cancel");
    const pendingDelivery = fixture.db.get("SELECT id FROM email_deliveries WHERE notification_id = ?", [pendingResult.notificationIds[0]]);
    assert.equal(service.cancelDelivery(fixture.admin, pendingDelivery.id).status, "cancelled");
  } finally {
    await fixture.close();
  }
});
