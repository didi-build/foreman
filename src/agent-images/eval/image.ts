// The weekly test job (ADR 0117, D-427, D-432): run every planned case of the weekly model test
// set on every planned model, through the job's egress proxy, score each answer with the
// runner's own checks, keep the week inside its dollar cap, and print one result line. It runs as
// a Kubernetes Job behind an egress proxy, as the repo map Job and the agent runs do: the proxy
// adds each provider's key, so this image holds none, and every model call keeps the proxy's
// request ceiling, 429 count and served-tier reading (D-423). It touches no repository, writes
// nothing anywhere but its log, and reads only the files its image holds: the cases
// (eval/cases/), the bot files (contracts/bots/) and the persona files each run's instructions are
// composed with (contracts/personas/, ADR 0119 slice 2).
//
// Its inputs, all from the environment, each checked before any model call (a problem names the
// setting, never its value):
//
// - FOREMAN_RUN_ID: the job's id, as a run's. Each run's `prompt_cache_key` is `<id>-<n>`, n its
//   place in the job's order, where its provider takes one (O-152).
// - FOREMAN_EVAL_PLAN: the week's plan, a JSON list of entries (./plan.ts): model, provider,
//   tier, the catalog's price for the model, and the case roles it covers.
// - FOREMAN_EVAL_CASES: the case ids to run, separated by commas. Unset or empty: every case.
// - FOREMAN_EVAL_CAP_USD: the weekly cap in US dollars (D-204's setting).
// - FOREMAN_EVAL_SPENT_USD: what earlier runs of the week spent, which counts toward the cap.
//   Unset: 0.
// - FOREMAN_MODEL_BASE_URLS: a JSON object from each provider's name to its address on the
//   proxy, `http://<proxy>:<port>/<provider>`, as a run's `base_url_env` names it.
// - FOREMAN_FLEX_CAPACITY_RETRIES, and optionally FOREMAN_MAX_OUTPUT_TOKENS and FOREMAN_EFFORT:
//   the loop's settings, read with the Messages API image's names, defaults and checks.
//
// Its output is the shared result line, last on stdout (./result.ts): `success` with the week's
// records and totals as `structured`, or `error` with a fixed text when the job could not start.
// Before it, one log line per run (case, model, provider, outcome, reason, cost), never any text
// of an answer. It exits 0 with a `success` line and 1 otherwise, as the repo map Job does.
import {
  readBotFiles,
  type BotFiles,
} from "../../adapters/contracts-file/bot-files.ts";
import { readConfig, type Setting } from "../../service-kit/config.ts";
import { createLogger } from "../../service-kit/logger.ts";
import { EvalCaseError, loadCases, type EvalCase } from "../../eval/cases.ts";
import { buildCaseRun, type CaseRun } from "../../eval/inputs.ts";
import { apiSettings, proxyClient } from "../claude-api/image.ts";
import { realClock, type LoopClock, type MessagesClient } from "../claude-api/loop.ts";
import { matching } from "../shared/job-kit.ts";
import { waitForProxy } from "../shared/proxy-ready.ts";
import {
  errorResult,
  exitCode,
  resultLine,
  type AgentResult,
} from "../shared/result.ts";
import { PLACEHOLDER_CREDENTIAL, RUN_ID, positiveAmount } from "../shared/settings.ts";
import {
  checkPlan,
  parseBaseUrls,
  parseCaseList,
  parsePlan,
  selectCases,
} from "./plan.ts";
import {
  EVAL_RESULT_LOG_BYTES,
  MAX_RUNS,
  checkEvalResult,
  evalTotals,
  type EvalResult,
} from "./result.ts";
import { plannedRuns, runWeek } from "./week.ts";

const { maxOutputTokens, effort, flexCapacityRetries } = apiSettings;

const SETTINGS = {
  runId: matching("FOREMAN_RUN_ID", RUN_ID, "is not a run id"),
  plan: { env: "FOREMAN_EVAL_PLAN", parse: parsePlan } satisfies Setting<unknown>,
  caseIds: {
    env: "FOREMAN_EVAL_CASES",
    fallback: "",
    parse: parseCaseList,
  } satisfies Setting<unknown>,
  capUsd: positiveAmount("FOREMAN_EVAL_CAP_USD"),
  spentBeforeUsd: {
    env: "FOREMAN_EVAL_SPENT_USD",
    fallback: "0",
    parse: (raw: string) => {
      const value = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(value) || value < 0) {
        throw new Error("is not an amount of at least 0");
      }
      return value;
    },
  } satisfies Setting<number>,
  baseUrls: { env: "FOREMAN_MODEL_BASE_URLS", parse: parseBaseUrls } satisfies Setting<
    Record<string, string>
  >,
  maxOutputTokens,
  effort,
  flexCapacityRetries,
};

export interface EvalImageDeps {
  write?: (line: string) => void;
  /** The runs' clock: their minutes and the loop's capacity waits. Tests pass a fake one. */
  clock?: LoopClock;
  /** The wait for the job's egress proxy (O-133). Tests may pass their own. */
  waitForProxy?: (urlOnProxy: string) => Promise<void>;
  /** The client for one run. Tests may pass one that is not the SDK's. */
  client?: (baseUrl: string, deadline: AbortSignal) => MessagesClient;
  /** A run's deadline after `ms`. Tests may pass their own. */
  deadline?: (ms: number) => AbortSignal;
  /**
   * Where the cases, the bot files and the persona files are. The image's own folders unless a
   * test says.
   */
  casesDir?: string;
  botsDir?: string;
  personasDir?: string;
}

/** The SDK client for one run: no retries, the placeholder key, aborted at the run's deadline. */
function deadlineClient(baseUrl: string, deadline: AbortSignal): MessagesClient {
  const sdk = proxyClient(baseUrl);
  return {
    messages: { create: (params) => sdk.messages.create(params, { signal: deadline }) },
  };
}

/**
 * Runs `read`. Its error becomes one that starts with `what`, followed by the error's own message
 * when `named` says that message names only files and fields, as the loaders' and the builders'
 * do.
 */
function reading<T>(
  what: string,
  read: () => T,
  named: (error: unknown) => boolean = (error) => error instanceof Error,
): T {
  try {
    return read();
  } catch (error) {
    const said = named(error) && error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`${what}${said}`);
  }
}

/** Each case's run, built by the runner's builders. A case they refuse stops the job. */
function buildRuns(
  cases: readonly EvalCase[],
  bots: BotFiles,
  all: readonly EvalCase[],
): Map<string, CaseRun> {
  const runs = new Map<string, CaseRun>();
  for (const c of cases) {
    runs.set(
      c.id,
      reading(`the run of case ${c.id} cannot be built`, () =>
        buildCaseRun(c, bots, all),
      ),
    );
  }
  return runs;
}

/** Runs the job; returns its exit code. The result line is the last thing written. */
export async function runEvalImage(
  env: NodeJS.ProcessEnv,
  deps: EvalImageDeps = {},
): Promise<number> {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  // The job holds no credential: the placeholder is still never printed (ADR 0106 section 5).
  const secrets = [PLACEHOLDER_CREDENTIAL];
  let result: AgentResult;
  try {
    const settings = readConfig(SETTINGS, env);
    const bots = reading("the bot files cannot be read", () =>
      readBotFiles(deps.botsDir, deps.personasDir),
    );
    const all = reading(
      "the test cases cannot be read",
      () => loadCases(deps.casesDir),
      (error) => error instanceof EvalCaseError,
    );
    const cases = selectCases(all, settings.caseIds);
    checkPlan(settings.plan, bots, settings.baseUrls);
    const planned = plannedRuns(cases, settings.plan);
    if (planned.length > MAX_RUNS) {
      throw new Error(`the plan has more than ${MAX_RUNS} runs`);
    }
    const runs = buildRuns(cases, bots, all);
    // The proxy may not answer yet when this pod starts (O-133).
    const used = new Set(planned.map(({ entry }) => settings.baseUrls[entry.provider]));
    for (const url of used) await (deps.waitForProxy ?? waitForProxy)(url as string);
    const logger = createLogger("eval-job", write);
    const records = await runWeek({
      runId: settings.runId,
      planned,
      runs,
      bots,
      baseUrls: settings.baseUrls,
      capUsd: settings.capUsd,
      spentBeforeUsd: settings.spentBeforeUsd,
      loop: {
        maxOutputTokens: settings.maxOutputTokens,
        effort: settings.effort,
        flexCapacityRetries: settings.flexCapacityRetries,
      },
      clock: deps.clock ?? realClock,
      client: deps.client ?? deadlineClient,
      deadline: deps.deadline ?? ((ms) => AbortSignal.timeout(ms)),
      onRecord: (r) =>
        logger.info("run ended", {
          caseId: r.caseId,
          model: r.model,
          provider: r.provider,
          outcome: r.outcome,
          reason: r.reason,
          costUsd: r.costUsd,
        }),
    });
    const structured: EvalResult = checkEvalResult({
      evalResult: 1,
      runId: settings.runId,
      capUsd: settings.capUsd,
      spentBeforeUsd: settings.spentBeforeUsd,
      runs: records,
      totals: evalTotals(records, settings.plan),
    });
    result = {
      ...errorResult(""),
      status: "success",
      costUsd: structured.totals.spentUsd,
      structured,
    };
  } catch (error) {
    // Errors name a setting, a file or a field, never a value.
    result = errorResult(
      error instanceof Error ? error.message : "the test job failed",
    );
  }
  let line = resultLine(result, secrets);
  if (Buffer.byteLength(line, "utf8") > EVAL_RESULT_LOG_BYTES) {
    result = errorResult(`the result is larger than ${EVAL_RESULT_LOG_BYTES} bytes`);
    line = resultLine(result, secrets);
  }
  write(line);
  return exitCode(result);
}
