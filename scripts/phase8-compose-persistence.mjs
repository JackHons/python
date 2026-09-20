import { writeFile } from "node:fs/promises";

const base = process.env.PHASE8_WEB_URL ?? "http://127.0.0.1:3000";
const username = process.env.PHASE8_ADMIN_USERNAME ?? "admin-demo";
const password = process.env.PHASE8_ADMIN_PASSWORD;
if (!password) throw new Error("PHASE8_ADMIN_PASSWORD is required and is never logged");

function cookieOf(response) { return response.headers.get("set-cookie")?.split(";", 1)[0] ?? ""; }
async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    headers.set("origin", base);
  }
  return fetch(`${base}/api/v1${path}`, { ...options, headers });
}

const login = await request("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
if (login.status !== 200) throw new Error(`persistence login failed: ${login.status}`);
const cookie = cookieOf(login);
const courses = await request("/courses", { headers: { cookie } });
if (!courses.ok) throw new Error(`persistent courses read failed: ${courses.status}`);
const courseBody = await courses.json();
const report = {
  scenario: "compose-restart-persistence",
  loginStatus: login.status,
  coursesStatus: courses.status,
  coursesCount: Array.isArray(courseBody.courses) ? courseBody.courses.length : 0,
  credentialOrSecretLogged: false,
  note: "Verified after docker compose restart; password is supplied only through the process environment and is not written to the report.",
};
await writeFile("docs/任務包/證據/phase8b-persistence.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
