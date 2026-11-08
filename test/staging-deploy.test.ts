// Seam: unit, on the memory store with the real machine-2 contracts and guards, the fake GitHub, a
// fake staging check, and fakes of CI's builds and the deploy target. The runner's own staging
// deploy (src/core/staging-deploy.ts, D-353, D-356, O-116): it reads the CI run from GitHub again,
// deploys exactly that run's build, then records the deploy on each item in Verifying on staging
// whose merge commit the deployed commit counts for (D-225 rule 1, GitHub's compare), then runs
// their staging check, in that order. A refused file set counts as a failed deploy (D-225 rule 2);
// a refusal by infrastructure counts no failure (N-103). Under the kill switch nothing is read;
// dry run says what it would deploy. The reconcile backstop deploys main's newest build for a
// project whose item waits with no deploy recorded. Fake data only.
import { describe, expect, it } from "vitest";

import { mainBuild } from "../src/adapters/deploy/fake.ts";
import {
  COVER_UNREADABLE,
  DEPLOY_REFUSALS,
  createStagingDeploys,
  isMainBuild,
  stagingDeployRecordKey,
  stagingDeployRefusedKey,
  type BuildRun,
} from "../src/core/staging-deploy.ts";
import type { Store } from "../src/core/store.ts";
import { REPO } from "./reconcile-fixture.ts";
import { outcomeOf, setupStaging as setup } from "./staging-fixture.ts";

const LATER = "b".repeat(40);
const OTHER = "a".repeat(40);

type T = Awaited<ReturnType<typeof setup>>;

/** The deploys of the fixture, with each step of a deploy logged in order. */
function logged(t: T) {
  const log: string[] = [];
  const store: Store = {
    ...t.store,
    insertEvidenceOnce: async (evidence, key) => {
      log.push(`record ${evidence.kind}`);
      return t.store.insertEvidenceOnce(evidence, key);
    },
  };
  const deploys = createStagingDeploys({
    ...t.deps,
    store,
    checker: {
      check: async (request) => {
        log.push("check");
        return t.checker.check(request);
      },
    },
    builds: t.builds,
    target: {
      deploy: async (request) => {
        log.push("upload");
        return t.target.deploy(request);
      },
    },
  });
  return { deploys, log };
}

describe("the runner's staging deploy (unit: D-353, D-356, O-116)", () => {
  it("deploys the run's build, then records it on the item it covers, then checks staging", async () => {
    const t = await setup();
    const runId = t.built();
    const { deploys, log } = logged(t);

    const result = await deploys.deployRun(REPO, runId);

    expect(log).toEqual([
      "upload",
      "record staging_deploy",
      "check",
      "record staging_check",
    ]);
    expect(t.builds.reads).toEqual([
      `getRun ${REPO}#${runId}`,
      `siteArchive ${REPO}#${runId}`,
    ]);
    expect(t.target.deploys).toEqual([
      { slug: "rehearsal", commitSha: t.mergeSha, archiveBytes: 1 },
    ]);
    const [deploy] = await t.kind("staging_deploy");
    expect(deploy).toMatchObject({
      commitSha: t.mergeSha,
      ref: stagingDeployRecordKey(REPO, runId, t.mergeSha),
      payload: {
        deployedSha: t.mergeSha,
        workflowRunId: runId,
        containment: "identical",
      },
    });
    expect(result).toMatchObject({
      repo: REPO,
      runId,
      step: "deployed",
      commitSha: t.mergeSha,
      files: 1,
      covers: [t.node.id],
      recorded: [{ nodeId: t.node.id, evidenceId: deploy?.id }],
      verified: [{ nodeId: t.node.id, move: { toState: "done", outcome: "applied" } }],
    });
    expect(await t.state()).toBe("done");
  });

  it("records and checks every item a later commit on main covers, and no other", async () => {
    const t = await setup();
    const second = await setup({
      store: t.store,
      idPrefix: "52000000-0000-4000-8000",
      slug: "second",
      pr: 9,
      mergeSha: "9".repeat(40),
    });
    const elsewhere = await setup({
      store: t.store,
      idPrefix: "53000000-0000-4000-8000",
      slug: "third",
      pr: 10,
      mergeSha: "8".repeat(40),
    });
    // Main: the first merge, the second, then LATER. The third merge is on no branch of main.
    for (const g of [t.github, second.github, elsewhere.github]) {
      g.putCommit(REPO, second.mergeSha, [t.mergeSha]);
      g.putCommit(REPO, LATER, [second.mergeSha]);
      g.setBranchHead(REPO, "main", LATER);
    }
    const runId = t.built(LATER);
    const result = await t.deploys().deployRun(REPO, runId);
    expect(result.covers?.sort()).toEqual([t.node.id, second.node.id].sort());
    expect(await t.state()).toBe("done");
    expect((await t.store.getNode(second.node.id))?.state).toBe("done");
    expect((await t.store.getNode(elsewhere.node.id))?.state).toBe(
      "verifying_on_staging",
    );
    expect(await elsewhere.kind("staging_deploy", elsewhere.node)).toEqual([]);
    expect(t.checker.calls.map((c) => c.commitSha).sort()).toEqual(
      [t.mergeSha, second.mergeSha].sort(),
    );
  });

  it("deploys a build that covers no item, and records nothing", async () => {
    const t = await setup();
    t.github.putCommit(REPO, t.mergeSha, [OTHER]);
    const runId = t.built(OTHER);
    expect(await t.deploys().deployRun(REPO, runId)).toMatchObject({
      step: "deployed",
      covers: [],
      recorded: [],
      verified: [],
    });
    expect(t.target.deploys).toHaveLength(1);
    expect(await t.kind("staging_deploy")).toEqual([]);
    expect(t.checker.calls).toEqual([]);
  });

  it("deploys only a successful CI run started by a push to main from the repository itself", async () => {
    const t = await setup();
    const good = mainBuild(REPO, 500, t.mergeSha);
    expect(isMainBuild(good, REPO)).toBe(true);
    const variants: [string, Partial<BuildRun>][] = [
      ["another workflow", { path: ".github/workflows/screenshots.yml" }],
      ["the path with a ref", { path: ".github/workflows/ci.yml@refs/heads/main" }],
      ["a pull request's run", { event: "pull_request" }],
      ["another branch", { headBranch: "feature" }],
      ["a fork", { headRepo: "someone/rehearsal" }],
      ["no head repository", { headRepo: null }],
      ["a failed run", { conclusion: "failure" }],
      ["a run still going", { status: "in_progress", conclusion: null }],
      ["a run not completed", { status: "queued" }],
      ["a short commit", { headSha: "abc" }],
    ];
    for (const [i, [label, change]] of variants.entries()) {
      const run = { ...good, id: 600 + i, ...change };
      expect(isMainBuild(run, REPO), label).toBe(false);
      t.builds.putRun(REPO, run);
      expect((await t.deploys().deployRun(REPO, run.id)).step, label).toBe(
        "not_a_main_build",
      );
    }
    // A run GitHub does not have, or one listed under another id.
    expect((await t.deploys().deployRun(REPO, 999)).step).toBe("not_a_main_build");
    expect(t.target.deploys).toEqual([]);
    expect(t.builds.reads.filter((r) => r.startsWith("siteArchive"))).toEqual([]);
    expect(await t.kind("staging_deploy")).toEqual([]);
  });

  it("deploys nothing when GitHub answers with another run than the one asked for", async () => {
    const t = await setup();
    t.built();
    const builds = {
      ...t.builds,
      getRun: async () => mainBuild(REPO, 12345, t.mergeSha),
    };
    const deploys = createStagingDeploys({
      ...t.deps,
      checker: t.checker,
      builds,
      target: t.target,
    });
    expect((await deploys.deployRun(REPO, 701)).step).toBe("not_a_main_build");
    expect(t.target.deploys).toEqual([]);
  });

  it("covers only items in Verifying on staging: one already Done gets nothing more", async () => {
    const t = await setup();
    await t.deploys().deployRun(REPO, t.built());
    expect(await t.state()).toBe("done");
    const again = await t.deploys().deployRun(REPO, t.built());
    expect(again).toMatchObject({
      step: "deployed",
      covers: [],
      recorded: [],
      verified: [],
    });
    expect(await t.kind("staging_deploy")).toHaveLength(1);
  });

  it("refuses a repository that is not a registered project, reading nothing from GitHub", async () => {
    const t = await setup();
    expect(await t.deploys().deployRun("didi-build/launchpad", 1)).toEqual({
      repo: "didi-build/launchpad",
      runId: 1,
      step: "not_a_project",
    });
    expect(t.builds.reads).toEqual([]);
  });
});

describe("a refused staging deploy (unit: D-225 rule 2, O-116, N-103)", () => {
  it("a refused file set is recorded on the item it covers, counts one failure and sends it back", async () => {
    const t = await setup();
    const runId = t.built(t.mergeSha, "failure");
    const result = await t.deploys().deployRun(REPO, runId);
    expect(result).toMatchObject({
      step: "refused_file_set",
      reason: "worker_code",
      text: "the staging-site build holds _worker.js, which would run code",
      covers: [t.node.id],
      verified: [{ step: "deploy_failed", move: { toState: "in_development" } }],
    });
    expect((await t.kind("staging_deploy_failed"))[0]).toMatchObject({
      ref: stagingDeployRefusedKey(REPO, runId, "file_set", t.mergeSha),
      payload: { cause: "file_set", state: "failure" },
    });
    expect(await t.counter("failure")).toBe(1);
    expect(t.checker.calls).toEqual([]);
  });

  it("an infrastructure refusal is recorded as a deploy error, counts no failure, runs no check and moves nothing", async () => {
    const t = await setup();
    const runId = t.built(t.mergeSha, "error");
    const { deploys, log } = logged(t);
    const result = await deploys.deployRun(REPO, runId);
    expect(log).toEqual(["upload", "record staging_deploy_failed"]);
    expect(result).toMatchObject({
      step: "refused_infrastructure",
      reason: "cloudflare_unavailable",
      covers: [t.node.id],
      verified: [],
    });
    expect((await t.kind("staging_deploy_failed"))[0]).toMatchObject({
      ref: stagingDeployRefusedKey(REPO, runId, "infrastructure", t.mergeSha),
      payload: { cause: "infrastructure", state: "error" },
    });
    expect(await t.counter("failure")).toBe(0);
    expect(await t.state()).toBe("verifying_on_staging");
    expect(t.checker.calls).toEqual([]);
  });

  it("refuses as infrastructure, with fixed text, when GitHub's run, its artifact or the target fails", async () => {
    for (const [label, prepare, reason] of [
      ["run unreadable", (t: T) => t.builds.failNext.add("getRun"), "run_unreadable"],
      [
        "no artifact",
        (t: T) => t.builds.putRun(REPO, mainBuild(REPO, 401, t.mergeSha), null),
        "artifact_missing",
      ],
      [
        "artifact unreadable",
        (t: T) => t.builds.failNext.add("siteArchive"),
        "artifact_unreadable",
      ],
      ["target broke", (t: T) => t.target.answers.push("throw"), "target_error"],
    ] as const) {
      const t = await setup();
      const runId = t.built();
      prepare(t);
      const run = label === "no artifact" ? 401 : runId;
      const result = await t.deploys().deployRun(REPO, run);
      expect(result, label).toMatchObject({
        step: "refused_infrastructure",
        reason,
        text: DEPLOY_REFUSALS[reason],
      });
      expect(await t.counter("failure"), label).toBe(0);
      expect(await t.state(), label).toBe("verifying_on_staging");
      if (label === "run unreadable") {
        expect(await t.kind("staging_deploy_failed")).toEqual([]);
        expect(t.target.deploys).toEqual([]);
      } else {
        expect(
          (await t.kind("staging_deploy_failed"))[0]?.payload,
          label,
        ).toMatchObject({
          cause: "infrastructure",
          reason,
        });
      }
      if (reason !== "target_error") expect(t.target.deploys, label).toEqual([]);
    }
  });

  it("records nothing when GitHub's compare cannot be read after the deploy, and says so", async () => {
    const t = await setup();
    t.commitOnMain(LATER);
    const runId = t.built(LATER);
    const deploys = createStagingDeploys({
      ...t.deps,
      github: {
        ...t.github,
        compareCommits: async (): Promise<never> => {
          throw new Error("GitHub is down");
        },
      },
      checker: t.checker,
      builds: t.builds,
      target: t.target,
    });
    expect(await deploys.deployRun(REPO, runId)).toMatchObject({
      step: "deployed",
      problem: COVER_UNREADABLE,
    });
    expect(await t.kind("staging_deploy")).toEqual([]);
    expect(t.checker.calls).toEqual([]);
  });
});

describe("the switches (unit: O-116)", () => {
  it("under the kill switch reads and deploys nothing", async () => {
    const t = await setup();
    const runId = t.built();
    await t.setting("kill_switch", true);
    const reads = t.github.reads;
    expect(await t.deploys().deployRun(REPO, runId)).toEqual({
      repo: REPO,
      runId,
      step: "refused",
    });
    expect(await t.deploys().backstop()).toEqual([]);
    expect(t.builds.reads).toEqual([]);
    expect(t.github.reads).toBe(reads);
    expect(t.target.deploys).toEqual([]);
  });

  it("in dry run says what it would deploy and which items it would cover, fetching and recording nothing", async () => {
    const t = await setup({ dryRun: true });
    const runId = t.built();
    expect(await t.deploys().deployRun(REPO, runId)).toEqual({
      repo: REPO,
      runId,
      step: "would_deploy",
      commitSha: t.mergeSha,
      covers: [t.node.id],
    });
    expect(t.builds.reads).toEqual([`getRun ${REPO}#${runId}`]);
    expect(t.target.deploys).toEqual([]);
    expect(await t.kind("staging_deploy")).toEqual([]);
    expect(t.checker.calls).toEqual([]);
  });
});

describe("the reconcile backstop (unit: O-116)", () => {
  it("deploys main's newest build for a project whose item waits with no deploy, then nothing more", async () => {
    const t = await setup();
    const runId = t.built();
    const steps = await t.deploys().backstop();
    expect(steps).toMatchObject([
      {
        repo: REPO,
        step: "deploy",
        deploy: { runId, step: "deployed", covers: [t.node.id] },
      },
    ]);
    expect(await t.state()).toBe("done");
    const reads = t.builds.reads.length;
    expect(await t.deploys().backstop()).toEqual([]);
    // Nothing waits, so GitHub is not read again.
    expect(t.builds.reads).toHaveLength(reads);
    expect(t.target.deploys).toHaveLength(1);
  });

  it("retries a run infrastructure refused, and stops once a deploy is recorded", async () => {
    const t = await setup();
    const runId = t.built(t.mergeSha, "error");
    expect((await t.deploys().deployRun(REPO, runId)).step).toBe(
      "refused_infrastructure",
    );
    const steps = await t.deploys().backstop();
    expect(steps).toMatchObject([
      { step: "deploy", deploy: { runId, step: "deployed" } },
    ]);
    expect(await t.state()).toBe("done");
    expect(await t.counter("failure")).toBe(0);
  });

  it("deploys an item that reached Verifying on staging after its build was deployed", async () => {
    const t = await setup();
    // Main's build of the merge commit was deployed before the item waited: nothing recorded.
    const runId = t.built();
    await t.deploys().record(REPO, mainBuild(REPO, runId, OTHER), outcomeOf("success"));
    expect(await t.kind("staging_deploy")).toEqual([]);
    expect(await t.deploys().backstop()).toMatchObject([
      { step: "deploy", deploy: { runId, covers: [t.node.id] } },
    ]);
    expect(await t.kind("staging_deploy")).toHaveLength(1);
  });

  it("waits when main's newest build does not cover the item yet, or there is none, and says so", async () => {
    const t = await setup();
    expect(await t.deploys().backstop()).toEqual([
      { repo: REPO, step: "no_main_build" },
    ]);
    t.github.putCommit(REPO, t.mergeSha, [OTHER]);
    t.built(OTHER);
    expect(await t.deploys().backstop()).toEqual([{ repo: REPO, step: "not_covered" }]);
    expect(t.target.deploys).toEqual([]);
  });

  it("reports GitHub it cannot read, and deploys nothing", async () => {
    const t = await setup();
    t.built();
    t.builds.failNext.add("latestMainBuild");
    expect(await t.deploys().backstop()).toEqual([{ repo: REPO, step: "unreadable" }]);
    const broken = createStagingDeploys({
      ...t.deps,
      github: {
        ...t.github,
        compareCommits: async (): Promise<never> => {
          throw new Error("GitHub is down");
        },
      },
      checker: t.checker,
      builds: t.builds,
      target: t.target,
    });
    t.github.putCommit(REPO, LATER, [t.mergeSha]);
    t.github.setBranchHead(REPO, "main", LATER);
    t.built(LATER);
    expect(await broken.backstop()).toEqual([{ repo: REPO, step: "unreadable" }]);
    expect(t.target.deploys).toEqual([]);
  });

  it("reads nothing for a project with no item waiting: none in Verifying on staging, or one with a deploy recorded", async () => {
    const t = await setup();
    await t.deploy();
    t.built();
    expect(await t.deploys().backstop()).toEqual([]);
    expect(t.builds.reads).toEqual([]);
  });

  it("in dry run reports what it would deploy and deploys nothing", async () => {
    const t = await setup({ dryRun: true });
    const runId = t.built();
    expect(await t.deploys().backstop()).toEqual([
      {
        repo: REPO,
        step: "deploy",
        deploy: {
          repo: REPO,
          runId,
          step: "would_deploy",
          commitSha: t.mergeSha,
          covers: [t.node.id],
        },
      },
    ]);
    expect(t.target.deploys).toEqual([]);
    expect(await t.kind("staging_deploy")).toEqual([]);
  });
});
