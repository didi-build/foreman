// The daily check's generator (build plan M4.4, spec section 6, FR-12, O-91). Plain logic over the
// store, the contracts and a passed-in clock (D-162). It reads only: it writes nothing, opens,
// re-asks or answers no request (D-272), and runs whatever the kill switch and dry run say,
// since reading is not acting; the check says when either is on. It is delivered as a page Didi
// opens, with no alert (D-319, D-320, O-100): the flow f/foreman/daily_check returns the check as
// its Windmill run's result, rendered for reading by ./daily-check-render.ts. A push alert waits
// for the proper frontend.
//
// The window: the 24 hours before the clock. Nothing records when the previous check ran (a
// record would be a write), so "since the previous check" is the same 24 hours on the once-a-day
// schedule. What is waiting now (blocked items, questions, held items, what is on staging) is
// shown whatever its age, so an unanswered gate shows again in every check (spec section 5).
//
// Projects: every project with at least one node, as the reconcile pass finds them. A project
// with nothing to show is named under `quietProjects` only.
//
// The order, "what blocks the most work" (spec section 6), counted from the store: a project's
// `waitingItems` is the number of its items, not in a terminal state, that cannot move now: in a
// state that carries a blocked reason (Blocked, or escalated; schema invariant 4), held
// (`hold`), or the subject of an open blocking gate request. The most first; then the most
// questions waiting for Didi; then the slug. Inside a project, blocked items are ordered by how
// many unfinished items each one holds up through `blocks` edges (counted transitively), then the
// longest blocked first; questions show blocking ones first, then the oldest; held items the
// longest held first (./held-items.ts).
//
// The sections, per project, in the spec's order:
// - moved: the transitions applied in the window. Rows a dry run wrote (mode `dry_run`) are listed
//   apart as `plannedInDryRun`: the runner planned them and nothing moved.
// - blocked: items with a blocked reason, the reason, and the unfinished items they wait on.
// - staging: the project's `stagingUrl`, the items in the state a staging check moves out of
//   (Verifying on staging, read from the contracts by the guard `staging_check_on_merge_commit`),
//   and the items a passed staging check moved to Done in the window.
// - questions: open gate requests owned by Didi, of every kind (so a proposed playbook rule shows
//   here once something opens one).
// - heldItems: the held-items list (D-272, O-90) with each item's fresh-request flow (D-295).
// - spend: the runs that ended in the window, their recorded cost (`runs.cost_usd`) and tokens,
//   and the runs still active. Raw totals only: the spend roll-up and its thresholds are M4.5.
// - scan: the project's last Scanner stage 1 scan (D-299, O-92), whatever its age: when it ran and
//   at which commit, its findings by check, the new ideas it filed (ids and titles), how many it
//   merged as duplicates and how many were over the cap; for a failed scan, the step it stopped at.
//   Read from the scan's record (migration 0017, ./scan-ideas.ts), which the scan flow writes.
//   Since D-301 (O-93) it also shows the open ideas new findings were folded into, with how many
//   each, and the ideas the scan no longer found: each one in Submitted as withdrawn (its move to
//   Rejected applied with the scan's trigger), or as not withdrawn when the move did not apply,
//   each one further along as no longer found with the Council asked. Didi's controls to reopen
//   come with the attention list (D-314), so the check says so rather than offer a reopen.
// - stalled: both kinds of stalled work (D-302, D-112, O-94), from the one read-only stall check
//   the reconcile pass also reads (./stalls.ts): items ready to start for at least one reconcile
//   cycle with no run, with how long and what each waits on as the runner would say it now, and
//   active runs with no recorded activity past their budget, with the bot and the time since
//   their last activity. Longest stalled first, both kinds in one list in the rendering. No push
//   alert: D-112's alert after an hour waits for delivery (M4.3). A failing `no_pending_gate`
//   guard is named without its note, since the note names topic keys (see below); the request
//   itself shows under questions when it is Didi's.
// - councilAccepted: the plans the Council accepted itself in the window (D-307, O-96): every
//   `plan_accepted` recorded on one of the project's ideas with `acceptedBy` `council`, with the
//   idea, the plan's first line and the Council's reason why Didi was not needed, both quoted as
//   data. Didi-approved plans are not listed here: Didi saw each one on a request.
// - cancels: every cancel (D-308, O-97, ./cancel.ts), one line per cancel that stands on an idea
//   or a work item and is still being acted on, whatever its age, or that finished in the window:
//   who decided (the Council on a plan it accepted, Didi confirming the Council's recommendation,
//   or Didi), the Council's note or Didi's reason quoted as data, each work item it covers with
//   its state (a merged one finishes normally), the pull request the store records for each item
//   with its close (D-318, ./pr-close.ts: closed until the item is cancelled, no close run yet,
//   the close run in progress, or its outcome), the idea's move to Rejected, and that reopening
//   comes with the attention list (D-314). A Council stop waiting for Didi's confirmation shows
//   under questions, as Didi's open request.
// The production deploy approval (spec section 6, D-007) is a named empty section: the store
// records no production deploy or GitHub approval, so there is nothing to read yet.
//
// Project setup (D-358, O-114), before the projects: "Bootstrap failed for <slug>; run the
// register form again" for each registered project whose newest restarted Bootstrap run failed
// (./bootstrap-access.ts, `failedSetups`), whether or not the project has items yet. GitHub keeps
// the runs, so this is read from GitHub with the runner App's `actions: read` token, not from the
// store; a project whose runs cannot be read is named as such. With no `bootstrapRuns` port given
// it is not read (`projectSetup` null).
//
// Text recorded by agents (titles, reasons, questions) and Didi's own words are returned
// verbatim as data; the renderings (./daily-check-render.ts) quote each one, and the page also
// escapes it as HTML text, so nothing in them reads as part of the check. No approval link,
// topic key, decision, run or evidence id is shown: only item ids and gate request ids, which the
// attention list already shows.
import {
  failedSetups,
  type BootstrapRuns,
  type SetupReport,
} from "./bootstrap-access.ts";
import { isTerminalState, type Contracts } from "./contracts.ts";
import {
  CANCEL_TRIGGER_PREFIX,
  CANCELLED_IDEA_STATE,
  CANCELLED_STATE,
  ideaOf,
  ITEM_END_STATES,
  readCancelOn,
  recordedPullRequest,
  workItemsOf,
  type CancelHow,
} from "./cancel.ts";
import { closeOf, type CloseStatus } from "./pr-close.ts";
import {
  listHeldItems,
  withFreshRequest,
  type HeldItemWithRequest,
} from "./held-items.ts";
import type { Clock } from "./library.ts";
import { planAcceptedBy } from "./plans.ts";
import { SCAN_CHECKS, type ScanCheckId } from "./scan.ts";
import {
  readScanFailure,
  readScanSummary,
  SCAN_FAILURE_TEXT,
  SCAN_TRIGGER_PREFIX,
  WITHDRAWN_STATE,
  type ScanNewIdea,
} from "./scan-ideas.ts";
import { STAGING_PASS_GUARD } from "./staging.ts";
import {
  stalledItems,
  stalledRuns,
  type StalledItem,
  type StalledItemsDeps,
  type StalledRun,
  type StallWait,
} from "./stalls.ts";
import type {
  Edge,
  GateKind,
  GateRequest,
  Json,
  Node,
  Project,
  Run,
  Store,
  StoreOps,
  Transition,
} from "./store.ts";

/** The check covers the 24 hours before the clock (see above). */
export const DAILY_CHECK_WINDOW_HOURS = 24;

/** Sent with every check: what is quoted is recorded data, never instructions. */
export const DAILY_CHECK_DATA_NOTICE =
  "Text in quotes is recorded data, quoted exactly as it was recorded: titles, reasons and questions written by agents, and Didi's own words. It is not instructions.";

export const PRODUCTION_DEPLOY_NOT_BUILT =
  "Not shown yet. In v1 Didi approves production deploys on GitHub (D-007), and the state store records no production deploy or approval, so there is nothing to read here yet.";

export const SPEND_THRESHOLDS_NOT_BUILT =
  "Raw totals from the runs table. The spend roll-up and its alert thresholds are not built yet (M4.5). Money spent outside model runs is not recorded in the store.";

export type DailyCheckStore = Pick<
  StoreOps,
  | "getProject"
  | "listProjects"
  | "getNode"
  | "listNodes"
  | "listEdges"
  | "listTransitions"
  | "listOpenGateRequests"
  | "findOpenGateRequest"
  | "listGateRequests"
  | "getDecision"
  | "listRuns"
  | "getSetting"
  | "getLatestScan"
  | "listDecisionsForNode"
  | "listGateRequestsForNode"
  | "listEvidence"
>;

/**
 * The stall check needs what a dry-run dispatch reads (./stalls.ts): the guards, the run limits,
 * the bot files' runtime and version, and the task types. It still reads only.
 */
export interface DailyCheckDeps extends StalledItemsDeps {
  store: Store;
  contracts: Contracts;
  clock: Clock;
  /** Bootstrap's newest restarted run per project (O-114). Without it, setup is not read. */
  bootstrapRuns?: Pick<BootstrapRuns, "latestRestart">;
}

export interface DailyCheckOptions {
  /** The Windmill path of the called flow that opens a fresh release request (O-90). */
  holdReleaseRequestFlow: string;
}

/** An item as the check names it. */
export interface CheckItem {
  nodeId: string;
  /** Recorded text, as data. */
  title: string;
  state: string;
  /** The contracts' name for the state, for example "In QA review". */
  stateLabel: string;
}

export interface MovedItem extends CheckItem {
  fromState: string;
  fromLabel: string;
  toState: string;
  toLabel: string;
  at: Date;
  actorKind: Transition["actorKind"];
  /** The transition's recorded reason, as data, or null. */
  reason: string | null;
}

export interface BlockedItem extends CheckItem {
  blockedSince: Date;
  /** The recorded blocked reason, as data. */
  reason: string;
  /** Unfinished items this one waits on (`blocks` edges into it). */
  waitingOn: CheckItem[];
  /** Unfinished items held up behind this one, through `blocks` edges, counted transitively. */
  holdsUp: number;
}

export interface StagingItem extends CheckItem {
  since: Date;
}

export interface StagingSection {
  /** The project's staging address, as recorded, or null when none is. */
  url: string | null;
  /** Items waiting on their staging check now. */
  onStaging: StagingItem[];
  /** Items a passed staging check moved to Done in the window. */
  passedInWindow: StagingItem[];
}

export interface QuestionItem {
  gateRequestId: string;
  nodeId: string | null;
  /** The item's recorded title, as data, or null for a request on no item. */
  title: string | null;
  kind: GateKind;
  blocking: boolean;
  waitingSince: Date;
  waitingForMinutes: number;
  /** The request's question (`payload.question`), as data, when it carries one. */
  question: string | null;
}

export interface SpendSection {
  runsEnded: number;
  /** The summed `cost_usd` of the runs that ended, in US dollars. */
  costUsd: number;
  /** Runs that ended with no recorded cost, so they are not in `costUsd`. */
  unpricedRuns: number;
  /** Tokens of the runs that ended, from what each run recorded. */
  tokens: { input: number; output: number };
  runsActive: number;
}

/** The project's last scan (D-299), or a note that none is recorded. */
export interface ScanSection {
  /** When the last scan was recorded; null when there is none. */
  lastScanAt: Date | null;
  outcome: "scanned" | "failed" | null;
  commitSha: string | null;
  /** For a failed scan, the fixed text of the step it stopped at. */
  failure: string | null;
  /** Every finding of the last scan, by check. */
  findingsByCheck: Record<ScanCheckId, number>;
  findings: number;
  /** The ideas it filed, by item id and recorded title (data). */
  newIdeas: ScanNewIdea[];
  /** Findings already on an open idea or item. */
  merged: number;
  /** Findings past the cap of new ideas per scan, not filed this time. */
  overCap: number;
  cap: number | null;
  /** Open ideas new findings were folded into (D-301), each with how many, by item id. */
  foldedInto: { nodeId: string; title: string; findings: number }[];
  /** Scanner ideas in Submitted the scan no longer found, withdrawn to Rejected (D-301). */
  withdrawn: { nodeId: string; title: string }[];
  /** Ones it no longer found whose withdrawal did not apply: still in Submitted. */
  notWithdrawn: { nodeId: string; title: string }[];
  /** Ideas further along it no longer found: recorded on each, and the Council asked. */
  askedCouncil: { nodeId: string; title: string; state: string }[];
  /** Said when there is no scan, or its record cannot be read. */
  note: string | null;
}

/** An active run quiet past its budget, with its item's recorded title (data), or null. */
export interface StalledRunEntry extends StalledRun {
  title: string | null;
}

/** A stalled item with the contracts' name for its state. */
export interface StalledItemEntry extends StalledItem {
  stateLabel: string;
}

/** Both kinds of stalled work in a project (D-302), each longest stalled first. */
export interface StalledSection {
  items: StalledItemEntry[];
  runs: StalledRunEntry[];
}

/** A plan the Council accepted itself, with no request for Didi (D-307). */
export interface CouncilAcceptedPlan {
  /** The idea. Its title is recorded text, as data. */
  nodeId: string;
  title: string;
  acceptedAt: Date;
  /** The plan's first non-blank line, cut to `PLAN_FIRST_LINE_CHARS`, as data. */
  planFirstLine: string;
  /** The Council's reason why Didi was not needed, as data. */
  reason: string;
}

/** How much of a plan's first line the check shows. */
export const PLAN_FIRST_LINE_CHARS = 200;

/** A plan's first non-blank line, trimmed and cut, saying so. */
export function planFirstLine(plan: string): string {
  const line =
    plan
      .split(/\r?\n/)
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";
  return line.length <= PLAN_FIRST_LINE_CHARS
    ? line
    : `${line.slice(0, PLAN_FIRST_LINE_CHARS)} [cut at ${PLAN_FIRST_LINE_CHARS} characters]`;
}

/** The check's words on reopening, until the attention list brings Didi's controls (D-314). */
export const REOPEN_LATER = "Reopening comes with the attention list (D-314).";

/** One cancel (D-308), as the check shows it. */
export interface CancelEntry {
  /** The node the cancel was decided on: an idea (the scanner question) or a work item. */
  nodeId: string;
  title: string;
  stateLabel: string;
  /** Who let it stand: the Council, Didi confirming the Council, or Didi. */
  how: CancelHow;
  /** The Council's note, or Didi's reason, verbatim (data). */
  note: string;
  /** True once every item it covers is finished. */
  finished: boolean;
  /** The idea, when the cancel moved it to Rejected, and when. */
  ideaRejected: { nodeId: string; title: string; at: Date } | null;
  items: (CheckItem & {
    /** The pull request number the store records for the item. */
    pullRequest: number | null;
    /** Its close run (D-318), once the item is Cancelled; null before, or with no pull request. */
    close: CloseStatus | null;
  })[];
}

export const NO_SCAN_YET =
  "No scan is recorded yet. The Scanner's stage 1 runs once a day before this check, once the runner App is registered and dry run is off.";

export interface ProjectCheck {
  projectId: string;
  slug: string;
  name: string;
  /** The ordering key (see above). */
  waitingItems: number;
  moved: MovedItem[];
  plannedInDryRun: MovedItem[];
  blocked: BlockedItem[];
  staging: StagingSection;
  questions: QuestionItem[];
  heldItems: HeldItemWithRequest[];
  spend: SpendSection;
  scan: ScanSection;
  stalled: StalledSection;
  /** Plans the Council accepted itself in the window, oldest first (D-307). */
  councilAccepted: CouncilAcceptedPlan[];
  cancels: CancelEntry[];
}

export interface DailyCheck {
  generatedAt: Date;
  window: { from: Date; to: Date; hours: number };
  /** The switches as they are now. Reading is not acting, so the check runs either way. */
  switches: { killSwitch: boolean; dryRun: boolean };
  dataNotice: string;
  projects: ProjectCheck[];
  /** Slugs of projects with nothing to show. */
  quietProjects: string[];
  productionDeployApproval: { items: []; note: string };
  spendNote: string;
  /** One reconcile cycle, after which a ready item with no run counts as stalled (D-112). */
  stalledAfterMinutes: number | null;
  /** Said when stalled items could not be listed. */
  stalledNote: string | null;
  /** Projects whose setup failed, read from GitHub (O-114); null when not read. */
  projectSetup: SetupReport | null;
}

const MINUTE_MS = 60_000;

const fieldOf = (value: Json | undefined, key: string): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value[key]
    : undefined;

const count = (value: Json | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** Input and output tokens from a run's recorded `tokens` (src/core/runs.ts). */
function runTokens(run: Run): { input: number; output: number } {
  return {
    input:
      count(fieldOf(run.tokens, "uncachedInput")) +
      count(fieldOf(run.tokens, "cachedInput")) +
      count(fieldOf(run.tokens, "cacheWriteInput")),
    output: count(fieldOf(run.tokens, "output")),
  };
}

const noFindings = (): Record<ScanCheckId, number> =>
  Object.fromEntries(SCAN_CHECKS.map((c) => [c, 0])) as Record<ScanCheckId, number>;

/** The project's last scan as the check shows it. Reads only. */
async function scanSection(
  store: DailyCheckStore,
  projectId: string,
): Promise<ScanSection> {
  const empty: ScanSection = {
    lastScanAt: null,
    outcome: null,
    commitSha: null,
    failure: null,
    findingsByCheck: noFindings(),
    findings: 0,
    newIdeas: [],
    merged: 0,
    overCap: 0,
    cap: null,
    foldedInto: [],
    withdrawn: [],
    notWithdrawn: [],
    askedCouncil: [],
    note: NO_SCAN_YET,
  };
  const last = await store.getLatestScan(projectId);
  if (!last) return empty;
  const known = {
    ...empty,
    lastScanAt: last.recordedAt,
    commitSha: last.commitSha,
    note: null,
  };
  if (last.outcome === "failed") {
    const failure = readScanFailure(last.summary);
    return {
      ...known,
      outcome: "failed",
      failure: failure === null ? "the scan failed" : SCAN_FAILURE_TEXT[failure],
    };
  }
  const summary = readScanSummary(last.summary);
  if (summary === null) {
    return {
      ...known,
      outcome: "scanned",
      note: "The last scan's record could not be read.",
    };
  }
  const foldedInto: ScanSection["foldedInto"] = [];
  for (const f of summary.folded) {
    const into = foldedInto.find((i) => i.nodeId === f.nodeId);
    if (into) into.findings += 1;
    else foldedInto.push({ nodeId: f.nodeId, title: f.title, findings: 1 });
  }
  const withdrawn: ScanSection["withdrawn"] = [];
  const notWithdrawn: ScanSection["notWithdrawn"] = [];
  const askedCouncil: ScanSection["askedCouncil"] = [];
  const trigger = `${SCAN_TRIGGER_PREFIX}${last.id}`;
  for (const g of summary.gone) {
    if (g.action === "asked_council") {
      askedCouncil.push({ nodeId: g.nodeId, title: g.title, state: g.state });
      continue;
    }
    const moved = (await store.listTransitions(g.nodeId)).some(
      (t) =>
        t.mode === "applied" &&
        t.toState === WITHDRAWN_STATE &&
        t.triggerRef === trigger,
    );
    const node = await store.getNode(g.nodeId);
    (moved && node?.state === WITHDRAWN_STATE ? withdrawn : notWithdrawn).push({
      nodeId: g.nodeId,
      title: g.title,
    });
  }
  return {
    ...known,
    outcome: "scanned",
    findingsByCheck: summary.counts,
    findings: summary.findings,
    newIdeas: summary.newIdeas,
    merged: summary.merged,
    overCap: summary.overCap,
    cap: summary.cap,
    foldedInto,
    withdrawn,
    notWithdrawn,
    askedCouncil,
  };
}

/** The guard whose note names open requests by topic key, which the check never shows. */
const PENDING_GATE_GUARD = "no_pending_gate";

/** A wait as the check shows it: the guard's note, unless it names topic keys. */
const shownWait = (wait: StallWait): StallWait =>
  wait.guard === PENDING_GATE_GUARD ? { ...wait, detail: null } : wait;

const inWindow = (at: Date, from: Date, to: Date): boolean =>
  at.getTime() >= from.getTime() && at.getTime() < to.getTime();

/** Every cancel on the project's ideas and work items still acted on or finished in the window. */
async function cancelSection(
  store: DailyCheckStore,
  projectNodes: readonly Node[],
  labelOf: (state: string) => string,
  from: Date,
  to: Date,
): Promise<CancelEntry[]> {
  const entries: CancelEntry[] = [];
  for (const node of projectNodes) {
    const idea = await ideaOf(store, node);
    const on = await readCancelOn(store, node, idea);
    if (on?.status !== "cancel") continue;
    const { cancel } = on;
    const ref = `${CANCEL_TRIGGER_PREFIX}${cancel.decisionId}`;
    const covered = node.type === "idea" ? await workItemsOf(store, node.id) : [node];
    const finished = covered.every((i) => ITEM_END_STATES.includes(i.state));
    const moves: Transition[] = [];
    for (const n of [...covered, ...(idea ? [idea] : [])]) {
      moves.push(
        ...(await store.listTransitions(n.id)).filter(
          (t) => t.mode === "applied" && t.triggerRef === ref,
        ),
      );
    }
    const rejected = idea
      ? moves.find((t) => t.nodeId === idea.id && t.toState === CANCELLED_IDEA_STATE)
      : undefined;
    const lastAt = moves
      .map((t) => t.at)
      .sort((a, b) => a.getTime() - b.getTime())
      .at(-1);
    if (finished && (!lastAt || !inWindow(lastAt, from, to))) continue;
    const items: CancelEntry["items"] = [];
    for (const item of covered) {
      const pullRequest = (await recordedPullRequest(store, item.id))?.number ?? null;
      items.push({
        nodeId: item.id,
        title: item.title,
        state: item.state,
        stateLabel: labelOf(item.state),
        pullRequest,
        close:
          pullRequest !== null && item.state === CANCELLED_STATE
            ? await closeOf(store, item.id, pullRequest)
            : null,
      });
    }
    entries.push({
      nodeId: node.id,
      title: node.title,
      stateLabel: labelOf(node.state),
      how: cancel.how,
      note: cancel.note,
      finished,
      ideaRejected:
        rejected && idea
          ? { nodeId: idea.id, title: idea.title, at: rejected.at }
          : null,
      items,
    });
  }
  return entries;
}

/** Generates the daily check. Reads only. */
export async function generateDailyCheck(
  deps: DailyCheckDeps,
  { holdReleaseRequestFlow }: DailyCheckOptions,
): Promise<DailyCheck> {
  const { store, contracts, clock } = deps;
  const to = clock.now();
  const from = new Date(to.getTime() - DAILY_CHECK_WINDOW_HOURS * 60 * MINUTE_MS);
  const killSwitch = (await store.getSetting("kill_switch"))?.value === true;
  // A missing setting means dry run, as in the library.
  const dryRun = (await store.getSetting("dry_run"))?.value !== false;

  const labelOf = (state: string): string =>
    (Object.hasOwn(contracts.states, state)
      ? contracts.states[state]?.label
      : undefined) ?? state;
  const terminal = (state: string): boolean => isTerminalState(contracts, state);
  const itemOf = (node: Node): CheckItem => ({
    nodeId: node.id,
    title: node.title,
    state: node.state,
    stateLabel: labelOf(node.state),
  });
  /** The states a staging check moves out of, and the states its pass leads to. */
  const stagingMoves = contracts.transitions.filter(
    (m) => !m.escalation && !m.fallbackMove && m.guards.includes(STAGING_PASS_GUARD),
  );
  const stagingStates = new Set(stagingMoves.map((m) => m.from));
  const stagingPassed = (t: Transition): boolean =>
    stagingMoves.some((m) => m.from === t.fromState && m.to === t.toState);

  const nodes = await store.listNodes({});
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const projectIds = [...new Set(nodes.map((n) => n.projectId))];
  const held = withFreshRequest(
    await listHeldItems({ store, clock, contracts }),
    holdReleaseRequestFlow,
  );
  const stalled = await stalledItems(deps);
  const quietRuns = await stalledRuns(deps);

  const outgoing = new Map<string, Edge[]>();
  const blocksFrom = async (nodeId: string): Promise<Edge[]> => {
    const cached = outgoing.get(nodeId);
    if (cached) return cached;
    const edges = await store.listEdges({ fromNode: nodeId, type: "blocks" });
    outgoing.set(nodeId, edges);
    return edges;
  };
  /** Unfinished items held up behind a node, through `blocks` edges. */
  async function holdsUp(nodeId: string): Promise<number> {
    const seen = new Set<string>([nodeId]);
    const queue = [nodeId];
    let found = 0;
    while (queue.length > 0) {
      for (const edge of await blocksFrom(queue.shift() as string)) {
        if (seen.has(edge.toNode)) continue;
        seen.add(edge.toNode);
        const dependent = nodeById.get(edge.toNode);
        if (!dependent || terminal(dependent.state)) continue;
        found += 1;
        queue.push(edge.toNode);
      }
    }
    return found;
  }

  const projects: ProjectCheck[] = [];
  const quietProjects: string[] = [];
  for (const projectId of projectIds) {
    const project: Project | null = await store.getProject(projectId);
    if (!project) continue;
    const projectNodes = nodes.filter((n) => n.projectId === projectId);
    const openGates: GateRequest[] = await store.listOpenGateRequests(projectId);

    const moved: MovedItem[] = [];
    const plannedInDryRun: MovedItem[] = [];
    const passedInWindow: StagingItem[] = [];
    const runs: Run[] = [];
    for (const node of projectNodes) {
      for (const t of await store.listTransitions(node.id)) {
        if (!inWindow(t.at, from, to)) continue;
        const entry: MovedItem = {
          ...itemOf(node),
          fromState: t.fromState,
          fromLabel: labelOf(t.fromState),
          toState: t.toState,
          toLabel: labelOf(t.toState),
          at: t.at,
          actorKind: t.actorKind,
          reason: t.reason,
        };
        if (t.mode === "dry_run") {
          plannedInDryRun.push(entry);
          continue;
        }
        moved.push(entry);
        if (stagingPassed(t)) passedInWindow.push({ ...itemOf(node), since: t.at });
      }
      runs.push(...(await store.listRuns({ nodeId: node.id })));
    }
    const byTime = (a: { at: Date; nodeId: string }, b: { at: Date; nodeId: string }) =>
      a.at.getTime() - b.at.getTime() || a.nodeId.localeCompare(b.nodeId);
    moved.sort(byTime);
    plannedInDryRun.sort(byTime);

    const blocked: BlockedItem[] = [];
    for (const node of projectNodes) {
      if (node.blockedReason === null || terminal(node.state)) continue;
      const waitingOn: CheckItem[] = [];
      for (const edge of await store.listEdges({ toNode: node.id, type: "blocks" })) {
        const blocker = nodeById.get(edge.fromNode);
        if (blocker && !terminal(blocker.state)) waitingOn.push(itemOf(blocker));
      }
      blocked.push({
        ...itemOf(node),
        blockedSince: node.stateSince,
        reason: node.blockedReason,
        waitingOn,
        holdsUp: await holdsUp(node.id),
      });
    }
    blocked.sort(
      (a, b) =>
        b.holdsUp - a.holdsUp ||
        a.blockedSince.getTime() - b.blockedSince.getTime() ||
        a.nodeId.localeCompare(b.nodeId),
    );

    const onStaging: StagingItem[] = projectNodes
      .filter((n) => stagingStates.has(n.state))
      .map((n) => ({ ...itemOf(n), since: n.stateSince }));

    const questions: QuestionItem[] = openGates
      .filter((g) => g.owner === "didi")
      .map((g) => {
        const node = g.nodeId ? nodeById.get(g.nodeId) : undefined;
        const question = fieldOf(g.payload, "question");
        return {
          gateRequestId: g.id,
          nodeId: g.nodeId,
          title: node?.title ?? null,
          kind: g.kind,
          blocking: g.blocking,
          waitingSince: g.createdAt,
          waitingForMinutes: Math.max(
            0,
            Math.floor((to.getTime() - g.createdAt.getTime()) / MINUTE_MS),
          ),
          question: typeof question === "string" ? question : null,
        };
      })
      .sort(
        (a, b) =>
          Number(b.blocking) - Number(a.blocking) ||
          a.waitingSince.getTime() - b.waitingSince.getTime() ||
          a.gateRequestId.localeCompare(b.gateRequestId),
      );

    const ended = runs.filter(
      (r) => r.endedAt !== null && inWindow(r.endedAt, from, to),
    );
    const spend: SpendSection = {
      runsEnded: ended.length,
      costUsd:
        Math.round(ended.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) * 1e6) / 1e6,
      unpricedRuns: ended.filter((r) => r.costUsd === null).length,
      tokens: ended.reduce(
        (sum, r) => {
          const t = runTokens(r);
          return { input: sum.input + t.input, output: sum.output + t.output };
        },
        { input: 0, output: 0 },
      ),
      runsActive: runs.filter((r) => r.endedAt === null).length,
    };

    const councilAccepted: CouncilAcceptedPlan[] = [];
    for (const node of projectNodes) {
      if (node.type !== "idea") continue;
      for (const d of await store.listDecisionsForNode(node.id)) {
        const scope = d.scope;
        if (
          d.kind !== "council_decision" ||
          d.nodeId !== node.id ||
          typeof scope !== "object" ||
          scope === null ||
          Array.isArray(scope) ||
          scope.kind !== "plan_accepted" ||
          planAcceptedBy(d) !== "council" ||
          !inWindow(d.recordedAt, from, to)
        ) {
          continue;
        }
        councilAccepted.push({
          nodeId: node.id,
          title: node.title,
          acceptedAt: d.recordedAt,
          planFirstLine: planFirstLine(d.textVerbatim),
          reason:
            typeof scope.needsDidiReason === "string" ? scope.needsDidiReason : "",
        });
      }
    }
    councilAccepted.sort(
      (a, b) =>
        a.acceptedAt.getTime() - b.acceptedAt.getTime() ||
        a.nodeId.localeCompare(b.nodeId),
    );

    const blockingGateNodes = new Set(
      openGates.filter((g) => g.blocking && g.nodeId !== null).map((g) => g.nodeId),
    );
    const waitingItems = projectNodes.filter(
      (n) =>
        !terminal(n.state) &&
        (n.blockedReason !== null || n.hold || blockingGateNodes.has(n.id)),
    ).length;

    const check: ProjectCheck = {
      projectId,
      slug: project.slug,
      name: project.name,
      waitingItems,
      moved,
      plannedInDryRun,
      blocked,
      staging: { url: project.stagingUrl, onStaging, passedInWindow },
      questions,
      heldItems: held.filter((h) => h.projectId === projectId),
      spend,
      scan: await scanSection(store, projectId),
      stalled: {
        items: stalled.items
          .filter((i) => i.projectId === projectId)
          .map((i) => ({
            ...i,
            stateLabel: labelOf(i.state),
            waits: i.waits.map(shownWait),
          })),
        runs: quietRuns
          .filter((r) => r.projectId === projectId)
          .map((r) => ({
            ...r,
            title: r.nodeId ? (nodeById.get(r.nodeId)?.title ?? null) : null,
          })),
      },
      councilAccepted,
      cancels: await cancelSection(store, projectNodes, labelOf, from, to),
    };
    const quiet =
      waitingItems === 0 &&
      moved.length === 0 &&
      plannedInDryRun.length === 0 &&
      blocked.length === 0 &&
      onStaging.length === 0 &&
      passedInWindow.length === 0 &&
      questions.length === 0 &&
      check.heldItems.length === 0 &&
      spend.runsEnded === 0 &&
      spend.runsActive === 0 &&
      check.scan.findings === 0 &&
      check.scan.withdrawn.length === 0 &&
      check.scan.notWithdrawn.length === 0 &&
      check.scan.askedCouncil.length === 0 &&
      check.scan.outcome !== "failed" &&
      check.stalled.items.length === 0 &&
      check.stalled.runs.length === 0 &&
      councilAccepted.length === 0 &&
      check.cancels.length === 0;
    if (quiet) quietProjects.push(project.slug);
    else projects.push(check);
  }

  projects.sort(
    (a, b) =>
      b.waitingItems - a.waitingItems ||
      b.questions.length - a.questions.length ||
      a.slug.localeCompare(b.slug),
  );
  return {
    generatedAt: to,
    window: { from, to, hours: DAILY_CHECK_WINDOW_HOURS },
    switches: { killSwitch, dryRun },
    dataNotice: DAILY_CHECK_DATA_NOTICE,
    projects,
    quietProjects: quietProjects.sort(),
    productionDeployApproval: { items: [], note: PRODUCTION_DEPLOY_NOT_BUILT },
    spendNote: SPEND_THRESHOLDS_NOT_BUILT,
    stalledAfterMinutes: stalled.cycleMinutes,
    stalledNote: stalled.problem,
    projectSetup: deps.bootstrapRuns
      ? await failedSetups(
          { bootstrapRuns: deps.bootstrapRuns },
          await store.listProjects(),
        )
      : null,
  };
}
