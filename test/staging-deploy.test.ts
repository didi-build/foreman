// Seam: unit, on the memory store with the real machine-2 contracts and guards, the fake GitHub, a
// fake staging check, and fakes of CI's builds and the deploy target. The runner's own staging
// deploy (src/core/staging-deploy.ts, D-353, D-356, O-116): it reads the CI run from GitHub again,
// deploys exactly that run's build, then records the deploy on each item in Verifying on staging
// whose merge commit the deployed commit counts for (D-225 rule 1, GitHub's compare), then runs
// their staging check, in that order. A refused file set counts as a failed deploy (D-225 rule 2);
// a refusal by infrastructure counts no failure (N-103). Under the kill switch nothing is read;
// dry run says what it would deploy. The reconcile backstop deploys main's newest build for a
// project whose item waits with no deploy recorded. A deploy with a Worker module is recorded as
// such, carries its required secret names in its result only, and has the check probe the Worker
// (O-159). A build whose manifest requires a secret the staging Worker does not have is held as an
// infrastructure refusal that names the missing secrets and the Set project secret form, counts
// no failure, shows in the daily check and deploys on the backstop's next pass once the secret is
// set (D-448, O-163). The names of the D1 migrations a deploy applied reach its result only, and
// a migration the database refused as SQL counts as a refused file set does (O-165). Fake data
// only.
import { describe, expect, it } from "vitest";

import { mainBuild } from "../src/adapters/deploy/fake.ts";
import {
  DEPLOY_REFUSAL_TEXT_MAX_CHARS,
  readDeployRefusal,
} from "../src/core/guards/evidence.ts";
import {
  COVER_UNREADABLE,
  DEPLOY_REFUSALS,
  createStagingDeploys,
  isMainBuild,
  missingSecretsText,
  pendingDeployError,
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
    targets: {
      cloudflare: {
        deploy: async (request) => {
          log.push("upload");
          return t.target.deploy(request);
        },
        listSecretNames: async (slug) => {
          log.push("list secret names");
          return t.target.listSecretNames(slug);
        },
      },
      cluster: t.cluster,
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
      targets: { cloudflare: t.target, cluster: t.cluster },
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

describe("a staging deploy with a Worker module (unit: ADR 0118 slice 3, O-159)", () => {
  it("records the Worker on the deploy, carries the required secret names, and has the check probe it", async () => {
    const t = await setup();
    const runId = t.built();
    // The secret the build requires is on the staging Worker (D-448).
    t.target.secretNames.set("rehearsal", new Set(["MODEL_API_KEY"]));
    t.target.answers.push({
      outcome: "deployed",
      files: 2,
      worker: { requiredSecrets: ["MODEL_API_KEY"] },
    });
    const result = await t.deploys().deployRun(REPO, runId);
    expect(result).toMatchObject({
      step: "deployed",
      files: 2,
      worker: { requiredSecrets: ["MODEL_API_KEY"] },
      verified: [{ move: { toState: "done", outcome: "applied" } }],
    });
    const [deploy] = await t.kind("staging_deploy");
    expect(deploy?.payload).toMatchObject({ files: 2, worker: true });
    // Names only reach the result; the evidence keeps only that the build had a Worker.
    expect(JSON.stringify(deploy?.payload)).not.toContain("MODEL_API_KEY");
    expect(t.checker.calls).toEqual([
      {
        project: expect.objectContaining({ slug: "rehearsal" }),
        commitSha: t.mergeSha,
        worker: true,
      },
    ]);
  });

  it("asks only the marker for a deploy without a Worker, as before", async () => {
    const t = await setup();
    const result = await t.deploys().deployRun(REPO, t.built());
    expect(result).not.toHaveProperty("worker");
    const [deploy] = await t.kind("staging_deploy");
    expect(deploy?.payload).not.toHaveProperty("worker");
    expect(t.checker.calls).toHaveLength(1);
    expect(t.checker.calls[0]).not.toHaveProperty("worker");
  });

  it("records a failed health probe as a failed check with its reason, which sends the item back with one failure", async () => {
    const t = await setup();
    const runId = t.built();
    t.target.answers.push({
      outcome: "deployed",
      files: 2,
      worker: { requiredSecrets: [] },
    });
    t.checker.answers.push({
      result: "fail",
      servedCommitSha: t.mergeSha,
      reason: "api_health",
    });
    const result = await t.deploys().deployRun(REPO, runId);
    expect(result).toMatchObject({
      step: "deployed",
      verified: [
        { step: "checked", move: { toState: "in_development", outcome: "applied" } },
      ],
    });
    const [check] = await t.kind("staging_check");
    expect(check?.payload).toMatchObject({
      pass: false,
      servedCommitSha: t.mergeSha,
      reason: "api_health",
      containment: "identical",
    });
    expect(await t.counter("failure")).toBe(1);
  });
});

describe("a staging deploy with D1 migrations (unit: ADR 0118 slice 8, O-165)", () => {
  it("carries the names the target applied in its result only, and records the deploy as before", async () => {
    const t = await setup();
    const runId = t.built();
    t.target.answers.push({
      outcome: "deployed",
      files: 2,
      worker: { requiredSecrets: [] },
      migrationsApplied: ["0001_init.sql"],
    });
    const result = await t.deploys().deployRun(REPO, runId);
    expect(result).toMatchObject({
      step: "deployed",
      migrationsApplied: ["0001_init.sql"],
      verified: [{ move: { toState: "done", outcome: "applied" } }],
    });
    const [deploy] = await t.kind("staging_deploy");
    expect(deploy?.payload).toMatchObject({ files: 2, worker: true });
    expect(JSON.stringify(deploy?.payload)).not.toContain("0001_init.sql");
    // A deploy that applied none says so; one of a build without migrations says nothing.
    const again = await setup();
    again.target.answers.push({
      outcome: "deployed",
      files: 2,
      worker: { requiredSecrets: [] },
      migrationsApplied: [],
    });
    expect(await again.deploys().deployRun(REPO, again.built())).toMatchObject({
      step: "deployed",
      migrationsApplied: [],
    });
    const none = await setup();
    expect(await none.deploys().deployRun(REPO, none.built())).not.toHaveProperty(
      "migrationsApplied",
    );
  });

  it("records a migration the database refused as SQL like a refused file set: one failure, the item sent back, the text naming the file", async () => {
    const t = await setup();
    const runId = t.built();
    const text =
      "the migration 0002_more.sql failed on the staging database; nothing after it was applied or uploaded";
    t.target.answers.push({
      outcome: "refused",
      cause: "file_set",
      reason: "migration_failed",
      text,
      detail: { call: "migration_apply", status: 400, codes: [7500] },
    });
    const result = await t.deploys().deployRun(REPO, runId);
    expect(result).toMatchObject({
      step: "refused_file_set",
      reason: "migration_failed",
      text,
      detail: { call: "migration_apply", status: 400, codes: [7500] },
      covers: [t.node.id],
      verified: [{ step: "deploy_failed", move: { toState: "in_development" } }],
    });
    const [failed] = await t.kind("staging_deploy_failed");
    expect(failed).toMatchObject({
      ref: stagingDeployRefusedKey(REPO, runId, "file_set", t.mergeSha),
      payload: {
        cause: "file_set",
        state: "failure",
        reason: "migration_failed",
        text,
      },
    });
    // The detail stays on the result, as O-139 keeps it; the evidence has the fixed text only.
    expect(failed?.payload).not.toHaveProperty("detail");
    expect(readDeployRefusal(failed!.payload)).toEqual({
      reason: "migration_failed",
      text,
    });
    expect(await t.counter("failure")).toBe(1);
    expect(t.checker.calls).toEqual([]);
  });

  it("holds a deploy whose staging database is missing as infrastructure, counting no failure", async () => {
    const t = await setup();
    const runId = t.built();
    t.target.answers.push({
      outcome: "refused",
      cause: "infrastructure",
      reason: "database_missing",
      text: "Cloudflare lists no staging D1 database for the project; the New project form sets the project's database up",
      detail: { call: "database_list" },
    });
    expect(await t.deploys().deployRun(REPO, runId)).toMatchObject({
      step: "refused_infrastructure",
      reason: "database_missing",
      verified: [],
    });
    expect(await t.counter("failure")).toBe(0);
    expect(await t.state()).toBe("verifying_on_staging");
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

  it("passes on where the target's refusal came from, so it can be told apart (O-139)", async () => {
    const t = await setup();
    const runId = t.built();
    t.target.answers.push({
      outcome: "refused",
      cause: "infrastructure",
      reason: "credential_refused",
      text: "Cloudflare refused the staging deploy credential",
      detail: { call: "asset_upload", status: 401, codes: [10001] },
    });
    const result = await t.deploys().deployRun(REPO, runId);
    expect(result).toMatchObject({
      step: "refused_infrastructure",
      reason: "credential_refused",
      detail: { call: "asset_upload", status: 401, codes: [10001] },
    });
    expect(await t.counter("failure")).toBe(0);
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
      targets: { cloudflare: t.target, cluster: t.cluster },
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
      targets: { cloudflare: t.target, cluster: t.cluster },
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

describe("the required-secret check before a Worker is uploaded (unit: D-448, O-163)", () => {
  const WORKER_BUILD = {
    outcome: "deployed" as const,
    files: 2,
    worker: { requiredSecrets: ["MODEL_API_KEY", "MAIL_API_KEY"] },
  };

  it("holds a build that requires a secret the staging Worker does not have, as an infrastructure refusal naming it and the form, counting no failure", async () => {
    const t = await setup();
    const runId = t.built();
    t.target.secretNames.set("rehearsal", new Set(["MAIL_API_KEY", "OTHER_KEY"]));
    t.target.answers.push(WORKER_BUILD);
    const { deploys, log } = logged(t);
    const result = await deploys.deployRun(REPO, runId);
    const text =
      "the build needs product secrets not set on the staging Worker: MODEL_API_KEY. Set each with the Set project secret form";
    expect(result).toMatchObject({
      step: "refused_infrastructure",
      commitSha: t.mergeSha,
      reason: "secrets_missing",
      text,
      missingSecrets: ["MODEL_API_KEY"],
      covers: [t.node.id],
      verified: [],
    });
    // Listed before the upload, and nothing was uploaded: no check, no move.
    expect(log).toEqual([
      "upload",
      "list secret names",
      "record staging_deploy_failed",
    ]);
    expect(t.target.held).toEqual([t.mergeSha]);
    expect(await t.kind("staging_deploy")).toEqual([]);
    const [held] = await t.kind("staging_deploy_failed");
    expect(held?.payload).toMatchObject({
      state: "error",
      cause: "infrastructure",
      reason: "secrets_missing",
      text,
    });
    expect(await t.counter("failure")).toBe(0);
    expect(await t.state()).toBe("verifying_on_staging");
    // The daily check shows it as a deploy that did not go through (N-103).
    const node = await t.store.getNode(t.node.id);
    expect(node && (await pendingDeployError(t.store, node))).toMatchObject({
      reason: "secrets_missing",
      text,
    });
  });

  it("deploys on the backstop's next pass once the secret is set", async () => {
    const t = await setup();
    const runId = t.built();
    t.target.answers.push(WORKER_BUILD);
    expect(await t.deploys().deployRun(REPO, runId)).toMatchObject({
      reason: "secrets_missing",
      missingSecrets: ["MAIL_API_KEY", "MODEL_API_KEY"],
    });
    // Didi sets both with the form; the next pass deploys and the check moves the item.
    await t.target.putSecret("rehearsal", "MODEL_API_KEY", "test-only-value-1");
    await t.target.putSecret("rehearsal", "MAIL_API_KEY", "test-only-value-2");
    t.target.answers.push(WORKER_BUILD);
    const steps = await t.deploys().backstop();
    expect(steps).toMatchObject([
      {
        repo: REPO,
        step: "deploy",
        deploy: {
          step: "deployed",
          worker: { requiredSecrets: ["MODEL_API_KEY", "MAIL_API_KEY"] },
          verified: [{ move: { toState: "done", outcome: "applied" } }],
        },
      },
    ]);
    expect(await t.counter("failure")).toBe(0);
    expect(await t.state()).toBe("done");
  });

  it("holds the deploy when the staging Worker's secret names cannot be read, with the target's call and status", async () => {
    for (const listSecretNames of [
      async () => ({
        outcome: "refused" as const,
        reason: "credential_refused",
        text: "Cloudflare refused the staging deploy credential",
        detail: { call: "secret_list", status: 403 },
      }),
      async (): Promise<never> => {
        throw new Error("the fake target broke");
      },
    ]) {
      const t = await setup();
      const runId = t.built();
      t.target.answers.push(WORKER_BUILD);
      const deploys = createStagingDeploys({
        ...t.deps,
        checker: t.checker,
        builds: t.builds,
        targets: {
          cloudflare: { deploy: t.target.deploy, listSecretNames },
          cluster: t.cluster,
        },
      });
      const result = await deploys.deployRun(REPO, runId);
      expect(result).toMatchObject({
        step: "refused_infrastructure",
        reason: "secrets_unreadable",
        text: DEPLOY_REFUSALS.secrets_unreadable,
        verified: [],
      });
      expect(result.detail).toEqual(
        result.detail ? { call: "secret_list", status: 403 } : undefined,
      );
      expect(await t.counter("failure")).toBe(0);
      expect(await t.kind("staging_deploy")).toEqual([]);
    }
  });

  it("asks nothing for a build that requires no secret, nor for one without a Worker", async () => {
    const t = await setup();
    t.target.answers.push({ ...WORKER_BUILD, worker: { requiredSecrets: [] } });
    const { deploys, log } = logged(t);
    expect((await deploys.deployRun(REPO, t.built())).step).toBe("deployed");
    expect(log).not.toContain("list secret names");
    expect(t.target.held).toEqual([]);
  });

  it("keeps the text within what the daily check shows, naming as many as fit and how many more", () => {
    expect(missingSecretsText(["MODEL_API_KEY"])).toBe(
      "the build needs product secrets not set on the staging Worker: MODEL_API_KEY. Set each with the Set project secret form",
    );
    const long = (c: string) => `${c}${"_".repeat(62)}${c}`;
    const many = Array.from({ length: 64 }, (_, i) =>
      long(String.fromCharCode(65 + (i % 26))),
    );
    for (const missing of [
      many,
      many.slice(0, 2),
      ["A", "B", "C"],
      Array.from({ length: 64 }, (_, i) => `KEY_${i}`),
    ]) {
      const text = missingSecretsText(missing);
      expect(text.length, text).toBeLessThanOrEqual(DEPLOY_REFUSAL_TEXT_MAX_CHARS);
      expect(readDeployRefusal({ reason: "secrets_missing", text })).toEqual({
        reason: "secrets_missing",
        text,
      });
      expect(text).toContain(missing[0]);
      expect(text).toMatch(/Set each with the Set project secret form$/);
    }
    expect(missingSecretsText(many)).toContain(`${many[0]} and 63 more`);
    expect(missingSecretsText(["A", "B", "C"])).toContain(": A, B, C.");
  });
});
