// The runner's own staging deploy (D-353, D-356, O-116). On a push to main a project's CI builds
// its site with no secret, writes the commit marker into it and keeps it as the workflow artifact
// `staging-site` (`.github/workflows/ci.yml`, job `preview-check`, O-111). The runner then:
//
// 1. Reads the CI run from GitHub again (never from the event): it must be a successful run of
//    `.github/workflows/ci.yml` started by a push to `main` from the project's own repository.
// 2. Fetches that run's `staging-site` artifact (`StagingBuilds`, the runner App's `actions: read`
//    token for that one repository, D-267).
// 3. Hands it to the deploy target (`StagingTarget`, src/adapters/deploy/), which checks the file
//    set and, only when it passes, uploads exactly those files to the project's staging site,
//    with the build's Worker module when it has one (O-159). A set that fails is refused with
//    fixed text and nothing is uploaded (`file_set`); a refusal by Cloudflare, the deploy
//    credential or GitHub's artifact is `infrastructure`. Before a build with a Worker is
//    uploaded, every product secret its manifest requires must be set on the project's staging
//    Worker (D-448, O-163): the target hands the names to `beforeWorkerUpload`, which compares
//    them with the names the target lists (`listSecretNames`). A missing name holds the deploy as
//    an infrastructure refusal (`secrets_missing`) whose text names the missing secrets and the
//    Set project secret form, and nothing is uploaded; names that cannot be read hold it too
//    (`secrets_unreadable`). Like any infrastructure refusal it counts no failure, shows in the
//    daily check, and the backstop deploys on its next pass once the secret is set. Then, for a
//    build that carries D1 migrations, the target applies the new ones to the project's staging
//    database before it uploads (ADR 0118 slice 8, O-165). A migration the database refuses as
//    SQL is the change's own failure, like a refused file set (`file_set`, `migration_failed`,
//    its text naming the file); a missing database, a refused D1 credential or a D1 call that
//    fails is `infrastructure`. A held deploy applies no migration.
// 4. Records the outcome on each item in Verifying on staging whose merge commit the deployed
//    commit counts for, by GitHub's compare as O-38 does (D-225 rule 1): `staging_deploy` for a
//    deploy (with `worker: true` when it carried a Worker module, O-159),
//    `staging_deploy_failed` for a refusal, keyed per CI run, cause and merge commit. A
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
// Routing by target (ADR 0118 slice 9, D-441, O-166): the deploy goes to the target the project's
// store row names (`deployTarget`, migration 0028), each given by name (`targets`). Everything
// above is the `cloudflare` target's path, unchanged. A `cluster` project (Foreman itself, appendix
// G) has no staging: its items are Done at merge (D-449, ./staging.ts), so its deploy fetches no
// `staging-site` build, calls no Cloudflare, records nothing on an item and runs no check. After
// steps 1 and 2's checks of the CI run, the cluster target reads the Images workflow's run for the
// commit and answers `awaiting_apply` (its images were built and wait for Didi's Platform apply of
// the new pins) or refuses with fixed text. Every such refusal is infrastructure: the item is Done
// already, so nothing counts and nothing moves. The answer is the flow's result only, as for any
// deploy that covers no item (N-104), and the daily check reads the waiting upgrade from GitHub
// itself (./cluster-release.ts). The backstop leaves cluster projects out: none of their items
// waits for a deploy.
//
// Plain logic over injected ports (D-162): no Cloudflare, HTTP or GitHub code here (essential 9).
import {
  DEPLOY_REFUSAL_TEXT_MAX_CHARS,
  INFRASTRUCTURE_CAUSE,
  countsAsFailedDeploy,
  latest,
  readDeployRefusal,
} from "./guards/evidence.ts";
import {
  PREVIEW_CHECK_WORKFLOW,
  PREVIEW_CHECK_WORKFLOW_FILE,
} from "./preview-check.ts";
import type {
  ClusterDeploy,
  ClusterDeployTarget,
  DeployTarget,
  SecretNames,
} from "./deploy-target.ts";
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

/**
 * Where a target's refusal came from, for diagnosis (O-139): the fixed name of the call that was
 * refused, the HTTP status when the provider answered, and the provider's numeric error codes.
 * A fixed name and numbers only: never a message, an id or a value.
 */
export interface DeployRefusalDetail {
  call: string;
  status?: number;
  codes?: number[];
}

/**
 * What a deploy with a Worker module adds (ADR 0118 slice 3, O-159): the names of the product
 * secrets the build's manifest says the Worker needs (D-440), never a value. The deploy holds
 * while one of them is not set on the staging Worker (D-448, O-163).
 */
export interface WorkerDeploy {
  requiredSecrets: string[];
}

/** A deploy that was not made: why, in fixed text. */
export interface StagingRefusal {
  outcome: "refused";
  cause: DeployRefusalCause;
  /** A short fixed code. */
  reason: string;
  /**
   * Fixed text: never a path, a value or a word from the build or from Cloudflare, except the
   * names of missing secrets (`secrets_missing`), which passed the manifest's name rule (D-448),
   * and the name of a failed migration file (`migration_failed`), which passed the build's name
   * rule (O-165). Never SQL text or a row.
   */
  text: string;
  detail?: DeployRefusalDetail;
  /** `secrets_missing`: every missing secret's name, sorted. Names only, never a value. */
  missingSecrets?: string[];
}

export type StagingUpload =
  | {
      outcome: "deployed";
      files: number;
      /** Only when the build carried a Worker module, so `/api` runs code. */
      worker?: WorkerDeploy;
      /**
       * Only when the build carried D1 migrations: the names of those this deploy applied, in
       * order, none when every one was applied before (O-165). Names only, never SQL.
       */
      migrationsApplied?: string[];
    }
  | StagingRefusal;

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
    /**
     * For a build with a Worker module: called once its file set has passed and before any
     * migration is applied or anything is uploaded, with the names its manifest requires. A
     * refusal it returns is the deploy's answer, and nothing is applied or uploaded (D-448,
     * O-163, O-165).
     */
    beforeWorkerUpload?: (worker: WorkerDeploy) => Promise<StagingRefusal | null>;
  }): Promise<StagingUpload>;
}

/** The fixed texts of the refusals the runner makes itself, before or around the target. */
export const DEPLOY_REFUSALS = {
  run_unreadable: "GitHub's record of the CI run could not be read",
  artifact_missing: "the CI run kept no staging-site build, or it has expired",
  artifact_unreadable: "the CI run's staging-site build could not be downloaded",
  target_error: "the deploy target failed without saying why",
  secrets_unreadable:
    "the staging Worker's secret names could not be read, so the build's required secrets could not be checked and nothing was uploaded",
} as const;

/** The two halves of a `secrets_missing` text, around the missing names (D-448). */
const MISSING_SECRETS_LEAD =
  "the build needs product secrets not set on the staging Worker: ";
const MISSING_SECRETS_TAIL = ". Set each with the Set project secret form";

/**
 * The fixed text of a deploy held for missing secrets (D-448): the names, in order, as many as fit
 * in the bound the daily check shows (`readDeployRefusal` in ./guards/evidence.ts), then how many
 * more. Each name follows the manifest's rule, so the text keeps to the characters it shows.
 */
export function missingSecretsText(missing: readonly string[]): string {
  const room =
    DEPLOY_REFUSAL_TEXT_MAX_CHARS -
    MISSING_SECRETS_LEAD.length -
    MISSING_SECRETS_TAIL.length;
  let names = `${missing.length} secrets`;
  for (let shown = missing.length; shown >= 1; shown--) {
    const rest = missing.length - shown;
    const list = `${missing.slice(0, shown).join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
    if (list.length <= room) {
      names = list;
      break;
    }
  }
  return `${MISSING_SECRETS_LEAD}${names}${MISSING_SECRETS_TAIL}`;
}

/** Why a deploy result names no covered item: GitHub's compare could not be read. */
export const COVER_UNREADABLE =
  "GitHub's compare could not be read, so no item was recorded; the reconcile pass retries";

const infrastructure = (reason: keyof typeof DEPLOY_REFUSALS): StagingRefusal => ({
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
  /**
   * A cluster-target project (D-449): the commit's images were built and wait for Didi's
   * Platform apply of the new pins. Nothing was deployed or recorded.
   */
  | "awaiting_apply"
  | "refused_file_set"
  | "refused_infrastructure";

export interface StagingDeployResult {
  repo: string;
  runId: number;
  step: StagingDeployStep;
  /** The run's head commit, which was deployed or would be. */
  commitSha?: string;
  /** For a refusal: its fixed code and text, and where the target's refusal came from. */
  reason?: string;
  text?: string;
  detail?: DeployRefusalDetail;
  /** For a deploy: how many files the site has. */
  files?: number;
  /** For `awaiting_apply`: the Images workflow's run that built the commit's images. */
  images?: { runId: number };
  /** For a deploy with a Worker module: the secret names it requires (O-159). */
  worker?: WorkerDeploy;
  /** For a deploy of a build with D1 migrations: the names it applied, in order (O-165). */
  migrationsApplied?: string[];
  /** For a deploy held for missing secrets (D-448): each missing name, sorted. Never a value. */
  missingSecrets?: string[];
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

/**
 * The deploy targets by name (D-441, O-166), as the composition gives them; a project's
 * `deployTarget` picks one.
 */
export interface StagingDeployTargets {
  /** The deploy, and the secret names the required-secret check compares with (D-448). */
  readonly cloudflare: StagingTarget & Pick<DeployTarget, "listSecretNames">;
  /** The release record of a project on Foreman's own cluster (appendix G). */
  readonly cluster: Pick<ClusterDeployTarget, "deploy">;
}

export interface StagingDeployDeps extends StagingDeps {
  builds: StagingBuilds;
  targets: StagingDeployTargets;
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
  const { store, clock, ids, github, builds, targets } = deps;
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
    // `worker: true` tells the staging check to probe `/api/health` too (O-159).
    const payload: Json = deployed
      ? { ...facts, files: upload.files, ...(upload.worker ? { worker: true } : {}) }
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

  /**
   * D-448: a build with a Worker is uploaded only when every secret its manifest requires is set
   * on the project's staging Worker. Otherwise the deploy is held as an infrastructure refusal
   * naming the missing secrets and the Set project secret form; names the target cannot list hold
   * it too. A build that requires none asks nothing.
   */
  async function requiredSecretsHold(
    project: Project,
    worker: WorkerDeploy,
  ): Promise<StagingRefusal | null> {
    if (worker.requiredSecrets.length === 0) return null;
    let listed: SecretNames | null;
    try {
      listed = await targets.cloudflare.listSecretNames(project.slug);
    } catch {
      listed = null;
    }
    if (listed?.outcome !== "listed") {
      return {
        ...infrastructure("secrets_unreadable"),
        ...(listed?.detail ? { detail: listed.detail } : {}),
      };
    }
    const set = new Set(listed.names);
    const missing = [...new Set(worker.requiredSecrets)]
      .filter((name) => !set.has(name))
      .sort();
    if (missing.length === 0) return null;
    return {
      outcome: "refused",
      cause: INFRASTRUCTURE_CAUSE,
      reason: "secrets_missing",
      text: missingSecretsText(missing),
      missingSecrets: missing,
    };
  }

  /**
   * The cluster target's answer for the run's commit (O-166): no build is fetched. Every error
   * becomes an infrastructure refusal, and so does any refusal it gives (see the header).
   */
  async function release(project: Project, run: BuildRun): Promise<ClusterDeploy> {
    let answer: ClusterDeploy;
    try {
      answer = await targets.cluster.deploy({ project, commitSha: run.headSha });
    } catch {
      return infrastructure("target_error");
    }
    if (answer.outcome === "awaiting_apply") {
      return { outcome: "awaiting_apply", images: { runId: answer.images.runId } };
    }
    return { ...answer, cause: INFRASTRUCTURE_CAUSE };
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
      return await targets.cloudflare.deploy({
        project,
        commitSha: run.headSha,
        archive,
        beforeWorkerUpload: (worker) => requiredSecretsHold(project, worker),
      });
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

    // A cluster-target project: its images' release, recorded nowhere (see the header).
    if (project.deployTarget === "cluster") {
      const answer = await release(project, run);
      if (answer.outcome === "awaiting_apply") {
        return { ...base, step: "awaiting_apply", commitSha, images: answer.images };
      }
      return {
        ...base,
        step: "refused_infrastructure",
        commitSha,
        reason: answer.reason,
        text: answer.text,
        ...(answer.detail ? { detail: answer.detail } : {}),
      };
    }

    // Deploy, then record, then check (D-356).
    const outcome = await upload(project, run);
    const done: StagingDeployResult =
      outcome.outcome === "deployed"
        ? {
            ...base,
            step: "deployed",
            commitSha,
            files: outcome.files,
            ...(outcome.worker ? { worker: outcome.worker } : {}),
            ...(outcome.migrationsApplied
              ? { migrationsApplied: outcome.migrationsApplied }
              : {}),
          }
        : {
            ...base,
            step:
              outcome.cause === INFRASTRUCTURE_CAUSE
                ? "refused_infrastructure"
                : "refused_file_set",
            commitSha,
            reason: outcome.reason,
            text: outcome.text,
            ...(outcome.detail ? { detail: outcome.detail } : {}),
            ...(outcome.missingSecrets
              ? { missingSecrets: outcome.missingSecrets }
              : {}),
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
        // A cluster-target item is Done at merge (D-449): none waits for a deploy.
        if (project.deployTarget === "cluster") continue;
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
