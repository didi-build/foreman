// A fake of the weekly model test's ports in the flow (flows/lib/model-eval.ts): a Job port that
// records what it is asked and answers what a test sets, a key reader that hands out made-up keys
// and records each path it reads, and a case list. Nothing reaches a cluster, Windmill or a model.
import { randomBytes } from "node:crypto";

import type { ModelEvalPorts } from "../../flows/lib/model-eval.ts";
import type {
  EvalCaseRef,
  EvalJobCollect,
  EvalJobSpec,
} from "../../src/core/model-eval.ts";

/** The test set's cases as the bundle holds them today (eval/cases/). */
export const FAKE_EVAL_CASES: EvalCaseRef[] = [
  { id: "council-answer-in-plan", role: "council" },
  { id: "council-product-decision", role: "council" },
  { id: "qa-format-duration-fake-key", role: "qa" },
  { id: "qa-format-duration-pass", role: "qa" },
  { id: "qa-slugify-pass", role: "qa" },
  { id: "qa-slugify-skipped-test", role: "qa" },
  { id: "qa-truncate-off-by-one", role: "qa" },
  { id: "qa-truncate-pass", role: "qa" },
  { id: "qa-truncate-readme-change", role: "qa" },
  { id: "triage-helper-then-page", role: "triage" },
  { id: "triage-slugify-plan", role: "triage" },
  { id: "triage-truncate-plan", role: "triage" },
];

export interface FakeModelEval extends ModelEvalPorts {
  started: { spec: EvalJobSpec; keys: Record<string, string> }[];
  /** Each path the key reader was asked for, in order. */
  keyReads: string[];
  /** The made-up key handed out for each path, generated per test run. */
  keyValues: Map<string, string>;
  /** What `collect` answers for a Job; running when unset. */
  collects: Map<string, EvalJobCollect>;
  collected: { jobId: string; boundAt: Date }[];
  removed: string[];
  pinned: boolean;
  failNext: Set<"start" | "collect" | "remove" | "key">;
  caseList: EvalCaseRef[];
}

export function createFakeModelEval(): FakeModelEval {
  const fail = (step: "start" | "collect" | "remove" | "key") => {
    if (fake.failNext.delete(step)) throw new Error(`the fake refused to ${step}`);
  };
  const fake: FakeModelEval = {
    started: [],
    keyReads: [],
    keyValues: new Map(),
    collects: new Map(),
    collected: [],
    removed: [],
    pinned: true,
    failNext: new Set(),
    caseList: [...FAKE_EVAL_CASES],
    jobs: {
      imagePinned: async () => fake.pinned,
      async start(spec, keys) {
        fail("start");
        fake.started.push({ spec: structuredClone(spec), keys: { ...keys } });
      },
      async collect(jobId, boundAt) {
        fail("collect");
        fake.collected.push({ jobId, boundAt });
        return fake.collects.get(jobId) ?? { state: "running" };
      },
      async remove(jobId) {
        fail("remove");
        fake.removed.push(jobId);
      },
    },
    async key(path) {
      fail("key");
      fake.keyReads.push(path);
      const value =
        fake.keyValues.get(path) ?? `made-up-${randomBytes(12).toString("hex")}`;
      fake.keyValues.set(path, value);
      return value;
    },
    cases: () => [...fake.caseList],
  };
  return fake;
}

/** Ports for a flow test that never reaches the weekly test: every call throws. */
export function unusedModelEval(): ModelEvalPorts {
  const notUsed = async (): Promise<never> => {
    throw new Error("this flow runs no weekly model test");
  };
  return {
    jobs: { imagePinned: notUsed, start: notUsed, collect: notUsed, remove: notUsed },
    key: notUsed,
    cases: () => {
      throw new Error("this flow runs no weekly model test");
    },
  };
}
