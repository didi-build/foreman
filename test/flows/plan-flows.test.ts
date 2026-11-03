// Seam: the flows around the planning chat's plan (D-266, D-230, D-254) on the memory store with
// both machines' real contracts and guards, a fake repo map port and a fake agent runtime. The
// planning chat's submission is recorded as the state API records it (src/core/plans.ts); the
// reconcile flow's plan approval pass opens Didi's request; the approval resume step records
// Didi's answer and takes the idea's move: Approve into Plan accepted with `plan_accepted`
// recorded by the runner, and Triage starts; Reject or Request changes back to Council planning,
// where a resubmission is asked about again. The API's side is in src/api/planning.test.ts.
import { describe, expect, it } from "vitest";

import { run as resume } from "../../flows/approval-resume.ts";
import { run as planApprovalFlow } from "../../flows/plan-approval.ts";
import { run as reconcileFlow } from "../../flows/reconcile.ts";
import { run as requestTransition } from "../../flows/request-transition.ts";
import { createLibrary } from "../../src/core/library.ts";
import {
  createPlanSubmissions,
  PLAN_APPROVAL_QUESTION,
  planApprovalTopic,
  type PlanSubmission,
} from "../../src/core/plans.ts";
import { createPlanningReads } from "../../src/core/planning-reads.ts";
import type { GateRequest, Node } from "../../src/core/store.ts";
import { MAP_COMMIT, PLAN, REPO_MAP } from "../triage-fixture.ts";
import { REPO } from "../reconcile-fixture.ts";
import { createFlowFixture, type FlowFixture } from "./flow-fixture.ts";

const DIRECTION = "Settings stay on one page. No account changes.";
const ANSWERS = [{ question: "One page or two?", answer: "One page." }];

function ticking(f: FlowFixture) {
  const read = f.clock.now;
  f.clock.now = () => {
    f.advanceMinutes(1 / 60);
    return read();
  };
}

/** A live fixture with the repo map Triage needs. */
async function live(): Promise<FlowFixture> {
  const f = await createFlowFixture();
  ticking(f);
  await f.live();
  f.repoMaps.put(REPO, REPO_MAP);
  return f;
}

/** Records a submission as the state API does for the planning chat. */
async function submit(
  f: FlowFixture,
  change: Partial<PlanSubmission> = {},
): Promise<string> {
  const recorded = await createPlanSubmissions(f.deps).submit({
    projectSlug: "rehearsal",
    ideaId: null,
    title: "Settings page",
    plan: PLAN,
    productDirection: DIRECTION,
    answers: ANSWERS,
    ...change,
  });
  if (!recorded.recorded) throw new Error(`not recorded: ${recorded.reason}`);
  return recorded.ideaId;
}

async function openRequest(f: FlowFixture, ideaId: string): Promise<GateRequest> {
  const request = await f.store.findOpenGateRequest(
    f.projectId,
    planApprovalTopic(ideaId),
  );
  if (!request) throw new Error("no open plan-approval request");
  return request;
}

const answer = (
  f: FlowFixture,
  gateRequestId: string,
  decision: string,
  feedback = "",
) =>
  resume(f.deps, {
    gateRequestId,
    resume: { decision, options: [], feedback },
    approvers: ["anonymous"],
  });

const stateOf = async (f: FlowFixture, id: string) =>
  (await f.store.getNode(id))?.state;

describe("the planning chat's plan reaches Didi (flow, D-266)", () => {
  it("the reconcile flow opens one plan-approval request for Didi, with the plan and no options", async () => {
    const f = await live();
    const ideaId = await submit(f);
    const pass = await reconcileFlow(f.deps);
    expect(pass.plans).toMatchObject([{ ideaId, step: "opened" }]);
    const request = await openRequest(f, ideaId);
    expect(request).toMatchObject({
      nodeId: ideaId,
      kind: "scope",
      owner: "didi",
      blocking: true,
      payload: {
        question: PLAN_APPROVAL_QUESTION,
        title: "Settings page",
        plan: PLAN,
        productDirection: DIRECTION,
        answers: ANSWERS,
        ideaId,
      },
    });
    expect((request.payload as { options?: unknown }).options).toBeUndefined();
    // Nothing moved, and nothing is accepted yet.
    expect(await stateOf(f, ideaId)).toBe("submitted");
    expect(
      (await f.store.listDecisionsForNode(ideaId)).some(
        (d) => d.kind === "council_decision",
      ),
    ).toBe(false);
    // A second pass opens nothing more.
    const before = await f.footprint(ideaId);
    expect((await reconcileFlow(f.deps)).plans).toMatchObject([
      { ideaId, step: "waiting" },
    ]);
    expect(await f.footprint(ideaId)).toBe(before);
  });

  it("in dry run or under the kill switch opens nothing", async () => {
    const f = await live();
    const ideaId = await submit(f);
    await f.setting("dry_run", true);
    await reconcileFlow(f.deps);
    await f.live();
    await f.killed();
    await reconcileFlow(f.deps);
    expect(
      await f.store.findOpenGateRequest(f.projectId, planApprovalTopic(ideaId)),
    ).toBe(null);
  });
});

describe("the plan-approval flow the state API starts (flow, D-273 (2), D-274)", () => {
  it("opens Didi's request at once; a repeat and the reconcile pass open nothing more", async () => {
    const f = await live();
    const ideaId = await submit(f);
    const step = await planApprovalFlow(f.deps, { ideaId });
    expect(step).toMatchObject({ ideaId, step: "opened" });
    const request = await openRequest(f, ideaId);
    expect(request).toMatchObject({ nodeId: ideaId, payload: { plan: PLAN, ideaId } });
    const before = await f.footprint(ideaId);
    expect(await planApprovalFlow(f.deps, { ideaId })).toEqual({
      ideaId,
      step: "waiting",
    });
    expect((await reconcileFlow(f.deps)).plans).toMatchObject([
      { ideaId, step: "waiting" },
    ]);
    expect(await f.footprint(ideaId)).toBe(before);
  });

  it("when the start never came, the reconcile pass opens the request as the safety net", async () => {
    const f = await live();
    const ideaId = await submit(f);
    expect((await reconcileFlow(f.deps)).plans).toMatchObject([
      { ideaId, step: "opened" },
    ]);
    expect(await planApprovalFlow(f.deps, { ideaId })).toMatchObject({
      step: "waiting",
    });
  });

  it("in dry run or under the kill switch opens nothing, and an unknown idea is refused", async () => {
    const f = await live();
    const ideaId = await submit(f);
    await f.setting("dry_run", true);
    expect(await planApprovalFlow(f.deps, { ideaId })).toMatchObject({
      step: "dry_run",
    });
    await f.live();
    await f.killed();
    expect(await planApprovalFlow(f.deps, { ideaId })).toMatchObject({
      step: "kill_switch",
    });
    expect(
      await f.store.findOpenGateRequest(f.projectId, planApprovalTopic(ideaId)),
    ).toBe(null);
    expect(
      await planApprovalFlow(f.deps, {
        ideaId: "00000000-0000-4000-8000-00000000ffff",
      }),
    ).toMatchObject({ step: "no_idea" });
  });
});

describe("Didi's Approve accepts the plan (flow, D-266, D-230)", () => {
  it("moves the idea into Plan accepted, records plan_accepted as the runner, and starts Triage", async () => {
    const f = await live();
    const ideaId = await submit(f);
    await reconcileFlow(f.deps);
    const request = await openRequest(f, ideaId);
    // Approve needs no feedback on a plan approval (D-254).
    const approved = await answer(f, request.id, "Approve");
    expect(approved).toMatchObject({
      outcome: "recorded",
      plan: {
        step: { ideaId, step: "accepted", move: { outcome: "applied" } },
        triage: [{ ideaId, step: "start", result: { outcome: "started" } }],
      },
    });
    expect(await stateOf(f, ideaId)).toBe("triage");
    const moves = await f.store.listTransitions(ideaId);
    expect(moves.map((t) => [t.fromState, t.toState, t.actorKind])).toEqual([
      ["submitted", "plan_accepted", "runner"],
      ["plan_accepted", "triage", "runner"],
    ]);
    const accepted = (await f.store.listDecisionsForNode(ideaId)).filter(
      (d) => d.kind === "council_decision",
    );
    expect(accepted).toMatchObject([
      {
        textVerbatim: PLAN,
        scope: {
          kind: "plan_accepted",
          topicKey: planApprovalTopic(ideaId),
          gateRequestId: request.id,
          recordedBy: "runner",
        },
      },
    ]);
    // Triage's run is given the plan Didi approved, verbatim.
    const start = f.tasksFor.at(-1);
    expect(start?.run).toMatchObject({
      bot: "triage",
      nodeId: ideaId,
      headSha: MAP_COMMIT,
    });
    expect(start?.input).toContain("> Plan: a settings page for the rehearsal app.");

    // A repeated answer records nothing, and the pass has nothing left to do.
    const before = await f.footprint(ideaId);
    expect(await answer(f, request.id, "Approve")).toEqual({
      outcome: "already_closed",
    });
    expect((await reconcileFlow(f.deps)).plans).toEqual([]);
    expect(await f.footprint(ideaId)).toBe(before);
  });

  it("is a runner-only move: the transition flow cannot take it, even after Didi's Approve", async () => {
    const f = await live();
    const ideaId = await submit(f);
    await reconcileFlow(f.deps);
    await f.setting("dry_run", true);
    const request = await openRequest(f, ideaId);
    expect(await answer(f, request.id, "Approve")).toMatchObject({
      outcome: "recorded",
      heldBy: "dry_run",
      plan: {
        step: { step: "accepted", move: { outcome: "refused", reason: "dry_run" } },
      },
    });
    await f.live();
    const asked = await requestTransition(f.deps, {
      nodeId: ideaId,
      toState: "plan_accepted",
      trigger: { kind: "human", ref: "someone" },
      actor: { kind: "operator", id: "someone" },
    });
    expect(asked).toMatchObject({ outcome: "rejected", reason: "runner_only_move" });
    expect(await stateOf(f, ideaId)).toBe("submitted");
    // The reconcile flow's pass takes it once the runner is live.
    expect((await reconcileFlow(f.deps)).plans).toMatchObject([
      { ideaId, step: "accepted", move: { outcome: "applied" } },
    ]);
    expect(await stateOf(f, ideaId)).toBe("triage");
  });

  it("an approval of an older plan does not accept a newer one", async () => {
    const f = await live();
    const ideaId = await submit(f);
    await reconcileFlow(f.deps);
    await f.setting("dry_run", true);
    const first = await openRequest(f, ideaId);
    await answer(f, first.id, "Approve");
    // The chat sends a new plan before the runner acted on the answer.
    await submit(f, { ideaId, plan: "Plan, second version." });
    await f.live();
    expect((await reconcileFlow(f.deps)).plans).toMatchObject([
      { ideaId, step: "opened" },
    ]);
    expect(await stateOf(f, ideaId)).toBe("submitted");
    const second = await openRequest(f, ideaId);
    expect(second.payload).toMatchObject({ plan: "Plan, second version." });
    await answer(f, second.id, "Approve");
    const accepted = (await f.store.listDecisionsForNode(ideaId)).filter(
      (d) => d.kind === "council_decision",
    );
    expect(accepted.map((d) => d.textVerbatim)).toEqual(["Plan, second version."]);
  });
});

describe("Didi's Reject or Request changes sends the plan back (flow, D-266, D-254)", () => {
  it("moves the idea to Council planning with Didi's words, and a resubmission is asked about again", async () => {
    const f = await live();
    const ideaId = await submit(f);
    await reconcileFlow(f.deps);
    const first = await openRequest(f, ideaId);
    // Feedback is required (D-254): with none, nothing is recorded and a fresh request opens.
    const reopened = await answer(f, first.id, "Reject");
    expect(reopened).toMatchObject({ outcome: "reopened" });
    const fresh = await openRequest(f, ideaId);
    const words = "Too big.\nSplit the settings page from the account page.";
    expect(await answer(f, fresh.id, "Reject", words)).toMatchObject({
      outcome: "recorded",
      plan: {
        step: { ideaId, step: "returned", move: { outcome: "applied" } },
        triage: [],
      },
    });
    expect(await stateOf(f, ideaId)).toBe("council_planning");
    expect(
      (await f.store.listDecisionsForNode(ideaId)).find((d) => d.kind === "answer"),
    ).toMatchObject({
      byActor: "didi",
      textVerbatim: words,
      scope: { outcome: "rejected", topicKey: planApprovalTopic(ideaId) },
    });
    expect(
      (await f.store.listDecisionsForNode(ideaId)).some(
        (d) => d.kind === "council_decision",
      ),
    ).toBe(false);
    // Nothing more while the chat has not resubmitted.
    const before = await f.footprint(ideaId);
    expect((await reconcileFlow(f.deps)).plans).toMatchObject([
      { ideaId, step: "kept_in_planning" },
    ]);
    expect(await f.footprint(ideaId)).toBe(before);

    // The resubmission gets a new request; Request changes keeps the idea in Council planning.
    await submit(f, { ideaId, plan: "Plan, second version." });
    expect((await reconcileFlow(f.deps)).plans).toMatchObject([
      { ideaId, step: "opened" },
    ]);
    const second = await openRequest(f, ideaId);
    expect(
      await answer(f, second.id, "Request changes", "Name the settings."),
    ).toMatchObject({ plan: { step: { step: "kept_in_planning" } } });
    expect(await stateOf(f, ideaId)).toBe("council_planning");

    // The third plan is approved: Council planning to Plan accepted, then Triage.
    await submit(f, { ideaId, plan: "Plan, third version." });
    await reconcileFlow(f.deps);
    const third = await openRequest(f, ideaId);
    expect(await answer(f, third.id, "Approve")).toMatchObject({
      plan: { step: { step: "accepted", move: { outcome: "applied" } } },
    });
    expect(await stateOf(f, ideaId)).toBe("triage");
    const accepted = (await f.store.listDecisionsForNode(ideaId)).filter(
      (d) => d.kind === "council_decision",
    );
    expect(accepted.map((d) => d.textVerbatim)).toEqual(["Plan, third version."]);
  });

  it("a newer submission supersedes an open request, whose page then records nothing", async () => {
    const f = await live();
    const ideaId = await submit(f);
    await reconcileFlow(f.deps);
    const first = await openRequest(f, ideaId);
    await submit(f, { ideaId, plan: "Plan, second version." });
    await reconcileFlow(f.deps);
    expect((await f.store.getGateRequest(first.id))?.status).toBe("superseded");
    expect(await answer(f, first.id, "Approve")).toEqual({ outcome: "already_closed" });
    expect(await stateOf(f, ideaId)).toBe("submitted");
  });
});

describe("only the runner records plan_accepted (flow, D-230)", () => {
  it("an idea whose plan Didi has not approved does not reach Plan accepted or Triage", async () => {
    const f = await live();
    const ideaId = await submit(f);
    const library = createLibrary(f.deps);
    const node = (await f.store.getNode(ideaId)) as Node;
    const check = await library.checkTransition({
      nodeId: node.id,
      toState: "plan_accepted",
      trigger: { kind: "event", ref: "x" },
      actor: { kind: "runner", id: "test" },
      runnerOnly: true,
    });
    expect(check.guardReport.find((c) => !c.pass)).toMatchObject({
      name: "plan_approval_recorded",
    });
    await reconcileFlow(f.deps);
    expect(await stateOf(f, ideaId)).toBe("submitted");
    expect(await f.store.listRuns({ nodeId: ideaId })).toEqual([]);
  });
});

describe("the planning chat's reads follow Didi's real answers (flow, D-273 (3))", () => {
  it("shows an approved plan as approved and accepted, with its direction", async () => {
    const f = await live();
    const ideaId = await submit(f);
    const reads = createPlanningReads(f.store);
    await planApprovalFlow(f.deps, { ideaId });
    expect(await reads.submissions(f.projectId)).toMatchObject([
      { ideaId, status: "waiting" },
    ]);
    await answer(f, (await openRequest(f, ideaId)).id, "Approve");
    expect(await reads.submissions(f.projectId)).toMatchObject([
      { ideaId, status: "approved" },
    ]);
    expect(await reads.accepted(f.projectId)).toMatchObject([
      { ideaId, plan: PLAN, productDirection: DIRECTION },
    ]);
    expect(await reads.feedback(f.projectId)).toEqual([]);
  });

  it("shows a plan sent back with Didi's words verbatim, and a resubmission as waiting", async () => {
    const f = await live();
    const ideaId = await submit(f);
    const reads = createPlanningReads(f.store);
    await planApprovalFlow(f.deps, { ideaId });
    const words = "Split it in two.\nKeep the first part small.";
    await answer(f, (await openRequest(f, ideaId)).id, "Request changes", words);
    expect(await reads.submissions(f.projectId)).toMatchObject([
      { ideaId, status: "sent_back" },
    ]);
    expect(await reads.feedback(f.projectId)).toMatchObject([
      { ideaId, outcome: "changes_requested", feedback: words },
    ]);
    await submit(f, { ideaId, plan: "Plan, second version." });
    expect(await reads.submissions(f.projectId)).toMatchObject([
      { ideaId, status: "waiting" },
    ]);
    // The earlier feedback stays readable.
    expect(await reads.feedback(f.projectId)).toHaveLength(1);
    expect(await reads.accepted(f.projectId)).toEqual([]);
  });
});
