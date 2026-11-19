// Adapter contract: the weekly model test's Job port on Kubernetes (D-432, D-433, O-155, O-156)
// against the in-memory fake client. The Job's log is framed by the image's own result line
// (src/agent-images/shared/result.ts) around a synthetic result, or written by hand for a
// malformed one. No cluster, no network, no model and no real key.
import { beforeEach, describe, expect, it } from "vitest";

import { readBotFiles } from "../../contracts-file/bot-files.ts";
import { errorResult, resultLine } from "../../../agent-images/shared/result.ts";
import { EVAL_RESULT_LOG_BYTES } from "../../../core/model-eval-result.ts";
import {
  evalSizing,
  parseModelEvalSettings,
  weekPlan,
  type EvalJobSpec,
} from "../../../core/model-eval.ts";
import { parseModelCatalog } from "../../../core/routing.ts";
import {
  SEEDED_MODEL_CATALOG,
  SEEDED_MODEL_EVAL,
} from "../../../core/routing-testing.ts";
import { REHEARSAL_RUN_LIMITS } from "../../../core/runs.ts";
import {
  EVAL_TTL_SECONDS,
  EvalJobError,
  createKubernetesEvalJobs,
  evalProviders,
} from "./eval-jobs.ts";
import { createFakeKubernetes, type FakeKubernetes } from "./fake.ts";
import { SETTINGS } from "./fixtures.ts";
import type { KubernetesRunSettings } from "./manifests.ts";
import { EVAL_NAMESPACE, LABEL_PROJECT, evalNames } from "./names.ts";
import type { EnvVar, Job, NetworkPolicy, Secret } from "./objects.ts";

const NS = EVAL_NAMESPACE;
const JOB_ID = "7e5a0000-0000-4000-8000-000000000001";
const n = evalNames(JOB_ID);
const EVAL_IMAGE = `registry.example.com/foreman/eval@sha256:${"f".repeat(64)}`;
const DEEPINFRA_KEY = "deepinfra-key-not-real-0123456789";
const ANTHROPIC_KEY = "anthropic-key-not-real-0123456789";
const KEYS = {
  "eval/models/deepinfra": DEEPINFRA_KEY,
  "eval/models/anthropic": ANTHROPIC_KEY,
};
const bots = readBotFiles();

const problems: string[] = [];
const settings = parseModelEvalSettings(SEEDED_MODEL_EVAL, problems);
const catalog = parseModelCatalog(SEEDED_MODEL_CATALOG, problems);
if (!settings || !catalog) throw new Error(problems.join("; "));

/** The week's spec, as the weekly flow builds it: with or without Claude's baseline. */
function spec(baseline = true): EvalJobSpec {
  const { entries } = weekPlan(settings as never, catalog as never, baseline);
  const cases = [
    { id: "council-answer-in-plan", role: "council" as const },
    { id: "qa-truncate-pass", role: "qa" as const },
    { id: "triage-truncate-plan", role: "triage" as const },
  ];
  const sizing = evalSizing(cases, entries, (role) => REHEARSAL_RUN_LIMITS[role], {
    flexCapacityRetries: 3,
    maxRejectedModelRequests: 6,
  });
  if (!sizing) throw new Error("no sizing");
  return {
    jobId: JOB_ID,
    entries,
    caseIds: cases.map((c) => c.id),
    capUsd: 10,
    spentBeforeUsd: 0,
    sizing,
    flexCapacityRetries: 3,
    keyPaths: baseline
      ? { deepinfra: "eval/models/deepinfra", anthropic: "eval/models/anthropic" }
      : { deepinfra: "eval/models/deepinfra" },
  };
}

/** A synthetic checked result for the Job. */
const structured = () => ({
  evalResult: 1,
  runId: JOB_ID,
  capUsd: 10,
  spentBeforeUsd: 0,
  runs: [
    {
      caseId: "qa-truncate-pass",
      caseVersion: 1,
      role: "qa",
      model: "deepseek-ai/DeepSeek-V4-Pro-0813",
      provider: "deepinfra",
      tier: "flex",
      outcome: "correct",
      reason: "as_expected",
      turns: 4,
      tokens: { uncachedInput: 1, cachedInput: 0, cacheWriteInput: 0, output: 1 },
      costUsd: 0.01,
      serviceTierServed: "flex",
      minutes: 1,
      facts: { verdict: "pass", findingPaths: [] },
    },
  ],
  totals: {
    spentUsd: 0.01,
    runs: 1,
    skipped: 0,
    models: [
      {
        model: "deepseek-ai/DeepSeek-V4-Pro-0813",
        provider: "deepinfra",
        runs: 1,
        correct: 1,
        costUsd: 0.01,
      },
    ],
  },
});
const successLog = (value: unknown = structured()) =>
  [
    '{"level":"info","msg":"run ended"}',
    resultLine(
      { ...errorResult(""), status: "success", costUsd: 0.01, structured: value },
      [],
    ),
  ].join("\n");

let fake: FakeKubernetes;
let clock: number;
let clusterReads: number;
let runSettings: KubernetesRunSettings;

const jobs = () =>
  createKubernetesEvalJobs({
    cluster: async () => {
      clusterReads += 1;
      return { client: fake, settings: runSettings };
    },
    bots,
    now: () => clock,
  });

beforeEach(() => {
  fake = createFakeKubernetes();
  clock = Date.parse("2026-11-22T07:17:00Z");
  clusterReads = 0;
  runSettings = { ...SETTINGS, evalImage: EVAL_IMAGE };
});

const envOf = (job: Job): EnvVar[] => job.spec.template.spec.containers[0]?.env ?? [];
const plain = (job: Job): Record<string, string> =>
  Object.fromEntries(
    envOf(job).flatMap((e) => ("value" in e ? [[e.name, e.value]] : [])),
  );

describe("starting the weekly test's Job (adapter: fake cluster, D-432, D-433)", () => {
  it("creates the key Secret, the policies, the proxy and the Job in the weekly test's namespace, in order", async () => {
    await jobs().start(spec(), KEYS);
    expect(fake.calls).toEqual([
      `create Secret/${n.modelSecret}`,
      `create NetworkPolicy/${n.policy}`,
      `create NetworkPolicy/${n.proxyPolicy}`,
      `create Job/${n.proxyJob}`,
      `create Service/${n.proxyService}`,
      `create Job/${n.job}`,
    ]);
    for (const object of fake.objects.values()) {
      expect(object.metadata.namespace).toBe(NS);
      // No project: the state API's ingress, which needs one, never admits these pods.
      expect(object.metadata.labels?.[LABEL_PROJECT]).toBeUndefined();
    }
  });

  it("gives the proxy only the plan's providers, each with its eval key path, and a week's ceiling", async () => {
    const s = spec();
    await jobs().start(s, KEYS);
    const proxy = plain(fake.get<Job>("Job", NS, n.proxyJob) as Job);
    expect(JSON.parse(proxy.MODEL_PROVIDERS ?? "")).toEqual([
      {
        name: "deepinfra",
        upstream: "https://api.deepinfra.com/anthropic",
        credential: "x-api-key",
        secretPath: "eval/models/deepinfra",
      },
      {
        name: "anthropic",
        upstream: "https://api.anthropic.com",
        credential: "x-api-key",
        secretPath: "eval/models/anthropic",
      },
    ]);
    expect(proxy).toMatchObject({
      ALLOWED_HOSTS: "",
      STATE_API_UPSTREAM: "",
      MAX_MODEL_REQUESTS: String(s.sizing.maxModelRequests),
      MAX_REJECTED_MODEL_REQUESTS: String(s.sizing.maxRejectedModelRequests),
    });
    // 3 cases, each on the 3 weekly models and its Claude model.
    expect(s.sizing.runs).toBe(12);
    // The keys come from the Secret by reference, never as values.
    const proxyEnv = envOf(fake.get<Job>("Job", NS, n.proxyJob) as Job);
    expect(proxyEnv.filter((e) => "valueFrom" in e)).toEqual([
      {
        name: "SECRET_EVAL_MODELS_DEEPINFRA",
        valueFrom: {
          secretKeyRef: { name: n.modelSecret, key: "SECRET_EVAL_MODELS_DEEPINFRA" },
        },
      },
      {
        name: "SECRET_EVAL_MODELS_ANTHROPIC",
        valueFrom: {
          secretKeyRef: { name: n.modelSecret, key: "SECRET_EVAL_MODELS_ANTHROPIC" },
        },
      },
    ]);
    const secret = fake.get<Secret>("Secret", NS, n.modelSecret);
    expect(secret?.stringData).toEqual({
      SECRET_EVAL_MODELS_DEEPINFRA: DEEPINFRA_KEY,
      SECRET_EVAL_MODELS_ANTHROPIC: ANTHROPIC_KEY,
    });
  });

  it("holds a key in the Secret only: never in a Job, a policy or a Service", async () => {
    await jobs().start(spec(), KEYS);
    for (const object of fake.objects.values()) {
      if (object.kind === "Secret") continue;
      const text = JSON.stringify(object);
      expect(text).not.toContain(DEEPINFRA_KEY);
      expect(text).not.toContain(ANTHROPIC_KEY);
    }
  });

  it("gives the Job the plan, the cases, the cap, the spend so far and each provider's address on the proxy", async () => {
    const s = spec();
    await jobs().start(s, KEYS);
    const job = fake.get<Job>("Job", NS, n.job) as Job;
    const env = plain(job);
    const proxyIp = env.NO_PROXY ?? "";
    expect(env).toMatchObject({
      FOREMAN_RUN_ID: JOB_ID,
      FOREMAN_EVAL_CASES:
        "council-answer-in-plan,qa-truncate-pass,triage-truncate-plan",
      FOREMAN_EVAL_CAP_USD: "10",
      FOREMAN_EVAL_SPENT_USD: "0",
      FOREMAN_FLEX_CAPACITY_RETRIES: "3",
      HTTPS_PROXY: `http://${proxyIp}:8080`,
    });
    expect(JSON.parse(env.FOREMAN_MODEL_BASE_URLS ?? "")).toEqual({
      deepinfra: `http://${proxyIp}:8080/deepinfra`,
      anthropic: `http://${proxyIp}:8080/anthropic`,
    });
    const plan = JSON.parse(env.FOREMAN_EVAL_PLAN ?? "") as Record<string, unknown>[];
    expect(plan.map((e) => [e.model, e.provider, e.tier, e.roles])).toEqual([
      [
        "deepseek-ai/DeepSeek-V4-Pro-0813",
        "deepinfra",
        "flex",
        ["qa", "triage", "council"],
      ],
      [
        "deepseek-ai/DeepSeek-V4.1-Flash-1017",
        "deepinfra",
        "flex",
        ["qa", "triage", "council"],
      ],
      ["moonshotai/Kimi-K2.6", "deepinfra", "flex", ["qa", "triage", "council"]],
      ["claude-opus-5-5", "anthropic", "standard", ["qa"]],
      ["claude-sonnet-5-5", "anthropic", "standard", ["triage", "council"]],
    ]);
    expect(plan.every((e) => !("baseline" in e))).toBe(true);
    expect(envOf(job).some((e) => "valueFrom" in e)).toBe(false);
    expect(job.spec.template.spec.containers[0]?.image).toBe(EVAL_IMAGE);
    expect(job.spec.activeDeadlineSeconds).toBe(s.sizing.deadlineMinutes * 60);
    expect(job.spec.ttlSecondsAfterFinished).toBe(EVAL_TTL_SECONDS);
    expect(job.spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(job.spec.template.spec.containers[0]?.resources).toEqual(
      SETTINGS.resources.agent,
    );
  });

  it("reaches only the proxy from the Job, and only public 443 and DNS from the proxy: no state API", async () => {
    await jobs().start(spec(), KEYS);
    const client = fake.get<NetworkPolicy>(
      "NetworkPolicy",
      NS,
      n.policy,
    ) as NetworkPolicy;
    expect(client.spec.egress).toHaveLength(1);
    expect(client.spec.ingress).toEqual([]);
    const proxy = fake.get<NetworkPolicy>(
      "NetworkPolicy",
      NS,
      n.proxyPolicy,
    ) as NetworkPolicy;
    expect(proxy.spec.egress).toHaveLength(2);
    expect(JSON.stringify(proxy.spec.egress)).not.toContain(
      SETTINGS.stateApi.namespace,
    );
  });

  it("reads only the deepinfra key in a week without Claude", async () => {
    await jobs().start(spec(false), { "eval/models/deepinfra": DEEPINFRA_KEY });
    const secret = fake.get<Secret>("Secret", NS, n.modelSecret);
    expect(Object.keys(secret?.stringData ?? {})).toEqual([
      "SECRET_EVAL_MODELS_DEEPINFRA",
    ]);
  });

  it("creates nothing without a pinned image, a needed key or a provider the bot files list", async () => {
    runSettings = { ...SETTINGS };
    await expect(jobs().start(spec(), KEYS)).rejects.toThrow(
      /eval image is not pinned/,
    );
    runSettings = { ...SETTINGS, evalImage: EVAL_IMAGE };
    await expect(
      jobs().start(spec(), { "eval/models/deepinfra": DEEPINFRA_KEY }),
    ).rejects.toThrow(/key for provider anthropic is missing/);
    const strange = spec();
    strange.entries = [{ ...strange.entries[0]!, provider: "elsewhere" }];
    await expect(jobs().start(strange, KEYS)).rejects.toThrow(EvalJobError);
    expect(fake.calls).toEqual([]);
    expect(() =>
      evalProviders({ entries: spec().entries, keyPaths: {} }, bots),
    ).toThrow(/has no key path/);
  });

  it("deletes every object it made when a create fails, and reports the create's error", async () => {
    fake.failNextCreate("Job", 403, "Forbidden");
    await expect(jobs().start(spec(), KEYS)).rejects.toThrow(/create Job/);
    expect(fake.objects.size).toBe(0);
    expect(fake.calls.filter((c) => c.startsWith("delete"))).toEqual([
      `delete Job/${n.job}`,
      `delete Job/${n.proxyJob}`,
      `delete Service/${n.proxyService}`,
      `delete NetworkPolicy/${n.policy}`,
      `delete NetworkPolicy/${n.proxyPolicy}`,
      `delete Secret/${n.modelSecret}`,
    ]);
  });
});

describe("reading the weekly test's Job (adapter: fake cluster, O-156)", () => {
  const bound = () => new Date(clock + 60_000);

  it("leaves a running Job as it is before its bound, and reads no log", async () => {
    await jobs().start(spec(), KEYS);
    fake.calls.length = 0;
    expect(await jobs().collect(JOB_ID, bound())).toEqual({ state: "running" });
    expect(fake.calls).toEqual([`get Job/${n.job}`]);
    expect(fake.has("Secret", NS, n.modelSecret)).toBe(true);
  });

  it("stops a Job still running past its bound, its key and proxy with it", async () => {
    await jobs().start(spec(), KEYS);
    const at = bound();
    clock += 120_000;
    expect(await jobs().collect(JOB_ID, at)).toMatchObject({
      state: "failed",
      reason: "did_not_end",
    });
    expect(fake.has("Job", NS, n.job)).toBe(false);
    expect(fake.has("Secret", NS, n.modelSecret)).toBe(false);
    expect(fake.has("Job", NS, n.proxyJob)).toBe(false);
  });

  it("deletes the key Secret and the proxy once the Job ended, before it reads the log, bounded", async () => {
    await jobs().start(spec(), KEYS);
    fake.finishJob(NS, n.job, { condition: "Complete", log: successLog() });
    fake.calls.length = 0;
    const read = await jobs().collect(JOB_ID, bound());
    expect(read).toEqual({ state: "finished", result: structured() });
    expect(fake.calls).toEqual([
      `get Job/${n.job}`,
      `delete Secret/${n.modelSecret}`,
      `delete Job/${n.proxyJob}`,
      "list Pod",
      `log Pod/${n.job}-abcde`,
    ]);
    // The Job and its log stay until the flow has stored the result and removes them.
    expect(fake.has("Job", NS, n.job)).toBe(true);
  });

  it("reads at most EVAL_RESULT_LOG_BYTES of the log", async () => {
    await jobs().start(spec(), KEYS);
    const reads: { limitBytes: number; tailLines: number }[] = [];
    const readPodLog = fake.readPodLog.bind(fake);
    fake.readPodLog = async (namespace, pod, options) => {
      reads.push({ limitBytes: options.limitBytes, tailLines: options.tailLines });
      return readPodLog(namespace, pod, options);
    };
    fake.finishJob(NS, n.job, { condition: "Complete", log: successLog() });
    await jobs().collect(JOB_ID, bound());
    expect(reads).toEqual([{ limitBytes: EVAL_RESULT_LOG_BYTES, tailLines: 5 }]);
  });

  it.each([
    [
      "a result that fails the check",
      {
        condition: "Complete" as const,
        log: successLog({ ...structured(), runs: "x" }),
      },
      { state: "failed", reason: "bad_result" },
    ],
    [
      "a line that is no result",
      { condition: "Complete" as const, log: "the job printed this" },
      { state: "failed", reason: "job_failed", detail: null },
    ],
    [
      "an error result, its text kept as plain words",
      {
        condition: "Failed" as const,
        log: resultLine(errorResult("the egress proxy never answered <script>"), []),
      },
      {
        state: "failed",
        reason: "job_failed",
        detail: "the egress proxy never answered  script",
      },
    ],
    [
      "a Job past its deadline",
      { condition: "Failed" as const, reason: "DeadlineExceeded" },
      { state: "failed", reason: "deadline", detail: null },
    ],
  ])("refuses %s, the key gone first", async (_label, end, expected) => {
    await jobs().start(spec(), KEYS);
    fake.finishJob(NS, n.job, end);
    const read = await jobs().collect(JOB_ID, bound());
    expect(read).toMatchObject(expected);
    expect(fake.has("Secret", NS, n.modelSecret)).toBe(false);
  });

  it("says a Job deleted before it was read is gone, and deletes what is left of it", async () => {
    await jobs().start(spec(), KEYS);
    await fake.delete("Job", NS, n.job);
    expect(await jobs().collect(JOB_ID, bound())).toEqual({
      state: "failed",
      reason: "job_gone",
      detail: null,
    });
    await jobs().remove(JOB_ID);
    expect(fake.objects.size).toBe(0);
  });

  it("removes every object, Jobs first, and finds nothing left to remove the second time", async () => {
    await jobs().start(spec(), KEYS);
    fake.calls.length = 0;
    await jobs().remove(JOB_ID);
    expect(fake.objects.size).toBe(0);
    expect(fake.calls[0]).toBe(`delete Job/${n.job}`);
    await expect(jobs().remove(JOB_ID)).resolves.toBeUndefined();
  });

  it("says whether the image is pinned, from the run settings", async () => {
    expect(await jobs().imagePinned()).toBe(true);
    runSettings = { ...SETTINGS };
    expect(await jobs().imagePinned()).toBe(false);
    expect(clusterReads).toBe(2);
  });
});
