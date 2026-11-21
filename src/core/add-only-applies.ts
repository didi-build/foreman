// The applies made without Didi's approval (D-378, D-444, ADR 0118 appendix B, O-158), as the
// daily check lists them. When a Platform or Infra plan only adds standard-size projects, its
// add-only apply job runs in an environment with no reviewer: `kubectl-apply-add-only` in
// `platform-add-project`, `tofu-apply-add-only` in `infra-add-project`. Each job's name carries
// the projects it adds, `<job> (<slug>,<slug>)`, so nothing needs recording: GitHub keeps the
// runs, and the daily check reads the jobs of the two workflows' recent runs with the runner App's
// `actions: read` token (D-267), as it reads Bootstrap's runs (O-114). Reads only.
//
// Each add-only apply job that ran is listed: when it ended (or started, while it runs), the
// workflow, the projects, and whether it applied, is still running, or did not finish (it may
// then have applied part of its plan). A job that was skipped never ran and is not listed. A job
// whose name does not show its projects is still listed, saying so. When GitHub's runs cannot be
// read, the check says so rather than show nothing, so an apply is never left unseen.
import { PROJECT_ENTRY_SLUG } from "./project-entry.ts";

/** The two admin workflows with an add-only apply, by GitHub's `workflow_id` (the file name). */
export const ADD_ONLY_WORKFLOWS = {
  platform: {
    file: "platform.yml",
    label: "Platform",
    job: "kubectl-apply-add-only",
    environment: "platform-add-project",
  },
  infra: {
    file: "infra-apply.yml",
    label: "Infra apply",
    job: "tofu-apply-add-only",
    environment: "infra-add-project",
  },
} as const;

export type AddOnlyWorkflow = keyof typeof ADD_ONLY_WORKFLOWS;

/** The repository whose runs are read: Foreman's own (the workflows run only there, on main). */
export const ADD_ONLY_REPOSITORY = "didi-build/foreman";

/** One add-only apply job as GitHub shows it. */
export interface AddOnlyApplyJob {
  workflow: AddOnlyWorkflow;
  /** The run's number in its workflow, as GitHub's run list shows it (`#57`). */
  runNumber: number;
  /** The job's name as GitHub shows it, with its expression filled in. */
  name: string;
  /** `queued`, `in_progress`, `completed` and GitHub's other job statuses. */
  status: string;
  /** Set once the job completed: `success`, `failure`, `cancelled`, `skipped` and the others. */
  conclusion: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface AddOnlyApplies {
  /**
   * Every add-only apply job in the two workflows' runs that were still going at `since` or
   * started after it. Throws on a failed read, and when there may be more than it read.
   */
  jobsSince(since: Date): Promise<AddOnlyApplyJob[]>;
}

/** One apply made without approval, as the daily check shows it. */
export interface UnreviewedApply {
  workflow: AddOnlyWorkflow;
  /** The workflow's name, for example "Platform". */
  label: string;
  runNumber: number;
  /** The projects from the job's name, or null when the name does not show them. */
  projects: string[] | null;
  outcome: "applied" | "running" | "did_not_finish";
  /** GitHub's conclusion for a job that did not finish, for example `failure`. */
  conclusion: string | null;
  /** When it ended, or, while it runs, when it started. */
  at: Date;
}

export interface UnreviewedApplies {
  /** Oldest first. */
  applies: UnreviewedApply[];
  /** True when GitHub's runs could not be read: whether any apply ran is then not known. */
  unreadable: boolean;
}

/**
 * The projects a job's name carries, `<job> (<slug>,<slug>)` with one to three slugs the entry
 * rule accepts, or null for any other name.
 */
export function projectsOfJobName(
  workflow: AddOnlyWorkflow,
  name: string,
): string[] | null {
  const prefix = `${ADD_ONLY_WORKFLOWS[workflow].job} (`;
  if (!name.startsWith(prefix) || !name.endsWith(")")) return null;
  const slugs = name.slice(prefix.length, -1).split(",");
  return slugs.length <= 3 && slugs.every((s) => PROJECT_ENTRY_SLUG.test(s))
    ? slugs
    : null;
}

/** Whether a job's name is a workflow's add-only apply's, with or without its projects. */
export const isAddOnlyJobName = (workflow: AddOnlyWorkflow, name: string): boolean => {
  const job = ADD_ONLY_WORKFLOWS[workflow].job;
  return name === job || name.startsWith(`${job} `);
};

const inWindow = (at: Date, from: Date, to: Date): boolean =>
  at.getTime() >= from.getTime() && at.getTime() < to.getTime();

/**
 * For the daily check: each add-only apply that ran in the window, and each still running. Reads
 * only. A job that completed as `skipped` never ran.
 */
export async function unreviewedApplies(
  deps: { addOnlyApplies: AddOnlyApplies },
  window: { from: Date; to: Date },
): Promise<UnreviewedApplies> {
  let jobs: AddOnlyApplyJob[];
  try {
    jobs = await deps.addOnlyApplies.jobsSince(window.from);
  } catch {
    return { applies: [], unreadable: true };
  }
  const applies: UnreviewedApply[] = [];
  for (const job of jobs) {
    if (!isAddOnlyJobName(job.workflow, job.name)) continue;
    const base = {
      workflow: job.workflow,
      label: ADD_ONLY_WORKFLOWS[job.workflow].label,
      runNumber: job.runNumber,
      projects: projectsOfJobName(job.workflow, job.name),
    };
    if (job.status !== "completed") {
      const at = job.startedAt;
      if (at !== null && at.getTime() < window.to.getTime()) {
        applies.push({ ...base, outcome: "running", conclusion: null, at });
      }
      continue;
    }
    if (job.conclusion === "skipped" || job.completedAt === null) continue;
    if (!inWindow(job.completedAt, window.from, window.to)) continue;
    applies.push({
      ...base,
      outcome: job.conclusion === "success" ? "applied" : "did_not_finish",
      conclusion: job.conclusion === "success" ? null : job.conclusion,
      at: job.completedAt,
    });
  }
  applies.sort(
    (a, b) =>
      a.at.getTime() - b.at.getTime() ||
      a.workflow.localeCompare(b.workflow) ||
      a.runNumber - b.runNumber,
  );
  return { applies, unreadable: false };
}
