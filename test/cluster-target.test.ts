// Seam: unit, on the memory store with the real machine-2 contracts and guards, the fake GitHub,
// the fake staging check and fakes of both deploy targets (ADR 0118 slice 9, D-441, D-449,
// O-166). A project whose store row names the `cluster` target (Foreman itself):
// - its item is Done at merge: the merge asks for the runner-only move Verifying on staging to Done
//   guarded by `merged_on_cluster_target` right after its own move, with the counters reset and
//   the blocked items released, and no deploy, check or staging fact read or written; the
//   reconcile pass's staging pass takes the same move for an item a failure left behind; dry run
//   writes a planned row only; a Cloudflare-target merge is left exactly as before;
// - its deploy goes to the cluster target only: no `staging-site` build is read, the Cloudflare
//   target is never asked, nothing is recorded on an item and no check runs; every refusal is
//   infrastructure; the backstop leaves it out;
// - the daily check lists its Done at merge under what moved, never as a passed staging check,
//   and shows "Foreman upgrade waiting for your Platform apply" while the newest Images build is
//   not what the cluster runs, read from a fake of GitHub.
// Fake data only.
import { describe, expect, it } from "vitest";

import {
  createFakeClusterTarget,
  createFakeStagingBuilds,
  createFakeStagingTarget,
  mainBuild,
} from "../src/adapters/deploy/fake.ts";
import {
  FOREMAN_UPGRADE_WAITING,
  clusterReleaseLine,
  type ClusterReleases,
  type ImagesBuild,
  type PlatformApplied,
  type PlatformImages,
} from "../src/core/cluster-release.ts";
import { generateDailyCheck } from "../src/core/daily-check.ts";
import { renderDailyCheck } from "../src/core/daily-check-render.ts";
import {
  CLUSTER_DONE_GUARD,
  clusterDoneTrigger,
  createStaging,
} from "../src/core/staging.ts";
import { createStagingDeploys, DEPLOY_REFUSALS } from "../src/core/staging-deploy.ts";
import { HEAD, REPO } from "./reconcile-fixture.ts";
import { setupMerge } from "./merge-fixture.ts";
import { createFakeStagingChecker } from "./staging-fixture.ts";

const IMAGES = (digit: string): PlatformImages => ({
  stateApi: `ghcr.io/didi-build/foreman-state-api@sha256:${digit.repeat(64)}`,
  receiver: `ghcr.io/didi-build/foreman-github-receiver@sha256:${digit.repeat(64)}`,
  egressProxy: `ghcr.io/didi-build/foreman-egress-proxy@sha256:${digit.repeat(64)}`,
  runWatcher: `ghcr.io/didi-build/foreman-run-watcher@sha256:${digit.repeat(64)}`,
});

/** One item in QA review on a project of the given target, with QA's pass on its head. */
async function merged(deployTarget: "cloudflare" | "cluster", dryRun = false) {
  const t = await setupMerge({ deployTarget, dryRun });
  const dependent = await t.addNode("blocked", { title: "Waits on the merged item" });
  await t.blocks(t.node.id, dependent.id);
  await t.passedOn(HEAD);
  await t.store.setCounter(t.node.id, "failure", 2, t.clock.now());
  await t.store.setCounter(t.node.id, "qa_round", 1, t.clock.now());
  return { t, dependent };
}

describe("a cluster-target item is Done at merge (unit: D-449, O-166)", () => {
  it("moves to Done right after the merge's own move, resets the counters and releases the items it blocked, reading no staging fact", async () => {
    const { t, dependent } = await merged("cluster");
    const result = await t.merges().mergeOnPass(t.node.id, t.trigger);
    expect(result).toMatchObject({
      outcome: "applied",
      mergeCommitSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      doneAtMerge: {
        nodeId: t.node.id,
        step: "done_at_merge",
        move: { toState: "done", outcome: "applied", failedGuards: [] },
        released: [{ nodeId: dependent.id, move: { toState: "ready_for_dev" } }],
      },
    });
    expect(await t.state()).toBe("done");
    expect((await t.store.getNode(dependent.id))?.state).toBe("ready_for_dev");
    expect(await t.store.getCounter(t.node.id, "failure")).toBe(0);
    expect(await t.store.getCounter(t.node.id, "qa_round")).toBe(0);
    const [merge] = await t.kinds("merge_commit");
    const moves = (await t.store.listTransitions(t.node.id)).filter(
      (m) => m.mode === "applied",
    );
    expect(moves.map((m) => [m.fromState, m.toState, m.triggerRef])).toEqual([
      ["in_qa_review", "verifying_on_staging", `github:merge_commit:${REPO}#7`],
      ["verifying_on_staging", "done", clusterDoneTrigger(merge?.id ?? "").ref],
    ]);
    const done = moves[1];
    expect(done?.guardResult).toEqual([
      expect.objectContaining({ name: CLUSTER_DONE_GUARD, pass: true }),
    ]);
    expect(done?.evidenceIds).toContain(merge?.id);
    expect(done?.reason).toMatch(
      /Done at merge, and the release waits for Didi's Platform apply \(D-449\)/,
    );
    for (const kind of [
      "staging_deploy",
      "staging_deploy_failed",
      "staging_check",
      "staging_no_result",
    ] as const) {
      expect(await t.store.listEvidence({ nodeId: t.node.id, kind }), kind).toEqual([]);
    }
  });

  it("leaves a Cloudflare-target merge exactly as before: in Verifying on staging, waiting for its deploy", async () => {
    const { t, dependent } = await merged("cloudflare");
    const result = await t.merges().mergeOnPass(t.node.id, t.trigger);
    expect(result.outcome).toBe("applied");
    expect(result).not.toHaveProperty("doneAtMerge");
    expect(await t.state()).toBe("verifying_on_staging");
    expect((await t.store.getNode(dependent.id))?.state).toBe("blocked");
    expect(await t.store.getCounter(t.node.id, "failure")).toBe(2);
    // The staging pass does not take the at-merge way for it either.
    const verified = await createStaging({
      ...t.deps,
      checker: createFakeStagingChecker(),
    }).verify(t.node.id);
    expect(verified.step).toBe("waiting_for_deploy");
  });

  it("is taken by the reconcile pass's staging pass for an item a failure left in Verifying on staging, once", async () => {
    const { t } = await merged("cluster");
    // As if the merge stopped after its own move: GitHub merged, the move to Verifying applied.
    const staging = createStaging({ ...t.deps, checker: createFakeStagingChecker() });
    const node = await t.addNode("verifying_on_staging", { ownerRole: "qa" });
    const dependent = await t.addNode("blocked", { title: "Waits on it alone" });
    await t.evidence(node.id, "merge_commit", { pr: 8 }, { commitSha: "c".repeat(40) });
    await t.blocks(node.id, dependent.id);
    const ready = await staging.verifyReady();
    expect(ready).toEqual([
      expect.objectContaining({
        nodeId: node.id,
        step: "done_at_merge",
        move: expect.objectContaining({ toState: "done", outcome: "applied" }),
      }),
    ]);
    expect((await t.store.getNode(node.id))?.state).toBe("done");
    expect((await t.store.getNode(dependent.id))?.state).toBe("ready_for_dev");
    expect((await staging.verifyReady()).filter((r) => r.nodeId === node.id)).toEqual(
      [],
    );
  });

  it("in dry run writes a planned row and no counter, and moves nothing; under the kill switch it does nothing", async () => {
    const { t } = await merged("cluster");
    const staging = createStaging({ ...t.deps, checker: null });
    const node = await t.addNode("verifying_on_staging", { ownerRole: "qa" });
    await t.evidence(node.id, "merge_commit", { pr: 8 }, { commitSha: "c".repeat(40) });
    await t.store.setCounter(node.id, "failure", 1, t.clock.now());
    await t.setting("dry_run", true);
    expect(await staging.doneAtMerge(node.id)).toMatchObject({
      step: "done_at_merge",
      move: { toState: "done", outcome: "planned" },
    });
    expect((await t.store.getNode(node.id))?.state).toBe("verifying_on_staging");
    expect(
      (await t.store.listTransitions(node.id)).map((m) => [m.toState, m.mode]),
    ).toEqual([["done", "dry_run"]]);
    expect(await t.store.getCounter(node.id, "failure")).toBe(1);
    await t.setting("dry_run", false);
    await t.setting("kill_switch", true);
    expect(await staging.doneAtMerge(node.id)).toBeNull();
    expect((await staging.verify(node.id)).step).toBe("refused");
  });

  it("is refused by its guard without a merge commit, and never asked for an item of another state", async () => {
    const { t } = await merged("cluster");
    const staging = createStaging({ ...t.deps, checker: null });
    const node = await t.addNode("verifying_on_staging", { ownerRole: "qa" });
    expect(await staging.doneAtMerge(node.id)).toBeNull();
    expect((await staging.verify(node.id)).step).toBe("no_merge_commit");
    expect(await staging.doneAtMerge(t.node.id)).toBeNull();
    expect(await t.state()).toBe("in_qa_review");
  });
});

/** A project on the cluster target with CI's builds on main, and both targets as fakes. */
async function deploying(deployTarget: "cloudflare" | "cluster" = "cluster") {
  const t = await setupMerge({ deployTarget });
  const builds = createFakeStagingBuilds();
  const archivesRead: number[] = [];
  const cloudflare = createFakeStagingTarget();
  const cluster = createFakeClusterTarget();
  const checker = createFakeStagingChecker();
  const deploys = createStagingDeploys({
    ...t.deps,
    checker,
    builds: {
      ...builds,
      siteArchive: async (repo, runId) => {
        archivesRead.push(runId);
        return builds.siteArchive(repo, runId);
      },
    },
    targets: { cloudflare, cluster },
  });
  return { t, builds, archivesRead, cloudflare, cluster, checker, deploys };
}

describe("a cluster-target project's deploy goes to the cluster target only (unit: D-441, O-166)", () => {
  it("answers that the commit's images were built and wait for Didi's Platform apply, reading no build, asking no Cloudflare and recording nothing", async () => {
    const d = await deploying();
    const commit = "d".repeat(40);
    d.builds.putRun(REPO, mainBuild(REPO, 41, commit));
    d.cluster.answers.push({ outcome: "awaiting_apply", images: { runId: 9001 } });
    expect(await d.deploys.deployRun(REPO, 41)).toEqual({
      repo: REPO,
      runId: 41,
      step: "awaiting_apply",
      commitSha: commit,
      images: { runId: 9001 },
    });
    expect(d.cluster.deploys).toEqual([{ slug: "rehearsal", commitSha: commit }]);
    expect(d.cloudflare.deploys).toEqual([]);
    expect(d.archivesRead).toEqual([]);
    expect(d.checker.calls).toEqual([]);
  });

  it("passes on the cluster target's refusal as infrastructure, whatever cause it gives, and a target that breaks as target_error", async () => {
    const d = await deploying();
    d.builds.putRun(REPO, mainBuild(REPO, 42, HEAD));
    d.cluster.answers.push({
      outcome: "refused",
      cause: "file_set",
      reason: "images_failed",
      text: "made-up fixed text",
    });
    expect(await d.deploys.deployRun(REPO, 42)).toEqual({
      repo: REPO,
      runId: 42,
      step: "refused_infrastructure",
      commitSha: HEAD,
      reason: "images_failed",
      text: "made-up fixed text",
    });
    d.cluster.answers.push("throw");
    expect(await d.deploys.deployRun(REPO, 42)).toMatchObject({
      step: "refused_infrastructure",
      reason: "target_error",
      text: DEPLOY_REFUSALS.target_error,
    });
    expect(d.cloudflare.deploys).toEqual([]);
    expect(await d.t.store.listEvidence({ nodeId: d.t.node.id })).not.toContainEqual(
      expect.objectContaining({ kind: "staging_deploy_failed" }),
    );
  });

  it("keeps the CI run's checks, the kill switch and dry run before the target", async () => {
    const d = await deploying();
    d.builds.putRun(REPO, { ...mainBuild(REPO, 43, HEAD), conclusion: "failure" });
    expect((await d.deploys.deployRun(REPO, 43)).step).toBe("not_a_main_build");
    d.builds.putRun(REPO, mainBuild(REPO, 44, HEAD));
    await d.t.setting("dry_run", true);
    expect(await d.deploys.deployRun(REPO, 44)).toMatchObject({ step: "would_deploy" });
    await d.t.setting("kill_switch", true);
    expect((await d.deploys.deployRun(REPO, 44)).step).toBe("refused");
    expect(d.cluster.deploys).toEqual([]);
  });

  it("leaves a cluster-target project out of the backstop, and never asks the cluster target for a Cloudflare-target project", async () => {
    const d = await deploying();
    const waiting = await d.t.addNode("verifying_on_staging", { ownerRole: "qa" });
    await d.t.evidence(waiting.id, "merge_commit", { pr: 9 }, { commitSha: HEAD });
    d.builds.putRun(REPO, mainBuild(REPO, 45, HEAD));
    expect(await d.deploys.backstop()).toEqual([]);
    expect(d.cluster.deploys).toEqual([]);

    const c = await deploying("cloudflare");
    c.builds.putRun(REPO, mainBuild(REPO, 46, HEAD));
    expect((await c.deploys.deployRun(REPO, 46)).step).toBe("deployed");
    expect(c.cloudflare.deploys).toHaveLength(1);
    expect(c.cluster.deploys).toEqual([]);
    expect(c.archivesRead).toEqual([46]);
  });
});

/** Foreman's newest build and apply, as a fake of GitHub gives them. */
function releases(
  build: ImagesBuild | null | "throw",
  applied: PlatformApplied | null | "throw" = null,
) {
  const reads: string[] = [];
  const port: ClusterReleases = {
    async latestBuild(repo) {
      reads.push(`build ${repo}`);
      if (build === "throw") throw new Error("the fake GitHub refused");
      return build;
    },
    async latestApplied(repo) {
      reads.push(`applied ${repo}`);
      if (applied === "throw") throw new Error("the fake GitHub refused");
      return applied;
    },
  };
  return { port, reads };
}

describe("the daily check keeps a Foreman release in sight until Didi applies it (unit: D-449, O-166)", () => {
  const BUILD: ImagesBuild = {
    runNumber: 88,
    commitSha: "e".repeat(40),
    images: IMAGES("1"),
  };

  it("shows the waiting upgrade with both runs, lists the Done at merge under what moved and not as a passed staging check", async () => {
    const { t } = await merged("cluster");
    await t.merges().mergeOnPass(t.node.id, t.trigger);
    t.advanceMinutes(1);
    const gh = releases(BUILD, {
      runNumber: 57,
      commitSha: "f".repeat(40),
      images: IMAGES("2"),
    });
    const check = await generateDailyCheck(
      { ...t.deps, clusterReleases: gh.port },
      { holdReleaseRequestFlow: "f/foreman/hold_release_request" },
    );
    expect(gh.reads).toEqual([`build ${REPO}`, `applied ${REPO}`]);
    expect(check.clusterReleases).toEqual([
      expect.objectContaining({ slug: "rehearsal", state: "waiting" }),
    ]);
    const project = check.projects.find((p) => p.slug === "rehearsal");
    expect(project?.moved.map((m) => m.toState)).toContain("done");
    expect(project?.staging.passedInWindow).toEqual([]);
    const text = renderDailyCheck(check);
    expect(text).toContain(
      `${FOREMAN_UPGRADE_WAITING}: the images built from commit eeeeeee (Images run #88) are not applied; the cluster runs the pins of commit fffffff (Platform run #57).`,
    );
    expect(text).toContain(
      "Copy the pins from that Images run's foreman-images artifact",
    );
  });

  it("shows nothing once the cluster runs the newest build, or when main has none, and reads nothing for Cloudflare-target projects", async () => {
    const { t } = await merged("cluster");
    const deps = (port: ClusterReleases) => ({ ...t.deps, clusterReleases: port });
    const options = { holdReleaseRequestFlow: "f/foreman/hold_release_request" };
    const applied = releases(BUILD, {
      runNumber: 60,
      commitSha: "f".repeat(40),
      images: IMAGES("1"),
    });
    const check = await generateDailyCheck(deps(applied.port), options);
    expect(check.clusterReleases?.[0]?.state).toBe("applied");
    expect(renderDailyCheck(check)).not.toContain(FOREMAN_UPGRADE_WAITING);
    const none = releases(null);
    expect(
      (await generateDailyCheck(deps(none.port), options)).clusterReleases,
    ).toEqual([{ slug: "rehearsal", state: "no_build", build: null, applied: null }]);
    expect(none.reads).toEqual([`build ${REPO}`]);

    const c = await merged("cloudflare");
    const unread = releases("throw", "throw");
    expect(
      (await generateDailyCheck({ ...c.t.deps, clusterReleases: unread.port }, options))
        .clusterReleases,
    ).toEqual([]);
    expect(unread.reads).toEqual([]);
  });

  it("shows the upgrade waiting when no recent Platform run left the cluster matching its commit, and says so when GitHub cannot be read", async () => {
    expect(
      clusterReleaseLine({
        slug: "foreman",
        state: "waiting",
        build: BUILD,
        applied: null,
      }),
    ).toBe(
      `${FOREMAN_UPGRADE_WAITING}: the images built from commit eeeeeee (Images run #88) are not applied; no recent Platform run on main shows the cluster matching its commit. Copy the pins from that Images run's foreman-images artifact into infra/kubernetes/settings/production.json, merge, and approve the Platform apply.`,
    );
    const { t } = await merged("cluster");
    const options = { holdReleaseRequestFlow: "f/foreman/hold_release_request" };
    for (const [gh, words] of [
      [
        releases("throw"),
        "the newest Images run on main and its foreman-images artifact",
      ],
      [releases(BUILD, "throw"), "the Platform workflow's newest runs on main"],
    ] as const) {
      const check = await generateDailyCheck(
        { ...t.deps, clusterReleases: gh.port },
        options,
      );
      expect(check.clusterReleases?.[0]?.state).toBe("unreadable");
      const text = renderDailyCheck(check);
      expect(text).toContain(
        "Whether a Foreman upgrade waits for your Platform apply is not shown",
      );
      expect(text).toContain(words);
    }
  });
});
