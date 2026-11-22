// The deploy adapter's cluster target (ADR 0118 appendix G, D-441, slice 9, O-166): where Foreman
// itself runs, Foreman's own cluster. Its first build never applies anything to the cluster (the
// runner never holds cluster admin, D-340) and never calls Cloudflare. A release of Foreman is
// production (D-007): Didi copies the new image pins into infra/kubernetes/settings/production.json
// and approves the Platform workflow's apply. So the deploy only reads, and says where the merged
// commit stands.
//
// `deploy({project, commitSha})`: the Images workflow's run for exactly that commit, read with
// the runner App's `actions: read` token for the project's repository only (D-267), through the
// two reads GitHub ingestion already makes (src/adapters/github/workflow-runs.ts, the core's
// `GitHubWorkflowReader`): `GET /repos/{repo}/actions/workflows/images.yml/runs?head_sha={sha}`,
// then the jobs of the newest such run. The Images workflow (.github/workflows/images.yml) builds
// and pushes Foreman's images from a push to main in one job, `build-and-push`; its success means
// every image was pushed and the run's artifact `foreman-images` holds their references pinned by
// digest, which nothing applies until Didi pins and applies them. A run of another workflow, from
// another repository, or whose job is missing is not counted. The answer:
//
// - `awaiting_apply`, with the run's id: the job completed with `success`, so the commit's images
//   were built and wait for Didi's Platform apply of the new pins.
// - A refusal with fixed text (`CLUSTER_REFUSALS`), each infrastructure: the job still runs
//   (`images_building`); was cancelled, most likely by a newer push whose run builds this commit
//   too, since the workflow cancels a run in progress (`images_cancelled`); ended any other way
//   (`images_failed`); no run is listed for the commit (`images_missing`: the commit changed none
//   of the paths the workflow builds from, or GitHub has not listed the run yet); or GitHub could
//   not be read (`images_unreadable`). None counts against the change: a cluster-target item is
//   Done at merge (D-449), so there is nothing to send back; and a pull request that changes
//   `src/` already had every image built by CI's container checks (.github/workflows/
//   containers.yml) before the merge, so a failed Images run is more often the registry's or
//   GitHub's than the change's, and the run's own page says which.
//
// `setUp`, `putSecret` and `listSecretNames` refuse with fixed text: Didi writes Foreman's project
// file by hand, since a cluster-target file is never add-only (appendix B), and Foreman's own
// secrets go through the Platform workflow's cluster Secrets job, which Didi approves.
//
// Nothing here logs, keeps a token or returns GitHub's words: only the run's id, fixed codes and
// fixed texts.
import type {
  ClusterDeploy,
  ClusterDeployTarget,
  ProjectSetUp,
  TargetRefusal,
} from "../../core/deploy-target.ts";
import type { GitHubWorkflowReader, WorkflowJob } from "../../core/github.ts";
import type { StagingRefusal } from "../../core/staging-deploy.ts";

/** The workflow that builds Foreman's images on a push to main, as its runs name it. */
export const IMAGES_WORKFLOW = ".github/workflows/images.yml";
/** Its file name, as GitHub's workflow runs list takes it. */
export const IMAGES_WORKFLOW_FILE = "images.yml";
/** Its one job (`name:`), which builds and pushes every image. */
export const IMAGES_JOB = "build-and-push";

/** The cluster target's refusals of a deploy. Fixed text; none quotes GitHub. */
export const CLUSTER_REFUSALS = {
  images_building:
    "the Images workflow is still building this commit's images; the daily check shows the upgrade once they are built",
  images_cancelled:
    "the Images run for this commit was cancelled, most likely by a newer push to main whose run also builds this commit",
  images_failed:
    "the Images run for this commit did not succeed, so no new images wait for the Platform apply; run the Images workflow again on main",
  images_missing:
    "no Images run is listed for this commit: it changed nothing the images are built from, or GitHub has not listed the run yet",
  images_unreadable:
    "GitHub's record of the Images runs for this commit could not be read",
} as const;

export type ClusterRefusal = keyof typeof CLUSTER_REFUSALS;

/** Why setup and product secrets have no place on the cluster target (appendix G). */
export const CLUSTER_TARGET_REFUSALS = {
  no_setup:
    "Foreman's own cluster target sets nothing up: Didi writes the project file and approves its Platform plan (ADR 0118 appendix G)",
  no_secrets:
    "Foreman's own cluster target holds no product secrets: Foreman's secrets go through the Platform workflow's cluster Secrets job, which Didi approves",
} as const;

const FULL_SHA = /^[0-9a-f]{40}$/;

export interface ClusterTargetOptions {
  /** The runner's reads of a workflow's runs and jobs, with its `actions: read` token (D-267). */
  workflows: GitHubWorkflowReader;
}

const refused = (reason: ClusterRefusal): StagingRefusal => ({
  outcome: "refused",
  cause: "infrastructure",
  reason,
  text: CLUSTER_REFUSALS[reason],
});

/** The Images job's answer for a commit, from its newest run's build job. */
function answerOf(runId: number, job: WorkflowJob | undefined): ClusterDeploy {
  if (!job) return refused("images_unreadable");
  if (job.status !== "completed") return refused("images_building");
  if (job.conclusion === "success") {
    return { outcome: "awaiting_apply", images: { runId } };
  }
  return refused(job.conclusion === "cancelled" ? "images_cancelled" : "images_failed");
}

export function createClusterTarget({
  workflows,
}: ClusterTargetOptions): ClusterDeployTarget {
  const noSetUp = (): ProjectSetUp => ({
    outcome: "refused",
    step: "check",
    reason: "no_setup",
    text: CLUSTER_TARGET_REFUSALS.no_setup,
  });
  const noSecrets = (): TargetRefusal => ({
    outcome: "refused",
    reason: "no_secrets",
    text: CLUSTER_TARGET_REFUSALS.no_secrets,
  });

  return {
    name: "cluster",

    async deploy({ project, commitSha }) {
      if (!FULL_SHA.test(commitSha)) return refused("images_unreadable");
      const repo = project.repo;
      try {
        const runs = (
          await workflows.listWorkflowRuns(repo, IMAGES_WORKFLOW_FILE, commitSha)
        ).filter(
          (run) =>
            run.path === IMAGES_WORKFLOW &&
            run.headSha === commitSha &&
            run.headRepo === repo,
        );
        if (runs.length === 0) return refused("images_missing");
        // The newest run for the commit: a rerun keeps its id, a new run gets a larger one.
        const newest = runs.reduce((a, b) => (b.id > a.id ? b : a));
        const job = (await workflows.listWorkflowJobs(repo, newest.id)).find(
          (j) => j.runId === newest.id && j.name === IMAGES_JOB,
        );
        return answerOf(newest.id, job);
      } catch {
        return refused("images_unreadable");
      }
    },

    async setUp() {
      return noSetUp();
    },

    async putSecret() {
      return noSecrets();
    },

    async listSecretNames() {
      return noSecrets();
    },
  };
}
