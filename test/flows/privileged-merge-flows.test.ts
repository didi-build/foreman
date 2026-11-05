// Seam: flow, the approval resume step with fake adapters, on the memory store with the real
// contracts and guards. Didi's Approve of a privileged-path request merges the item at once
// through the merge pass's own path (N-82, D-334): the guards decide, the squash merge names the
// approved head, and nothing merges on a Reject, under a switch, or for an older head. Synthetic
// data only.
import { describe, expect, it } from "vitest";

import { run as resume } from "../../flows/approval-resume.ts";
import { privilegedPathTopic } from "../../src/core/merge.ts";
import { NEW, PR, setupMerge } from "../merge-fixture.ts";
import { HEAD, REPO } from "../reconcile-fixture.ts";
import { flowDepsFor } from "./flow-fixture.ts";

const MIGRATION = "db/migrations/0010_merge_check.sql";

/** A privileged-path item QA passed on HEAD, waiting on Didi's request for that head. */
async function waiting() {
  const t = await setupMerge({ paths: ["src/a.ts", MIGRATION] });
  await t.passedOn(HEAD);
  const first = await t.merges().mergeOnPass(t.node.id, t.trigger);
  expect(first).toMatchObject({ reason: "waiting_for_privileged_path_approval" });
  const gateRequestId = first.gateRequestId as string;
  const { deps } = flowDepsFor(t.deps);
  const answer = (decision: "Approve" | "Reject", feedback = "") =>
    resume(deps, {
      gateRequestId,
      resume: { decision, options: [], feedback },
      approvers: ["anonymous"],
    });
  const openRequests = async () =>
    (
      await t.store.listGateRequests(t.projectId, privilegedPathTopic(t.node.id))
    ).filter((g) => g.status === "open");
  return { ...t, gateRequestId, answer, openRequests };
}

describe("Didi's Approve of a privileged-path request merges at once (flow: N-82, D-334)", () => {
  it("merges the approved head through the merge path, once", async () => {
    const t = await waiting();

    const result = await t.answer("Approve");

    expect(result).toMatchObject({
      outcome: "recorded",
      heldBy: null,
      privilegedMerge: { merge: { outcome: "applied", failedGuards: [] } },
    });
    expect(t.github.merges).toEqual([{ repo: REPO, number: PR, headSha: HEAD }]);
    expect(await t.state()).toBe("verifying_on_staging");
    // The merge pass finds nothing left to do: the item has left the merge state.
    const pass = await t.merges().mergeReady();
    expect(pass.filter((r) => r.nodeId === t.node.id)).toEqual([]);
    expect(t.github.merges).toHaveLength(1);
  });

  it("merges nothing on a Reject, and opens no fresh request at once", async () => {
    const t = await waiting();

    const result = await t.answer("Reject", "not this migration");

    expect(result).toMatchObject({ outcome: "recorded" });
    expect(result).not.toHaveProperty("privilegedMerge");
    expect(t.github.merges).toEqual([]);
    expect(await t.state()).toBe("in_qa_review");
    expect(await t.openRequests()).toEqual([]);
  });

  it.each([
    ["kill_switch", true],
    ["dry_run", true],
  ] as const)(
    "merges nothing while %s is on; the merge pass takes it on later",
    async (key, value) => {
      const t = await waiting();
      await t.setting(key, value);

      const result = await t.answer("Approve");

      expect(result).toMatchObject({ outcome: "recorded", heldBy: key });
      expect(result).not.toHaveProperty("privilegedMerge");
      expect(t.github.merges).toEqual([]);
      expect(await t.state()).toBe("in_qa_review");
    },
  );

  it("merges nothing when a new commit landed after the request: the guard needs a fresh approval", async () => {
    const t = await waiting();
    t.github.pushHead(REPO, PR, NEW);
    await t.passedOn(NEW);

    const result = await t.answer("Approve");

    expect(result).toMatchObject({
      outcome: "recorded",
      privilegedMerge: {
        merge: {
          outcome: "rejected",
          reason: "waiting_for_privileged_path_approval",
          failedGuards: ["privileged_paths_approved"],
        },
      },
    });
    expect(t.github.merges).toEqual([]);
    // The merge asked again for the new head, as the merge pass would.
    const [open] = await t.openRequests();
    expect(open?.payload).toMatchObject({ commitSha: NEW });
  });
});
