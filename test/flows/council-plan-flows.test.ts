// Seam: the flows around the Council's own acceptance of a non-product plan (D-307, O-96) with a
// fake agent runtime on the memory store and both machines' real contracts and guards. A scanner
// idea in Submitted gets its Council run from the reconcile flow's Council pass; the run-end flow
// records the Council's plan and takes the plan approval step at once: with Didi not needed, the
// runner accepts the plan as the Council's and Triage starts; with Didi needed or the Council
// unsure, Didi's plan-approval request opens. The planning chat's submission, recorded as the
// state API records it, goes the same way through the plan-approval flow the state API starts,
// and the planning reads say who accepted it. And the switches. And D-316: an idea from a bot's
// out-of-scope finding planned the same way; Didi's Request changes or Reject starting the
// Council's replan at once from the approval resume step, accepted by the Council when Didi is
// not needed (D-315); and the scan's withdrawal cancelling Didi's open plan-approval request. The rules are in
// test/council-plan.test.ts; the API's side of the field is in src/api/planning.test.ts.
import { describe, expect, it } from "vitest";

import { run as resume } from "../../flows/approval-resume.ts";
import { run as planApprovalFlow } from "../../flows/plan-approval.ts";
import { run as reconcileFlow } from "../../flows/reconcile.ts";
import { run as recordRunEnd } from "../../flows/record-run-end.ts";
import { run as scanFlow } from "../../flows/scan.ts";
import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import { generateDailyCheck } from "../../src/core/daily-check.ts";
import { FINDING_SOURCE } from "../../src/core/finding-ideas.ts";
import {
  COUNCIL_FINDING_PLAN_APPROVAL_QUESTION,
  COUNCIL_PLAN_APPROVAL_QUESTION,
  councilPlanTopic,
  createPlanSubmissions,
  planApprovalTopic,
  type NeedsDidi,
} from "../../src/core/plans.ts";
import { createPlanningReads } from "../../src/core/planning-reads.ts";
import { SCAN_CHECKS, type RepoScan } from "../../src/core/scan.ts";
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

/** An idea filed from a QA run's out-of-scope finding, with the body ./finding-ideas.ts writes. */
async function findingIdea(f: FlowFixture): Promise<Node> {
  const item = await f.node("in_qa_review");
  return f.node("submitted", {
    type: "idea",
    track: null,
    ownerRole: "runner",
    agentReady: false,
    title: "Settings page logs the session cookie",
    body: {
      source: FINDING_SOURCE,
      description: "The settings page writes the session cookie to the console.",
      foundBy: { role: "qa", nodeId: item.id, runId: "run-1" },
    },
  });
}

const answerPlanRequest = (
  f: FlowFixture,
  gateRequestId: string,
  decision: string,
  feedback: string,
) =>
  resume(f.deps, {
    gateRequestId,
    resume: { decision, options: [], feedback },
    approvers: ["anonymous"],
  });

describe("the Council plans an idea from a bot's finding (flow: Council pass and run end, D-316 (1))", () => {
  it("the reconcile flow starts its Council run, and with Didi not needed Triage starts", async () => {
    const f = await live();
    const idea = await findingIdea(f);
    const pass = await reconcileFlow(f.deps);
    expect(pass.councilRuns).toMatchObject([
      { topicKey: councilPlanTopic(idea.id), kind: "plan", step: "start" },
    ]);
    const start = f.tasksFor.at(-1);
    expect(start?.input).toContain(
      "A bot's run noticed the bug below outside its own item",
    );
    expect(start?.input).toContain(
      "> The settings page writes the session cookie to the console.",
    );
    const ended = await finish(f, start!.run.id, {
      plan: PLAN,
      productDirection: DIRECTION,
      needsDidi: NOT_NEEDED,
    });
    expect(ended).toMatchObject({
      council: {
        answer: { recorded: true, kind: "plan" },
        plan: { step: "council_accepted", move: { outcome: "applied" } },
      },
    });
    expect(await stateOf(f, idea.id)).toBe("triage");
    expect(await acceptedBy(f, idea.id)).toEqual(["council"]);
  });

  it("with Didi needed opens Didi's request with the finding's own question", async () => {
    const f = await live();
    const idea = await findingIdea(f);
    await reconcileFlow(f.deps);
    await finish(f, f.tasksFor.at(-1)!.run.id, {
      plan: PLAN,
      productDirection: DIRECTION,
      needsDidi: { needed: "yes", reason: "A logging change users may notice." },
    });
    expect(
      await f.store.findOpenGateRequest(f.projectId, planApprovalTopic(idea.id)),
    ).toMatchObject({ payload: { question: COUNCIL_FINDING_PLAN_APPROVAL_QUESTION } });
    expect(await stateOf(f, idea.id)).toBe("submitted");
  });

  it("in dry run or under the kill switch starts no Council run", async () => {
    const f = await live();
    const idea = await findingIdea(f);
    await f.setting("dry_run", true);
    await reconcileFlow(f.deps);
    await f.live();
    await f.killed();
    await reconcileFlow(f.deps);
    expect(f.tasksFor).toEqual([]);
    expect(await f.store.listDecisionsForNode(idea.id)).toEqual([]);
  });
});

describe("Didi sends a Council plan back and the Council replans it (flow: approval resume and run end, D-316 (3), D-315)", () => {
  /** The Council's plan for a scanner idea, with Didi needed, and Didi's open request for it. */
  async function askedDidi(f: FlowFixture) {
    const idea = await scannerIdea(f);
    await reconcileFlow(f.deps);
    await finish(f, f.tasksFor.at(-1)!.run.id, {
      plan: PLAN,
      productDirection: DIRECTION,
      needsDidi: { needed: "yes", reason: "It changes a page users read." },
    });
    const request = await f.store.findOpenGateRequest(
      f.projectId,
      planApprovalTopic(idea.id),
    );
    return { idea, request: request! };
  }

  it("Request changes starts a replan with Didi's words at once; with Didi not needed the Council accepts it and Triage starts", async () => {
    const f = await live();
    const { idea, request } = await askedDidi(f);
    const runs = f.tasksFor.length;
    const answered = await answerPlanRequest(
      f,
      request.id,
      "Request changes",
      "Keep the old link as a redirect.",
    );
    expect(answered).toMatchObject({
      outcome: "recorded",
      plan: {
        step: { step: "returned", move: { outcome: "applied" } },
        triage: [],
        council: [
          {
            topicKey: councilPlanTopic(idea.id),
            kind: "plan",
            step: "start",
            result: { outcome: "started" },
          },
        ],
      },
    });
    expect(await stateOf(f, idea.id)).toBe("council_planning");
    expect(f.tasksFor).toHaveLength(runs + 1);
    const replan = f.tasksFor.at(-1)!;
    expect(replan.run).toMatchObject({ bot: "council", nodeId: idea.id });
    expect(replan.input).toContain("Didi's answer: Request changes.");
    expect(replan.input).toContain("> Keep the old link as a redirect.");
    expect(replan.input).toContain("> Fix the broken link in docs/a.md.");
    const ended = await finish(f, replan.run.id, {
      plan: "Fix the link and keep a redirect from the old one.",
      productDirection: DIRECTION,
      needsDidi: NOT_NEEDED,
    });
    expect(ended).toMatchObject({
      council: {
        answer: { recorded: true, kind: "plan" },
        plan: { step: "council_accepted", move: { outcome: "applied" } },
        triage: [{ ideaId: idea.id, step: "start" }],
      },
    });
    expect(await stateOf(f, idea.id)).toBe("triage");
    expect(await acceptedBy(f, idea.id)).toEqual(["council"]);
    // One replan per answer: a later pass asks the Council nothing more.
    expect((await reconcileFlow(f.deps)).councilRuns).toEqual([]);
  });

  it("Reject with Didi still needed asks Didi again with a fresh request", async () => {
    const f = await live();
    const { idea, request } = await askedDidi(f);
    await answerPlanRequest(f, request.id, "Reject", "Not like this.");
    await finish(f, f.tasksFor.at(-1)!.run.id, {
      plan: "A different plan.",
      productDirection: DIRECTION,
      needsDidi: { needed: "unsure", reason: "May change a page." },
    });
    const fresh = await f.store.findOpenGateRequest(
      f.projectId,
      planApprovalTopic(idea.id),
    );
    expect(fresh).toMatchObject({ payload: { plan: "A different plan." } });
    expect(fresh?.id).not.toBe(request.id);
    expect(await stateOf(f, idea.id)).toBe("council_planning");
  });

  it("in dry run Didi's answer is recorded and no replan starts; once live the reconcile flow starts it", async () => {
    const f = await live();
    const { idea, request } = await askedDidi(f);
    const runs = f.tasksFor.length;
    await f.setting("dry_run", true);
    expect(
      await answerPlanRequest(f, request.id, "Request changes", "Smaller, please."),
    ).toMatchObject({ outcome: "recorded" });
    expect(f.tasksFor).toHaveLength(runs);
    await f.live();
    await f.killed();
    await reconcileFlow(f.deps);
    expect(f.tasksFor).toHaveLength(runs);
    await f.setting("kill_switch", false);
    const pass = await reconcileFlow(f.deps);
    expect(pass.councilRuns).toMatchObject([
      { topicKey: councilPlanTopic(idea.id), kind: "plan", step: "start" },
    ]);
    expect(f.tasksFor.at(-1)?.input).toContain("> Smaller, please.");
  });
});

describe("a scanner idea withdrawn while Didi's plan-approval request is open (flow: scan and approval resume, D-316 (4))", () => {
  it("the scan's withdrawal cancels the request, and Didi's late answer records nothing", async () => {
    const f = await live();
    const counts = Object.fromEntries(
      SCAN_CHECKS.map((c) => [c, 0]),
    ) as RepoScan["counts"];
    const finding = {
      check: "doc_link_missing" as const,
      path: "docs/a.md",
      line: 3,
      target: "docs/gone.md",
    };
    f.repoScans.put(REPO, {
      commitSha: "c".repeat(40),
      counts: { ...counts, doc_link_missing: 1 },
      findings: [finding],
      notRun: [],
    });
    await scanFlow(f.deps);
    const [idea] = (await f.store.listNodes({ projectId: f.projectId })).filter(
      (n) => n.type === "idea",
    );
    await reconcileFlow(f.deps);
    await finish(f, f.tasksFor.at(-1)!.run.id, {
      plan: PLAN,
      productDirection: DIRECTION,
      needsDidi: { needed: "yes", reason: "r" },
    });
    const request = await f.store.findOpenGateRequest(
      f.projectId,
      planApprovalTopic(idea!.id),
    );
    expect(request).not.toBeNull();
    f.advanceMinutes(24 * 60);
    f.repoScans.put(REPO, {
      commitSha: "d".repeat(40),
      counts,
      findings: [],
      notRun: [],
    });
    expect(await scanFlow(f.deps)).toMatchObject({
      projects: [{ withdrawals: [{ nodeId: idea!.id, outcome: "applied" }] }],
    });
    expect(await stateOf(f, idea!.id)).toBe("rejected");
    expect((await f.store.getGateRequest(request!.id))?.status).toBe("cancelled");
    expect(await answerPlanRequest(f, request!.id, "Approve", "")).toEqual({
      outcome: "already_closed",
    });
    expect(await acceptedBy(f, idea!.id)).toEqual([]);
  });
});
