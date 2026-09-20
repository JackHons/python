import type { LocalDatabase } from "../db.ts";
import { DomainError } from "../errors.ts";

/**
 * The classroom lock is a server-side submission guard.  UI state is never
 * treated as an authority: every write path that accepts student work calls
 * this helper before mutating a submission.
 */
export function assertAssignmentSubmissionOpen(database: LocalDatabase, assignmentId: string) {
  const guarded = database.get<{ activity_status: string; session_status: string }>(
    `SELECT ca.status AS activity_status, cs.status AS session_status
       FROM classroom_activities ca
       JOIN classroom_sessions cs ON cs.id = ca.session_id
      WHERE ca.assignment_id = ? AND (ca.status = 'locked' OR cs.status = 'ended')
      ORDER BY CASE WHEN ca.status = 'locked' THEN 0 ELSE 1 END, ca.created_at DESC
      LIMIT 1`,
    [assignmentId],
  );
  if (guarded?.activity_status === "locked") throw new DomainError("activity_locked", "This classroom activity is locked", 423);
  if (guarded?.session_status === "ended") throw new DomainError("classroom_ended", "This classroom has ended and is read-only", 423);
}
