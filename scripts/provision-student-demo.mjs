import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
if (process.env.LOCAL_STUDENT_DEMO_CONFIRM !== "PROVISION_STUDENT_DEMO") throw new Error("Set LOCAL_STUDENT_DEMO_CONFIRM=PROVISION_STUDENT_DEMO; no account was changed");
const root = resolve(process.cwd(), ".local-secrets");
const destination = resolve(root, "student-demo.json");
const temporary = resolve(root, `student-demo.json.tmp-${process.pid}`);
await mkdir(root, { recursive: true, mode: 0o700 });
await chmod(root, 0o700);
try {
  const handle = await open(temporary, "wx", 0o600);
  try {
    const result = await execFileAsync("docker", ["compose", "exec", "-T", "-e", "NODE_NO_WARNINGS=1", "-e", "LOCAL_STUDENT_DEMO_CONFIRM=PROVISION_STUDENT_DEMO", "backend", "node", "--experimental-strip-types", "scripts/provision-student-demo-backend.mjs"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    const value = JSON.parse(result.stdout);
    if (value.username !== "student-demo" || typeof value.initialPassword !== "string" || value.initialPassword.length < 16 || value.mustChangePassword !== false || typeof value.courseId !== "string" || typeof value.assignmentId !== "string") throw new Error("backend returned an invalid student demo contract");
    await handle.writeFile(JSON.stringify({ username: value.username, initialPassword: value.initialPassword, mustChangePassword: false, courseId: value.courseId, assignmentId: value.assignmentId, joinCode: value.joinCode, demoOnly: true }, null, 2) + "\n", "utf8");
  } finally {
    await handle.chmod(0o600);
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  console.log(JSON.stringify({ account: "student-demo", credentialsFile: ".local-secrets/student-demo.json", mode: "0600", demoOnly: true, secretPrinted: false }));
} catch (error) {
  await rm(temporary, { force: true });
  throw new Error(`student demo provisioning failed: ${error instanceof Error ? error.message : "unknown error"}`);
}
