import { describe, expect, it } from "vitest";

import { CEILING_MESSAGE } from "../../../egress-proxy/proxy.ts";
import type { JobStatus } from "./objects.ts";
import { jobMinutes, jobState, mapRunEnd, parseAgentResult } from "./result.ts";

// Unit: the agent's result line and the outcome mapping (ADR 0106 section 6, ADR 0107).

const line = (fields: Record<string, unknown>): string =>
  JSON.stringify({ foremanResult: 1, ...fields });

const JOB: JobStatus = {
  metadata: { name: "run-x-agent" },
  status: { startTime: "2026-10-30T12:00:00Z", completionTime: "2026-10-30T12:12:30Z" },
};

describe("parseAgentResult (unit: defensive parsing)", () => {
  it("reads the last result line and its fields", () => {
    const log = [
      "starting",
      line({ status: "error" }),
      line({
        status: "success",
        finalText: "done",
        turns: 3,
        costUsd: 0.02,
        tokens: {
          uncachedInput: 10,
          cachedInput: 900,
          cacheWriteInput: 50,
          output: 120,
        },
        structured: { verdict: "pass" },
      }),
      "",
    ].join("\n");
    expect(parseAgentResult(log)).toEqual({
      status: "success",
      finalText: "done",
      structured: { verdict: "pass" },
      turns: 3,
      costUsd: 0.02,
      tokens: { uncachedInput: 10, cachedInput: 900, cacheWriteInput: 50, output: 120 },
      errorText: "",
      providerError: null,
    });
  });

  it.each([
    ["no log", null],
    ["an empty log", ""],
    ["plain text", "Segmentation fault"],
    ["broken JSON", '{"foremanResult":1,"status":'],
    ["a JSON array", "[1,2,3]"],
    ["no version marker", JSON.stringify({ status: "success" })],
    ["a later version", JSON.stringify({ foremanResult: 2, status: "success" })],
    ["an unknown status", line({ status: "great" })],
    ["a status that is not a string", line({ status: 1 })],
  ])("returns null, never throws, for %s", (_label, log) => {
    expect(parseAgentResult(log)).toBeNull();
  });

  it("drops fields of the wrong type instead of failing", () => {
    const result = parseAgentResult(
      line({
        status: "success",
        finalText: 7,
        turns: -1,
        costUsd: "a lot",
        tokens: { uncachedInput: 1.5, cachedInput: 0, output: 0 },
        providerError: "429",
      }),
    );
    expect(result).toMatchObject({
      finalText: "",
      turns: null,
      costUsd: null,
      tokens: null,
      providerError: null,
    });
  });

  it("caps the final text", () => {
    const result = parseAgentResult(
      line({ status: "success", finalText: "x".repeat(100_000) }),
    );
    expect(result?.finalText.length).toBe(64 * 1024);
  });
});

describe("jobState (unit: Job conditions)", () => {
  const withCondition = (type: string, reason?: string): JobStatus => ({
    metadata: { name: "j" },
    status: { conditions: [{ type, status: "True", reason }] },
  });

  it.each<[string, JobStatus | null, string]>([
    ["no Job", null, "gone"],
    ["no conditions", { metadata: { name: "j" } }, "running"],
    [
      "FailureTarget, pods still stopping",
      withCondition("FailureTarget", "DeadlineExceeded"),
      "running",
    ],
    ["Complete", withCondition("Complete"), "complete"],
    ["Failed on the deadline", withCondition("Failed", "DeadlineExceeded"), "deadline"],
    ["Failed otherwise", withCondition("Failed", "BackoffLimitExceeded"), "failed"],
    [
      "being deleted",
      { metadata: { name: "j", deletionTimestamp: "2026-10-30T12:00:00Z" } },
      "stopping",
    ],
  ])("%s is %s", (_label, job, state) => {
    expect(jobState(job)).toBe(state);
  });

  it("reads minutes from the Job's own times", () => {
    expect(jobMinutes(JOB)).toBe(12.5);
    expect(jobMinutes({ metadata: { name: "j" } })).toBeNull();
  });
});

describe("mapRunEnd (unit: outcome mapping, ADR 0106 section 6)", () => {
  const parse = (fields: Record<string, unknown>) => parseAgentResult(line(fields));

  it("maps a Complete Job with a success result to success, with its counts", () => {
    const result = mapRunEnd(
      "complete",
      JOB,
      parse({ status: "success", turns: 3, costUsd: 0.02, finalText: "ok" }),
      "claude-sonnet-5-5",
    );
    expect(result).toEqual({
      outcome: "success",
      detail: "success",
      finalText: "ok",
      turns: 3,
      costUsd: 0.02,
      minutes: 12.5,
      tokens: null,
      model: "claude-sonnet-5-5",
    });
  });

  it("maps the deadline to timeout whatever the output says", () => {
    const result = mapRunEnd("deadline", JOB, parse({ status: "success" }), "m");
    expect(result).toMatchObject({ outcome: "timeout", detail: "deadline_exceeded" });
  });

  it.each([
    ["the runtime's turn cap", { status: "max_turns" }, "max_turns"],
    ["the runtime's dollar cap", { status: "max_budget" }, "max_budget"],
    [
      "the proxy's ceiling in the error text",
      { status: "error", errorText: `API Error: 403 {"error":"${CEILING_MESSAGE}"}` },
      "proxy_ceiling",
    ],
    [
      "the proxy's ceiling in the provider error",
      { status: "error", providerError: { status: 403, message: CEILING_MESSAGE } },
      "proxy_ceiling",
    ],
  ])("maps %s to budget_exceeded", (_label, fields, detail) => {
    expect(mapRunEnd("failed", JOB, parse(fields), "m")).toMatchObject({
      outcome: "budget_exceeded",
      detail,
    });
  });

  it.each([
    [{ status: 429, retryAfterSeconds: 30 }, "rate_limit", 30],
    [{ type: "rate_limit_error" }, "rate_limit", undefined],
    [{ status: 529, type: "overloaded_error" }, "capacity", undefined],
    [{ status: 402 }, "out_of_credit", undefined],
    [{ type: "billing_error" }, "out_of_credit", undefined],
  ])(
    "maps provider error %j to usage_exhausted with its cause",
    (error, cause, retry) => {
      const result = mapRunEnd(
        "failed",
        JOB,
        parse({ status: "error", providerError: error }),
        "m",
      );
      expect(result.outcome).toBe("usage_exhausted");
      expect(result.usageExhaustedCause).toBe(cause);
      expect(result.retryAfterSeconds).toBe(retry);
    },
  );

  it.each<[string, "complete" | "failed", Record<string, unknown> | null, string]>([
    ["bad output", "complete", null, "bad_output"],
    [
      "a Complete Job with an error result",
      "complete",
      { status: "error" },
      "agent_error",
    ],
    [
      "a Failed Job with a success result",
      "failed",
      { status: "success" },
      "job_failed",
    ],
    [
      "another provider error",
      "failed",
      {
        status: "error",
        providerError: { status: 400, type: "invalid_request_error" },
      },
      "job_failed",
    ],
  ])("maps %s to fail", (_label, state, fields, detail) => {
    const result = mapRunEnd(state, JOB, fields === null ? null : parse(fields), "m");
    expect(result).toMatchObject({ outcome: "fail", detail });
    expect(result.usageExhaustedCause).toBeUndefined();
  });

  it("does not take the ceiling message from the agent's final text", () => {
    const result = mapRunEnd(
      "complete",
      JOB,
      parse({ status: "success", finalText: CEILING_MESSAGE }),
      "m",
    );
    expect(result.outcome).toBe("success");
  });
});
