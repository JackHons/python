/* eslint-disable @typescript-eslint/no-explicit-any -- SQLite row shapes are runtime-defined and vary by projection. */
import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "./education.ts";
import type { LocalDatabase } from "./db.ts";
import { DomainError } from "./errors.ts";
import { assertAssignmentSubmissionOpen } from "./classroom/guard.ts";

const STAFF = new Set(["admin", "teacher"]);
const MAX_CODE_BYTES = 100 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const SUPPORTED_PACKAGES = new Set(["numpy", "pandas", "matplotlib"]);

type TestCaseSnapshot = {
  id: string;
  visibility: "public" | "hidden";
  label?: string | null;
  inputJson?: unknown;
  expectedOutput: string;
  comparisonMode?: "exact" | "trimmed" | "numeric_tolerance";
  tolerance?: number | null;
  weight?: number;
  position?: number;
  timeLimitMs?: number | null;
  memoryLimitMb?: number | null;
};

type QuestionSnapshot = {
  id: string;
  type: string;
  maxScore: number;
  testCases: TestCaseSnapshot[];
};

export type RunnerResult = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  output_limited: boolean;
  duration_ms?: number;
};

export interface RunnerClient {
  execute(input: { code: string; stdin: string; timeoutMs: number; allowedPackages: string[] }): Promise<RunnerResult>;
}

export class HttpRunnerClient implements RunnerClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  constructor(
    baseUrl: string,
    token: string,
    requestTimeoutMs = MAX_TIMEOUT_MS + 1000,
  ) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async execute(input: { code: string; stdin: string; timeoutMs: number; allowedPackages: string[] }) {
    if (!this.token.trim()) throw new DomainError("runner_unavailable", "Python Runner is not configured", 503);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(this.baseUrl.replace(/\/$/, "") + "/execute", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + this.token },
          body: JSON.stringify({ code: input.code, stdin: input.stdin, timeout_ms: input.timeoutMs, allowed_packages: input.allowedPackages }),
          signal: controller.signal,
        });
      } catch {
        throw new DomainError("runner_unavailable", "Python Runner is unavailable", 503);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new DomainError("runner_protocol", "Python Runner returned an invalid response", 502);
      }
      if (response.status === 429) throw new DomainError("runner_busy", "Python Runner is busy; retry later", 429);
      if (!response.ok) throw new DomainError("runner_failed", "Python Runner rejected the job", 502);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new DomainError("runner_protocol", "Python Runner returned an invalid response", 502);
      const result = payload as Record<string, unknown>;
      if (typeof result.stdout !== "string" || typeof result.stderr !== "string" || !(result.exit_code === null || Number.isInteger(result.exit_code)) || typeof result.timed_out !== "boolean" || typeof result.output_limited !== "boolean") {
        throw new DomainError("runner_protocol", "Python Runner returned an invalid response", 502);
      }
      return result as RunnerResult;
    } finally {
      clearTimeout(timer);
    }
  }
}

function sha256(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function json(value: unknown) { return JSON.stringify(value ?? null); }
function parseSnapshot(value: unknown): QuestionSnapshot {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { throw new DomainError("invalid_snapshot", "Question snapshot is invalid"); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new DomainError("invalid_snapshot", "Question snapshot is invalid");
  const snapshot = parsed as Record<string, unknown>;
  if (typeof snapshot.id !== "string" || typeof snapshot.type !== "string" || !Number.isFinite(Number(snapshot.maxScore)) || !Array.isArray(snapshot.testCases)) throw new DomainError("invalid_snapshot", "Question snapshot is incomplete");
  return { id: snapshot.id, type: snapshot.type, maxScore: Number(snapshot.maxScore), testCases: snapshot.testCases as TestCaseSnapshot[] };
}
function inputText(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
function parseTime(value: unknown) {
  if (!value) return null;
  const raw = String(value);
  const parsed = new Date(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function compareOutput(actual: string, expected: string, mode = "trimmed", tolerance: number | null | undefined) {
  if (mode === "exact") return actual === expected;
  if (mode === "numeric_tolerance") {
    const actualNumber = Number(actual.trim());
    const expectedNumber = Number(expected.trim());
    return Number.isFinite(actualNumber) && Number.isFinite(expectedNumber) && Math.abs(actualNumber - expectedNumber) <= (tolerance ?? 0);
  }
  return actual.trim() === expected.trim();
}
function isStaff(actor: Actor) { return STAFF.has(actor.role); }
function validateAllowedPackages(packages: string[]) {
  if (!Array.isArray(packages) || packages.some((item) => typeof item !== "string" || !SUPPORTED_PACKAGES.has(item))) {
    throw new DomainError("package_not_allowed", "Requested Python package is not allowed");
  }
  return [...new Set(packages)];
}

export class ExecutionService {
  private readonly runnerVersion: string;
  private readonly runnerImage: string;
  private readonly maxTimeoutMs: number;
  private readonly db: LocalDatabase;
  private readonly runner: RunnerClient;
  private readonly clock: () => Date;
  constructor(
    db: LocalDatabase,
    runner: RunnerClient,
    options: { runnerVersion?: string; runnerImage?: string; maxTimeoutMs?: number; clock?: () => Date } = {},
  ) {
    this.db = db;
    this.runner = runner;
    this.runnerVersion = options.runnerVersion ?? "unknown";
    this.runnerImage = options.runnerImage ?? "unknown";
    this.maxTimeoutMs = Math.min(options.maxTimeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.clock = options.clock ?? (() => new Date());
  }

  private answer(answerId: string) {
    return this.db.get<Record<string, any>>(`SELECT sa.*, s.assignment_id, s.student_id AS submission_student_id,
      a.course_id, a.status AS assignment_status, a.publish_at, a.show_score_immediately, a.show_test_results_immediately,
      a.unit_id AS assignment_unit_id, u.status AS unit_status, c.status AS course_status, ce.status AS enrollment_status
      FROM submission_answers sa
      JOIN submissions s ON s.id = sa.submission_id AND sa.assignment_id = s.assignment_id
      JOIN assignments a ON a.id = s.assignment_id
      JOIN courses c ON c.id = a.course_id
      LEFT JOIN units u ON u.id = a.unit_id AND u.course_id = a.course_id
      LEFT JOIN course_enrollments ce ON ce.course_id = a.course_id AND ce.student_id = s.student_id
      JOIN assignment_items ai ON ai.assignment_id = s.assignment_id AND ai.question_id = sa.question_id AND ai.course_id = a.course_id AND ai.assignment_id = sa.assignment_id
      JOIN questions q ON q.id = sa.question_id AND q.course_id = a.course_id
      WHERE sa.id = ?`, [answerId]);
  }

  private canManage(actor: Actor, courseId: string) {
    if (actor.role === "admin") return true;
    if (actor.role !== "teacher") return false;
    return Boolean(this.db.get("SELECT 1 FROM courses c WHERE c.id = ? AND (c.owner_teacher_id = ? OR EXISTS (SELECT 1 FROM course_class_assignments cca JOIN class_memberships cm ON cm.class_id = cca.class_id WHERE cca.course_id = c.id AND cm.user_id = ? AND cm.member_role = 'teacher' AND cm.status = 'active'))", [courseId, actor.id, actor.id]));
  }

  private assertAnswerScope(actor: Actor, answer: Record<string, any>) {
    if (actor.role === "student") {
      const unavailable = answer.submission_student_id !== actor.id ||
        answer.course_status !== "published" ||
        answer.enrollment_status !== "active" ||
        answer.assignment_status !== "published" ||
        (answer.assignment_unit_id && answer.unit_status !== "published") ||
        (answer.publish_at && (parseTime(answer.publish_at)?.getTime() ?? Number.POSITIVE_INFINITY) > this.clock().getTime());
      if (unavailable) throw new DomainError("not_found", "Submission answer not found", 404);
    }
    if (isStaff(actor) && !this.canManage(actor, answer.course_id)) throw new DomainError("forbidden", "You cannot access this course", 403);
    if (!isStaff(actor) && actor.role !== "student") throw new DomainError("forbidden", "Execution permission required", 403);
    return answer;
  }

  private snapshotForAnswer(answer: Record<string, any>) {
    const snapshot = parseSnapshot(answer.question_snapshot_json);
    if (!["code_fill", "python_code"].includes(snapshot.type)) throw new DomainError("invalid_input", "Only Python questions can be executed");
    return snapshot;
  }

  private policyKey(courseId: string) { return `python.allowed_packages.course.${courseId}`; }

  private allowedPackages(courseId: string) {
    const course = this.db.get<{ value_json: string }>("SELECT value_json FROM system_settings WHERE key = ?", [this.policyKey(courseId)]);
    const global = this.db.get<{ value_json: string }>("SELECT value_json FROM system_settings WHERE key = 'python.allowed_packages'");
    const raw = course?.value_json ?? global?.value_json ?? "[]";
    try { return validateAllowedPackages(JSON.parse(raw)); } catch { throw new DomainError("invalid_policy", "Python package policy is invalid", 500); }
  }

  getPackagePolicy(actor: Actor, courseId: string) {
    if (!this.canManage(actor, courseId) && actor.role !== "student") throw new DomainError("forbidden", "You cannot view this course policy", 403);
    if (actor.role === "student") {
      const enrolled = this.db.get("SELECT 1 FROM course_enrollments WHERE course_id = ? AND student_id = ? AND status = 'active'", [courseId, actor.id]);
      if (!enrolled) throw new DomainError("forbidden", "You cannot view this course policy", 403);
    }
    return { courseId, allowedPackages: this.allowedPackages(courseId), supportedPackages: [...SUPPORTED_PACKAGES] };
  }

  setPackagePolicy(actor: Actor, courseId: string, packages: string[]) {
    if (!this.canManage(actor, courseId)) throw new DomainError("forbidden", "You cannot manage this course policy", 403);
    const allowedPackages = validateAllowedPackages(packages);
    this.db.run("INSERT INTO system_settings (key, value_json, sensitivity, updated_by_id, updated_at) VALUES (?, ?, 'admin_only', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by_id = excluded.updated_by_id, updated_at = excluded.updated_at", [this.policyKey(courseId), JSON.stringify(allowedPackages), actor.id, new Date().toISOString()]);
    return { courseId, allowedPackages, supportedPackages: [...SUPPORTED_PACKAGES] };
  }

  createCodeSnapshot(actor: Actor, answerId: string, code: string, source: "autosave" | "run" | "submit" | "paste", pastedCharacterCount = 0) {
    const answer = this.assertAnswerScope(actor, this.answer(answerId) ?? (() => { throw new DomainError("not_found", "Submission answer not found", 404); })());
    if (actor.role === "student") assertAssignmentSubmissionOpen(this.db, answer.assignment_id);
    this.snapshotForAnswer(answer);
    if (typeof code !== "string" || !code) throw new DomainError("invalid_input", "Code is required");
    if (new TextEncoder().encode(code).byteLength > MAX_CODE_BYTES) throw new DomainError("code_too_large", "Code is too large", 413);
    if (!Number.isInteger(pastedCharacterCount) || pastedCharacterCount < 0) throw new DomainError("invalid_input", "Paste count is invalid");
    const id = randomUUID();
    const hash = sha256(code);
    const sequence = (this.db.get<{ max: number | null }>("SELECT MAX(sequence_number) AS max FROM code_snapshots WHERE submission_answer_id = ?", [answerId])?.max ?? 0) + 1;
    this.db.run("INSERT INTO code_snapshots (id, submission_answer_id, student_id, sequence_number, source, code, sha256, pasted_character_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [id, answerId, answer.submission_student_id, sequence, source, code, hash, pastedCharacterCount]);
    return this.db.get("SELECT id, submission_answer_id, student_id, sequence_number, source, sha256, pasted_character_count, created_at FROM code_snapshots WHERE id = ?", [id]);
  }

  private createRun(actor: Actor, answer: Record<string, any>, snapshotId: string, codeHash: string, runType: "execute" | "grade", timeoutMs: number, allowedPackages: string[]) {
    const id = randomUUID();
    const limits = { timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES, memoryMb: 768, maxFileBytes: 5 * 1024 * 1024, maxProcesses: 32, allowedPackages };
    this.db.run("INSERT INTO code_runs (id, submission_answer_id, actor_id, student_id, snapshot_id, question_id, run_type, limits_json, runner_version, runner_image, code_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, answer.id, actor.id, answer.submission_student_id, snapshotId, parseSnapshot(answer.question_snapshot_json).id, runType, json(limits), this.runnerVersion, this.runnerImage, codeHash]);
    return { id, limits };
  }

  async execute(actor: Actor, answerId: string, code: string, options: { stdin?: string; timeoutMs?: number; pastedCharacterCount?: number } = {}) {
    const answer = this.assertAnswerScope(actor, this.answer(answerId) ?? (() => { throw new DomainError("not_found", "Submission answer not found", 404); })());
    if (actor.role === "student") assertAssignmentSubmissionOpen(this.db, answer.assignment_id);
    this.snapshotForAnswer(answer);
    const stdin = options.stdin ?? "";
    if (new TextEncoder().encode(stdin).byteLength > MAX_INPUT_BYTES) throw new DomainError("input_too_large", "Input is too large", 413);
    const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, this.maxTimeoutMs));
    const codeSnapshot = this.createCodeSnapshot(actor, answerId, code, "run", options.pastedCharacterCount ?? 0) as { id: string; sha256: string };
    const allowedPackages = this.allowedPackages(answer.course_id);
    const run = this.createRun(actor, answer, codeSnapshot.id, codeSnapshot.sha256, "execute", timeoutMs, allowedPackages);
    try {
      const result = await this.runner.execute({ code, stdin, timeoutMs, allowedPackages });
      this.db.run("UPDATE code_runs SET status = ?, stdout = ?, stderr = ?, exit_code = ?, duration_ms = ?, started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?", [result.timed_out ? "timeout" : result.exit_code === 0 ? "passed" : "failed", result.stdout, result.stderr, result.exit_code, result.duration_ms ?? null, new Date().toISOString(), new Date().toISOString(), run.id]);
    } catch (error) {
      const domain = error instanceof DomainError ? error : new DomainError("runner_failed", "Python Runner failed", 502);
      this.db.run("UPDATE code_runs SET status = 'error', stderr = ?, finished_at = ? WHERE id = ?", [domain.code, new Date().toISOString(), run.id]);
      throw domain;
    }
    return this.getRun(actor, run.id);
  }

  async grade(actor: Actor, answerId: string, code: string, options: { timeoutMs?: number; pastedCharacterCount?: number } = {}) {
    const answer = this.assertAnswerScope(actor, this.answer(answerId) ?? (() => { throw new DomainError("not_found", "Submission answer not found", 404); })());
    assertAssignmentSubmissionOpen(this.db, answer.assignment_id);
    const snapshot = this.snapshotForAnswer(answer);
    if (snapshot.testCases.length === 0) throw new DomainError("invalid_input", "The code question has no test cases");
    const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, this.maxTimeoutMs));
    const codeSnapshot = this.createCodeSnapshot(actor, answerId, code, "submit", options.pastedCharacterCount ?? 0) as { id: string; sha256: string };
    const allowedPackages = this.allowedPackages(answer.course_id);
    const run = this.createRun(actor, answer, codeSnapshot.id, codeSnapshot.sha256, "grade", timeoutMs, allowedPackages);
    const outcomes: Array<{ test: TestCaseSnapshot; result: RunnerResult | null; status: "passed" | "failed" | "timeout" | "error"; errorCode?: string }> = [];
    let busyError: DomainError | null = null;
    for (const testCase of snapshot.testCases) {
      try {
        const result = await this.runner.execute({ code, stdin: inputText(testCase.inputJson), timeoutMs: Math.min(timeoutMs, testCase.timeLimitMs ?? timeoutMs), allowedPackages });
        const status = result.timed_out ? "timeout" : result.exit_code === 0 && compareOutput(result.stdout, testCase.expectedOutput, testCase.comparisonMode, testCase.tolerance) ? "passed" : result.timed_out ? "timeout" : "failed";
        outcomes.push({ test: testCase, result, status });
      } catch (error) {
        if (error instanceof DomainError && error.code === "runner_busy") busyError = error;
        outcomes.push({ test: testCase, result: null, status: "error", errorCode: error instanceof DomainError ? error.code : "runner_failed" });
      }
    }
    const totalWeight = snapshot.testCases.reduce((sum, item) => sum + Math.max(0, Number(item.weight ?? 1)), 0) || snapshot.testCases.length;
    const passedWeight = outcomes.reduce((sum, item) => sum + (item.status === "passed" ? Math.max(0, Number(item.test.weight ?? 1)) : 0), 0);
    const score = Math.round(snapshot.maxScore * (passedWeight / totalWeight) * 100) / 100;
    const runStatus = outcomes.some((item) => item.status === "timeout") ? "timeout" : outcomes.some((item) => item.status === "error") ? "error" : outcomes.every((item) => item.status === "passed") ? "passed" : "failed";
    this.db.transaction(() => {
      for (const outcome of outcomes) {
        const result = outcome.result;
        this.db.run("INSERT INTO test_results (id, code_run_id, test_case_id, question_id, test_case_snapshot_json, status, actual_output, error_message, duration_ms, score_awarded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [randomUUID(), run.id, outcome.test.id, snapshot.id, json(outcome.test), outcome.status, outcome.test.visibility === "public" ? result?.stdout ?? null : result?.stdout ?? null, outcome.test.visibility === "public" ? result?.stderr ?? outcome.errorCode ?? null : outcome.errorCode ?? null, result?.duration_ms ?? null, outcome.status === "passed" ? snapshot.maxScore * (Math.max(0, Number(outcome.test.weight ?? 1)) / totalWeight) : 0]);
      }
      this.db.run("UPDATE code_runs SET status = ?, finished_at = ? WHERE id = ?", [runStatus, new Date().toISOString(), run.id]);
      this.db.run("UPDATE submission_answers SET auto_score = ?, final_score = ?, updated_at = ? WHERE id = ?", [score, score, new Date().toISOString(), answerId]);
      const totals = this.db.get<{ auto_score: number | null; final_score: number | null; max_score: number | null }>(`SELECT COALESCE(SUM(auto_score), 0) AS auto_score,
        COALESCE(SUM(final_score), 0) AS final_score,
        COALESCE(SUM(json_extract(question_snapshot_json, '$.maxScore')), 0) AS max_score
        FROM submission_answers WHERE submission_id = ?`, [answer.submission_id]);
      const grade = this.db.get<{ id: string }>("SELECT id FROM grades WHERE submission_id = ?", [answer.submission_id]);
      if (grade) this.db.run("UPDATE grades SET auto_score = ?, final_score = ?, max_score = ?, status = 'review_required', updated_at = ? WHERE id = ?", [totals?.auto_score ?? 0, totals?.final_score ?? 0, totals?.max_score ?? 0, new Date().toISOString(), grade.id]);
      else this.db.run("INSERT INTO grades (id, submission_id, auto_score, final_score, max_score, status) VALUES (?, ?, ?, ?, ?, 'review_required')", [randomUUID(), answer.submission_id, totals?.auto_score ?? 0, totals?.final_score ?? 0, totals?.max_score ?? snapshot.maxScore]);
    });
    if (busyError) throw busyError;
    return this.getRun(actor, run.id);
  }

  private projection(run: Record<string, any>, results: Record<string, any>[], student: boolean) {
    const answersReleased = Boolean(run.answer_release_at && new Date(run.answer_release_at).getTime() <= this.clock().getTime());
    const testResultsReleased = !student || Boolean(run.show_test_results_immediately || run.grade_status === "released" || answersReleased);
    if (!testResultsReleased) return { id: run.id, submissionAnswerId: run.submission_answer_id, snapshotId: run.snapshot_id, status: run.status, runType: run.run_type, stdout: run.stdout, stderr: run.stderr, exitCode: run.exit_code, durationMs: run.duration_ms, runnerVersion: run.runner_version, limits: JSON.parse(run.limits_json), testResultsReleased: false, testResults: [] };
    const testResults = results.map((result) => {
      let testCase: TestCaseSnapshot;
      try { testCase = JSON.parse(result.test_case_snapshot_json) as TestCaseSnapshot; } catch { testCase = { id: result.test_case_id, visibility: "hidden", expectedOutput: "" }; }
      if (student && testCase.visibility === "hidden") return { id: result.test_case_id, status: result.status, errorCode: result.status === "passed" ? null : "test_failed" };
      return { id: result.test_case_id, status: result.status, expectedOutput: testCase.expectedOutput, inputJson: testCase.inputJson, actualOutput: result.actual_output, stderr: result.error_message, durationMs: result.duration_ms, scoreAwarded: result.score_awarded };
    });
    return { id: run.id, submissionAnswerId: run.submission_answer_id, snapshotId: run.snapshot_id, status: run.status, runType: run.run_type, stdout: run.stdout, stderr: run.stderr, exitCode: run.exit_code, durationMs: run.duration_ms, runnerVersion: run.runner_version, limits: JSON.parse(run.limits_json), testResultsReleased: true, testResults };
  }

  getRun(actor: Actor, runId: string) {
    const run = this.db.get<Record<string, any>>("SELECT cr.*, sa.student_id, s.student_id AS submission_student_id, a.course_id, a.show_test_results_immediately, a.answer_release_at, g.status AS grade_status FROM code_runs cr JOIN submission_answers sa ON sa.id = cr.submission_answer_id JOIN submissions s ON s.id = sa.submission_id JOIN assignments a ON a.id = s.assignment_id LEFT JOIN grades g ON g.submission_id = s.id WHERE cr.id = ?", [runId]);
    if (!run) throw new DomainError("not_found", "Run not found", 404);
    this.assertAnswerScope(actor, this.answer(run.submission_answer_id) ?? (() => { throw new DomainError("not_found", "Run not found", 404); })());
    const results = this.db.all<Record<string, any>>("SELECT * FROM test_results WHERE code_run_id = ? ORDER BY CAST(json_extract(test_case_snapshot_json, '$.position') AS INTEGER), id", [runId]);
    return this.projection(run, results, actor.role === "student");
  }
}
