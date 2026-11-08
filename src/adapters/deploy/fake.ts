// A fake staging target and a fake of CI's builds for tests (O-116): the deploy port of the core
// (`StagingTarget`) and the GitHub reads it deploys from (`StagingBuilds`), in memory. The target
// records each deploy it is asked for and answers what the test sets (a deploy by default); the
// builds hold runs and their `staging-site` archives. No network, no Cloudflare and no GitHub.
import type {
  BuildRun,
  StagingBuilds,
  StagingTarget,
  StagingUpload,
} from "../../core/staging-deploy.ts";
import {
  STAGING_BUILD_EVENT,
  STAGING_BUILD_WORKFLOW,
} from "../../core/staging-deploy.ts";
import { STAGING_MAIN_BRANCH } from "../../core/staging.ts";

export interface FakeStagingTarget extends StagingTarget {
  /** Each deploy asked for, in order: the project's slug, the commit and the archive's size. */
  readonly deploys: { slug: string; commitSha: string; archiveBytes: number }[];
  /** What the next deploys answer, in order; a deploy of one file once it is empty. */
  readonly answers: (StagingUpload | "throw")[];
}

export function createFakeStagingTarget(): FakeStagingTarget {
  const deploys: FakeStagingTarget["deploys"] = [];
  const answers: FakeStagingTarget["answers"] = [];
  return {
    deploys,
    answers,
    async deploy({ project, commitSha, archive }) {
      deploys.push({ slug: project.slug, commitSha, archiveBytes: archive.length });
      const next = answers.shift();
      if (next === "throw") throw new Error("the fake staging target broke");
      return next ?? { outcome: "deployed", files: 1 };
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
