// Seam: unit. The Council's base casts as data (ADR 0119 slice 6a, D-463, D-466, D-482 to D-487):
// `councilCast` resolves each question kind's cast from the table the Council's bot file holds,
// over question data shaped as the runner builds each kind's input (./council-input.ts): the
// escalated item, the stale items of a reversal, and a plan's idea as the Scanner or the
// run-finding step writes its body. `questionDiscussion` gives the chair, the cast and the pull-in
// limit a Council task carries (ADR 0119 slice 6e). The table's own check is in
// src/adapters/contracts-file/bot-files.test.ts.
import { describe, expect, it } from "vitest";

import {
  CAST_TOKENS,
  COUNCIL_QUESTION_KINDS,
  MAX_PULL_INS,
  councilCast,
  isCastToken,
  questionDiscussion,
  type CastQuestion,
  type CouncilDiscussion,
} from "./council-cast.ts";
import type {
  CouncilPlanInput,
  EscalationInput,
  ReversalInput,
  ScopeUpdateView,
} from "./council-input.ts";
import { SCANNER_SOURCE, SCANNER_STAGE } from "./scan-ideas.ts";
import { FINDING_SOURCE } from "./finding-ideas.ts";
import type { Node, Track } from "./store.ts";

/** The table in contracts/bots/council.yaml. */
const TABLE: CouncilDiscussion = {
  chair: "product",
  maxPullIns: 2,
  casts: {
    escalation: ["builder", "quality"],
    reversal: ["stale_builders"],
    plan: ["developer", "designer_if_ui"],
    still_needed: ["developer"],
    visual_call: ["designer", "quality"],
    scanner_gone: ["developer"],
  },
};

/** An item as the escalation and reversal inputs carry it. */
const item = (
  track: Track | null,
  id = "item-1",
): Pick<Node, "id" | "title" | "body" | "state" | "track"> => ({
  id,
  title: `An item on ${track ?? "no"} track`,
  body: { description: "What it must do.", acceptanceCriteria: ["It does it."] },
  state: "in_progress",
  track,
});

const escalation = (track: Track | null): CastQuestion => {
  const input: Pick<EscalationInput, "node"> = { node: item(track) };
  return { kind: "escalation", node: input.node };
};

const reversal = (...tracks: (Track | null)[]): CastQuestion => {
  const input: Pick<ReversalInput, "staleItems"> = {
    staleItems: tracks.map((track, i) => item(track, `stale-${i}`)),
  };
  return { kind: "reversal", staleItems: input.staleItems };
};

/** A scanner idea's body, as ./scan-ideas.ts writes it. */
const scannerBody = (...paths: string[]) => ({
  source: SCANNER_SOURCE,
  description: "A finding of the fixed checks.",
  class: "drift",
  check: "unused_export",
  evidence: paths.map((path, i) => ({ path, line: i + 1 })),
  confidence: 1,
  dedupeKey: "unused_export:key",
  foundBy: { scanner: SCANNER_STAGE, commitSha: "a".repeat(40) },
});

/** An idea filed from a run's out-of-scope finding, as ./finding-ideas.ts writes it. */
const findingBody = (role: string) => ({
  source: FINDING_SOURCE,
  description: "Seen outside the run's own item.",
  foundBy: { role, nodeId: "item-9", runId: "run-9" },
});

const update = (path: string): ScopeUpdateView => ({
  check: "unused_export",
  path,
  line: 3,
  target: null,
  commitSha: "b".repeat(40),
});

const plan = (
  input: Pick<CouncilPlanInput, "source" | "scopeUpdates"> & {
    body: Node["body"];
  },
  foundOn: Pick<Node, "track"> | null = null,
): CastQuestion => {
  const built: Pick<CouncilPlanInput, "node" | "source" | "scopeUpdates"> = {
    node: { id: "idea-1", title: "An idea", body: input.body },
    source: input.source,
    scopeUpdates: input.scopeUpdates,
  };
  return { kind: "plan", ...built, foundOn };
};

describe("the Council's question kinds and rule tokens (unit, ADR 0119 slice 6a)", () => {
  it("name every question kind once, in the bot file's schema order, and two pull-ins at most", () => {
    expect(COUNCIL_QUESTION_KINDS).toEqual([
      "escalation",
      "reversal",
      "visual_call",
      "scanner_gone",
      "still_needed",
      "plan",
    ]);
    expect(MAX_PULL_INS).toBe(2);
  });

  it("give each rule token one question kind", () => {
    expect(
      Object.fromEntries(
        Object.entries(CAST_TOKENS).map(([token, { kind }]) => [token, kind]),
      ),
    ).toEqual({
      builder: "escalation",
      stale_builders: "reversal",
      designer_if_ui: "plan",
    });
    expect(isCastToken("builder")).toBe(true);
    expect(isCastToken("developer")).toBe(false);
    expect(isCastToken("toString")).toBe(false);
  });
});

describe("a question's base cast (unit, ADR 0119 slice 6a)", () => {
  it("gives an escalation its builder and Quality: the Designer for a design item, else the Developer (D-463, D-466)", () => {
    expect(councilCast(TABLE, escalation("design"))).toEqual(["designer", "quality"]);
    for (const track of ["code", "infra", "docs", null] as const) {
      expect(councilCast(TABLE, escalation(track)), String(track)).toEqual([
        "developer",
        "quality",
      ]);
    }
  });

  it("gives a reversal the builders of its stale items, the Developer first, or nobody (D-486)", () => {
    expect(councilCast(TABLE, reversal())).toEqual([]);
    for (const track of ["code", "infra", "docs", null] as const) {
      expect(councilCast(TABLE, reversal(track)), String(track)).toEqual(["developer"]);
    }
    expect(councilCast(TABLE, reversal("design", "design"))).toEqual(["designer"]);
    expect(councilCast(TABLE, reversal("design", "code"))).toEqual([
      "developer",
      "designer",
    ]);
    expect(councilCast(TABLE, reversal("docs", "design", "infra"))).toEqual([
      "developer",
      "designer",
    ]);
  });

  it("adds the Designer to a plan whose finding or scope update has a path under design/ or components/ (D-487)", () => {
    const onlyDeveloper = ["developer"];
    const withDesigner = ["developer", "designer"];
    const scanner = (paths: string[], updates: string[] = []) =>
      councilCast(
        TABLE,
        plan({
          source: "scanner",
          body: scannerBody(...paths),
          scopeUpdates: updates.map(update),
        }),
      );
    expect(scanner(["src/core/plans.ts"])).toEqual(onlyDeveloper);
    expect(scanner(["design/forms/sign-up/spec.md"])).toEqual(withDesigner);
    expect(scanner(["src/core/plans.ts", "components/Button.tsx"])).toEqual(
      withDesigner,
    );
    expect(scanner(["src/core/plans.ts"], ["components/Card.tsx"])).toEqual(
      withDesigner,
    );
    expect(scanner(["src/core/plans.ts"], ["design/cards/spec.md"])).toEqual(
      withDesigner,
    );
    // From the repository's root only: a folder of the same name deeper down, or a name that
    // only starts the same, is not the UI.
    expect(
      scanner(
        ["src/design/tokens.ts", "designs/old.md", "lib/components/x.ts"],
        ["docs/components.md"],
      ),
    ).toEqual(onlyDeveloper);
    // An idea with no evidence and no updates.
    expect(scanner([])).toEqual(onlyDeveloper);
  });

  it("adds the Designer to a plan for an idea a Designer run found, or one found on a design item (D-487)", () => {
    const finding = (role: string, foundOn: Pick<Node, "track"> | null) =>
      councilCast(
        TABLE,
        plan(
          { source: "run_finding", body: findingBody(role), scopeUpdates: [] },
          foundOn,
        ),
      );
    expect(finding("designer", { track: "design" })).toEqual(["developer", "designer"]);
    expect(finding("designer", null)).toEqual(["developer", "designer"]);
    expect(finding("qa", { track: "design" })).toEqual(["developer", "designer"]);
    expect(finding("qa", { track: "code" })).toEqual(["developer"]);
    expect(finding("developer", { track: "infra" })).toEqual(["developer"]);
    expect(finding("developer", null)).toEqual(["developer"]);
    // A scanner idea's finder is the Scanner: its foundBy names no role, and its body's role
    // field, if one were there, is not read.
    expect(
      councilCast(
        TABLE,
        plan({
          source: "scanner",
          body: { ...scannerBody("src/a.ts"), foundBy: { role: "designer" } },
          scopeUpdates: [],
        }),
      ),
    ).toEqual(["developer"]);
    // A run finding's body has no evidence: a path there is not read.
    expect(
      councilCast(
        TABLE,
        plan({
          source: "run_finding",
          body: { ...findingBody("qa"), evidence: [{ path: "design/x.md" }] },
          scopeUpdates: [],
        }),
      ),
    ).toEqual(["developer"]);
  });

  it("gives the other kinds their fixed personas: still needed and scanner gone the Developer, a visual call the Designer and Quality", () => {
    expect(councilCast(TABLE, { kind: "still_needed" })).toEqual(["developer"]);
    expect(councilCast(TABLE, { kind: "scanner_gone" })).toEqual(["developer"]);
    expect(councilCast(TABLE, { kind: "visual_call" })).toEqual([
      "designer",
      "quality",
    ]);
  });

  it("keeps the table's order and names a persona once, at its first place, and never the chair", () => {
    const table = (casts: Partial<CouncilDiscussion["casts"]>): CouncilDiscussion => ({
      ...TABLE,
      casts: { ...TABLE.casts, ...casts },
    });
    expect(
      councilCast(table({ escalation: ["quality", "builder"] }), escalation("design")),
    ).toEqual(["quality", "designer"]);
    expect(
      councilCast(
        table({ escalation: ["developer", "builder", "quality"] }),
        escalation("code"),
      ),
    ).toEqual(["developer", "quality"]);
    expect(
      councilCast(
        table({ escalation: ["developer", "builder", "quality"] }),
        escalation("design"),
      ),
    ).toEqual(["developer", "designer", "quality"]);
    expect(
      councilCast(
        table({ reversal: ["designer", "stale_builders"] }),
        reversal("code", "design"),
      ),
    ).toEqual(["designer", "developer"]);
    // A table the bot file check would refuse still never puts the chair in a cast.
    expect(
      councilCast(
        {
          ...TABLE,
          chair: "developer",
          casts: { ...TABLE.casts, escalation: ["builder"] },
        },
        escalation("code"),
      ),
    ).toEqual([]);
  });

  it("names only the personas a token says it may name", () => {
    const questions: CastQuestion[] = [
      escalation("design"),
      escalation(null),
      reversal("design", "code", null),
      plan({ source: "scanner", body: scannerBody("design/a.md"), scopeUpdates: [] }),
      plan({ source: "run_finding", body: findingBody("designer"), scopeUpdates: [] }),
    ];
    for (const question of questions) {
      for (const [token, { kind, mayName }] of Object.entries(CAST_TOKENS)) {
        if (kind !== question.kind) continue;
        const only: CouncilDiscussion = {
          ...TABLE,
          casts: { ...TABLE.casts, [kind]: [token] },
        };
        for (const id of councilCast(only, question)) {
          expect(mayName as readonly string[], token).toContain(id);
        }
      }
    }
  });

  it("refuses a rule token on another kind's cast, which the bot file check never lets through", () => {
    const wrong: CouncilDiscussion = {
      ...TABLE,
      casts: { ...TABLE.casts, visual_call: ["designer", "builder"] },
    };
    expect(() => councilCast(wrong, { kind: "visual_call" })).toThrow(
      "the rule token builder is for the escalation cast only",
    );
  });
});

describe("a question's discussion (unit, ADR 0119 slice 6e)", () => {
  it("gives the table's chair and pull-in limit with the question's cast, a new list each time", () => {
    expect(questionDiscussion(TABLE, escalation("design"))).toEqual({
      chair: "product",
      cast: ["designer", "quality"],
      maxPullIns: 2,
    });
    expect(questionDiscussion(TABLE, reversal())).toEqual({
      chair: "product",
      cast: [],
      maxPullIns: 2,
    });
    const one = { ...TABLE, maxPullIns: 1 };
    const first = questionDiscussion(one, { kind: "visual_call" });
    expect(first).toEqual({
      chair: "product",
      cast: ["designer", "quality"],
      maxPullIns: 1,
    });
    first.cast.push("developer");
    expect(questionDiscussion(one, { kind: "visual_call" }).cast).toEqual([
      "designer",
      "quality",
    ]);
    expect(TABLE.casts.visual_call).toEqual(["designer", "quality"]);
  });
});
