// Seam: unit, on the memory store with the real machine-2 contracts and guards and the fake
// GitHub. The runner's merge (src/core/merge.ts, build plan M3.3, D-218): the merge guard decides,
// the squash merge names the head the guards checked, the merge commit and the move are written
// only after GitHub merged, a failure after the merge is recovered without merging or recording
// twice, and a privileged-path PR opens one gate request for its head and waits for Didi.
import { describe, expect, it } from "vitest";

import { approvalDecision } from "../src/core/approvals.ts";
import type { GitHub } from "../src/core/github.ts";
import { mergeCommitKey } from "../src/core/github-ingest.ts";
import { createLibrary } from "../src/core/library.ts";
import { privilegedPathTopic } from "../src/core/merge.ts";
import { reconcile } from "../src/core/reconcile.ts";
import { createRunReports } from "../src/core/run-reports.ts";
import type { Store } from "../src/core/store.ts";
import { NEW, PR, setupMerge as setup } from "./merge-fixture.ts";
import { HEAD, REPO } from "./reconcile-fixture.ts";

describe("the merge on a QA pass (unit: src/core/merge.ts, M3.3)", () => {
  it("squash-merges at the checked head, then records the merge commit and the move", async () => {
    const t = await setup();
    await t.passedOn(HEAD);

    const result = await t.merges().mergeOnPass(t.node.id, t.trigger);

    expect(result).toMatchObject({ outcome: "applied", failedGuards: [] });
    expect(t.github.merges).toEqual([{ repo: REPO, number: PR, headSha: HEAD }]);
    expect(await t.state()).toBe("verifying_on_staging");
    const [check] = await t.kinds("merge_check");
    expect(check).toMatchObject({
      commitSha: HEAD,
      payload: { pr: PR, mergeable: true },
      recordedBy: "runner",
    });
    const [merge] = await t.kinds("merge_commit");
    expect(merge).toMatchObject({
      commitSha: result.mergeCommitSha,
      ref: mergeCommitKey(REPO, PR),
      payload: { pr: PR },
    });
    const [move] = await t.transitions(t.node.id);
    expect(move).toMatchObject({
      fromState: "in_qa_review",
      toState: "verifying_on_staging",
      triggerKind: "event",
      triggerRef: mergeCommitKey(REPO, PR),
      actorId: "merge",
      mode: "applied",
    });
    expect(move?.evidenceIds).toContain(merge?.id);
    expect(move?.evidenceIds).toContain(check?.id);
  });

  it("refuses when the guards fail before reading GitHub, and merges nothing", async () => {
    const t = await setup();
    await t.evidence(
      t.node.id,
      "ci_run",
      { conclusion: "failure", pr: PR, changedPaths: ["src/a.ts"] },
      { commitSha: HEAD },
    );
    const result = await t.merges().mergeOnPass(t.node.id, t.trigger);
    expect(result).toMatchObject({ outcome: "rejected", reason: "guard_failed" });
    expect(result.failedGuards).toEqual(
      expect.arrayContaining(["qa_verdict_independent_on_head", "ci_green_on_head"]),
    );
    expect(t.github.reads).toBe(0);
    expect(t.github.merges).toEqual([]);
    expect(await t.transitions(t.node.id)).toEqual([]);
    expect(await t.kinds("merge_check")).toEqual([]);
  });

  it.each([
    [false, /merge conflict/],
    [null, /has not worked out/],
  ])(
    "records GitHub's mergeable %s on the head and does not merge",
    async (mergeable, detail) => {
      const t = await setup();
      await t.passedOn(HEAD);
      t.github.setMergeable(REPO, PR, mergeable);
      const result = await t.merges().mergeOnPass(t.node.id, t.trigger);
      expect(result).toMatchObject({
        outcome: "rejected",
        failedGuards: ["no_merge_conflict_on_head"],
      });
      expect((await t.kinds("merge_check"))[0]?.payload).toEqual({ pr: PR, mergeable });
      expect(t.github.merges).toEqual([]);
      expect(await t.transitions(t.node.id)).toEqual([]);
      const report = await createLibrary(t.deps).checkTransition({
        nodeId: t.node.id,
        toState: "verifying_on_staging",
        trigger: t.trigger,
        actor: { kind: "runner", id: "test" },
      });
      expect(report.guardReport.find((c) => !c.pass)?.detail).toMatch(detail);
    },
  );

  it("does not merge a newer head GitHub reports that ingestion has not recorded yet", async () => {
    const t = await setup();
    await t.passedOn(HEAD);
    t.github.pushHead(REPO, PR, NEW);
    expect(await t.merges().mergeOnPass(t.node.id, t.trigger)).toMatchObject({
      outcome: "rejected",
      reason: "head_not_recorded",
    });
    expect(t.github.merges).toEqual([]);
    expect(await t.kinds("merge_check")).toEqual([]);
  });

  it("is refused by GitHub when a commit lands after the check, and records nothing", async () => {
    const t = await setup();
    await t.passedOn(HEAD);
    // A push right after the runner read the mergeable state, before it merges.
    const racing: GitHub = {
      ...t.github,
      getMergeability: async (repo, number) => {
        const answer = await t.github.getMergeability(repo, number);
        t.github.pushHead(repo, number, NEW);
        return answer;
      },
      squashMerge: (repo, number, sha) => t.github.squashMerge(repo, number, sha),
    };
    const result = await t.merges(t.store, racing).mergeOnPass(t.node.id, t.trigger);
    expect(result).toMatchObject({
      outcome: "refused",
      reason: "merge_refused",
      mergeRefusal: "head_changed",
    });
    expect(t.github.merges).toEqual([]);
    expect(await t.kinds("merge_commit")).toEqual([]);
    expect(await t.transitions(t.node.id)).toEqual([]);
    expect(await t.state()).toBe("in_qa_review");
  });

  it("recovers a failure after the merge on the next pass, without merging or recording twice", async () => {
    const t = await setup();
    await t.passedOn(HEAD);
    // The move's write fails once, after GitHub merged.
    let failOnce = true;
    const flaky: Store = {
      ...t.store,
      transaction: (work) =>
        t.store.transaction((tx) =>
          work({
            ...tx,
            insertTransition: async (row) => {
              if (failOnce && row.toState === "verifying_on_staging") {
                failOnce = false;
                throw new Error("the database connection dropped");
              }
              return tx.insertTransition(row);
            },
          }),
        ),
    };
    await expect(t.merges(flaky).mergeOnPass(t.node.id, t.trigger)).rejects.toThrow(
      /connection dropped/,
    );
    expect(t.github.merges).toHaveLength(1);
    expect(await t.kinds("merge_commit")).toHaveLength(1);
    expect(await t.state()).toBe("in_qa_review");

    // The reconcile flow's merge pass finds the PR merged at the node's head.
    const [recovered] = await t.merges().mergeReady();
    expect(recovered?.result).toMatchObject({ outcome: "applied" });
    expect(await t.state()).toBe("verifying_on_staging");

    // Again, and the polling backstop's own record of the merge: nothing new.
    expect(await t.merges().mergeReady()).toEqual([]);
    expect(await t.merges().mergeOnPass(t.node.id, t.trigger)).toMatchObject({
      outcome: "rejected",
      reason: "no_merge_move",
    });
    expect(t.github.merges).toHaveLength(1);
    expect(await t.kinds("merge_commit")).toHaveLength(1);
    expect(await t.transitions(t.node.id)).toHaveLength(1);
  });

  it("uses the merge commit GitHub ingestion already recorded, under the same key", async () => {
    const t = await setup();
    await t.passedOn(HEAD);
    // The runner checked and merged, then stopped; the webhook for the merge was ingested first.
    await t.merges().inspect(t.node.id);
    const merged = await t.github.squashMerge(REPO, PR, HEAD);
    if (!merged.merged) throw new Error("the fake refused the merge");
    const ingestedId = "70000000-0000-4000-8000-000000000001";
    await t.store.insertEvidenceOnce(
      {
        id: ingestedId,
        nodeId: t.node.id,
        runId: null,
        kind: "merge_commit",
        ref: mergeCommitKey(REPO, PR),
        commitSha: merged.mergeCommitSha,
        payload: { pr: PR },
        recordedBy: "github",
        recordedAt: t.clock.now(),
        supersedesId: null,
      },
      mergeCommitKey(REPO, PR),
    );

    const result = await t.merges().mergeOnPass(t.node.id, t.trigger);
    expect(result).toMatchObject({
      outcome: "applied",
      mergeCommitSha: merged.mergeCommitSha,
    });
    expect(t.github.merges).toHaveLength(1);
    expect((await t.kinds("merge_commit")).map((e) => e.id)).toEqual([ingestedId]);
    expect((await t.transitions(t.node.id))[0]?.evidenceIds).toContain(ingestedId);
  });

  it("does not complete a PR merged at a head the guards never read", async () => {
    const t = await setup();
    await t.passedOn(HEAD);
    t.github.pushHead(REPO, PR, NEW);
    t.github.merge(REPO, PR, "9".repeat(40));
    expect(await t.merges().mergeOnPass(t.node.id, t.trigger)).toMatchObject({
      outcome: "rejected",
      reason: "merged_at_another_head",
    });
    expect(await t.kinds("merge_commit")).toEqual([]);
    expect(await t.state()).toBe("in_qa_review");
  });

  it("merges nothing in dry run and writes the move as a dry-run row once", async () => {
    const t = await setup({ dryRun: true });
    await t.passedOn(HEAD);
    expect(await t.merges().mergeOnPass(t.node.id, t.trigger)).toMatchObject({
      outcome: "planned",
    });
    expect(await t.merges().mergeOnPass(t.node.id, t.trigger)).toMatchObject({
      outcome: "noop",
      reason: "duplicate_trigger",
    });
    expect(t.github.merges).toEqual([]);
    expect(await t.transitions(t.node.id)).toMatchObject([
      { mode: "dry_run", triggerRef: "run:test" },
    ]);
    expect(await t.state()).toBe("in_qa_review");
  });

  it("is refused under the kill switch before anything is read", async () => {
    const t = await setup();
    await t.passedOn(HEAD);
    await t.setting("kill_switch", true);
    expect(await t.merges().mergeOnPass(t.node.id, t.trigger)).toMatchObject({
      outcome: "refused",
      reason: "kill_switch",
    });
    expect(t.github.reads).toBe(0);
  });

  it("refuses at the QA round cap, and passes after two failed rounds (no double count)", async () => {
    const t = await setup();
    await t.passedOn(HEAD);
    await t.store.setCounter(t.node.id, "qa_round", 3, t.clock.now());
    const capped = await t.merges().mergeOnPass(t.node.id, t.trigger);
    expect(capped).toMatchObject({ outcome: "rejected", reason: "guard_failed" });
    expect(capped.failedGuards).toContain("qa_rounds_below_cap");
    expect(t.github.reads).toBe(0);
    await t.store.setCounter(t.node.id, "qa_round", 2, t.clock.now());
    expect(await t.merges().mergeOnPass(t.node.id, t.trigger)).toMatchObject({
      outcome: "applied",
    });
  });
});

describe("a privileged-path PR (unit: M3.3, D-102)", () => {
  const MIGRATION = "db/migrations/0010_merge_check.sql";

  it("opens one gate request for its head and waits; Didi's approval for that head lets it merge", async () => {
    const t = await setup({ paths: ["src/a.ts", MIGRATION] });
    await t.passedOn(HEAD);

    const waiting = await t.merges().mergeOnPass(t.node.id, t.trigger);
    expect(waiting).toMatchObject({
      outcome: "rejected",
      reason: "waiting_for_privileged_path_approval",
      failedGuards: ["privileged_paths_approved"],
    });
    expect(t.github.merges).toEqual([]);
    const gate = await t.store.getGateRequest(waiting.gateRequestId as string);
    expect(gate).toMatchObject({
      kind: "privileged_path",
      owner: "didi",
      status: "open",
      topicKey: privilegedPathTopic(t.node.id),
      nodeId: t.node.id,
      payload: { commitSha: HEAD, repo: REPO, pr: PR, paths: [MIGRATION] },
    });
    // Asking again keeps the same request.
    expect((await t.merges().mergeOnPass(t.node.id, t.trigger)).gateRequestId).toBe(
      gate?.id,
    );

    // Didi approves on the approval page (D-200); the answer carries the guard's scope.
    const library = createLibrary(t.deps);
    const decision = await library.answerGateRequest(
      gate!.id,
      approvalDecision(gate!, {
        choice: "approve",
        words: "yes, merge the migration",
        approvers: ["anonymous"],
      }),
    );
    expect(decision.scope).toMatchObject({ kind: "privileged_path", commitSha: HEAD });

    expect(await t.merges().mergeOnPass(t.node.id, t.trigger)).toMatchObject({
      outcome: "applied",
    });
    expect(t.github.merges).toEqual([{ repo: REPO, number: PR, headSha: HEAD }]);
  });

  it("needs a fresh approval for a new commit, with a new request that names it", async () => {
    const t = await setup({ paths: [MIGRATION] });
    await t.passedOn(HEAD);
    const first = await t.merges().mergeOnPass(t.node.id, t.trigger);
    const gate = (await t.store.getGateRequest(first.gateRequestId as string))!;
    await createLibrary(t.deps).answerGateRequest(
      gate.id,
      approvalDecision(gate, { choice: "approve", words: "ok", approvers: [] }),
    );
    // A new commit lands before the merge; CI and QA pass again on it.
    t.github.pushHead(REPO, PR, NEW);
    await t.passedOn(NEW);

    const again = await t.merges().mergeOnPass(t.node.id, t.trigger);
    expect(again).toMatchObject({
      outcome: "rejected",
      reason: "waiting_for_privileged_path_approval",
    });
    expect(again.gateRequestId).not.toBe(gate.id);
    expect(
      (await t.store.getGateRequest(again.gateRequestId as string))?.payload,
    ).toMatchObject({ commitSha: NEW });
    expect(t.github.merges).toEqual([]);
  });

  it("opens no gate request in dry run", async () => {
    const t = await setup({ paths: [MIGRATION], dryRun: true });
    await t.passedOn(HEAD);
    const result = await t.merges().mergeOnPass(t.node.id, t.trigger);
    expect(result).toMatchObject({ outcome: "rejected", reason: "guard_failed" });
    expect(result.gateRequestId).toBeUndefined();
    expect(await t.store.listOpenGateRequests(t.node.projectId)).toEqual([]);
  });

  it("waits on the design track too (D-218)", async () => {
    const t = await setup({ track: "design", paths: [".github/workflows/deploy.yml"] });
    await t.passedOn(HEAD);
    expect(await t.merges().mergeOnPass(t.node.id, t.trigger)).toMatchObject({
      outcome: "rejected",
      reason: "waiting_for_privileged_path_approval",
    });
    expect(t.github.merges).toEqual([]);
  });

  it("merges a design PR with no privileged path", async () => {
    const t = await setup({ track: "design", paths: ["components/Button.tsx"] });
    await t.passedOn(HEAD);
    expect(await t.merges().mergeOnPass(t.node.id, t.trigger)).toMatchObject({
      outcome: "applied",
    });
  });
});

describe("QA's pass report leads to the merge (unit: src/core/run-reports.ts, M3.3)", () => {
  it("merges and moves the item when the run that reported is QA's pass", async () => {
    const t = await setup();
    const qa = await t.passedOn(HEAD);
    const move = await createRunReports(t.deps).requestReportedMove(qa.id);
    expect(move).toMatchObject({
      requested: true,
      outcome: "applied",
      toState: "verifying_on_staging",
    });
    expect(move.requested && move.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await t.state()).toBe("verifying_on_staging");
    expect(t.github.merges).toHaveLength(1);
    // The run-end flow run again asks for nothing: the node moved since the run started.
    expect(await createRunReports(t.deps).requestReportedMove(qa.id)).toEqual({
      requested: false,
      reason: "state_changed",
    });
    expect(t.github.merges).toHaveLength(1);
  });

  it("keeps the gate request on the result when a pass waits for Didi", async () => {
    const t = await setup({ paths: ["docs/privacy/data-map.yml"] });
    const qa = await t.passedOn(HEAD);
    const move = await createRunReports(t.deps).requestReportedMove(qa.id);
    expect(move).toMatchObject({ requested: true, outcome: "rejected" });
    expect(move.requested && move.gateRequestId).toBeTruthy();
    expect(await t.state()).toBe("in_qa_review");
  });
});

describe("the reconcile pass and the merge (unit: src/core/reconcile.ts, dry run)", () => {
  it("plans the merge move as a dry-run row and records the mergeable state, merging nothing", async () => {
    const t = await setup({ dryRun: true });
    await t.passedOn(HEAD);
    const report = await reconcile(t.deps);
    expect(report.advances.filter((a) => a.nodeId === t.node.id)).toEqual([]);
    expect(report.merges).toMatchObject([
      { nodeId: t.node.id, toState: "verifying_on_staging", outcome: "planned" },
    ]);
    expect(await t.kinds("merge_check")).toHaveLength(1);
    expect(t.github.merges).toEqual([]);
    expect(await t.state()).toBe("in_qa_review");
  });

  it("names the failed guards of an item QA has not passed, and writes no row", async () => {
    const t = await setup({ dryRun: true });
    const report = await reconcile(t.deps);
    expect(report.merges).toMatchObject([{ nodeId: t.node.id, outcome: "rejected" }]);
    expect(await t.transitions(t.node.id)).toEqual([]);
  });
});
