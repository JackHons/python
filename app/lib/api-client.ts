export type ApiErrorPayload = { error?: { code?: string; message?: string } };
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  constructor(status: number, payload: ApiErrorPayload, requestId: string | null = null) {
    super(payload.error?.message ?? "Request failed");
    this.name = "ApiError";
    this.status = status;
    this.code = payload.error?.code ?? "request_failed";
    this.requestId = requestId;
  }
}
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  let response = await fetch("/api/v1" + path, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  if (response.status === 429 && (!init.method || init.method === "GET")) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    response = await fetch("/api/v1" + path, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  }
  const payload = await response.json().catch(() => ({})) as T & ApiErrorPayload;
  if (!response.ok) throw new ApiError(response.status, payload, response.headers.get("x-request-id"));
  return payload;
}
export type SessionUser = { id: string; role: "admin" | "teacher" | "student"; username: string; mustChangePassword: boolean };
export type CourseDto = { id: string; title_zh: string; title_en: string | null; status: string; join_code?: string };
export type UnitDto = { id: string; course_id: string; title_zh: string; title_en: string | null; description_zh?: string | null; description_en?: string | null; position: number; status?: string };
export type FileAssetDto = { id: string; originalName: string; mimeType: string; byteSize: number; sha256: string | null; status: "quarantined" | "ready" | "deleted" | "pending"; purpose: "material_library" | "submission_attachment" | "other"; libraryScope: "private" | "school"; createdAt: string; deduplicated?: boolean; rootAssetId: string; previousAssetId: string | null; versionNumber: number; latestAssetId: string; updateAvailable: boolean; ownedByMe?: boolean };
export type MaterialDto = { id: string; unit_id: string; file_asset_id?: string | null; asset_binding_mode?: "reference" | "copy"; kind: string; title_zh: string; title_en: string | null; body_zh: string | null; body_en: string | null; source_url: string | null; position: number; allow_download: number; published_at: string | null; status?: string; file_name?: string | null; file_mime_type?: string | null; file_byte_size?: number | null; file_status?: string | null; file_library_scope?: "private" | "school" | null; file_version_number?: number | null; latest_file_asset_id?: string | null; update_available?: number; conversion_job_id?: string | null; conversion_kind?: string | null; conversion_status?: string | null; conversion_error_code?: string | null; conversion_page_count?: number | null };
export type MaterialConversionDto = { id: string; material_id: string; output_asset_id: string | null; kind: "ppt_to_web" | "document_preview"; status: "queued" | "running" | "succeeded" | "failed"; error_code: string | null; error_message: string | null; page_count: number | null; created_at: string; started_at: string | null; finished_at: string | null };
export type MaterialPreviewDto = { materialId: string; jobId: string; pageCount: number; pdfUrl: string; slides: Array<{ page: number; url: string }> };
export type QuestionDto = { id: string; course_id: string; unit_id: string | null; rubric_id: string | null; type: "multiple_choice" | "fill_blank" | "short_answer" | "code_fill" | "python_code" | "file_upload" | "project_upload"; title_zh: string; title_en: string | null; prompt_zh: string; prompt_en: string | null; options_json?: unknown; answer_key_json?: unknown; starter_code: string | null; required_concepts_json: unknown; max_score: number; sharing_scope: string; status: string };
export type AssignmentDto = { id: string; course_id: string; unit_id: string | null; kind: string; title_zh: string; title_en: string | null; instructions_zh?: string | null; instructions_en?: string | null; status: string; publish_at?: string | null; due_at: string | null; answer_release_at?: string | null; max_attempts: number; allow_late?: number; allow_resubmit?: number; randomize_order?: number; question_selection_count?: number | null; show_score_immediately?: number; show_test_results_immediately?: number; reminder_state?: "upcoming" | "past_due" | "closed" | "no_due"; can_start?: number };

export function sortAssignmentsByDue<T extends Pick<AssignmentDto, "id" | "due_at">>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    if (left.due_at === null && right.due_at !== null) return 1;
    if (left.due_at !== null && right.due_at === null) return -1;
    if (left.due_at !== null && right.due_at !== null) {
      const dueOrder = Date.parse(left.due_at) - Date.parse(right.due_at);
      if (dueOrder !== 0) return dueOrder;
    }
    return left.id.localeCompare(right.id);
  });
}
export type UserDto = { id: string; role: "admin" | "teacher" | "student"; username: string; student_number: string | null; chinese_name: string; english_name: string | null; email: string | null; must_change_password: number; status: string; last_login_at: string | null };
export type ClassDto = { id: string; name: string; academic_year: string; grade_level: string | null; status: string };
export type StudentDisplayDto = { id: string; chineseName: string; englishName: string | null; studentNumber: string | null };
export type SubmissionListDto = { id: string; assignment_id: string; student_id: string; student?: StudentDisplayDto; attempt_number: number; status: string; is_late: number; submitted_at: string | null; final_score: number | null; max_score: number | null; grade_status: string | null };
export type AssignmentItemDto = { assignment_id: string; question_id: string; course_id: string; position: number; score_override: number | null; title_zh?: string; title_en?: string | null; type?: QuestionDto["type"]; max_score?: number };
export type StudentQuestionDto = { id: string; type: QuestionDto["type"]; titleZh: string; titleEn: string | null; promptZh: string; promptEn: string | null; options: unknown; starterCode: string | null; maxScore: number; testCases: Array<{ id: string; label: string | null; visibility: "public"; inputJson: unknown; expectedOutput: string; comparisonMode: string; tolerance: number | null; position: number }> };
export type SubmissionAnswerDto = { id: string; questionId: string; position: number; answerText: string | null; answerJson: unknown; fileAssetId?: string | null; autoScore: number | null; aiSuggestedScore?: number | null; teacherScore?: number | null; finalScore: number | null; teacherFeedback?: string | null; reviewStatus?: string; reviewedById?: string | null; reviewedAt?: string | null; question?: StudentQuestionDto & { answerKey?: unknown; explanationZh?: string | null; explanationEn?: string | null; solutionCode?: string | null } };
export type SubmissionDto = { id: string; assignment_id: string; student_id: string; student?: StudentDisplayDto; status: string; attempt_number: number; submitted_at: string | null; scoreReleased?: boolean; testResultsReleased?: boolean; answersReleased?: boolean; totalScore?: number | null; maxScore?: number; gradeStatus?: string; answers: SubmissionAnswerDto[] };
export type ExecutionDto = { id: string; submissionAnswerId: string; status: string; stdout: string | null; stderr: string | null; exitCode: number | null; durationMs: number | null; testResults: Array<{ id: string; status: string; expectedOutput?: string; inputJson?: unknown; actualOutput?: string | null; stderr?: string | null; scoreAwarded?: number }> };
export type NotificationDto = { id: string; type: string; title: string; body: string; link_path: string | null; read_at: string | null; created_at: string };
export type AnnouncementDto = { id: string; author_id: string; course_id: string | null; class_id: string | null; title_zh: string; title_en: string | null; body_zh: string; body_en: string | null; status: "draft" | "published" | "archived"; publish_at: string | null; expires_at: string | null; recipient_count?: number };
export type AdminStatusDto = { ai: { configured: boolean }; backup: { enabled: boolean } };
export type AnalyticsDto = { snapshotAt: string; data: Record<string, unknown>; missingData: string[]; scope: { role: string; courseId: string | null } };
export type AiProviderDto = { id: string; provider_key: string; display_name: string; api_base_url: string | null; api_path: string; timeout_ms: number; default_model: string; api_key_hint: string | null; encryption_version: number; key_rotated_at: string | null; enabled: number; updated_at: string };
export type AiSettingsDto = { id: string; provider_config_id: string | null; enabled: number; assistant_mode: "hints_only" | "progressive" | "full_after_attempts"; full_answer_after_attempts: number | null; school_daily_token_limit: number | null; school_daily_request_limit: number | null; student_daily_token_limit: number | null; student_daily_request_limit: number | null; save_conversations: number; conversation_retention_days: number | null; max_hint_layers: number; timezone: string; updated_at: string | null };
export type AiStatusDto = { enabled: boolean; hintLevel: number; maxHintLevel: number };
export type QuestionHintDto = { id: string; question_id: string; level: number; content_zh: string; content_en: string | null; source: "manual" | "ai"; status: "draft" | "approved" | "rejected"; reviewed_by_id?: string | null; reviewed_at?: string | null };
export type StudentHintStateDto = { enabled: boolean; hintLevel: number; maxHintLevel: number; replay?: boolean; hints: Array<{ level: number; source: "manual" | "ai"; unlocked_at: string; content_zh: string; content_en: string | null }> };
export type AiArtifactDto = { id: string; artifact_type: string; course_id: string; student_id: string | null; material_id: string | null; question_id: string | null; submission_answer_id: string | null; status: "pending_review" | "approved" | "rejected" | "published"; reviewed_by_id: string | null; review_comment: string | null; reviewed_at: string | null; published_at: string | null; created_at: string; content?: unknown };
export type ClassroomSessionDto = { id: string; course_id: string; title: string; status: string; version: number; started_at: string | null; ended_at: string | null };
export type ClassroomStateDto = {
  session: { id: string; courseId: string; title: string; status: "active" | "ended"; version: number; startedAt?: string | null; endedAt?: string | null };
  activity: null | { id: string; assignmentId: string | null; title: string; status: "draft" | "active" | "paused" | "locked" | "reopened" | "ended"; anonymousAnswers: boolean; promptJson?: unknown };
  participants: unknown;
  progress: null | { submitted?: number; total?: number; completionRate?: number; selfStatus?: string };
  anonymousAnswers?: Array<{ anonymousId: string; questionId: string; answerText: string | null }>;
  events: Array<{ id: string; version: number; eventType?: string; event_type?: string; createdAt?: string }>;
};
export type ClassroomEventsDto = { serverVersion: number; events: ClassroomStateDto["events"] };
export type ExportReportType = "overview" | "questionAccuracy" | "commonErrors" | "aiUsage" | "codeHistory" | "learningTime" | "compareCourses";
export type ExportFormat = "xlsx" | "pdf" | "csv";
export type ExportStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ExportJobDto = {
  id: string;
  requested_by_id: string;
  report_type: ExportReportType;
  format: ExportFormat;
  scope_json: string;
  filter_json: string;
  snapshot_at: string;
  timezone: string;
  report_version: string;
  status: ExportStatus;
  correlation_id: string | null;
  expires_at: string | null;
  attempt_count: number;
  started_at: string | null;
  error_code: string | null;
  finished_at: string | null;
  sha256: string | null;
  byte_size: number | null;
  created_at: string;
  deleted_at: string | null;
};
export type EmailSettingsDto = { enabled: boolean; configured: boolean; host: string; port: number; tlsMode: "none" | "starttls" | "tls"; username: string; from: string; passwordConfigured: boolean };
export type EmailDeliveryDto = { id: string; notification_id: string; recipient_email: string; status: string; attempt_count: number; next_attempt_at: string | null; last_error_code: string | null; created_at: string; sent_at: string | null };
export type BackupDto = { id: string; trigger: string; scope: string; status: string; checksum: string | null; byte_size: number | null; created_at: string; verified_at: string | null };
export type AuditLogDto = { id: string; actor_id: string | null; action: string; entity_type: string; entity_id: string | null; result: string; metadata_json: string; request_id: string | null; created_at: string };
export const learningApi = {
  login: (username: string, password: string) => apiFetch<{ user: SessionUser }>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => apiFetch<{ ok: true }>("/auth/logout", { method: "POST", body: "{}" }),
  changePassword: (newPassword: string) => apiFetch<{ user: SessionUser }>("/auth/password", { method: "POST", body: JSON.stringify({ newPassword }) }),
  me: () => apiFetch<{ user: SessionUser }>("/me"),
  users: (role?: UserDto["role"]) => apiFetch<{ users: UserDto[] }>("/users" + (role ? "?role=" + encodeURIComponent(role) : "")),
  createUser: (body: Record<string, unknown>) => apiFetch<{ user: UserDto; initialPassword: string }>("/admin/users", { method: "POST", body: JSON.stringify(body) }),
  archiveUser: (userId: string) => apiFetch<{ user: UserDto }>("/users/" + encodeURIComponent(userId), { method: "DELETE", body: "{}" }),
  resetPassword: (userId: string) => apiFetch<{ user: UserDto; initialPassword: string }>("/users/" + encodeURIComponent(userId) + "/reset-password", { method: "POST", body: "{}" }),
  classes: () => apiFetch<{ classes: ClassDto[] }>("/classes"),
  createClass: (body: Record<string, unknown>) => apiFetch<{ class: ClassDto }>("/classes", { method: "POST", body: JSON.stringify(body) }),
  classMembers: (classId: string) => apiFetch<{ members: UserDto[] }>("/classes/" + encodeURIComponent(classId) + "/members"),
  addClassMember: (classId: string, userId: string) => apiFetch<{ ok: true }>("/classes/" + encodeURIComponent(classId) + "/members", { method: "POST", body: JSON.stringify({ userId }) }),
  assignClassToCourse: (courseId: string, classId: string) => apiFetch<{ ok: true }>("/courses/" + encodeURIComponent(courseId) + "/classes", { method: "POST", body: JSON.stringify({ classId }) }),
  courseClasses: (courseId: string) => apiFetch<{ classes: ClassDto[] }>("/courses/" + encodeURIComponent(courseId) + "/classes"),
  executionPolicy: (courseId: string) => apiFetch<{ policy: { courseId: string; allowedPackages: string[]; supportedPackages: string[] } }>("/courses/" + encodeURIComponent(courseId) + "/execution-policy"),
  updateExecutionPolicy: (courseId: string, allowedPackages: string[]) => apiFetch<{ policy: { courseId: string; allowedPackages: string[]; supportedPackages: string[] } }>("/courses/" + encodeURIComponent(courseId) + "/execution-policy", { method: "PATCH", body: JSON.stringify({ allowedPackages }) }),
  importStudents: (rows: Array<Record<string, unknown>>, classId?: string) => apiFetch<{ imported: unknown[]; errors: unknown[] }>("/students/import", { method: "POST", body: JSON.stringify({ rows, classId }) }),
  courses: () => apiFetch<{ courses: CourseDto[] }>("/courses"),
  course: (courseId: string) => apiFetch<{ course: CourseDto }>("/courses/" + encodeURIComponent(courseId)),
  createCourse: (body: Record<string, unknown>) => apiFetch<{ course: CourseDto }>("/courses", { method: "POST", body: JSON.stringify(body) }),
  updateCourse: (courseId: string, body: Record<string, unknown>) => apiFetch<{ course: CourseDto }>("/courses/" + encodeURIComponent(courseId), { method: "PATCH", body: JSON.stringify(body) }),
  archiveCourse: (courseId: string) => apiFetch<{ ok: true }>("/courses/" + encodeURIComponent(courseId), { method: "DELETE", body: "{}" }),
  joinCourse: (joinCode: string) => apiFetch<{ course: CourseDto }>("/courses/join", { method: "POST", body: JSON.stringify({ joinCode }) }),
  units: (courseId: string, signal?: AbortSignal) => apiFetch<{ units: UnitDto[] }>("/courses/" + encodeURIComponent(courseId) + "/units", { signal }),
  createUnit: (courseId: string, body: Record<string, unknown>) => apiFetch<{ unit: UnitDto }>("/courses/" + encodeURIComponent(courseId) + "/units", { method: "POST", body: JSON.stringify(body) }),
  updateUnit: (unitId: string, body: Record<string, unknown>) => apiFetch<{ unit: UnitDto }>("/units/" + encodeURIComponent(unitId), { method: "PATCH", body: JSON.stringify(body) }),
  archiveUnit: (unitId: string) => apiFetch<{ ok: true }>("/units/" + encodeURIComponent(unitId), { method: "DELETE", body: "{}" }),
  materials: (unitId: string, signal?: AbortSignal) => apiFetch<{ materials: MaterialDto[] }>("/units/" + encodeURIComponent(unitId) + "/materials", { signal }),
  createMaterial: (unitId: string, body: Record<string, unknown>) => apiFetch<{ material: MaterialDto }>("/units/" + encodeURIComponent(unitId) + "/materials", { method: "POST", body: JSON.stringify(body) }),
  updateMaterial: (materialId: string, body: Record<string, unknown>) => apiFetch<{ material: MaterialDto }>("/materials/" + encodeURIComponent(materialId), { method: "PATCH", body: JSON.stringify(body) }),
  archiveMaterial: (materialId: string) => apiFetch<{ material: MaterialDto }>("/materials/" + encodeURIComponent(materialId), { method: "DELETE", body: "{}" }),
  upgradeMaterialAsset: (materialId: string, assetId?: string) => apiFetch<{ material: MaterialDto }>("/materials/" + encodeURIComponent(materialId) + "/upgrade-asset", { method: "POST", body: JSON.stringify({ assetId }) }),
  queueMaterialConversion: (materialId: string, kind: "ppt_to_web" | "document_preview" = "ppt_to_web") => apiFetch<{ job: MaterialConversionDto }>("/materials/" + encodeURIComponent(materialId) + "/conversion", { method: "POST", body: JSON.stringify({ kind }) }),
  materialConversionStatus: (materialId: string) => apiFetch<{ job: MaterialConversionDto | null }>("/materials/" + encodeURIComponent(materialId) + "/conversion"),
  materialPreview: (materialId: string) => apiFetch<{ preview: MaterialPreviewDto }>("/materials/" + encodeURIComponent(materialId) + "/preview"),
  materialPreviewPdfUrl: (materialId: string) => "/api/v1/materials/" + encodeURIComponent(materialId) + "/preview/pdf",
  materialPreviewSlideUrl: (materialId: string, page: number) => "/api/v1/materials/" + encodeURIComponent(materialId) + "/preview/slides/" + page,
  materialDownloadUrl: (materialId: string) => "/api/v1/materials/" + encodeURIComponent(materialId) + "/download",
  assignments: (courseId: string, signal?: AbortSignal) => apiFetch<{ assignments: AssignmentDto[] }>("/courses/" + encodeURIComponent(courseId) + "/assignments", { signal }),
  createAssignment: (body: Record<string, unknown>) => apiFetch<{ assignment: AssignmentDto }>("/assignments", { method: "POST", body: JSON.stringify(body) }),
  updateAssignment: (assignmentId: string, body: Record<string, unknown>) => apiFetch<{ assignment: AssignmentDto }>("/assignments/" + encodeURIComponent(assignmentId), { method: "PATCH", body: JSON.stringify(body) }),
  archiveAssignment: (assignmentId: string) => apiFetch<{ assignment: AssignmentDto }>("/assignments/" + encodeURIComponent(assignmentId), { method: "DELETE", body: "{}" }),
  addAssignmentQuestion: (assignmentId: string, questionId: string) => apiFetch("/assignments/" + encodeURIComponent(assignmentId) + "/questions", { method: "POST", body: JSON.stringify({ questionId }) }),
  assignmentQuestions: (assignmentId: string) => apiFetch<{ items: AssignmentItemDto[]; totalScore: number }>("/assignments/" + encodeURIComponent(assignmentId) + "/questions"),
  assignmentSubmissions: (assignmentId: string, signal?: AbortSignal) => apiFetch<{ submissions: SubmissionListDto[] }>("/assignments/" + encodeURIComponent(assignmentId) + "/submissions", { signal }),
  removeAssignmentQuestion: (assignmentId: string, questionId: string) => apiFetch<{ items: AssignmentItemDto[] }>("/assignments/" + encodeURIComponent(assignmentId) + "/questions", { method: "DELETE", body: JSON.stringify({ questionId }) }),
  reorderAssignmentQuestions: (assignmentId: string, items: Array<{ questionId: string; position: number; scoreOverride?: number | null }>) => apiFetch<{ items: AssignmentItemDto[] }>("/assignments/" + encodeURIComponent(assignmentId) + "/questions", { method: "PATCH", body: JSON.stringify({ items }) }),
  questions: (courseId: string) => apiFetch<{ questions: QuestionDto[] }>("/courses/" + encodeURIComponent(courseId) + "/questions"),
  createQuestion: (body: Record<string, unknown>) => apiFetch<{ question: QuestionDto }>("/questions", { method: "POST", body: JSON.stringify(body) }),
  updateQuestion: (questionId: string, body: Record<string, unknown>) => apiFetch<{ question: QuestionDto }>("/questions/" + encodeURIComponent(questionId), { method: "PATCH", body: JSON.stringify(body) }),
  archiveQuestion: (questionId: string) => apiFetch<{ question: QuestionDto }>("/questions/" + encodeURIComponent(questionId), { method: "DELETE", body: "{}" }),
  addTestCase: (questionId: string, body: Record<string, unknown>) => apiFetch("/questions/" + encodeURIComponent(questionId) + "/test-cases", { method: "POST", body: JSON.stringify(body) }),
  createRubric: (body: Record<string, unknown>) => apiFetch<{ rubric: { id: string } }>("/rubrics", { method: "POST", body: JSON.stringify(body) }),
  addRubricCriterion: (rubricId: string, body: Record<string, unknown>) => apiFetch("/rubrics/" + encodeURIComponent(rubricId) + "/criteria", { method: "POST", body: JSON.stringify(body) }),
  activateRubric: (rubricId: string) => apiFetch("/rubrics/" + encodeURIComponent(rubricId) + "/activate", { method: "POST", body: "{}" }),
  notifications: () => apiFetch<{ notifications: NotificationDto[] }>("/notifications"),
  markNotificationRead: (notificationId: string) => apiFetch<{ notification: { id: string; read_at: string } }>("/notifications/" + encodeURIComponent(notificationId) + "/read", { method: "POST", body: "{}" }),
  announcements: () => apiFetch<{ announcements: AnnouncementDto[] }>("/announcements"),
  createAnnouncement: (body: Record<string, unknown>) => apiFetch<{ announcement: { id: string } }>("/announcements", { method: "POST", body: JSON.stringify(body) }),
  updateAnnouncement: (announcementId: string, body: Record<string, unknown>) => apiFetch<{ announcement: AnnouncementDto }>("/announcements/" + encodeURIComponent(announcementId), { method: "PATCH", body: JSON.stringify(body) }),
  previewAnnouncement: (announcementId: string) => apiFetch<{ announcement: AnnouncementDto; recipientCount: number; emailCount: number }>("/announcements/" + encodeURIComponent(announcementId) + "/preview"),
  publishAnnouncement: (announcementId: string, sendEmail: boolean) => apiFetch<{ announcement: { recipientCount: number } }>("/announcements/" + encodeURIComponent(announcementId) + "/publish", { method: "POST", body: JSON.stringify({ sendEmail }) }),
  assignment: (assignmentId: string, signal?: AbortSignal) => apiFetch<{ assignment: AssignmentDto }>("/assignments/" + encodeURIComponent(assignmentId), { signal }),
  beginSubmission: (assignmentId: string) => apiFetch<{ submission: SubmissionDto }>("/assignments/" + encodeURIComponent(assignmentId) + "/submissions", { method: "POST", body: "{}" }),
  getSubmission: (submissionId: string, signal?: AbortSignal) => apiFetch<{ submission: SubmissionDto }>("/submissions/" + encodeURIComponent(submissionId), { signal }),
  gradeSubmission: (submissionId: string, questionId: string, score: number, feedback: string) => apiFetch<{ submission: SubmissionDto }>("/submissions/" + encodeURIComponent(submissionId) + "/grade", { method: "POST", body: JSON.stringify({ questionId, score, feedback }) }),
  releaseGrade: (submissionId: string) => apiFetch<{ grade: unknown }>("/submissions/" + encodeURIComponent(submissionId) + "/release-grade", { method: "POST", body: "{}" }),
  saveAnswer: (submissionId: string, questionId: string, body: { answerText?: string; answerJson?: unknown; fileAssetId?: string | null }) => apiFetch<{ submission: SubmissionDto }>("/submissions/" + encodeURIComponent(submissionId) + "/answers/" + encodeURIComponent(questionId), { method: "PATCH", body: JSON.stringify(body) }),
  uploadFile: async (file: File, options: { purpose?: FileAssetDto["purpose"]; libraryScope?: FileAssetDto["libraryScope"]; previousAssetId?: string; mimeType?: string; onProgress?: (value: number) => void } = {}) => { options.onProgress?.(5); const bytes = new Uint8Array(await file.arrayBuffer()); options.onProgress?.(20); let binary = ""; const chunk = 0x8000; for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk)); options.onProgress?.(45); const result = await apiFetch<{ asset: FileAssetDto }>("/files", { method: "POST", body: JSON.stringify({ originalName: file.name, mimeType: options.mimeType ?? (file.type || "application/octet-stream"), contentBase64: btoa(binary), purpose: options.purpose, libraryScope: options.libraryScope, previousAssetId: options.previousAssetId }) }); options.onProgress?.(70); return result; },
  releaseFile: (assetId: string) => apiFetch<{ asset: FileAssetDto }>("/files/" + encodeURIComponent(assetId) + "/release", { method: "POST", body: "{}" }),
  availableFiles: (signal?: AbortSignal) => apiFetch<{ assets: FileAssetDto[] }>("/files?scope=available", { signal }),
  updateFileScope: (assetId: string, libraryScope: FileAssetDto["libraryScope"]) => apiFetch<{ asset: FileAssetDto }>("/files/" + encodeURIComponent(assetId), { method: "PATCH", body: JSON.stringify({ libraryScope }) }),
  deleteFile: (assetId: string) => apiFetch<{ asset: FileAssetDto }>("/files/" + encodeURIComponent(assetId), { method: "DELETE", body: "{}" }),
  fileDownloadUrl: (assetId: string) => "/api/v1/files/" + encodeURIComponent(assetId) + "/download",
  execute: (answerId: string, code: string, stdin = "") => apiFetch<{ execution: ExecutionDto }>("/submission-answers/" + encodeURIComponent(answerId) + "/execute", { method: "POST", body: JSON.stringify({ code, stdin }) }),
  grade: (answerId: string, code: string) => apiFetch<{ execution: ExecutionDto }>("/submission-answers/" + encodeURIComponent(answerId) + "/grade", { method: "POST", body: JSON.stringify({ code }) }),
  saveCodeSnapshot: (answerId: string, code: string, source: "autosave" | "paste", pastedCharacterCount = 0) => apiFetch<{ snapshot: { id: string; sequence_number: number } }>("/submission-answers/" + encodeURIComponent(answerId) + "/snapshots", { method: "POST", body: JSON.stringify({ code, source, pastedCharacterCount }) }),
  submit: (submissionId: string) => apiFetch<{ submission: SubmissionDto }>("/submissions/" + encodeURIComponent(submissionId) + "/submit", { method: "POST", body: "{}" }),
  analytics: (report = "overview", filters?: string | { courseId?: string; classId?: string; studentId?: string }) => { const values = typeof filters === "string" ? { courseId: filters } : filters ?? {}; const query = new URLSearchParams(Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString(); return apiFetch<AnalyticsDto>("/analytics/" + report + (query ? "?" + query : "")); },
  classroomSessions: (courseId: string) => apiFetch<{ sessions: ClassroomSessionDto[] }>("/courses/" + encodeURIComponent(courseId) + "/classrooms"),
  classroomState: (sessionId: string) => apiFetch<{ classroom: ClassroomStateDto }>("/classrooms/" + encodeURIComponent(sessionId)),
  joinClassroom: (sessionId: string) => apiFetch<{ classroom: ClassroomStateDto }>("/classrooms/" + encodeURIComponent(sessionId) + "/join", { method: "POST", body: "{}" }),
  heartbeatClassroom: (sessionId: string) => apiFetch<{ classroom: ClassroomStateDto }>("/classrooms/" + encodeURIComponent(sessionId) + "/heartbeat", { method: "POST", body: "{}" }),
  classroomEvents: (sessionId: string, since: number) => apiFetch<ClassroomEventsDto>("/classrooms/" + encodeURIComponent(sessionId) + "/events?since=" + encodeURIComponent(String(since))),
  createClassroom: (courseId: string, title: string) => apiFetch<{ classroom: ClassroomStateDto }>("/classrooms", { method: "POST", body: JSON.stringify({ courseId, title }) }),
  createClassroomActivity: (sessionId: string, body: Record<string, unknown>) => apiFetch<{ activity: { id: string; status: string } }>("/classrooms/" + encodeURIComponent(sessionId) + "/activities", { method: "POST", body: JSON.stringify(body) }),
  transitionClassroomActivity: (activityId: string, transition: "start" | "pause" | "lock" | "reopen" | "end") => apiFetch<{ classroom: ClassroomStateDto }>("/activities/" + encodeURIComponent(activityId) + "/transition", { method: "POST", body: JSON.stringify({ transition, idempotencyKey: crypto.randomUUID() }) }),
  endClassroom: (sessionId: string) => apiFetch<{ classroom: ClassroomStateDto }>("/classrooms/" + encodeURIComponent(sessionId) + "/end", { method: "POST", body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }) }),
  exports: () => apiFetch<{ jobs: ExportJobDto[] }>("/exports"),
  createExport: (reportType: ExportReportType, format: ExportFormat, courseId?: string) => apiFetch<{ job: ExportJobDto }>("/exports", { method: "POST", body: JSON.stringify({ reportType, format, filters: courseId ? { courseId } : {} }) }),
  runExport: (exportId: string) => apiFetch<{ job: ExportJobDto }>("/exports/" + encodeURIComponent(exportId) + "/run", { method: "POST", body: "{}" }),
  retryExport: (exportId: string) => apiFetch<{ job: ExportJobDto }>("/exports/" + encodeURIComponent(exportId) + "/retry", { method: "POST", body: "{}" }),
  exportDownloadUrl: (exportId: string) => "/api/v1/exports/" + encodeURIComponent(exportId) + "/download",
  emailSettings: () => apiFetch<{ settings: EmailSettingsDto }>("/admin/email/settings"),
  updateEmailSettings: (body: Record<string, unknown>) => apiFetch<{ settings: EmailSettingsDto }>("/admin/email/settings", { method: "PATCH", body: JSON.stringify(body) }),
  emailDeliveries: (status?: string) => apiFetch<{ deliveries: EmailDeliveryDto[] }>("/admin/email" + (status ? "?status=" + encodeURIComponent(status) : "")),
  processEmail: () => apiFetch<{ deliveries: Array<{ id: string; status: string }> }>("/admin/email/process", { method: "POST", body: "{}" }),
  retryEmail: (deliveryId: string) => apiFetch("/admin/email/" + encodeURIComponent(deliveryId) + "/retry", { method: "POST", body: "{}" }),
  cancelEmail: (deliveryId: string) => apiFetch("/admin/email/" + encodeURIComponent(deliveryId) + "/cancel", { method: "POST", body: "{}" }),
  auditLogs: (filters: { action?: string; correlationId?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (filters.action) query.set("action", filters.action);
    if (filters.correlationId) query.set("correlationId", filters.correlationId);
    if (filters.limit !== undefined) query.set("limit", String(filters.limit));
    const suffix = query.toString();
    return apiFetch<{ logs: AuditLogDto[] }>("/admin/audit" + (suffix ? "?" + suffix : ""));
  },
  backups: () => apiFetch<{ backups: BackupDto[]; settings: { enabled: boolean; retentionDays: number } }>("/admin/backups"),
  updateBackupSettings: (enabled: boolean) => apiFetch<{ settings: { enabled: boolean; retentionDays: number } }>("/admin/backups", { method: "PATCH", body: JSON.stringify({ enabled }) }),
  createBackup: (scope: "database" | "files" | "full") => apiFetch<{ backup: BackupDto }>("/admin/backups", { method: "POST", body: JSON.stringify({ trigger: "manual", scope }) }),
  verifyBackup: (backupId: string) => apiFetch<{ verification: { valid: boolean; checksum: string } }>("/admin/backups/" + encodeURIComponent(backupId) + "/verify", { method: "POST", body: "{}" }),
  aiStatus: () => apiFetch<{ status: AiStatusDto }>("/ai/status"),
  startAiConversation: (body: { courseId: string; assignmentId?: string; questionId?: string }) => apiFetch<{ conversation: { id: string; successful_hint_count?: number } }>("/ai/conversations", { method: "POST", body: JSON.stringify(body) }),
  requestAiHint: (body: { requestKey: string; purpose: "student_hint"; task: string; questionPrompt?: string; studentCode?: string; runnerFeedback?: string; conversationId?: string; estimatedTokens?: number }) => apiFetch<{ result: { status: string; content: string | null; hintLevel?: number; usage?: { inputTokens: number; outputTokens: number } } }>("/ai/request", { method: "POST", body: JSON.stringify(body) }),
  aiProviders: () => apiFetch<{ providers: AiProviderDto[] }>("/admin/ai/providers"),
  configureAiProvider: (body: { providerKey: string; displayName: string; apiBaseUrl: string; apiPath: string; timeoutMs: number; defaultModel: string; apiKey: string; enabled: boolean }) => apiFetch<{ provider: AiProviderDto }>("/admin/ai/providers", { method: "POST", body: JSON.stringify(body) }),
  activateAiProvider: (providerId: string) => apiFetch<{ provider: AiProviderDto }>("/admin/ai/providers/" + encodeURIComponent(providerId) + "/activate", { method: "POST", body: "{}" }),
  disableAiProvider: (providerId: string) => apiFetch<{ provider: AiProviderDto }>("/admin/ai/providers/" + encodeURIComponent(providerId) + "/disable", { method: "POST", body: "{}" }),
  aiSettings: () => apiFetch<{ settings: AiSettingsDto }>("/admin/ai/settings"),
  updateAiSettings: (body: Record<string, unknown>) => apiFetch<{ settings: AiSettingsDto }>("/admin/ai/settings", { method: "PATCH", body: JSON.stringify(body) }),
  questionHints: (questionId: string) => apiFetch<{ maxHintLayers: number; hints: QuestionHintDto[] }>("/questions/" + encodeURIComponent(questionId) + "/hints"),
  saveQuestionHint: (questionId: string, body: { level: number; contentZh: string; contentEn?: string; source?: "manual" | "ai" }) => apiFetch<{ hint: QuestionHintDto }>("/questions/" + encodeURIComponent(questionId) + "/hints", { method: "POST", body: JSON.stringify(body) }),
  generateQuestionHint: (questionId: string, level: number) => apiFetch<{ hint: QuestionHintDto }>("/questions/" + encodeURIComponent(questionId) + "/hints/generate", { method: "POST", body: JSON.stringify({ level, requestKey: crypto.randomUUID() }) }),
  deleteQuestionHint: (questionId: string, level: number) => apiFetch<{ removed: { id: string; questionId: string; level: number } }>("/questions/" + encodeURIComponent(questionId) + "/hints/" + level, { method: "DELETE", body: "{}" }),
  reviewQuestionHint: (hintId: string, decision: "approved" | "rejected") => apiFetch<{ hint: QuestionHintDto }>("/question-hints/" + encodeURIComponent(hintId) + "/review", { method: "POST", body: JSON.stringify({ decision }) }),
  studentHintState: (submissionId: string, questionId: string) => apiFetch<{ state: StudentHintStateDto }>("/submissions/" + encodeURIComponent(submissionId) + "/questions/" + encodeURIComponent(questionId) + "/hints"),
  unlockStudentHint: (submissionId: string, questionId: string, idempotencyKey: string) => apiFetch<{ state: StudentHintStateDto }>("/submissions/" + encodeURIComponent(submissionId) + "/questions/" + encodeURIComponent(questionId) + "/hints/unlock", { method: "POST", body: JSON.stringify({ idempotencyKey }) }),
  aiArtifacts: (courseId: string) => apiFetch<{ artifacts: AiArtifactDto[] }>("/courses/" + encodeURIComponent(courseId) + "/ai-artifacts"),
  aiArtifact: (artifactId: string) => apiFetch<{ artifact: AiArtifactDto & { content?: unknown } }>("/ai/artifacts/" + encodeURIComponent(artifactId)),
  reviewAiArtifact: (artifactId: string, decision: "approved" | "rejected", comment?: string) => apiFetch<{ artifact: AiArtifactDto }>("/ai/artifacts/" + encodeURIComponent(artifactId) + "/review", { method: "POST", body: JSON.stringify({ decision, comment }) }),
  publishAiArtifact: (artifactId: string) => apiFetch<{ artifact: AiArtifactDto }>("/ai/artifacts/" + encodeURIComponent(artifactId) + "/publish", { method: "POST", body: "{}" }),
  adminStatus: () => apiFetch<AdminStatusDto>("/admin/status"),
};
