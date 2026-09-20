import net from "node:net";
import tls from "node:tls";
import { randomUUID } from "node:crypto";
import { EmailDeliveryError, type Mailer, type MailMessage } from "./service.ts";

export type SmtpConfig = {
  host: string;
  port: number;
  tlsMode: "none" | "starttls" | "tls";
  username?: string;
  password?: string;
  from: string;
  timeoutMs?: number;
};

function cleanHeader(value: string, name: string) {
  const result = String(value ?? "").trim();
  if (!result || /[\r\n]/.test(result)) throw new EmailDeliveryError("temporary", `${name} is invalid`);
  return result;
}

class SmtpConnection {
  private buffer = "";
  private readonly waiters: Array<{ resolve: (value: { code: number; text: string }) => void; reject: (error: Error) => void }> = [];
  readonly socket: net.Socket | tls.TLSSocket;
  constructor(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { this.buffer += chunk; this.consume(); });
    socket.on("error", (error) => { while (this.waiters.length) this.waiters.shift()?.reject(error); });
  }
  private consume() {
    const lines = this.buffer.split("\r\n");
    this.buffer = lines.pop() ?? "";
    let index = 0;
    while (index < lines.length && this.waiters.length) {
      const first = lines[index];
      const match = first.match(/^(\d{3})([- ])(.*)$/);
      if (!match) { index += 1; continue; }
      const code = Number(match[1]);
      const response = [match[3]];
      index += 1;
      if (match[2] === "-") {
        while (index < lines.length) {
          const continuation = lines[index];
          response.push(continuation.replace(/^\d{3}[- ]/, ""));
          index += 1;
          if (continuation.startsWith(`${code} `)) break;
        }
      }
      this.waiters.shift()?.resolve({ code, text: response.join("\n") });
    }
  }
  response(timeoutMs: number) {
    return new Promise<{ code: number; text: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("smtp_timeout")), timeoutMs);
      this.waiters.push({ resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.consume();
    });
  }
  async command(value: string, timeoutMs: number) {
    this.socket.write(value + "\r\n");
    return this.response(timeoutMs);
  }
}

function expect(response: { code: number; text: string }, allowed: number[]) {
  if (allowed.includes(response.code)) return response;
  if (response.code >= 500) throw new EmailDeliveryError(response.code >= 550 ? "bounced" : "temporary", `SMTP rejected the message (${response.code})`);
  throw new EmailDeliveryError("temporary", `SMTP temporary failure (${response.code})`);
}

export class SmtpMailer implements Mailer {
  private config: SmtpConfig | null;
  constructor(config?: SmtpConfig) { this.config = config ? this.validate(config) : null; }
  configure(config: SmtpConfig) { this.config = this.validate(config); }
  settings() {
    return { host: this.config?.host ?? "", port: this.config?.port ?? 0, tlsMode: this.config?.tlsMode ?? "none", username: this.config?.username ?? "", from: this.config?.from ?? "", passwordConfigured: Boolean(this.config?.password) };
  }
  private validate(config: SmtpConfig) {
    const host = cleanHeader(config.host, "SMTP host");
    const from = cleanHeader(config.from, "SMTP sender");
    const port = Number(config.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new EmailDeliveryError("disabled", "SMTP port is invalid");
    if (!(["none", "starttls", "tls"] as const).includes(config.tlsMode)) throw new EmailDeliveryError("disabled", "SMTP TLS mode is invalid");
    return { ...config, host, port, from, timeoutMs: Math.max(1000, Math.min(60000, config.timeoutMs ?? 10000)) };
  }
  async send(message: MailMessage) {
    const config = this.config;
    if (!config) throw new EmailDeliveryError("disabled", "SMTP is not configured");
    const timeout = config.timeoutMs ?? 10000;
    const recipient = cleanHeader(message.to, "Recipient");
    const subject = cleanHeader(message.subject || "Learning platform notification", "Subject");
    let socket: net.Socket | tls.TLSSocket = config.tlsMode === "tls"
      ? tls.connect({ host: config.host, port: config.port, servername: config.host, rejectUnauthorized: true })
      : net.createConnection({ host: config.host, port: config.port });
    socket.setTimeout(timeout, () => socket.destroy(new Error("smtp_timeout")));
    let session = new SmtpConnection(socket);
    try {
      expect(await session.response(timeout), [220]);
      expect(await session.command("EHLO learning-platform.local", timeout), [250]);
      if (config.tlsMode === "starttls") {
        expect(await session.command("STARTTLS", timeout), [220]);
        socket = tls.connect({ socket, servername: config.host, rejectUnauthorized: true });
        session = new SmtpConnection(socket);
        expect(await session.command("EHLO learning-platform.local", timeout), [250]);
      }
      if (config.username) {
        const auth = Buffer.from(`\0${config.username}\0${config.password ?? ""}`, "utf8").toString("base64");
        expect(await session.command(`AUTH PLAIN ${auth}`, timeout), [235]);
      }
      expect(await session.command(`MAIL FROM:<${cleanHeader(config.from, "Sender")}>`, timeout), [250]);
      expect(await session.command(`RCPT TO:<${recipient}>`, timeout), [250, 251]);
      expect(await session.command("DATA", timeout), [354]);
      const messageId = `<${randomUUID()}@learning-platform.local>`;
      const body = String(message.body ?? "").replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
      const payload = [`From: ${config.from}`, `To: ${recipient}`, `Subject: ${subject}`, `Message-ID: ${messageId}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", body, "."].join("\r\n");
      socket.write(payload + "\r\n");
      expect(await session.response(timeout), [250]);
      await session.command("QUIT", timeout).catch(() => ({ code: 221, text: "" }));
      return { providerMessageId: messageId };
    } catch (error) {
      if (error instanceof EmailDeliveryError) throw error;
      throw new EmailDeliveryError("temporary", "SMTP delivery failed");
    } finally { socket.destroy(); }
  }
}
