// Seam: the flows around the Council's own acceptance of a non-product plan (D-307, O-96) with a
// fake agent runtime on the memory store and both machines' real contracts and guards. A scanner
// idea in Submitted gets its Council run from the reconcile flow's Council pass; the run-end flow
// records the Council's plan and takes the plan approval step at once: with Didi not needed, the
// runner accepts the plan as the Council's and Triage starts; with Didi needed or the Council
// unsure, Didi's plan-approval request opens. The planning chat's submission, recorded as the
// state API records it, goes the same way through the plan-approval flow the state API starts,
// and the planning reads say who accepted it. And the switches. The rules are in
// test/council-plan.test.ts; the API's side of the field is in src/api/planning.test.ts.
import { describe, expect, it } from "vitest";

import { run as planApprovalFlow } from "../../flows/plan-approval.ts";
import { run as reconcileFlow } from "../../flows/reconcile.ts";
import { run as recordRunEnd } from "../../flows/record-run-end.ts";
import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import { generateDailyCheck } from "../../src/core/daily-check.ts";
import {
  COUNCIL_PLAN_APPROVAL_QUESTION,
  councilPlanTopic,
  createPlanSubmissions,
  planApprovalTopic,
  type NeedsDidi,
} from "../../src/core/plans.ts";
import { createPlanningReads } from "../../src/core/planning-reads.ts";
import type { Node } from "../../src/core/store.ts";
import { REPO } from "../reconcile-fixture.ts";
import { MAP_COMMIT, REPO_MAP } from "../triage-fixture.ts";
import { createFlowFixture, type FlowFixture } from "./flow-fixture.ts";

const RESULT: AgentRunResult = {
  outcome: "success",
  detail: "done",
  finalText: "never stored",
  turns: 3,
  costUsd: 0.1,
  minutes: 2,
  tokens: { uncachedInput: 100, cachedInput: 900, output: 50 },
  model: "claude-sonnet-5-5",
};
const PLAN =
  "Fix the broken link in docs/a.md.\nPoint it at docs/b.md and run the link check.";
const DIRECTION = "No change to the product: a docs fix.";
const NOT_NEEDED: NeedsDidi = {
  needed: "no",
  reason: "A docs link; nothing a user sees.",
};

function ticking(f: FlowFixture) {
  const read = f.clock.now;
  f.clock.now = () => {
    f.advanceMinutes(1 / 60);
    return read();
  };
}

async function live(): Promise<FlowFixture> {
  const f = await createFlowFixture();
  ticking(f);
  await f.live();
  f.repoMaps.put(REPO, REPO_MAP);
  return f;
}

const scannerIdea = (f: FlowFixture): Promise<Node> =>
  f.node("submitted", {
    type: "idea",
    track: null,
    ownerRole: "runner",
    agentReady: false,
    title: "Broken link in docs/a.md",
    body: {
      source: "scanner",
      description: "docs/a.md links docs/gone.md, which does not exist.",
      class: "drift",
      check: "doc_link_missing",
      evidence: [{ path: "docs/a.md", line: 3 }],
      confidence: 1,
      dedupeKey: "scanner:doc_link_missing:docs/a.md -> docs/gone.md",
      foundBy: { scanner: "fixed-checks", commitSha: "c".repeat(40) },
    },
  });

function finish(f: FlowFixture, runId: string, structured: unknown) {
  f.runtime.status.set(runId, { state: "finished", result: { ...RESULT, structured } });
  return recordRunEnd(f.deps, { runId });
}

const stateOf = async (f: FlowFixture, id: string) =>
  (await f.store.getNode(id))?.state;

const acceptedBy = async (f: FlowFixture, ideaId: string) =>
  (await f.store.listDecisionsForNode(ideaId))
    .filter(
      (d) =>
        d.kind === "council_decision" &&
        (d.scope as Record<string, unknown>).kind === "plan_accepted",
    )
    .map((d) => (d.scope as Record<string, unknown>).acceptedBy);

describe("the Council plans a scanner idea and accepts it itself (flow: Council pass and run end, D-307)", () => {
  it("the reconcile flow starts the Council's run; its answer with Didi not needed moves the idea to Triage", async () => {
    const f = await live();
    const idea = await scannerIdea(f);
    const pass = await reconcileFlow(f.deps);
    expect(pass.councilRuns).toMatchObject([
      {
        topicKey: councilPlanTopic(idea.id),
        kind: "plan",
        step: "start",
        result: { outcome: "started" },
      },
    ]);
    const start = f.tasksFor.at(-1);
    expect(start?.run).toMatchObject({ bot: "council", nodeId: idea.id });
    expect(start?.input).toContain("Write the plan for its work");

    const ended = await finish(f, start!.run.id, {
      plan: PLAN,
      productDirection: DIRECTION,
      needsDidi: NOT_NEEDED,
    });
    expect(ended).toMatchObject({
      council: {
        answer: { recorded: true, kind: "plan" },
        plan: { step: "council_accepted", move: { outcome: "applied" } },
        triage: [{ ideaId: idea.id, step: "start", result: { outcome: "started" } }],
      },
    });
    expect(await stateOf(f, idea.id)).toBe("triage");
    expect(await acceptedBy(f, idea.id)).toEqual(["council"]);
    expect(
      await f.store.listGateRequests(f.projectId, planApprovalTopic(idea.id)),
    ).toEqual([]);
    // Triage's run is given the Council's plan, verbatim.
    const triage = f.tasksFor.at(-1);
    expect(triage?.run).toMatchObject({
      bot: "triage",
      nodeId: idea.id,
      headSha: MAP_COMMIT,
    });
    expect(triage?.input).toContain("> Fix the broken link in docs/a.md.");
    // The daily check lists it, read only.
    f.advanceMinutes(1);
    const check = await generateDailyCheck(f.deps, {
      holdReleaseRequestFlow: "f/foreman/hold_release_request",
    });
    expect(
      check.projects.find((p) => p.projectId === f.projectId)?.councilAccepted,
    ).toMatchObject([{ nodeId: idea.id, reason: NOT_NEEDED.reason }]);
    // A second pass asks the Council nothing more.
    expect((await reconcileFlow(f.deps)).councilRuns).toEqual([]);
  });

  it("an unsure answer opens Didi's plan-approval request with the Council's plan, and nothing moves", async () => {
    const f = await live();
    const idea = await scannerIdea(f);
    await reconcileFlow(f.deps);
    const start = f.tasksFor.at(-1);
    const ended = await finish(f, start!.run.id, {
      plan: PLAN,
      productDirection: DIRECTION,
      needsDidi: { needed: "unsure", reason: "It might change what users read." },
    });
    expect(ended).toMatchObject({ council: { plan: { step: "opened" } } });
    expect(
      await f.store.findOpenGateRequest(f.projectId, planApprovalTopic(idea.id)),
    ).toMatchObject({
      owner: "didi",
      blocking: true,
      payload: { question: COUNCIL_PLAN_APPROVAL_QUESTION, plan: PLAN },
    });
    expect(await stateOf(f, idea.id)).toBe("submitted");
    expect(await acceptedBy(f, idea.id)).toEqual([]);
  });

  it("in dry run or under the kill switch starts no Council run and accepts nothing", async () => {
    const f = await live();
    const idea = await scannerIdea(f);
    await f.setting("dry_run", true);
    await reconcileFlow(f.deps);
    await f.live();
    await f.killed();
    await reconcileFlow(f.deps);
    expect(f.tasksFor).toEqual([]);
    expect(await stateOf(f, idea.id)).toBe("submitted");
    expect(await f.store.listDecisionsForNode(idea.id)).toEqual([]);
  });
});

describe("the planning chat's plan with Didi not needed (flow: the submission and the plan-approval flow, D-307)", () => {
  const submit = async (
    f: FlowFixture,
    needsDidi: NeedsDidi,
    title = "Rename a setting",
  ) => {
    const recorded = await createPlanSubmissions(f.deps).submit({
      projectSlug: "rehearsal",
      ideaId: null,
      title,
      plan: PLAN,
      productDirection: DIRECTION,
      answers: [],
      needsDidi,
    });
    if (!recorded.recorded) throw new Error(`not recorded: ${recorded.reason}`);
    return recorded.ideaId;
  };

  it("is accepted as the Council's at once, with no request, and Triage starts; the reads say who accepted it", async () => {
    const f = await live();
    const ideaId = await submit(f, NOT_NEEDED);
    expect(await planApprovalFlow(f.deps, { ideaId })).toMatchObject({
      ideaId,
      step: "council_accepted",
      move: { outcome: "applied" },
      triage: [{ ideaId, step: "start", result: { outcome: "started" } }],
    });
    expect(await stateOf(f, ideaId)).toBe("triage");
    expect(await acceptedBy(f, ideaId)).toEqual(["council"]);
    expect(
      await f.store.listGateRequests(f.projectId, planApprovalTopic(ideaId)),
    ).toEqual([]);
    const reads = createPlanningReads(f.store);
    expect(await reads.submissions(f.projectId)).toMatchObject([
      { ideaId, status: "accepted_by_council" },
    ]);
    expect(await reads.accepted(f.projectId)).toMatchObject([
      {
        ideaId,
        acceptedBy: "council",
        productDirection: {
          label: "submitted with a plan the Council accepted, not approved by Didi",
        },
      },
    ]);
    // A repeat and the reconcile pass do nothing more.
    expect(await planApprovalFlow(f.deps, { ideaId })).toMatchObject({
      step: "not_planning",
    });
    expect((await reconcileFlow(f.deps)).plans).toEqual([]);
  });

  it("with Didi needed opens Didi's request as before", async () => {
    const f = await live();
    const ideaId = await submit(f, { needed: "yes", reason: "A new page." });
    expect(await planApprovalFlow(f.deps, { ideaId })).toMatchObject({
      step: "opened",
    });
    expect(await stateOf(f, ideaId)).toBe("submitted");
  });

  it("in dry run or under the kill switch accepts nothing; the reconcile pass takes it once live", async () => {
    const f = await live();
    const ideaId = await submit(f, NOT_NEEDED);
    await f.setting("dry_run", true);
    expect(await planApprovalFlow(f.deps, { ideaId })).toMatchObject({
      step: "dry_run",
    });
    await f.live();
    await f.killed();
    expect(await planApprovalFlow(f.deps, { ideaId })).toMatchObject({
      step: "kill_switch",
    });
    expect(await stateOf(f, ideaId)).toBe("submitted");
    await f.setting("kill_switch", false);
    expect((await reconcileFlow(f.deps)).plans).toMatchObject([
      { ideaId, step: "council_accepted", move: { outcome: "applied" } },
    ]);
    expect(await stateOf(f, ideaId)).toBe("triage");
  });
});
