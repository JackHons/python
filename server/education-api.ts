import { DomainError, asDomainError } from "./errors.ts";
import type { Actor, EducationService, StudentImportRow } from "./education.ts";
import { parseStudentImportFile } from "./education.ts";

type ApiDependencies = { service: EducationService };

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { ...JSON_HEADERS, ...headers } });
}

function tokenFrom(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length).trim();
  const cookie = request.headers.get("cookie") ?? "";
  return cookie.match(/(?:^|;\s*)session=([^;]+)/)?.[1] ?? null;
}

async function body(request: Request) {
  try {
    return await request.json() as Record<string, unknown>;
  } catch {
    throw new DomainError("invalid_json", "Request body must be valid JSON", 400);
  }
}

function actorFrom(request: Request, service: EducationService): Actor & { user: unknown; sessionId: string } {
  const token = tokenFrom(request);
  if (!token) throw new DomainError("unauthorized", "Authentication required", 401);
  return service.session(token);
}

function cookie(token: string, maxAge = 8 * 60 * 60) {
  return `session=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax`;
}

function routeParts(pathname: string) {
  return pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
}

export async function handleEducationApi(request: Request, dependencies: ApiDependencies) {
  try {
    const { service } = dependencies;
    const parts = routeParts(new URL(request.url).pathname.replace(/^\/api\/education\/?/, "/"));
    const method = request.method.toUpperCase();

    if (method === "POST" && parts.join("/") === "auth/login") {
      const input = await body(request);
      const result = service.login(String(input.username ?? ""), String(input.password ?? ""));
      return json({ user: result.user }, 200, { "set-cookie": cookie(result.token) });
    }
    if (method === "POST" && parts.join("/") === "auth/logout") {
      const token = tokenFrom(request);
      if (token) service.logout(token);
      return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
    }
    if (method === "POST" && parts.join("/") === "auth/password") {
      const token = tokenFrom(request);
      if (!token) throw new DomainError("unauthorized", "Authentication required", 401);
      const input = await body(request);
      return json(service.changePassword(token, String(input.newPassword ?? "")));
    }

    const actor = actorFrom(request, service);
    if (method === "GET" && parts.length === 1 && parts[0] === "me") return json({ user: actor.user });
    if (method === "GET" && parts.length === 1 && parts[0] === "users") {
      const url = new URL(request.url);
      const role = url.searchParams.get("role") as "admin" | "teacher" | "student" | null;
      return json({ users: service.listUsers(actor, { role: role ?? undefined, includeArchived: url.searchParams.get("includeArchived") === "true" }) });
    }
    if (method === "POST" && parts.length === 3 && parts[0] === "users" && parts[2] === "reset-password") return json(service.resetPassword(actor, parts[1]));
    if (method === "DELETE" && parts.length === 2 && parts[0] === "users") return json({ user: service.archiveUser(actor, parts[1]) });
    if (method === "GET" && parts.length === 1 && parts[0] === "classes") return json({ classes: service.listClasses(actor) });
    if (method === "POST" && parts.length === 1 && parts[0] === "classes") {
      const input = await body(request);
      return json({ class: service.createClass(actor, { name: String(input.name ?? ""), academicYear: String(input.academicYear ?? ""), gradeLevel: input.gradeLevel ? String(input.gradeLevel) : undefined, teacherId: input.teacherId ? String(input.teacherId) : undefined }) }, 201);
    }
    if (method === "POST" && parts.length === 3 && parts[0] === "classes" && parts[2] === "members") {
      const input = await body(request);
      service.addClassMember(actor, parts[1], String(input.userId ?? ""));
      return json({ ok: true }, 201);
    }
    if (method === "GET" && parts.length === 3 && parts[0] === "classes" && parts[2] === "members") return json({ members: service.listClassMembers(actor, parts[1]) });
    if (method === "GET" && parts.length === 1 && parts[0] === "courses") return json({ courses: service.listCourses(actor) });
    if (method === "GET" && parts.length === 2 && parts[0] === "courses") return json({ course: service.getCourse(actor, parts[1]) });
    if (method === "POST" && parts.length === 1 && parts[0] === "courses") {
      const input = await body(request);
      return json({ course: service.createCourse(actor, { titleZh: String(input.titleZh ?? ""), titleEn: input.titleEn ? String(input.titleEn) : undefined, descriptionZh: input.descriptionZh ? String(input.descriptionZh) : undefined, descriptionEn: input.descriptionEn ? String(input.descriptionEn) : undefined, joinCode: input.joinCode ? String(input.joinCode) : undefined, teacherId: input.teacherId ? String(input.teacherId) : undefined }) }, 201);
    }
    if ((method === "PATCH" || method === "PUT") && parts.length === 2 && parts[0] === "classes") {
      const input = await body(request);
      return json({ class: service.updateClass(actor, parts[1], { name: input.name ? String(input.name) : undefined, academicYear: input.academicYear ? String(input.academicYear) : undefined, gradeLevel: input.gradeLevel ? String(input.gradeLevel) : undefined }) });
    }
    if (method === "DELETE" && parts.length === 2 && parts[0] === "classes") {
      service.archiveClass(actor, parts[1]);
      return json({ ok: true });
    }
    if ((method === "PATCH" || method === "PUT") && parts.length === 2 && parts[0] === "courses") {
      const input = await body(request);
      return json({ course: service.updateCourse(actor, parts[1], { titleZh: input.titleZh ? String(input.titleZh) : undefined, titleEn: input.titleEn ? String(input.titleEn) : undefined, descriptionZh: input.descriptionZh ? String(input.descriptionZh) : undefined, descriptionEn: input.descriptionEn ? String(input.descriptionEn) : undefined, joinCode: input.joinCode ? String(input.joinCode) : undefined, status: input.status === "draft" || input.status === "published" || input.status === "archived" ? input.status : undefined }) });
    }
    if (method === "DELETE" && parts.length === 2 && parts[0] === "courses") {
      service.archiveCourse(actor, parts[1]);
      return json({ ok: true });
    }
    if (method === "POST" && parts.length === 2 && parts[0] === "courses" && parts[1] === "join") {
      const input = await body(request);
      return json({ course: service.joinCourseByCode(actor, String(input.joinCode ?? "")) }, 201);
    }
    if (method === "POST" && parts.length === 3 && parts[0] === "courses" && parts[2] === "classes") {
      service.assignClassToCourse(actor, parts[1], (await body(request)).classId as string);
      return json({ ok: true }, 201);
    }
    if (method === "GET" && parts.length === 3 && parts[0] === "courses" && parts[2] === "classes") return json({ classes: service.listCourseClasses(actor, parts[1]) });
    if (method === "GET" && parts.length === 3 && parts[0] === "courses" && parts[2] === "units") return json({ units: service.listUnits(actor, parts[1]) });
    if (method === "POST" && parts.length === 3 && parts[0] === "courses" && parts[2] === "units") {
      const input = await body(request);
      return json({ unit: service.createUnit(actor, parts[1], { titleZh: String(input.titleZh ?? ""), titleEn: input.titleEn ? String(input.titleEn) : undefined, descriptionZh: input.descriptionZh ? String(input.descriptionZh) : undefined, descriptionEn: input.descriptionEn ? String(input.descriptionEn) : undefined, position: typeof input.position === "number" ? input.position : undefined }) }, 201);
    }
    if ((method === "PATCH" || method === "PUT") && parts.length === 2 && parts[0] === "units") {
      const input = await body(request);
      return json({ unit: service.updateUnit(actor, parts[1], { titleZh: input.titleZh ? String(input.titleZh) : undefined, titleEn: input.titleEn ? String(input.titleEn) : undefined, descriptionZh: input.descriptionZh ? String(input.descriptionZh) : undefined, descriptionEn: input.descriptionEn ? String(input.descriptionEn) : undefined, position: typeof input.position === "number" ? input.position : undefined, status: input.status === "draft" || input.status === "published" || input.status === "archived" ? input.status : undefined }) });
    }
    if (method === "DELETE" && parts.length === 2 && parts[0] === "units") {
      service.archiveUnit(actor, parts[1]);
      return json({ ok: true });
    }
    if (method === "POST" && parts.length === 2 && parts[0] === "students" && parts[1] === "import") {
      const input = await body(request);
      let rows: Array<{ row: number; value: StudentImportRow }>;
      if (Array.isArray(input.rows)) rows = input.rows.map((value, index) => ({ row: index + 1, value: value as StudentImportRow }));
      else rows = parseStudentImportFile(String(input.filename ?? "students.csv"), Buffer.from(String(input.contentBase64 ?? ""), "base64"));
      return json(service.importStudents(actor, rows, { classId: input.classId ? String(input.classId) : undefined }), 201);
    }
    throw new DomainError("not_found", "API endpoint not found", 404);
  } catch (error) {
    const domainError = asDomainError(error);
    return json({ error: { code: domainError.code, message: domainError.message } }, domainError.status);
  }
}
