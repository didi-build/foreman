// The runner's own staging deploy (D-353, D-356, O-116). On a push to main a project's CI builds
// its site with no secret, writes the commit marker into it and keeps it as the workflow artifact
// `staging-site` (`.github/workflows/ci.yml`, job `preview-check`, O-111). The runner then:
//
// 1. Reads the CI run from GitHub again (never from the event): it must be a successful run of
//    `.github/workflows/ci.yml` started by a push to `main` from the project's own repository.
// 2. Fetches that run's `staging-site` artifact (`StagingBuilds`, the runner App's `actions: read`
//    token for that one repository, D-267).
// 3. Hands it to the deploy target (`StagingTarget`, src/adapters/deploy/), which checks the file
//    set and, only when it passes, uploads exactly those files to the project's staging site. A
//    set that fails is refused with fixed text and nothing is uploaded (`file_set`); a refusal by
//    Cloudflare, the deploy credential or GitHub's artifact is `infrastructure`.
// 4. Records the outcome on each item in Verifying on staging whose merge commit the deployed
//    commit counts for, by GitHub's compare as O-38 does (D-225 rule 1): `staging_deploy` for a
//    deploy, `staging_deploy_failed` for a refusal, keyed per CI run, cause and merge commit. A
//    refused file set counts as a failed deploy (D-225 rule 2: the build is the change's own
//    output); an infrastructure refusal counts no failure, and the item keeps waiting for a deploy
//    and shows on the attention list after the wait setting (O-40) and in the daily check (N-103).
// 5. Starts the staging check for each of those items in the same run (./staging.ts `verify`),
//    whose moves the guards decide.
//
// A deploy that covers no item is made and recorded nowhere in the store: evidence belongs to an
// item, and no table holds a project's deploy without a migration (N-104). Its result is the
// flow's.
//
// The switches: under the kill switch nothing is read or deployed. In dry run nothing is fetched,
// uploaded or recorded; the result says what would be deployed and which items it would cover.
//
// The backstop (`backstop`, the reconcile flow's passes): for a project with an item in Verifying
// on staging that has no deploy recorded for its merge commit (none, or only infrastructure
// refusals), the newest successful CI run on main is deployed when its commit counts for one of
// those items. So a missed event, an infrastructure refusal and an item that reached Verifying on
// staging after its deploy are each retried once per pass.
//
// Plain logic over injected ports (D-162): no Cloudflare, HTTP or GitHub code here (essential 9).
import {
  INFRASTRUCTURE_CAUSE,
  countsAsFailedDeploy,
  latest,
  readDeployRefusal,
} from "./guards/evidence.ts";
import {
  PREVIEW_CHECK_WORKFLOW,
  PREVIEW_CHECK_WORKFLOW_FILE,
} from "./preview-check.ts";
import {
  createCoverReader,
  createStaging,
  STAGING_MAIN_BRANCH,
  type CoverProof,
  type StagingDeps,
  type StagingResult,
} from "./staging.ts";
import type { Evidence, Json, Node, Project, StoreOps } from "./store.ts";

/** The artifact CI keeps the built site in, on a push to main only (O-116). */
export const STAGING_SITE_ARTIFACT = "staging-site";
/** The workflow whose build is deployed: the project's CI (O-111). */
export const STAGING_BUILD_WORKFLOW = PREVIEW_CHECK_WORKFLOW;
/** The workflow's file name, as GitHub's workflow runs list takes it. */
export const STAGING_BUILD_WORKFLOW_FILE = PREVIEW_CHECK_WORKFLOW_FILE;
/** The only event whose run is deployed. */
export const STAGING_BUILD_EVENT = "push";

const FULL_SHA = /^[0-9a-f]{40}$/;

/** A CI workflow run as GitHub reports it now. */
export interface BuildRun {
  id: number;
  /** The workflow file, for example `.github/workflows/ci.yml`. */
  path: string;
  /** The event that started the run, for example `push`. */
  event: string;
  headSha: string;
  headBranch: string | null;
  /** The repository the run's commit came from, `owner/name`. */
  headRepo: string | null;
  status: string;
  conclusion: string | null;
}

/**
 * What the runner reads from GitHub to deploy a CI build (D-267: the runner App's `actions: read`,
 * minted for one repository per read). Implemented in src/adapters/github/staging-builds.ts.
 */
export interface StagingBuilds {
  /** The run, read from GitHub now; null when GitHub has no such run. */
  getRun(repo: string, runId: number): Promise<BuildRun | null>;
  /** The newest successful run of CI started by a push to main; null when there is none. */
  latestMainBuild(repo: string): Promise<BuildRun | null>;
  /**
   * The `staging-site` artifact of exactly that run, as GitHub serves it (a zip file); null when
   * the run kept none or it has expired.
   */
  siteArchive(repo: string, runId: number): Promise<Uint8Array | null>;
}

/** `file_set`: the build is not a site the runner uploads. `infrastructure`: see the header. */
export type DeployRefusalCause = "file_set" | typeof INFRASTRUCTURE_CAUSE;

export type StagingUpload =
  | { outcome: "deployed"; files: number }
  | {
      outcome: "refused";
      cause: DeployRefusalCause;
      /** A short fixed code. */
      reason: string;
      /** Fixed text: never a path, a value or a word from the build or from Cloudflare. */
      text: string;
    };

/**
 * The deploy adapter's staging target (ADR 0111 section 2, `deploy`): it checks the site and, only
 * when the check passes, uploads exactly its files as the project's staging site. It never makes
 * a route, a custom domain or a DNS record (D-357). A refusal is returned, not thrown.
 */
export interface StagingTarget {
  deploy(request: {
    project: Project;
    commitSha: string;
    archive: Uint8Array;
  }): Promise<StagingUpload>;
}

/** The fixed texts of the refusals the runner makes itself, before or around the target. */
export const DEPLOY_REFUSALS = {
  run_unreadable: "GitHub's record of the CI run could not be read",
  artifact_missing: "the CI run kept no staging-site build, or it has expired",
  artifact_unreadable: "the CI run's staging-site build could not be downloaded",
  target_error: "the deploy target failed without saying why",
} as const;

/** Why a deploy result names no covered item: GitHub's compare could not be read. */
export const COVER_UNREADABLE =
  "GitHub's compare could not be read, so no item was recorded; the reconcile pass retries";

const infrastructure = (reason: keyof typeof DEPLOY_REFUSALS): StagingUpload => ({
  outcome: "refused",
  cause: INFRASTRUCTURE_CAUSE,
  reason,
  text: DEPLOY_REFUSALS[reason],
});

/** A successful run of CI started by a push to main from the repository itself (O-116). */
export function isMainBuild(run: BuildRun, repo: string): boolean {
  return (
    run.path === STAGING_BUILD_WORKFLOW &&
    run.event === STAGING_BUILD_EVENT &&
    run.headBranch === STAGING_MAIN_BRANCH &&
    run.headRepo === repo &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    FULL_SHA.test(run.headSha)
  );
}

/** The key of a deploy on one merge commit it covers: one per CI run and merge commit. */
export const stagingDeployRecordKey = (
  repo: string,
  runId: number,
  mergeSha: string,
): string => `runner:staging_deploy:${repo}:run-${runId}:covers-${mergeSha}`;

/**
 * The key of a refused deploy on one merge commit it covers: one per CI run, cause and merge
 * commit, so a retried run that infrastructure refused once and the file set refuses later is
 * recorded again.
 */
export const stagingDeployRefusedKey = (
  repo: string,
  runId: number,
  cause: DeployRefusalCause,
  mergeSha: string,
): string =>
  `runner:staging_deploy_failed:${repo}:run-${runId}:${cause}:covers-${mergeSha}`;

export type StagingDeployStep =
  /** The kill switch is on. Nothing was read or written. */
  | "refused"
  /** The repository is not a registered project. */
  | "not_a_project"
  /** The run is not a successful CI run started by a push to main from the repository. */
  | "not_a_main_build"
  /** Dry run: what would be deployed. Nothing was fetched, uploaded or recorded. */
  | "would_deploy"
  | "deployed"
  | "refused_file_set"
  | "refused_infrastructure";

export interface StagingDeployResult {
  repo: string;
  runId: number;
  step: StagingDeployStep;
  /** The run's head commit, which was deployed or would be. */
  commitSha?: string;
  /** For a refusal: its fixed code and text. */
  reason?: string;
  text?: string;
  /** For a deploy: how many files the site has. */
  files?: number;
  /** The items in Verifying on staging whose merge commit the deployed commit counts for. */
  covers?: string[];
  /** What was recorded on each covered item. */
  recorded?: { nodeId: string; evidenceId: string }[];
  /** The staging check of each covered item, run right after the record (D-356). */
  verified?: StagingResult[];
  /** Set when the covered items could not be worked out, so nothing was recorded. */
  problem?: string;
}

/** What the backstop did for one project with an item waiting for a deploy. */
export interface StagingBackstopStep {
  repo: string;
  step:
    | "deploy"
    /** GitHub lists no successful CI run on main that the runner may deploy. */
    | "no_main_build"
    /** The newest one does not count for any waiting item yet: CI has not built it. */
    | "not_covered"
    /** GitHub could not be read. */
    | "unreadable";
  deploy?: StagingDeployResult;
}

export interface StagingDeployDeps extends StagingDeps {
  builds: StagingBuilds;
  target: StagingTarget;
}

/**
 * The latest refusal by infrastructure recorded on a node's merge commit since it entered its
 * state, while no deploy is recorded on it: what the daily check shows as a deploy that did not go
 * through and counted no failure (O-116, N-103). Null otherwise.
 */
export async function pendingDeployError(
  store: Pick<StoreOps, "listEvidence">,
  node: Node,
): Promise<{ at: Date; reason: string; text: string } | null> {
  const merge = latest(
    await store.listEvidence({ nodeId: node.id, kind: "merge_commit" }),
  );
  const sha = merge?.commitSha;
  if (!sha) return null;
  const deployed = await store.listEvidence({
    nodeId: node.id,
    kind: "staging_deploy",
    commitSha: sha,
  });
  if (deployed.length > 0) return null;
  const refused = latest(
    (
      await store.listEvidence({
        nodeId: node.id,
        kind: "staging_deploy_failed",
        commitSha: sha,
      })
    ).filter(
      (e) =>
        !countsAsFailedDeploy(e.payload) &&
        e.recordedAt.getTime() >= node.stateSince.getTime(),
    ),
  );
  if (!refused) return null;
  const refusal = readDeployRefusal(refused.payload);
  return refusal ? { at: refused.recordedAt, ...refusal } : null;
}

export function createStagingDeploys(deps: StagingDeployDeps) {
  const { store, clock, ids, github, builds, target } = deps;
  const staging = createStaging(deps);

  const killSwitchOn = async () =>
    (await store.getSetting("kill_switch"))?.value === true;
  // A missing setting means dry run, as in the library.
  const dryRunOn = async () => (await store.getSetting("dry_run"))?.value !== false;

  /** The node's latest merge commit, when it is in Verifying on staging. */
  async function verifyingMerge(node: Node): Promise<string | null> {
    if (!staging.stagingMovesFor(node)) return null;
    const merge = latest(
      await store.listEvidence({ nodeId: node.id, kind: "merge_commit" }),
    );
    return merge?.commitSha ?? null;
  }

  /**
   * The items of `repo` in Verifying on staging whose merge commit `commitSha` counts for, with
   * the proof (D-225 rule 1, O-38). Found through their dispatch records, which name the
   * repository. GitHub's errors are thrown.
   */
  async function coveredItems(
    repo: string,
    commitSha: string,
  ): Promise<{ node: Node; mergeSha: string; proof: CoverProof }[]> {
    const covered: { node: Node; mergeSha: string; proof: CoverProof }[] = [];
    for (const dispatch of await store.listDispatches({ repo })) {
      const node = await store.getNode(dispatch.nodeId);
      if (!node) continue;
      const mergeSha = await verifyingMerge(node);
      if (!mergeSha) continue;
      const proof = await createCoverReader(github, repo, mergeSha)(commitSha);
      if (proof) covered.push({ node, mergeSha, proof });
    }
    return covered;
  }

  /** Inserts a fact under its key, or returns the row that took the key first. */
  async function recordOnce(evidence: Evidence, key: string): Promise<Evidence | null> {
    if (await store.insertEvidenceOnce(evidence, key)) return evidence;
    const existing = await store.listEvidence({
      nodeId: evidence.nodeId,
      kind: evidence.kind,
      ...(evidence.commitSha ? { commitSha: evidence.commitSha } : {}),
    });
    return existing.find((e) => e.ref === key) ?? null;
  }

  /** What the outcome records on one covered item. */
  function factFor(
    repo: string,
    run: BuildRun,
    upload: StagingUpload,
    item: { node: Node; mergeSha: string; proof: CoverProof },
  ): { evidence: Evidence; key: string } {
    const facts = { deployedSha: run.headSha, workflowRunId: run.id, ...item.proof };
    const deployed = upload.outcome === "deployed";
    const key = deployed
      ? stagingDeployRecordKey(repo, run.id, item.mergeSha)
      : stagingDeployRefusedKey(repo, run.id, upload.cause, item.mergeSha);
    const payload: Json = deployed
      ? { ...facts, files: upload.files }
      : {
          ...facts,
          // `failure` counts as D-225 rule 2 reads it; `error` with the cause counts nothing.
          state: upload.cause === INFRASTRUCTURE_CAUSE ? "error" : "failure",
          cause: upload.cause,
          reason: upload.reason,
          text: upload.text,
        };
    return {
      key,
      evidence: {
        id: ids.next(),
        nodeId: item.node.id,
        runId: null,
        kind: deployed ? "staging_deploy" : "staging_deploy_failed",
        ref: key,
        commitSha: item.mergeSha,
        payload,
        recordedBy: "runner",
        recordedAt: clock.now(),
        supersedesId: null,
      },
    };
  }

  /**
   * Step 4: records a deploy's outcome on each item of `repo` in Verifying on staging whose merge
   * commit the run's commit counts for, once per run, cause and merge commit. GitHub's errors are
   * thrown, and then nothing is recorded.
   */
  async function record(
    repo: string,
    run: BuildRun,
    outcome: StagingUpload,
  ): Promise<{ covers: Node[]; recorded: { nodeId: string; evidenceId: string }[] }> {
    const covered = await coveredItems(repo, run.headSha);
    const recorded: { nodeId: string; evidenceId: string }[] = [];
    for (const item of covered) {
      const { evidence, key } = factFor(repo, run, outcome, item);
      const row = await recordOnce(evidence, key);
      if (row) recorded.push({ nodeId: item.node.id, evidenceId: row.id });
    }
    return { covers: covered.map((c) => c.node), recorded };
  }

  /** The upload, from the run's artifact. Every error becomes an infrastructure refusal. */
  async function upload(project: Project, run: BuildRun): Promise<StagingUpload> {
    let archive: Uint8Array | null;
    try {
      archive = await builds.siteArchive(project.repo, run.id);
    } catch {
      return infrastructure("artifact_unreadable");
    }
    if (archive === null) return infrastructure("artifact_missing");
    try {
      return await target.deploy({ project, commitSha: run.headSha, archive });
    } catch {
      return infrastructure("target_error");
    }
  }

  /** Deploys one CI run's build to the project's staging site, then records and checks. */
  async function deployRun(repo: string, runId: number): Promise<StagingDeployResult> {
    const base = { repo, runId };
    if (await killSwitchOn()) return { ...base, step: "refused" };
    const project = (await store.listProjects()).find((p) => p.repo === repo);
    if (!project) return { ...base, step: "not_a_project" };
    let run: BuildRun | null;
    try {
      run = await builds.getRun(repo, runId);
    } catch {
      return {
        ...base,
        step: "refused_infrastructure",
        reason: "run_unreadable",
        text: DEPLOY_REFUSALS.run_unreadable,
      };
    }
    if (!run || run.id !== runId || !isMainBuild(run, repo)) {
      return { ...base, step: "not_a_main_build" };
    }
    const commitSha = run.headSha;

    if (await dryRunOn()) {
      try {
        const covered = await coveredItems(repo, commitSha);
        return {
          ...base,
          step: "would_deploy",
          commitSha,
          covers: covered.map((c) => c.node.id),
        };
      } catch {
        return { ...base, step: "would_deploy", commitSha, problem: COVER_UNREADABLE };
      }
    }

    // Deploy, then record, then check (D-356).
    const outcome = await upload(project, run);
    const done: StagingDeployResult =
      outcome.outcome === "deployed"
        ? { ...base, step: "deployed", commitSha, files: outcome.files }
        : {
            ...base,
            step:
              outcome.cause === INFRASTRUCTURE_CAUSE
                ? "refused_infrastructure"
                : "refused_file_set",
            commitSha,
            reason: outcome.reason,
            text: outcome.text,
          };
    let recorded;
    try {
      recorded = await record(repo, run, outcome);
    } catch {
      return { ...done, problem: COVER_UNREADABLE };
    }
    // An infrastructure refusal says nothing about the change: no check, no move (N-103).
    const verified: StagingResult[] = [];
    if (done.step !== "refused_infrastructure") {
      for (const node of recorded.covers) verified.push(await staging.verify(node.id));
    }
    return {
      ...done,
      covers: recorded.covers.map((n) => n.id),
      recorded: recorded.recorded,
      verified,
    };
  }

  /**
   * The items of the project in Verifying on staging with no deploy recorded for their merge
   * commit: none, or only refusals by infrastructure.
   */
  async function waitingMerges(project: Project): Promise<string[]> {
    const waiting: string[] = [];
    for (const node of await store.listNodes({ projectId: project.id })) {
      const sha = await verifyingMerge(node);
      if (!sha) continue;
      const deployed = await store.listEvidence({
        nodeId: node.id,
        kind: "staging_deploy",
        commitSha: sha,
      });
      const failed = (
        await store.listEvidence({
          nodeId: node.id,
          kind: "staging_deploy_failed",
          commitSha: sha,
        })
      ).filter((e) => countsAsFailedDeploy(e.payload));
      if (deployed.length === 0 && failed.length === 0) waiting.push(sha);
    }
    return waiting;
  }

  return {
    deployRun,
    record,

    /**
     * The reconcile flow's backstop: for each project with an item waiting for a deploy, the
     * newest successful CI run on main, deployed when its commit counts for a waiting item. In
     * dry run each deploy says what it would do. Under the kill switch nothing.
     */
    async backstop(): Promise<StagingBackstopStep[]> {
      if (await killSwitchOn()) return [];
      const steps: StagingBackstopStep[] = [];
      for (const project of await store.listProjects()) {
        const waiting = await waitingMerges(project);
        if (waiting.length === 0) continue;
        const repo = project.repo;
        let run: BuildRun | null;
        try {
          run = await builds.latestMainBuild(repo);
        } catch {
          steps.push({ repo, step: "unreadable" });
          continue;
        }
        if (!run || !isMainBuild(run, repo)) {
          steps.push({ repo, step: "no_main_build" });
          continue;
        }
        let counts = false;
        try {
          for (const sha of waiting) {
            if (await createCoverReader(github, repo, sha)(run.headSha)) {
              counts = true;
              break;
            }
          }
        } catch {
          steps.push({ repo, step: "unreadable" });
          continue;
        }
        if (!counts) {
          steps.push({ repo, step: "not_covered" });
          continue;
        }
        steps.push({ repo, step: "deploy", deploy: await deployRun(repo, run.id) });
      }
      return steps;
    },
  };
}

export type StagingDeploys = ReturnType<typeof createStagingDeploys>;
