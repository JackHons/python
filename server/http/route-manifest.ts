export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type ApiRole = "student" | "teacher" | "admin" | "anonymous";
export type ApiRouteContract = { pattern: RegExp; template: string; example: string; methods: HttpMethod[]; roles: ApiRole[]; permissionsByMethod: Partial<Record<HttpMethod, ApiRole[]>>; command?: boolean; deprecatedMethods?: Partial<Record<HttpMethod, string>> };

const all = ["student", "teacher", "admin"] as ApiRole[];
const staff = ["teacher", "admin"] as ApiRole[];
const admin = ["admin"] as ApiRole[];
const route = (pattern: RegExp, template: string, example: string, methods: HttpMethod[], roles: ApiRole[], command = false, deprecatedMethods?: Partial<Record<HttpMethod, string>>, permissions?: Partial<Record<HttpMethod, ApiRole[]>>): ApiRouteContract => ({
  pattern, template, example, methods, roles,
  permissionsByMethod: Object.fromEntries(methods.map((method) => [method, permissions?.[method] ?? roles])),
  command: command || undefined, deprecatedMethods,
});

export const API_ROUTE_CONTRACTS: ApiRouteContract[] = [
  route(/^\/auth\/login$/, "/auth/login", "/auth/login", ["POST"], ["anonymous", ...all], true),
  route(/^\/auth\/logout$/, "/auth/logout", "/auth/logout", ["POST"], ["anonymous", ...all], true),
  route(/^\/auth\/(password|change-password)$/, "/auth/:passwordCommand", "/auth/password", ["POST"], all, true),
  route(/^\/me$/, "/me", "/me", ["GET"], all),
  route(/^\/users$/, "/users", "/users", ["GET"], staff),
  route(/^\/users\/[^/]+\/reset-password$/, "/users/:userId/reset-password", "/users/user-1/reset-password", ["POST"], admin, true),
  route(/^\/users\/[^/]+$/, "/users/:userId", "/users/user-1", ["DELETE"], admin),
  route(/^\/admin\/users$/, "/admin/users", "/admin/users", ["POST"], admin),
  route(/^\/students\/import$/, "/students/import", "/students/import", ["POST"], staff),
  route(/^\/classes$/, "/classes", "/classes", ["GET", "POST"], staff),
  route(/^\/classes\/[^/]+\/members$/, "/classes/:classId/members", "/classes/class-1/members", ["GET", "POST"], staff),
  route(/^\/classes\/[^/]+$/, "/classes/:classId", "/classes/class-1", ["PATCH", "PUT", "DELETE"], staff, false, { PUT: "/classes/:classId" }),
  route(/^\/courses\/join$/, "/courses/join", "/courses/join", ["POST"], ["student"], true),
  route(/^\/courses$/, "/courses", "/courses", ["GET", "POST"], all, false, undefined, { GET: all, POST: staff }),
  route(/^\/courses\/[^/]+\/classes$/, "/courses/:courseId/classes", "/courses/course-1/classes", ["GET", "POST"], staff),
  route(/^\/courses\/[^/]+\/units$/, "/courses/:courseId/units", "/courses/course-1/units", ["GET", "POST"], all, false, undefined, { GET: all, POST: staff }),
  route(/^\/courses\/[^/]+\/assignments$/, "/courses/:courseId/assignments", "/courses/course-1/assignments", ["GET"], all),
  route(/^\/courses\/[^/]+\/questions$/, "/courses/:courseId/questions", "/courses/course-1/questions", ["GET"], staff),
  route(/^\/courses\/[^/]+\/classrooms$/, "/courses/:courseId/classrooms", "/courses/course-1/classrooms", ["GET"], all),
  route(/^\/courses\/[^/]+\/execution-policy$/, "/courses/:courseId/execution-policy", "/courses/course-1/execution-policy", ["GET", "PATCH"], all, false, undefined, { GET: all, PATCH: staff }),
  route(/^\/courses\/[^/]+\/ai-artifacts$/, "/courses/:courseId/ai-artifacts", "/courses/course-1/ai-artifacts", ["GET"], staff),
  route(/^\/courses\/[^/]+$/, "/courses/:courseId", "/courses/course-1", ["GET", "PATCH", "PUT", "DELETE"], all, false, { PUT: "/courses/:courseId" }, { GET: all, PATCH: staff, PUT: staff, DELETE: staff }),
  route(/^\/units\/[^/]+\/materials$/, "/units/:unitId/materials", "/units/unit-1/materials", ["GET", "POST"], all, false, undefined, { GET: all, POST: staff }),
  route(/^\/units\/[^/]+$/, "/units/:unitId", "/units/unit-1", ["PATCH", "PUT", "DELETE"], staff, false, { PUT: "/units/:unitId" }),
  route(/^\/materials\/[^/]+\/upgrade-asset$/, "/materials/:materialId/upgrade-asset", "/materials/material-1/upgrade-asset", ["POST"], staff, true),
  route(/^\/materials\/[^/]+\/conversion$/, "/materials/:materialId/conversion", "/materials/material-1/conversion", ["GET", "POST"], all, true, undefined, { GET: all, POST: staff }),
  route(/^\/materials\/[^/]+\/preview\/pdf$/, "/materials/:materialId/preview/pdf", "/materials/material-1/preview/pdf", ["GET"], all),
  route(/^\/materials\/[^/]+\/preview\/slides\/\d+$/, "/materials/:materialId/preview/slides/:page", "/materials/material-1/preview/slides/1", ["GET"], all),
  route(/^\/materials\/[^/]+\/(preview|download)$/, "/materials/:materialId/:view", "/materials/material-1/preview", ["GET"], all),
  route(/^\/materials\/[^/]+$/, "/materials/:materialId", "/materials/material-1", ["PATCH", "DELETE"], staff),
  route(/^\/files$/, "/files", "/files", ["GET", "POST"], all, false, undefined, { GET: staff, POST: all }),
  route(/^\/files\/[^/]+\/release$/, "/files/:assetId/release", "/files/asset-1/release", ["POST"], all, true),
  route(/^\/files\/[^/]+\/download$/, "/files/:assetId/download", "/files/asset-1/download", ["GET"], staff),
  route(/^\/files\/[^/]+$/, "/files/:assetId", "/files/asset-1", ["PATCH", "DELETE"], all, false, undefined, { PATCH: staff, DELETE: all }),
  route(/^\/questions$/, "/questions", "/questions", ["POST"], staff),
  route(/^\/questions\/[^/]+\/test-cases$/, "/questions/:questionId/test-cases", "/questions/question-1/test-cases", ["POST"], staff),
  route(/^\/questions\/[^/]+\/hints\/generate$/, "/questions/:questionId/hints/generate", "/questions/question-1/hints/generate", ["POST"], staff, true),
  route(/^\/questions\/[^/]+\/hints\/[1-9]\d*$/, "/questions/:questionId/hints/:level", "/questions/question-1/hints/1", ["DELETE"], staff),
  route(/^\/questions\/[^/]+\/hints$/, "/questions/:questionId/hints", "/questions/question-1/hints", ["GET", "POST"], staff),
  route(/^\/questions\/[^/]+$/, "/questions/:questionId", "/questions/question-1", ["GET", "PATCH", "DELETE"], all, false, undefined, { GET: all, PATCH: staff, DELETE: staff }),
  route(/^\/question-hints\/[^/]+\/review$/, "/question-hints/:hintId/review", "/question-hints/hint-1/review", ["POST"], staff, true),
  route(/^\/rubrics$/, "/rubrics", "/rubrics", ["POST"], staff),
  route(/^\/rubrics\/[^/]+\/criteria$/, "/rubrics/:rubricId/criteria", "/rubrics/rubric-1/criteria", ["POST"], staff),
  route(/^\/rubrics\/[^/]+\/activate$/, "/rubrics/:rubricId/activate", "/rubrics/rubric-1/activate", ["POST"], staff, true),
  route(/^\/assignments$/, "/assignments", "/assignments", ["POST"], staff),
  route(/^\/assignments\/[^/]+\/questions$/, "/assignments/:assignmentId/questions", "/assignments/assignment-1/questions", ["GET", "POST", "PATCH", "DELETE"], staff),
  route(/^\/assignments\/[^/]+\/submissions$/, "/assignments/:assignmentId/submissions", "/assignments/assignment-1/submissions", ["GET", "POST"], all, false, undefined, { GET: staff, POST: ["student"] }),
  route(/^\/assignments\/[^/]+$/, "/assignments/:assignmentId", "/assignments/assignment-1", ["GET", "PATCH", "DELETE"], all, false, undefined, { GET: all, PATCH: staff, DELETE: staff }),
  route(/^\/submissions\/[^/]+\/answers\/[^/]+$/, "/submissions/:submissionId/answers/:questionId", "/submissions/submission-1/answers/question-1", ["PATCH"], ["student"]),
  route(/^\/submissions\/[^/]+\/questions\/[^/]+\/hints\/unlock$/, "/submissions/:submissionId/questions/:questionId/hints/unlock", "/submissions/submission-1/questions/question-1/hints/unlock", ["POST"], ["student"], true),
  route(/^\/submissions\/[^/]+\/questions\/[^/]+\/hints$/, "/submissions/:submissionId/questions/:questionId/hints", "/submissions/submission-1/questions/question-1/hints", ["GET"], ["student"]),
  route(/^\/submissions\/[^/]+\/submit$/, "/submissions/:submissionId/submit", "/submissions/submission-1/submit", ["POST"], ["student"], true),
  route(/^\/submissions\/[^/]+\/(grade|release-grade)$/, "/submissions/:submissionId/:command", "/submissions/submission-1/grade", ["POST"], staff, true),
  route(/^\/submissions\/[^/]+$/, "/submissions/:submissionId", "/submissions/submission-1", ["GET"], all),
  route(/^\/submission-answers\/[^/]+\/(execute|grade|snapshots)$/, "/submission-answers/:answerId/:command", "/submission-answers/answer-1/execute", ["POST"], all, true),
  route(/^\/classrooms$/, "/classrooms", "/classrooms", ["POST"], staff),
  route(/^\/classrooms\/[^/]+\/(join|heartbeat)$/, "/classrooms/:sessionId/:command", "/classrooms/session-1/join", ["POST"], all, true),
  route(/^\/classrooms\/[^/]+\/(end|activities)$/, "/classrooms/:sessionId/:command", "/classrooms/session-1/end", ["POST"], staff, true),
  route(/^\/classrooms\/[^/]+\/events$/, "/classrooms/:sessionId/events", "/classrooms/session-1/events", ["GET"], all),
  route(/^\/classrooms\/[^/]+$/, "/classrooms/:sessionId", "/classrooms/session-1", ["GET"], all),
  route(/^\/activities\/[^/]+\/transition$/, "/activities/:activityId/transition", "/activities/activity-1/transition", ["POST"], staff, true),
  route(/^\/exports$/, "/exports", "/exports", ["GET", "POST"], staff),
  route(/^\/exports\/[^/]+\/run$/, "/exports/:exportId/run", "/exports/export-1/run", ["POST"], staff, true),
  route(/^\/exports\/[^/]+\/download$/, "/exports/:exportId/download", "/exports/export-1/download", ["GET"], staff),
  route(/^\/notifications$/, "/notifications", "/notifications", ["GET"], all),
  route(/^\/notifications\/[^/]+\/read$/, "/notifications/:notificationId/read", "/notifications/notification-1/read", ["POST"], all, true),
  route(/^\/announcements$/, "/announcements", "/announcements", ["GET", "POST"], staff),
  route(/^\/announcements\/[^/]+\/preview$/, "/announcements/:announcementId/preview", "/announcements/announcement-1/preview", ["GET"], staff),
  route(/^\/announcements\/[^/]+$/, "/announcements/:announcementId", "/announcements/announcement-1", ["PATCH"], staff),
  route(/^\/announcements\/[^/]+\/publish$/, "/announcements/:announcementId/publish", "/announcements/announcement-1/publish", ["POST"], staff, true),
  route(/^\/admin\/email\/process$/, "/admin/email/process", "/admin/email/process", ["POST"], admin, true),
  route(/^\/admin\/email\/settings$/, "/admin/email/settings", "/admin/email/settings", ["GET", "PATCH"], admin),
  route(/^\/admin\/email\/[^/]+\/(retry|cancel)$/, "/admin/email/:deliveryId/:command", "/admin/email/delivery-1/retry", ["POST"], admin, true),
  route(/^\/admin\/email$/, "/admin/email", "/admin/email", ["GET"], admin),
  route(/^\/ai\/status$/, "/ai/status", "/ai/status", ["GET"], all),
  route(/^\/ai\/conversations$/, "/ai/conversations", "/ai/conversations", ["POST"], all, true),
  route(/^\/ai\/conversations\/[^/]+$/, "/ai/conversations/:conversationId", "/ai/conversations/conversation-1", ["GET"], all),
  route(/^\/ai\/request$/, "/ai/request", "/ai/request", ["POST"], all, true),
  route(/^\/ai\/artifacts$/, "/ai/artifacts", "/ai/artifacts", ["POST"], staff),
  route(/^\/ai\/artifacts\/[^/]+\/(review|publish)$/, "/ai/artifacts/:artifactId/:command", "/ai/artifacts/artifact-1/review", ["POST"], staff, true),
  route(/^\/ai\/artifacts\/[^/]+$/, "/ai/artifacts/:artifactId", "/ai/artifacts/artifact-1", ["GET"], all),
  route(/^\/admin\/ai\/providers$/, "/admin/ai/providers", "/admin/ai/providers", ["GET", "POST"], admin),
  route(/^\/admin\/ai\/providers\/[^/]+\/(activate|disable)$/, "/admin/ai/providers/:providerId/:command", "/admin/ai/providers/provider-1/activate", ["POST"], admin, true),
  route(/^\/admin\/ai\/settings$/, "/admin/ai/settings", "/admin/ai/settings", ["GET", "PATCH"], admin),
  route(/^\/admin\/ai-provider$/, "/admin/ai-provider", "/admin/ai-provider", ["POST"], admin, true),
  route(/^\/admin\/ai-settings$/, "/admin/ai-settings", "/admin/ai-settings", ["PATCH"], admin, true),
  route(/^\/analytics(?:\/(overview|question-accuracy|common-errors|ai-usage|code-history|learning-time|compare-courses))?$/, "/analytics/:report", "/analytics/overview", ["GET"], staff),
  route(/^\/admin\/audit$/, "/admin/audit", "/admin/audit", ["GET"], admin),
  route(/^\/admin\/backups\/[^/]+\/verify$/, "/admin/backups/:backupId/verify", "/admin/backups/backup-1/verify", ["POST"], admin, true),
  route(/^\/admin\/backups$/, "/admin/backups", "/admin/backups", ["GET", "POST", "PATCH"], admin),
  route(/^\/admin\/status$/, "/admin/status", "/admin/status", ["GET"], admin),
];

export function routeContractsForPath(path: string) {
  return API_ROUTE_CONTRACTS.filter((item) => item.pattern.test(path));
}
export function routeContractForPath(path: string): ApiRouteContract | null {
  const matches = routeContractsForPath(path);
  if (!matches.length) return null;
  const specificity = (item: ApiRouteContract) => item.template.split("/").filter((part) => part && !part.startsWith(":")).length;
  const highestSpecificity = Math.max(...matches.map(specificity));
  const selected = matches.filter((item) => specificity(item) === highestSpecificity);
  const methods = [...new Set(selected.flatMap((item) => item.methods))];
  const permissionsByMethod: Partial<Record<HttpMethod, ApiRole[]>> = {};
  for (const method of methods) permissionsByMethod[method] = [...new Set(selected.flatMap((item) => item.permissionsByMethod[method] ?? []))];
  return { ...selected[0], methods, roles: [...new Set(Object.values(permissionsByMethod).flat())], permissionsByMethod };
}
export const allowedMethodsForPath = (path: string) => routeContractForPath(path)?.methods ?? null;
