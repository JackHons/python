export type PortalRole = "student" | "teacher" | "admin";

export type PortalRoute = {
  path: string;
  role: PortalRole;
  labelZh: string;
  labelEn: string;
  section: string;
};

export const PORTAL_ROUTES: PortalRoute[] = [
  { path: "/student/dashboard", role: "student", labelZh: "首頁", labelEn: "Dashboard", section: "home" },
  { path: "/student/courses", role: "student", labelZh: "課程", labelEn: "Courses", section: "courses" },
  { path: "/student/notifications", role: "student", labelZh: "通知", labelEn: "Notifications", section: "notifications" },
  { path: "/student/classrooms", role: "student", labelZh: "即時課堂", labelEn: "Live classrooms", section: "classrooms" },
  { path: "/teacher/dashboard", role: "teacher", labelZh: "教師首頁", labelEn: "Dashboard", section: "dashboard" },
  { path: "/teacher/courses", role: "teacher", labelZh: "課程內容", labelEn: "Courses", section: "content" },
  { path: "/teacher/classes", role: "teacher", labelZh: "班別學生", labelEn: "Classes", section: "classes" },
  { path: "/teacher/announcements", role: "teacher", labelZh: "公告通知", labelEn: "Announcements", section: "announcements" },
  { path: "/teacher/classrooms", role: "teacher", labelZh: "即時課堂", labelEn: "Live classrooms", section: "classrooms" },
  { path: "/teacher/analytics", role: "teacher", labelZh: "學習分析", labelEn: "Analytics", section: "dashboard" },
  { path: "/teacher/analytics/ai", role: "teacher", labelZh: "AI 用量分析", labelEn: "AI analytics", section: "analytics-ai" },
  { path: "/teacher/ai-review", role: "teacher", labelZh: "AI 內容審核", labelEn: "AI content review", section: "ai" },
  { path: "/admin/dashboard", role: "admin", labelZh: "系統概況", labelEn: "Dashboard", section: "admin" },
  { path: "/admin/users", role: "admin", labelZh: "帳戶", labelEn: "Users", section: "admin-users" },
  { path: "/admin/classes", role: "admin", labelZh: "班別", labelEn: "Classes", section: "admin-classes" },
  { path: "/admin/courses", role: "admin", labelZh: "課程", labelEn: "Courses", section: "admin-courses" },
  { path: "/admin/settings/ai", role: "admin", labelZh: "AI 設定", labelEn: "AI settings", section: "ai-settings" },
  { path: "/admin/settings", role: "admin", labelZh: "系統設定", labelEn: "Settings", section: "admin-settings" },
  { path: "/admin/backups", role: "admin", labelZh: "備份", labelEn: "Backups", section: "admin-backups" },
  { path: "/admin/audit", role: "admin", labelZh: "稽核", labelEn: "Audit", section: "admin-audit" },
  { path: "/admin/email", role: "admin", labelZh: "Email Outbox", labelEn: "Email Outbox", section: "admin-email" },
];

const DYNAMIC_ROUTES: Array<{ pattern: RegExp; role: PortalRole; section: string }> = [
  { pattern: /^\/student\/courses\/[^/]+$/, role: "student", section: "courses" },
  { pattern: /^\/student\/courses\/[^/]+\/units\/[^/]+$/, role: "student", section: "courses" },
  { pattern: /^\/student\/courses\/[^/]+\/assignments\/[^/]+$/, role: "student", section: "missions" },
  { pattern: /^\/student\/practice\/[^/]+$/, role: "student", section: "practice" },
  { pattern: /^\/student\/classrooms\/[^/]+$/, role: "student", section: "classrooms" },
  { pattern: /^\/teacher\/courses\/[^/]+$/, role: "teacher", section: "content" },
  { pattern: /^\/teacher\/courses\/[^/]+\/units\/[^/]+\/materials$/, role: "teacher", section: "materials" },
  { pattern: /^\/teacher\/classes\/[^/]+$/, role: "teacher", section: "classes" },
  { pattern: /^\/teacher\/assignments\/[^/]+\/submissions$/, role: "teacher", section: "assessment" },
  { pattern: /^\/teacher\/classrooms\/[^/]+$/, role: "teacher", section: "classrooms" },
];

export function roleHome(role: PortalRole) {
  return `/${role}/dashboard`;
}

export function resolvePortalPath(pathname: string): { role: PortalRole; section: string; params: string[] } | null {
  const exact = PORTAL_ROUTES.find((route) => route.path === pathname);
  if (exact) return { role: exact.role, section: exact.section, params: [] };
  const dynamic = DYNAMIC_ROUTES.find((route) => route.pattern.test(pathname));
  if (!dynamic) return null;
  return { role: dynamic.role, section: dynamic.section, params: pathname.split("/").filter(Boolean) };
}

export function compatiblePath(pathname: string, role: PortalRole) {
  if (pathname === "/dashboard") return roleHome(role);
  if (pathname === "/courses") return role === "student" ? "/student/courses" : role === "teacher" ? "/teacher/courses" : "/admin/courses";
  if (pathname === "/classroom") return role === "student" ? "/student/classrooms" : role === "teacher" ? "/teacher/classrooms" : "/admin/dashboard";
  return pathname;
}

export function safeReturnTo(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  try {
    const parsed = new URL(value, "http://local.invalid");
    return parsed.origin === "http://local.invalid" ? parsed.pathname + parsed.search : null;
  } catch {
    return null;
  }
}
