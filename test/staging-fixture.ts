// Test support for staging verification (build plan M3.4): a fake staging check, and one item in
// Verifying on staging on the merge fixture, merged by the runner's own merge, with builders for
// the runner's own staging deploy of a commit (D-356, O-116: recorded as the deploy flow records
// it, through the core's `record`, with no check) and for the commits on main after the merge
// commit (D-225). Fake data only; nothing reaches staging, Cloudflare or GitHub.
import {
  createFakeStagingBuilds,
  createFakeStagingTarget,
  mainBuild,
} from "../src/adapters/deploy/fake.ts";
import type { Node, Store, Track } from "../src/core/store.ts";
import {
  createStaging,
  type StagingCheckRequest,
  type StagingCheckResult,
  type StagingChecker,
} from "../src/core/staging.ts";
import {
  createStagingDeploys,
  type StagingUpload,
} from "../src/core/staging-deploy.ts";
import { PR, setupMerge } from "./merge-fixture.ts";
import { HEAD, REPO } from "./reconcile-fixture.ts";

export interface FakeStagingChecker extends StagingChecker {
  /** Every check asked for, in order. */
  readonly calls: StagingCheckRequest[];
  /**
   * What the next checks find, in order. When it is empty, staging serves the commit asked about
   * and the check passes.
   */
  readonly answers: (StagingCheckResult | "throw")[];
}

export function createFakeStagingChecker(): FakeStagingChecker {
  const calls: StagingCheckRequest[] = [];
  const answers: (StagingCheckResult | "throw")[] = [];
  return {
    calls,
    answers,
    async check(request) {
      calls.push(request);
      const next = answers.shift();
      if (next === "throw") throw new Error("the fake staging check broke");
      return next ?? { result: "pass", servedCommitSha: request.commitSha };
    },
  };
}

/** One item merged by the runner and now in Verifying on staging, with a fake staging check. */
export async function setupStaging(
  options: {
    track?: Track;
    dryRun?: boolean;
    store?: Store;
    idPrefix?: string;
    slug?: string;
    pr?: number;
    /**
     * The merge commit, for tests that share one database: the item's PR is merged at its head on
     * GitHub with this commit, and the runner's merge completes it (its recovery path, O-31).
     */
    mergeSha?: string;
  } = {},
) {
  const t = await setupMerge({ ...options, dryRun: false });
  await t.passedOn(HEAD);
  if (options.mergeSha) {
    // As if the runner's merge stopped after GitHub merged: its mergeable check is recorded.
    const pr = options.pr ?? PR;
    await t.evidence(
      t.node.id,
      "merge_check",
      { pr, mergeable: true },
      { commitSha: HEAD },
    );
    t.github.merge(REPO, pr, options.mergeSha);
  }
  const merged = await t.merges().mergeOnPass(t.node.id, t.trigger);
  if (merged.outcome !== "applied" || !merged.mergeCommitSha) {
    throw new Error(`the merge fixture did not merge: ${merged.reason ?? "no reason"}`);
  }
  const mergeSha = merged.mergeCommitSha;
  if (options.dryRun) await t.setting("dry_run", true);
  const checker = createFakeStagingChecker();
  const builds = createFakeStagingBuilds();
  const target = createFakeStagingTarget();
  // GitHub's run ids are unique per repository; the PR number keeps them apart here.
  let runId = (options.pr ?? PR) * 100;

  const deploys = (store: Store = t.store) =>
    createStagingDeploys({ ...t.deps, store, checker, builds, target });

  /**
   * The runner deployed CI's build of `sha` on main and recorded it, as the deploy flow does
   * before its check: `success` a deploy, `failure` a refused file set (D-225 rule 2), `error` a
   * refusal by infrastructure (counted as no failure, N-103). Returns the CI run's id.
   */
  async function deploy(
    sha = mergeSha,
    state: "success" | "failure" | "error" = "success",
    store: Store = t.store,
  ): Promise<number> {
    const run = mainBuild(REPO, ++runId, sha);
    await deploys(store).record(REPO, run, outcomeOf(state));
    return run.id;
  }

  /**
   * CI built `sha` on main and kept its site, for the deploy flow to deploy: the fake target then
   * answers as `state` says. Returns the CI run's id; nothing is deployed or recorded yet.
   */
  function built(
    sha = mergeSha,
    state: "success" | "failure" | "error" = "success",
  ): number {
    const run = mainBuild(REPO, ++runId, sha);
    builds.putRun(REPO, run);
    if (state !== "success") target.answers.push(outcomeOf(state));
    return run.id;
  }

  const staging = (store: Store = t.store) =>
    createStaging({ ...t.deps, store, checker });
  const counter = (kind: "failure" | "qa_round" = "failure", node: Node = t.node) =>
    t.store.getCounter(node.id, kind);
  // Main's head is the merge commit until a later commit lands on it.
  t.github.setBranchHead(REPO, "main", mergeSha);

  /**
   * Main gains `sha` on top of `parent` (the merge commit unless given) and points at it, for
   * GitHub's compare.
   */
  function commitOnMain(sha: string, parent = mergeSha): string {
    t.github.putCommit(REPO, sha, [parent]);
    t.github.setBranchHead(REPO, "main", sha);
    return sha;
  }

  /** A branch commit on top of `parent` (the merge commit unless given); main does not move. */
  function commitOnBranch(sha: string, parent = mergeSha): string {
    t.github.putCommit(REPO, sha, [parent]);
    return sha;
  }

  const kind = (
    name:
      | "staging_deploy"
      | "staging_deploy_failed"
      | "staging_check"
      | "staging_no_result",
    node: Node = t.node,
  ) => t.store.listEvidence({ nodeId: node.id, kind: name });

  return {
    ...t,
    mergeSha,
    checker,
    builds,
    target,
    deploys,
    deploy,
    built,
    commitOnMain,
    commitOnBranch,
    staging,
    counter,
    kind,
  };
}

/** A deploy's outcome as the fixture's `deploy` names it. */
export function outcomeOf(state: "success" | "failure" | "error"): StagingUpload {
  if (state === "success") return { outcome: "deployed", files: 3 };
  return state === "failure"
    ? {
        outcome: "refused",
        cause: "file_set",
        reason: "worker_code",
        text: "the staging-site build holds _worker.js, which would run code",
      }
    : {
        outcome: "refused",
        cause: "infrastructure",
        reason: "cloudflare_unavailable",
        text: "Cloudflare failed or limited the staging upload; it is tried again",
      };
}
