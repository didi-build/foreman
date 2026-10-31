// Seam: unit, on the memory store with the real machine-2 contracts and guards, the fake GitHub and
// a fake staging check. Staging verification (src/core/staging.ts, build plan M3.4, D-103, D-104):
// only a staging deploy of the merge commit counts, the runner's check is recorded as
// `staging_check` on that commit, a pass moves the item to Done and releases what it blocked, a
// fail sends it back with `failure` up by one and the third failure to the Council, a check
// without a result is re-dispatched once and then goes to the Council, and every step is taken
// once however often it is asked for.
import { describe, expect, it } from "vitest";

import { reconcile } from "../src/core/reconcile.ts";
import { createRunReports } from "../src/core/run-reports.ts";
import {
  createStaging,
  releaseTrigger,
  stagingCheckKey,
  stagingCheckTrigger,
  stagingDeployKey,
} from "../src/core/staging.ts";
import type { Store } from "../src/core/store.ts";
import { setupMerge } from "./merge-fixture.ts";
import { HEAD, REPO } from "./reconcile-fixture.ts";
import { createFakeStagingChecker, setupStaging as setup } from "./staging-fixture.ts";

const OTHER = "a".repeat(40);

describe("the staging deploy of the merge commit (unit: M3.4, O-34)", () => {
  it("waits, checking nothing, until GitHub reports a successful staging deploy of the merge commit", async () => {
    const t = await setup();
    expect(await t.staging().verify(t.node.id)).toMatchObject({
      step: "waiting_for_deploy",
      mergeCommitSha: t.mergeSha,
    });
    t.deploy(t.mergeSha, "in_progress");
    t.deploy(t.mergeSha, "inactive");
    expect((await t.staging().verify(t.node.id)).step).toBe("waiting_for_deploy");
    expect(t.checker.calls).toEqual([]);
    expect(await t.kind("staging_deploy")).toEqual([]);
  });

  it("does nothing for a deploy of another commit: the PR's head or any other commit on main", async () => {
    const t = await setup();
    t.deploy(HEAD);
    t.deploy(OTHER);
    expect((await t.staging().verify(t.node.id)).step).toBe("waiting_for_deploy");
    expect(await t.staging().verifyCommit(REPO, OTHER)).toEqual([]);
    expect(await t.staging().verifyCommit(REPO, HEAD)).toEqual([]);
    expect(t.checker.calls).toEqual([]);
    expect(await t.kind("staging_deploy")).toEqual([]);
    expect(await t.state()).toBe("verifying_on_staging");
  });

  it("records the deploy as runner evidence on the merge commit, once per deployment", async () => {
    const t = await setup();
    const deployment = t.deploy();
    const result = await t.staging().verify(t.node.id);
    const [deploy] = await t.kind("staging_deploy");
    expect(deploy).toMatchObject({
      commitSha: t.mergeSha,
      payload: { environment: "staging", deploymentId: deployment.id },
      ref: stagingDeployKey(REPO, deployment.id),
      recordedBy: "runner",
    });
    expect(result.deployEvidenceId).toBe(deploy?.id);
    await t.staging().verify(t.node.id);
    expect(await t.kind("staging_deploy")).toHaveLength(1);
  });

  it("the event path verifies only the item whose latest merge commit was deployed", async () => {
    const t = await setup();
    t.deploy();
    const results = await t.staging().verifyCommit(REPO, t.mergeSha);
    expect(results).toMatchObject([
      {
        nodeId: t.node.id,
        step: "checked",
        move: { toState: "done", outcome: "applied" },
      },
    ]);
    expect(await t.state()).toBe("done");
  });

  it("the polling backstop: a dry-run reconcile pass records the deploy and runs no check", async () => {
    const t = await setup({ dryRun: true });
    t.deploy();
    const report = await reconcile(t.deps);
    expect(report.staging).toMatchObject([{ nodeId: t.node.id, step: "would_check" }]);
    expect(await t.kind("staging_deploy")).toHaveLength(1);
    expect(t.checker.calls).toEqual([]);
    expect(await t.kind("staging_check")).toEqual([]);
    expect(await t.state()).toBe("verifying_on_staging");
  });

  it("reports a GitHub read that failed, and records nothing", async () => {
    const t = await setup();
    const broken = {
      ...t.deps,
      github: {
        ...t.github,
        listDeployments: async () => {
          throw new Error("GitHub is down");
        },
      },
    };
    const result = await createStaging({ ...broken, checker: t.checker }).verify(
      t.node.id,
    );
    expect(result.step).toBe("github_read_failed");
    expect(await t.kind("staging_deploy")).toEqual([]);
  });
});

describe("a passed staging check (unit: M3.4, O-35, O-37)", () => {
  it("checks staging at the merge commit, records the result, moves to Done and resets the counters", async () => {
    const t = await setup();
    await t.store.setCounter(t.node.id, "failure", 2, t.clock.now());
    await t.store.setCounter(t.node.id, "qa_round", 1, t.clock.now());
    t.deploy();

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
    t.deploy();

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
    t.deploy();
    await Promise.all([
      t.staging().verify(t.node.id),
      t.staging().verify(t.node.id),
      t.staging().verifyCommit(REPO, t.mergeSha),
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
    t.deploy();
    expect(await t.staging().verify(t.node.id)).toMatchObject({
      move: { toState: "done", outcome: "applied" },
    });
  });
});

describe("a failed staging check (unit: M3.4, D-104, P-03, O-37)", () => {
  it("sends the item back to In development with the failure counter up by one", async () => {
    const t = await setup();
    t.deploy();
    t.checker.answers.push({ result: "fail", servedCommitSha: t.mergeSha });

    const result = await t.staging().verify(t.node.id);

    expect((await t.kind("staging_check"))[0]?.payload).toEqual({ pass: false });
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
    t.deploy();
    t.checker.answers.push({ result: "fail", servedCommitSha: t.mergeSha });
    await t.staging().verify(t.node.id);
    expect(await t.state()).toBe("building_components");
    expect(await t.counter("failure")).toBe(1);
  });

  it("sends the third failure on to Escalated to Council, from In development", async () => {
    const t = await setup();
    await t.store.setCounter(t.node.id, "failure", 2, t.clock.now());
    t.deploy();
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
    t.deploy();
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
    t.deploy();
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
    t.deploy();
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
    t.deploy();
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
    t.deploy();
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
    t.deploy();
    await t.setting("kill_switch", true);
    const reads = t.github.reads;
    expect((await t.staging().verify(t.node.id)).step).toBe("refused");
    expect(await t.staging().verifyReady()).toEqual([]);
    expect(t.github.reads).toBe(reads);
    expect(t.checker.calls).toEqual([]);
    expect(await t.kind("staging_deploy")).toEqual([]);
    expect(await t.state()).toBe("verifying_on_staging");
  });

  it("in dry run records the deploy, runs no check and moves nothing", async () => {
    const t = await setup({ dryRun: true });
    t.deploy();
    const before = (await t.transitions(t.node.id)).length;
    expect((await t.staging().verify(t.node.id)).step).toBe("would_check");
    expect(t.checker.calls).toEqual([]);
    expect(await t.transitions(t.node.id)).toHaveLength(before);
    expect(await t.kind("staging_deploy")).toHaveLength(1);
  });

  it("in dry run writes one dry-run row for a check already recorded, and no counter", async () => {
    const t = await setup();
    t.deploy();
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
    // Main deploys the merge commit to staging, and the event reaches the runner.
    t.github.putDeployment(REPO, {
      id: 1,
      sha: mergeSha,
      environment: "staging",
      state: "success",
    });
    const staging = createStaging({ ...t.deps, checker: createFakeStagingChecker() });
    await staging.verifyCommit(REPO, mergeSha);

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
    t.deploy();
    t.checker.answers.push({ result: "fail", servedCommitSha: t.mergeSha });
    await t.staging().verifyCommit(REPO, t.mergeSha);

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
    t.deploy();
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
