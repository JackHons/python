import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { MasterKeyCipher } from "../server/ai.ts";
import { NotificationService } from "../server/notifications/service.ts";
import { SmtpMailer } from "../server/notifications/smtp.ts";
import { makeContentFixture } from "./content-helpers.mjs";

async function fakeSmtp() {
  const messages = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 local-smtp ESMTP\r\n");
    let buffer = "";
    let data = false;
    let message = [];
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\r\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (data) {
          if (line === ".") { messages.push(message.join("\n")); message = []; data = false; socket.write("250 2.0.0 accepted\r\n"); }
          else message.push(line);
        } else if (line.startsWith("EHLO")) socket.write("250-local-smtp\r\n250 8BITMIME\r\n");
        else if (line.startsWith("MAIL FROM")) socket.write("250 sender ok\r\n");
        else if (line.startsWith("RCPT TO")) socket.write("250 recipient ok\r\n");
        else if (line === "DATA") { data = true; socket.write("354 end with dot\r\n"); }
        else if (line === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, messages, port: server.address().port };
}

test("SMTP adapter sends queued notifications and persisted credentials remain encrypted and masked", async () => {
  const smtp = await fakeSmtp();
  const fixture = await makeContentFixture();
  try {
    fixture.db.run("UPDATE users SET email = ? WHERE id = ?", ["student@example.test", fixture.student.id]);
    const cipher = new MasterKeyCipher(Buffer.alloc(32, 7));
    const mailer = new SmtpMailer();
    const service = new NotificationService(fixture.db, () => new Date("2026-08-23T04:00:00.000Z"), { mailer, emailEnabled: false, secretCipher: cipher });
    const settings = service.configureEmail(fixture.admin, { enabled: true, host: "127.0.0.1", port: smtp.port, tlsMode: "none", password: "SMTP_TEST_SECRET", from: "teacher@example.test" });
    assert.equal(settings.enabled, true);
    assert.equal(settings.passwordConfigured, true);
    assert.equal("password" in settings, false);
    const stored = fixture.db.get("SELECT value_json FROM system_settings WHERE key = 'email.smtp'").value_json;
    assert.doesNotMatch(stored, /SMTP_TEST_SECRET/);

    const announcement = service.createAnnouncement(fixture.teacher, { courseId: fixture.course.id, titleZh: "課堂通知", bodyZh: "明天帶電腦。" });
    service.publishAnnouncement(fixture.teacher, announcement.id, "smtp-integration-event");
    const results = await service.processEmailQueue();
    assert.deepEqual(results.map((item) => item.status), ["sent"]);
    assert.equal(smtp.messages.length, 1);
    assert.match(smtp.messages[0], /Subject: 課堂通知/);
    assert.match(smtp.messages[0], /明天帶電腦/);
    assert.doesNotMatch(smtp.messages[0], /SMTP_TEST_SECRET|hidden[_ -]?test/i);

    const reloaded = new NotificationService(fixture.db, undefined, { mailer: new SmtpMailer(), emailEnabled: false, secretCipher: cipher });
    assert.equal(reloaded.emailSettings(fixture.admin).passwordConfigured, true);
    assert.equal(reloaded.emailSettings(fixture.admin).enabled, true);
  } finally {
    await fixture.close();
    await new Promise((resolve) => smtp.server.close(resolve));
  }
});
