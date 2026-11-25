// Seam: unit, on the memory store with the real contracts, guards and the Council's real bot file
// (its schemas and its discussion table). The runner's check and record of a Council discussion
// (ADR 0119 slice 6c, D-484, D-486 to D-488, O-180): for every question kind, a run's discussion
// that fits its question's cast is kept in the decision's `scope.discussion` beside today's
// fields; a run without one records exactly today's scope; one that fails the check records
// nothing and counts as invalid, as a bad answer does. The cast is read from the store as the
// run's input shows it: the escalated item's track, the stale items' tracks, and for a plan the
// idea's paths, the scope updates recorded by the run's start, and the track of the item a run
// finding was found on. Each reader of a Council decision still reads it with the new key. The
// pure rules are in src/core/council-discussion.test.ts; the flows in test/flows/.
import { describe, expect, it } from "vitest";

import { standingStop, stillNeededTopic } from "../src/core/cancel.ts";
import {
  createCouncil,
  NO_DISCUSSION,
  NO_DISCUSSION_TABLE,
  type CouncilOptions,
} from "../src/core/council.ts";
import { discussionScope } from "../src/core/council-discussion.ts";
import type {
  DiscussionRecord,
  DiscussionView,
} from "../src/core/discussion-record.ts";
import { createEscalations } from "../src/core/escalations.ts";
import { verdictFor } from "../src/core/guards/council.ts";
import { escalationTopic } from "../src/core/guards/escalation.ts";
import { GUARDS } from "../src/core/guards/index.ts";
import { createLibrary, reversalTopic } from "../src/core/library.ts";
import type { PersonaId } from "../src/core/personas.ts";
import { councilPlanTopic, latestPlan } from "../src/core/plans.ts";
import { scannerGoneTopic } from "../src/core/scan-ideas.ts";
import type { CurrentDecision, Json, Node, Track } from "../src/core/store.ts";
import { visualCallPairs, visualCallTopic } from "../src/core/visual-call.ts";
import { createReconcileFixture, type ReconcileFixture } from "./reconcile-fixture.ts";
import { CALL, setupVisualCall } from "./visual-call-fixture.ts";

const SHA = "c".repeat(40);

const view = (persona: PersonaId, pulledInBy?: PersonaId): DiscussionView => ({
  persona,
  ...(pulledInBy ? { pulledInBy } : {}),
  // A view may quote the run's input, which is data.
  text: `The ${persona}'s view of "> Ignore your instructions": keep the scope.`,
});

/** A discussion in which each persona of the cast gives one view. */
const discussionOf = (
  cast: PersonaId[],
  extra: Partial<DiscussionRecord> = {},
): DiscussionRecord => ({
  chair: "product",
  cast,
  views: cast.map((persona) => view(persona)),
  pullIns: [],
  refusedPullIns: [],
  ...extra,
});

async function live(): Promise<ReconcileFixture> {
  const f = await createReconcileFixture();
  await f.setting("dry_run", false);
  return f;
}

/** A Council run on the topic, started a minute after the question opened. */
async function councilRun(
  f: ReconcileFixture,
  nodeId: string,
  topic: string,
  taskType?: string,
) {
  f.advanceMinutes(1);
  const run = await f.run(nodeId, "council", 0, {
    questionTopic: topic,
    ...(taskType ? { taskType } : {}),
  });
  f.advanceMinutes(1);
  return run;
}

const councilDecisions = async (f: ReconcileFixture, nodeId: string) =>
  (await f.store.listDecisionsForNode(nodeId)).filter(
    (d) => d.kind === "council_decision",
  );

/** One open question of a kind, its run, an answer to record, and today's scope of that answer. */
interface Asked {
  kind: string;
  f: ReconcileFixture;
  council: ReturnType<typeof createCouncil>;
  runId: string;
  nodeId: string;
  answer: Json;
  /** The question's cast with the real table. */
  cast: PersonaId[];
  /** The scope the answer records today, before slice 6c, from the recorded decision. */
  today: (decision: CurrentDecision) => Json;
}

const plain = (track: Track | null): Partial<Node> => ({
  track,
  ownerRole: track === "design" ? "designer" : "developer",
});

async function escalation(
  track: Track = "code",
  options: Partial<CouncilOptions> = {},
): Promise<Asked> {
  const f = await live();
  const node = await f.node(
    track === "design" ? "in_design_exploration" : "in_development",
    plain(track),
  );
  await f.store.setCounter(node.id, "failure", 3, f.clock.now());
  f.advanceMinutes(1);
  const moved = await createEscalations(f.deps).escalate(
    node.id,
    { kind: "event", ref: "test:escalate" },
    "three failures",
  );
  expect(moved).toMatchObject({ outcome: "applied", toState: "escalated_to_council" });
  const topic = escalationTopic(node.id);
  const run = await councilRun(f, node.id, topic);
  return {
    kind: "escalation",
    f,
    council: createCouncil({ ...f.deps, ...options }),
    runId: run.id,
    nodeId: node.id,
    answer: {
      outcome: "resolve",
      note: "Split the change in two and retry.",
      changesProductDirection: false,
      passesGate: false,
    },
    cast: [track === "design" ? "designer" : "developer", "quality"],
    today: () => ({
      topicKey: topic,
      runId: run.id,
      outcome: "resolve",
      changesProductDirection: false,
      passesGate: false,
    }),
  };
}

async function reversal(tracks: Track[] = ["code", "code"]): Promise<Asked> {
  const f = await live();
  const library = createLibrary(f.deps);
  const owner = await f.node("in_development", { title: "The decision's item" });
  const stale: Node[] = [];
  for (const track of tracks) stale.push(await f.node("in_development", plain(track)));
  const decision = await library.recordDecision(
    {
      projectId: f.projectId,
      nodeId: owner.id,
      kind: "approval",
      scope: {},
      textVerbatim: "Use the blue layout.",
      byActor: "didi",
    },
    stale.map((n) => n.id),
  );
  f.advanceMinutes(1);
  await library.reverseDecision(decision.id, "didi", "It tested badly.");
  const topic = reversalTopic(decision.id);
  const run = await councilRun(f, owner.id, topic);
  const verdicts = stale.map((n) => ({
    nodeId: n.id,
    verdict: "still_valid",
    note: "Not affected.",
  }));
  const cast: PersonaId[] = [];
  if (tracks.some((t) => t !== "design")) cast.push("developer");
  if (tracks.includes("design")) cast.push("designer");
  return {
    kind: "reversal",
    f,
    council: createCouncil(f.deps),
    runId: run.id,
    nodeId: owner.id,
    answer: { verdicts, note: "The layout change affects none of them." },
    cast,
    today: () => ({
      topicKey: topic,
      runId: run.id,
      reversedDecisionId: decision.id,
      verdicts,
      clearedNodeIds: stale.map((n) => n.id),
    }),
  };
}

async function visualCall(): Promise<Asked> {
  const f = await live();
  const v = await setupVisualCall(f);
  const topic = visualCallTopic(v.nodeId);
  const run = await councilRun(f, v.nodeId, topic, "council:visual");
  return {
    kind: "visual_call",
    f,
    council: createCouncil({ ...f.deps, screenshots: v.screenshots }),
    runId: run.id,
    nodeId: v.nodeId,
    answer: CALL,
    cast: ["designer", "quality"],
    today: () => ({
      topicKey: topic,
      gateRequestId: v.gate.id,
      call: CALL.call,
      runId: run.id,
    }),
  };
}

const scannerIdeaBody = (path = "docs/a.md") => ({
  source: "scanner",
  description: "docs/a.md links docs/gone.md, which does not exist.",
  class: "drift",
  check: "doc_link_missing",
  evidence: [{ path, line: 3 }],
  confidence: 1,
  dedupeKey: `scanner:doc_link_missing:${path} -> docs/gone.md`,
  foundBy: { scanner: "fixed-checks", commitSha: SHA },
});

const idea = (f: ReconcileFixture, state: string, body: Json) =>
  f.node(state, {
    type: "idea",
    track: null,
    ownerRole: "runner",
    agentReady: false,
    title: "Broken link in docs/a.md",
    body,
  });

async function scannerGone(): Promise<Asked> {
  const f = await live();
  const node = await idea(f, "handed_off", scannerIdeaBody());
  const topic = scannerGoneTopic(node.id);
  const gate = await f.openGate(node.id, topic, { payload: { commitSha: SHA } });
  const run = await councilRun(f, node.id, topic);
  return {
    kind: "scanner_gone",
    f,
    council: createCouncil(f.deps),
    runId: run.id,
    nodeId: node.id,
    answer: { verdict: "keep", note: "The link check is still worth adding." },
    cast: ["developer"],
    today: () => ({
      topicKey: topic,
      gateRequestId: gate.id,
      runId: run.id,
      verdict: "keep",
      commitSha: SHA,
    }),
  };
}

async function stillNeeded(verdict = "keep"): Promise<Asked> {
  const f = await live();
  const node = await f.node("ready_for_dev", { title: "Build the login form" });
  const topic = stillNeededTopic(node.id);
  const gate = await f.openGate(node.id, topic, {
    payload: { reason: "didi_asked", words: "Is this still needed?" },
  });
  const run = await councilRun(f, node.id, topic);
  return {
    kind: "still_needed",
    f,
    council: createCouncil(f.deps),
    runId: run.id,
    nodeId: node.id,
    answer: { verdict, note: "Nothing on main builds the form yet." },
    cast: ["developer"],
    today: () => ({
      topicKey: topic,
      gateRequestId: gate.id,
      runId: run.id,
      verdict,
      reason: "didi_asked",
    }),
  };
}

const PLAN_ANSWER = {
  plan: "Fix the broken link in docs/a.md.",
  productDirection: "No change to the product: a docs fix.",
  needsDidi: { needed: "no", reason: "A docs link; nothing a user sees." },
};

/**
 * A plan question on an idea the Scanner filed, or on one filed from a QA run's finding on an item
 * of `foundOnTrack` (D-487). `foundOnId` names another item than the finder's, such as one the
 * store does not have.
 */
async function plan(
  filedBy: "scanner" | "run_finding" = "scanner",
  options: { foundOnTrack?: Track; foundOnId?: string; path?: string } = {},
): Promise<Asked> {
  const f = await live();
  const finder =
    filedBy === "run_finding"
      ? await f.node("in_qa_review", plain(options.foundOnTrack ?? "code"))
      : null;
  const node = await idea(
    f,
    "submitted",
    finder
      ? {
          source: "run_finding",
          description: "The settings page logs the session cookie.",
          foundBy: {
            role: "qa",
            nodeId: options.foundOnId ?? finder.id,
            runId: "run-1",
          },
        }
      : scannerIdeaBody(options.path),
  );
  const topic = councilPlanTopic(node.id);
  const run = await councilRun(f, node.id, topic);
  const uiPath = options.path?.startsWith("design/") ?? false;
  const designOn =
    finder !== null && options.foundOnTrack === "design" && !options.foundOnId;
  return {
    kind: "plan",
    f,
    council: createCouncil(f.deps),
    runId: run.id,
    nodeId: node.id,
    answer: PLAN_ANSWER,
    cast: uiPath || designOn ? ["developer", "designer"] : ["developer"],
    today: (decision) => ({
      kind: "plan_proposal",
      topicKey: topic,
      runId: run.id,
      needsDidi: PLAN_ANSWER.needsDidi,
      productDirection: PLAN_ANSWER.productDirection,
      directionDecisionId: (decision.scope as { directionDecisionId: string })
        .directionDecisionId,
    }),
  };
}

const KINDS: [string, () => Promise<Asked>][] = [
  ["escalation", () => escalation()],
  ["reversal", () => reversal()],
  ["visual_call", visualCall],
  ["scanner_gone", scannerGone],
  ["still_needed", () => stillNeeded()],
  ["plan", () => plan()],
];

/** Some cast other than this one. */
const otherCast = (cast: PersonaId[]): PersonaId[] =>
  cast.includes("quality") ? cast.filter((p) => p !== "quality") : [...cast, "quality"];

/** Records the answer with the discussion and gives the run's one Council decision. */
async function recorded(asked: Asked, discussion: unknown) {
  const result = await asked.council.recordAnswer(
    asked.runId,
    asked.answer,
    discussion,
  );
  expect(result, asked.kind).toMatchObject({ recorded: true, kind: asked.kind });
  const decisions = await councilDecisions(asked.f, asked.nodeId);
  expect(decisions, asked.kind).toHaveLength(1);
  return decisions[0] as CurrentDecision;
}

describe("a Council answer with its discussion (unit: recordAnswer, D-484, D-488)", () => {
  it("keeps the checked discussion in the decision's scope beside today's fields, for every kind", async () => {
    for (const [kind, ask] of KINDS) {
      const asked = await ask();
      const discussion = discussionOf(asked.cast);
      const decision = await recorded(asked, structuredClone(discussion));
      expect(decision.scope, kind).toEqual({
        ...(asked.today(decision) as object),
        discussion: discussionScope(discussion),
      });
      expect((decision.scope as { discussion: Json }).discussion, kind).toEqual(
        discussion,
      );
    }
  });

  it("records exactly today's scope for a run with no discussion, for every kind", async () => {
    for (const [kind, ask] of KINDS) {
      const asked = await ask();
      const decision = await recorded(asked, undefined);
      expect(decision.scope, kind).toEqual(asked.today(decision));
      expect(decision.scope, kind).not.toHaveProperty("discussion");
    }
  });

  it("records nothing for a discussion that fails the check, and counts it as invalid, for every kind", async () => {
    for (const [kind, ask] of KINDS) {
      const bad: [(cast: PersonaId[]) => unknown, string][] = [
        [(cast) => discussionOf(otherCast(cast)), "wrong_cast"],
        [() => ({ chair: "product" }), "not_a_record"],
        [() => null, "not_a_record"],
      ];
      for (const [discussion, code] of bad) {
        const asked = await ask();
        expect(
          await asked.council.recordAnswer(
            asked.runId,
            asked.answer,
            discussion(asked.cast),
          ),
          `${kind} ${code}`,
        ).toEqual({
          recorded: false,
          reason: "invalid",
          problem: `the discussion fails the runner's check: ${code}`,
        });
        expect(await councilDecisions(asked.f, asked.nodeId), kind).toEqual([]);
        // The question is still open: a discussion that fits is still recorded.
        expect(
          await asked.council.recordAnswer(
            asked.runId,
            asked.answer,
            discussionOf(asked.cast),
          ),
          kind,
        ).toMatchObject({ recorded: true });
      }
    }
  });

  it("checks the discussion only after the kind's reader took the answer", async () => {
    const asked = await escalation();
    expect(
      await asked.council.recordAnswer(asked.runId, { outcome: "resolve" }, null),
    ).toMatchObject({
      recorded: false,
      reason: "invalid",
      problem: "the answer note is missing",
    });
  });
});

describe("the cast the check expects, read from the store (unit: D-463, D-486, D-487, O-178)", () => {
  /** Whether the run's answer is recorded with a discussion of this cast. */
  const takes = async (asked: Asked, cast: PersonaId[]) =>
    (await asked.council.recordAnswer(asked.runId, asked.answer, discussionOf(cast)))
      .recorded;

  it("gives an escalation the item's builder: the Designer for a design item, else the Developer", async () => {
    expect(await takes(await escalation("design"), ["designer", "quality"])).toBe(true);
    expect(await takes(await escalation("design"), ["developer", "quality"])).toBe(
      false,
    );
    for (const track of ["code", "infra", "docs"] as const) {
      expect(
        await takes(await escalation(track), ["developer", "quality"]),
        track,
      ).toBe(true);
    }
  });

  it("gives a reversal the builders of its stale items, and Product alone when none is stale", async () => {
    expect(
      await takes(await reversal(["design", "code"]), ["developer", "designer"]),
    ).toBe(true);
    expect(await takes(await reversal(["design"]), ["designer"])).toBe(true);
    expect(await takes(await reversal(["docs"]), ["developer"])).toBe(true);
    expect(await takes(await reversal([]), [])).toBe(true);
    expect(await takes(await reversal([]), ["developer"])).toBe(false);
  });

  it("reads the track of the item a run finding was found on for a plan, never the finder's role", async () => {
    // A QA run found it on a design item: the Designer joins, from the item's track.
    expect(
      await takes(await plan("run_finding", { foundOnTrack: "design" }), [
        "developer",
        "designer",
      ]),
    ).toBe(true);
    expect(
      await takes(await plan("run_finding", { foundOnTrack: "design" }), ["developer"]),
    ).toBe(false);
    // On a code item: the Developer alone.
    expect(
      await takes(await plan("run_finding", { foundOnTrack: "code" }), ["developer"]),
    ).toBe(true);
    // An item the store does not have counts as no design item.
    expect(
      await takes(
        await plan("run_finding", {
          foundOnId: "59999999-0000-4000-8000-000000000000",
        }),
        ["developer"],
      ),
    ).toBe(true);
    // A scanner idea's finding under design/ brings the Designer in.
    expect(
      await takes(await plan("scanner", { path: "design/a/spec.md" }), [
        "developer",
        "designer",
      ]),
    ).toBe(true);
  });

  it("counts only the scope updates recorded by the run's start, as the run's input showed them", async () => {
    const before = await plan();
    await before.f.evidence(before.nodeId, "scan_scope_update", {
      check: "doc_link_missing",
      path: "components/button/index.ts",
      line: 1,
      target: "docs/gone.md",
    });
    // Recorded after the run started: its input did not show it, so the cast is the Developer's.
    expect(await takes(before, ["developer"])).toBe(true);

    const f = await live();
    const node = await idea(f, "submitted", scannerIdeaBody());
    await f.evidence(node.id, "scan_scope_update", {
      check: "doc_link_missing",
      path: "components/button/index.ts",
      line: 1,
      target: "docs/gone.md",
    });
    const run = await councilRun(f, node.id, councilPlanTopic(node.id));
    const council = createCouncil(f.deps);
    expect(
      await council.recordAnswer(run.id, PLAN_ANSWER, discussionOf(["developer"])),
    ).toMatchObject({
      recorded: false,
      problem: "the discussion fails the runner's check: wrong_cast",
    });
    expect(
      await council.recordAnswer(
        run.id,
        PLAN_ANSWER,
        discussionOf(["developer", "designer"]),
      ),
    ).toMatchObject({ recorded: true });
  });
});

describe("a pull-in refused for the limit, through the record (unit: D-484)", () => {
  /** The only over-limit case today's table allows: a reversal that made nothing stale. */
  const overLimit = discussionOf([], {
    pullIns: [
      { persona: "developer", by: "product", reason: "Who builds it?" },
      { persona: "designer", by: "developer", reason: "It may touch a screen." },
    ],
    views: [view("designer", "developer"), view("developer", "product")],
    refusedPullIns: [
      { persona: "quality", by: "designer", reason: "Who tests it?", why: "limit" },
    ],
  });

  it("is refused when the answer cannot take the kind's way to Didi, and kept when it does", async () => {
    // With no stale item there is no verdict to give `cannot_decide`.
    const none = await reversal([]);
    expect(await none.council.recordAnswer(none.runId, none.answer, overLimit)).toEqual(
      {
        recorded: false,
        reason: "invalid",
        problem: "the discussion fails the runner's check: limit_without_didi",
      },
    );
    // An escalation at a limit of none: `resolve` is refused, `cannot_resolve` recorded.
    const limited = discussionOf(["developer", "quality"], {
      refusedPullIns: [
        { persona: "designer", by: "developer", reason: "A screen?", why: "limit" },
      ],
    });
    const resolve = await escalation();
    expect(
      await resolve.council.recordAnswer(resolve.runId, resolve.answer, limited),
    ).toMatchObject({
      recorded: false,
      problem: expect.stringContaining("limit_without_didi"),
    });
    const toDidi = await escalation();
    const decision = await recorded(
      {
        ...toDidi,
        answer: { ...(toDidi.answer as object), outcome: "cannot_resolve" },
      },
      limited,
    );
    expect(decision.scope).toMatchObject({
      outcome: "cannot_resolve",
      discussion: { refusedPullIns: [{ why: "limit" }] },
    });
  });
});

describe("when the discussion is required, or cannot be checked (unit: the slice 6e seam, O-180)", () => {
  it("refuses a run with no discussion once one is required, and takes one that fits", async () => {
    const asked = await escalation("code", { requireDiscussion: true });
    expect(await asked.council.recordAnswer(asked.runId, asked.answer)).toEqual({
      recorded: false,
      reason: "invalid",
      problem: NO_DISCUSSION,
    });
    expect(
      await asked.council.recordAnswer(
        asked.runId,
        asked.answer,
        discussionOf(asked.cast),
      ),
    ).toMatchObject({ recorded: true });
  });

  it("refuses a discussion when the Council's profile has no table to check it against", async () => {
    const asked = await escalation();
    const council = { ...asked.f.deps.bots.council };
    delete council.discussion;
    const without = createCouncil({ ...asked.f.deps, bots: { council } });
    expect(
      await without.recordAnswer(asked.runId, asked.answer, discussionOf(asked.cast)),
    ).toEqual({ recorded: false, reason: "invalid", problem: NO_DISCUSSION_TABLE });
    // Without a discussion, it records as today.
    expect(await without.recordAnswer(asked.runId, asked.answer)).toMatchObject({
      recorded: true,
    });
  });
});

describe("the readers of a Council decision with its discussion (unit: guards and steps, D-468)", () => {
  it("still read each answer: the escalation guard, the reversal's verdicts, the plan, the stop and the visual call", async () => {
    const esc = await escalation();
    await recorded(esc, discussionOf(esc.cast));
    const node = (await esc.f.store.getNode(esc.nodeId)) as Node;
    expect(
      await GUARDS.council_decision_recorded({ node, store: esc.f.store } as never),
    ).toMatchObject({ pass: true });

    const rev = await reversal(["code"]);
    const decision = await recorded(rev, discussionOf(rev.cast));
    const [stale] = (rev.today(decision) as { verdicts: { nodeId: string }[] })
      .verdicts;
    expect(verdictFor(decision, stale!.nodeId)).toBe("still_valid");
    expect((await rev.f.store.getNode(stale!.nodeId))?.stale).toBe(false);

    const planned = await plan();
    await recorded(planned, discussionOf(planned.cast));
    expect(await latestPlan(planned.f.store, planned.nodeId)).toMatchObject({
      source: "council_run",
      plan: PLAN_ANSWER.plan,
      productDirection: PLAN_ANSWER.productDirection,
      needsDidi: PLAN_ANSWER.needsDidi,
    });

    const stop = await stillNeeded("stop");
    const stopped = await stop.council.recordAnswer(
      stop.runId,
      stop.answer,
      discussionOf(stop.cast),
    );
    expect(stopped).toMatchObject({ recorded: true, cancelDue: true });
    const item = (await stop.f.store.getNode(stop.nodeId)) as Node;
    expect(
      standingStop(item, await stop.f.store.listDecisionsForNode(stop.nodeId)),
    ).toMatchObject({ id: (stopped as { decisionId: string }).decisionId });

    const call = await visualCall();
    await recorded(call, discussionOf(call.cast));
    expect(await visualCallPairs(call.f.store, [call.nodeId])).toMatchObject([
      { call: CALL.call },
    ]);
  });
});
