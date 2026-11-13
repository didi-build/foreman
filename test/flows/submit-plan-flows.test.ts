// Seam: the called flow `f/foreman/submit_plan`, Didi's form to submit a plan by hand (flow,
// D-383, O-129), on the memory store with both machines' real contracts and guards, a fake repo
// map port and a fake agent runtime. The form takes exactly what `POST /plans` takes: every body
// `readPlanSubmission` refuses, and one over the state API's body cap, is refused with the same
// sentence and writes nothing. It records a new idea and a resubmission through the same core
// code, by the planning chat's identity, and then takes the plan approval step in its own run:
// the store ends exactly as after the API's record and the plan-approval flow it starts. Under
// either switch it records the submission and takes no step, as the API starts no flow then
// (D-333); a step that throws leaves the submission standing for the reconcile pass. Its result
// echoes none of the submission's texts. Synthetic data only; nothing reaches Windmill or GitHub.
// The API's side is in src/api/planning.test.ts; the step's rules in test/flows/plan-flows.test.ts
// and test/flows/council-plan-flows.test.ts.
import { describe, expect, it } from "vitest";

import { run as planApprovalFlow } from "../../flows/plan-approval.ts";
import { run as reconcileFlow } from "../../flows/reconcile.ts";
import { run as submitPlanForm } from "../../flows/submit-plan.ts";
import {
  PLANS_BODY_MAX_BYTES,
  SUBMIT_PLAN_MESSAGES,
  type SubmitPlanFields,
  type SubmitPlanResult,
} from "../../flows/lib/submit-plan.ts";
import { MAX_BODY_BYTES } from "../../src/api/routes.ts";
import {
  createPlanSubmissions,
  PLAN_LIMITS,
  PLAN_SUBMISSION_KIND,
  planApprovalTopic,
  readPlanSubmission,
  SUBMIT_REFUSAL_MESSAGES,
} from "../../src/core/plans.ts";
import type { Node } from "../../src/core/store.ts";
import { REPO } from "../reconcile-fixture.ts";
import { REPO_MAP } from "../triage-fixture.ts";
import { createFlowFixture, type FlowFixture } from "./flow-fixture.ts";

const TITLE = "Export settings as a file";
const PLAN =
  "Add an export button to the settings page.\nIt saves the settings as a JSON file.";
const DIRECTION = "Settings stay on one page. No account changes.";
const ANSWERS = [{ question: "Which file format?", answer: "JSON,\nfor now." }];
const REASON = "It adds a button that users see.";

/** Didi's boxes, filled from the Claude project's output, for a new idea. */
const FIELDS: SubmitPlanFields = {
  projectSlug: "rehearsal",
  title: TITLE,
  plan: PLAN,
  productDirection: DIRECTION,
  needsDidi: "yes",
  needsDidiReason: REASON,
  answers: ANSWERS,
  ideaId: "",
};

/** The same submission as the planning chat sends it to `POST /plans`. */
const CHAT_BODY: Record<string, unknown> = {
  projectSlug: "rehearsal",
  title: TITLE,
  plan: PLAN,
  productDirection: DIRECTION,
  answers: ANSWERS,
  needsDidi: { needed: "yes", reason: REASON },
};

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

/** Everything the form could have written in the project. */
async function everything(f: FlowFixture): Promise<string> {
  const nodes = await f.store.listNodes({ projectId: f.projectId });
  const each = <T>(read: (node: Node) => Promise<T>) => Promise.all(nodes.map(read));
  return JSON.stringify({
    nodes,
    decisions: await each((n) => f.store.listDecisionsForNode(n.id)),
    evidence: await each((n) => f.store.listEvidence({ nodeId: n.id })),
    transitions: await each((n) => f.store.listTransitions(n.id)),
    runs: await each((n) => f.store.listRuns({ nodeId: n.id })),
    gates: await each((n) =>
      f.store.listGateRequests(f.projectId, planApprovalTopic(n.id)),
    ),
  });
}

/** No text from the submission comes back in the result. */
function expectNoEcho(result: SubmitPlanResult) {
  const shown = JSON.stringify(result);
  for (const text of [
    TITLE,
    PLAN,
    DIRECTION,
    REASON,
    ...ANSWERS.flatMap((a) => [a.question, a.answer]),
  ]) {
    expect(shown).not.toContain(text);
  }
}

const recorded = (result: SubmitPlanResult) => {
  if (result.outcome !== "recorded") throw new Error(`not recorded: ${result.reason}`);
  return result;
};

const ideaIn = (f: FlowFixture, state: string, title = "Export settings") =>
  f.node(state, {
    type: "idea",
    track: null,
    ownerRole: "runner",
    agentReady: false,
    title,
  });

describe("the form takes exactly what POST /plans takes (flow, D-383)", () => {
  const long = (n: number) => "x".repeat(n);
  it.each([
    ["a project slug that is not a slug", { projectSlug: "Not a slug" }, null],
    ["an empty project slug", { projectSlug: "" }, null],
    ["an empty title", { title: "" }, null],
    ["a title on two lines", { title: "Export\nsettings" }, null],
    ["a title over its bound", { title: long(PLAN_LIMITS.titleChars + 1) }, null],
    ["an empty plan", { plan: "" }, null],
    ["a blank plan", { plan: "  \n " }, null],
    ["a plan over its bound", { plan: long(PLAN_LIMITS.planChars + 1) }, null],
    ["an empty product direction", { productDirection: "" }, null],
    [
      "a product direction over its bound",
      { productDirection: long(PLAN_LIMITS.directionChars + 1) },
      null,
    ],
    [
      "too many answers",
      { answers: Array(PLAN_LIMITS.answers + 1).fill({ question: "q", answer: "a" }) },
      null,
    ],
    [
      "an answer with an extra field",
      { answers: [{ question: "q", answer: "a", by: "x" }] as never },
      null,
    ],
    [
      "an answer with a blank answer",
      { answers: [{ question: "q", answer: " " }] },
      null,
    ],
    [
      "an answer over its bound",
      { answers: [{ question: "q", answer: long(PLAN_LIMITS.answerChars + 1) }] },
      null,
    ],
    ["answers that are not a list", { answers: "Which file format?" as never }, null],
    ["a malformed idea id", { ideaId: "not-an-id" }, null],
    ["an idea id of spaces", { ideaId: " " }, null],
    [
      "a call outside yes, no and unsure",
      { needsDidi: "maybe" },
      { needsDidi: { needed: "maybe", reason: REASON } },
    ],
    [
      "a call in capitals",
      { needsDidi: "Yes" },
      { needsDidi: { needed: "Yes", reason: REASON } },
    ],
    ["an empty call", { needsDidi: "" }, { needsDidi: { needed: "", reason: REASON } }],
    [
      "a blank reason",
      { needsDidiReason: " " },
      { needsDidi: { needed: "yes", reason: " " } },
    ],
    [
      "a reason over its bound",
      { needsDidiReason: long(PLAN_LIMITS.needsDidiReasonChars + 1) },
      {
        needsDidi: {
          needed: "yes",
          reason: long(PLAN_LIMITS.needsDidiReasonChars + 1),
        },
      },
    ],
  ] as const)(
    "refuses %s with POST /plans' sentence and writes nothing",
    async (_label, change, chatChange) => {
      const f = await live();
      const before = await everything(f);
      // The planning chat's body for the same boxes: the same change, or the call it makes.
      const chat = readPlanSubmission({ ...CHAT_BODY, ...(chatChange ?? change) });
      if (!("problem" in chat)) throw new Error("POST /plans takes this body");
      const result = await submitPlanForm(f.deps, { ...FIELDS, ...change });
      expect(result).toEqual({
        outcome: "refused",
        reason: "invalid_submission",
        message: chat.problem,
      });
      expectNoEcho(result);
      expect(await everything(f)).toBe(before);
    },
  );

  it.each([
    [
      "a title of exactly its bound",
      { title: "t".repeat(PLAN_LIMITS.titleChars) },
      null,
    ],
    ["a plan of exactly its bound", { plan: "p".repeat(PLAN_LIMITS.planChars) }, null],
    [
      "exactly the most answers",
      { answers: Array(PLAN_LIMITS.answers).fill({ question: "q", answer: "a" }) },
      null,
    ],
    ["no answers", { answers: [] }, null],
    ["answers left out", { answers: null }, null],
    ["an idea id left out", { ideaId: null }, null],
    [
      "the call unsure",
      { needsDidi: "unsure" },
      { needsDidi: { needed: "unsure", reason: REASON } },
    ],
  ] as const)("records %s, as POST /plans does", async (_label, change, chatChange) => {
    expect(
      readPlanSubmission({ ...CHAT_BODY, ...(chatChange ?? change) }),
    ).toHaveProperty("submission");
    const f = await live();
    const result = recorded(await submitPlanForm(f.deps, { ...FIELDS, ...change }));
    expect(result.created).toBe(true);
    expect((await f.store.getNode(result.ideaId))?.state).toBe("submitted");
  });

  it("refuses a body over the state API's cap with a fixed sentence, and takes one of exactly the cap", async () => {
    expect(PLANS_BODY_MAX_BYTES).toBe(MAX_BODY_BYTES);
    const answers = Array(6).fill({ question: "q", answer: "a".repeat(4_000) });
    const productDirection = "d".repeat(PLAN_LIMITS.directionChars);
    // The plan that makes the planning chat's compact JSON body exactly the cap.
    const bytes = (plan: string) =>
      new TextEncoder().encode(
        JSON.stringify({ ...CHAT_BODY, plan, productDirection, answers }),
      ).byteLength;
    const fill = MAX_BODY_BYTES - bytes("");
    expect(fill).toBeLessThanOrEqual(PLAN_LIMITS.planChars);
    const atCap = { ...FIELDS, productDirection, answers, plan: "p".repeat(fill) };
    expect(bytes(atCap.plan)).toBe(MAX_BODY_BYTES);

    const f = await live();
    const before = await everything(f);
    const over = await submitPlanForm(f.deps, { ...atCap, plan: `${atCap.plan}p` });
    expect(over).toEqual({
      outcome: "refused",
      reason: "too_large",
      message: SUBMIT_PLAN_MESSAGES.too_large,
    });
    expect(await everything(f)).toBe(before);
    // A character of two bytes counts as two, as the API counts the body's bytes.
    const twoBytes = { ...atCap, plan: `${atCap.plan.slice(1)}é` };
    expect(await submitPlanForm(f.deps, twoBytes)).toMatchObject({
      reason: "too_large",
    });
    expect(await everything(f)).toBe(before);
    expect(recorded(await submitPlanForm(f.deps, atCap)).created).toBe(true);
  });

  it("refuses an unknown project, an unknown idea, another project's idea and one past planning with the API's sentences, writing nothing", async () => {
    const f = await live();
    await f.store.insertProject({
      id: "50000000-0000-4000-8000-0000000000f1",
      slug: "other",
      name: "Other",
      repo: "didi-build/other",
      linearProjectId: null,
      galleryPathOverride: null,
      privilegedPathsExtra: [],
      prodRequiresApproval: false,
      stagingUrl: null,
      createdAt: f.clock.now(),
    });
    const accepted = await ideaIn(f, "plan_accepted");
    const before = await everything(f);
    const cases = [
      [{ projectSlug: "nowhere" }, "no_project"],
      [{ ideaId: "50000000-0000-4000-8000-0000000000e1" }, "no_idea"],
      [{ projectSlug: "other", ideaId: accepted.id }, "no_idea"],
      [{ ideaId: accepted.id }, "not_submittable"],
    ] as const;
    for (const [change, reason] of cases) {
      const result = await submitPlanForm(f.deps, { ...FIELDS, ...change });
      expect(result, reason).toEqual({
        outcome: "refused",
        reason,
        message: SUBMIT_REFUSAL_MESSAGES[reason],
      });
      expectNoEcho(result);
    }
    expect(await everything(f)).toBe(before);
  });
});

describe("the form records as POST /plans records and takes the step the plan-approval flow takes (flow, D-383, D-273 (2))", () => {
  /**
   * The same boxes two ways on two identical fixtures: through the form, and as the state API
   * does it (`readPlanSubmission`, `createPlanSubmissions`, then the plan-approval flow it starts
   * with both switches off). Ids and times come from the same sequences, so the stores must end
   * the same.
   */
  async function bothWays(
    fieldsFor: (prepared: string) => SubmitPlanFields,
    prepare: (f: FlowFixture) => Promise<string> = () => Promise.resolve(""),
  ) {
    const form = await live();
    const api = await live();
    const prepared = await prepare(form);
    expect(await prepare(api)).toBe(prepared);
    const fields = fieldsFor(prepared);
    const result = await submitPlanForm(form.deps, fields);

    const { ideaId, needsDidi, needsDidiReason, ...texts } = fields;
    const read = readPlanSubmission({
      ...texts,
      ...(ideaId ? { ideaId } : {}),
      needsDidi: { needed: needsDidi, reason: needsDidiReason },
    });
    if ("problem" in read) throw new Error(read.problem);
    const submitted = await createPlanSubmissions(api.deps).submit(read.submission);
    if (!submitted.recorded) throw new Error(submitted.reason);
    const step = await planApprovalFlow(api.deps, { ideaId: submitted.ideaId });

    expect(await everything(form)).toBe(await everything(api));
    expect(result).toEqual({
      outcome: "recorded",
      ideaId: submitted.ideaId,
      created: submitted.created,
      planApproval: { outcome: "taken", step },
    });
    expectNoEcho(result);
    return { f: form, result: recorded(result) };
  }

  it("records a new idea by the planning chat's identity and opens Didi's plan-approval request", async () => {
    const { f, result } = await bothWays(() => FIELDS);
    expect(result.created).toBe(true);
    expect(result.planApproval).toMatchObject({ step: { step: "opened" } });
    expect(await f.store.getNode(result.ideaId)).toMatchObject({
      type: "idea",
      state: "submitted",
      ownerRole: "runner",
      title: TITLE,
      body: { source: "planning_chat" },
    });
    const decisions = await f.store.listDecisionsForNode(result.ideaId);
    expect(decisions.map((d) => [d.kind, d.byActor, d.textVerbatim])).toEqual([
      ["product_direction", "planning", DIRECTION],
      ["interview_answer", "planning", "JSON,\nfor now."],
    ]);
    expect(
      await f.store.listEvidence({ nodeId: result.ideaId, kind: "agent_report" }),
    ).toMatchObject([
      {
        runId: null,
        recordedBy: "planning",
        payload: {
          kind: PLAN_SUBMISSION_KIND,
          title: TITLE,
          plan: PLAN,
          productDirection: DIRECTION,
          answers: ANSWERS,
          needsDidi: { needed: "yes", reason: REASON },
        },
      },
    ]);
    const request = await f.store.findOpenGateRequest(
      f.projectId,
      planApprovalTopic(result.ideaId),
    );
    expect(request?.payload).toMatchObject({ plan: PLAN, source: "planning_chat" });
    // Taken once: the plan-approval flow and the reconcile pass after it open nothing more.
    expect(await planApprovalFlow(f.deps, { ideaId: result.ideaId })).toMatchObject({
      step: "waiting",
    });
  });

  it("records a resubmission on an idea in Council planning and asks Didi about the new plan", async () => {
    const second = `${PLAN}\nSecond version.`;
    const { f, result } = await bothWays(
      (ideaId) => ({ ...FIELDS, plan: second, ideaId }),
      async (fixture) => (await ideaIn(fixture, "council_planning")).id,
    );
    expect(result.created).toBe(false);
    expect(result.planApproval).toMatchObject({
      step: { ideaId: result.ideaId, step: "opened" },
    });
    // Resubmitted, not moved: the idea waits in Council planning for Didi's answer.
    expect((await f.store.getNode(result.ideaId))?.state).toBe("council_planning");
    expect(await f.store.listTransitions(result.ideaId)).toEqual([]);
    const request = await f.store.findOpenGateRequest(
      f.projectId,
      planApprovalTopic(result.ideaId),
    );
    expect(request?.payload).toMatchObject({ plan: second });
  });

  it("with the Council's call that Didi is not needed, accepts the plan as the Council's and starts Triage", async () => {
    const { f, result } = await bothWays(() => ({
      ...FIELDS,
      needsDidi: "no",
      needsDidiReason: "An internal rename.",
    }));
    expect(result.planApproval).toMatchObject({
      step: {
        step: "council_accepted",
        move: { outcome: "applied" },
        triage: [{ ideaId: result.ideaId, step: "start" }],
      },
    });
    expect((await f.store.getNode(result.ideaId))?.state).toBe("triage");
    expect(
      await f.store.listGateRequests(f.projectId, planApprovalTopic(result.ideaId)),
    ).toEqual([]);
  });
});

describe("the form under the switches (flow, D-333)", () => {
  it.each(["dry_run", "kill_switch"] as const)(
    "with %s on records the submission, as POST /plans does, and takes no step; the reconcile pass takes it once both are off",
    async (held) => {
      const f = await live();
      if (held === "dry_run") await f.setting("dry_run", true);
      else await f.killed();
      const result = recorded(await submitPlanForm(f.deps, FIELDS));
      expect(result).toEqual({
        outcome: "recorded",
        ideaId: result.ideaId,
        created: true,
        planApproval: {
          outcome: "held",
          heldBy: held,
          message: SUBMIT_PLAN_MESSAGES[held],
        },
      });
      expectNoEcho(result);
      expect(
        await f.store.listEvidence({ nodeId: result.ideaId, kind: "agent_report" }),
      ).toMatchObject([{ recordedBy: "planning", payload: { plan: PLAN } }]);
      expect(await f.store.listTransitions(result.ideaId)).toEqual([]);
      expect(
        await f.store.listGateRequests(f.projectId, planApprovalTopic(result.ideaId)),
      ).toEqual([]);

      await f.setting("kill_switch", false);
      await f.live();
      expect((await reconcileFlow(f.deps)).plans).toMatchObject([
        { ideaId: result.ideaId, step: "opened" },
      ]);
    },
  );

  it("with both on names the kill switch, as the API's start does", async () => {
    const f = await live();
    await f.setting("dry_run", true);
    await f.killed();
    expect(recorded(await submitPlanForm(f.deps, FIELDS)).planApproval).toEqual({
      outcome: "held",
      heldBy: "kill_switch",
      message: SUBMIT_PLAN_MESSAGES.kill_switch,
    });
  });
});

describe("a plan approval step that throws (flow, D-274)", () => {
  it("leaves the submission standing, keeps nothing from the error, and the reconcile pass opens the request", async () => {
    const f = await live();
    const failing = new Proxy(f.store, {
      get: (target, key, receiver) =>
        key === "listGateRequests"
          ? () => Promise.reject(new Error("synthetic failure text"))
          : (Reflect.get(target, key, receiver) as unknown),
    });
    const result = recorded(
      await submitPlanForm({ ...f.deps, store: failing }, FIELDS),
    );
    expect(result.planApproval).toEqual({
      outcome: "failed",
      message: SUBMIT_PLAN_MESSAGES.failed,
    });
    expect(JSON.stringify(result)).not.toContain("synthetic");
    expectNoEcho(result);
    expect(
      await f.store.listEvidence({ nodeId: result.ideaId, kind: "agent_report" }),
    ).toHaveLength(1);
    expect((await reconcileFlow(f.deps)).plans).toMatchObject([
      { ideaId: result.ideaId, step: "opened" },
    ]);
  });
});
