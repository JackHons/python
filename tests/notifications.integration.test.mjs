import assert from "node:assert/strict";
import test from "node:test";

const { NotificationService } = await import("../server/notifications.ts");
import { makeContentFixture } from "./content-helpers.mjs";

test("announcement recipients are snapshotted at publish time and duplicate events are idempotent", async () => {
  const fixture = await makeContentFixture();
  try {
    fixture.db.run("UPDATE users SET email = 'student@example.edu' WHERE id = ?", [fixture.student.id]);
    const service = new NotificationService(fixture.db);
    const announcement = service.createAnnouncement(fixture.teacher, { courseId: fixture.course.id, titleZh: "公告", bodyZh: "請完成練習" });
    const first = service.publishAnnouncement(fixture.teacher, announcement.id, "announcement-event-1");
    const second = service.publishAnnouncement(fixture.teacher, announcement.id, "announcement-event-1");
    assert.equal(first.notificationIds.length, 1);
    assert.equal(second.notificationIds.length, 0);
    assert.equal(fixture.db.get("SELECT COUNT(*) AS count FROM notifications WHERE source_key = ?", ["announcement-event-1"]).count, 1);
    assert.equal(service.listNotifications(fixture.student)[0].title, "公告");
    service.markRead(fixture.student, first.notificationIds[0]);
    assert.equal(service.listNotifications(fixture.student, { unreadOnly: true }).length, 0);
    const later = fixture.education.createUser(fixture.admin, { role: "student", username: "late", chineseName: "後加入", email: "late@example.edu", studentNumber: "S0002" });
    const classId = fixture.db.get("SELECT id FROM classes LIMIT 1").id;
    fixture.education.addClassMember(fixture.admin, classId, later.user.id);
    assert.equal(service.listNotifications({ id: later.user.id, role: "student" }).length, 0);
  } finally {
    await fixture.close();
  }
});
