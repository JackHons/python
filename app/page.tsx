"use client";

/* The teacher workspace deliberately hydrates server data after the selected
 * course changes; these effects are the synchronization boundary. */
/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ApiError, learningApi, sortAssignmentsByDue, type AdminStatusDto, type AiArtifactDto, type AiProviderDto, type AiSettingsDto, type AiStatusDto, type AnalyticsDto, type AnnouncementDto, type AssignmentDto, type AssignmentItemDto, type AuditLogDto, type BackupDto, type ClassDto, type ClassroomSessionDto, type ClassroomStateDto, type CourseDto, type EmailDeliveryDto, type EmailSettingsDto, type ExecutionDto, type FileAssetDto, type MaterialConversionDto, type MaterialDto, type MaterialPreviewDto, type NotificationDto, type QuestionDto, type QuestionHintDto, type SessionUser, type StudentQuestionDto, type SubmissionDto, type SubmissionListDto, type UnitDto, type UserDto } from "./lib/api-client";
import { PORTAL_ROUTES, compatiblePath, resolvePortalPath, roleHome, safeReturnTo } from "./lib/portal-routes";
import { hydratePortalDeepLink } from "./lib/deep-link-loader";
import { LatestRequestGate } from "./lib/latest-request";

type Language = "zh" | "en";
type Role = "student" | "teacher" | "admin";
type StudentView = "home" | "courses" | "notifications" | "missions" | "practice" | "resources" | "classrooms";
type StaffView = "dashboard" | "content" | "materials" | "classes" | "assessment" | "classrooms" | "analytics-ai" | "ai" | "announcements" | "email" | "ai-settings" | "admin" | "admin-users" | "admin-classes" | "admin-courses" | "admin-settings" | "admin-backups" | "admin-audit" | "admin-email";
type TestState = "idle" | "running" | "passed" | "failed" | "unconfigured";
type Translator = (zh: string, en: string) => string;
type RunResult = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  output_limited: boolean;
  error?: string;
};
type AuthState = "authenticated" | "loading" | "unauthenticated";

// Code is populated from the server-side assignment snapshot.  Keep the
// initial editor empty so an unselected assignment can never look like a
// real exercise with fabricated test results.
const starterCode = "";

const studentNav: Array<{ key: StudentView | "courses" | "resources"; zh: string; en: string }> = [
  { key: "home", zh: "首頁", en: "Home" },
  { key: "courses", zh: "課程", en: "Courses" },
  { key: "notifications", zh: "通知", en: "Notifications" },
  { key: "missions", zh: "學習任務", en: "Missions" },
  { key: "practice", zh: "練習場", en: "Practice" },
  { key: "resources", zh: "資源", en: "Resources" },
  { key: "classrooms", zh: "即時課堂", en: "Live class" },
];
const teacherNav: Array<{ key: StaffView; zh: string; en: string }> = [
  { key: "dashboard", zh: "學習分析", en: "Analytics" }, { key: "content", zh: "課程內容", en: "Content" }, { key: "materials", zh: "教材庫", en: "Materials" },
  { key: "classes", zh: "班別學生", en: "Classes" }, { key: "announcements", zh: "公告通知", en: "Announcements" }, { key: "assessment", zh: "功課批改", en: "Assessment" }, { key: "ai", zh: "AI 審核", en: "AI review" },
];

export default function Home() {
  const router = useRouter();
  const pathname = usePathname();
  const [language, setLanguage] = useState<Language>("zh");
  const [role, setRole] = useState<Role>("student");
  const [studentView, setStudentView] = useState<StudentView>("home");
  const [staffView, setStaffView] = useState<StaffView>("dashboard");
  const [code, setCode] = useState(starterCode);
  const [stdin, setStdin] = useState("");
  const [testState, setTestState] = useState<TestState>("idle");
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [hintCount, setHintCount] = useState(0);
  const [aiHint, setAiHint] = useState("");
  const [aiStatus, setAiStatus] = useState<AiStatusDto | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [authUser, setAuthUser] = useState<SessionUser | null>(null);
  const [authError, setAuthError] = useState("");
  const [courses, setCourses] = useState<CourseDto[]>([]);
  const [courseUnits, setCourseUnits] = useState<UnitDto[]>([]);
  const [resourceMaterials, setResourceMaterials] = useState<MaterialDto[]>([]);
  const [assignments, setAssignments] = useState<AssignmentDto[]>([]);
  const [notifications, setNotifications] = useState<NotificationDto[]>([]);
  const [studentClassrooms, setStudentClassrooms] = useState<ClassroomSessionDto[]>([]);
  const [teacherCourses, setTeacherCourses] = useState<CourseDto[]>([]);
  const [adminStatus, setAdminStatus] = useState<AdminStatusDto | null>(null);
  const [routePath, setRoutePath] = useState("/");
  const [routeError, setRouteError] = useState<"forbidden" | "not-found" | null>(null);
  const [activeAnswerId, setActiveAnswerId] = useState<string | null>(null);
  const [activeAnswerIndex, setActiveAnswerIndex] = useState(0);
  const [activeFileAssetId, setActiveFileAssetId] = useState<string | null>(null);
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(null);
  const [activeSubmissionId, setActiveSubmissionId] = useState<string | null>(null);
  const [activeSubmission, setActiveSubmission] = useState<SubmissionDto | null>(null);
  const [activeQuestion, setActiveQuestion] = useState<StudentQuestionDto | null>(null);
  const [activeExecution, setActiveExecution] = useState<ExecutionDto | null>(null);
  const [autosaveState, setAutosaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const deepLinkRequestRef = useRef(0);
  const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
  const L: Translator = (zh, en) => (language === "zh" ? zh : en);
  function applyRoute(userRole: Role, requestedPath?: string) {
    const current = requestedPath ?? pathname ?? "/";
    const alias = compatiblePath(current, userRole);
    const returnTo = current === "/" ? safeReturnTo(new URLSearchParams(window.location.search).get("returnTo")) : null;
    const target = returnTo ?? (alias === "/" ? roleHome(userRole) : alias);
    const route = resolvePortalPath(target);
    if (!route) {
      setRouteError("not-found");
      setRoutePath(target);
      return;
    }
    if (route.role !== userRole) {
      setRouteError("forbidden");
      setRoutePath(target);
      return;
    }
    setRouteError(null);
    setRoutePath(target);
    if (target !== current || current === "/") router.replace(target);
    if (userRole === "student") setStudentView(route.section as StudentView);
    else setStaffView(route.section as StaffView);
  }
  function navigatePath(path: string) {
    const route = resolvePortalPath(path);
    if (!route || route.role !== role) return setRouteError("forbidden");
    router.push(path);
  }
  useEffect(() => {
    if (demoMode) return;
    const loadingTimer = window.setTimeout(() => setAuthState("loading"), 0);
    learningApi.me().then(({ user }) => { setAuthError(""); setAuthUser(user); setRole(user.role); setAuthState("authenticated"); applyRoute(user.role, pathname); }).catch(() => {
      const path = window.location.pathname + window.location.search;
      if (window.location.pathname !== "/") router.replace("/?returnTo=" + encodeURIComponent(path));
      setAuthUser(null); setAuthError(""); setAuthState("unauthenticated");
    });
    return () => window.clearTimeout(loadingTimer);
  }, [demoMode]);
  useEffect(() => {
    if (authState !== "authenticated" || demoMode || role !== "student") return;
    Promise.all([learningApi.courses(), learningApi.notifications()])
      .then(async ([courseResult, notificationResult]) => {
        setCourses(courseResult.courses);
        setNotifications(notificationResult.notifications);
        const assignmentResults = await Promise.all(courseResult.courses.map((course) => learningApi.assignments(course.id)));
        setAssignments(sortAssignmentsByDue(assignmentResults.flatMap((result) => result.assignments)));
        const classroomResults = await Promise.all(courseResult.courses.map((course) => learningApi.classroomSessions(course.id)));
        setStudentClassrooms(classroomResults.flatMap((result) => result.sessions));
      })
      .catch(() => setAuthError(language === "zh" ? "資料暫時無法載入，請重試。" : "Data could not be loaded. Please retry."));
  }, [authState, demoMode, role, language]);

  function hydrateSubmission(submission: SubmissionDto) {
    const answer = submission.answers[0];
    setActiveSubmissionId(submission.id); setActiveSubmission(submission); setActiveAnswerIndex(0);
    setActiveAnswerId(answer?.id ?? null); setActiveQuestionId(answer?.questionId ?? null); setActiveQuestion(answer?.question ?? null);
    setCode(answer?.answerText ?? answer?.question?.starterCode ?? ""); setActiveFileAssetId(answer?.fileAssetId ?? null);
    setActiveExecution(null); setTestState("idle"); setRunResult(null); setStdin("");
  }

  useEffect(() => {
    if (authState !== "authenticated" || demoMode) return;
    const requestNumber = ++deepLinkRequestRef.current;
    let cancelled = false;
    void hydratePortalDeepLink(routePath, learningApi).then((result) => {
      if (cancelled || requestNumber !== deepLinkRequestRef.current || !result) return;
      if (result.course) {
        const setter = role === "student" ? setCourses : setTeacherCourses;
        setter((current) => current.some((course) => course.id === result.course!.id) ? current.map((course) => course.id === result.course!.id ? result.course! : course) : [result.course!, ...current]);
      }
      if (result.units) setCourseUnits(result.units);
      if (result.materials) setResourceMaterials(result.materials);
      if (result.assignments) setAssignments(sortAssignmentsByDue(result.assignments));
      if (result.assignment) setAssignments((current) => current.some((item) => item.id === result.assignment!.id) ? current.map((item) => item.id === result.assignment!.id ? result.assignment! : item) : [result.assignment!, ...current]);
      if (result.submission) hydrateSubmission(result.submission);
      setRouteError(null);
    }).catch((caught: unknown) => {
      if (cancelled || requestNumber !== deepLinkRequestRef.current) return;
      setRouteError(caught instanceof ApiError && caught.status === 403 ? "forbidden" : "not-found");
    });
    return () => { cancelled = true; };
  }, [authState, demoMode, role, routePath]);
  useEffect(() => { if (authState === "authenticated") applyRoute(role, pathname); }, [authState, pathname, role]);
  useEffect(() => {
    if (authState !== "authenticated" || role !== "student" || !activeAnswerId || !code) return;
    setAutosaveState("saving");
    const timer = window.setTimeout(() => {
      learningApi.saveCodeSnapshot(activeAnswerId, code, "autosave").then(() => setAutosaveState("saved")).catch(() => setAutosaveState("error"));
    }, 900);
    return () => window.clearTimeout(timer);
  }, [activeAnswerId, authState, code, role]);
  useEffect(() => {
    if (authState !== "authenticated" || demoMode || role !== "student" || !["courses", "resources"].includes(studentView)) return;
    let cancelled = false;
    Promise.all(courses.map((course) => learningApi.units(course.id)))
      .then(async (results) => {
        if (cancelled) return;
        const units = results.flatMap((result) => result.units);
        setCourseUnits(units);
        const materialResults = await Promise.all(units.map((unit) => learningApi.materials(unit.id)));
        if (!cancelled) setResourceMaterials(materialResults.flatMap((result) => result.materials));
      })
      .catch(() => { if (!cancelled) setAuthError(language === "zh" ? "課程資料暫時無法載入，請重試。" : "Course data could not be loaded. Please retry."); })
    return () => { cancelled = true; };
  }, [authState, courses, demoMode, language, role, studentView]);
  useEffect(() => {
    if (authState !== "authenticated" || demoMode) return;
    if (role === "teacher") learningApi.courses().then(({ courses: result }) => { setTeacherCourses(result); }).catch(() => setAuthError(language === "zh" ? "教師資料暫時無法載入。" : "Teacher data could not be loaded."));
    if (role === "admin") learningApi.adminStatus().then((status) => setAdminStatus(status)).catch(() => setAuthError(language === "zh" ? "管理員狀態暫時無法載入。" : "Admin status could not be loaded."));
  }, [authState, demoMode, role, language]);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }

  async function logout() {
    await learningApi.logout().catch(() => undefined);
    setAuthUser(null);
    setAuthState("unauthenticated");
  }

  async function runCode() {
    setTestState("running");
    setRunResult(null);
    try {
      if (!activeAnswerId) throw new Error(L("請先從功課開始作答。", "Start an assignment before running code."));
      const result = await learningApi.execute(activeAnswerId, code, stdin);
      const payload = result.execution;
      setActiveExecution(payload);
      setRunResult({ stdout: payload.stdout ?? "", stderr: payload.stderr ?? "", exit_code: payload.exitCode, timed_out: payload.status === "timeout", output_limited: false });
      // Plain execution is not grading. Only the grade endpoint returns test
      // results that may be rendered as passed/failed; never infer a full pass
      // from exit_code=0 when the snapshot cases were not evaluated.
      if (payload.testResults.length === 0) setTestState("unconfigured");
      else setTestState(payload.testResults.every((result) => result.status === "passed") ? "passed" : "failed");
    } catch (caught) {
      setRunResult({
        stdout: "",
        stderr: "",
        exit_code: null,
        timed_out: false,
        output_limited: false,
        error: caught instanceof Error ? caught.message : L("無法連接 Python 執行服務", "Unable to reach the Python runner"),
      });
      setTestState("failed");
    }
  }
  async function startAssignment(assignmentId: string) {
    try {
      const result = await learningApi.beginSubmission(assignmentId);
      hydrateSubmission(result.submission);
      setAiHint("");
      const path = "/student/practice/" + encodeURIComponent(result.submission.id);
      router.push(path);
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : L("無法開始功課", "Unable to start assignment"));
    }
  }
  function selectSubmissionAnswer(index: number) {
    const answer = activeSubmission?.answers[index];
    if (!answer) return;
    setActiveAnswerIndex(index);
    setActiveAnswerId(answer.id);
    setActiveQuestionId(answer.questionId);
    setActiveQuestion(answer.question ?? null);
    setCode(answer.question?.type === "python_code" || answer.question?.type === "code_fill" ? answer.answerText ?? answer.question.starterCode ?? "" : answer.answerText ?? (typeof answer.answerJson === "string" ? answer.answerJson : answer.answerJson ? JSON.stringify(answer.answerJson) : ""));
    setActiveExecution(null);
    setActiveFileAssetId(answer.fileAssetId ?? null);
    setTestState("idle");
    setRunResult(null);
  }
  async function saveWork() {
    if (!activeAnswerId) return showToast(L("請先開始功課。", "Start an assignment first."));
    if (!activeQuestionId) return showToast(L("找不到題目。", "Question is unavailable."));
    await learningApi.saveAnswer(activeSubmissionId ?? "", activeQuestionId, { answerText: code, answerJson: activeQuestion?.type === "multiple_choice" ? { value: code } : undefined, fileAssetId: activeFileAssetId }).then((result) => { setActiveSubmission(result.submission); showToast(L("已保存到伺服器", "Saved to server")); }).catch((caught) => showToast(caught instanceof Error ? caught.message : L("保存失敗", "Save failed")));
  }
  async function submitWork() {
    if (!activeSubmissionId) return showToast(L("請先開始功課。", "Start an assignment first."));
    try {
      if (activeQuestionId) await learningApi.saveAnswer(activeSubmissionId, activeQuestionId, { answerText: code, answerJson: activeQuestion?.type === "multiple_choice" ? { value: code } : undefined, fileAssetId: activeFileAssetId });
      for (const answer of activeSubmission?.answers ?? []) {
        if (!["code_fill", "python_code"].includes(answer.question?.type ?? "")) continue;
        const answerCode = answer.id === activeAnswerId ? code : answer.answerText ?? answer.question?.starterCode ?? "";
        if (!answerCode.trim()) continue;
        const result = await learningApi.grade(answer.id, answerCode);
        if (answer.id === activeAnswerId) {
          setActiveExecution(result.execution);
          setRunResult({ stdout: result.execution.stdout ?? "", stderr: result.execution.stderr ?? "", exit_code: result.execution.exitCode, timed_out: result.execution.status === "timeout", output_limited: false });
          setTestState(result.execution.testResults.length === 0 ? "unconfigured" : result.execution.testResults.every((item) => item.status === "passed") ? "passed" : "failed");
        }
      }
      const result = await learningApi.submit(activeSubmissionId);
      setActiveSubmission(result.submission);
      showToast(L("已提交功課並保存評分結果", "Assignment submitted with grading result"));
    } catch (caught) { showToast(caught instanceof Error ? caught.message : L("提交失敗", "Submission failed")); }
  }

  async function joinCourse(joinCode: string) {
    try {
      const result = await learningApi.joinCourse(joinCode);
      setCourses((current) => current.some((course) => course.id === result.course.id) ? current : [result.course, ...current]);
      router.push("/student/courses/" + encodeURIComponent(result.course.id));
      showToast(L("已加入課程", "Course joined"));
    } catch (caught) { showToast(caught instanceof Error ? caught.message : L("加入課程失敗", "Unable to join course")); }
  }
  async function uploadAnswerFile(file: File) {
    try { const uploaded = await learningApi.uploadFile(file); await learningApi.releaseFile(uploaded.asset.id); setActiveFileAssetId(uploaded.asset.id); showToast(L("檔案已安全上傳並準備提交", "File uploaded and released for submission")); }
    catch (caught) { showToast(caught instanceof Error ? caught.message : L("檔案上傳失敗", "File upload failed")); }
  }
  async function requestAiHint() {
    if (!activeSubmissionId || !activeQuestion) return showToast(L("請先開始功課。", "Start an assignment first."));
    setAiBusy(true);
    try {
      const state = (await learningApi.unlockStudentHint(activeSubmissionId, activeQuestion.id, crypto.randomUUID())).state;
      setHintCount(state.hintLevel);
      setAiStatus({ enabled: state.enabled, hintLevel: state.hintLevel, maxHintLevel: state.maxHintLevel });
      const latest = state.hints.at(-1);
      setAiHint(latest ? languageText(latest.content_zh, latest.content_en, L) : L("尚未有可用提示。", "No hint is available yet."));
    } catch (caught) { setAiHint(caught instanceof Error ? caught.message : L("思路提示暫時不可用。", "Hints are temporarily unavailable.")); }
    finally { setAiBusy(false); }
  }

  useEffect(() => {
    if (!activeSubmissionId || !activeQuestionId || role !== "student") return;
    learningApi.studentHintState(activeSubmissionId, activeQuestionId).then(({ state }) => {
      setHintCount(state.hintLevel);
      setAiStatus({ enabled: state.enabled, hintLevel: state.hintLevel, maxHintLevel: state.maxHintLevel });
      const latest = state.hints.at(-1);
      setAiHint(latest ? (language === "zh" ? latest.content_zh : latest.content_en || latest.content_zh) : "");
    }).catch(() => { setHintCount(0); setAiStatus(null); setAiHint(""); });
  }, [activeSubmissionId, activeQuestionId, language, role]);

  if (authState === "unauthenticated" && !demoMode) {
    return <LoginGate L={L} error={authError} onAuthenticated={(user) => { setAuthUser(user); setRole(user.role); setAuthState("authenticated"); applyRoute(user.role); }} />;
  }
  if (authState === "loading" && !demoMode) {
    return <div className="site-frame"><main className="page-main"><section className="empty-state"><h1>{L("正在驗證登入狀態…", "Checking your session…")}</h1></section></main></div>;
  }
  return (
    <div className="site-frame">
      <TopNavigation
        L={L}
        language={language}
        setLanguage={setLanguage}
        role={role}
        setRole={setRole}
        studentView={studentView}
        staffView={staffView}
        showToast={showToast}
        user={authUser}
        logout={logout}
        navigatePath={navigatePath}
      />

      <div className="portal-layout">
      <RoleSidebar L={L} role={role} routePath={routePath} />
      <main className={studentView === "practice" && role === "student" ? "page-main practice-page-main" : "page-main"}>
        {routeError && <RouteAccessError L={L} kind={routeError} home={() => navigatePath(roleHome(role))} />}
        {!routeError && <>
        {role === "student" && studentView === "home" && (
          <StudentHome L={L} navigatePath={navigatePath} courses={courses} assignments={assignments} classrooms={studentClassrooms} notifications={notifications} startAssignment={startAssignment} onNotificationRead={(id) => void learningApi.markNotificationRead(id).then(() => setNotifications((current) => current.map((item) => item.id === id ? { ...item, read_at: new Date().toISOString() } : item))).catch(() => showToast(L("通知暫時無法標記為已讀", "Unable to mark notification as read")))} />
        )}
        {role === "student" && studentView === "courses" && <StudentCourses L={L} courses={courses} units={courseUnits} materials={resourceMaterials} assignments={assignments} routePath={routePath} navigatePath={navigatePath} joinCourse={joinCourse} />}
        {role === "student" && studentView === "notifications" && <StudentNotifications L={L} notifications={notifications} onNotificationRead={(id) => void learningApi.markNotificationRead(id).then(() => setNotifications((current) => current.map((item) => item.id === id ? { ...item, read_at: new Date().toISOString() } : item))).catch(() => showToast(L("通知暫時無法標記為已讀", "Unable to mark notification as read")))} />}
        {role === "student" && studentView === "missions" && (
          <MissionCentre L={L} assignments={assignments} courses={courses} routePath={routePath} navigatePath={navigatePath} startAssignment={startAssignment} />
        )}
        {role === "student" && studentView === "practice" && (
            <PracticeWorkspace
            L={L}
            code={code}
            setCode={setCode}
            testState={testState}
            runResult={runResult}
            runCode={runCode}
            stdin={stdin}
            setStdin={setStdin}
            answers={activeSubmission?.answers ?? []}
            answerIndex={activeAnswerIndex}
            selectAnswer={selectSubmissionAnswer}
            uploadAnswerFile={uploadAnswerFile}
            question={activeQuestion}
            submission={activeSubmission}
            execution={activeExecution}
            hintCount={hintCount}
            aiHint={aiHint}
            aiStatus={aiStatus}
            aiBusy={aiBusy}
            requestAiHint={requestAiHint}
            saveWork={saveWork}
            submitWork={submitWork}
            autosaveState={autosaveState}
            recordPaste={(count) => { if (activeAnswerId) void learningApi.saveCodeSnapshot(activeAnswerId, code, "paste", count).catch(() => setAutosaveState("error")); }}
          />
        )}
        {role === "student" && studentView === "resources" && <StudentResources L={L} courses={courses} units={courseUnits} materials={resourceMaterials} />}
        {role === "student" && studentView === "classrooms" && <StudentClassroomHub L={L} sessions={studentClassrooms} routePath={routePath} navigatePath={navigatePath} />}
        {role === "teacher" && staffView === "dashboard" && <TeacherAnalyticsDashboard L={L} courses={teacherCourses} />}
        {role === "teacher" && staffView === "content" && <><TeacherWorkspace L={L} showToast={showToast} courses={teacherCourses} onCoursesChanged={setTeacherCourses} initialCourseId={routePath.match(/^\/teacher\/courses\/([^/]+)$/)?.[1]} /><TeacherContentEditor L={L} showToast={showToast} courses={teacherCourses} initialCourseId={routePath.match(/^\/teacher\/courses\/([^/]+)$/)?.[1]} /></>}
        {role === "teacher" && staffView === "materials" && <TeacherMaterialsHub L={L} courses={teacherCourses} initialCourseId={routePath.match(/^\/teacher\/courses\/([^/]+)\/units\/([^/]+)\/materials$/)?.[1]} initialUnitId={routePath.match(/^\/teacher\/courses\/([^/]+)\/units\/([^/]+)\/materials$/)?.[2]} />}
        {role === "teacher" && staffView === "classes" && <TeacherClassManager L={L} courses={teacherCourses} showToast={showToast} />}
        {role === "teacher" && staffView === "announcements" && <TeacherAnnouncements L={L} courses={teacherCourses} showToast={showToast} />}
        {role === "teacher" && staffView === "assessment" && <><TeacherAssignmentPolicy L={L} courses={teacherCourses} showToast={showToast} /><TeacherPackagePolicy L={L} courses={teacherCourses} showToast={showToast} /><TeacherGradingDesk L={L} courses={teacherCourses} showToast={showToast} initialAssignmentId={routePath.match(/^\/teacher\/assignments\/([^/]+)\/submissions$/)?.[1]} /></>}
        {role === "teacher" && staffView === "classrooms" && <TeacherLiveClass L={L} courses={teacherCourses} routePath={routePath} navigatePath={navigatePath} showToast={showToast} />}
        {role === "teacher" && staffView === "analytics-ai" && <TeacherAnalyticsDashboard L={L} courses={teacherCourses} initialReport="ai-usage" />}
        {role === "teacher" && staffView === "ai" && <><TeacherAiReviewQueue L={L} courses={teacherCourses} showToast={showToast} /><TeacherHintManager L={L} courses={teacherCourses} showToast={showToast} /></>}
        {role === "admin" && staffView === "ai-settings" && <AdminAiCentre L={L} showToast={showToast} />}
        {role === "admin" && staffView === "admin-backups" && <AdminBackupCentre L={L} showToast={showToast} onEnabledChange={(enabled) => setAdminStatus((current) => current ? { ...current, backup: { ...current.backup, enabled } } : current)} />}
        {role === "admin" && staffView === "admin-audit" && <AdminAuditCentre L={L} />}
        {role === "admin" && staffView === "admin-email" && <AdminEmailOps L={L} showToast={showToast} />}
        {role === "admin" && !["ai-settings", "admin-backups", "admin-audit", "admin-email"].includes(staffView) && <AdminCentre L={L} showToast={showToast} status={adminStatus} />}
        </>}
      </main>
      </div>

      {toast && <div className="toast" role="status">✓ {toast}</div>}
    </div>
  );
}

function LoginGate({ L, error, onAuthenticated }: { L: Translator; error: string; onAuthenticated: (user: SessionUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [mustChange, setMustChange] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(error);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      if (!mustChange) {
        const result = await learningApi.login(username, password);
        if (result.user.mustChangePassword) { setMustChange(true); return; }
        onAuthenticated(result.user);
      } else {
        const result = await learningApi.changePassword(newPassword);
        onAuthenticated(result.user);
      }
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : L("登入失敗", "Login failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="site-frame">
      <main className="page-main">
        <section className="login-screen">
          <div className="login-intro">
            <span className="grade-tag">{L("初三至高中 · 校本編程", "FORM 3–6 · SCHOOL CODING")}</span>
            <div className="login-brand-lockup"><span className="brand-symbol" aria-hidden="true">&lt;/&gt;</span><span><strong>{L("智學 Python", "Smart Python")}</strong><small>{L("校本編程學習平台", "School coding learning platform")}</small></span></div>
            <h1>{L("學會思考，\n寫出未來。", "Think in code.\nBuild the future.")}</h1>
            <p>{L("由課堂示範到瀏覽器練習，逐步建立 Python 思維、解難能力和作品。", "From classroom demonstrations to browser-based practice, build Python thinking, problem-solving skills, and real projects step by step.")}</p>
            <div className="login-features"><span><i className="benefit-icon amber">⌁</i><b>{L("逐步引導", "Guided learning")}</b><small>{L("清晰教材與練習", "Clear lessons and practice")}</small></span><span><i className="benefit-icon teal">▥</i><b>{L("即時回饋", "Instant feedback")}</b><small>{L("安全執行與自動批改", "Safe runs and grading")}</small></span></div>
          </div>
          <section className="empty-state login-card">
            <div className="login-card-header"><span className="prototype-chip">{mustChange ? L("首次登入", "FIRST LOGIN") : L("校內帳戶", "SCHOOL ACCOUNT")}</span><span className="login-card-mark">↗</span></div>
            <h2>{mustChange ? L("請設定你的新密碼", "Set your new password") : L("登入你的學習空間", "Sign in to your learning space")}</h2>
            <p>{mustChange ? L("首次登入需要先修改由教師或管理員提供的初始密碼。", "For security, change the initial password issued by your teacher or administrator.") : L("帳戶由教師或管理員提供。學生、教師及管理員會看到各自的工作區。", "Accounts are issued by a teacher or administrator. Students, teachers, and administrators see their own workspace.")}</p>
            {message && <p role="alert" className="form-error">{message}</p>}
            <form className="login-form" onSubmit={submit}>
              {!mustChange && <><label>{L("帳戶", "Username")}<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></label><label>{L("密碼", "Password")}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label></>}
              {mustChange && <label>{L("新密碼", "New password")}<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={10} required /></label>}
              <button type="submit" disabled={busy}>{busy ? L("處理中…", "Working…") : mustChange ? L("儲存新密碼", "Save password") : L("登入平台", "Sign in")}</button>
            </form>
            <small className="login-card-note">{L("需要協助？請聯絡任課教師或校內管理員。", "Need help? Contact your teacher or school administrator.")}</small>
          </section>
        </section>
      </main>
    </div>
  );
}

function RouteAccessError({ L, kind, home }: { L: Translator; kind: "forbidden" | "not-found"; home: () => void }) {
  return <section className="empty-state route-error" role="alert"><span className="grade-tag">{kind === "forbidden" ? "403" : "404"}</span><h1>{kind === "forbidden" ? L("你沒有權限進入此工作區", "You do not have access to this workspace") : L("找不到此頁或內容已封存", "This page was not found or has been archived")}</h1><p>{L("角色與資料範圍會由伺服器再次驗證。", "Role and data scope are checked again by the server.")}</p><button type="button" onClick={home}>{L("返回我的首頁", "Return to my dashboard")}</button></section>;
}

function RoleSidebar({ L, role, routePath }: { L: Translator; role: Role; routePath: string }) {
  const routes = PORTAL_ROUTES.filter((item) => item.role === role);
  return <aside className="role-sidebar" aria-label={L("工作區導覽", "Workspace navigation")}><strong>{role === "student" ? L("學生中心", "Student centre") : role === "teacher" ? L("教師工作台", "Teacher workspace") : L("管理員控制台", "Admin console")}</strong><nav>{routes.map((route) => <Link key={route.path} href={route.path} className={routePath === route.path || (route.path !== roleHome(role) && routePath.startsWith(route.path + "/")) ? "active" : ""}>{L(route.labelZh, route.labelEn)}</Link>)}</nav></aside>;
}

function TopNavigation({
  L,
  language,
  setLanguage,
  role,
  setRole,
  studentView,
  staffView,
  showToast,
  user,
  logout,
  navigatePath,
}: {
  L: Translator;
  language: Language;
  setLanguage: (language: Language) => void;
  role: Role;
  setRole: (role: Role) => void;
  studentView: StudentView;
  staffView: StaffView;
  showToast: (message: string) => void;
  user: SessionUser | null;
  logout: () => Promise<void>;
  navigatePath: (path: string) => void;
}) {
  const studentPath: Record<StudentView, string> = { home: "/student/dashboard", courses: "/student/courses", notifications: "/student/notifications", missions: "/student/dashboard", practice: "/student/courses", resources: "/student/courses", classrooms: "/student/classrooms" };
  const teacherPath: Partial<Record<StaffView, string>> = { dashboard: "/teacher/dashboard", content: "/teacher/courses", materials: "/teacher/courses", classes: "/teacher/classes", announcements: "/teacher/announcements", assessment: "/teacher/courses", ai: "/teacher/ai-review" };

  return (
    <header className="site-header">
      <div className="brand">
        <span className="brand-symbol" aria-hidden="true">&lt;/&gt;</span>
        <span>
          <strong>{L("智學 Python", "Smart Python")}</strong>
          <small>{L("聖若瑟教區中學第五校", "Colégio Diocesano de São José (5ª)")}</small>
        </span>
      </div>

      <nav className="top-navigation" aria-label={L("主要導覽", "Main navigation")}>
        {role === "student" && studentNav.map((item) => (
          <Link
            key={item.key}
            href={studentPath[item.key]}
            className={role === "student" && studentView === item.key ? "top-nav-item active" : "top-nav-item"}
          >
            {L(item.zh, item.en)}
          </Link>
        ))}
        {role === "teacher" && teacherNav.map((item) => <Link key={item.key} href={teacherPath[item.key] ?? "/teacher/dashboard"} className={staffView === item.key ? "top-nav-item active" : "top-nav-item"}>{L(item.zh, item.en)}</Link>)}
        {role === "admin" && <Link className="top-nav-item active" href="/admin/dashboard">{L("管理中心", "Admin centre")}</Link>}
      </nav>

      <div className="header-actions">
        <span className="streak-pill" title={L("連續學習", "Learning streak")}>🔥 <strong>6</strong></span>
        <div className="language-switch" aria-label={L("語言", "Language")}>
          <button type="button" className={language === "zh" ? "selected" : ""} onClick={() => setLanguage("zh")}>中</button>
          <button type="button" className={language === "en" ? "selected" : ""} onClick={() => setLanguage("en")}>EN</button>
        </div>
        {process.env.NEXT_PUBLIC_DEMO_MODE === "true" && <div className="role-switch" aria-label={L("預覽角色", "Preview role")}>
          {(["student", "teacher", "admin"] as Role[]).map((item) => (
            <button
              type="button"
              key={item}
              className={role === item ? "selected" : ""}
              onClick={() => setRole(item)}
            >
              {item === "student" ? L("學生", "Student") : item === "teacher" ? L("教師", "Teacher") : L("管理", "Admin")}
            </button>
          ))}
        </div>}
        <button type="button" className="start-button" onClick={() => { if (role === "student") navigatePath("/student/courses"); else showToast(L("請使用你的角色工作區。", "Use your assigned role workspace.")); }}>
          {L("開始", "Start")} <span aria-hidden="true">→</span>
        </button>
        {user && <button type="button" className="text-button" onClick={() => { void logout(); }}>{L("登出", "Sign out")}</button>}
      </div>
    </header>
  );
}

function assignmentReminderLabel(assignment: AssignmentDto, L: Translator) {
  if (assignment.reminder_state === "closed") return L("已關閉", "Closed");
  if (assignment.reminder_state === "past_due") return assignment.can_start ? L("已逾期，可補交", "Past due · late submission allowed") : L("已逾期", "Past due");
  if (assignment.reminder_state === "no_due") return L("無截止日期", "No due date");
  return assignment.due_at ? `${L("截止", "Due")}: ${new Date(assignment.due_at).toLocaleString()}` : L("可開始", "Ready");
}

function StudentHome({
  L,
  navigatePath,
  courses,
  assignments,
  classrooms,
  notifications,
  startAssignment,
  onNotificationRead,
}: {
  L: Translator;
  navigatePath: (path: string) => void;
  courses: CourseDto[];
  assignments: AssignmentDto[];
  classrooms: ClassroomSessionDto[];
  notifications: NotificationDto[];
  startAssignment: (assignmentId: string) => Promise<void>;
  onNotificationRead: (notificationId: string) => void;
}) {
  const actionableAssignment = assignments.find((assignment) => assignment.can_start !== 0);
  const upcomingReminders = assignments.filter((assignment) => assignment.reminder_state === "upcoming").slice(0, 2);
  const inactiveReminder = assignments.find((assignment) => assignment.reminder_state === "past_due" || assignment.reminder_state === "closed");
  return (
    <>
      <section className="hero-section">
        <div className="hero-copy">
          <span className="grade-tag">{L("初三至高中 · 校本編程", "FORM 3–6 · SCHOOL CODING")}</span>
          <h1>
            {L("學會思考，", "Think in code.")}
            <br />
            <span>{L("寫出未來。", "Build the future.")}</span>
          </h1>
          <p>
            {L(
              "跟着課堂一步步掌握 Python，從第一行程式開始，完成練習、挑戰與自己的作品。",
              "Learn Python step by step in class, then turn each lesson into challenges and projects of your own.",
            )}
          </p>
          <div className="hero-actions">
            <button type="button" className="primary-action" onClick={() => actionableAssignment ? void startAssignment(actionableAssignment.id) : navigatePath("/student/courses")}>
              {L("繼續編程", "Continue coding")} <span>→</span>
            </button>
            <button type="button" className="secondary-action" onClick={() => navigatePath("/student/courses")}>
              {L("查看學習任務", "View missions")}
            </button>
          </div>
          <div className="hero-benefits">
            <span><i className="benefit-icon amber">⌁</i><b>{L("逐步引導", "Guided")}</b><small>{L("由概念到實作", "Concept to practice")}</small></span>
            <span><i className="benefit-icon coral">↗</i><b>{L("任務學習", "Mission based")}</b><small>{L("完成真實挑戰", "Solve real challenges")}</small></span>
            <span><i className="benefit-icon teal">▥</i><b>{L("追蹤進度", "Track progress")}</b><small>{L("看見每次成長", "See every step")}</small></span>
          </div>
        </div>
        <CodePreview L={L} />
      </section>

      <section className="overview-grid" aria-label={L("學習概況", "Learning overview")}>
        <DashboardCard eyebrow={L("來自伺服器", "FROM SERVER")} action={courses.length ? L("已同步", "Synced") : L("暫無課程", "No courses")}>
          <div className="progress-header"><strong>{courses.length} {L("個課程", "courses")}</strong><span>{assignments.length} {L("份功課", "assignments")}</span></div>
          <p>{notifications.filter((item) => !item.read_at).length} {L("則未讀通知", "unread notifications")}</p>
          {actionableAssignment && <button type="button" onClick={() => void startAssignment(actionableAssignment.id)}>{L("開始最近功課", "Start nearest assignment")}</button>}
        </DashboardCard>
        <DashboardCard eyebrow={L("最近功課", "RECENT ASSIGNMENTS")} action={assignments.length ? L("已同步", "Synced") : L("暫無功課", "No assignments")}>
          {assignments.length ? assignments.slice(0, 3).map((assignment) => <button type="button" className="data-row-button" key={assignment.id} disabled={assignment.can_start === 0} onClick={() => void startAssignment(assignment.id)}><b>{languageText(assignment.title_zh, assignment.title_en, L)}</b><small>{assignmentReminderLabel(assignment, L)}</small></button>) : <p className="empty-copy">{L("教師尚未發布功課。", "No assignment has been published yet.")}</p>}
        </DashboardCard>
        <DashboardCard eyebrow={L("通知", "NOTIFICATIONS")} action={notifications.length ? `${notifications.length}` : L("暫無", "None")}>
          {notifications.length ? notifications.slice(0, 3).map((notification) => <div className="data-row" key={notification.id}><b>{notification.title}</b><small>{notification.body}</small>{!notification.read_at && <button type="button" className="text-button" onClick={() => onNotificationRead(notification.id)}>{L("標記已讀", "Mark read")}</button>}</div>) : <p className="empty-copy">{L("目前沒有新通知。", "There are no new notifications.")}</p>}
        </DashboardCard>
        <DashboardCard eyebrow={L("今日／近期課堂", "TODAY / RECENT CLASSES")} action={classrooms.length ? `${classrooms.length}` : L("暫無", "None")}>
          {classrooms.length ? classrooms.slice(0, 3).map((classroom) => <div className="data-row" key={classroom.id}><b>{classroom.title}</b><small>{classroom.status} · {classroom.started_at ? new Date(classroom.started_at).toLocaleString() : L("尚未開始", "Not started")}</small></div>) : <p className="empty-copy">{L("目前沒有近期即時課堂。", "There are no recent live classes.")}</p>}
          {upcomingReminders.map((assignment) => <button type="button" className="data-row-button" key={`due-${assignment.id}`} onClick={() => void startAssignment(assignment.id)}><b>{assignment.kind === "exam" ? L("考核提醒", "Assessment reminder") : L("功課提醒", "Assignment reminder")}</b><small>{languageText(assignment.title_zh, assignment.title_en, L)} · {assignmentReminderLabel(assignment, L)}</small></button>)}
          {inactiveReminder && <div className="data-row assignment-inactive-reminder"><b>{languageText(inactiveReminder.title_zh, inactiveReminder.title_en, L)}</b><small>{assignmentReminderLabel(inactiveReminder, L)}</small></div>}
        </DashboardCard>
      </section>

      <section className="course-section">
        <div className="section-heading">
          <div><span>{L("你的學習路線", "YOUR LEARNING PATH")}</span><h2>{L("從基礎到作品", "From fundamentals to projects")}</h2></div>
          <button type="button" onClick={() => navigatePath("/student/courses")}>
            {L("查看所有課程", "View all courses")} →
          </button>
        </div>
        <div className="course-grid">
          {courses.length ? courses.map((course, index) => <CourseCard key={course.id} icon={String(index + 1).padStart(2, "0")} tone={["teal", "blue", "coral", "amber"][index % 4]} title={languageText(course.title_zh, course.title_en, L)} note={course.status} progress={0} meta={L("由伺服器載入", "Loaded from server")} />) : <p className="empty-copy">{L("目前沒有已加入的課程，請向教師索取課程代碼。", "You are not enrolled in a course yet. Ask your teacher for a course code.")}</p>}
        </div>
      </section>
    </>
  );
}

function canonicalNotificationPath(path: string | null) {
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  const route = resolvePortalPath(path);
  return route?.role === "student" ? path : null;
}

function StudentNotifications({ L, notifications, onNotificationRead }: { L: Translator; notifications: NotificationDto[]; onNotificationRead: (id: string) => void }) {
  const unreadCount = notifications.filter((item) => !item.read_at).length;
  return <section className="student-page notification-centre"><div className="page-heading"><div><span className="grade-tag">{L("學生中心", "STUDENT CENTRE")}</span><h1>{L("通知中心", "Notification centre")}</h1><p>{unreadCount ? L(`有 ${unreadCount} 則未讀通知。`, `${unreadCount} unread notifications.`) : L("所有通知都已讀。", "All notifications are read.")}</p></div><span className="prototype-chip">{notifications.length}</span></div><div className="settings-card"><ul className="data-list notification-list">{notifications.map((notification) => { const link = canonicalNotificationPath(notification.link_path); return <li key={notification.id} className={notification.read_at ? "notification-item" : "notification-item unread"}><div><b>{notification.title}</b><small>{new Date(notification.created_at).toLocaleString()} · {notification.type}</small><p>{notification.body}</p>{link && <Link className="text-button" href={link}>{L("查看相關內容", "View related content")}</Link>}</div>{!notification.read_at && <button type="button" className="secondary-action" onClick={() => onNotificationRead(notification.id)}>{L("標記已讀", "Mark read")}</button>}</li>; })}</ul>{!notifications.length && <p className="empty-copy">{L("目前沒有通知。", "There are no notifications yet.")}</p>}</div></section>;
}

function StudentCourses({ L, courses, units, materials, assignments, routePath, navigatePath, joinCourse }: { L: Translator; courses: CourseDto[]; units: UnitDto[]; materials: MaterialDto[]; assignments: AssignmentDto[]; routePath: string; navigatePath: (path: string) => void; joinCourse: (code: string) => Promise<void> }) {
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [courseId, setCourseId] = useState("");
  const [unitId, setUnitId] = useState("");
  useEffect(() => {
    const unitRoute = routePath.match(/^\/student\/courses\/([^/]+)\/units\/([^/]+)$/);
    const courseRoute = routePath.match(/^\/student\/courses\/([^/]+)$/);
    setCourseId(unitRoute?.[1] ?? courseRoute?.[1] ?? "");
    setUnitId(unitRoute?.[2] ?? "");
  }, [routePath]);
  const selectedCourse = courses.find((course) => course.id === courseId);
  const courseUnits = units.filter((unit) => unit.course_id === courseId);
  const selectedUnit = courseUnits.find((unit) => unit.id === unitId);
  const unitMaterials = materials.filter((material) => material.unit_id === unitId);
  const unitAssignments = assignments.filter((assignment) => assignment.course_id === courseId && (!assignment.unit_id || assignment.unit_id === unitId));
  async function submitJoin(event: React.FormEvent) { event.preventDefault(); if (!joinCode.trim()) return; setJoining(true); try { await joinCourse(joinCode.trim()); setJoinCode(""); } finally { setJoining(false); } }
  return (
    <div className="student-centre-page course-browser">
      <div className="page-heading"><div><span className="grade-tag">{L("學生中心", "STUDENT CENTRE")}</span><h1>{selectedUnit ? languageText(selectedUnit.title_zh, selectedUnit.title_en, L) : selectedCourse ? languageText(selectedCourse.title_zh, selectedCourse.title_en, L) : L("我的課程", "My courses")}</h1><p>{L("依次選擇課程與單元，再開啟教材或課堂練習。", "Choose a course and unit, then open its material or classroom practice.")}</p></div></div>
      <nav className="course-breadcrumbs" aria-label={L("課程層級", "Course hierarchy")}><Link href="/student/courses" aria-current={!courseId ? "page" : undefined}>{L("課程", "Courses")}</Link>{selectedCourse && <><span>›</span><Link href={`/student/courses/${encodeURIComponent(selectedCourse.id)}`} aria-current={!unitId ? "page" : undefined}>{languageText(selectedCourse.title_zh, selectedCourse.title_en, L)}</Link></>}{selectedUnit && <><span>›</span><b>{languageText(selectedUnit.title_zh, selectedUnit.title_en, L)}</b></>}</nav>
      {!courseId && <><form className="join-course-form" onSubmit={submitJoin}><label>{L("加入課程代碼", "Course code")}<input aria-label={L("加入課程代碼", "Course code")} value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} placeholder="ABC123" /></label><button type="submit" disabled={joining || !joinCode.trim()}>{joining ? L("加入中…", "Joining…") : L("加入課程", "Join course")}</button></form>{!courses.length ? <section className="empty-state"><h2>{L("目前沒有已加入的課程", "You are not enrolled in any course")}</h2><p>{L("請向教師索取課程代碼，或請教師把你的班別加入課程。", "Ask your teacher for a course code or have your class added to the course.")}</p></section> : <div className="course-grid">{courses.map((course, index) => <Link className="course-card course-select-card" key={course.id} href={`/student/courses/${encodeURIComponent(course.id)}`}><span className={["teal", "blue", "coral", "amber"][index % 4]}>{String(index + 1).padStart(2, "0")}</span><strong>{languageText(course.title_zh, course.title_en, L)}</strong><small>{units.filter((unit) => unit.course_id === course.id).length} {L("個單元", "units")} →</small></Link>)}</div>}</>}
      {courseId && !unitId && <section className="unit-browser"><h2>{L("單元章節", "Course units")}</h2>{courseUnits.length ? <div className="data-list">{courseUnits.map((unit, index) => <Link className="data-row-button" key={unit.id} href={`/student/courses/${encodeURIComponent(courseId)}/units/${encodeURIComponent(unit.id)}`}><b>{index + 1}. {languageText(unit.title_zh, unit.title_en, L)}</b><small>{unit.description_zh ? languageText(unit.description_zh, unit.description_en, L) : L("開啟教材與練習", "Open materials and practice")}</small></Link>)}</div> : <section className="empty-state"><h2>{L("教師尚未發布單元", "No units published yet")}</h2></section>}</section>}
      {selectedUnit && <div className="unit-learning-grid"><section><h2>{L("PPT 與教材", "PPT and materials")}</h2>{unitMaterials.length ? <div className="resource-list">{unitMaterials.map((material) => <article className="resource-card" key={material.id}><h3>{languageText(material.title_zh, material.title_en, L)}</h3><p>{material.file_name ?? material.kind}</p><MaterialPreview material={material} L={L} />{material.allow_download && material.file_name && <a className="download-link" href={learningApi.materialDownloadUrl(material.id)}>{L("下載原檔", "Download original")}</a>}</article>)}</div> : <p className="empty-copy">{L("此單元尚未發布教材。", "No material has been published in this unit.")}</p>}</section><section><h2>{L("課堂練習與功課", "Class practice and assignments")}</h2>{unitAssignments.length ? <div className="data-list">{unitAssignments.map((assignment) => <Link className={assignment.can_start === 0 ? "data-row-button disabled" : "data-row-button"} aria-disabled={assignment.can_start === 0} key={assignment.id} href={`/student/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignment.id)}`}><b>{languageText(assignment.title_zh, assignment.title_en, L)}</b><small>{assignmentReminderLabel(assignment, L)}</small></Link>)}</div> : <p className="empty-copy">{L("此單元尚未發布練習。", "No practice has been published in this unit.")}</p>}</section></div>}
      <button type="button" className="secondary-action" onClick={() => navigatePath("/student/courses")}>{L("返回全部課程", "Back to all courses")} →</button>
    </div>
  );
}

function StudentResources({ L, courses, units, materials }: { L: Translator; courses: CourseDto[]; units: UnitDto[]; materials: MaterialDto[] }) {
  const courseForUnit = (unitId: string) => courses.find((course) => units.find((unit) => unit.id === unitId)?.course_id === course.id);
  return (
    <div className="student-centre-page">
      <div className="page-heading"><div><span className="grade-tag">{L("學生中心", "STUDENT CENTRE")}</span><h1>{L("教材資源", "Learning resources")}</h1><p>{L("只顯示你已加入課程中已發布的教材。", "Only published materials from your enrolled courses are shown.")}</p></div></div>
      {!courses.length && <section className="empty-state"><h2>{L("目前沒有可用教材", "No resources available")}</h2><p>{L("加入課程後，教師發布的教材會在這裡顯示。", "Join a course to see resources published by your teacher.")}</p></section>}
      {courses.length > 0 && !materials.length && <section className="empty-state"><h2>{L("教師尚未發布教材", "No resources published yet")}</h2><p>{L("課程已同步，但目前沒有可供你查看的已發布教材。", "Your courses are synced, but no published resources are available yet.")}</p></section>}
      {materials.length > 0 && <div className="resource-list">{materials.map((material) => {
        const course = courseForUnit(material.unit_id);
        const unit = units.find((item) => item.id === material.unit_id);
        return <article className="resource-card" key={material.id}>
          <span className="grade-tag">{material.file_mime_type ?? material.kind}</span><h2>{languageText(material.title_zh, material.title_en, L)}</h2>
          <p>{course ? languageText(course.title_zh, course.title_en, L) : ""}{unit ? ` · ${languageText(unit.title_zh, unit.title_en, L)}` : ""}</p>
          {material.file_name && <dl className="file-metadata"><div><dt>{L("原檔", "Original file")}</dt><dd>{material.file_name}</dd></div><div><dt>{L("大小", "Size")}</dt><dd>{formatBytes(material.file_byte_size ?? 0)}</dd></div><div><dt>{L("網頁轉換", "Web conversion")}</dt><dd>{conversionLabel(material.conversion_status, L)}</dd></div></dl>}
          {(material.body_zh || material.body_en) && <div className="resource-body">{languageText(material.body_zh ?? "", material.body_en, L)}</div>}
          {material.source_url && <a href={material.source_url} target="_blank" rel="noreferrer">{L("開啟連結", "Open link")}</a>}
          <MaterialPreview material={material} L={L} />
          {material.file_name && Boolean(material.allow_download) && <a className="download-link" href={learningApi.materialDownloadUrl(material.id)}>{L("下載原檔", "Download original")}</a>}
        </article>;
      })}</div>}
    </div>
  );
}

function StudentClassroomHub({ L, sessions, routePath, navigatePath }: { L: Translator; sessions: ClassroomSessionDto[]; routePath: string; navigatePath: (path: string) => void }) {
  const sessionId = routePath.match(/^\/student\/classrooms\/([^/]+)$/)?.[1] ?? "";
  const [state, setState] = useState<ClassroomStateDto | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!sessionId) { setState(null); return; }
    let stopped = false;
    setLoading(true); setError("");
    const sync = async (join = false) => {
      try {
        const result = join ? await learningApi.joinClassroom(sessionId) : await learningApi.heartbeatClassroom(sessionId);
        if (!stopped) setState(result.classroom);
      } catch (caught) {
        if (!stopped) setError(caught instanceof Error ? caught.message : L("課堂暫時無法載入", "The classroom could not be loaded"));
      } finally { if (!stopped) setLoading(false); }
    };
    void sync(true);
    const timer = window.setInterval(() => void sync(false), 5000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [sessionId]);
  if (sessionId) return <section className="student-classroom-hub live-classroom-detail">
    <div className="page-heading"><div><span className="grade-tag">{L("即時課堂", "LIVE CLASSROOM")}</span><h1>{state?.session.title ?? L("載入課堂…", "Loading classroom…")}</h1><p>{state?.session.status === "ended" ? L("課堂已結束；記錄為唯讀。", "This classroom has ended; its record is read-only.") : L("課堂狀態會自動同步，鎖定時伺服器會拒絕保存及提交。", "Classroom state syncs automatically; the server rejects saves and submissions while locked.")}</p></div><button type="button" className="secondary-action" onClick={() => navigatePath("/student/classrooms")}>{L("返回列表", "Back to list")}</button></div>
    {error && <div className="form-error" role="alert"><p>{error}</p><button type="button" onClick={() => window.location.reload()}>{L("重試", "Retry")}</button></div>}
    {loading && !state ? <div className="empty-state" aria-live="polite">{L("正在加入課堂…", "Joining classroom…")}</div> : state && <div className="teacher-live-grid">
      <section className="class-code-panel"><div className="studio-toolbar"><span className="file-tab">{state.activity?.title ?? L("等待教師發布活動", "Waiting for an activity")}</span><span className="live-indicator">● {state.activity?.status ?? state.session.status}</span></div><div className="classroom-prompt">{state.activity ? <><h2>{state.activity.title}</h2>{state.activity.promptJson && <pre>{JSON.stringify(state.activity.promptJson, null, 2)}</pre>}</> : <div className="empty-state">{L("教師尚未建立活動。", "Your teacher has not created an activity yet.")}</div>}</div></section>
      <aside className="class-insights"><DashboardCard eyebrow={L("我的進度", "MY PROGRESS")} action={state.progress?.selfStatus ?? "—"}><p>{L("全班已提交", "Class submitted")}: {state.progress?.submitted ?? 0} / {state.progress?.total ?? 0}</p></DashboardCard><DashboardCard eyebrow={L("連線狀態", "CONNECTION")} action={state.session.status === "ended" ? L("唯讀", "Read only") : L("已同步", "Synced")}><p>{L("伺服器版本", "Server version")}: {state.session.version}</p></DashboardCard></aside>
    </div>}
  </section>;
  return <section className="student-classroom-hub"><div className="page-heading"><div><span className="grade-tag">{L("即時課堂", "LIVE CLASSROOM")}</span><h1>{L("我的課堂", "My live classrooms")}</h1><p>{L("重新整理或重新登入後，課室狀態會從伺服器恢復。", "Classroom state is restored from the server after a refresh or sign-in.")}</p></div></div>{sessions.length ? <ul className="data-list">{sessions.map((session) => <li key={session.id}><span><b>{session.title}</b> · {session.status}</span><button type="button" onClick={() => navigatePath("/student/classrooms/" + session.id)}>{L("進入", "Open")}</button></li>)}</ul> : <div className="empty-state"><h2>{L("目前沒有即時課堂", "No live classroom right now")}</h2><p>{L("教師建立課堂後會在這裡出現。", "A classroom will appear here after your teacher creates one.")}</p></div>}</section>;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function conversionLabel(status: string | null | undefined, L: Translator) {
  if (!status) return L("未要求轉換", "Not requested");
  if (status === "queued") return L("排隊轉換中", "Queued for conversion");
  if (status === "running") return L("正在轉換", "Converting");
  if (status === "succeeded") return L("轉換完成", "Conversion completed");
  return L("轉換失敗", "Conversion failed");
}

function MaterialPreview({ material, L, onTerminal }: { material: MaterialDto; L: Translator; onTerminal?: () => Promise<void> }) {
  const initialStatus = material.conversion_status as MaterialConversionDto["status"] | null | undefined;
  const [job, setJob] = useState<MaterialConversionDto | null>(material.conversion_job_id && initialStatus ? {
    id: material.conversion_job_id, material_id: material.id, output_asset_id: null, kind: "ppt_to_web", status: initialStatus,
    error_code: material.conversion_error_code ?? null, error_message: null, page_count: material.conversion_page_count ?? null,
    created_at: "", started_at: null, finished_at: null,
  } : null);
  const [preview, setPreview] = useState<MaterialPreviewDto | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    let stopped = false;
    const poll = async () => {
      try {
        const result = await learningApi.materialConversionStatus(material.id);
        if (stopped) return;
        setJob(result.job);
        if (result.job && (result.job.status === "succeeded" || result.job.status === "failed")) await onTerminal?.();
      } catch (caught) { if (!stopped) setError(caught instanceof Error ? caught.message : L("轉換狀態載入失敗", "Conversion status could not be loaded")); }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [job?.status, material.id]);
  useEffect(() => {
    if (job?.status !== "succeeded") return;
    let stopped = false;
    void learningApi.materialPreview(material.id).then((result) => { if (!stopped) { setPreview(result.preview); setError(""); } }).catch((caught) => { if (!stopped) setError(caught instanceof Error ? caught.message : L("預覽載入失敗", "Preview could not be loaded")); });
    return () => { stopped = true; };
  }, [job?.status, material.id]);
  if (!job) return null;
  if (job.status === "queued" || job.status === "running") return <p className="conversion-progress" role="status">{conversionLabel(job.status, L)}</p>;
  if (job.status === "failed") return <p className="form-error" role="alert">{L("轉換失敗，教師可重新排隊。", "Conversion failed; the teacher can retry.")}</p>;
  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!preview) return <p className="conversion-progress" role="status">{L("正在載入投影片…", "Loading slides…")}</p>;
  const current = preview.slides.find((slide) => slide.page === page) ?? preview.slides[0];
  return <section className="slide-viewer" aria-label={L("網頁投影片預覽", "Web slide preview")}>
    {/* eslint-disable-next-line @next/next/no-img-element -- authenticated slide routes cannot use an optimizer cache. */}
    <img src={current.url} alt={`${languageText(material.title_zh, material.title_en, L)} · ${page}/${preview.pageCount}`} />
    <div className="slide-controls"><button type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>{L("上一頁", "Previous")}</button><span>{page} / {preview.pageCount}</span><button type="button" disabled={page >= preview.pageCount} onClick={() => setPage((value) => Math.min(preview.pageCount, value + 1))}>{L("下一頁", "Next")}</button><a href={preview.pdfUrl} target="_blank" rel="noreferrer">PDF</a></div>
  </section>;
}

const LIBRARY_TYPES = new Set(["application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "image/png", "image/jpeg", "application/zip"]);
const LIBRARY_MIME_BY_EXTENSION: Record<string, string> = { ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", zip: "application/zip" };

function TeacherMaterialLibrary({ L, assets, onChanged }: { L: Translator; assets: FileAssetDto[]; onChanged: () => Promise<void> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastFile, setLastFile] = useState<File | null>(null);
  const [previousAssetId, setPreviousAssetId] = useState("");
  async function upload(file?: File) {
    if (!file) return;
    setLastFile(file);
    if (file.size > 25 * 1024 * 1024) { setError(L("檔案不可超過 25 MB", "Files must not exceed 25 MB")); return; }
    const inferredMime = LIBRARY_MIME_BY_EXTENSION[file.name.split(".").pop()?.toLowerCase() ?? ""];
    const mimeType = file.type && file.type !== "application/octet-stream" ? file.type : inferredMime;
    if (!mimeType || !LIBRARY_TYPES.has(mimeType)) { setError(L("此教材格式不受支援，請檢查副檔名與 MIME 類型。", "This material format is not supported; check its extension and MIME type.")); return; }
    setBusy(true); setError(""); setProgress(1);
    try {
      const uploaded = await learningApi.uploadFile(file, { purpose: "material_library", libraryScope: "school", previousAssetId: previousAssetId || undefined, mimeType, onProgress: setProgress });
      setProgress(80);
      if (uploaded.asset.status === "quarantined") await learningApi.releaseFile(uploaded.asset.id);
      setProgress(100); await onChanged();
    } catch (caught) { const requestId = (caught as { requestId?: string | null }).requestId; setError((caught instanceof Error ? caught.message : L("教材上傳失敗", "Material upload failed")) + (requestId ? ` · ${L("請求編號", "Request ID")}: ${requestId}` : "")); setProgress(0); }
    finally { setBusy(false); }
  }
  return <section className="settings-card material-library" aria-labelledby="material-library-title"><div className="settings-title"><span>⇧</span><div><h2 id="material-library-title">{L("教材庫上傳", "Material library upload")}</h2><p>{L("原檔先隔離驗證；新上傳預設全校教師共享，但只有擁有者或管理員可改動原檔。", "Files are quarantined first. New uploads are school-shared by default, while only the owner or an administrator can alter the source.")}</p></div></div><label>{L("建立新版（可選）", "New version of (optional)")}<select value={previousAssetId} onChange={(event) => setPreviousAssetId(event.target.value)}><option value="">{L("新教材", "New material")}</option>{assets.filter((asset) => asset.ownedByMe).map((asset) => <option key={asset.id} value={asset.id}>{asset.originalName} · v{asset.versionNumber}</option>)}</select></label><input ref={inputRef} className="visually-hidden" type="file" accept=".ppt,.pptx,.pdf,.doc,.docx,.png,.jpg,.jpeg,.zip" onChange={(event) => void upload(event.target.files?.[0])} /><button type="button" className="library-dropzone" disabled={busy} onClick={() => inputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void upload(event.dataTransfer.files[0]); }}><strong>{busy ? L("正在隔離及驗證…", "Quarantining and validating…") : L("選擇或拖放教材", "Choose or drop a material")}</strong><small>{L("PPT/PPTX、PDF、Word、PNG/JPEG、ZIP · 上限 25 MB", "PPT/PPTX, PDF, Word, PNG/JPEG, ZIP · 25 MB max")}</small></button>{(busy || progress > 0) && <div className="upload-progress" aria-live="polite"><progress max="100" value={progress} aria-label={L("教材上傳進度", "Material upload progress")} /><span>{progress}%</span></div>}{error && <div className="upload-error" role="alert"><p className="form-error">{error}</p>{lastFile && <button type="button" disabled={busy} onClick={() => void upload(lastFile)}>{L("重試上傳", "Retry upload")}</button>}</div>}<ul className="asset-list">{assets.map((asset) => <li key={asset.id}><div><strong>{asset.originalName}</strong><small>{asset.mimeType} · {formatBytes(asset.byteSize)} · v{asset.versionNumber} · {asset.status}</small></div>{asset.ownedByMe ? <label>{L("共享範圍", "Sharing scope")}<select value={asset.libraryScope} onChange={async (event) => { try { await learningApi.updateFileScope(asset.id, event.target.value as FileAssetDto["libraryScope"]); await onChanged(); } catch (caught) { setError(caught instanceof Error ? caught.message : L("共享設定失敗", "Sharing update failed")); } }}><option value="private">{L("私人", "Private")}</option><option value="school">{L("全校教師", "School teachers")}</option></select></label> : <small>{L("全校共享（唯讀）", "School shared (read-only)")}</small>}<a href={learningApi.fileDownloadUrl(asset.id)}>{L("下載", "Download")}</a></li>)}</ul>{!assets.length && <p className="empty-copy">{L("教材庫目前是空的。上傳一次後，可在多個課程重用同一檔案。", "The library is empty. Upload once, then reuse the same file across courses.")}</p>}</section>;
}

function TeacherCourseMaterials({ L, courses, units, materials, assets, selectedCourseId, initialUnitId, onCourseChange, onChanged }: { L: Translator; courses: CourseDto[]; units: UnitDto[]; materials: MaterialDto[]; assets: FileAssetDto[]; selectedCourseId: string; initialUnitId?: string; onCourseChange: (id: string) => void; onChanged: () => Promise<void> }) {
  const [unitId, setUnitId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [titleZh, setTitleZh] = useState("");
  const [titleEn, setTitleEn] = useState("");
  const [bodyZh, setBodyZh] = useState("");
  const [bodyEn, setBodyEn] = useState("");
  const [allowDownload, setAllowDownload] = useState(true);
  const [convert, setConvert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const directInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (initialUnitId && units.some((unit) => unit.id === initialUnitId)) setUnitId(initialUnitId); }, [initialUnitId, units]);
  const selectedAsset = assets.find((item) => item.id === assetId);
  const canConvert = selectedAsset?.mimeType === "application/vnd.ms-powerpoint" || selectedAsset?.mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  useEffect(() => { if (!units.some((unit) => unit.id === unitId)) setUnitId(units.at(0)?.id ?? ""); }, [units, unitId]);
  async function create(event: React.FormEvent) {
    event.preventDefault(); if (!unitId || !assetId || !titleZh.trim()) return;
    setBusy(true); setError("");
    try {
      const result = await learningApi.createMaterial(unitId, { kind: canConvert ? "slides" : "document", titleZh: titleZh.trim(), titleEn: titleEn.trim() || undefined, bodyZh: bodyZh.trim() || undefined, bodyEn: bodyEn.trim() || undefined, fileAssetId: assetId, allowDownload, position: materials.filter((item) => item.unit_id === unitId).length });
      if (convert && canConvert) await learningApi.queueMaterialConversion(result.material.id, "ppt_to_web");
      setTitleZh(""); setTitleEn(""); setBodyZh(""); setBodyEn(""); await onChanged();
    } catch (caught) { setError(caught instanceof Error ? caught.message : L("教材草稿建立失敗", "Material draft could not be created")); }
    finally { setBusy(false); }
  }
  async function uploadToUnit(file?: File) {
    if (!file || !unitId) return;
    const mimeType = file.type && file.type !== "application/octet-stream" ? file.type : LIBRARY_MIME_BY_EXTENSION[file.name.split(".").pop()?.toLowerCase() ?? ""];
    if (!mimeType || !LIBRARY_TYPES.has(mimeType) || file.size > 25 * 1024 * 1024) { setError(L("請選擇受支援且不超過 25 MB 的教材。", "Choose a supported material no larger than 25 MB.")); return; }
    setBusy(true); setError("");
    try {
      const uploaded = await learningApi.uploadFile(file, { purpose: "material_library", libraryScope: "school", mimeType });
      const asset = uploaded.asset.status === "quarantined" ? (await learningApi.releaseFile(uploaded.asset.id)).asset : uploaded.asset;
      const result = await learningApi.createMaterial(unitId, { kind: mimeType.includes("powerpoint") || mimeType.includes("presentation") ? "slides" : "document", titleZh: file.name, titleEn: file.name, fileAssetId: asset.id, allowDownload: true, bindingMode: "reference", position: materials.filter((item) => item.unit_id === unitId).length });
      if (mimeType.includes("powerpoint") || mimeType.includes("presentation")) await learningApi.queueMaterialConversion(result.material.id);
      await onChanged();
    } catch (caught) { const requestId = (caught as { requestId?: string | null }).requestId; setError((caught instanceof Error ? caught.message : L("單元上傳失敗", "Unit upload failed")) + (requestId ? ` · ${L("請求編號", "Request ID")}: ${requestId}` : "")); }
    finally { setBusy(false); if (directInputRef.current) directInputRef.current.value = ""; }
  }
  return <section className="settings-card course-materials" aria-labelledby="course-materials-title"><div className="settings-title"><span>▤</span><div><h2 id="course-materials-title">{L("課程教材選用", "Course material selection")}</h2><p>{L("可從全校教材庫引用，或直接上傳到所選單元；兩種方式都先建立草稿，必須由教師明確發布。", "Reference the school library or upload directly to the selected unit. Both create a draft that a teacher must explicitly publish.")}</p></div></div><form onSubmit={create} className="material-form-grid"><label>{L("課程", "Course")}<select value={selectedCourseId} onChange={(event) => onCourseChange(event.target.value)}><option value="">{L("選擇課程", "Select course")}</option>{courses.map((course) => <option key={course.id} value={course.id}>{languageText(course.title_zh, course.title_en, L)}</option>)}</select></label><label>{L("單元", "Unit")}<select value={unitId} onChange={(event) => setUnitId(event.target.value)}><option value="">{L("選擇單元", "Select unit")}</option>{units.map((unit) => <option key={unit.id} value={unit.id}>{languageText(unit.title_zh, unit.title_en, L)}</option>)}</select></label><div className="full-field"><input ref={directInputRef} type="file" accept=".ppt,.pptx,.pdf,.doc,.docx,.png,.jpg,.jpeg,.zip" disabled={busy || !unitId} onChange={(event) => void uploadToUnit(event.target.files?.[0])} /><small>{L("直接上傳會預設全校共享、建立單元草稿；PPT 會排隊轉換但不會自動發布。", "Direct upload defaults to school sharing and creates a unit draft; PPT conversion is queued without auto-publishing.")}</small></div><label className="full-field">{L("教材庫檔案", "Library asset")}<select value={assetId} onChange={(event) => { setAssetId(event.target.value); setConvert(false); }}><option value="">{L("選擇已驗證檔案", "Choose a verified file")}</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.originalName} · v{asset.versionNumber} · {asset.libraryScope}</option>)}</select></label><label>{L("中文標題", "Chinese title")}<input value={titleZh} onChange={(event) => setTitleZh(event.target.value)} /></label><label>{L("英文標題", "English title")}<input value={titleEn} onChange={(event) => setTitleEn(event.target.value)} /></label><label>{L("中文說明", "Chinese description")}<textarea value={bodyZh} onChange={(event) => setBodyZh(event.target.value)} /></label><label>{L("英文說明", "English description")}<textarea value={bodyEn} onChange={(event) => setBodyEn(event.target.value)} /></label><label className="check-row"><input type="checkbox" checked={allowDownload} onChange={(event) => setAllowDownload(event.target.checked)} />{L("允許學生下載原檔", "Allow students to download the original")}</label><label className="check-row"><input type="checkbox" checked={convert} disabled={!canConvert} onChange={(event) => setConvert(event.target.checked)} />{L("排隊轉成網頁教材", "Queue web conversion")}</label><button type="submit" disabled={busy || !unitId || !assetId || !titleZh.trim()}>{busy ? L("儲存中…", "Saving…") : L("儲存教材草稿", "Save material draft")}</button></form>{error && <p className="form-error" role="alert">{error}</p>}<ul className="asset-list">{materials.map((material) => <li key={material.id}><div><strong>{languageText(material.title_zh, material.title_en, L)}</strong><small>{material.file_name ?? material.kind} · v{material.file_version_number ?? 1} · {material.status ?? "draft"} · {conversionLabel(material.conversion_status, L)}</small></div>{Boolean(material.update_available) && <button type="button" onClick={async () => { setError(""); try { await learningApi.upgradeMaterialAsset(material.id); await onChanged(); } catch (caught) { setError(caught instanceof Error ? caught.message : L("升級失敗", "Upgrade failed")); } }}>{L("升級至最新版", "Upgrade to latest")}</button>}{material.status !== "published" && <button type="button" onClick={async () => { setError(""); try { await learningApi.updateMaterial(material.id, { status: "published" }); await onChanged(); } catch (caught) { setError(caught instanceof Error ? caught.message : L("發布失敗", "Publish failed")); } }}>{L("發布", "Publish")}</button>}</li>)}</ul></section>;
}

function TeacherMaterialsHub({ L, courses, initialCourseId, initialUnitId }: { L: Translator; courses: CourseDto[]; initialCourseId?: string; initialUnitId?: string }) {
  const [courseId, setCourseId] = useState(initialCourseId ?? "");
  const [units, setUnits] = useState<UnitDto[]>([]);
  const [materials, setMaterials] = useState<MaterialDto[]>([]);
  const [assets, setAssets] = useState<FileAssetDto[]>([]);
  const [error, setError] = useState("");
  const refreshGate = useRef(new LatestRequestGate());
  useEffect(() => { if (!courseId && courses[0]) setCourseId(courses[0].id); }, [courseId, courses]);
  useEffect(() => { if (initialCourseId) setCourseId(initialCourseId); }, [initialCourseId]);
  async function refresh() {
    await refreshGate.current.run(async (signal) => {
      const [assetResult, unitResult] = await Promise.all([learningApi.availableFiles(signal), courseId ? learningApi.units(courseId, signal) : Promise.resolve({ units: [] as UnitDto[] })]);
      const materialResults = await Promise.all(unitResult.units.map((unit) => learningApi.materials(unit.id, signal)));
      return { assets: assetResult.assets, units: unitResult.units, materials: materialResults.flatMap((result) => result.materials) };
    }, (result) => {
      setAssets(result.assets); setUnits(result.units); setMaterials(result.materials); setError("");
    }, (caught) => setError(caught instanceof Error ? caught.message : L("教材工作台載入失敗", "Material workspace could not be loaded")));
  }
  useEffect(() => { void refresh(); }, [courseId]);
  useEffect(() => () => refreshGate.current.cancel(), []);
  return <section className="teacher-material-hub"><div className="page-heading compact-heading"><div><span className="grade-tag">{L("教師教材中心", "TEACHER MATERIALS")}</span><h1>{L("上傳一次，多課程選用", "Upload once, reuse across courses")}</h1><p>{L("教材原檔、發布範圍與轉換狀態均由後端提供。", "Original files, sharing scope and conversion state all come from the backend.")}</p></div></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="teacher-material-workspace"><TeacherMaterialLibrary L={L} assets={assets} onChanged={refresh} /><TeacherCourseMaterials L={L} courses={courses} units={units} materials={materials} assets={assets} selectedCourseId={courseId} initialUnitId={initialUnitId} onCourseChange={setCourseId} onChanged={refresh} /></div>{assets.some((asset) => asset.ownedByMe) && <section className="settings-card" aria-labelledby="owned-file-actions"><h2 id="owned-file-actions">{L("原檔管理", "Source file management")}</h2><p>{L("只有未被教材、提交或轉換工作引用的檔案可刪除。", "Only files not referenced by materials, submissions, or conversion jobs can be deleted.")}</p><ul className="data-list">{assets.filter((asset) => asset.ownedByMe).map((asset) => <li key={asset.id}><span>{asset.originalName} · v{asset.versionNumber}</span><button type="button" className="secondary-action" onClick={async () => { if (!window.confirm(L("確定刪除此未被使用的檔案？", "Delete this unused file?"))) return; try { await learningApi.deleteFile(asset.id); await refresh(); } catch (caught) { setError(caught instanceof Error ? caught.message : L("檔案正在使用，無法刪除", "The file is in use and cannot be deleted")); } }}>{L("刪除", "Delete")}</button></li>)}</ul></section>}</section>;
}

function CodePreview({ L }: { L: Translator }) {
  return (
    <div className="code-preview-card" aria-label={L("Python 程式預覽", "Python code preview")}>
      <div className="preview-tabs"><span>main.py <i /></span><span>{L("輸出預覽", "Output preview")}</span><button type="button" aria-label={L("執行", "Run")}>▶</button></div>
      <div className="preview-body">
        <pre><code><em>1</em> <span className="muted"># 今日小挑戰</span>{"\n"}<em>2</em> scores = <span className="blue-code">[82, 91, 76, 88]</span>{"\n"}<em>3</em> average = <span className="pink-code">sum</span>(scores) / <span className="pink-code">len</span>(scores){"\n"}<em>4</em>{"\n"}<em>5</em> <span className="pink-code">print</span>(<span className="green-code">f&quot;平均分：{"{"}average{"}"}&quot;</span>)</code></pre>
        <div className="preview-output"><span>{L("執行結果", "Result")}</span><strong>{L("平均分：84.25", "Average: 84.25")}</strong><small>✓ {L("程式執行成功", "Program finished successfully")}</small></div>
      </div>
      <div className="preview-console"><span>Console <i /></span><code>Python 3.12 · ready</code></div>
    </div>
  );
}

function MissionCentre({ L, assignments, courses, routePath, navigatePath, startAssignment }: { L: Translator; assignments: AssignmentDto[]; courses: CourseDto[]; routePath: string; navigatePath: (path: string) => void; startAssignment: (assignmentId: string) => Promise<void> }) {
  const [courseId, setCourseId] = useState("");
  const routeMatch = routePath.match(/^\/student\/courses\/([^/]+)\/assignments\/([^/]+)$/);
  const selectedAssignment = routeMatch ? assignments.find((assignment) => assignment.id === routeMatch[2] && assignment.course_id === routeMatch[1]) : undefined;
  const visible = selectedAssignment ? [selectedAssignment] : courseId ? assignments.filter((assignment) => assignment.course_id === courseId) : assignments;
  const missions = visible.map((assignment, index) => ({ id: assignment.id, n: String(index + 1), icon: index === 0 ? "▶" : "&lt;/&gt;", state: "current", zh: assignment.title_zh, en: assignment.title_en ?? assignment.title_zh }));
  if (!missions.length) return <div className="missions-page"><div className="page-heading"><div><span className="grade-tag">{L("學生中心", "STUDENT CENTRE")}</span><h1>{L("Python 學習任務", "Python learning missions")}</h1><p>{L("任務會在教師發布功課後出現。", "Missions appear when a teacher publishes assignments.")}</p></div></div><section className="empty-state"><h2>{L("目前沒有可開始的任務", "No missions are available yet")}</h2><p>{L("返回首頁查看已同步的課程和通知。", "Return home to view synced courses and notifications.")}</p></section></div>;
  return (
    <div className="missions-page">
      <div className="page-heading">
        <div><span className="grade-tag">{L("學生中心", "STUDENT CENTRE")}</span><h1>{L("Python 學習任務", "Python learning missions")}</h1><p>{L("完成一站，解鎖下一個挑戰。", "Complete each stop to unlock the next challenge.")}</p></div>
        <label>{L("篩選課程", "Filter course")}<select value={courseId} onChange={(event) => setCourseId(event.target.value)}><option value="">{L("全部課程", "All courses")}</option>{courses.map((course) => <option key={course.id} value={course.id}>{languageText(course.title_zh, course.title_en, L)}</option>)}</select></label>
      </div>
      {selectedAssignment && <section className="settings-card assignment-deep-link"><h2>{languageText(selectedAssignment.title_zh, selectedAssignment.title_en, L)}</h2><p>{languageText(selectedAssignment.instructions_zh ?? "", selectedAssignment.instructions_en, L) || assignmentReminderLabel(selectedAssignment, L)}</p><div className="editor-controls"><button type="button" disabled={selectedAssignment.can_start === 0} onClick={() => void startAssignment(selectedAssignment.id)}>{L("開始作答", "Start assignment")}</button><button type="button" className="secondary-action" onClick={() => navigatePath(`/student/courses/${encodeURIComponent(selectedAssignment.course_id)}`)}>{L("返回課程", "Back to course")}</button></div></section>}
      <div className="mission-layout">
        <section className="mission-map-card">
          <div className="card-title-row"><div><span>{L("目前路線", "CURRENT PATH")}</span><h2>{L("Python 基礎", "Python foundations")}</h2></div><strong>58%</strong></div>
          <div className="mission-track">
            <span className="mission-line" />
            {missions.map((mission) => (
              <button
                type="button"
                key={mission.n}
                className={"mission-node " + mission.state}
                onClick={() => void startAssignment(mission.id)}
              >
                <i>{mission.icon}</i><b>{mission.n}</b><small>{L(mission.zh, mission.en)}</small>
              </button>
            ))}
          </div>
            <div className="mission-progress"><span>★</span><b>{L(`已載入 ${missions.length} 個任務`, `${missions.length} missions loaded`)}</b><ProgressBar value={0} tone="teal" /><i>⌁</i></div>
        </section>
        <aside className="mission-side">
          <DashboardCard eyebrow={L("本週進度", "WEEKLY PROGRESS")} action="65%">
            <div className="ring-summary"><div><strong>65%</strong><small>{L("完成", "Complete")}</small></div><ul><li><i className="dot teal" />{L("任務", "Missions")} <b>13 / 20</b></li><li><i className="dot coral" />{L("挑戰", "Challenges")} <b>8 / 12</b></li><li><i className="dot amber" />{L("專題", "Projects")} <b>2 / 5</b></li></ul></div>
          </DashboardCard>
          <DashboardCard eyebrow={L("班內排名", "CLASS RANK")} action={L("管理員控制", "Admin controlled")}>
            <p className="empty-copy">{L("排名顯示由管理員設定，現時沒有可公開的排名資料。", "Leaderboard visibility is controlled by an administrator; no public ranking is available.")}</p>
          </DashboardCard>
        </aside>
      </div>
      <section className="challenge-section">
        <div className="section-heading"><div><span>{L("編程挑戰", "CODING CHALLENGES")}</span><h2>{L("下一步任務", "Your next missions")}</h2></div></div>
        <div className="challenge-grid">
          {visible.map((assignment, index) => <ChallengeCard key={assignment.id} n={String(index + 1).padStart(2, "0")} icon="&lt;/&gt;" tone={["teal", "blue", "amber", "coral"][index % 4]} title={languageText(assignment.title_zh, assignment.title_en, L)} action={() => void startAssignment(assignment.id)} />)}
        </div>
      </section>
    </div>
  );
}

function PracticeWorkspace({
  L,
  code,
  setCode,
  stdin,
  setStdin,
  answers,
  answerIndex,
  selectAnswer,
  uploadAnswerFile,
  testState,
  runResult,
  question,
  submission,
  execution,
  runCode,
  hintCount,
  aiHint,
  aiStatus,
  aiBusy,
  requestAiHint,
  saveWork,
  submitWork,
  autosaveState,
  recordPaste,
}: {
  L: Translator;
  code: string;
  setCode: (code: string) => void;
  stdin: string;
  setStdin: (stdin: string) => void;
  answers: SubmissionDto["answers"];
  answerIndex: number;
  selectAnswer: (index: number) => void;
  uploadAnswerFile: (file: File) => Promise<void>;
  testState: TestState;
  runResult: RunResult | null;
  question: StudentQuestionDto | null;
  submission: SubmissionDto | null;
  execution: ExecutionDto | null;
  runCode: () => void;
  hintCount: number;
  aiHint: string;
  aiStatus: AiStatusDto | null;
  aiBusy: boolean;
  requestAiHint: () => Promise<void>;
  saveWork: () => Promise<void>;
  submitWork: () => Promise<void>;
  autosaveState: "idle" | "saving" | "saved" | "error";
  recordPaste: (count: number) => void;
}) {
  const output =
    testState === "idle"
      ? L("按「執行」查看結果", "Select Run to see the result")
      : testState === "running"
        ? L("正在執行 main.py…", "Running main.py…")
        : runResult?.error
          ? runResult.error
          : (runResult?.stdout || "") + (runResult?.stderr ? "\n" + runResult.stderr : "");

  return (
    <div className="practice-shell">
      <div className="practice-breadcrumb">
        <span>{L("課程", "Course")}</span><i>›</i><span>{L("真實作答", "Assignment")}</span><i>›</i><strong>{question ? languageText(question.titleZh, question.titleEn, L) : L("尚未開始作答", "No assignment selected")}</strong><small>{submission?.status ?? "draft"}</small>
        <div><small>{L("單元進度", "Unit progress")}</small><ProgressBar value={60} tone="blue" /><b>60%</b></div>
      </div>
      {answers.length > 1 && <nav className="question-navigation" aria-label={L("題目導覽", "Question navigation")}>{answers.map((answer, index) => <button type="button" key={answer.id} className={index === answerIndex ? "active" : ""} onClick={() => selectAnswer(index)}>{index + 1}<span>{answer.finalScore !== null ? "✓" : answer.answerText ? "•" : "○"}</span></button>)}</nav>}
      <div className="practice-grid">
        <aside className="lesson-sidebar">
          <div className="lesson-sidebar-title"><span>▤</span><strong>{L("功課題目", "Assignment question")}</strong><i>{question ? question.type : "—"}</i></div>
          <ProgressBar value={question ? (submission?.status === "submitted" ? 100 : 50) : 0} tone="blue" />
          {question ? <>
            <h3>{languageText(question.titleZh, question.titleEn, L)}</h3>
            <p className="empty-copy">{languageText(question.promptZh, question.promptEn, L)}</p>
            <div className="lesson-goal"><strong>{L("作答狀態", "Attempt status")}</strong><p>{submission?.status ?? L("草稿", "Draft")}</p><span>{L("最高分", "Max score")} <b>{question.maxScore}</b></span>{submission && <><span>{L("總分", "Total score")} <b>{submission.scoreReleased ? `${submission.totalScore ?? 0} / ${submission.maxScore ?? question.maxScore}` : L("尚未公布", "Not released")}</b></span><span>{L("答案公布", "Answers")} <b>{submission.answersReleased ? L("已公布", "Released") : L("尚未公布", "Not released")}</b></span><span>{L("測試結果", "Test results")} <b>{submission.testResultsReleased ? L("可查看", "Available") : L("尚未公布", "Not released")}</b></span>{submission.answers.some((answer) => answer.teacherFeedback) && <p>{submission.answers.map((answer) => answer.teacherFeedback).filter(Boolean).join(" · ")}</p>}</>}</div>
          </> : <div className="empty-state"><strong>{L("尚未選擇功課", "No assignment selected")}</strong><p>{L("請從已發布功課開始作答。", "Choose a published assignment to begin.")}</p></div>}
        </aside>

        <section className="coding-studio">
          <div className="studio-toolbar">
            <span className="file-tab"><i />main.py <b>×</b></span>
            <button type="button" className="run-button" onClick={runCode} disabled={testState === "running"}>▶ {testState === "running" ? L("執行中", "Running") : L("執行", "Run")}</button>
            <button type="button" className="dark-button" onClick={() => void saveWork()}>{L("保存", "Save")}</button>
            <small className={autosaveState === "error" ? "form-error" : "autosave-state"} aria-live="polite">{autosaveState === "saving" ? L("自動保存中…", "Autosaving…") : autosaveState === "saved" ? L("已自動保存", "Autosaved") : autosaveState === "error" ? L("自動保存失敗", "Autosave failed") : ""}</small>
            <button type="button" className="primary-action compact" onClick={() => void submitWork()}>{L("提交", "Submit")}</button>
          </div>
          {question && ["multiple_choice", "fill_blank", "short_answer"].includes(question.type) ? <div className="answer-control">{question.type === "multiple_choice" && <fieldset><legend>{L("選擇答案", "Choose an answer")}</legend>{(Array.isArray(question.options) ? question.options : []).map((option, index) => { const value = typeof option === "string" ? option : JSON.stringify(option); return <label key={index}><input type="radio" name="multiple-choice-answer" value={value} checked={code === value} onChange={() => setCode(value)} />{value}</label>; })}</fieldset>}{question.type !== "multiple_choice" && <label>{question.type === "fill_blank" ? L("填充答案", "Fill in the blank") : L("簡答", "Short answer")}<textarea aria-label={L("答案", "Answer")} value={code} onChange={(event) => setCode(event.target.value)} /></label>}</div> : <div className="editor-area">
            <div className="line-numbers" aria-hidden="true">{Array.from({ length: Math.max(12, code.split("\n").length) }, (_, i) => <span key={i}>{i + 1}</span>)}</div>
            <textarea aria-label={L("Python 程式編輯器", "Python code editor")} value={code} onChange={(event) => setCode(event.target.value)} onPaste={(event) => recordPaste(event.clipboardData.getData("text").length)} spellCheck={false} />
          </div>}
          {question && ["python_code", "code_fill"].includes(question.type) && <label className="stdin-editor">{L("程式輸入（stdin）", "Program input (stdin)")}<textarea aria-label={L("程式輸入", "Program stdin")} value={stdin} onChange={(event) => setStdin(event.target.value)} placeholder={L("每行一個輸入值", "One input value per line")} /></label>}
          {question && ["file_upload", "project_upload"].includes(question.type) && <label className="file-answer-control">{L("上傳答案檔案", "Upload answer file")}<input type="file" aria-label={L("上傳答案檔案", "Upload answer file")} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAnswerFile(file); }} /><small>{L("檔案會先隔離，再由伺服器釋放；未完成釋放不會提交。", "Files are quarantined then released by the server before submission.")}</small></label>}
          <div className="console-area">
            <div className="console-heading"><strong>⌄ Console</strong><button type="button" onClick={() => setCode(question?.starterCode ?? "")}>{L("重設程式", "Reset code")}</button></div>
            <pre className={testState === "failed" || testState === "unconfigured" ? "console-error" : ""}>{output}</pre>
            {testState !== "idle" && testState !== "running" && (
              <div className="run-meta">
                <span>exit: {runResult?.exit_code ?? "—"}</span>
                <span>{runResult?.timed_out ? L("已逾時", "Timed out") : L("時限正常", "Within limit")}</span>
                <span>{runResult?.output_limited ? L("輸出已截斷", "Output limited") : L("輸出正常", "Output OK")}</span>
              </div>
            )}
          </div>
        </section>

        <aside className="guidance-panel">
          <section className="task-preview">
            <span>{L("題目", "TASK")}</span><h2>{question ? languageText(question.titleZh, question.titleEn, L) : L("未載入題目", "Question not loaded")}</h2><p>{question ? languageText(question.promptZh, question.promptEn, L) : L("請從已發布功課開始作答。", "Start from a published assignment.")}</p>
            {question?.testCases.length ? <code>{L(`${question.testCases.length} 個公開測試案例`, `${question.testCases.length} public test cases` )}</code> : null}
          </section>
          <section className="hint-panel">
            <div className="panel-heading"><span>☼</span><strong>{L("逐層思路提示", "Progressive hints")}</strong><small>{hintCount}/{aiStatus?.maxHintLevel ?? 0}</small></div>
            <p className="empty-copy">{aiStatus?.enabled ? L("每次只解鎖下一層；AI 產生的提示必須先由教師批准。", "Each action unlocks one layer; AI-authored hints require teacher approval first.") : L("這份功課未啟用提示，或教師尚未發布提示。", "Hints are disabled for this assignment or none have been approved yet.")}</p>
            <button type="button" disabled={!question || aiBusy || !aiStatus?.enabled || hintCount >= (aiStatus?.maxHintLevel ?? 0)} onClick={() => void requestAiHint()}>{aiBusy ? L("正在取得提示…", "Getting hint…") : L(`解鎖第 ${hintCount + 1} 層提示`, `Unlock hint level ${hintCount + 1}`)} <span>⌄</span></button>
            {aiHint && <p aria-live="polite" className="ai-hint-response">{aiHint}</p>}
          </section>
          <section className="test-panel">
            <div className="panel-heading"><strong>{L("測試結果", "Test results")}</strong><b>{L("即時", "Live")}</b></div>
            <div className={testState === "passed" ? "test-result passed" : testState === "failed" ? "test-result failed" : "test-result"}>
              <i>{testState === "passed" ? "✓" : testState === "failed" ? "!" : "○"}</i>
              <span><strong>{L("公開測試", "Public tests")}</strong><small>{execution ? `${execution.testResults.filter((result) => result.expectedOutput !== undefined).filter((result) => result.status === "passed").length} / ${execution.testResults.filter((result) => result.expectedOutput !== undefined).length}` : L("提交後顯示結果", "Shown after grading")}</small></span>
            </div>
            {execution && execution.testResults.length > 0 && <div className="test-case-details">{execution.testResults.map((result) => <div key={result.id} className="test-case-detail"><strong>{result.expectedOutput !== undefined ? L("公開測試", "Public test") : L("隱藏測試", "Hidden test")}</strong><span>{result.status} · {result.scoreAwarded ?? 0} {L("分", "points")}</span>{result.expectedOutput !== undefined && <small>{L("輸入", "Input")}: {JSON.stringify(result.inputJson ?? "")} · {L("預期", "Expected")}: {result.expectedOutput} · {L("實際", "Actual")}: {result.actualOutput ?? ""}{result.stderr ? ` · stderr: ${result.stderr}` : ""}</small>}</div>)}</div>}
            <div className={testState === "passed" ? "test-result passed" : testState === "failed" ? "test-result failed" : "test-result"}>
              <i>{testState === "passed" ? "✓" : testState === "failed" ? "!" : "○"}</i>
              <span><strong>{L("隱藏測試", "Hidden tests")}</strong><small>{execution ? `${execution.testResults.filter((result) => result.expectedOutput === undefined && result.status === "passed").length} / ${execution.testResults.filter((result) => result.expectedOutput === undefined).length} · ${L("只顯示通過或失敗", "Pass or fail only")}` : L("提交後顯示結果", "Shown after grading")}</small></span>
            </div>
          </section>
          <section className="steps-panel">
            <div className="panel-heading"><strong>{L("作答流程", "Workflow")}</strong><b>{submission?.status ?? "—"}</b></div>
            <ul><li className={question ? "done" : "active"}>✓ {L("閱讀題目", "Read the question")}</li><li className={code.trim() ? "done" : "active"}>● {L("編寫並保存答案", "Write and save your answer")}</li><li className={execution ? "done" : "active"}>● {L("執行及查看測試", "Run and inspect tests")}</li><li className={submission?.status === "submitted" ? "done" : "active"}>○ {L("提交功課", "Submit assignment")}</li></ul>
            <button type="button" className="next-button" disabled>{L("請從功課清單選擇下一題", "Choose the next assignment from the list")}</button>
          </section>
        </aside>
      </div>
    </div>
  );
}

function TeacherAnalyticsDashboard({ L, courses, initialReport }: { L: Translator; courses: CourseDto[]; initialReport?: string }) {
  const [courseId, setCourseId] = useState("");
  const [classes, setClasses] = useState<ClassDto[]>([]);
  const [classId, setClassId] = useState("");
  const [studentId, setStudentId] = useState("");
  const [reports, setReports] = useState<Record<string, AnalyticsDto>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void learningApi.classes().then((result) => setClasses(result.classes)).catch(() => setClasses([])); }, []);
  useEffect(() => { if (!courseId && courses[0]) setCourseId(courses[0].id); }, [courseId, courses]);
  useEffect(() => {
    if (!courseId && !classId) return;
    let stopped = false;
    setLoading(true);
    const filters = { courseId: courseId || undefined, classId: classId || undefined, studentId: studentId || undefined };
    const names = ["overview", "question-accuracy", "common-errors", "ai-usage", "code-history", "learning-time"];
    void Promise.all(names.map(async (name) => [name, await learningApi.analytics(name, filters)] as const)).then((rows) => { if (!stopped) { setReports(Object.fromEntries(rows)); setError(""); } }).catch((caught) => { if (!stopped) setError(caught instanceof Error ? caught.message : L("分析資料載入失敗", "Analytics could not be loaded")); }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [courseId, classId, studentId]);
  const students = Array.isArray(reports.overview?.data.students) ? reports.overview.data.students as Array<{ studentId: string; chineseName?: string; englishName?: string; assignmentsTotal: number; assignmentsCompleted: number; completionRate: number; averageScore: number; attemptCount: number; learningSeconds: number }> : [];
  const uniqueStudents = [...new Map(students.map((student) => [student.studentId, student])).values()];
  const usage = Array.isArray(reports["ai-usage"]?.data.usage) ? reports["ai-usage"].data.usage as Array<{ userId?: string; requests: number; tokens: number }> : [];
  const errors = Array.isArray(reports["common-errors"]?.data.errors) ? reports["common-errors"].data.errors as Array<{ title: string; status: string; errorCode: string; occurrences: number }> : [];
  return <section className="teacher-analytics-page"><div className="page-heading"><div><span className="grade-tag">{initialReport === "ai-usage" ? L("AI 用量分析", "AI USAGE ANALYTICS") : L("教師 Dashboard", "TEACHER DASHBOARD")}</span><h1>{initialReport === "ai-usage" ? L("学生提示层使用", "Student hint-layer usage") : L("班級學習進度", "Class learning progress")}</h1><p>{L("完成率、分數、學習時間、作答、AI 提示與常見錯誤均來自後端分析。", "Completion, scores, learning time, attempts, AI hints and common errors come from server analytics.")}</p></div><span className="prototype-chip">{loading ? L("同步中…", "Syncing…") : reports.overview ? new Date(reports.overview.snapshotAt).toLocaleString() : "—"}</span></div>
    <div className="analytics-filters"><label>{L("課程", "Course")}<select value={courseId} onChange={(event) => { setCourseId(event.target.value); setClassId(""); setStudentId(""); }}><option value="">—</option>{courses.map((course) => <option key={course.id} value={course.id}>{languageText(course.title_zh, course.title_en, L)}</option>)}</select></label><label>{L("班別（可選）", "Class (optional)")}<select value={classId} onChange={(event) => { setClassId(event.target.value); setCourseId(""); setStudentId(""); }}><option value="">{L("全部班別", "All classes")}</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>{L("學生（可選）", "Student (optional)")}<select value={studentId} onChange={(event) => setStudentId(event.target.value)}><option value="">{L("全部學生", "All students")}</option>{uniqueStudents.map((student) => <option key={student.studentId} value={student.studentId}>{languageText(student.chineseName ?? student.studentId, student.englishName, L)}</option>)}</select></label></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <section className="admin-metrics"><MetricBlock label={L("學生", "Students")} value={String(uniqueStudents.length)} note={L("目前範圍", "Current scope")} tone="teal" /><MetricBlock label={L("平均完成率", "Average completion")} value={`${uniqueStudents.length ? Math.round(uniqueStudents.reduce((sum, item) => sum + item.completionRate, 0) / uniqueStudents.length * 100) : 0}%`} note={L("已發布功課", "Published assignments")} tone="blue" /><MetricBlock label={L("AI 提示", "AI hints")} value={String(usage.reduce((sum, item) => sum + Number(item.requests ?? 0), 0))} note={`${usage.reduce((sum, item) => sum + Number(item.tokens ?? 0), 0)} tokens`} tone="amber" /><MetricBlock label={L("常見錯誤類型", "Common error types")} value={String(errors.length)} note={L("持久化測試結果", "Persisted test results")} tone="coral" /></section>
    <div className="analytics-dashboard-grid"><section className="settings-card"><h2>{L("學生明細", "Student detail")}</h2>{uniqueStudents.length ? <div className="analytics-table-wrap"><table><thead><tr><th>{L("學生", "Student")}</th><th>{L("完成率", "Completion")}</th><th>{L("平均分", "Average")}</th><th>{L("作答", "Attempts")}</th><th>{L("學習時間", "Learning time")}</th><th>{L("AI 提示", "AI hints")}</th></tr></thead><tbody>{uniqueStudents.map((student) => <tr key={student.studentId}><td>{languageText(student.chineseName ?? student.studentId, student.englishName, L)}</td><td>{Math.round(student.completionRate * 100)}%</td><td>{student.averageScore.toFixed(1)}</td><td>{student.attemptCount}</td><td>{Math.round(student.learningSeconds / 60)} min</td><td>{usage.filter((item) => item.userId === student.studentId).reduce((sum, item) => sum + item.requests, 0)}</td></tr>)}</tbody></table></div> : <p className="empty-copy">{loading ? L("正在載入…", "Loading…") : L("此範圍尚無學生紀錄。", "No student records in this scope.")}</p>}</section><section className="settings-card"><h2>{L("常見錯誤", "Common errors")}</h2>{errors.length ? <ul className="data-list">{errors.slice(0, 10).map((item, index) => <li key={`${item.title}-${index}`}><span><b>{item.title}</b><small>{item.status} · {item.errorCode}</small></span><strong>{item.occurrences}</strong></li>)}</ul> : <p className="empty-copy">{L("目前沒有已記錄的失敗測試。", "No failed tests are currently recorded.")}</p>}</section></div>
  </section>;
}

function TeacherWorkspace({ L, showToast, courses, onCoursesChanged, initialCourseId }: { L: Translator; showToast: (message: string) => void; courses: CourseDto[]; onCoursesChanged: (courses: CourseDto[]) => void; initialCourseId?: string }) {
  const [selectedCourseId, setSelectedCourseId] = useState(initialCourseId ?? "");
  const [units, setUnits] = useState<UnitDto[]>([]);
  const [materials, setMaterials] = useState<MaterialDto[]>([]);
  const [selectedMaterialUnitId, setSelectedMaterialUnitId] = useState("");
  const [questions, setQuestions] = useState<QuestionDto[]>([]);
  const [assignments, setAssignments] = useState<AssignmentDto[]>([]);
  useEffect(() => { if (initialCourseId) setSelectedCourseId(initialCourseId); }, [initialCourseId]);
  const [error, setError] = useState("");
  const [courseTitle, setCourseTitle] = useState("");
  const [unitTitle, setUnitTitle] = useState("");
  const [materialTitle, setMaterialTitle] = useState("");
  const [materialBody, setMaterialBody] = useState("");
  const [questionTitle, setQuestionTitle] = useState("");
  const [questionPrompt, setQuestionPrompt] = useState("");
  const [questionType, setQuestionType] = useState("python_code");
  const [questionOptions, setQuestionOptions] = useState("");
  const [questionAnswer, setQuestionAnswer] = useState("");
  const [starter, setStarter] = useState("");
  const [testVisibility, setTestVisibility] = useState("public");
  const [testInput, setTestInput] = useState("");
  const [testExpected, setTestExpected] = useState("");
  const [assignmentTitle, setAssignmentTitle] = useState("");
  const [rubricTitle, setRubricTitle] = useState("");

  useEffect(() => { if (!selectedCourseId && courses[0]) setSelectedCourseId(courses[0].id); }, [courses, selectedCourseId]);
  async function refreshCourse(courseId = selectedCourseId) {
    if (!courseId) return;
    try { const [unitResult, questionResult, assignmentResult] = await Promise.all([learningApi.units(courseId), learningApi.questions(courseId), learningApi.assignments(courseId)]); setUnits(unitResult.units); setQuestions(questionResult.questions); setAssignments(assignmentResult.assignments); if (!unitResult.units.some((unit) => unit.id === selectedMaterialUnitId)) setSelectedMaterialUnitId(unitResult.units.at(0)?.id ?? ""); const materialResults = await Promise.all(unitResult.units.map((unit) => learningApi.materials(unit.id))); setMaterials(materialResults.flatMap((result) => result.materials)); setError(""); } catch (caught) { setError(caught instanceof Error ? caught.message : L("內容資料載入失敗", "Content data could not be loaded")); }
  }
  useEffect(() => { void refreshCourse(); }, [selectedCourseId]);
  async function action(work: () => Promise<void>) { try { setError(""); await work(); } catch (caught) { setError(caught instanceof Error ? caught.message : L("操作失敗", "Operation failed")); } }
  async function createCourse(event: React.FormEvent) { event.preventDefault(); if (!courseTitle.trim()) return; await action(async () => { const result = await learningApi.createCourse({ titleZh: courseTitle.trim(), titleEn: courseTitle.trim(), status: "draft" }); onCoursesChanged([result.course, ...courses]); setSelectedCourseId(result.course.id); setCourseTitle(""); showToast(L("課程已建立", "Course created")); }); }
  async function createUnit(event: React.FormEvent) { event.preventDefault(); if (!unitTitle.trim() || !selectedCourseId) return; await action(async () => { await learningApi.createUnit(selectedCourseId, { titleZh: unitTitle.trim(), titleEn: unitTitle.trim() }); setUnitTitle(""); await refreshCourse(); showToast(L("單元已建立", "Unit created")); }); }
  async function createMaterial(event: React.FormEvent) { event.preventDefault(); if (!materialTitle.trim() || !selectedMaterialUnitId) return; await action(async () => { await learningApi.createMaterial(selectedMaterialUnitId, { kind: "web_content", titleZh: materialTitle.trim(), titleEn: materialTitle.trim(), bodyZh: materialBody, bodyEn: materialBody }); setMaterialTitle(""); setMaterialBody(""); await refreshCourse(); showToast(L("教材已建立為草稿", "Material draft created")); }); }
  async function createQuestion(event: React.FormEvent) { event.preventDefault(); if (!questionTitle.trim() || !questionPrompt.trim() || !selectedCourseId) return; await action(async () => { let optionsJson: unknown; let answerKeyJson: unknown; if (questionOptions.trim()) optionsJson = JSON.parse(questionOptions); if (questionAnswer.trim()) answerKeyJson = JSON.parse(questionAnswer); const result = await learningApi.createQuestion({ courseId: selectedCourseId, unitId: units.at(0)?.id, type: questionType, titleZh: questionTitle.trim(), titleEn: questionTitle.trim(), promptZh: questionPrompt.trim(), promptEn: questionPrompt.trim(), optionsJson, answerKeyJson, starterCode: starter || undefined, maxScore: 1, sharingScope: "course" }); if (["python_code", "code_fill"].includes(questionType) && testExpected.trim()) await learningApi.addTestCase(result.question.id, { visibility: testVisibility, inputJson: testInput ? JSON.parse(testInput) : null, expectedOutput: testExpected.trim(), label: testVisibility === "hidden" ? "Hidden test" : "Public test" }); setQuestionTitle(""); setQuestionPrompt(""); setQuestionOptions(""); setQuestionAnswer(""); setStarter(""); await refreshCourse(); showToast(L("題目已建立為草稿", "Question draft created")); }); }
  async function createAssignment(event: React.FormEvent) { event.preventDefault(); if (!assignmentTitle.trim() || !selectedCourseId) return; await action(async () => { const result = await learningApi.createAssignment({ courseId: selectedCourseId, unitId: units.at(0)?.id, titleZh: assignmentTitle.trim(), titleEn: assignmentTitle.trim(), kind: "homework", maxAttempts: 1, showScoreImmediately: true, showTestResultsImmediately: true }); const firstQuestion = questions[0]; if (firstQuestion) await learningApi.addAssignmentQuestion(result.assignment.id, firstQuestion.id); setAssignmentTitle(""); await refreshCourse(); showToast(L("功課已建立，請在政策面板設定後發布", "Assignment created; configure it in the policy panel before publishing")); }); }
  const selectedCourse = courses.find((course) => course.id === selectedCourseId);
  return <div className="teacher-page"><div className="page-heading"><div><span className="grade-tag">{L("教師管理工作台", "TEACHER WORKSPACE")}</span><h1>{selectedCourse ? languageText(selectedCourse.title_zh, selectedCourse.title_en, L) : L("尚未選擇課程", "No course selected")}</h1><p>{L("課程 → 單元 → 教材 → 題目 → 功課，所有資料由後端 API 驅動。", "Course → unit → material → question → assignment, all driven by the backend API.")}</p></div><select aria-label={L("選擇課程", "Select course")} value={selectedCourseId} onChange={(event) => setSelectedCourseId(event.target.value)}><option value="">{L("選擇課程", "Select course")}</option>{courses.map((course) => <option key={course.id} value={course.id}>{languageText(course.title_zh, course.title_en, L)} · {course.status}</option>)}</select></div>{error && <p role="alert" className="form-error">{error}</p>}<div className="teacher-workspace-grid"><section className="settings-card"><h2>{L("課程與單元", "Courses and units")}</h2><form onSubmit={createCourse}><label>{L("新課程名稱", "New course title")}<input aria-label={L("新課程名稱", "New course title")} value={courseTitle} onChange={(event) => setCourseTitle(event.target.value)} /></label><button type="submit" disabled={!courseTitle.trim()}>{L("建立課程", "Create course")}</button></form><form onSubmit={createUnit}><label>{L("新單元名稱", "New unit title")}<input aria-label={L("新單元名稱", "New unit title")} value={unitTitle} onChange={(event) => setUnitTitle(event.target.value)} /></label><button type="submit" disabled={!selectedCourseId || !unitTitle.trim()}>{L("建立單元", "Create unit")}</button></form><ul className="data-list">{units.map((unit) => <li key={unit.id}>{languageText(unit.title_zh, unit.title_en, L)}</li>)}</ul><button type="button" disabled={!selectedCourseId} onClick={() => void action(async () => { await learningApi.updateCourse(selectedCourseId, { status: selectedCourse?.status === "published" ? "draft" : "published" }); const result = await learningApi.courses(); onCoursesChanged(result.courses); showToast(L("課程狀態已更新", "Course status updated")); })}>{selectedCourse?.status === "published" ? L("改為草稿", "Set draft") : L("發布課程", "Publish course")}</button></section><section className="settings-card"><h2>{L("教材", "Materials")}</h2><form onSubmit={createMaterial}><label>{L("教材標題", "Material title")}<input aria-label={L("教材標題", "Material title")} value={materialTitle} onChange={(event) => setMaterialTitle(event.target.value)} /></label><label>{L("教材內容", "Material body")}<textarea aria-label={L("教材內容", "Material body")} value={materialBody} onChange={(event) => setMaterialBody(event.target.value)} /></label><button type="submit" disabled={!selectedMaterialUnitId || !materialTitle.trim()}>{L("建立教材草稿", "Create material draft")}</button></form><ul className="data-list">{materials.map((material) => <li key={material.id}><span>{languageText(material.title_zh, material.title_en, L)} · {material.status ?? "draft"}</span>{material.status !== "published" && <button type="button" onClick={() => void action(async () => { await learningApi.updateMaterial(material.id, { status: "published" }); await refreshCourse(); })}>{L("發布", "Publish")}</button>}</li>)}</ul><p className="empty-copy">{L("文字教材可在此快速建立；檔案教材請使用下方教師教材中心。", "Create text materials here; use the Teacher Materials section below for file assets.")}</p></section><section className="settings-card"><h2>{L("題庫與 rubric", "Question bank and rubric")}</h2><form onSubmit={createQuestion}><label>{L("題目標題", "Question title")}<input aria-label={L("題目標題", "Question title")} value={questionTitle} onChange={(event) => setQuestionTitle(event.target.value)} /></label><label>{L("題目內容", "Prompt")}<textarea aria-label={L("題目內容", "Prompt")} value={questionPrompt} onChange={(event) => setQuestionPrompt(event.target.value)} /></label><label>{L("題型", "Type")}<select aria-label={L("題型", "Type")} value={questionType} onChange={(event) => setQuestionType(event.target.value)}>{["multiple_choice", "fill_blank", "short_answer", "code_fill", "python_code", "file_upload", "project_upload"].map((type) => <option key={type} value={type}>{type}</option>)}</select></label><label>{L("選項 JSON（選擇題）", "Options JSON (multiple choice)")}<input aria-label={L("選項 JSON（選擇題）", "Options JSON (multiple choice)")} value={questionOptions} onChange={(event) => setQuestionOptions(event.target.value)} /></label><label>{L("答案 JSON（教師專用）", "Answer JSON (teacher only)")}<input aria-label={L("答案 JSON（教師專用）", "Answer JSON (teacher only)")} value={questionAnswer} onChange={(event) => setQuestionAnswer(event.target.value)} /></label>{["code_fill", "python_code"].includes(questionType) && <><label>{L("起始程式", "Starter code")}<textarea value={starter} onChange={(event) => setStarter(event.target.value)} /></label><label>{L("測試案例可見性", "Test visibility")}<select value={testVisibility} onChange={(event) => setTestVisibility(event.target.value)}><option value="public">public</option><option value="hidden">hidden</option></select></label><label>{L("測試輸入 JSON", "Test input JSON")}<input value={testInput} onChange={(event) => setTestInput(event.target.value)} /></label><label>{L("預期輸出", "Expected output")}<input value={testExpected} onChange={(event) => setTestExpected(event.target.value)} /></label></>}<button type="submit" disabled={!selectedCourseId || !questionTitle.trim() || !questionPrompt.trim()}>{L("建立題目草稿", "Create question draft")}</button></form><ul className="data-list">{questions.map((question) => <li key={question.id}><span>{question.title_zh} · {question.type} · {question.status}</span>{question.status !== "published" && <button type="button" onClick={() => void action(async () => { await learningApi.updateQuestion(question.id, { status: "published" }); await refreshCourse(); })}>{L("發布", "Publish")}</button>}</li>)}</ul><input aria-label={L("Rubric 名稱", "Rubric title")} placeholder={L("Rubric 名稱（可選）", "Rubric title (optional)")} value={rubricTitle} onChange={(event) => setRubricTitle(event.target.value)} /><button type="button" disabled={!selectedCourseId || !rubricTitle.trim()} onClick={() => void action(async () => { await learningApi.createRubric({ courseId: selectedCourseId, titleZh: rubricTitle, titleEn: rubricTitle }); setRubricTitle(""); showToast(L("Rubric 已建立", "Rubric created")); })}>{L("建立 rubric", "Create rubric")}</button></section><section className="settings-card"><h2>{L("功課", "Assignments")}</h2><form onSubmit={createAssignment}><label>{L("功課標題", "Assignment title")}<input aria-label={L("功課標題", "Assignment title")} value={assignmentTitle} onChange={(event) => setAssignmentTitle(event.target.value)} /></label><button type="submit" disabled={!selectedCourseId || !assignmentTitle.trim()}>{L("建立功課草稿", "Create assignment draft")}</button></form><ul className="data-list">{assignments.map((assignment) => <li key={assignment.id}><span>{assignment.title_zh} · {assignment.status}</span>{assignment.status !== "published" && <button type="button" onClick={() => void action(async () => { await learningApi.updateAssignment(assignment.id, { status: "published" }); await refreshCourse(); })}>{L("發布", "Publish")}</button>}</li>)}</ul></section></div></div>;
}

function TeacherAnnouncements({ L, courses, showToast }: { L: Translator; courses: CourseDto[]; showToast: (message: string) => void }) {
  const [items, setItems] = useState<AnnouncementDto[]>([]);
  const [classes, setClasses] = useState<ClassDto[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [audience, setAudience] = useState<"course" | "class">("course");
  const [audienceId, setAudienceId] = useState("");
  const [title, setTitle] = useState("");
  const [titleEn, setTitleEn] = useState("");
  const [body, setBody] = useState("");
  const [bodyEn, setBodyEn] = useState("");
  const [publishAt, setPublishAt] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [sendEmail, setSendEmail] = useState(true);
  const [preview, setPreview] = useState<{ recipientCount: number; emailCount: number } | null>(null);
  const [error, setError] = useState("");
  const selected = items.find((item) => item.id === selectedId);
  async function refresh() {
    try { const [announcementResult, classResult] = await Promise.all([learningApi.announcements(), learningApi.classes()]); setItems(announcementResult.announcements); setClasses(classResult.classes); setError(""); }
    catch (caught) { setError(caught instanceof Error ? caught.message : L("公告資料載入失敗", "Announcements could not be loaded")); }
  }
  useEffect(() => { void refresh(); }, []);
  function select(item: AnnouncementDto) { setSelectedId(item.id); setAudience(item.course_id ? "course" : "class"); setAudienceId(item.course_id ?? item.class_id ?? ""); setTitle(item.title_zh); setTitleEn(item.title_en ?? ""); setBody(item.body_zh); setBodyEn(item.body_en ?? ""); setPublishAt(item.publish_at ? item.publish_at.slice(0, 16) : ""); setExpiresAt(item.expires_at ? item.expires_at.slice(0, 16) : ""); setPreview(null); }
  async function save(event: React.FormEvent) { event.preventDefault(); try { const payload = { titleZh: title, titleEn: titleEn || undefined, bodyZh: body, bodyEn: bodyEn || undefined, publishAt: publishAt || undefined, expiresAt: expiresAt || undefined, ...(audience === "course" ? { courseId: audienceId } : { classId: audienceId }) }; if (selected?.status === "draft") await learningApi.updateAnnouncement(selected.id, payload); else { const result = await learningApi.createAnnouncement(payload); setSelectedId(result.announcement.id); } await refresh(); showToast(L("公告草稿已保存", "Announcement draft saved")); } catch (caught) { setError(caught instanceof Error ? caught.message : L("保存公告失敗", "Could not save announcement")); } }
  async function previewAnnouncement() { if (!selectedId) return; try { setPreview(await learningApi.previewAnnouncement(selectedId)); } catch (caught) { setError(caught instanceof Error ? caught.message : L("預覽失敗", "Preview failed")); } }
  async function publish() { if (!selectedId) return; try { await learningApi.publishAnnouncement(selectedId, sendEmail); await refresh(); showToast(sendEmail ? L("公告已發布並加入 email outbox", "Announcement published and queued for email") : L("公告已發布，未加入 email outbox", "Announcement published without email")); } catch (caught) { setError(caught instanceof Error ? caught.message : L("發布公告失敗", "Could not publish announcement")); } }
  return <section className="settings-card announcement-centre"><div className="page-heading"><div><span className="grade-tag">{L("公告與通知", "ANNOUNCEMENTS")}</span><h2>{L("教師公告工作台", "Teacher announcement desk")}</h2><p>{L("先保存草稿，再預覽收件 scope，確認後發布。", "Save a draft, preview the recipient scope, then publish when ready.")}</p></div></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="teacher-workspace-grid"><form className="form-grid" onSubmit={save}><label>{L("收件範圍", "Recipient scope")}<select value={audience} onChange={(event) => { setAudience(event.target.value as "course" | "class"); setAudienceId(""); }}><option value="course">{L("課程學生", "Course students")}</option><option value="class">{L("指定班別", "Specific class")}</option></select></label><label>{audience === "course" ? L("課程", "Course") : L("班別", "Class")}<select value={audienceId} onChange={(event) => setAudienceId(event.target.value)} required><option value="">—</option>{(audience === "course" ? courses : classes).map((item) => <option key={item.id} value={item.id}>{audience === "course" ? (item as CourseDto).title_zh : (item as ClassDto).name}</option>)}</select></label><label>{L("中文標題", "Chinese title")}<input value={title} onChange={(event) => setTitle(event.target.value)} required /></label><label>{L("英文標題", "English title")}<input value={titleEn} onChange={(event) => setTitleEn(event.target.value)} /></label><label className="full-field">{L("中文內容", "Chinese body")}<textarea rows={5} value={body} onChange={(event) => setBody(event.target.value)} required /></label><label className="full-field">{L("英文內容", "English body")}<textarea rows={5} value={bodyEn} onChange={(event) => setBodyEn(event.target.value)} /></label><label>{L("預定發布（可選）", "Scheduled publish (optional)")}<input type="datetime-local" value={publishAt} onChange={(event) => setPublishAt(event.target.value)} /></label><label>{L("到期時間（可選）", "Expiry (optional)")}<input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label><label className="checkbox-field"><input type="checkbox" checked={sendEmail} onChange={(event) => setSendEmail(event.target.checked)} />{L("發布時加入 email outbox", "Queue email on publish")}</label><div className="editor-controls"><button type="submit">{selected?.status === "draft" ? L("更新草稿", "Update draft") : L("保存草稿", "Save draft")}</button><button type="button" className="secondary-action" disabled={!selectedId} onClick={() => void previewAnnouncement()}>{L("預覽收件人", "Preview recipients")}</button><button type="button" disabled={!selectedId || selected?.status !== "draft"} onClick={() => void publish()}>{L("發布公告", "Publish")}</button></div>{preview && <p className="form-note" role="status">{sendEmail ? L(`將通知 ${preview.recipientCount} 位學生，${preview.emailCount} 封 email`, `${preview.recipientCount} students and ${preview.emailCount} emails will be queued`) : L(`將通知 ${preview.recipientCount} 位學生，不會寄送 email`, `${preview.recipientCount} students; no email will be queued`)}</p>}</form><div><h3>{L("現有公告", "Announcements")}</h3><ul className="data-list">{items.map((item) => <li key={item.id}><button type="button" className="data-row-button" onClick={() => select(item)}><b>{item.title_zh}</b><small>{item.status} · {item.recipient_count ?? 0} recipients</small></button></li>)}</ul>{!items.length && <p className="empty-copy">{L("尚未建立公告草稿。", "No announcements yet.")}</p>}</div></div></section>;
}

function AdminEmailOps({ L, showToast }: { L: Translator; showToast: (message: string) => void }) {
  const [deliveries, setDeliveries] = useState<EmailDeliveryDto[]>([]);
  const [settings, setSettings] = useState<EmailSettingsDto | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [form, setForm] = useState({ enabled: false, host: "", port: "587", tlsMode: "starttls" as EmailSettingsDto["tlsMode"], username: "", from: "", password: "" });
  const [error, setError] = useState("");
  async function refresh() { try { const [deliveryResult, settingResult] = await Promise.all([learningApi.emailDeliveries(statusFilter || undefined), learningApi.emailSettings()]); setDeliveries(deliveryResult.deliveries); setSettings(settingResult.settings); setForm((current) => ({ ...current, enabled: settingResult.settings.enabled, host: settingResult.settings.host, port: String(settingResult.settings.port || 587), tlsMode: settingResult.settings.tlsMode, username: settingResult.settings.username, from: settingResult.settings.from, password: "" })); setError(""); } catch (caught) { setError(caught instanceof Error ? caught.message : L("Email outbox 載入失敗", "Email outbox could not be loaded")); } }
  useEffect(() => { void refresh(); }, [statusFilter]);
  async function process() { try { await learningApi.processEmail(); await refresh(); showToast(L("Email queue 已處理", "Email queue processed")); } catch (caught) { setError(caught instanceof Error ? caught.message : L("Email queue 處理失敗", "Email queue processing failed")); } }
  async function retry(id: string) { try { await learningApi.retryEmail(id); await refresh(); showToast(L("已重新排入 email queue", "Email requeued")); } catch (caught) { setError(caught instanceof Error ? caught.message : L("重試失敗", "Retry failed")); } }
  async function saveSettings(event: React.FormEvent) { event.preventDefault(); try { await learningApi.updateEmailSettings({ enabled: form.enabled, host: form.host, port: Number(form.port), tlsMode: form.tlsMode, username: form.username, from: form.from, ...(form.password ? { password: form.password } : {}) }); setForm((current) => ({ ...current, password: "" })); await refresh(); showToast(L("Email 設定已保存", "Email settings saved")); } catch (caught) { setError(caught instanceof Error ? caught.message : L("Email 設定保存失敗", "Email settings could not be saved")); } }
  async function cancel(id: string) { try { await learningApi.cancelEmail(id); await refresh(); showToast(L("Email 已取消", "Email cancelled")); } catch (caught) { setError(caught instanceof Error ? caught.message : L("取消失敗", "Cancel failed")); } }
  return <section className="settings-card email-ops"><div className="page-heading"><div><span className="grade-tag">EMAIL OPS</span><h2>{L("Email Outbox", "Email Outbox")}</h2><p>{L("只顯示狀態與重試操作，不會顯示 SMTP 密碼。", "View delivery state and retry failed messages without exposing SMTP passwords.")}</p></div><button type="button" onClick={() => void process()}>{L("處理 queue", "Process queue")}</button></div>{error && <p className="form-error" role="alert">{error}</p>}<form className="form-grid" onSubmit={saveSettings}><label className="checkbox-field"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))} />{L("啟用 SMTP", "Enable SMTP")}</label><label>{L("主機", "Host")}<input value={form.host} onChange={(event) => setForm((current) => ({ ...current, host: event.target.value }))} /></label><label>{L("Port", "Port")}<input type="number" min="1" max="65535" value={form.port} onChange={(event) => setForm((current) => ({ ...current, port: event.target.value }))} /></label><label>{L("TLS", "TLS")}<select value={form.tlsMode} onChange={(event) => setForm((current) => ({ ...current, tlsMode: event.target.value as EmailSettingsDto["tlsMode"] }))}><option value="none">none</option><option value="starttls">STARTTLS</option><option value="tls">TLS</option></select></label><label>{L("帳戶", "Username")}<input value={form.username} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} /></label><label>{L("寄件人", "From")}<input type="email" value={form.from} onChange={(event) => setForm((current) => ({ ...current, from: event.target.value }))} /></label><label>{L("替換密碼（可選）", "Replacement password (optional)")}<input type="password" autoComplete="new-password" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} placeholder={settings?.passwordConfigured ? L("已配置；留空以保留", "Configured; leave blank to keep") : ""} /></label><button type="submit">{L("保存 SMTP 設定", "Save SMTP settings")}</button></form><p className="form-note">{settings ? `${settings.enabled ? L("已啟用", "Enabled") : L("已停用", "Disabled")} · ${settings.configured ? L("已配置", "Configured") : L("未配置", "Not configured")} · ${settings.passwordConfigured ? L("密碼已配置", "Password configured") : L("未配置密碼", "Password not configured")}` : L("正在讀取設定…", "Loading settings…")}</p><div className="page-heading"><h3>{L("Delivery 狀態", "Delivery status")}</h3><select aria-label={L("Delivery 狀態篩選", "Delivery status filter")} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">{L("全部", "All")}</option>{["queued", "sending", "sent", "failed", "suppressed", "bounced", "cancelled"].map((status) => <option key={status} value={status}>{status}</option>)}</select></div><ul className="data-list">{deliveries.map((delivery) => <li key={delivery.id}><span><b>{delivery.recipient_email}</b><small>{delivery.status} · attempts {delivery.attempt_count} · {delivery.last_error_code ?? "—"}</small></span>{delivery.status === "failed" && <button type="button" onClick={() => void retry(delivery.id)}>{L("重試", "Retry")}</button>}{["queued", "failed"].includes(delivery.status) && <button type="button" className="secondary-action" onClick={() => void cancel(delivery.id)}>{L("取消", "Cancel")}</button>}</li>)}</ul>{!deliveries.length && <p className="empty-copy">{L("目前沒有 email delivery。", "No email deliveries yet.")}</p>}</section>;
}

function TeacherClassManager({ L, courses, showToast }: { L: Translator; courses: CourseDto[]; showToast: (message: string) => void }) {
  const [classes, setClasses] = useState<ClassDto[]>([]);
  const [students, setStudents] = useState<UserDto[]>([]);
  const [classId, setClassId] = useState("");
  const [courseId, setCourseId] = useState("");
  const [studentId, setStudentId] = useState("");
  const [members, setMembers] = useState<UserDto[]>([]);
  const [error, setError] = useState("");
  async function refresh() { try { const [classResult, studentResult] = await Promise.all([learningApi.classes(), learningApi.users("student")]); setClasses(classResult.classes); setStudents(studentResult.users); if (classId) setMembers((await learningApi.classMembers(classId)).members); setError(""); } catch (caught) { setError(caught instanceof Error ? caught.message : L("班別資料載入失敗", "Class data could not be loaded")); } }
  useEffect(() => { void refresh(); }, [classId]);
  const course = courses.find((item) => item.id === courseId);
  return <section className="settings-card teacher-class-manager"><div className="page-heading"><div><span className="grade-tag">{L("班別與學生", "CLASSES & STUDENTS")}</span><h2>{L("整班加入課程", "Add a whole class to a course")}</h2></div></div>{error && <p role="alert" className="form-error">{error}</p>}<div className="form-grid"><label>{L("班別", "Class")}<select value={classId} onChange={(event) => setClassId(event.target.value)}><option value="">—</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.academic_year}</option>)}</select></label><label>{L("學生", "Student")}<select value={studentId} onChange={(event) => setStudentId(event.target.value)}><option value="">—</option>{students.map((student) => <option key={student.id} value={student.id}>{student.chinese_name} · {student.student_number}</option>)}</select></label><button type="button" disabled={!classId || !studentId} onClick={() => void learningApi.addClassMember(classId, studentId).then(() => { showToast(L("學生已加入班別", "Student added to class")); return refresh(); }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : L("加入失敗", "Add failed")))}>{L("加入學生", "Add student")}</button><label>{L("課程", "Course")}<select value={courseId} onChange={(event) => setCourseId(event.target.value)}><option value="">—</option>{courses.map((item) => <option key={item.id} value={item.id}>{languageText(item.title_zh, item.title_en, L)}</option>)}</select></label><button type="button" disabled={!classId || !courseId} onClick={() => void learningApi.assignClassToCourse(courseId, classId).then(() => showToast(L("整班已加入課程", "Class assigned to course"))).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : L("加入失敗", "Assignment failed")))}>{L("整班加入課程", "Assign class")}</button>{course && <p><b>{L("課程代碼", "Join code")}: </b><code>{course.join_code ?? L("未設定", "Not set")}</code></p>}</div><ul className="data-list">{members.filter((member) => member.role === "student").map((member) => <li key={member.id}>{member.chinese_name} · {member.student_number}</li>)}</ul></section>;
}

function TeacherAssignmentPolicy({ L, courses, showToast }: { L: Translator; courses: CourseDto[]; showToast: (message: string) => void }) {
  const [courseId, setCourseId] = useState("");
  const [items, setItems] = useState<AssignmentDto[]>([]);
  const [assignmentId, setAssignmentId] = useState("");
  const [publishAt, setPublishAt] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [answerReleaseAt, setAnswerReleaseAt] = useState("");
  const [maxAttempts, setMaxAttempts] = useState(1);
  const [allowLate, setAllowLate] = useState(false);
  const [allowResubmit, setAllowResubmit] = useState(false);
  const [randomizeOrder, setRandomizeOrder] = useState(false);
  const [showScoreImmediately, setShowScoreImmediately] = useState(true);
  const [showTestResultsImmediately, setShowTestResultsImmediately] = useState(true);
  const [questionCount, setQuestionCount] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => { if (!courseId && courses[0]) setCourseId(courses[0].id); }, [courses, courseId]);
  useEffect(() => { if (!courseId) return; learningApi.assignments(courseId).then((result) => setItems(result.assignments)).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : L("功課載入失敗", "Assignments could not be loaded"))); }, [courseId]);
  function choose(id: string) { setAssignmentId(id); const item = items.find((assignment) => assignment.id === id); if (!item) return; const local = (value?: string | null) => value ? new Date(value).toISOString().slice(0, 16) : ""; setPublishAt(local(item.publish_at)); setDueAt(local(item.due_at)); setAnswerReleaseAt(local(item.answer_release_at)); setMaxAttempts(item.max_attempts); setAllowLate(Boolean(item.allow_late)); setAllowResubmit(Boolean(item.allow_resubmit)); setRandomizeOrder(Boolean(item.randomize_order)); setShowScoreImmediately(item.show_score_immediately === undefined ? true : Boolean(item.show_score_immediately)); setShowTestResultsImmediately(item.show_test_results_immediately === undefined ? true : Boolean(item.show_test_results_immediately)); setQuestionCount(item.question_selection_count ?? 0); }
  async function save(event: React.FormEvent) { event.preventDefault(); try { await learningApi.updateAssignment(assignmentId, { publishAt: publishAt ? new Date(publishAt).toISOString() : null, dueAt: dueAt ? new Date(dueAt).toISOString() : null, answerReleaseAt: answerReleaseAt ? new Date(answerReleaseAt).toISOString() : null, maxAttempts, allowLate, allowResubmit, randomizeOrder, questionSelectionCount: questionCount || null, showScoreImmediately, showTestResultsImmediately }); showToast(L("功課政策已保存", "Assignment policy saved")); setItems((await learningApi.assignments(courseId)).assignments); } catch (caught) { setError(caught instanceof Error ? caught.message : L("政策保存失敗", "Policy save failed")); } }
  return <section className="settings-card assignment-policy"><div className="page-heading"><div><span className="grade-tag">{L("功課政策", "ASSIGNMENT POLICY")}</span><h2>{L("發布、截止與重交", "Release, deadline and resubmission")}</h2></div></div>{error && <p role="alert" className="form-error">{error}</p>}<form className="form-grid" onSubmit={save}><label>{L("課程", "Course")}<select value={courseId} onChange={(event) => { setCourseId(event.target.value); setAssignmentId(""); }}><option value="">—</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.title_zh}</option>)}</select></label><label>{L("功課", "Assignment")}<select value={assignmentId} onChange={(event) => choose(event.target.value)}><option value="">—</option>{items.map((item) => <option key={item.id} value={item.id}>{item.title_zh}</option>)}</select></label><label>{L("發布時間", "Publish time")}<input type="datetime-local" value={publishAt} onChange={(event) => setPublishAt(event.target.value)} /></label><label>{L("截止時間", "Due time")}<input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label><label>{L("答案公布時間", "Answer release time")}<input type="datetime-local" value={answerReleaseAt} onChange={(event) => setAnswerReleaseAt(event.target.value)} /></label><label>{L("最多作答次數", "Maximum attempts")}<input type="number" min="1" value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))} /></label><label>{L("抽題數（0=全部）", "Question count (0=all)")}<input type="number" min="0" value={questionCount} onChange={(event) => setQuestionCount(Number(event.target.value))} /></label><label><input type="checkbox" checked={allowLate} onChange={(event) => setAllowLate(event.target.checked)} />{L("允許逾期", "Allow late")}</label><label><input type="checkbox" checked={allowResubmit} onChange={(event) => setAllowResubmit(event.target.checked)} />{L("允許補交／重交", "Allow resubmission")}</label><label><input type="checkbox" checked={randomizeOrder} onChange={(event) => setRandomizeOrder(event.target.checked)} />{L("隨機排列題目", "Randomize questions")}</label><label><input type="checkbox" checked={showScoreImmediately} onChange={(event) => setShowScoreImmediately(event.target.checked)} />{L("提交後立即顯示分數", "Show score immediately after submission")}</label><label><input type="checkbox" checked={showTestResultsImmediately} onChange={(event) => setShowTestResultsImmediately(event.target.checked)} />{L("提交後立即顯示測試結果", "Show test results immediately after submission")}</label><button type="submit" disabled={!assignmentId}>{L("保存政策", "Save policy")}</button></form></section>;
}

function TeacherAiReviewQueue({ L, courses, showToast }: { L: Translator; courses: CourseDto[]; showToast: (message: string) => void }) {
  const [courseId, setCourseId] = useState("");
  const [artifacts, setArtifacts] = useState<AiArtifactDto[]>([]);
  const [selected, setSelected] = useState<(AiArtifactDto & { content?: unknown }) | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { if (!courseId && courses[0]) setCourseId(courses[0].id); }, [courses, courseId]);
  async function refresh() { if (!courseId) return; try { setArtifacts((await learningApi.aiArtifacts(courseId)).artifacts); setError(""); } catch (caught) { setError(caught instanceof Error ? caught.message : L("AI 審核佇列載入失敗", "AI review queue could not be loaded")); } }
  useEffect(() => { void refresh(); }, [courseId]);
  async function choose(id: string) { try { setSelected((await learningApi.aiArtifact(id)).artifact); setError(""); } catch (caught) { setError(caught instanceof Error ? caught.message : L("預覽載入失敗", "Preview could not be loaded")); } }
  async function decide(decision: "approved" | "rejected") { if (!selected) return; try { const result = await learningApi.reviewAiArtifact(selected.id, decision, comment || undefined); setSelected(result.artifact); setComment(""); await refresh(); showToast(decision === "approved" ? L("AI 產物已批准", "AI artifact approved") : L("AI 產物已拒絕", "AI artifact rejected")); } catch (caught) { setError(caught instanceof Error ? caught.message : L("審核失敗", "Review failed")); } }
  async function publish() { if (!selected) return; try { const result = await learningApi.publishAiArtifact(selected.id); setSelected(result.artifact); await refresh(); showToast(L("已發布經教師確認的 AI 內容", "Teacher-approved AI content published")); } catch (caught) { setError(caught instanceof Error ? caught.message : L("發布失敗", "Publish failed")); } }
  return <section className="settings-card ai-review-queue"><div className="page-heading"><div><span className="grade-tag">{L("教師確認", "TEACHER REVIEW")}</span><h2>{L("AI 產物審核佇列", "AI artifact review queue")}</h2><p>{L("未批准內容不會向學生發布或計入正式成績。", "Unapproved content is never published to students or counted as a final grade.")}</p></div></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="editor-controls"><label>{L("課程", "Course")}<select value={courseId} onChange={(event) => { setCourseId(event.target.value); setSelected(null); }}><option value="">—</option>{courses.map((course) => <option key={course.id} value={course.id}>{languageText(course.title_zh, course.title_en, L)}</option>)}</select></label><label>{L("待審項目", "Review item")}<select value={selected?.id ?? ""} onChange={(event) => void choose(event.target.value)}><option value="">—</option>{artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.artifact_type} · {artifact.status}</option>)}</select></label></div>{!artifacts.length && <p className="empty-copy">{L("目前沒有 AI 產物。這不代表外部 AI 已配置。", "There are no AI artifacts. This does not imply an external AI provider is configured.")}</p>}{selected && <div className="editor-form"><strong>{selected.artifact_type} · {selected.status}</strong><pre className="artifact-preview">{JSON.stringify(selected.content ?? {}, null, 2)}</pre>{selected.status === "pending_review" && <><label>{L("審核備註", "Review comment")}<textarea value={comment} onChange={(event) => setComment(event.target.value)} /></label><div className="editor-controls"><button type="button" onClick={() => void decide("approved")}>{L("批准", "Approve")}</button><button type="button" className="secondary-action" onClick={() => void decide("rejected")}>{L("拒絕", "Reject")}</button></div></>}{selected.status === "approved" && <button type="button" onClick={() => void publish()}>{L("發布已批准內容", "Publish approved content")}</button>}</div>}</section>;
}

function TeacherHintManager({ L, courses, showToast }: { L: Translator; courses: CourseDto[]; showToast: (message: string) => void }) {
  const [courseId, setCourseId] = useState("");
  const [questions, setQuestions] = useState<QuestionDto[]>([]);
  const [questionId, setQuestionId] = useState("");
  const [hints, setHints] = useState<QuestionHintDto[]>([]);
  const [maxLayers, setMaxLayers] = useState(3);
  const [level, setLevel] = useState(1);
  const [contentZh, setContentZh] = useState("");
  const [contentEn, setContentEn] = useState("");
  const [source, setSource] = useState<"manual" | "ai">("manual");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (!courseId && courses[0]) setCourseId(courses[0].id); }, [courseId, courses]);
  useEffect(() => {
    if (!courseId) return;
    learningApi.questions(courseId).then(({ questions: rows }) => { setQuestions(rows); setQuestionId((current) => rows.some((item) => item.id === current) ? current : rows[0]?.id ?? ""); setError(""); }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : L("題目載入失敗", "Questions could not be loaded")));
  }, [courseId]);
  async function refreshHints(id = questionId) {
    if (!id) { setHints([]); return; }
    try { const result = await learningApi.questionHints(id); setHints(result.hints); setMaxLayers(result.maxHintLayers); setError(""); }
    catch (caught) { setError(caught instanceof Error ? caught.message : L("提示載入失敗", "Hints could not be loaded")); }
  }
  useEffect(() => { void refreshHints(); }, [questionId]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!questionId || !contentZh.trim()) return;
    setBusy(true); setError("");
    try { await learningApi.saveQuestionHint(questionId, { level, contentZh, contentEn: contentEn || undefined, source }); setContentZh(""); setContentEn(""); await refreshHints(); showToast(source === "ai" ? L("AI 提示草稿已保存，必須批准後才可見", "AI hint draft saved; approval is required") : L("手寫提示已發布", "Manual hint published")); }
    catch (caught) { setError(caught instanceof Error ? caught.message : L("提示保存失敗", "Hint could not be saved")); }
    finally { setBusy(false); }
  }
  async function generate() {
    if (!questionId) return; setBusy(true); setError("");
    try { await learningApi.generateQuestionHint(questionId, level); await refreshHints(); showToast(L("AI 已產生草稿，請教師審核", "AI draft generated; teacher review is required")); }
    catch (caught) { setError(caught instanceof Error ? caught.message : L("AI 供應商未配置或產生失敗", "AI provider is unavailable or generation failed")); }
    finally { setBusy(false); }
  }
  return <section className="settings-card hint-manager"><div className="page-heading"><div><span className="grade-tag">{L("逐層提示", "PROGRESSIVE HINTS")}</span><h2>{L("題目提示管理", "Question hint management")}</h2><p>{L("手寫提示可直接批准；AI 產生或標記的內容永遠先成為草稿。刪除高層提示可降低該題的可用層數。", "Manual hints can be approved immediately; AI-authored content always starts as a draft. Remove upper layers to reduce a question's available depth.")}</p></div></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="editor-controls"><label>{L("課程", "Course")}<select value={courseId} onChange={(event) => setCourseId(event.target.value)}><option value="">—</option>{courses.map((course) => <option key={course.id} value={course.id}>{languageText(course.title_zh, course.title_en, L)}</option>)}</select></label><label>{L("題目", "Question")}<select value={questionId} onChange={(event) => setQuestionId(event.target.value)}><option value="">—</option>{questions.map((question) => <option key={question.id} value={question.id}>{question.title_zh}</option>)}</select></label></div><form className="form-grid" onSubmit={save}><label>{L("層級", "Level")}<select value={level} onChange={(event) => setLevel(Number(event.target.value))}>{Array.from({ length: maxLayers }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label>{L("來源", "Source")}<select value={source} onChange={(event) => setSource(event.target.value as "manual" | "ai")}><option value="manual">{L("教師手寫", "Teacher-written")}</option><option value="ai">{L("AI 草稿（需審核）", "AI draft (review required)")}</option></select></label><label>{L("中文提示", "Chinese hint")}<textarea value={contentZh} onChange={(event) => setContentZh(event.target.value)} required /></label><label>{L("英文提示", "English hint")}<textarea value={contentEn} onChange={(event) => setContentEn(event.target.value)} /></label><button type="submit" disabled={busy || !questionId || !contentZh.trim()}>{L("保存提示", "Save hint")}</button><button type="button" className="secondary-action" disabled={busy || !questionId} onClick={() => void generate()}>{L("由已配置 AI 產生草稿", "Generate draft with configured AI")}</button></form><ul className="data-list">{hints.map((hint) => <li key={hint.id}><span><b>{L("第", "Level ")}{hint.level}{L("層", "")}</b> · {hint.source} · {hint.status}<small>{languageText(hint.content_zh, hint.content_en, L)}</small></span><div className="editor-controls">{hint.source === "ai" && hint.status === "draft" && <><button type="button" onClick={() => void learningApi.reviewQuestionHint(hint.id, "approved").then(() => refreshHints()).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : L("批准失敗", "Approval failed")))}>{L("批准", "Approve")}</button><button type="button" className="secondary-action" onClick={() => void learningApi.reviewQuestionHint(hint.id, "rejected").then(() => refreshHints()).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : L("拒絕失敗", "Rejection failed")))}>{L("拒絕", "Reject")}</button></>}<button type="button" className="secondary-action" onClick={() => void learningApi.deleteQuestionHint(questionId, hint.level).then(() => refreshHints()).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : L("刪除失敗", "Delete failed")))}>{L("刪除", "Remove")}</button></div></li>)}</ul>{!hints.length && <p className="empty-copy">{L("此題尚未建立提示。學生不會看到空白或未批准草稿。", "No hints exist for this question. Students never see empty or unapproved drafts.")}</p>}</section>;
}

function TeacherPackagePolicy({ L, courses, showToast }: { L: Translator; courses: CourseDto[]; showToast: (message: string) => void }) {
  const [courseId, setCourseId] = useState("");
  const [supported, setSupported] = useState<string[]>([]);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { if (!courseId && courses[0]) setCourseId(courses[0].id); }, [courses, courseId]);
  useEffect(() => { if (!courseId) return; learningApi.executionPolicy(courseId).then(({ policy }) => { setSupported(policy.supportedPackages); setAllowed(policy.allowedPackages); setError(""); }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : L("套件政策載入失敗", "Package policy could not be loaded"))); }, [courseId]);
  async function save() { try { const result = await learningApi.updateExecutionPolicy(courseId, allowed); setAllowed(result.policy.allowedPackages); showToast(L("Python 套件政策已保存", "Python package policy saved")); } catch (caught) { setError(caught instanceof Error ? caught.message : L("套件政策保存失敗", "Package policy save failed")); } }
  return <section className="settings-card package-policy"><div className="page-heading"><div><span className="grade-tag">{L("Python 執行政策", "PYTHON EXECUTION POLICY")}</span><h2>{L("教師選擇可用套件", "Teacher-selected packages")}</h2><p>{L("標準函式庫可用；pip、外網及未勾選的第三方套件會由 Runner 拒絕。", "The standard library remains available; pip, networking and unselected third-party packages are rejected by the Runner.")}</p></div></div>{error && <p role="alert" className="form-error">{error}</p>}<label>{L("課程", "Course")}<select value={courseId} onChange={(event) => setCourseId(event.target.value)}><option value="">—</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.title_zh}</option>)}</select></label><fieldset><legend>{L("允許套件", "Allowed packages")}</legend>{supported.map((item) => <label key={item}><input type="checkbox" checked={allowed.includes(item)} onChange={(event) => setAllowed((current) => event.target.checked ? [...new Set([...current, item])] : current.filter((value) => value !== item))} />{item}</label>)}</fieldset><button type="button" disabled={!courseId} onClick={() => void save()}>{L("保存套件政策", "Save package policy")}</button></section>;
}

function TeacherGradingDesk({ L, courses, showToast, initialAssignmentId }: { L: Translator; courses: CourseDto[]; showToast: (message: string) => void; initialAssignmentId?: string }) {
  const [courseId, setCourseId] = useState("");
  const [assignments, setAssignments] = useState<AssignmentDto[]>([]);
  const [assignmentId, setAssignmentId] = useState("");
  const [submissions, setSubmissions] = useState<SubmissionListDto[]>([]);
  const [submission, setSubmission] = useState<(SubmissionDto & { answers: Array<SubmissionDto["answers"][number] & { question_id?: string; question_snapshot_json?: string; teacher_feedback?: string | null }> }) | null>(null);
  const [score, setScore] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const deepLinkGate = useRef(new LatestRequestGate());
  const assignmentListGate = useRef(new LatestRequestGate());
  const submissionListGate = useRef(new LatestRequestGate());
  const submissionGate = useRef(new LatestRequestGate());
  useEffect(() => { if (!courseId && courses[0]) setCourseId(courses[0].id); }, [courses, courseId]);
  useEffect(() => {
    if (!initialAssignmentId) { deepLinkGate.current.cancel(); return; }
    submissionListGate.current.cancel(); submissionGate.current.cancel();
    void deepLinkGate.current.run((signal) => learningApi.assignment(initialAssignmentId, signal), ({ assignment }) => {
      setCourseId(assignment.course_id);
      setAssignments((current) => current.some((item) => item.id === assignment.id) ? current : [assignment, ...current]);
      void loadSubmissions(assignment.id);
    }, (caught) => setError(caught instanceof Error ? caught.message : L("功課不存在或無權查看", "Assignment was not found or is unavailable")));
    return () => deepLinkGate.current.cancel();
  }, [initialAssignmentId]);
  useEffect(() => {
    if (!courseId) { assignmentListGate.current.cancel(); return; }
    void assignmentListGate.current.run((signal) => learningApi.assignments(courseId, signal), (result) => { setAssignments(result.assignments); setError(""); }, (caught) => setError(caught instanceof Error ? caught.message : L("功課載入失敗", "Assignments could not be loaded")));
    return () => assignmentListGate.current.cancel();
  }, [courseId]);
  useEffect(() => () => { deepLinkGate.current.cancel(); assignmentListGate.current.cancel(); submissionListGate.current.cancel(); submissionGate.current.cancel(); }, []);
  async function loadSubmissions(id: string) {
    setAssignmentId(id); setSubmission(null); submissionGate.current.cancel();
    await submissionListGate.current.run((signal) => learningApi.assignmentSubmissions(id, signal), (result) => { setSubmissions(result.submissions); setError(""); }, (caught) => setError(caught instanceof Error ? caught.message : L("提交載入失敗", "Submissions could not be loaded")));
  }
  async function chooseSubmission(id: string) {
    await submissionGate.current.run((signal) => learningApi.getSubmission(id, signal), (result) => { setSubmission(result.submission as typeof submission); setError(""); }, (caught) => setError(caught instanceof Error ? caught.message : L("提交內容載入失敗", "Submission could not be loaded")));
  }
  const firstAnswer = submission?.answers[0];
  const questionId = firstAnswer?.questionId ?? firstAnswer?.question_id ?? "";
  return <section className="settings-card grading-desk"><div className="page-heading"><div><span className="grade-tag">{L("批改與發布", "GRADE & RELEASE")}</span><h2>{L("學生提交", "Student submissions")}</h2></div></div>{error && <p role="alert" className="form-error">{error}</p>}<div className="editor-controls"><label>{L("課程", "Course")}<select value={courseId} onChange={(event) => { deepLinkGate.current.cancel(); submissionListGate.current.cancel(); submissionGate.current.cancel(); setAssignmentId(""); setSubmissions([]); setSubmission(null); setCourseId(event.target.value); }}>{courses.map((item) => <option key={item.id} value={item.id}>{item.title_zh}</option>)}</select></label><label>{L("功課", "Assignment")}<select value={assignmentId} onChange={(event) => void loadSubmissions(event.target.value)}><option value="">—</option>{assignments.map((item) => <option key={item.id} value={item.id}>{item.title_zh}</option>)}</select></label><label>{L("提交", "Submission")}<select value={submission?.id ?? ""} onChange={(event) => void chooseSubmission(event.target.value)}><option value="">—</option>{submissions.map((item) => <option key={item.id} value={item.id}>{item.student_id} · #{item.attempt_number} · {item.status}</option>)}</select></label></div>{submission && <div className="editor-form"><p>{L("作答題數", "Answers")}: {submission.answers.length} · {L("狀態", "Status")}: {submission.status}</p><label>{L("第一題分數", "First answer score")}<input type="number" min="0" value={score} onChange={(event) => setScore(event.target.value)} /></label><label>{L("教師評語", "Teacher feedback")}<textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} /></label><button type="button" disabled={!questionId || !score} onClick={() => void learningApi.gradeSubmission(submission.id, questionId, Number(score), feedback).then((result) => { setSubmission(result.submission as typeof submission); showToast(L("評分已保存", "Grade saved")); }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : L("評分失敗", "Grading failed")))}>{L("保存手動評分", "Save manual grade")}</button><button type="button" onClick={() => void learningApi.releaseGrade(submission.id).then(() => { showToast(L("成績已發布", "Grade released")); return chooseSubmission(submission.id); }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : L("發布失敗", "Release failed")))}>{L("向學生發布成績", "Release grade")}</button></div>}</section>;
}

function TeacherContentEditor({ L, showToast, courses, initialCourseId }: { L: Translator; showToast: (message: string) => void; courses: CourseDto[]; initialCourseId?: string }) {
  const [courseId, setCourseId] = useState(initialCourseId ?? "");
  const [units, setUnits] = useState<UnitDto[]>([]);
  const [materials, setMaterials] = useState<MaterialDto[]>([]);
  const [questions, setQuestions] = useState<QuestionDto[]>([]);
  const [assignments, setAssignments] = useState<AssignmentDto[]>([]);
  const [assignmentItems, setAssignmentItems] = useState<AssignmentItemDto[]>([]);
  const [selectedUnitId, setSelectedUnitId] = useState("");
  const [selectedMaterialId, setSelectedMaterialId] = useState("");
  const [selectedQuestionId, setSelectedQuestionId] = useState("");
  const [selectedAssignmentId, setSelectedAssignmentId] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { if (!courseId && courses[0]) setCourseId(courses[0].id); }, [courses, courseId]);
  useEffect(() => { if (initialCourseId) setCourseId(initialCourseId); }, [initialCourseId]);
  async function refresh() {
    if (!courseId) return;
    try {
      const [unitResult, questionResult, assignmentResult] = await Promise.all([learningApi.units(courseId), learningApi.questions(courseId), learningApi.assignments(courseId)]);
      setUnits(unitResult.units); setQuestions(questionResult.questions); setAssignments(assignmentResult.assignments);
      const materialResults = await Promise.all(unitResult.units.map((unit) => learningApi.materials(unit.id)));
      setMaterials(materialResults.flatMap((result) => result.materials));
      if (selectedAssignmentId) setAssignmentItems((await learningApi.assignmentQuestions(selectedAssignmentId)).items);
      setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : L("編輯資料載入失敗", "Editor data could not be loaded")); }
  }
  useEffect(() => { void refresh(); }, [courseId, selectedAssignmentId]);
  function selectEntity(kind: "unit" | "material" | "question" | "assignment", value: string) {
    setSelectedUnitId(kind === "unit" ? value : ""); setSelectedMaterialId(kind === "material" ? value : ""); setSelectedQuestionId(kind === "question" ? value : ""); setSelectedAssignmentId(kind === "assignment" ? value : "");
    if (kind === "unit") { setSelectedUnitId(value); const item = units.find((unit) => unit.id === value); setEditTitle(item?.title_zh ?? ""); setEditBody(item?.description_zh ?? ""); }
    if (kind === "material") { setSelectedMaterialId(value); const item = materials.find((material) => material.id === value); setEditTitle(item?.title_zh ?? ""); setEditBody(item?.body_zh ?? ""); }
    if (kind === "question") { setSelectedQuestionId(value); const item = questions.find((question) => question.id === value); setEditTitle(item?.title_zh ?? ""); setEditBody(item?.prompt_zh ?? ""); }
    if (kind === "assignment") { setSelectedAssignmentId(value); const item = assignments.find((assignment) => assignment.id === value); setEditTitle(item?.title_zh ?? ""); setEditBody(item?.instructions_zh ?? ""); }
  }
  async function save(kind: "unit" | "material" | "question" | "assignment") {
    try {
      if (kind === "unit") await learningApi.updateUnit(selectedUnitId, { titleZh: editTitle, descriptionZh: editBody });
      if (kind === "material") await learningApi.updateMaterial(selectedMaterialId, { titleZh: editTitle, bodyZh: editBody });
      if (kind === "question") await learningApi.updateQuestion(selectedQuestionId, { titleZh: editTitle, promptZh: editBody });
      if (kind === "assignment") await learningApi.updateAssignment(selectedAssignmentId, { titleZh: editTitle, instructionsZh: editBody });
      await refresh(); showToast(L("內容已保存", "Content saved"));
    } catch (caught) { setError(caught instanceof Error ? caught.message : L("保存失敗", "Save failed")); }
  }
  async function archive(kind: "course" | "unit" | "material" | "question" | "assignment") {
    if (!window.confirm(L("確定要封存？如有依賴，伺服器會拒絕。", "Archive this item? The server rejects items with dependencies."))) return;
    try {
      if (kind === "course") await learningApi.archiveCourse(courseId);
      if (kind === "unit") await learningApi.archiveUnit(selectedUnitId);
      if (kind === "material") await learningApi.archiveMaterial(selectedMaterialId);
      if (kind === "question") await learningApi.archiveQuestion(selectedQuestionId);
      if (kind === "assignment") await learningApi.archiveAssignment(selectedAssignmentId);
      await refresh(); showToast(L("已封存", "Archived"));
    } catch (caught) { setError(caught instanceof Error ? caught.message : L("封存失敗；可能存在依賴", "Archive failed; dependencies may exist")); }
  }
  async function toggleQuestion(questionId: string, included: boolean) {
    try { if (included) await learningApi.removeAssignmentQuestion(selectedAssignmentId, questionId); else await learningApi.addAssignmentQuestion(selectedAssignmentId, questionId); setAssignmentItems((await learningApi.assignmentQuestions(selectedAssignmentId)).items); } catch (caught) { setError(caught instanceof Error ? caught.message : L("題目清單更新失敗", "Question list update failed")); }
  }
  async function moveItem(index: number, direction: -1 | 1) {
    const next = index + direction; if (next < 0 || next >= assignmentItems.length) return;
    const items = assignmentItems.slice(); [items[index], items[next]] = [items[next], items[index]];
    try { const result = await learningApi.reorderAssignmentQuestions(selectedAssignmentId, items.map((item, position) => ({ questionId: item.question_id, position, scoreOverride: item.score_override }))); setAssignmentItems(result.items); } catch (caught) { setError(caught instanceof Error ? caught.message : L("排序失敗", "Reorder failed")); }
  }
  return <section className="settings-card content-editor"><div className="page-heading"><div><span className="grade-tag">{L("內容編輯", "CONTENT EDITOR")}</span><h2>{L("編輯與安全封存", "Edit and safe archive")}</h2><p>{L("所有更新和刪除均由後端權限及依賴檢查守護。", "Updates and archives are guarded by server RBAC and dependency checks.")}</p></div><select aria-label={L("編輯課程", "Edit course")} value={courseId} onChange={(event) => setCourseId(event.target.value)}>{courses.map((course) => <option key={course.id} value={course.id}>{course.title_zh}</option>)}</select></div>{error && <p role="alert" className="form-error">{error}</p>}<div className="editor-controls"><label>{L("單元", "Unit")}<select value={selectedUnitId} onChange={(event) => selectEntity("unit", event.target.value)}><option value="">—</option>{units.map((unit) => <option key={unit.id} value={unit.id}>{unit.title_zh}</option>)}</select></label><label>{L("教材", "Material")}<select value={selectedMaterialId} onChange={(event) => selectEntity("material", event.target.value)}><option value="">—</option>{materials.map((material) => <option key={material.id} value={material.id}>{material.title_zh}</option>)}</select></label><label>{L("題目", "Question")}<select value={selectedQuestionId} onChange={(event) => selectEntity("question", event.target.value)}><option value="">—</option>{questions.map((question) => <option key={question.id} value={question.id}>{question.title_zh}</option>)}</select></label><label>{L("功課", "Assignment")}<select value={selectedAssignmentId} onChange={(event) => selectEntity("assignment", event.target.value)}><option value="">—</option>{assignments.map((assignment) => <option key={assignment.id} value={assignment.id}>{assignment.title_zh}</option>)}</select></label></div><div className="editor-form"><label>{L("標題", "Title")}<input aria-label={L("編輯標題", "Edit title")} value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /></label><label>{L("內容／說明", "Body / instructions")}<textarea aria-label={L("編輯內容", "Edit body")} value={editBody} onChange={(event) => setEditBody(event.target.value)} /></label><div><button type="button" disabled={!editTitle.trim() || (!selectedUnitId && !selectedMaterialId && !selectedQuestionId && !selectedAssignmentId)} onClick={() => void save(selectedUnitId ? "unit" : selectedMaterialId ? "material" : selectedQuestionId ? "question" : "assignment")}>{L("保存編輯", "Save edit")}</button><button type="button" className="secondary-action" disabled={!courseId} onClick={() => void archive(selectedAssignmentId ? "assignment" : selectedQuestionId ? "question" : selectedMaterialId ? "material" : selectedUnitId ? "unit" : "course")}>{L("封存選中項目", "Archive selected")}</button></div></div>{selectedAssignmentId && <div className="assignment-question-editor"><h3>{L("功課題目（可多選及排序）", "Assignment questions (select and reorder)")}</h3><p>{L("總分", "Total score")}: {assignmentItems.reduce((sum, item) => sum + Number(item.score_override ?? item.max_score ?? 0), 0)}</p>{questions.map((question) => { const itemIndex = assignmentItems.findIndex((item) => item.question_id === question.id); return <label key={question.id}><input type="checkbox" checked={itemIndex >= 0} onChange={() => void toggleQuestion(question.id, itemIndex >= 0)} />{question.title_zh} · {question.type}{itemIndex >= 0 && <><button type="button" onClick={(event) => { event.preventDefault(); void moveItem(itemIndex, -1); }}>↑</button><button type="button" onClick={(event) => { event.preventDefault(); void moveItem(itemIndex, 1); }}>↓</button></>}</label>; })}</div>}</section>;
}

function TeacherLiveClass({ L, showToast, courses, routePath, navigatePath }: { L: Translator; showToast: (message: string) => void; courses: CourseDto[]; routePath: string; navigatePath: (path: string) => void }) {
  const routeSessionId = routePath.match(/^\/teacher\/classrooms\/([^/]+)$/)?.[1] ?? "";
  const [courseId, setCourseId] = useState(courses[0]?.id ?? "");
  const [sessions, setSessions] = useState<ClassroomSessionDto[]>([]);
  const [assignments, setAssignments] = useState<AssignmentDto[]>([]);
  const [state, setState] = useState<ClassroomStateDto | null>(null);
  const [sessionTitle, setSessionTitle] = useState("");
  const [activityTitle, setActivityTitle] = useState("");
  const [assignmentId, setAssignmentId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const eventVersion = useRef(0);
  useEffect(() => { if (!courseId && courses[0]) setCourseId(courses[0].id); }, [courses, courseId]);
  useEffect(() => {
    if (!courseId) { setSessions([]); setAssignments([]); return; }
    Promise.all([learningApi.classroomSessions(courseId), learningApi.assignments(courseId)])
      .then(([classroomResult, assignmentResult]) => { setSessions(classroomResult.sessions); setAssignments(assignmentResult.assignments); setError(""); })
      .catch((caught) => setError(caught instanceof Error ? caught.message : L("課堂資料載入失敗", "Classroom data failed to load")));
  }, [courseId]);
  useEffect(() => {
    if (!routeSessionId) { setState(null); return; }
    let stopped = false;
    const load = async () => {
      try { const result = await learningApi.classroomState(routeSessionId); if (!stopped) { setState(result.classroom); eventVersion.current = result.classroom.session.version; setError(""); } }
      catch (caught) { if (!stopped) setError(caught instanceof Error ? caught.message : L("課堂狀態載入失敗", "Classroom state failed to load")); }
    };
    void load();
    const timer = window.setInterval(async () => {
      try { const update = await learningApi.classroomEvents(routeSessionId, eventVersion.current); if (!stopped && update.serverVersion > eventVersion.current) await load(); }
      catch { /* The next polling cycle retries without inventing local state. */ }
    }, 3000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [routeSessionId]);
  async function createSession() {
    if (!courseId || !sessionTitle.trim()) return;
    setBusy(true); setError("");
    try { const result = await learningApi.createClassroom(courseId, sessionTitle.trim()); setSessionTitle(""); navigatePath("/teacher/classrooms/" + result.classroom.session.id); showToast(L("課堂已建立", "Classroom created")); }
    catch (caught) { setError(caught instanceof Error ? caught.message : L("建立課堂失敗", "Could not create classroom")); }
    finally { setBusy(false); }
  }
  async function createActivity() {
    if (!routeSessionId || !activityTitle.trim()) return;
    setBusy(true); setError("");
    try { await learningApi.createClassroomActivity(routeSessionId, { title: activityTitle.trim(), assignmentId: assignmentId || undefined, anonymousAnswers: true, idempotencyKey: crypto.randomUUID() }); const result = await learningApi.classroomState(routeSessionId); setState(result.classroom); setActivityTitle(""); showToast(L("活動已建立", "Activity created")); }
    catch (caught) { setError(caught instanceof Error ? caught.message : L("建立活動失敗", "Could not create activity")); }
    finally { setBusy(false); }
  }
  async function transition(transitionName: "start" | "pause" | "lock" | "reopen" | "end") {
    if (!state?.activity) return;
    setBusy(true); setError("");
    try { const result = await learningApi.transitionClassroomActivity(state.activity.id, transitionName); setState(result.classroom); }
    catch (caught) { setError(caught instanceof Error ? caught.message : L("活動狀態更新失敗", "Could not update activity")); }
    finally { setBusy(false); }
  }
  async function endClassroom() {
    if (!routeSessionId) return;
    setBusy(true); setError("");
    try { const result = await learningApi.endClassroom(routeSessionId); setState(result.classroom); setSessions((items) => items.map((item) => item.id === routeSessionId ? { ...item, status: "ended" } : item)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : L("結束課堂失敗", "Could not end classroom")); }
    finally { setBusy(false); }
  }
  const participants = Array.isArray(state?.participants) ? state.participants as Array<{ userId: string; role: string; chineseName?: string; englishName?: string; lastSeenAt?: string | null }> : [];
  const completion = Math.round(Number(state?.progress?.completionRate ?? 0) * 100);
  return <div className="teacher-page live-classroom-workspace">
    <div className="page-heading"><div><span className="grade-tag">{L("即時課堂", "LIVE CLASS")}</span><h1>{state?.session.title ?? L("課堂控制台", "Classroom console")}</h1><p>{L("所有控制及狀態均由伺服器保存，重新整理後可恢復。", "Controls and state are stored on the server and survive refreshes.")}</p></div>{routeSessionId && <button type="button" className="secondary-action" onClick={() => navigatePath("/teacher/classrooms")}>{L("返回課堂列表", "Back to classrooms")}</button>}</div>
    {error && <p role="alert" className="form-error">{error}</p>}
    {!routeSessionId ? <div className="settings-layout"><section className="settings-card"><h2>{L("建立課堂", "Create classroom")}</h2><label>{L("課程", "Course")}<select value={courseId} onChange={(event) => setCourseId(event.target.value)}><option value="">{L("選擇課程", "Select course")}</option>{courses.map((course) => <option key={course.id} value={course.id}>{languageText(course.title_zh, course.title_en, L)}</option>)}</select></label><label>{L("課堂名稱", "Classroom title")}<input value={sessionTitle} onChange={(event) => setSessionTitle(event.target.value)} /></label><button type="button" disabled={busy || !courseId || !sessionTitle.trim()} onClick={() => void createSession()}>{busy ? L("建立中…", "Creating…") : L("建立並開啟", "Create and open")}</button></section><section className="settings-card"><h2>{L("現有課堂", "Existing classrooms")}</h2>{sessions.length ? <ul className="data-list">{sessions.map((session) => <li key={session.id}><span><b>{session.title}</b> · {session.status}</span><button type="button" onClick={() => navigatePath("/teacher/classrooms/" + session.id)}>{L("管理", "Manage")}</button></li>)}</ul> : <div className="empty-state">{L("此課程暫未建立課堂。", "No classroom has been created for this course.")}</div>}</section></div> : !state ? <div className="empty-state" aria-live="polite">{L("正在載入課堂…", "Loading classroom…")}</div> : <div className="teacher-live-grid">
      <aside className="student-monitor"><div className="panel-heading"><strong>{L("學生狀態", "Student status")}</strong><b>{participants.filter((item) => item.role === "student").length}</b></div><ProgressBar value={completion} tone="teal" />{participants.filter((item) => item.role === "student").map((student) => { const name = languageText(student.chineseName ?? L("學生", "Student"), student.englishName, L); return <div className="student-monitor-row" key={student.userId}><i className="active">{name[0]}</i><span><b>{name}</b><small>{student.lastSeenAt ? L("已連線", "Connected") : L("等待加入", "Waiting")}</small></span></div>; })}</aside>
      <section className="class-code-panel"><div className="studio-toolbar"><span className="file-tab">{state.activity?.title ?? L("未建立活動", "No activity")}</span><span className="live-indicator">● {state.activity?.status ?? state.session.status}</span></div>{state.session.status === "ended" ? <div className="empty-state"><h2>{L("課堂已結束", "Classroom ended")}</h2><p>{L("活動、學生狀態及匿名答案保留為唯讀記錄。", "Activities, presence, and anonymous answers remain as a read-only record.")}</p></div> : <div className="classroom-control-form"><label>{L("活動名稱", "Activity title")}<input value={activityTitle} onChange={(event) => setActivityTitle(event.target.value)} /></label><label>{L("連結功課（可選）", "Linked assignment (optional)")}<select value={assignmentId} onChange={(event) => setAssignmentId(event.target.value)}><option value="">{L("不連結功課", "No linked assignment")}</option>{assignments.map((assignment) => <option key={assignment.id} value={assignment.id}>{languageText(assignment.title_zh, assignment.title_en, L)}</option>)}</select></label><button type="button" disabled={busy || !activityTitle.trim()} onClick={() => void createActivity()}>{L("建立活動", "Create activity")}</button>{state.activity && <div className="classroom-transition-bar"><button type="button" disabled={busy || !["draft", "paused", "reopened"].includes(state.activity.status)} onClick={() => void transition("start")}>{L("開始", "Start")}</button><button type="button" disabled={busy || !["active", "reopened"].includes(state.activity.status)} onClick={() => void transition("pause")}>{L("暫停", "Pause")}</button><button type="button" disabled={busy || !["active", "paused", "reopened"].includes(state.activity.status)} onClick={() => void transition("lock")}>{L("鎖定提交", "Lock submissions")}</button><button type="button" disabled={busy || state.activity.status !== "locked"} onClick={() => void transition("reopen")}>{L("解除鎖定", "Unlock")}</button><button type="button" disabled={busy || state.activity.status === "ended"} onClick={() => void transition("end")}>{L("結束活動", "End activity")}</button></div>}</div>}{state.anonymousAnswers?.length ? <div className="anonymous-answer-list"><h3>{L("匿名答案", "Anonymous answers")}</h3>{state.anonymousAnswers.map((answer) => <article key={`${answer.anonymousId}-${answer.questionId}`}><b>{answer.anonymousId}</b><pre>{answer.answerText ?? "—"}</pre></article>)}</div> : null}</section>
      <aside className="class-insights"><DashboardCard eyebrow={L("全班進度", "CLASS PROGRESS")} action={`${completion}%`}><p>{state.progress?.submitted ?? 0} / {state.progress?.total ?? 0} {L("已提交", "submitted")}</p><ProgressBar value={completion} tone="teal" /></DashboardCard><DashboardCard eyebrow={L("事件同步", "EVENT SYNC")} action={`v${state.session.version}`}><p>{state.events.length} {L("項事件已保存", "events stored")}</p></DashboardCard><button type="button" className="lock-class-button" disabled={busy || state.session.status === "ended"} onClick={() => void endClassroom()}>■ {L("結束整個課堂", "End classroom")}</button></aside>
    </div>}
  </div>;
}

function AdminAiCentre({ L, showToast }: { L: Translator; showToast: (message: string) => void }) {
  const [providers, setProviders] = useState<AiProviderDto[]>([]);
  const [settings, setSettings] = useState<AiSettingsDto | null>(null);
  const [providerKey, setProviderKey] = useState("openai-compatible");
  const [displayName, setDisplayName] = useState("OpenAI-compatible");
  const [apiBaseUrl, setApiBaseUrl] = useState("https://api.openai.com/v1");
  const [apiPath, setApiPath] = useState("/chat/completions");
  const [timeoutMs, setTimeoutMs] = useState(15000);
  const [defaultModel, setDefaultModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [assistantMode, setAssistantMode] = useState<AiSettingsDto["assistant_mode"]>("hints_only");
  const [fullAfter, setFullAfter] = useState(3);
  const [studentRequests, setStudentRequests] = useState(20);
  const [studentTokens, setStudentTokens] = useState(20000);
  const [schoolRequests, setSchoolRequests] = useState(1000);
  const [schoolTokens, setSchoolTokens] = useState(1000000);
  const [saveConversations, setSaveConversations] = useState(true);
  const [retentionDays, setRetentionDays] = useState(90);
  const [maxHintLayers, setMaxHintLayers] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refresh() {
    try {
      const [providerResult, settingResult] = await Promise.all([learningApi.aiProviders(), learningApi.aiSettings()]);
      setProviders(providerResult.providers); setSettings(settingResult.settings);
      const value = settingResult.settings;
      setSelectedProviderId(value.provider_config_id ?? ""); setEnabled(Boolean(value.enabled)); setAssistantMode(value.assistant_mode); setFullAfter(value.full_answer_after_attempts ?? 3); setStudentRequests(value.student_daily_request_limit ?? 20); setStudentTokens(value.student_daily_token_limit ?? 20000); setSchoolRequests(value.school_daily_request_limit ?? 1000); setSchoolTokens(value.school_daily_token_limit ?? 1000000); setSaveConversations(Boolean(value.save_conversations)); setRetentionDays(value.conversation_retention_days ?? 90); setMaxHintLayers(value.max_hint_layers ?? 3); setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : L("AI 設定載入失敗", "AI settings could not be loaded")); }
  }
  useEffect(() => { void refresh(); }, []);
  async function configure(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await learningApi.configureAiProvider({ providerKey, displayName, apiBaseUrl, apiPath, timeoutMs, defaultModel, apiKey, enabled: false }); setApiKey(""); await refresh(); showToast(L("供應商已加密保存；請在列表中明確啟用", "Provider saved encrypted; activate it explicitly from the list")); }
    catch (caught) { setError(caught instanceof Error ? caught.message : L("AI 供應商保存失敗", "AI provider could not be saved")); }
    finally { setBusy(false); }
  }
  async function savePolicy(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await learningApi.updateAiSettings({ enabled, providerConfigId: selectedProviderId || null, assistantMode, fullAnswerAfterAttempts: assistantMode === "full_after_attempts" ? fullAfter : null, studentDailyRequestLimit: studentRequests, studentDailyTokenLimit: studentTokens, schoolDailyRequestLimit: schoolRequests, schoolDailyTokenLimit: schoolTokens, saveConversations, conversationRetentionDays: saveConversations ? retentionDays : null, maxHintLayers, timezone: "Asia/Macau" }); await refresh(); showToast(L("AI 政策與限額已保存", "AI policy and quotas saved")); }
    catch (caught) { setError(caught instanceof Error ? caught.message : L("AI 政策保存失敗", "AI policy could not be saved")); }
    finally { setBusy(false); }
  }
  return <section className="settings-card admin-ai-centre"><div className="settings-title"><span>AI</span><div><h2>{L("AI 供應商與政策", "AI provider and policy")}</h2><p>{L("可保存多個 OpenAI-compatible 設定，但同一時間只會明確啟用一個；失敗不會自動切換。", "Multiple OpenAI-compatible configurations can be stored, but exactly one is explicitly active and failures never auto-fallback.")}</p></div></div>{error && <p className="form-error" role="alert">{error}</p>}<form className="form-grid" onSubmit={configure}><label>{L("供應商識別", "Provider key")}<input value={providerKey} onChange={(event) => setProviderKey(event.target.value)} placeholder="openai-compatible:school" required /></label><label>{L("顯示名稱", "Display name")}<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label><label className="full-field">Base URL<input type="url" value={apiBaseUrl} onChange={(event) => setApiBaseUrl(event.target.value)} required /></label><label>API path<input value={apiPath} onChange={(event) => setApiPath(event.target.value)} required /></label><label>{L("逾時（毫秒）", "Timeout (ms)")}<input type="number" min="1000" max="120000" value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value))} /></label><label>{L("模型", "Model")}<input value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} required /></label><label>API key<input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required /></label><button type="submit" disabled={busy}>{L("新增／輪換金鑰", "Add / rotate key")}</button></form><ul className="data-list">{providers.map((provider) => <li key={provider.id}><span><b>{provider.display_name}</b> · {provider.default_model} · {provider.api_key_hint ?? "••••••••"} · {provider.enabled ? L("已啟用", "active") : L("未啟用", "inactive")}</span><div className="editor-controls">{provider.enabled ? <button type="button" className="secondary-action" onClick={() => void learningApi.disableAiProvider(provider.id).then(refresh).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : L("停用失敗", "Disable failed")))}>{L("停用", "Disable")}</button> : <button type="button" onClick={() => void learningApi.activateAiProvider(provider.id).then(refresh).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : L("啟用失敗", "Activation failed")))}>{L("設為唯一啟用", "Set as sole active")}</button>}</div></li>)}</ul><form className="form-grid ai-policy-form" onSubmit={savePolicy}><label>{L("使用供應商", "Selected provider")}<select value={selectedProviderId} disabled><option value="">{L("未選擇", "None")}</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.display_name} · {provider.default_model}</option>)}</select></label><label className="check-row"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{L("啟用 AI 助教", "Enable AI assistant")}</label><label>{L("提示策略", "Hint policy")}<select value={assistantMode} onChange={(event) => setAssistantMode(event.target.value as AiSettingsDto["assistant_mode"])}><option value="hints_only">hints_only</option><option value="progressive">progressive</option><option value="full_after_attempts">full_after_attempts</option></select></label><label>{L("全校最多提示層數", "School maximum hint layers")}<input type="number" min="1" max="3" value={maxHintLayers} onChange={(event) => setMaxHintLayers(Number(event.target.value))} /></label>{assistantMode === "full_after_attempts" && <label>{L("完整解答前嘗試次數", "Attempts before full answer")}<input type="number" min="1" value={fullAfter} onChange={(event) => setFullAfter(Number(event.target.value))} /></label>}<label>{L("每生每日請求", "Requests/student/day")}<input type="number" min="1" value={studentRequests} onChange={(event) => setStudentRequests(Number(event.target.value))} /></label><label>{L("每生每日 tokens", "Tokens/student/day")}<input type="number" min="1" value={studentTokens} onChange={(event) => setStudentTokens(Number(event.target.value))} /></label><label>{L("全校每日請求", "School requests/day")}<input type="number" min="1" value={schoolRequests} onChange={(event) => setSchoolRequests(Number(event.target.value))} /></label><label>{L("全校每日 tokens", "School tokens/day")}<input type="number" min="1" value={schoolTokens} onChange={(event) => setSchoolTokens(Number(event.target.value))} /></label><label className="check-row"><input type="checkbox" checked={saveConversations} onChange={(event) => setSaveConversations(event.target.checked)} />{L("保存 AI 對話", "Save AI conversations")}</label>{saveConversations && <label>{L("保留日數", "Retention days")}<input type="number" min="1" value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))} /></label>}<button type="submit" disabled={busy || (enabled && !selectedProviderId)}>{L("保存 AI 政策", "Save AI policy")}</button></form>{!settings && <p className="empty-copy">{L("正在讀取 AI 設定…", "Loading AI settings…")}</p>}</section>;
}

function AdminBackupCentre({ L, showToast, onEnabledChange }: { L: Translator; showToast: (message: string) => void; onEnabledChange: (enabled: boolean) => void }) {
  const [backups, setBackups] = useState<BackupDto[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [scope, setScope] = useState<"database" | "files" | "full">("full");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"toggle" | "create" | string | null>(null);
  const [error, setError] = useState("");
  const [verification, setVerification] = useState<Record<string, string>>({});

  async function refresh() {
    setLoading(true);
    try {
      const result = await learningApi.backups();
      setBackups(result.backups);
      setEnabled(result.settings.enabled);
      setRetentionDays(result.settings.retentionDays);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : L("備份資料載入失敗", "Backup data could not be loaded"));
    } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  async function toggle() {
    setBusy("toggle"); setError("");
    try {
      const result = await learningApi.updateBackupSettings(!enabled);
      setEnabled(result.settings.enabled);
      onEnabledChange(result.settings.enabled);
      await refresh();
      showToast(L("備份開關已更新", "Backup setting updated"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : L("更新備份開關失敗", "Backup setting could not be updated"));
    } finally { setBusy(null); }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy("create"); setError("");
    try {
      await learningApi.createBackup(scope);
      await refresh();
      showToast(L("手動備份已建立", "Manual backup created"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : L("建立備份失敗", "Backup could not be created"));
    } finally { setBusy(null); }
  }
  async function verify(backupId: string) {
    setBusy("verify:" + backupId); setError("");
    try {
      const result = await learningApi.verifyBackup(backupId);
      if (!result.verification.valid) throw new Error(L("備份驗證未通過", "Backup verification did not pass"));
      setVerification((current) => ({ ...current, [backupId]: result.verification.checksum }));
      await refresh();
      showToast(L("備份驗證成功", "Backup verified"));
    } catch (caught) {
      setVerification((current) => { const next = { ...current }; delete next[backupId]; return next; });
      setError(caught instanceof Error ? caught.message : L("備份驗證失敗", "Backup verification failed"));
    } finally { setBusy(null); }
  }
  return <div className="admin-page admin-backup-centre">
    <div className="page-heading"><div><span className="grade-tag">{L("系統安全", "SYSTEM SAFETY")}</span><h1>{L("備份管理", "Backup management")}</h1><p>{L("建立及驗證隔離備份；此頁不提供還原操作。", "Create and verify isolated backups; restore is intentionally unavailable here.")}</p></div><span className="prototype-chip">{loading ? L("正在讀取", "Loading") : enabled ? L("自動備份已啟用", "Automatic backup enabled") : L("自動備份已停用", "Automatic backup disabled")}</span></div>
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="admin-settings-grid">
      <section className="settings-card"><h2>{L("備份設定", "Backup settings")}</h2><p>{retentionDays === null ? L("正在讀取保留政策…", "Loading retention policy…") : L(`保留 ${retentionDays} 日`, `Retention: ${retentionDays} days`)}</p><button type="button" disabled={loading || busy !== null} onClick={() => void toggle()}>{busy === "toggle" ? L("更新中…", "Updating…") : enabled ? L("停用自動備份", "Disable automatic backup") : L("啟用自動備份", "Enable automatic backup")}</button></section>
      <section className="settings-card"><h2>{L("手動建立", "Manual backup")}</h2><form className="form-grid" onSubmit={(event) => void create(event)}><label>{L("範圍", "Scope")}<select value={scope} disabled={busy !== null} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="database">database</option><option value="files">files</option><option value="full">full</option></select></label><button type="submit" disabled={loading || busy !== null}>{busy === "create" ? L("建立中…", "Creating…") : L("建立備份", "Create backup")}</button></form></section>
    </div>
    <section className="settings-card"><h2>{L("備份列表", "Backup list")}</h2>{loading ? <p className="empty-copy">{L("正在載入備份…", "Loading backups…")}</p> : backups.length === 0 ? <div className="empty-state"><h2>{L("尚未有備份", "No backups yet")}</h2><p>{L("建立第一個手動備份後會在此顯示。", "Create a manual backup to see it here.")}</p></div> : <ul className="data-list">{backups.map((backup) => <li key={backup.id}><span><b>{backup.scope}</b> · {backup.trigger} · {backup.status} · {new Date(backup.created_at).toLocaleString()} · {backup.verified_at ? `${L("已驗證", "Verified")} ${new Date(backup.verified_at).toLocaleString()}` : L("未驗證", "Not verified")} · {backup.checksum ? L("checksum 已存在", "checksum present") : L("checksum 無", "checksum absent")} · {backup.byte_size === null ? "—" : `${backup.byte_size} bytes`}</span><span>{(verification[backup.id] || backup.verified_at) && <small>{L("驗證成功", "Verified")}</small>}<button type="button" disabled={busy !== null} onClick={() => void verify(backup.id)}>{busy === "verify:" + backup.id ? L("驗證中…", "Verifying…") : L("驗證", "Verify")}</button></span></li>)}</ul>}</section>
  </div>;
}

function AdminAuditCentre({ L }: { L: Translator }) {
  const [logs, setLogs] = useState<AuditLogDto[]>([]);
  const [action, setAction] = useState("");
  const [correlationId, setCorrelationId] = useState("");
  const [limit, setLimit] = useState(100);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function refresh() {
    setLoading(true);
    try {
      const result = await learningApi.auditLogs({ action: action.trim() || undefined, correlationId: correlationId.trim() || undefined, limit });
      setLogs(result.logs); setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : L("稽核紀錄載入失敗", "Audit logs could not be loaded")); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  function metadata(value: string) {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return <div className="admin-page admin-audit-centre">
    <div className="page-heading"><div><span className="grade-tag">{L("安全紀錄", "SECURITY RECORDS")}</span><h1>{L("稽核紀錄", "Audit logs")}</h1><p>{L("按動作、關聯／請求識別碼及數量查詢；內容以純文字安全呈現。", "Filter by action, correlation/request id and limit; results are rendered as text.")}</p></div></div>
    {error && <p role="alert" className="form-error">{error}</p>}
    <section className="settings-card"><form className="form-grid" onSubmit={(event) => { event.preventDefault(); void refresh(); }}><label>{L("動作", "Action")}<input value={action} onChange={(event) => setAction(event.target.value)} placeholder="backup.created" /></label><label>{L("關聯／請求識別碼", "Correlation/request id")}<input value={correlationId} onChange={(event) => setCorrelationId(event.target.value)} /></label><label>{L("上限", "Limit")}<input type="number" min="1" max="500" value={limit} onChange={(event) => setLimit(Math.min(500, Math.max(1, Number(event.target.value) || 1)))} /></label><button type="submit" disabled={loading}>{loading ? L("查詢中…", "Loading…") : L("查詢", "Search")}</button></form></section>
    <section className="settings-card"><h2>{L("結果", "Results")}</h2>{loading ? <p className="empty-copy">{L("正在載入稽核紀錄…", "Loading audit logs…")}</p> : logs.length === 0 ? <div className="empty-state"><h2>{L("沒有符合的紀錄", "No matching records")}</h2><p>{L("請調整篩選條件後再查詢。", "Adjust the filters and search again.")}</p></div> : <ul className="data-list">{logs.map((log) => <li key={log.id}><span><b>{log.action}</b> · {log.result} · {log.entity_type}{log.entity_id ? `:${log.entity_id}` : ""} · {new Date(log.created_at).toLocaleString()}<br />{L("執行者", "Actor")}: {log.actor_id ?? "—"} · {L("關聯／請求", "Correlation/request")}: {log.request_id ?? "—"}<pre>{metadata(log.metadata_json)}</pre></span></li>)}</ul>}</section>
  </div>;
}

function AdminCentre({ L, showToast, status }: { L: Translator; showToast: (message: string) => void; status: AdminStatusDto | null }) {
  const [users, setUsers] = useState<UserDto[]>([]);
  const [classes, setClasses] = useState<ClassDto[]>([]);
  const [role, setNewRole] = useState<"teacher" | "student">("student");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [studentNumber, setStudentNumber] = useState("");
  const [className, setClassName] = useState("");
  const [academicYear, setAcademicYear] = useState("2026-2027");
  const [teacherId, setTeacherId] = useState("");
  const [oneTimePassword, setOneTimePassword] = useState("");
  const [importRows, setImportRows] = useState<Array<Record<string, unknown>>>([]);
  const [importClassId, setImportClassId] = useState("");
  const [error, setError] = useState("");
  async function refresh() { try { const [userResult, classResult] = await Promise.all([learningApi.users(), learningApi.classes()]); setUsers(userResult.users); setClasses(classResult.classes); setError(""); } catch (caught) { setError(caught instanceof Error ? caught.message : L("管理資料載入失敗", "Admin data could not be loaded")); } }
  useEffect(() => { void refresh(); }, []);
  async function createUser(event: React.FormEvent) { event.preventDefault(); try { const result = await learningApi.createUser({ role, username, chineseName: name, studentNumber: role === "student" ? studentNumber : undefined }); setOneTimePassword(result.initialPassword); setUsername(""); setName(""); setStudentNumber(""); await refresh(); } catch (caught) { setError(caught instanceof Error ? caught.message : L("建立帳戶失敗", "Account creation failed")); } }
  async function createClass(event: React.FormEvent) { event.preventDefault(); try { await learningApi.createClass({ name: className, academicYear, teacherId }); setClassName(""); await refresh(); } catch (caught) { setError(caught instanceof Error ? caught.message : L("建立班別失敗", "Class creation failed")); } }
  async function resetPassword(userId: string) { try { const result = await learningApi.resetPassword(userId); setOneTimePassword(result.initialPassword); showToast(L("已撤銷舊登入並產生一次性初始密碼", "Existing sessions revoked; one-time initial password created")); } catch (caught) { setError(caught instanceof Error ? caught.message : L("重設失敗", "Reset failed")); } }
  async function previewImport(file?: File) { if (!file) return; try { const XLSX = await import("xlsx"); const book = /\.xlsx?$/i.test(file.name) ? XLSX.read(await file.arrayBuffer(), { type: "array" }) : XLSX.read(await file.text(), { type: "string" }); const sheet = book.Sheets[book.SheetNames[0]]; if (!sheet) throw new Error(L("檔案沒有工作表", "The file has no worksheet")); const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" }); const aliases: Record<string, string> = { "學號": "studentNumber", student_number: "studentNumber", studentnumber: "studentNumber", "中文姓名": "chineseName", chinese_name: "chineseName", chinesename: "chineseName", "英文姓名": "englishName", english_name: "englishName", englishname: "englishName", "班別": "className", class_name: "className", classname: "className", "電郵": "email", email: "email" }; const headers = raw[0].map((value) => { const key = String(value).trim(); return aliases[key.toLowerCase()] ?? aliases[key] ?? key; }); setImportRows(raw.slice(1).filter((row) => row.some((value) => String(value).trim())).map((row) => Object.fromEntries(headers.map((header, index) => [header, String(row[index] ?? "").trim()])))); } catch (caught) { setError(caught instanceof Error ? caught.message : L("匯入預覽失敗", "Import preview failed")); } }
  async function submitImport() { try { const result = await learningApi.importStudents(importRows, importClassId || undefined); showToast(L(`已匯入 ${result.imported.length} 名學生`, `${result.imported.length} students imported`)); setImportRows([]); await refresh(); } catch (caught) { setError(caught instanceof Error ? caught.message : L("匯入失敗", "Import failed")); } }
  return (
    <div className="admin-page">
      <div className="page-heading"><div><span className="grade-tag">{L("管理中心", "ADMIN CENTRE")}</span><h1>{L("平台概況與設定", "Platform overview and settings")}</h1><p>{L("管理帳戶、AI 用量、執行限制與備份。", "Manage accounts, AI usage, runtime limits and backups.")}</p></div><span className="prototype-chip">{status ? L("伺服器已連線", "Server connected") : L("正在讀取狀態", "Loading status")}</span></div>
      <section className="admin-metrics">
        <MetricBlock label={L("帳戶管理", "Account management")} value={String(users.length)} note={L("真實有效帳戶", "Live account records")} tone="teal" />
        <MetricBlock label={L("AI 服務", "AI service")} value={status?.ai.configured ? L("已設定", "Configured") : L("未設定", "Not configured")} note={L("未設定時會安全停用", "Fails closed when unconfigured")} tone="blue" />
        <MetricBlock label={L("備份", "Backups")} value={status?.backup.enabled ? L("已啟用", "Enabled") : L("已停用", "Disabled")} note={L("可由管理 API 控制", "Controlled through the admin API")} tone="amber" />
        <MetricBlock label={L("系統狀態", "System status")} value={status ? L("正常", "Ready") : "—"} note={L("後端健康狀態已驗證", "Backend health has been verified")} tone="coral" />
      </section>
      {error && <p role="alert" className="form-error">{error}</p>}
      {oneTimePassword && <section className="one-time-secret" role="status"><strong>{L("一次性初始密碼（離開後不再顯示）", "One-time initial password (not shown again)")}</strong><code>{oneTimePassword}</code><button type="button" onClick={() => setOneTimePassword("")}>{L("我已安全保存", "I stored it securely")}</button></section>}
      <div className="admin-settings-grid account-admin-grid">
        <section className="settings-card"><h2>{L("建立帳戶", "Create account")}</h2><form className="form-grid" onSubmit={createUser}><label>{L("角色", "Role")}<select value={role} onChange={(event) => setNewRole(event.target.value as "teacher" | "student")}><option value="student">{L("學生", "Student")}</option><option value="teacher">{L("教師", "Teacher")}</option></select></label><label>{L("帳戶", "Username")}<input value={username} onChange={(event) => setUsername(event.target.value)} required /></label><label>{L("中文姓名", "Chinese name")}<input value={name} onChange={(event) => setName(event.target.value)} required /></label>{role === "student" && <label>{L("學號", "Student number")}<input value={studentNumber} onChange={(event) => setStudentNumber(event.target.value)} required /></label>}<button type="submit">{L("建立帳戶", "Create account")}</button></form></section>
        <section className="settings-card"><h2>{L("建立班別", "Create class")}</h2><form className="form-grid" onSubmit={createClass}><label>{L("班別", "Class name")}<input value={className} onChange={(event) => setClassName(event.target.value)} required /></label><label>{L("學年", "Academic year")}<input value={academicYear} onChange={(event) => setAcademicYear(event.target.value)} required /></label><label>{L("負責教師", "Owner teacher")}<select value={teacherId} onChange={(event) => setTeacherId(event.target.value)} required><option value="">—</option>{users.filter((user) => user.role === "teacher").map((user) => <option key={user.id} value={user.id}>{user.chinese_name} · {user.username}</option>)}</select></label><button type="submit">{L("建立班別", "Create class")}</button></form></section>
      </div>
      <section className="settings-card"><h2>{L("帳戶列表", "Accounts")}</h2><ul className="data-list">{users.map((user) => <li key={user.id}><span><b>{user.chinese_name}</b> · {user.username} · {user.role} · {user.status}</span>{user.role !== "admin" && <span><button type="button" onClick={() => void resetPassword(user.id)}>{L("重設密碼", "Reset password")}</button><button type="button" className="secondary-action" onClick={() => { if (window.confirm(L("封存帳戶並撤銷登入？", "Archive this account and revoke sessions?"))) void learningApi.archiveUser(user.id).then(() => refresh()).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : L("封存失敗", "Archive failed"))); }}>{L("封存", "Archive")}</button></span>}</li>)}</ul></section>
      <section className="settings-card"><h2>{L("學生 CSV／Excel 匯入", "Student CSV / Excel import")}</h2><label>{L("匯入班別（可選）", "Target class (optional)")}<select value={importClassId} onChange={(event) => setImportClassId(event.target.value)}><option value="">—</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><input type="file" accept=".csv,.xlsx,.xls" onChange={(event) => void previewImport(event.target.files?.[0])} />{importRows.length > 0 && <><p>{L(`預覽 ${importRows.length} 列；提交前請核對學號及姓名。`, `Previewing ${importRows.length} rows; verify student numbers and names.`)}</p><pre className="import-preview">{JSON.stringify(importRows.slice(0, 5), null, 2)}</pre><button type="button" onClick={() => void submitImport()}>{L("確認匯入", "Confirm import")}</button></>}</section>
      <div className="admin-settings-grid">
        <AdminAiCentre L={L} showToast={showToast} />
        <section className="settings-card policy-settings">
          <h2>{L("資料與安全", "Data and security")}</h2>
          <PolicyRow icon="◴" title={L("對話紀錄", "Conversation history")} note={L("由 AI 設定中的保存開關與保留日數控制", "Controlled by the AI save switch and retention setting")} />
          <PolicyRow icon="↻" title={L("每日自動備份", "Daily backup")} note={status?.backup.enabled ? L("已啟用", "Enabled") : L("已停用", "Disabled")} toggle={status?.backup.enabled ?? false} onToggle={() => showToast(L("請由管理 API 修改備份開關", "Change backup settings through the admin API"))} />
          <PolicyRow icon="⌁" title={L("程式執行限制", "Runtime limits")} note={L("5 秒 · 768 MB · 禁止外網", "5 seconds · 768 MB · No internet")} />
          <PolicyRow icon="⌾" title={L("稽核紀錄", "Audit logs")} note={L("登入、成績與設定變更", "Login, grades and settings")} />
        </section>
      </div>
    </div>
  );
}

function DashboardCard({ eyebrow, action, children }: { eyebrow: string; action: string; children: React.ReactNode }) {
  return <article className="dashboard-card"><div className="dashboard-card-title"><strong>{eyebrow}</strong><span>{action}</span></div>{children}</article>;
}

function ProgressBar({ value, tone }: { value: number; tone: string }) {
  return <span className={"progress-bar " + tone}><i style={{ width: value + "%" }} /></span>;
}

function CourseCard({ icon, tone, title, note, progress, meta }: { icon: string; tone: string; title: string; note: string; progress: number; meta: string }) {
  return <article className="course-card"><div><i className={tone}>{icon}</i><span><b>{title}</b><small>{note}</small></span></div><footer><ProgressBar value={progress} tone={tone} /><em>{meta}</em></footer></article>;
}

function languageText(zh: string, en: string | null | undefined, L: Translator) {
  return L(zh, en || zh);
}

function ChallengeCard({ n, icon, tone, title, action, locked = false }: { n: string; icon: string; tone: string; title: string; action?: () => void; locked?: boolean }) {
  return <article className={"challenge-card " + tone}><div><span>{icon}</span></div><small>{locked ? "🔒" : "Challenge " + n}</small><h3>{title}</h3><button type="button" disabled={locked} onClick={action}>{locked ? "Locked" : "Start"}</button></article>;
}

function MetricBlock({ label, value, note, tone }: { label: string; value: string; note: string; tone: string }) {
  return <article className={"metric-block " + tone}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>;
}

function PolicyRow({ icon, title, note, toggle, onToggle }: { icon: string; title: string; note: string; toggle?: boolean; onToggle?: () => void }) {
  return <div className="policy-row"><i>{icon}</i><span><b>{title}</b><small>{note}</small></span>{onToggle ? <button type="button" className={toggle ? "toggle on" : "toggle"} onClick={onToggle} aria-label={title}><em /></button> : <button type="button" className="chevron">›</button>}</div>;
}
