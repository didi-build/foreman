// A fake staging target and a fake of CI's builds for tests (O-116): the deploy port of the core
// (`DeployTarget` over `StagingTarget`, named `cloudflare`, O-159) and the GitHub reads it deploys
// from (`StagingBuilds`), in memory. The target records each deploy it is asked for and answers
// what the test sets (a deploy by default); an answer that deploys a Worker stands for a build
// with a Worker module, so the deploy first asks the request's `beforeWorkerUpload` (D-448, O-163)
// and answers its refusal instead when it gives one. It sets a project up once, as the real target
// finds before it creates, and keeps the names of the secrets put, never a value (O-160). The
// builds hold runs and their `staging-site` archives. The fake cluster target (O-166) records each
// deploy it is asked for and answers what the test sets (the release waiting by default), and
// refuses setup and secrets as the real one does. No network, no Cloudflare and no GitHub.
import type {
  ClusterDeploy,
  ClusterDeployTarget,
  DeployTarget,
  ProjectSetUpRequest,
} from "../../core/deploy-target.ts";
import { CLUSTER_TARGET_REFUSALS } from "./cluster-target.ts";
import type {
  BuildRun,
  StagingBuilds,
  StagingUpload,
} from "../../core/staging-deploy.ts";
import {
  STAGING_BUILD_EVENT,
  STAGING_BUILD_WORKFLOW,
} from "../../core/staging-deploy.ts";
import { STAGING_MAIN_BRANCH } from "../../core/staging.ts";

export interface FakeStagingTarget extends DeployTarget {
  /** Each deploy asked for, in order: the project's slug, the commit and the archive's size. */
  readonly deploys: { slug: string; commitSha: string; archiveBytes: number }[];
  /** The deploys the request's `beforeWorkerUpload` held, in order, by commit: nothing uploaded. */
  readonly held: string[];
  /** What the next deploys answer, in order; a deploy of one file once it is empty. */
  readonly answers: (StagingUpload | "throw")[];
  /** Each setup asked for, in order. */
  readonly setUps: ProjectSetUpRequest[];
  /** The secret names put on each project's staging product, by slug. Never a value. */
  readonly secretNames: Map<string, Set<string>>;
}

export function createFakeStagingTarget(): FakeStagingTarget {
  const deploys: FakeStagingTarget["deploys"] = [];
  const held: string[] = [];
  const answers: FakeStagingTarget["answers"] = [];
  const setUps: ProjectSetUpRequest[] = [];
  const secretNames = new Map<string, Set<string>>();
  const setUpSlugs = new Set<string>();
  return {
    name: "cloudflare",
    deploys,
    held,
    answers,
    setUps,
    secretNames,
    async deploy({ project, commitSha, archive, beforeWorkerUpload }) {
      deploys.push({ slug: project.slug, commitSha, archiveBytes: archive.length });
      const next = answers.shift();
      if (next === "throw") throw new Error("the fake staging target broke");
      const answer = next ?? { outcome: "deployed", files: 1 };
      if (answer.outcome === "deployed" && answer.worker && beforeWorkerUpload) {
        const hold = await beforeWorkerUpload(answer.worker);
        if (hold) {
          held.push(commitSha);
          return hold;
        }
      }
      return answer;
    },
    async setUp(request) {
      setUps.push({ ...request });
      if (setUpSlugs.has(request.slug)) {
        return {
          outcome: request.dryRun ? "dry_run" : "set_up",
          database: "found",
          placeholder: "kept",
        };
      }
      if (request.dryRun) {
        return {
          outcome: "dry_run",
          database: "would_create",
          placeholder: "would_upload",
        };
      }
      setUpSlugs.add(request.slug);
      return { outcome: "set_up", database: "created", placeholder: "uploaded" };
    },
    async putSecret(slug, name) {
      secretNames.set(slug, (secretNames.get(slug) ?? new Set()).add(name));
      return { outcome: "put", name };
    },
    async listSecretNames(slug) {
      return { outcome: "listed", names: [...(secretNames.get(slug) ?? [])].sort() };
    },
  };
}

export interface FakeStagingBuilds extends StagingBuilds {
  /** Adds a run as GitHub would report it, with the archive its `staging-site` artifact holds. */
  putRun(repo: string, run: BuildRun, archive?: Uint8Array | null): void;
  /** Makes the next read of this kind throw, as a GitHub error would. */
  readonly failNext: Set<"getRun" | "latestMainBuild" | "siteArchive">;
  /** Each read made, in order, as `<kind> <repo>[#<run id>]`. */
  readonly reads: string[];
}

/** A successful CI run of `sha` that a push to main started in `repo`. */
export function mainBuild(repo: string, id: number, sha: string): BuildRun {
  return {
    id,
    path: STAGING_BUILD_WORKFLOW,
    event: STAGING_BUILD_EVENT,
    headSha: sha,
    headBranch: STAGING_MAIN_BRANCH,
    headRepo: repo,
    status: "completed",
    conclusion: "success",
  };
}

export function createFakeStagingBuilds(): FakeStagingBuilds {
  const runs = new Map<string, BuildRun[]>();
  const archives = new Map<string, Uint8Array | null>();
  const failNext = new Set<"getRun" | "latestMainBuild" | "siteArchive">();
  const reads: string[] = [];
  const fail = (kind: "getRun" | "latestMainBuild" | "siteArchive") => {
    if (failNext.delete(kind)) throw new Error(`the fake GitHub refused ${kind}`);
  };
  return {
    failNext,
    reads,
    putRun(repo, run, archive = new Uint8Array([1])) {
      runs.set(repo, [
        ...(runs.get(repo) ?? []).filter((r) => r.id !== run.id),
        { ...run },
      ]);
      archives.set(`${repo}#${run.id}`, archive);
    },
    async getRun(repo, runId) {
      reads.push(`getRun ${repo}#${runId}`);
      fail("getRun");
      const run = (runs.get(repo) ?? []).find((r) => r.id === runId);
      return run ? { ...run } : null;
    },
    async latestMainBuild(repo) {
      reads.push(`latestMainBuild ${repo}`);
      fail("latestMainBuild");
      const newest = (runs.get(repo) ?? [])
        .filter(
          (r) =>
            r.headBranch === STAGING_MAIN_BRANCH &&
            r.event === STAGING_BUILD_EVENT &&
            r.conclusion === "success",
        )
        .sort((a, b) => b.id - a.id)[0];
      return newest ? { ...newest } : null;
    },
    async siteArchive(repo, runId) {
      reads.push(`siteArchive ${repo}#${runId}`);
      fail("siteArchive");
      return archives.get(`${repo}#${runId}`) ?? null;
    },
  };
}

export interface FakeClusterTarget extends ClusterDeployTarget {
  /** Each deploy asked for, in order: the project's slug and the commit. */
  readonly deploys: { slug: string; commitSha: string }[];
  /** What the next deploys answer, in order; the release waiting on run 1 once it is empty. */
  readonly answers: (ClusterDeploy | "throw")[];
  /** How many setup and secret calls were made: each is refused. */
  readonly refusedCalls: string[];
}

/** A fake of Foreman's own cluster target (ADR 0118 appendix G): nothing is applied anywhere. */
export function createFakeClusterTarget(): FakeClusterTarget {
  const deploys: FakeClusterTarget["deploys"] = [];
  const answers: FakeClusterTarget["answers"] = [];
  const refusedCalls: string[] = [];
  return {
    name: "cluster",
    deploys,
    answers,
    refusedCalls,
    async deploy({ project, commitSha }) {
      deploys.push({ slug: project.slug, commitSha });
      const next = answers.shift();
      if (next === "throw") throw new Error("the fake cluster target broke");
      return next ?? { outcome: "awaiting_apply", images: { runId: 1 } };
    },
    async setUp() {
      refusedCalls.push("setUp");
      return {
        outcome: "refused",
        step: "check",
        reason: "no_setup",
        text: CLUSTER_TARGET_REFUSALS.no_setup,
      };
    },
    async putSecret() {
      refusedCalls.push("putSecret");
      return {
        outcome: "refused",
        reason: "no_secrets",
        text: CLUSTER_TARGET_REFUSALS.no_secrets,
      };
    },
    async listSecretNames() {
      refusedCalls.push("listSecretNames");
      return {
        outcome: "refused",
        reason: "no_secrets",
        text: CLUSTER_TARGET_REFUSALS.no_secrets,
      };
    },
  };
}
