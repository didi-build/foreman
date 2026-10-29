// Seam: unit tests of the contracts validator (ADR 0105). The validator must collect every
// problem in one call, so a broken file shows all its fixes at once.
import { describe, expect, it } from "vitest";

import { validateContracts } from "./contracts.ts";

const GUARDS = ["blockers_done", "approval_recorded"];

const state = (label: string, extra: Record<string, unknown> = {}) => ({
  label,
  owner: "Runner",
  ...extra,
});

const base = () => ({
  version: "a".repeat(40),
  contentHash: "b".repeat(64),
  states: {
    ready: state("Ready", { initial: true }),
    working: state("Working"),
    escalated_to_council: state("Escalated to Council", {
      escalated: true,
      requires_blocked_reason: true,
    }),
  },
  transitions: [
    { from: "ready", to: "working", tracks: ["code"], guards: ["blockers_done"] },
  ],
});

describe("validateContracts (unit: contracts validator, ADR 0105)", () => {
  it("accepts a well-formed object and maps snake_case fields", () => {
    const raw = base();
    raw.states.ready = state("Ready", {
      initial: true,
      requires_blocked_reason: true,
      evidence_to_exit: "A dispatch record.",
      side_effects: "None.",
      budget: "not set",
    });
    const result = validateContracts(raw, GUARDS);
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
  });

  it("collects every problem in one call", () => {
    const raw = base();
    raw.transitions = [
      // Unknown state, unregistered guard, any outside escalation, all in one file.
      { from: "nowhere", to: "working", guards: ["not_a_guard"] },
      { from: "any", to: "working", guards: [] },
      { from: "working", to: "return", guards: [] },
      { from: "ready", to: "working", tracks: ["code"], guards: [] },
      { from: "ready", to: "working", tracks: ["code", "docs"], guards: [] },
    ] as never;
    const { contracts, problems } = validateContracts(raw, GUARDS);
    expect(contracts).toBeUndefined();
    expect(problems.join("\n")).toContain("unknown state nowhere");
    expect(problems.join("\n")).toContain("guard not_a_guard is not registered");
    expect(problems.filter((p) => p.includes("only for escalation.yaml"))).toHaveLength(
      2,
    );
    expect(problems.join("\n")).toContain("duplicate move ready to working");
  });

  it("allows any and return on escalation transitions only", () => {
    const raw = base();
    raw.transitions = [
      { from: "any", to: "escalated_to_council", guards: [], escalation: true },
      { from: "escalated_to_council", to: "return", guards: [], escalation: true },
    ] as never;
    expect(validateContracts(raw, GUARDS).problems).toEqual([]);
  });

  it("rejects any as a target and return as a source even under escalation", () => {
    const raw = base();
    raw.transitions = [
      { from: "return", to: "working", guards: [], escalation: true },
      { from: "ready", to: "any", guards: [], escalation: true },
    ] as never;
    const { problems } = validateContracts(raw, GUARDS);
    expect(problems.filter((p) => p.includes("only a target"))).toHaveLength(2);
  });

  it("requires labels, owners, snake_case ids and known tracks and evidence kinds", () => {
    const raw = base();
    (raw.states as Record<string, unknown>)["Bad-Id"] = { label: "", owner: "" };
    raw.transitions = [
      {
        from: "ready",
        to: "working",
        guards: [],
        tracks: ["web"],
        evidence: ["vibes"],
      },
    ] as never;
    const { problems } = validateContracts(raw, GUARDS);
    expect(problems.join("\n")).toContain("state id Bad-Id");
    expect(problems.join("\n")).toContain("needs a label");
    expect(problems.join("\n")).toContain("needs an owner");
    expect(problems.join("\n")).toContain("tracks must be a non-empty list");
    expect(problems.join("\n")).toContain("evidence must list known evidence kinds");
  });

  it("does not call moves on disjoint tracks duplicates", () => {
    const raw = base();
    raw.transitions = [
      { from: "ready", to: "working", tracks: ["code"], guards: [] },
      { from: "ready", to: "working", tracks: ["design"], guards: [] },
    ] as never;
    expect(validateContracts(raw, GUARDS).problems).toEqual([]);
  });

  it("rejects a non-object root with one clear problem", () => {
    expect(validateContracts(null, GUARDS).problems).toEqual([
      "contracts must be an object",
    ]);
  });
});
