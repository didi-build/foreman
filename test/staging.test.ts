// Seam: unit, on the memory store with the real machine-2 contracts and guards, the fake GitHub and
// a fake staging check. Staging verification (src/core/staging.ts, build plan M3.4, D-103, D-104):
// the deploy is the one the runner recorded itself when it deployed (D-356, O-116; recorded here
// through the deploy core's `record`, as the deploy flow does before its check), the runner's check
// is recorded as `staging_check` on the merge commit, a pass moves the item to Done and releases
// what it blocked, a fail sends it back with `failure` up by one and the third failure to the
// Council, a check without a result is re-dispatched once and then goes to the Council, and every
// step is taken once however often it is asked for. D-225: a deploy of a later commit on main that
// contains the merge commit (GitHub's compare) counts for it, a refused file set takes the fail
// path once, a refusal by infrastructure counts no failure (N-103), and an item waiting past
// `staging_deploy_attention_after_minutes` with no deploy goes on the attention list. GitHub's
// deployments are never read.
import { describe, expect, it } from "vitest";

import {
  createFakeStagingBuilds,
  createFakeStagingTarget,
  mainBuild,
} from "../src/adapters/deploy/fake.ts";
import { reconcile } from "../src/core/reconcile.ts";
import { createRunReports } from "../src/core/run-reports.ts";
import {
  createStaging,
  releaseTrigger,
  stagingCheckKey,
  stagingCheckTrigger,
  stagingDeployFailedTrigger,
} from "../src/core/staging.ts";
import {
  createStagingDeploys,
  stagingDeployRecordKey,
  stagingDeployRefusedKey,
} from "../src/core/staging-deploy.ts";
import type { Store } from "../src/core/store.ts";
import { setupMerge } from "./merge-fixture.ts";
import { HEAD, REPO } from "./reconcile-fixture.ts";
import {
  createFakeStagingChecker,
  outcomeOf,
  setupStaging as setup,
} from "./staging-fixture.ts";

const OTHER = "a".repeat(40);

describe("the staging deploy the runner recorded (unit: D-356, O-116)", () => {
  it("waits, checking nothing, until the runner records a deploy covering the merge commit", async () => {
    const t = await setup();
    expect(await t.staging().verify(t.node.id)).toMatchObject({
      step: "waiting_for_deploy",
      mergeCommitSha: t.mergeSha,
      waitingSince: t.node.stateSince,
    });
    expect(t.checker.calls).toEqual([]);
    expect(await t.kind("staging_deploy")).toEqual([]);
  });

  it("records nothing for a deploy of a commit without the merge commit: the PR's head or an unrelated commit", async () => {
    const t = await setup();
    await t.deploy(HEAD);
    await t.deploy(OTHER);
    expect(await t.kind("staging_deploy")).toEqual([]);
    expect((await t.staging().verify(t.node.id)).step).toBe("waiting_for_deploy");
    expect(t.checker.calls).toEqual([]);
    expect(await t.state()).toBe("verifying_on_staging");
  });

  it("records the deploy as runner evidence on the merge commit, once per CI run", async () => {
    const t = await setup();
    const run = mainBuild(REPO, 41, t.mergeSha);
    const recorded = await t.deploys().record(REPO, run, outcomeOf("success"));
    const [deploy] = await t.kind("staging_deploy");
    expect(deploy).toMatchObject({
      commitSha: t.mergeSha,
      payload: {
        deployedSha: t.mergeSha,
        workflowRunId: 41,
        containment: "identical",
        files: 3,
      },
      ref: stagingDeployRecordKey(REPO, 41, t.mergeSha),
      recordedBy: "runner",
      runId: null,
    });
    expect(recorded.recorded).toEqual([{ nodeId: t.node.id, evidenceId: deploy?.id }]);
    const result = await t.staging().verify(t.node.id);
    expect(result.deployEvidenceId).toBe(deploy?.id);
    await t.deploys().record(REPO, run, outcomeOf("success"));
    expect(await t.kind("staging_deploy")).toHaveLength(1);
  });

  it("a dry-run reconcile pass reads the recorded deploy, runs no check and records nothing", async () => {
    const t = await setup({ dryRun: true });
    await t.deploy();
    const report = await reconcile(t.deps);
    expect(report.staging).toMatchObject([{ nodeId: t.node.id, step: "would_check" }]);
    expect(await t.kind("staging_deploy")).toHaveLength(1);
    expect(t.checker.calls).toEqual([]);
    expect(await t.kind("staging_check")).toEqual([]);
    expect(await t.state()).toBe("verifying_on_staging");
  });

  it("reads no GitHub deployment: the GitHub port has none to read", async () => {
    const t = await setup();
    expect("listDeployments" in t.github).toBe(false);
    expect("listRecentDeployments" in t.github).toBe(false);
    const reads = t.github.reads;
    expect((await t.staging().verify(t.node.id)).step).toBe("waiting_for_deploy");
    expect(t.github.reads).toBe(reads);
  });
});

describe("a passed staging check (unit: M3.4, O-35, O-37)", () => {
  it("checks staging at the merge commit, records the result, moves to Done and resets the counters", async () => {
    const t = await setup();
    await t.store.setCounter(t.node.id, "failure", 2, t.clock.now());
    await t.store.setCounter(t.node.id, "qa_round", 1, t.clock.now());
    await t.deploy();

    const result = await t.staging().verify(t.node.id);

    expect(t.checker.calls).toMatchObject([
      { project: { id: t.projectId, repo: REPO }, commitSha: t.mergeSha },
    ]);
    const [check] = await t.kind("staging_check");
    expect(check).toMatchObject({
      commitSha: t.mergeSha,
      payload: { pass: true },
      ref: stagingCheckKey(REPO, t.mergeSha),
      recordedBy: "runner",
      runId: null,
    });
    expect(result).toMatchObject({
      step: "checked",
      checkEvidenceId: check?.id,
      move: { toState: "done", outcome: "applied", failedGuards: [] },
    });
    expect(await t.state()).toBe("done");
    const move = (await t.transitions(t.node.id)).at(-1);
    expect(move).toMatchObject({
      fromState: "verifying_on_staging",
      toState: "done",
      triggerKind: "event",
      triggerRef: stagingCheckTrigger(check?.id ?? "").ref,
      actorId: "staging",
      mode: "applied",
    });
    expect(move?.evidenceIds).toContain(check?.id);
    expect(await t.counter("failure")).toBe(0);
    expect(await t.counter("qa_round")).toBe(0);
  });

  it("releases the items it blocked, once; one with another open blocker stays Blocked", async () => {
    const t = await setup();
    const free = await t.addNode("blocked");
    const stillBlocked = await t.addNode("blocked");
    const other = await t.addNode("in_development");
    await t.blocks(t.node.id, free.id);
    await t.blocks(t.node.id, stillBlocked.id);
    await t.blocks(other.id, stillBlocked.id);
    await t.deploy();

    const result = await t.staging().verify(t.node.id);

    expect(result.released).toMatchObject([
      { nodeId: free.id, move: { toState: "ready_for_dev", outcome: "applied" } },
      {
        nodeId: stillBlocked.id,
        move: { outcome: "rejected", failedGuards: ["blockers_done"] },
      },
    ]);
    expect((await t.store.getNode(free.id))?.state).toBe("ready_for_dev");
    expect((await t.store.getNode(stillBlocked.id))?.state).toBe("blocked");
    const [release] = await t.transitions(free.id);
    expect(release?.triggerRef).toBe(releaseTrigger(t.node.id).ref);
    // The live pass asks again for every Done node; the trigger is taken once.
    await t.staging().verifyReady();
    expect(await t.transitions(free.id)).toHaveLength(1);
  });

  it("is taken once however often it is asked for, in turn or at once", async () => {
    const t = await setup();
    await t.deploy();
    await Promise.all([
      t.staging().verify(t.node.id),
      t.staging().verify(t.node.id),
      t.staging().verify(t.node.id),
    ]);
    await t.staging().verify(t.node.id);
    await t.staging().verifyReady();
    expect(await t.kind("staging_check")).toHaveLength(1);
    expect(
      (await t.transitions(t.node.id)).filter((m) => m.toState === "done"),
    ).toHaveLength(1);
    expect(await t.state()).toBe("done");
  });

  it("works the same on the design track, where Done also needs the spec merged", async () => {
    const t = await setup({ track: "design" });
    await t.deploy();
    expect(await t.staging().verify(t.node.id)).toMatchObject({
      move: { toState: "done", outcome: "applied" },
    });
  });
});

describe("a failed staging check (unit: M3.4, D-104, P-03, O-37)", () => {
  it("sends the item back to In development with the failure counter up by one", async () => {
    const t = await setup();
    await t.deploy();
    t.checker.answers.push({ result: "fail", servedCommitSha: t.mergeSha });

    const result = await t.staging().verify(t.node.id);

    expect((await t.kind("staging_check"))[0]?.payload).toEqual({
      pass: false,
      servedCommitSha: t.mergeSha,
      containment: "identical",
    });
    expect(result).toMatchObject({
      move: { toState: "in_development", outcome: "applied" },
      escalation: { outcome: "rejected", failedGuards: ["escalation_trigger_met"] },
    });
    expect(await t.state()).toBe("in_development");
    expect(await t.counter("failure")).toBe(1);
    // Asked again, in turn or by the live pass: one move, one count.
    await t.staging().verify(t.node.id);
    await t.staging().verifyReady();
    expect(await t.counter("failure")).toBe(1);
    expect(
      (await t.transitions(t.node.id)).filter((m) => m.toState === "in_development"),
    ).toHaveLength(1);
  });

  it("sends a design item back to Building components", async () => {
    const t = await setup({ track: "design" });
    await t.deploy();
    t.checker.answers.push({ result: "fail", servedCommitSha: t.mergeSha });
    await t.staging().verify(t.node.id);
    expect(await t.state()).toBe("building_components");
    expect(await t.counter("failure")).toBe(1);
  });

  it("sends the third failure on to Escalated to Council, from In development", async () => {
    const t = await setup();
    await t.store.setCounter(t.node.id, "failure", 2, t.clock.now());
    await t.deploy();
    t.checker.answers.push({ result: "fail", servedCommitSha: t.mergeSha });

    const result = await t.staging().verify(t.node.id);

    expect(result).toMatchObject({
      move: { toState: "in_development", outcome: "applied" },
      escalation: { toState: "escalated_to_council", outcome: "applied" },
    });
    const node = await t.store.getNode(t.node.id);
    expect(node?.state).toBe("escalated_to_council");
    expect(node?.blockedReason).toMatch(/failure counter reached its limit/);
    expect(await t.counter("failure")).toBe(3);
    const moves = await t.transitions(t.node.id);
    expect(moves.slice(-2).map((m) => [m.fromState, m.toState])).toEqual([
      ["verifying_on_staging", "in_development"],
      ["in_development", "escalated_to_council"],
    ]);
  });

  it("recovers an escalation a failure part way left behind, in the live pass", async () => {
    const t = await setup();
    await t.store.setCounter(t.node.id, "failure", 2, t.clock.now());
    // The escalation is refused this time, as if the call stopped after the move back.
    await t.setting("failure_threshold", 4);
    await t.deploy();
    t.checker.answers.push({ result: "fail", servedCommitSha: t.mergeSha });
    await t.staging().verify(t.node.id);
    expect(await t.state()).toBe("in_development");

    await t.setting("failure_threshold", 3);
    const results = await t.staging().verifyReady();
    expect(results).toMatchObject([
      { nodeId: t.node.id, escalation: { outcome: "applied" } },
    ]);
    expect(await t.state()).toBe("escalated_to_council");
    expect(await t.counter("failure")).toBe(3);
  });
});

describe("a staging check without a result (unit: the contract's timeout, M3.4, O-36)", () => {
  it("is re-dispatched once, and a pass on the re-dispatch moves to Done", async () => {
    const t = await setup();
    await t.deploy();
    t.checker.answers.push({ result: "no_result", reason: "unreachable" });

    const first = await t.staging().verify(t.node.id);
    expect(first.step).toBe("no_result");
    expect((await t.kind("staging_no_result"))[0]).toMatchObject({
      commitSha: t.mergeSha,
      payload: { reason: "unreachable", attempt: 1 },
    });
    expect(await t.state()).toBe("verifying_on_staging");
    expect(await t.counter("failure")).toBe(0);

    const second = await t.staging().verify(t.node.id);
    expect(second.move).toMatchObject({ toState: "done", outcome: "applied" });
    expect(t.checker.calls).toHaveLength(2);
  });

  it("goes to the Council when the re-dispatch also ends without a result", async () => {
    const t = await setup();
    await t.deploy();
    t.checker.answers.push(
      { result: "no_result", reason: "timed_out" },
      { result: "no_result", reason: "unreachable" },
    );
    await t.staging().verify(t.node.id);
    const second = await t.staging().verify(t.node.id);

    expect(second).toMatchObject({
      step: "timed_out",
      escalation: { toState: "escalated_to_council", outcome: "applied" },
    });
    const node = await t.store.getNode(t.node.id);
    expect(node?.state).toBe("escalated_to_council");
    expect(node?.blockedReason).toMatch(/without a result 2 times/);
    expect((await t.transitions(t.node.id)).at(-1)?.triggerKind).toBe("timeout");
    expect(await t.counter("failure")).toBe(0);
    // Escalated: nothing more is checked.
    expect((await t.staging().verify(t.node.id)).step).toBe("not_verifying");
    expect(t.checker.calls).toHaveLength(2);
  });

  it("counts staging serving another commit as no result for the merge commit", async () => {
    const t = await setup();
    await t.deploy();
    t.checker.answers.push({ result: "pass", servedCommitSha: OTHER });
    expect((await t.staging().verify(t.node.id)).step).toBe("no_result");
    expect((await t.kind("staging_no_result"))[0]?.payload).toEqual({
      reason: "another_commit",
      attempt: 1,
    });
    expect(await t.kind("staging_check")).toEqual([]);
  });

  it("records nothing when the check itself breaks, and tries again next time", async () => {
    const t = await setup();
    await t.deploy();
    t.checker.answers.push("throw");
    expect((await t.staging().verify(t.node.id)).step).toBe("check_error");
    expect(await t.kind("staging_no_result")).toEqual([]);
    expect(await t.kind("staging_check")).toEqual([]);
    expect((await t.staging().verify(t.node.id)).move?.toState).toBe("done");
  });
});

describe("the switches (unit: M3.4)", () => {
  it("under the kill switch reads and writes nothing", async () => {
    const t = await setup();
    await t.deploy();
    await t.setting("kill_switch", true);
    const reads = t.github.reads;
    expect((await t.staging().verify(t.node.id)).step).toBe("refused");
    expect(await t.staging().verifyReady()).toEqual([]);
    expect(t.github.reads).toBe(reads);
    expect(t.checker.calls).toEqual([]);
    expect(await t.kind("staging_check")).toEqual([]);
    expect(await t.state()).toBe("verifying_on_staging");
  });

  it("in dry run reads the deploy, runs no check and moves nothing", async () => {
    const t = await setup({ dryRun: true });
    await t.deploy();
    const before = (await t.transitions(t.node.id)).length;
    expect((await t.staging().verify(t.node.id)).step).toBe("would_check");
    expect(t.checker.calls).toEqual([]);
    expect(await t.transitions(t.node.id)).toHaveLength(before);
    expect(await t.kind("staging_deploy")).toHaveLength(1);
  });

  it("in dry run writes one dry-run row for a check already recorded, and no counter", async () => {
    const t = await setup();
    await t.deploy();
    await t.setting("dry_run", true);
    await t.evidence(
      t.node.id,
      "staging_check",
      { pass: false },
      { commitSha: t.mergeSha },
    );
    await t.staging().verify(t.node.id);
    await t.staging().verify(t.node.id);
    const rows = (await t.transitions(t.node.id)).filter(
      (m) => m.toState === "in_development",
    );
    expect(rows).toMatchObject([{ mode: "dry_run" }]);
    expect(await t.state()).toBe("verifying_on_staging");
    expect(await t.counter("failure")).toBe(0);
  });

  it("does not move an item that is not in Verifying on staging", async () => {
    const t = await setupMerge();
    const staging = createStaging({ ...t.deps, checker: null });
    expect((await staging.verify(t.node.id)).step).toBe("not_verifying");
  });
});

describe("walkthrough: QA pass, merge, staging deploy, check, Done (unit: M3.3 and M3.4)", () => {
  async function mergedByQaReport() {
    const t = await setup();
    // A second item the merged one blocks, released on Done.
    const dependent = await t.addNode("blocked");
    await t.blocks(t.node.id, dependent.id);
    return { t, dependent };
  }

  it("a rehearsal run passes: the item reaches Done and its dependent is released", async () => {
    const t = await setupMerge();
    const dependent = await t.addNode("blocked");
    await t.blocks(t.node.id, dependent.id);
    const qa = await t.passedOn(HEAD);
    const reported = await createRunReports(t.deps).requestReportedMove(qa.id);
    expect(reported).toMatchObject({
      outcome: "applied",
      toState: "verifying_on_staging",
    });
    const mergeSha = (reported.requested && reported.mergeCommitSha) || "";
    t.github.setBranchHead(REPO, "main", mergeSha);
    // CI builds main, and the runner deploys that build, records it and checks staging (O-116).
    const builds = createFakeStagingBuilds();
    builds.putRun(REPO, mainBuild(REPO, 7, mergeSha));
    const target = createFakeStagingTarget();
    const deployed = await createStagingDeploys({
      ...t.deps,
      checker: createFakeStagingChecker(),
      builds,
      target,
    }).deployRun(REPO, 7);
    expect(deployed).toMatchObject({ step: "deployed", covers: [t.node.id] });
    expect(target.deploys).toMatchObject([{ slug: "rehearsal", commitSha: mergeSha }]);

    expect(await t.state()).toBe("done");
    expect((await t.store.getNode(dependent.id))?.state).toBe("ready_for_dev");
    expect(
      (await t.transitions(t.node.id)).map((m) => [m.fromState, m.toState, m.mode]),
    ).toEqual([
      ["in_qa_review", "verifying_on_staging", "applied"],
      ["verifying_on_staging", "done", "applied"],
    ]);
  });

  it("a deliberately broken change reopens the item, and its dependent stays Blocked", async () => {
    const { t, dependent } = await mergedByQaReport();
    await t.deploy();
    t.checker.answers.push({ result: "fail", servedCommitSha: t.mergeSha });
    await t.staging().verify(t.node.id);

    expect(await t.state()).toBe("in_development");
    expect(await t.counter("failure")).toBe(1);
    expect((await t.store.getNode(dependent.id))?.state).toBe("blocked");
  });
});

/** A store whose `listEdges` fails once, as if the call stopped right after the Done move. */
function failingEdgesOnce(store: Store): Store {
  let fail = true;
  return {
    ...store,
    listEdges: async (filter) => {
      if (fail) {
        fail = false;
        throw new Error("the database connection dropped");
      }
      return store.listEdges(filter);
    },
  };
}

describe("recovery of the release (unit: M3.4, O-37)", () => {
  it("releases the dependents of a Done item whose release was cut short", async () => {
    const t = await setup();
    const dependent = await t.addNode("blocked");
    await t.blocks(t.node.id, dependent.id);
    await t.deploy();
    await expect(
      t.staging(failingEdgesOnce(t.store)).verify(t.node.id),
    ).rejects.toThrow(/connection dropped/);
    expect(await t.state()).toBe("done");
    expect((await t.store.getNode(dependent.id))?.state).toBe("blocked");

    const results = await t.staging().verifyReady();
    expect(results).toMatchObject([
      { nodeId: t.node.id, released: [{ nodeId: dependent.id }] },
    ]);
    expect((await t.store.getNode(dependent.id))?.state).toBe("ready_for_dev");
  });
});

const LATER = "b".repeat(40);
const LATEST = "c".repeat(40);
const BEFORE = "e".repeat(40);

describe("a deploy of a later commit that contains the merge commit (unit: D-225 rule 1, O-38, O-39)", () => {
  it("counts for the merge commit, records the compare, and a check on the served commit moves to Done", async () => {
    const t = await setup();
    t.commitOnMain(LATER);
    const runId = await t.deploy(LATER);
    t.checker.answers.push({ result: "pass", servedCommitSha: LATER });

    const result = await t.staging().verify(t.node.id);

    const [deploy] = await t.kind("staging_deploy");
    expect(deploy).toMatchObject({
      commitSha: t.mergeSha,
      payload: {
        deployedSha: LATER,
        workflowRunId: runId,
        containment: "ahead",
        onMain: true,
        mainHeadSha: LATER,
      },
      ref: stagingDeployRecordKey(REPO, runId, t.mergeSha),
      recordedBy: "runner",
    });
    // The check is still asked about, and recorded on, the merge commit.
    expect(t.checker.calls).toMatchObject([{ commitSha: t.mergeSha }]);
    const [check] = await t.kind("staging_check");
    expect(check).toMatchObject({
      commitSha: t.mergeSha,
      payload: {
        pass: true,
        servedCommitSha: LATER,
        containment: "ahead",
        onMain: true,
        mainHeadSha: LATER,
      },
      ref: stagingCheckKey(REPO, t.mergeSha),
    });
    expect(result).toMatchObject({
      step: "checked",
      deployEvidenceId: deploy?.id,
      move: { toState: "done", outcome: "applied", failedGuards: [] },
    });
    expect(await t.state()).toBe("done");
  });

  it("records the deploy of the merge commit itself as identical, needing no main check", async () => {
    const t = await setup();
    t.github.setBranchHead(REPO, "main", OTHER);
    await t.deploy();
    await t.staging().verify(t.node.id);
    expect((await t.kind("staging_deploy"))[0]?.payload).toEqual({
      deployedSha: t.mergeSha,
      workflowRunId: expect.any(Number),
      containment: "identical",
      files: 3,
    });
    expect((await t.kind("staging_check"))[0]?.payload).toEqual({
      pass: true,
      servedCommitSha: t.mergeSha,
      containment: "identical",
    });
    expect(await t.state()).toBe("done");
  });

  it("records nothing for a commit behind the merge commit, or diverged from it", async () => {
    const t = await setup();
    t.github.putCommit(REPO, t.mergeSha, [BEFORE]);
    await t.deploy(BEFORE);
    await t.deploy(OTHER);
    expect(await t.github.compareCommits(REPO, t.mergeSha, BEFORE)).toBe("behind");
    expect(await t.github.compareCommits(REPO, t.mergeSha, OTHER)).toBe("diverged");
    expect(await t.kind("staging_deploy")).toEqual([]);
    expect((await t.staging().verify(t.node.id)).step).toBe("waiting_for_deploy");
    expect(t.checker.calls).toEqual([]);
  });

  it("records nothing for a commit that contains the merge commit but is not on main", async () => {
    const t = await setup();
    t.commitOnBranch(LATER);
    await t.deploy(LATER);
    expect(await t.kind("staging_deploy")).toEqual([]);
    expect((await t.staging().verify(t.node.id)).step).toBe("waiting_for_deploy");
  });

  it("counts staging serving a branch commit as no result, even when it contains the merge commit", async () => {
    const t = await setup();
    await t.deploy();
    t.commitOnBranch(LATER);
    t.checker.answers.push({ result: "pass", servedCommitSha: LATER });
    expect((await t.staging().verify(t.node.id)).step).toBe("no_result");
    expect(await t.kind("staging_check")).toEqual([]);
  });

  it("records nothing, and throws, when main's head or the compare cannot be read", async () => {
    for (const broken of ["getBranchHead", "compareCommits"] as const) {
      const t = await setup();
      t.commitOnMain(LATER);
      const deploys = createStagingDeploys({
        ...t.deps,
        github: {
          ...t.github,
          [broken]: async (): Promise<never> => {
            throw new Error("GitHub is down");
          },
        },
        checker: t.checker,
        builds: t.builds,
        target: t.target,
      });
      await expect(
        deploys.record(REPO, mainBuild(REPO, 9, LATER), outcomeOf("success")),
      ).rejects.toThrow(/GitHub is down/);
      expect(await t.kind("staging_deploy"), broken).toEqual([]);
    }
  });

  it("one later deploy covers two items merged close together, each under its own key", async () => {
    const t = await setup();
    const second = await setup({
      store: t.store,
      idPrefix: "51000000-0000-4000-8000",
      slug: "second",
      pr: 8,
      mergeSha: "9".repeat(40),
    });
    for (const g of [t.github, second.github]) {
      g.putCommit(REPO, second.mergeSha, [t.mergeSha]);
      g.putCommit(REPO, LATER, [second.mergeSha]);
      g.setBranchHead(REPO, "main", LATER);
    }
    const recorded = await t
      .deploys()
      .record(REPO, mainBuild(REPO, 5000, LATER), outcomeOf("success"));
    expect(recorded.covers.map((n) => n.id).sort()).toEqual(
      [t.node.id, second.node.id].sort(),
    );

    await t.staging().verify(t.node.id);
    await second.staging().verify(second.node.id);

    expect((await t.kind("staging_deploy"))[0]?.ref).toBe(
      stagingDeployRecordKey(REPO, 5000, t.mergeSha),
    );
    expect((await second.kind("staging_deploy", second.node))[0]?.ref).toBe(
      stagingDeployRecordKey(REPO, 5000, second.mergeSha),
    );
    expect(await t.state()).toBe("done");
    expect((await second.store.getNode(second.node.id))?.state).toBe("done");
  });

  it("compares a served commit newer than the deployed one, and counts it when it contains the merge commit", async () => {
    const t = await setup();
    t.commitOnMain(LATER);
    t.commitOnMain(LATEST, LATER);
    await t.deploy(LATER);
    t.checker.answers.push({ result: "fail", servedCommitSha: LATEST });
    await t.staging().verify(t.node.id);
    expect((await t.kind("staging_check"))[0]?.payload).toEqual({
      pass: false,
      servedCommitSha: LATEST,
      containment: "ahead",
      onMain: true,
      mainHeadSha: LATEST,
    });
    expect(await t.state()).toBe("in_development");
  });

  it("counts a served commit without the merge commit as no result, and records no check", async () => {
    const t = await setup();
    t.commitOnMain(LATER);
    await t.deploy(LATER);
    t.checker.answers.push({ result: "pass", servedCommitSha: BEFORE });
    expect((await t.staging().verify(t.node.id)).step).toBe("no_result");
    expect((await t.kind("staging_no_result"))[0]?.payload).toMatchObject({
      reason: "another_commit",
    });
    expect(await t.kind("staging_check")).toEqual([]);
  });

  it("records no check when GitHub's compare of a served commit fails", async () => {
    const t = await setup();
    t.commitOnMain(LATER);
    t.commitOnMain(LATEST, LATER);
    await t.deploy(LATER);
    t.checker.answers.push({ result: "pass", servedCommitSha: LATEST });
    const broken = {
      ...t.deps,
      github: {
        ...t.github,
        compareCommits: async (): Promise<never> => {
          throw new Error("GitHub is down");
        },
      },
    };
    const staging = createStaging({ ...broken, checker: t.checker });
    expect((await staging.verify(t.node.id)).step).toBe("github_read_failed");
    expect(await t.kind("staging_check")).toEqual([]);
  });
});

describe("a refused file set (unit: D-225 rule 2, O-116)", () => {
  for (const [label, deployed] of [
    ["of the merge commit", "merge"],
    ["of a later commit that contains it", "later"],
  ] as const) {
    it(`${label} takes the fail path once, with the failure counter up by one`, async () => {
      const t = await setup();
      const sha = deployed === "merge" ? t.mergeSha : t.commitOnMain(LATER);
      const runId = await t.deploy(sha, "failure");

      const result = await t.staging().verify(t.node.id);

      const [failed] = await t.kind("staging_deploy_failed");
      expect(failed).toMatchObject({
        commitSha: t.mergeSha,
        payload: {
          deployedSha: sha,
          workflowRunId: runId,
          containment: deployed === "merge" ? "identical" : "ahead",
          state: "failure",
          cause: "file_set",
          reason: "worker_code",
          text: "the staging-site build holds _worker.js, which would run code",
        },
        ref: stagingDeployRefusedKey(REPO, runId, "file_set", t.mergeSha),
        recordedBy: "runner",
      });
      expect(result).toMatchObject({
        step: "deploy_failed",
        deployFailedEvidenceId: failed?.id,
        move: { toState: "in_development", outcome: "applied", failedGuards: [] },
      });
      expect(t.checker.calls).toEqual([]);
      expect(await t.state()).toBe("in_development");
      expect(await t.counter("failure")).toBe(1);
      const move = (await t.transitions(t.node.id)).at(-1);
      expect(move).toMatchObject({
        triggerKind: "event",
        triggerRef: stagingDeployFailedTrigger(failed?.id ?? "").ref,
      });
      expect(move?.evidenceIds).toContain(failed?.id);

      // Asked again, in turn or by the live pass: one fact, one move, one count.
      await t.staging().verify(t.node.id);
      await t.staging().verifyReady();
      expect(await t.kind("staging_deploy_failed")).toHaveLength(1);
      expect(await t.counter("failure")).toBe(1);
      expect(
        (await t.transitions(t.node.id)).filter((m) => m.toState === "in_development"),
      ).toHaveLength(1);
    });
  }

  it("sends a design item back to Building components", async () => {
    const t = await setup({ track: "design" });
    await t.deploy(t.mergeSha, "failure");
    await t.staging().verify(t.node.id);
    expect(await t.state()).toBe("building_components");
    expect(await t.counter("failure")).toBe(1);
  });

  it("does nothing for a refused set of a commit without the merge commit", async () => {
    const t = await setup();
    await t.deploy(OTHER, "failure");
    expect((await t.staging().verify(t.node.id)).step).toBe("waiting_for_deploy");
    expect(await t.kind("staging_deploy_failed")).toEqual([]);
    expect(await t.counter("failure")).toBe(0);
  });

  it("sends the third failure on to Escalated to Council, and recovers an escalation cut short", async () => {
    const t = await setup();
    await t.store.setCounter(t.node.id, "failure", 2, t.clock.now());
    await t.setting("failure_threshold", 4);
    await t.deploy(t.mergeSha, "failure");
    expect(await t.staging().verify(t.node.id)).toMatchObject({
      escalation: { outcome: "rejected" },
    });
    expect(await t.state()).toBe("in_development");

    await t.setting("failure_threshold", 3);
    expect(await t.staging().verifyReady()).toMatchObject([
      { nodeId: t.node.id, escalation: { outcome: "applied" } },
    ]);
    const node = await t.store.getNode(t.node.id);
    expect(node?.state).toBe("escalated_to_council");
    expect(node?.blockedReason).toMatch(/staging deploy failed/);
    expect(await t.counter("failure")).toBe(3);
  });

  it("in dry run writes one dry-run row, and no counter", async () => {
    const t = await setup({ dryRun: true });
    await t.deploy(t.mergeSha, "failure");
    await reconcile(t.deps);
    await reconcile(t.deps);
    expect(await t.kind("staging_deploy_failed")).toHaveLength(1);
    expect(
      (await t.transitions(t.node.id)).filter((m) => m.toState === "in_development"),
    ).toMatchObject([{ mode: "dry_run" }]);
    expect(await t.state()).toBe("verifying_on_staging");
    expect(await t.counter("failure")).toBe(0);
  });

  it("under the kill switch moves and counts nothing", async () => {
    const t = await setup();
    await t.deploy(t.mergeSha, "failure");
    await t.setting("kill_switch", true);
    const reads = t.github.reads;
    expect((await t.staging().verify(t.node.id)).step).toBe("refused");
    expect(t.github.reads).toBe(reads);
    expect(await t.counter("failure")).toBe(0);
    expect(await t.state()).toBe("verifying_on_staging");
  });
});

describe("a deploy infrastructure refused (unit: O-116, N-103)", () => {
  it("is recorded as a deploy error, counts no failure, and leaves the item waiting for a deploy", async () => {
    const t = await setup();
    const runId = await t.deploy(t.mergeSha, "error");
    const [refused] = await t.kind("staging_deploy_failed");
    expect(refused).toMatchObject({
      commitSha: t.mergeSha,
      payload: {
        deployedSha: t.mergeSha,
        workflowRunId: runId,
        containment: "identical",
        state: "error",
        cause: "infrastructure",
        reason: "cloudflare_unavailable",
      },
      ref: stagingDeployRefusedKey(REPO, runId, "infrastructure", t.mergeSha),
    });
    for (let i = 0; i < 2; i++) {
      expect(await t.staging().verify(t.node.id)).toMatchObject({
        step: "waiting_for_deploy",
        waitingSince: t.node.stateSince,
      });
    }
    await t.staging().verifyReady();
    expect(await t.state()).toBe("verifying_on_staging");
    expect(await t.counter("failure")).toBe(0);
    expect(t.checker.calls).toEqual([]);
    expect(
      (await t.transitions(t.node.id)).filter((m) => m.toState === "in_development"),
    ).toEqual([]);
  });

  it("is not a failed deploy to the guards: a later deploy of the same run goes on to Done", async () => {
    const t = await setup();
    const runId = await t.deploy(t.mergeSha, "error");
    // The backstop's retry of the same run goes through this time.
    await t
      .deploys()
      .record(REPO, mainBuild(REPO, runId, t.mergeSha), outcomeOf("success"));
    const result = await t.staging().verify(t.node.id);
    expect(result).toMatchObject({ move: { toState: "done", outcome: "applied" } });
    expect(await t.kind("staging_deploy_failed")).toHaveLength(1);
    expect(await t.counter("failure")).toBe(0);
  });

  it("then a refused file set of the same run is recorded again, under its own key, and counts", async () => {
    const t = await setup();
    const runId = await t.deploy(t.mergeSha, "error");
    await t
      .deploys()
      .record(REPO, mainBuild(REPO, runId, t.mergeSha), outcomeOf("failure"));
    expect((await t.kind("staging_deploy_failed")).map((e) => e.ref)).toEqual([
      stagingDeployRefusedKey(REPO, runId, "infrastructure", t.mergeSha),
      stagingDeployRefusedKey(REPO, runId, "file_set", t.mergeSha),
    ]);
    await t.staging().verify(t.node.id);
    expect(await t.state()).toBe("in_development");
    expect(await t.counter("failure")).toBe(1);
  });
});

describe("a long wait for a staging deploy (unit: D-225 rule 3, O-40)", () => {
  const waits = (report: Awaited<ReturnType<typeof reconcile>>) =>
    report.attention.filter((a) => a.kind === "staging_deploy_wait");

  it("goes on the attention list after the setting, and not before", async () => {
    const t = await setup({ dryRun: true });
    expect(waits(await reconcile(t.deps))).toEqual([]);
    t.advanceMinutes(60);
    expect(waits(await reconcile(t.deps))).toEqual([]);
    t.advanceMinutes(1);
    const node = await t.store.getNode(t.node.id);
    expect(waits(await reconcile(t.deps))).toEqual([
      {
        kind: "staging_deploy_wait",
        nodeId: t.node.id,
        state: "verifying_on_staging",
        waitingSince: node?.stateSince,
        waitedMinutes: 61,
        limitMinutes: 60,
      },
    ]);
  });

  it("follows the setting", async () => {
    const t = await setup({ dryRun: true });
    await t.setting("staging_deploy_attention_after_minutes", 180);
    t.advanceMinutes(120);
    expect(waits(await reconcile(t.deps))).toEqual([]);
    t.advanceMinutes(61);
    expect(waits(await reconcile(t.deps))).toHaveLength(1);
  });

  it("is not reported once a deploy is recorded", async () => {
    const t = await setup({ dryRun: true });
    t.advanceMinutes(90);
    t.commitOnMain(LATER);
    await t.deploy(LATER);
    const report = await reconcile(t.deps);
    expect(report.staging).toMatchObject([{ step: "would_check" }]);
    expect(waits(report)).toEqual([]);
  });

  it("is reported while only refusals by infrastructure are recorded", async () => {
    const t = await setup({ dryRun: true });
    await t.deploy(t.mergeSha, "error");
    t.advanceMinutes(90);
    expect(waits(await reconcile(t.deps))).toMatchObject([
      { nodeId: t.node.id, waitedMinutes: 90 },
    ]);
  });

  it("reports a missing setting as a problem and lists nothing", async () => {
    const t = await setup({ dryRun: true });
    await t.setting("staging_deploy_attention_after_minutes", null);
    t.advanceMinutes(90);
    const report = await reconcile(t.deps);
    expect(waits(report)).toEqual([]);
    expect(report.problems).toContain(
      "staging_deploy_attention_after_minutes is missing or invalid: no staging deploy wait on the attention list",
    );
  });

  it("under the kill switch reports nothing", async () => {
    const t = await setup({ dryRun: true });
    t.advanceMinutes(90);
    await t.setting("kill_switch", true);
    expect((await reconcile(t.deps)).attention).toEqual([]);
  });
});
