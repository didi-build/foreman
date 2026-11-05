// Where a Job is, from its own conditions (ADR 0106 section 6). The runtime's `poll` reads it to
// know whether a run has ended, and the run watcher reads it to know when to start the run-end
// flow (D-330), so the two always agree on what a stopped Job is. Its own file, with no import but
// a type, so the watcher's image copies it without the result parser.
import type { JobStatus } from "./objects.ts";

export type JobState =
  "running" | "stopping" | "complete" | "deadline" | "failed" | "gone";

/** Where a Job is. Only Complete and Failed are ends: FailureTarget means pods still stop. */
export function jobState(job: JobStatus | null): JobState {
  if (job === null) return "gone";
  if (job.metadata.deletionTimestamp) return "stopping";
  const conditions = job.status?.conditions ?? [];
  const holds = (type: string) =>
    conditions.find((c) => c.type === type && c.status === "True");
  if (holds("Complete")) return "complete";
  const failed = holds("Failed");
  if (failed) return failed.reason === "DeadlineExceeded" ? "deadline" : "failed";
  return "running";
}
