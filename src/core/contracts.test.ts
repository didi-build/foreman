// Seam: unit tests of the contracts validator (ADR 0105). The validator must collect every
// problem in one call, so a broken file shows all its fixes at once.
import { describe, expect, it } from "vitest";

import { validateContracts, type RawContractFile } from "./contracts.ts";

const GUARDS = ["blockers_done", "approval_recorded"];

type Data = Record<string, unknown>;

const state = (label: string, extra: Data = {}) => ({
  label,
  owner: "Runner",
  ...extra,
});

const codeData = (): Data => ({
  part: "code",
  states: {
    ready: state("Ready", { initial: true }),
    working: state("Working"),
  },
  transitions: [
    { from: "ready", to: "working", tracks: ["code"], guards: ["blockers_done"] },
  ],
});

const escalationData = (): Data => ({
  part: "escalation",
  states: {
    escalated_to_council: state("Escalated to Council", {
      escalated: true,
      requires_blocked_reason: true,
    }),
  },
  transitions: [
    { from: "any", to: "escalated_to_council", guards: [] },
    { from: "escalated_to_council", to: "return", guards: [] },
  ],
});

/** The shape the contracts-file adapter produces; escalation follows the file name. */
const raw = (...files: [string, unknown][]) => ({
  version: "a".repeat(40),
  contentHash: "b".repeat(64),
  files: files.map(([name, data]): RawContractFile => ({
    name,
    escalation: name === "escalation.yaml",
    data,
  })),
});

const problemsOf = (...files: [string, unknown][]) =>
  validateContracts(raw(...files), GUARDS).problems;

describe("validateContracts (unit: contracts validator, ADR 0105)", () => {
  it("accepts well-formed files and maps snake_case fields", () => {
    const code = codeData();
    (code.states as Data).ready = state("Ready", {
      initial: true,
      requires_blocked_reason: true,
      evidence_to_exit: "A dispatch record.",
      side_effects: "None.",
      budget: "not set",
    });
    const result = validateContracts(
      raw(["code.yaml", code], ["escalation.yaml", escalationData()]),
      GUARDS,
    );
    expect(result.problems).toEqual([]);
    expect(result.contracts?.states.ready).toMatchObject({
      label: "Ready",
      initial: true,
      requiresBlockedReason: true,
      evidenceToExit: "A dispatch record.",
      sideEffects: "None.",
      budget: "not set",
    });
    expect(result.contracts?.transitions[0]).toMatchObject({
      from: "ready",
      to: "working",
      tracks: ["code"],
    });
    expect(result.contracts?.transitions[1]).toMatchObject({ escalation: true });
  });

  it("collects every problem in one call", () => {
    const code = codeData();
    code.transitions = [
      // Unknown state, unregistered guard, any and return outside escalation, a duplicate.
      { from: "nowhere", to: "working", guards: ["not_a_guard"] },
      { from: "any", to: "working", guards: [] },
      { from: "working", to: "return", guards: [] },
      { from: "ready", to: "working", tracks: ["code"], guards: [] },
      { from: "ready", to: "working", tracks: ["code", "docs"], guards: [] },
    ];
    const { contracts, problems } = validateContracts(raw(["code.yaml", code]), GUARDS);
    expect(contracts).toBeUndefined();
    const all = problems.join("\n");
    expect(all).toContain("unknown state nowhere");
    expect(all).toContain("guard not_a_guard is not registered");
    expect(problems.filter((p) => p.includes("only for escalation.yaml"))).toHaveLength(
      2,
    );
    expect(all).toContain("duplicate move ready to working");
  });

  it("allows any and return in escalation.yaml only", () => {
    expect(
      problemsOf(["code.yaml", codeData()], ["escalation.yaml", escalationData()]),
    ).toEqual([]);
    const misplaced = escalationData();
    expect(
      problemsOf(
        ["code.yaml", codeData()],
        ["other.yaml", { ...misplaced, part: "other" }],
      ),
    ).toEqual(
      expect.arrayContaining([expect.stringContaining("only for escalation.yaml")]),
    );
  });

  it("rejects a file that marks itself as escalation to use any and return", () => {
    const code = codeData();
    code.transitions = [
      { from: "any", to: "working", guards: [], escalation: true },
      { from: "working", to: "return", guards: [], escalation: true },
    ];
    const all = problemsOf(["code.yaml", code]).join("\n");
    expect(all).toContain("unknown field escalation");
    expect(all).toContain("only for escalation.yaml");
  });

  it("rejects a part that disagrees with the file name", () => {
    expect(
      problemsOf(["code.yaml", { ...escalationData(), part: "escalation" }]),
    ).toEqual(expect.arrayContaining([expect.stringContaining("part must be code")]));
  });

  it("rejects any as a target and return as a source even in escalation.yaml", () => {
    const escalation = escalationData();
    escalation.transitions = [
      { from: "return", to: "escalated_to_council", guards: [] },
      { from: "escalated_to_council", to: "any", guards: [] },
    ];
    const problems = problemsOf(["escalation.yaml", escalation]);
    expect(problems.filter((p) => p.includes("only a target"))).toHaveLength(2);
  });

  it.each(["any", "return"])("rejects %s as a state id", (id) => {
    const code = codeData();
    (code.states as Data)[id] = state("Reserved");
    expect(problemsOf(["code.yaml", code])).toEqual(
      expect.arrayContaining([expect.stringContaining(`state id ${id}`)]),
    );
  });

  it.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "treats %s as an unknown state, not an inherited one",
    (name) => {
      const code = codeData();
      code.transitions = [{ from: "ready", to: name, guards: [] }];
      expect(problemsOf(["code.yaml", code])).toEqual(
        expect.arrayContaining([expect.stringContaining(`unknown state ${name}`)]),
      );
    },
  );

  it("reports a __proto__ state id instead of dropping it", () => {
    const code = codeData();
    // An own __proto__ key, as the yaml parser produces it.
    Object.defineProperty(code.states, "__proto__", {
      value: state("Sneaky"),
      enumerable: true,
    });
    expect(problemsOf(["code.yaml", code])).toEqual(
      expect.arrayContaining([expect.stringContaining("state id __proto__")]),
    );
  });

  it("reports a state declared in two files", () => {
    const design = { part: "design", states: { ready: state("Ready again") } };
    expect(problemsOf(["code.yaml", codeData()], ["design.yaml", design])).toEqual(
      expect.arrayContaining([
        expect.stringContaining("declared in both code.yaml and design.yaml"),
      ]),
    );
  });

  it("reports unknown fields at file, state and transition level", () => {
    const code = codeData();
    code.extra = true;
    (code.states as Data).working = state("Working", { inital: true });
    code.transitions = [{ from: "ready", to: "working", guards: [], track: ["code"] }];
    const all = problemsOf(["code.yaml", code]).join("\n");
    expect(all).toContain("code.yaml: unknown field extra");
    expect(all).toContain("state working: unknown field inital");
    expect(all).toContain("unknown field track");
  });

  it("type-checks flags and lists", () => {
    const code = codeData();
    (code.states as Data).working = state("Working", { escalated: "yes" });
    code.transitions = [
      { from: "ready", to: "working", guards: "blockers_done", fallback_move: "true" },
    ];
    const all = problemsOf(["code.yaml", code]).join("\n");
    expect(all).toContain("escalated must be a boolean");
    expect(all).toContain("guards must be a list");
    expect(all).toContain("fallback_move must be a boolean");
  });

  it("requires labels, owners, snake_case ids and known tracks and evidence kinds", () => {
    const code = codeData();
    (code.states as Data)["Bad-Id"] = { label: "", owner: "" };
    code.transitions = [
      {
        from: "ready",
        to: "working",
        guards: [],
        tracks: ["web"],
        evidence: ["vibes"],
      },
    ];
    const all = problemsOf(["code.yaml", code]).join("\n");
    expect(all).toContain("state id Bad-Id");
    expect(all).toContain("needs a label");
    expect(all).toContain("needs an owner");
    expect(all).toContain("tracks must be a non-empty list");
    expect(all).toContain("evidence must list known evidence kinds");
  });

  it("does not call moves on disjoint tracks duplicates", () => {
    const code = codeData();
    code.transitions = [
      { from: "ready", to: "working", tracks: ["code"], guards: [] },
      { from: "ready", to: "working", tracks: ["design"], guards: [] },
    ];
    expect(problemsOf(["code.yaml", code])).toEqual([]);
  });

  it("collects file shape problems instead of throwing", () => {
    const problems = problemsOf(
      ["a.yaml", ["not", "a", "mapping"]],
      ["b.yaml", null],
      ["c.yaml", { states: ["x"], transitions: { from: "x" } }],
    );
    const all = problems.join("\n");
    expect(all).toContain("a.yaml: must be a mapping");
    expect(all).toContain("b.yaml: must be a mapping");
    expect(all).toContain("c.yaml: states must be a mapping");
    expect(all).toContain("c.yaml: transitions must be a list");
  });

  it("returns states as a prototype-free record", () => {
    const { contracts } = validateContracts(raw(["code.yaml", codeData()]), GUARDS);
    expect(Object.getPrototypeOf(contracts?.states)).toBeNull();
  });

  it("rejects a non-object root with one clear problem", () => {
    expect(validateContracts(null, GUARDS).problems).toEqual([
      "contracts must be an object",
    ]);
  });
});
