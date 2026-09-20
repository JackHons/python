import { randomUUID } from "node:crypto";
import { createBackendApp } from "../server/http/backend.ts";
import { generateOpaqueToken, hashPassword } from "../server/security.ts";

const action = process.env.LOCAL_ADMIN_ACTION ?? "provision";
if (!["provision", "rotate"].includes(action)) throw new Error("Unsupported local admin action");

const app = createBackendApp({ databasePath: process.env.DATABASE_PATH });
const fixtureNames = ["admin-demo", "container-teacher", "container-operator"];
const fixturePattern = "container-student-%";
const timestamp = new Date().toISOString();
const password = `P${generateOpaqueToken(24)}!`;
const existingAdmin = app.services.db.get("SELECT id, role FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1");

try {
  let result;
  app.services.db.transaction(() => {
    const fixtureRows = app.services.db.all(
      "SELECT id, username FROM users WHERE username IN (?, ?, ?) OR username LIKE ?",
      [fixtureNames[0], fixtureNames[1], fixtureNames[2], fixturePattern],
    );
    for (const fixture of fixtureRows) {
      app.services.db.run("UPDATE users SET status = 'archived', updated_at = ? WHERE id = ?", [timestamp, fixture.id]);
      app.services.db.run("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [timestamp, fixture.id]);
    }
    const local = app.services.db.get("SELECT id, role FROM users WHERE username = ?", ["admin-local"]);
    if (local && local.role !== "admin") throw new Error("admin-local username is occupied by a non-admin account");
    if (action === "provision" && local) throw new Error("admin-local already exists; use --rotate for rotation");
    if (local) {
      app.services.db.run("UPDATE users SET password_hash = ?, must_change_password = 1, status = 'active', failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?", [hashPassword(password), timestamp, local.id]);
      app.services.db.run("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [timestamp, local.id]);
      result = { id: local.id, created: false };
    } else {
      const id = randomUUID();
      app.services.db.run(`INSERT INTO users (id, role, username, student_number, chinese_name, english_name, email, password_hash, must_change_password, status, created_at, updated_at)
        VALUES (?, 'admin', 'admin-local', NULL, '本地管理員', 'Local Administrator', NULL, ?, 1, 'active', ?, ?)`, [id, hashPassword(password), timestamp, timestamp]);
      result = { id, created: true };
    }
    app.services.audit.record(existingAdmin ? { id: existingAdmin.id, role: "admin" } : null, {
      action: action === "rotate" ? "admin.local.rotated" : "admin.local.provisioned",
      entityType: "user",
      entityId: result.id,
      metadata: { fixtureAccountsArchived: fixtureRows.length, mustChangePassword: true },
    });
  });
  console.log(JSON.stringify({ username: "admin-local", initialPassword: password, mustChangePassword: true, created: result.created, fixtureAccountsArchived: true }));
} finally {
  app.close();
}
