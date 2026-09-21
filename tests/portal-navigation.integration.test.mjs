import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const routesModule = await import("../app/lib/portal-routes.ts");
const { PORTAL_ROUTES, isPortalRouteActive, resolvePortalPath } = routesModule;

const expectedSections = {
  student: {
    home: "/student/dashboard",
    courses: "/student/courses",
    notifications: "/student/notifications",
    missions: "/student/missions",
    practice: "/student/practice",
    resources: "/student/resources",
    classrooms: "/student/classrooms",
  },
  teacher: {
    dashboard: "/teacher/dashboard",
    content: "/teacher/courses",
    materials: "/teacher/materials",
    classes: "/teacher/classes",
    announcements: "/teacher/announcements",
    exports: "/teacher/exports",
    assessment: "/teacher/assessment",
    classrooms: "/teacher/classrooms",
    "analytics-ai": "/teacher/analytics/ai",
    ai: "/teacher/ai-review",
  },
  admin: {
    admin: "/admin/dashboard",
    "admin-users": "/admin/users",
    "admin-classes": "/admin/classes",
    "admin-courses": "/admin/courses",
    "ai-settings": "/admin/settings/ai",
    "admin-settings": "/admin/settings",
    "admin-backups": "/admin/backups",
    "admin-audit": "/admin/audit",
    "admin-email": "/admin/email",
  },
};

test("every rendered top-level portal section has one canonical route and a page file", async () => {
  assert.equal(typeof routesModule.portalPathForSection, "function");
  const seen = new Set();
  for (const [role, sections] of Object.entries(expectedSections)) {
    for (const [section, path] of Object.entries(sections)) {
      assert.equal(routesModule.portalPathForSection(role, section), path, `${role}:${section}`);
      assert.deepEqual(resolvePortalPath(path), { role, section, params: [] }, path);
      assert.equal(seen.has(path), false, `duplicate canonical path: ${path}`);
      seen.add(path);
      await access(join(process.cwd(), "app", ...path.split("/").filter(Boolean), "page.tsx"));
    }
  }
  assert.equal(new Set(PORTAL_ROUTES.map((route) => route.path)).size, PORTAL_ROUTES.length);
});

test("dynamic navigation preserves section identity while changing resource parameters", () => {
  const cases = [
    ["/student/courses/course-a", "student", "courses"],
    ["/student/courses/course-b/units/unit-b", "student", "courses"],
    ["/student/courses/course-b/assignments/assignment-b", "student", "missions"],
    ["/student/practice/submission-b", "student", "practice"],
    ["/student/classrooms/session-b", "student", "classrooms"],
    ["/teacher/courses/course-b", "teacher", "content"],
    ["/teacher/courses/course-b/units/unit-b/materials", "teacher", "materials"],
    ["/teacher/classes/class-b", "teacher", "classes"],
    ["/teacher/assignments/assignment-b/submissions", "teacher", "assessment"],
    ["/teacher/classrooms/session-b", "teacher", "classrooms"],
  ];
  for (const [path, role, section] of cases) {
    const resolved = resolvePortalPath(path);
    assert.equal(resolved?.role, role, path);
    assert.equal(resolved?.section, section, path);
    assert.deepEqual(resolved?.params, path.split("/").filter(Boolean), path);
  }
});

test("only the most specific sidebar route is active", () => {
  const route = (path) => PORTAL_ROUTES.find((item) => item.path === path);
  assert.equal(isPortalRouteActive("/admin/settings/ai", route("/admin/settings/ai")), true);
  assert.equal(isPortalRouteActive("/admin/settings/ai", route("/admin/settings")), false);
  assert.equal(isPortalRouteActive("/teacher/analytics/ai", route("/teacher/analytics/ai")), true);
  assert.equal(isPortalRouteActive("/teacher/analytics/ai", route("/teacher/analytics")), false);
  assert.equal(isPortalRouteActive("/student/courses/course-a", route("/student/courses")), true);
  assert.equal(isPortalRouteActive("/student/dashboard/unknown", route("/student/dashboard")), false);
});

test("client navigation synchronizes view state before pushing the URL", async () => {
  const page = await readFile("app/page.tsx", "utf8");
  assert.match(page, /function navigatePath\(path: string\)[\s\S]*applyRoute\(role, path\);[\s\S]*router\.push\(path\)/);
  assert.match(page, /function RoleSidebar[\s\S]*onClick=\{\(event\) => \{ event\.preventDefault\(\); navigatePath\(route\.path\); \}\}/);
  assert.match(page, /course-select-card[\s\S]*navigatePath\(path\)/);
  assert.match(page, /course-breadcrumbs[\s\S]*navigatePath\("\/student\/courses"\)/);
  assert.match(page, /admin-link-grid[\s\S]*navigatePath\(path\)/);
  assert.match(page, /canonicalNotificationPath[\s\S]*navigatePath\(link\)/);
  assert.doesNotMatch(page, /const studentPath:/);
  assert.doesNotMatch(page, /const teacherPath:/);
  assert.match(page, /portalPathForSection\("student", item\.key\)/);
  assert.match(page, /portalPathForSection\("teacher", item\.key\)/);
  assert.doesNotMatch(page, /<Link(?! prefetch=\{false\})/);
  assert.match(page, /const loginPath = pathname === "\/" \|\| currentRoute\?\.role === user\.role \? undefined : roleHome\(user\.role\)/);
  assert.match(page, /applyRoute\(user\.role, loginPath\);[\s\S]*if \(loginPath\) router\.replace\(loginPath\)/);
  assert.match(page, /beginSubmission[\s\S]*navigatePath\(path\)/);
});
