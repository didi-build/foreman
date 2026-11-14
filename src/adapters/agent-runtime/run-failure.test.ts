// What a failed run keeps of its cause (D-385, ./run-failure.ts). Unit: the fixed sentences
// built as the images build them, and made-up text that must not be kept.
import { describe, expect, it } from "vitest";
import { FINISH_FAILURES } from "../../agent-images/opencode/finish.ts";
import { CEILING_MESSAGE, REJECTED_CEILING_MESSAGE } from "../../egress-proxy/proxy.ts";
import { readConfig, text } from "../../service-kit/config.ts";
import { FIXED_RUN_ERROR_STARTS, fixedRunError, runFailure } from "./run-failure.ts";

const configError = (env: NodeJS.ProcessEnv): string => {
  try {
    readConfig(
      {
        model: text("FOREMAN_MODEL"),
        price: {
          env: "FOREMAN_RUN_PRICE",
          parse: () => {
            throw new Error("is not a run price");
          },
        },
      },
      env,
    );
  } catch (error) {
    return error instanceof Error ? error.message : "";
  }
  return "";
};

describe("a failed run's cause (unit: run-failure.ts, D-385)", () => {
  it.each([
    "the run reached its turn limit",
    "the run reached its dollar limit",
    "the model endpoint could not be reached",
    "the model provider answered 401",
    "the model's reply reached the output token limit",
    "the model declined the request",
    "the model stopped for an unknown reason",
    "the answer is not JSON",
    "the state API could not be reached to record the verdict",
    "the state API refused the verdict with status 403",
    "a visual comparison task needs its answer schema",
    "the run failed",
    "the run failed before Claude Code started",
    "Claude Code exited with code 1 and printed no result",
    "Claude Code ended with error_during_execution",
    "the run reached its dollar cap; OpenCode was stopped",
    "OpenCode exited with a signal before any model step",
    "OpenCode printed no model step",
    CEILING_MESSAGE,
    REJECTED_CEILING_MESSAGE,
  ])("keeps the fixed sentence %j whole", (sentence) => {
    expect(fixedRunError(sentence)).toBe(sentence);
  });

  it("keeps the settings reader's message, which names settings and never their values", () => {
    const message = configError({ FOREMAN_RUN_PRICE: "made-up" });
    expect(message).toBe(
      "Invalid configuration: FOREMAN_MODEL is not set; FOREMAN_RUN_PRICE is not a run price",
    );
    expect(fixedRunError(message)).toBe(message);
  });

  it("keeps only the fixed start of a sentence that ends with the model's or a check's words", () => {
    expect(FIXED_RUN_ERROR_STARTS).toEqual(
      expect.arrayContaining(Object.values(FINISH_FAILURES)),
    );
    expect(fixedRunError(`${FINISH_FAILURES.report}: made-up words`)).toBe(
      FINISH_FAILURES.report,
    );
    expect(fixedRunError("the verdict is unusable: made-up problem")).toBe(
      "the verdict is unusable",
    );
  });

  it.each([
    "made-up words from the model",
    "fetch failed",
    "the model provider answered 401 with sk-made-up",
    "Invalid configuration: FOREMAN_MODEL is sk-ant-MadeUpValue",
    "the run reached its turn limit\nand more",
    "the verdict is unusablemade-up",
    "",
  ])("keeps nothing of %j", (text) => {
    expect(fixedRunError(text)).toBeUndefined();
  });

  it("keeps the provider's status and type, never its message, and checks both", () => {
    expect(
      runFailure("the model provider answered 401", {
        status: 401,
        type: "authentication_error",
      }),
    ).toEqual({
      providerStatus: 401,
      providerType: "authentication_error",
      error: "the model provider answered 401",
    });
    expect(runFailure("", { status: 99, type: "Not A Type" })).toEqual({});
    expect(runFailure("", { status: null, type: "" })).toEqual({});
    expect(runFailure("made-up words", null)).toEqual({});
  });
});
