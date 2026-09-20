import type { AssignmentDto, CourseDto, MaterialDto, SubmissionDto, SubmissionListDto, UnitDto } from "./api-client";

export type DeepLinkApi = {
  course(id: string): Promise<{ course: CourseDto }>;
  units(courseId: string): Promise<{ units: UnitDto[] }>;
  materials(unitId: string): Promise<{ materials: MaterialDto[] }>;
  assignments(courseId: string): Promise<{ assignments: AssignmentDto[] }>;
  assignment(id: string): Promise<{ assignment: AssignmentDto }>;
  getSubmission(id: string): Promise<{ submission: SubmissionDto }>;
  assignmentSubmissions(id: string): Promise<{ submissions: SubmissionListDto[] }>;
};

export type DeepLinkHydration = {
  kind: "student-course" | "student-unit" | "student-assignment" | "student-practice" | "teacher-course" | "teacher-materials" | "teacher-submissions";
  course?: CourseDto;
  units?: UnitDto[];
  unit?: UnitDto;
  materials?: MaterialDto[];
  assignments?: AssignmentDto[];
  assignment?: AssignmentDto;
  submission?: SubmissionDto;
  submissions?: SubmissionListDto[];
};

function item<T extends { id: string }>(rows: T[], id: string) {
  const result = rows.find((row) => row.id === id);
  if (!result) throw Object.assign(new Error("Resource not found"), { status: 404, code: "not_found" });
  return result;
}

export async function hydratePortalDeepLink(path: string, api: DeepLinkApi): Promise<DeepLinkHydration | null> {
  let match = path.match(/^\/student\/courses\/([^/]+)$/);
  if (match) {
    const [{ course }, { units }, { assignments }] = await Promise.all([api.course(match[1]), api.units(match[1]), api.assignments(match[1])]);
    return { kind: "student-course", course, units, assignments };
  }
  match = path.match(/^\/student\/courses\/([^/]+)\/units\/([^/]+)$/);
  if (match) {
    const [{ course }, { units }, { assignments }] = await Promise.all([api.course(match[1]), api.units(match[1]), api.assignments(match[1])]);
    const unit = item(units, match[2]);
    const { materials } = await api.materials(unit.id);
    return { kind: "student-unit", course, units, unit, materials, assignments };
  }
  match = path.match(/^\/student\/courses\/([^/]+)\/assignments\/([^/]+)$/);
  if (match) {
    const [{ course }, { assignment }] = await Promise.all([api.course(match[1]), api.assignment(match[2])]);
    if (assignment.course_id !== course.id) throw Object.assign(new Error("Resource not found"), { status: 404, code: "not_found" });
    return { kind: "student-assignment", course, assignment };
  }
  match = path.match(/^\/student\/practice\/([^/]+)$/);
  if (match) return { kind: "student-practice", submission: (await api.getSubmission(match[1])).submission };
  match = path.match(/^\/teacher\/courses\/([^/]+)$/);
  if (match) {
    const [{ course }, { units }, { assignments }] = await Promise.all([api.course(match[1]), api.units(match[1]), api.assignments(match[1])]);
    return { kind: "teacher-course", course, units, assignments };
  }
  match = path.match(/^\/teacher\/courses\/([^/]+)\/units\/([^/]+)\/materials$/);
  if (match) {
    const [{ course }, { units }] = await Promise.all([api.course(match[1]), api.units(match[1])]);
    const unit = item(units, match[2]);
    const { materials } = await api.materials(unit.id);
    return { kind: "teacher-materials", course, units, unit, materials };
  }
  match = path.match(/^\/teacher\/assignments\/([^/]+)\/submissions$/);
  if (match) {
    const [{ assignment }, { submissions }] = await Promise.all([api.assignment(match[1]), api.assignmentSubmissions(match[1])]);
    const { course } = await api.course(assignment.course_id);
    return { kind: "teacher-submissions", course, assignment, submissions };
  }
  return null;
}
