// GitHub evidence ingestion (build plan M2.3, ADR 0113). Plain functions over an injected GitHub
// reader, store, clock and id source: webhooks and the polling backstop both end here, build the
// same ingest keys for the same facts, and so never record a fact twice.
//
// A webhook delivery is read in two places (D-381, O-128). The receiver holds no GitHub token, so
// it decides from the signed payload alone (`receiveDelivery`): it records the delivery, decides
// what needs no GitHub read (an action ingestion does not use, a pull request closed without
// merging, a check event that is not a completion or names no pull request, an event that is not
// evidence, a payload it cannot read), and for the rest names the identifiers ingestion needs to
// read GitHub again (`HandedOnDelivery`): the delivery id, the event and action, the repository,
// the pull request numbers and the head commit the event names, never a title, a body, a branch
// name, a login or the payload (ADR 0113 section 8). The receiver starts the ingest flow with
// them, and the flow reads GitHub with the runner's own client and records what it finds
// (`ingestHandedOn`), through the same functions and keys as the polling backstop.
//
// The head rule (D-178, docs/guards.md): a guard takes the head commit from the newest `ci_run`,
// so a `ci_run` is recorded only for the PR's current head as GitHub reports it at that moment.
// A late event about an older commit records nothing, and the head never moves back.
//
// CI's preview check (D-354, O-111): with a final CI result on the head, ingestion also reads the
// preview check's job (./preview-check.ts) and records its conclusion as `preview_check` for that
// head, under its own key, so the webhook and the polling backstop record it once and a rerun is
// recorded again and is the newest. A job still running, or none, records nothing.
//
// A `deployment_status` delivery is still recorded as a delivery only, never as evidence (ADR 0113
// section 5), and nothing starts on it: the runner deploys staging itself and records that deploy
// (D-356, O-116), so GitHub's deployments say nothing the runner reads.
import {
  REPOSITORY,
  type GitHubReader,
  type CheckRun,
  type PullRequest,
} from "./github.ts";
import type { Clock, IdSource } from "./library.ts";
import { previewCheckKey, readPreviewCheck } from "./preview-check.ts";
import type {
  Evidence,
  GithubDeliveryOutcome,
  Json,
  Store,
  StoreOps,
} from "./store.ts";

/**
 * The name of the runner's own display-only check run, which never counts toward CI (D-158,
 * D-160). It is excluded only when the runner's App created it: a project's own check with the
 * same name still counts.
 */
export const QA_CHECK_RUN = "QA";

/** Event types ingestion reads. Any other type is acknowledged and not stored (ADR 0113 section 2). */
export const HANDLED_EVENTS: ReadonlySet<string> = new Set([
  "pull_request",
  "check_suite",
  "workflow_run",
  "deployment_status",
  "push",
]);

/** The `recorded_by` of every row ingestion writes. */
export const RECORDED_BY = "github";

/** Check run conclusions that do not fail CI. Anything else, `cancelled` and `timed_out` included, fails it. */
const PASSING = new Set(["success", "neutral", "skipped"]);

export interface IngestDeps {
  store: Store;
  github: GitHubReader;
  clock: Clock;
  ids: IdSource;
  /** Logins of the Developer and Designer Apps (D-156). Only their PRs link to a node. */
  appLogins: readonly string[];
  /** The runner App's slug (D-156). Only its `QA` check run is left out of the CI result. */
  runnerAppSlug: string;
}

export interface Delivery {
  /** `X-GitHub-Delivery`. */
  id: string;
  /** `X-GitHub-Event`. */
  event: string;
  /** The parsed body, already authenticated by the caller. */
  payload: unknown;
}

/** GitHub's delivery ids (`X-GitHub-Delivery`): the only form one is stored, logged or handed on. */
export const DELIVERY_ID = /^[A-Za-z0-9-]{1,100}$/;

/** A full commit id: the only form a head commit is handed to the ingest flow in. */
const FULL_SHA = /^[0-9a-f]{40}$/;

/** The reason a delivery handed to the ingest flow is recorded with (D-381, O-128). */
export const HANDED_ON = "handed to the ingest flow";

/**
 * What the receiver hands the ingest flow for a delivery that needs GitHub (D-381, O-128), and so
 * what crosses into Windmill: the identifiers ingestion needs to read GitHub again, and nothing
 * else. Never a title, a body, a branch name, a login or the payload (ADR 0113 section 8).
 */
export type HandedOnDelivery =
  | {
      deliveryId: string;
      event: "pull_request";
      /** New commits on a PR: a pending `ci_run` for the head, while it is still the head. */
      action: "opened" | "reopened" | "synchronize";
      /** `owner/name`. */
      repo: string;
      /** The one pull request the event is about. */
      pullRequests: number[];
      /** The head commit the event names. */
      headSha: string;
    }
  | {
      deliveryId: string;
      event: "pull_request";
      /** A merge (the payload says `merged: true`): GitHub is asked for the merge commit. */
      action: "closed";
      repo: string;
      pullRequests: number[];
      headSha: null;
    }
  | {
      deliveryId: string;
      event: "check_suite" | "workflow_run";
      /** CI's end on a commit: the final `ci_run` for each listed PR whose head it still is. */
      action: "completed";
      repo: string;
      /** The pull requests GitHub lists for the commit, each once. */
      pullRequests: number[];
      headSha: string;
    };

/** What one delivery amounts to from its signed payload alone (D-381, O-128). */
export type DeliveryDecision =
  /** An event type ingestion does not read: acknowledged and not stored (ADR 0113 section 2). */
  | { kind: "unhandled"; repo: string | null }
  /** A signed payload ingestion cannot read: recorded as `rejected` and answered 400. */
  | { kind: "rejected"; repo: string | null; reason: "malformed payload" }
  /** Decided without GitHub: recorded as `ignored`, with a short fixed reason. */
  | { kind: "ignored"; repo: string; pr: number | null; reason: string }
  /** Needs GitHub: recorded, and handed to the ingest flow with exactly these identifiers. */
  | { kind: "handed_on"; repo: string; pr: number; delivery: HandedOnDelivery };

/** What the receiver needs to record a delivery: no GitHub reader, no id source. */
export interface ReceiveDeps {
  store: Pick<Store, "recordGithubDelivery">;
  clock: Clock;
}

export interface ReceiveResult {
  /**
   * What was stored for the delivery: `recorded` for one handed to the ingest flow, `ignored` or
   * `rejected` for one decided here. `duplicate` (its id was seen before) and `unhandled` (an
   * event type ingestion does not read) store nothing.
   */
  outcome: GithubDeliveryOutcome | "duplicate" | "unhandled";
  /** A short fixed reason. Never text from the payload. */
  reason: string | null;
  repo: string | null;
  pr: number | null;
  /**
   * For a delivery recorded now that needs GitHub, what the ingest flow is started with. Null for
   * everything else, a replay included, so a delivery starts the flow at most once.
   */
  handedOn: HandedOnDelivery | null;
}

/** What the ingest flow recorded for one handed-on delivery. */
export interface HandedOnIngest {
  /** `recorded` when it inserted evidence, `ignored` when there was nothing new. */
  outcome: "recorded" | "ignored";
  /** A short fixed reason when nothing new was recorded. Never text from GitHub. */
  reason: string | null;
  pr: number | null;
  evidenceIds: string[];
  /**
   * Each PR head whose CI end this delivery recorded: a newly inserted final `ci_run` (success or
   * failure), never a pending one. A fact another delivery already recorded names none, so the
   * steps that follow CI's end run at most once per CI end (O-101, O-104).
   */
  finishedCi: FinishedCi[];
}

/** A node's PR head whose CI has just finished. */
export interface FinishedCi {
  nodeId: string;
  commitSha: string;
}

/** Evidence to record under its ingest key. */
interface Fact {
  evidence: Evidence;
  key: string;
}

/** What one pull request event amounts to: facts to record, or the reason there are none. */
interface Finding {
  pr: number | null;
  facts: Fact[];
  reason: string | null;
}

const ignore = (pr: number | null, reason: string): Finding => ({
  pr,
  facts: [],
  reason,
});

/**
 * A pending result has one key per commit. A final result also names its CI attempt, so a rerun
 * that ends like an earlier one (failure, success, failure) is still recorded and is the newest.
 */
export function ciRunKey(
  repo: string,
  pr: number,
  sha: string,
  conclusion: "pending" | "success" | "failure",
  attempt?: number,
): string {
  const base = `github:ci_run:${repo}#${pr}:${sha}:${conclusion}`;
  return attempt === undefined ? base : `${base}:check-run-${attempt}`;
}

/** One merge per PR (ADR 0113 section 5), so the key does not name the commit. */
export const mergeCommitKey = (repo: string, pr: number): string =>
  `github:merge_commit:${repo}#${pr}`;

export interface CiResult {
  conclusion: "success" | "failure";
  /**
   * The CI attempt: the highest check run id among the counted runs. A rerun creates new check
   * runs with new ids, so it changes on every attempt, and the webhook and the polling backstop
   * both read it from the same check run listing, so they agree on it.
   */
  attempt: number;
}

/**
 * The CI result on a commit: every check run except the runner App's own `QA` check run. Null
 * while any of them is unfinished, or when there are none.
 */
export function conclude(
  runs: readonly CheckRun[],
  runnerAppSlug: string,
): CiResult | null {
  const counted = runs.filter(
    (run) => !(run.name === QA_CHECK_RUN && run.appSlug === runnerAppSlug),
  );
  if (counted.length === 0 || counted.some((run) => run.status !== "completed"))
    return null;
  return {
    conclusion: counted.every((run) => PASSING.has(run.conclusion ?? ""))
      ? "success"
      : "failure",
    attempt: Math.max(...counted.map((run) => run.id)),
  };
}

type Link = { nodeId: string } | { reason: string };

/**
 * ADR 0113 section 4: the PR comes from a branch in its own repository, was opened by a factory
 * App, and its branch is the one named by exactly one node's latest dispatch record.
 */
async function link(deps: IngestDeps, pr: PullRequest): Promise<Link> {
  if (pr.headRepo !== pr.repo) return { reason: "fork pull request" };
  if (!deps.appLogins.includes(pr.author))
    return { reason: "author is not a factory App" };
  const dispatches = await deps.store.listDispatches({
    repo: pr.repo,
    branch: pr.headBranch,
  });
  if (dispatches.length === 0) return { reason: "no node dispatched on this branch" };
  if (dispatches.length > 1)
    return { reason: "branch dispatched to more than one node" };
  return { nodeId: dispatches[0]!.nodeId };
}

function evidence(
  deps: IngestDeps,
  nodeId: string,
  kind: "ci_run" | "merge_commit" | "preview_check",
  commitSha: string,
  payload: Json,
  key: string,
): Fact {
  return {
    key,
    evidence: {
      id: deps.ids.next(),
      nodeId,
      runId: null,
      kind,
      // The key names the fact, so it doubles as the human-readable reference.
      ref: key,
      commitSha,
      payload,
      recordedBy: RECORDED_BY,
      recordedAt: deps.clock.now(),
      supersedesId: null,
    },
  };
}

/**
 * A `ci_run` for `sha` on a PR, as GitHub reports the PR now.
 * - `pending`: checks have started on a new head (a `pull_request` event).
 * - `final`: checks finished (a `check_suite` or `workflow_run` event); nothing while any still run.
 * - `current`: whatever the checks say now (the polling backstop).
 * A pending row is skipped when the commit already has a `ci_run`, so a late or repeated
 * pending event never hides a finished result. With a final result, the preview check's job is
 * read too, and its conclusion is a `preview_check` for `sha` when the job has finished.
 */
async function ciRunFinding(
  deps: IngestDeps,
  pr: PullRequest,
  sha: string,
  mode: "pending" | "final" | "current",
): Promise<Finding> {
  const linked = await link(deps, pr);
  if ("reason" in linked) return ignore(pr.number, linked.reason);
  if (pr.state !== "open") return ignore(pr.number, "pull request is not open");
  if (sha !== pr.headSha) return ignore(pr.number, "not the current head");

  let result: CiResult | null = null;
  if (mode !== "pending") {
    result = conclude(
      await deps.github.listCheckRuns(pr.repo, sha),
      deps.runnerAppSlug,
    );
    if (result === null && mode === "final")
      return ignore(pr.number, "checks still running");
  }
  const conclusion = result?.conclusion ?? "pending";
  if (result === null) {
    const existing = await deps.store.listEvidence({
      nodeId: linked.nodeId,
      commitSha: sha,
      kind: "ci_run",
    });
    if (existing.length > 0) return ignore(pr.number, "head already has a ci_run");
  }
  const changedPaths = await deps.github.listChangedPaths(pr.repo, pr.number);
  const facts = [
    evidence(
      deps,
      linked.nodeId,
      "ci_run",
      sha,
      { conclusion, pr: pr.number, changedPaths },
      ciRunKey(pr.repo, pr.number, sha, conclusion, result?.attempt),
    ),
  ];
  const preview = result ? await readPreviewCheck(deps.github, pr.repo, sha) : null;
  if (preview) {
    facts.push(
      evidence(
        deps,
        linked.nodeId,
        "preview_check",
        sha,
        {
          pass: preview.pass,
          conclusion: preview.conclusion,
          pr: pr.number,
          workflowRunId: preview.workflowRunId,
          jobId: preview.jobId,
        },
        previewCheckKey(pr.repo, pr.number, sha, preview),
      ),
    );
  }
  return { pr: pr.number, reason: null, facts };
}

async function mergeFinding(deps: IngestDeps, pr: PullRequest): Promise<Finding> {
  const linked = await link(deps, pr);
  if ("reason" in linked) return ignore(pr.number, linked.reason);
  if (!pr.merged || pr.mergeCommitSha === null) return ignore(pr.number, "not merged");
  return {
    pr: pr.number,
    reason: null,
    facts: [
      evidence(
        deps,
        linked.nodeId,
        "merge_commit",
        pr.mergeCommitSha,
        { pr: pr.number },
        mergeCommitKey(pr.repo, pr.number),
      ),
    ],
  };
}

async function fetchPullRequest(
  deps: IngestDeps,
  repo: string,
  number: number,
): Promise<PullRequest | Finding> {
  return (
    (await deps.github.getPullRequest(repo, number)) ??
    ignore(number, "pull request not found")
  );
}

const isFinding = (value: PullRequest | Finding): value is Finding => "facts" in value;

// Payload readers. A signed payload missing a field we need is rejected, not guessed at.
class MalformedPayload extends Error {}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function str(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new MalformedPayload();
  return value;
}

const isPullRequestNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

function prNumber(value: unknown): number {
  if (!isPullRequestNumber(value)) throw new MalformedPayload();
  return value;
}

/** A commit the ingest flow is handed: a full commit id, or the payload is not read. */
function fullSha(value: string): string {
  if (!FULL_SHA.test(value)) throw new MalformedPayload();
  return value;
}

/** The delivery's repository, `repository.full_name`, or null when the payload names none. */
function repositoryOf(payload: unknown): string | null {
  const name = field(field(payload, "repository"), "full_name");
  return typeof name === "string" && name !== "" ? name : null;
}

type Decided = Exclude<DeliveryDecision, { kind: "unhandled" | "rejected" }>;

/**
 * What a handled event amounts to from its signed payload alone: what ingestion decided without
 * GitHub before (D-381), or the identifiers it reads GitHub with. Throws `MalformedPayload`.
 */
function decide(id: string, event: string, repo: string, payload: unknown): Decided {
  const ignored = (pr: number | null, reason: string): Decided => ({
    kind: "ignored",
    repo,
    pr,
    reason,
  });
  // The repository a token and an API path are built for (D-267): handed on only in that form.
  const handedOn = (delivery: HandedOnDelivery): Decided => {
    if (!REPOSITORY.test(repo)) throw new MalformedPayload();
    return { kind: "handed_on", repo, pr: delivery.pullRequests[0]!, delivery };
  };
  const action = field(payload, "action");
  if (event === "pull_request") {
    const pull = field(payload, "pull_request");
    const number = prNumber(field(pull, "number"));
    if (action === "opened" || action === "reopened" || action === "synchronize") {
      const sha = fullSha(str(field(field(pull, "head"), "sha")));
      return handedOn({
        deliveryId: id,
        event,
        action,
        repo,
        pullRequests: [number],
        headSha: sha,
      });
    }
    if (action === "closed") {
      if (field(pull, "merged") !== true)
        return ignored(number, "closed without merging");
      return handedOn({
        deliveryId: id,
        event,
        action,
        repo,
        pullRequests: [number],
        headSha: null,
      });
    }
    return ignored(number, "pull request action not used");
  }
  if (event === "check_suite" || event === "workflow_run") {
    if (action !== "completed") return ignored(null, "not a completion");
    const subject = field(payload, event);
    const sha = str(field(subject, "head_sha"));
    const pulls = field(subject, "pull_requests");
    if (!Array.isArray(pulls)) throw new MalformedPayload();
    // GitHub lists only PRs whose head is in this repository, so a fork's run lists none.
    if (pulls.length === 0) return ignored(null, "no pull request for this commit");
    const numbers = [...new Set(pulls.map((pull) => prNumber(field(pull, "number"))))];
    return handedOn({
      deliveryId: id,
      event,
      action,
      repo,
      pullRequests: numbers,
      headSha: fullSha(sha),
    });
  }
  // deployment_status and push: not evidence by themselves; the runner checks staging itself
  // (ADR 0107). The preview check is CI's own job, read with the CI result (D-354).
  return ignored(null, "not evidence by itself");
}

/**
 * What one authenticated delivery amounts to from its signed payload alone, with no GitHub read
 * and no store (D-381, O-128).
 */
export function decideDelivery(delivery: Delivery): DeliveryDecision {
  const repo = repositoryOf(delivery.payload);
  if (!HANDLED_EVENTS.has(delivery.event)) return { kind: "unhandled", repo };
  const rejected = { kind: "rejected", repo, reason: "malformed payload" } as const;
  if (repo === null) return rejected;
  try {
    return decide(delivery.id, delivery.event, repo, delivery.payload);
  } catch (error) {
    if (!(error instanceof MalformedPayload)) throw error;
    return rejected;
  }
}

/**
 * Records one authenticated delivery as the receiver decides it (D-381, O-128): `ignored` or
 * `rejected` when the payload settles it, `recorded` with the reason `HANDED_ON` when it needs
 * GitHub, and then names what the ingest flow is started with. A replayed delivery id writes
 * nothing and names nothing, even when two copies race: the store records an id once.
 */
export async function receiveDelivery(
  deps: ReceiveDeps,
  delivery: Delivery,
): Promise<ReceiveResult> {
  const decision = decideDelivery(delivery);
  const { repo } = decision;
  if (decision.kind === "unhandled") {
    return { outcome: "unhandled", reason: null, repo, pr: null, handedOn: null };
  }
  const outcome: GithubDeliveryOutcome =
    decision.kind === "handed_on" ? "recorded" : decision.kind;
  const reason = decision.kind === "handed_on" ? HANDED_ON : decision.reason;
  const pr = decision.kind === "rejected" ? null : decision.pr;
  const fresh = await deps.store.recordGithubDelivery({
    deliveryId: delivery.id,
    eventType: delivery.event,
    repository: repo,
    receivedAt: deps.clock.now(),
    outcome,
    reason,
  });
  if (!fresh) return { outcome: "duplicate", reason: null, repo, pr, handedOn: null };
  return {
    outcome,
    reason,
    repo,
    pr,
    handedOn: decision.kind === "handed_on" ? decision.delivery : null,
  };
}

const INPUT_KEYS = new Set([
  "deliveryId",
  "event",
  "action",
  "repo",
  "pullRequests",
  "headSha",
]);

/**
 * The ingest flow's input read strictly (D-381, O-128): exactly the fields the receiver hands on,
 * in the combinations it hands them on in, or null. Any other key, a repository that is not
 * `owner/name`, a commit that is not a full commit id, or a pull request number that is not a
 * positive integer is refused.
 */
export function readHandedOnDelivery(input: unknown): HandedOnDelivery | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  if (Object.keys(input).some((key) => !INPUT_KEYS.has(key))) return null;
  const deliveryId = field(input, "deliveryId");
  const event = field(input, "event");
  const action = field(input, "action");
  const repo = field(input, "repo");
  const list = field(input, "pullRequests");
  const headSha = field(input, "headSha");
  if (typeof deliveryId !== "string" || !DELIVERY_ID.test(deliveryId)) return null;
  if (typeof repo !== "string" || !REPOSITORY.test(repo)) return null;
  if (!Array.isArray(list) || list.length === 0 || !list.every(isPullRequestNumber))
    return null;
  const pullRequests = [...(list as number[])];
  const sha = typeof headSha === "string" && FULL_SHA.test(headSha) ? headSha : null;
  if (event === "pull_request") {
    if (pullRequests.length !== 1) return null;
    if (action === "closed") {
      return headSha === null
        ? { deliveryId, event, action, repo, pullRequests, headSha: null }
        : null;
    }
    if (action === "opened" || action === "reopened" || action === "synchronize") {
      return sha
        ? { deliveryId, event, action, repo, pullRequests, headSha: sha }
        : null;
    }
    return null;
  }
  if ((event === "check_suite" || event === "workflow_run") && action === "completed") {
    return sha ? { deliveryId, event, action, repo, pullRequests, headSha: sha } : null;
  }
  return null;
}

/** What a handed-on delivery amounts to, reading each PR's live state from GitHub. */
async function examine(
  deps: IngestDeps,
  delivery: HandedOnDelivery,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const number of delivery.pullRequests) {
    const pr = await fetchPullRequest(deps, delivery.repo, number);
    if (isFinding(pr)) findings.push(pr);
    else if (delivery.action === "closed") findings.push(await mergeFinding(deps, pr));
    else {
      const mode = delivery.event === "pull_request" ? "pending" : "final";
      findings.push(await ciRunFinding(deps, pr, delivery.headSha, mode));
    }
  }
  return findings;
}

/** Inserts each fact unless its key is already recorded. Returns the ids inserted. */
async function insertFacts(
  tx: StoreOps,
  findings: readonly Finding[],
): Promise<string[]> {
  const inserted: string[] = [];
  for (const { facts } of findings) {
    for (const fact of facts) {
      if (await tx.insertEvidenceOnce(fact.evidence, fact.key))
        inserted.push(fact.evidence.id);
    }
  }
  return inserted;
}

/** The final `ci_run` facts among those just inserted (`inserted`, their evidence ids). */
function finishedCiOf(
  findings: readonly Finding[],
  inserted: readonly string[],
): FinishedCi[] {
  const ids = new Set(inserted);
  return findings
    .flatMap((f) => f.facts)
    .map((fact) => fact.evidence)
    .filter(
      (e) =>
        ids.has(e.id) &&
        e.kind === "ci_run" &&
        e.commitSha !== null &&
        field(e.payload, "conclusion") !== "pending",
    )
    .map((e) => ({ nodeId: e.nodeId, commitSha: e.commitSha as string }));
}

/**
 * Records what one handed-on delivery says, as the ingest flow reads it (D-381, O-128): each
 * PR's live state from GitHub, then each fact under its ingest key in one transaction, so a fact
 * the polling backstop or another delivery already recorded is not recorded again. The delivery
 * row is the receiver's, written before the flow started.
 */
export async function ingestHandedOn(
  deps: IngestDeps,
  delivery: HandedOnDelivery,
): Promise<HandedOnIngest> {
  const findings = await examine(deps, delivery);
  const evidenceIds = await deps.store.transaction((tx) => insertFacts(tx, findings));
  const recorded = evidenceIds.length > 0;
  return {
    outcome: recorded ? "recorded" : "ignored",
    reason: recorded
      ? null
      : (findings.find((f) => f.reason !== null)?.reason ?? "already recorded"),
    pr: findings.find((f) => f.pr !== null)?.pr ?? null,
    evidenceIds,
    finishedCi: finishedCiOf(findings, evidenceIds),
  };
}

export interface PollResult {
  pr: number;
  outcome: "recorded" | "ignored";
  reason: string | null;
  evidenceIds: string[];
}

/** The PR named by a node's newest `ci_run`, if any. */
async function lastPullRequest(
  store: StoreOps,
  nodeId: string,
): Promise<number | null> {
  const ciRuns = await store.listEvidence({ nodeId, kind: "ci_run" });
  const pr = field(ciRuns.at(-1)?.payload, "pr");
  return typeof pr === "number" ? pr : null;
}

/**
 * The polling backstop for one repository (ADR 0113 section 6, run by the reconcile pass in
 * M2.4). For every open PR it records the current head's `ci_run`; for every dispatched node
 * whose PR is no longer open it records the merge. Same functions and keys as the webhooks, so
 * a missed webhook is caught here and a received one is never recorded twice.
 */
export async function pollRepository(
  deps: IngestDeps,
  repo: string,
): Promise<PollResult[]> {
  const results: PollResult[] = [];
  const record = async (finding: Finding): Promise<void> => {
    const evidenceIds = await deps.store.transaction((tx) =>
      insertFacts(tx, [finding]),
    );
    results.push({
      pr: finding.pr ?? 0,
      outcome: evidenceIds.length > 0 ? "recorded" : "ignored",
      reason: evidenceIds.length > 0 ? null : (finding.reason ?? "already recorded"),
      evidenceIds,
    });
  };

  const open = await deps.github.listOpenPullRequests(repo);
  for (const pr of open)
    await record(await ciRunFinding(deps, pr, pr.headSha, "current"));

  const openNumbers = new Set(open.map((pr) => pr.number));
  for (const dispatch of await deps.store.listDispatches({ repo })) {
    const number = await lastPullRequest(deps.store, dispatch.nodeId);
    if (number === null || openNumbers.has(number)) continue;
    const merges = await deps.store.listEvidence({
      nodeId: dispatch.nodeId,
      kind: "merge_commit",
    });
    if (merges.some((m) => field(m.payload, "pr") === number)) continue;
    const pr = await fetchPullRequest(deps, repo, number);
    await record(isFinding(pr) ? pr : await mergeFinding(deps, pr));
  }
  return results;
}
