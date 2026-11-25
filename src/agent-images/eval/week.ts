// The week's runs (ADR 0117, D-432): every planned case on every plan entry that covers its role,
// in a fixed order, each run as a real run of its role would go and scored by the runner's own
// checks, inside the week's dollar cap.
//
// - **Order.** Cases in id order, then the plan's entries in order, `RUNS_PER_CASE` runs each.
// - **Each run** gets its task from the runner's builders (`buildCaseRun`, src/eval/inputs.ts)
//   and the Messages API image's frame (`qaReviewFrame`, `structuredFrame`, or for the Council
//   its discussion, below), so QA reads the case's tree with its three read-only tools. Its turn,
//   minute and dollar limits are its role's bot file's, and how its provider takes the answer and
//   a cache key is the bot file's `messages_api` for that provider (O-152), exactly as a real run
//   gets them. It runs the image's loop (`runLoop`) against the provider's address on the job's
//   egress proxy with the placeholder credential; the proxy adds the key, its request ceiling and
//   429 count, and reads the served tier (D-423). The run's id is its `prompt_cache_key` where
//   the provider takes one.
// - **The cap.** The week's spend starts at what earlier runs of the week spent. Before each run,
//   once the spend has reached the cap, the run is recorded as `skipped` (`cap_reached`) and never
//   starts. Otherwise its dollar limit is the smaller of its bot file's and what is left of the
//   cap. The loop stops before a request once a run's cost has reached its limit, so the week
//   passes the cap by at most one request.
// - **The minute limit** is also the run's deadline: past it, the request in flight is aborted
//   and the run ends as `error` (`max_minutes`), as a real run's Job deadline ends it.
// - **The Council** (ADR 0119 slice 6e): each case runs as one discussion through the Messages
//   API image's own `runDiscussion`, on the cast its task carries (src/eval/inputs.ts), exactly as
//   a real Council run does: one model call per persona of the cast, then Product's answer, every
//   call on the run's one budget of turns, minutes and dollars. The answer is scored with the
//   discussion's record beside it. A discussion that ends with a view outside the view schema, or
//   with more refused pull-ins than its record holds, is the model's failure to hold the
//   discussion, so it scores `discussion_rejected` (unusable) with no facts; a chair's answer
//   that is not JSON scores `answer_not_json`, as a run's final text does.
// - **Errors.** A provider error, or any other end of the loop that is not an answer, ends that
//   run as `error` with a fixed reason, and the next run starts. A successful run's final text is
//   scored (`scoreAnswer`).
// - **Context tools.** A case's task lists the context tools its role's bot file declares, as a
//   real run's does (ADR 0119 slice 3c). The cases hold no project records yet (slice 3a's known
//   gap), so the tools run against a stand-in for the state API that has none: each search finds
//   nothing, under the notice "No records yet.", and no item has a history. Calls go through the
//   real client, so the framing, the refusals and the call cap are a real run's.
// - **Documentation lookup.** A case whose task lists documentation hosts (ADR 0119 slice 4b; no
//   bot file declares the lookup yet) gets the real lookup over a stand-in for the proxy's lookup
//   route that is never on the network: every page answers "This page is not available in the
//   weekly model test." So the frame, the URL rules and the limits are a real run's, and no case
//   depends on what a live site says that week.
// - **Browser.** No case has a site to browse (ADR 0119 slice 5c): the case format holds no built
//   site, and a real run gets the browser only when the runner's check of its head gives one. So
//   no case's task has `browser`, QA's frame never names the browser tools here, and the test
//   does not yet measure a QA review with a browser. A known gap (docs/test-plan.md), for a later
//   slice that gives cases a site.
import type { BotFiles } from "../../adapters/contracts-file/bot-files.ts";
import type { EvalCase } from "../../eval/cases.ts";
import type { CaseRun } from "../../eval/inputs.ts";
import { scoreAnswer, type Score } from "../../eval/scoring.ts";
import { DISCUSSION_ERRORS, runDiscussion } from "../claude-api/discussion.ts";
import { qaReviewFrame, structuredFrame } from "../claude-api/image.ts";
import { createWorkspace } from "../claude-api/files.ts";
import { createContextTools, type ContextTools } from "../shared/context-tools.ts";
import { createDocsLookup, type DocsLookup } from "../shared/docs-lookup.ts";
import {
  LOOP_ERRORS,
  runLoop,
  type LoopClock,
  type LoopOptions,
  type MessagesClient,
} from "../claude-api/loop.ts";
import { errorResult, type AgentResult } from "../shared/result.ts";
import type { PlanEntry } from "./plan.ts";
import {
  boundFacts,
  boundProviderError,
  roundUsd,
  type EvalReason,
  type EvalRunRecord,
} from "./result.ts";

/**
 * One run per case and model each week (ADR 0117's open point "One run per case"). If one run
 * proves too noisy to compare models week to week, three, as the vision model test uses.
 */
export const RUNS_PER_CASE = 1;

/** One planned run: a case on a plan entry. */
export interface PlannedRun {
  case: EvalCase;
  entry: PlanEntry;
}

/** Every planned run in the job's order: cases in their order, then entries in the plan's. */
export function plannedRuns(
  cases: readonly EvalCase[],
  plan: readonly PlanEntry[],
): PlannedRun[] {
  return cases.flatMap((c) =>
    plan
      .filter((entry) => entry.roles.includes(c.role))
      .flatMap((entry) =>
        Array.from({ length: RUNS_PER_CASE }, () => ({ case: c, entry })),
      ),
  );
}

export interface WeekOptions {
  runId: string;
  planned: readonly PlannedRun[];
  /** Each case's run, built by the runner's builders, by case id. */
  runs: ReadonlyMap<string, CaseRun>;
  bots: BotFiles;
  /** Each provider's address on the job's egress proxy. */
  baseUrls: Readonly<Record<string, string>>;
  capUsd: number;
  spentBeforeUsd: number;
  /** The loop's settings that are the same for every run (../claude-api/image.ts). */
  loop: Pick<LoopOptions, "maxOutputTokens" | "effort" | "flexCapacityRetries">;
  clock: LoopClock;
  /** The client for one run: the provider's address, and the run's deadline. */
  client: (baseUrl: string, deadline: AbortSignal) => MessagesClient;
  /** The run's deadline after `ms`. */
  deadline: (ms: number) => AbortSignal;
  /** Called after each run, for the job's log. */
  onRecord?: (record: EvalRunRecord) => void;
}

const NO_TOKENS = { uncachedInput: 0, cachedInput: 0, cacheWriteInput: 0, output: 0 };

/** The stand-in state API of a case's context tools: no records in any project. */
export const NO_RECORDS_NOTICE = "No records yet.";
const noRecords: typeof fetch = async (url) =>
  String(url).endsWith("/history")
    ? Response.json({ error: "not found" }, { status: 404 })
    : Response.json({ notice: NO_RECORDS_NOTICE, data: [], truncated: false });

/** A case's context tools: the real client over the stand-in, which is never on the network. */
export function caseContextTools(run: CaseRun): ContextTools {
  return createContextTools({
    stateApiUrl: "http://eval.invalid/state-api",
    token: "the-weekly-test-has-no-state-api-token",
    allowed: run.task.contextTools ?? [],
    fetchImpl: noRecords,
    log: () => undefined,
  });
}

/** The stand-in lookup route's one page, for every URL. */
export const STAND_IN_PAGE = "This page is not available in the weekly model test.";
const noPages: typeof fetch = async () =>
  new Response(STAND_IN_PAGE, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

/**
 * A case's documentation lookup when its task lists hosts: the real client over the stand-in,
 * which is never on the network. None when it lists none.
 */
export function caseDocsLookup(run: CaseRun): DocsLookup | undefined {
  const hosts = run.task.docsLookupHosts ?? [];
  if (hosts.length === 0) return undefined;
  return createDocsLookup({
    lookupUrl: "http://eval.invalid/lookup",
    hosts,
    secrets: [],
    fetchImpl: noPages,
    log: () => undefined,
  });
}

/** The loop's fixed error texts, by reason. */
const LOOP_REASONS: Record<string, EvalReason> = {
  [LOOP_ERRORS.unreachable]: "endpoint_unreachable",
  [LOOP_ERRORS.outputLimit]: "output_limit",
  [LOOP_ERRORS.refused]: "refused",
  [LOOP_ERRORS.unknownStop]: "unknown_stop",
};

/**
 * How a Council discussion that ended without the chair's answer scores, when the model, not the
 * run, ended it: a view outside the view schema, or too many refused pull-ins. Null otherwise.
 */
function discussionEnd(result: AgentResult): Score | null {
  if (result.status !== "error") return null;
  if (result.errorText === DISCUSSION_ERRORS.notJson) {
    return {
      outcome: "unusable",
      code: "answer_not_json",
      detail: "the answer is not JSON",
    };
  }
  if (
    result.errorText === DISCUSSION_ERRORS.badView ||
    result.errorText === DISCUSSION_ERRORS.tooManyRefused
  ) {
    return {
      outcome: "unusable",
      code: "discussion_rejected",
      detail: `the discussion ended early: ${result.errorText}`,
    };
  }
  return null;
}

/** Why a run that ended without an answer ended. `late`: its deadline has passed. */
function endReason(
  result: AgentResult,
  capLimited: boolean,
  late: boolean,
): EvalReason {
  if (result.providerError) return "provider_error";
  if (result.status === "max_turns") return "max_turns";
  if (result.status === "max_budget") return capLimited ? "cap_limit" : "max_usd";
  // The aborted request ends the loop as an endpoint it could not reach.
  if (late) return "max_minutes";
  return LOOP_REASONS[result.errorText] ?? "run_error";
}

function recordBase({ case: c, entry }: PlannedRun) {
  return {
    caseId: c.id,
    caseVersion: c.version,
    role: c.role,
    model: entry.model,
    provider: entry.provider,
    tier: entry.tier,
  };
}

function skipped(planned: PlannedRun): EvalRunRecord {
  return {
    ...recordBase(planned),
    outcome: "skipped",
    reason: "cap_reached",
    turns: 0,
    tokens: { ...NO_TOKENS },
    costUsd: 0,
    serviceTierServed: null,
    minutes: 0,
  };
}

async function runOne(
  o: WeekOptions,
  planned: PlannedRun,
  key: string,
  leftUsd: number,
): Promise<EvalRunRecord> {
  const { case: c, entry } = planned;
  const run = o.runs.get(c.id) as CaseRun;
  const bot = o.bots[c.role];
  const limits = bot.taskLimits?.[c.taskType] ?? bot.limits;
  const api = bot.providers.find((p) => p.name === entry.provider)?.messagesApi;
  const answerVia = api?.answer ?? "schema";
  const maxUsd = Math.min(limits.maxUsd, leftUsd);
  const deadline = o.deadline(limits.maxMinutes * 60_000);
  const startedAt = o.clock.now();
  // What every loop of the run shares: the model, its limits, its price and tier, the answer mode.
  const loop = {
    client: o.client(o.baseUrls[entry.provider] as string, deadline),
    model: entry.model,
    maxTurns: limits.maxTurns,
    maxUsd,
    price: entry.price,
    maxMinutes: limits.maxMinutes,
    serviceTier: entry.tier,
    ...o.loop,
    clock: o.clock,
    answerVia,
    ...(api?.promptCacheKey ? { promptCacheKey: key } : {}),
  };
  let result: AgentResult;
  try {
    if (run.role === "council") {
      // The Council's case is one discussion on the cast its task carries (ADR 0119 slice 6e).
      result = await runDiscussion(loop, run.task, []);
    } else {
      const context = caseContextTools(run);
      const lookup = caseDocsLookup(run);
      const frame =
        run.role === "qa"
          ? qaReviewFrame(
              run.task,
              run.headSha,
              answerVia,
              // The trees are fixed fixtures: their reads are not logged, unlike a real QA run's.
              createWorkspace(run.workspace, () => undefined),
              context,
              lookup,
            )
          : structuredFrame(run.role, run.task, answerVia, context, lookup);
      ({ result } = await runLoop({ ...loop, ...frame }));
    }
  } catch {
    result = errorResult("the run failed");
  }
  const base = recordBase(planned);
  const spent = {
    turns: result.turns ?? 0,
    tokens: { ...NO_TOKENS, ...result.tokens },
    costUsd: result.costUsd ?? 0,
    serviceTierServed: result.serviceTierServed ?? null,
    minutes: Math.round(((o.clock.now() - startedAt) / 60_000) * 100) / 100,
  };
  const score =
    result.status === "success"
      ? scoreAnswer(c, run, result.finalText, result.discussion)
      : run.role === "council"
        ? discussionEnd(result)
        : null;
  if (score) {
    return {
      ...base,
      outcome: score.outcome,
      reason: score.code,
      ...spent,
      ...(score.facts ? { facts: boundFacts(score.facts) } : {}),
    };
  }
  const reason = endReason(result, maxUsd < limits.maxUsd, deadline.aborted);
  return {
    ...base,
    outcome: "error",
    reason,
    ...spent,
    ...(reason === "provider_error" && result.providerError
      ? { providerError: boundProviderError(result.providerError) }
      : {}),
  };
}

/** Runs the week's plan; returns one record per planned run, in order. */
export async function runWeek(o: WeekOptions): Promise<EvalRunRecord[]> {
  const records: EvalRunRecord[] = [];
  let spentUsd = o.spentBeforeUsd;
  for (const [i, planned] of o.planned.entries()) {
    const record =
      spentUsd >= o.capUsd
        ? skipped(planned)
        : await runOne(o, planned, `${o.runId}-${i + 1}`, o.capUsd - spentUsd);
    spentUsd = roundUsd(spentUsd + record.costUsd);
    records.push(record);
    o.onRecord?.(record);
  }
  return records;
}
