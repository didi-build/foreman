import { describe, expect, it } from "vitest";
import { parseClaudeResult } from "./claude-code.ts";
import { cursorStatus } from "./cursor.ts";
import { parseVerdict } from "./qa-verdict.ts";

describe("Claude Code result parsing (unit: spike M0.2)", () => {
  it("maps a success result", () => {
    const out = JSON.stringify({
      subtype: "success",
      is_error: false,
      result: "done",
      num_turns: 3,
      total_cost_usd: 0.02,
    });
    expect(parseClaudeResult(out)).toEqual({
      status: "success",
      finalText: "done",
      turns: 3,
      costUsd: 0.02,
    });
  });

  it.each([
    ["error_max_turns", "max_turns"],
    ["error_max_budget_usd", "budget"],
    ["error_during_execution", "error"],
  ])("maps %s to %s", (subtype, status) => {
    expect(
      parseClaudeResult(JSON.stringify({ subtype, is_error: true, errors: ["x"] }))
        .status,
    ).toBe(status);
  });

  it("treats success with is_error true as an error", () => {
    expect(
      parseClaudeResult(JSON.stringify({ subtype: "success", is_error: true })).status,
    ).toBe("error");
  });

  it("treats output that is not JSON as an error", () => {
    expect(parseClaudeResult("not json").status).toBe("error");
  });
});

describe("QA verdict validation (unit: spike M0.2)", () => {
  const head = "abc123";

  it("accepts a well-formed verdict for the head commit", () => {
    const content = JSON.stringify({
      verdict: "fail",
      commit: head,
      findings: ["off by one"],
    });
    expect(parseVerdict(content, head)).toEqual({
      verdict: { verdict: "fail", commit: head, findings: ["off by one"] },
    });
  });

  it("rejects a verdict for another commit", () => {
    const content = JSON.stringify({ verdict: "pass", commit: "old", findings: [] });
    expect(parseVerdict(content, head).problem).toBe(
      "verdict does not name the head commit",
    );
  });

  it.each([
    [undefined, "no message content"],
    ["not json", "content is not JSON"],
    [
      JSON.stringify({ verdict: "maybe", commit: head, findings: [] }),
      "verdict is not pass or fail",
    ],
    [
      JSON.stringify({ verdict: "pass", commit: head, findings: [1] }),
      "findings is not a list of strings",
    ],
  ])("rejects %s", (content, problem) => {
    expect(parseVerdict(content, head).problem).toBe(problem);
  });
});

describe("Cursor status reading (unit: spike M0.2)", () => {
  it("reads the status field and falls back to UNKNOWN", () => {
    expect(cursorStatus({ status: "FINISHED" })).toBe("FINISHED");
    expect(cursorStatus("oops")).toBe("UNKNOWN");
  });
});
