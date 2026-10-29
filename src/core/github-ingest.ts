// GitHub evidence ingestion (build plan M2.3, ADR 0113). Plain functions over an injected GitHub
// reader, store, clock and id source: webhooks and the polling backstop both end here, build the
// same ingest keys for the same facts, and so never record a fact twice.
//
// The head rule (D-178, docs/guards.md): a guard takes the head commit from the newest `ci_run`,
// so a `ci_run` is recorded only for the PR's current head as GitHub reports it at that moment.
// A late event about an older commit records nothing, and the head never moves back.
import type { GitHubReader, CheckRun, PullRequest } from "./github.ts";
import type { Clock, IdSource } from "./library.ts";
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

export interface IngestResult {
  /**
   * What was stored for the delivery. `duplicate` (its id was seen before) and `unhandled` (an
   * event type ingestion does not read) store nothing.
   */
  outcome: GithubDeliveryOutcome | "duplicate" | "unhandled";
  /** A short fixed reason when nothing new was recorded. Never text from the payload. */
  reason: string | null;
  repo: string | null;
  pr: number | null;
  evidenceIds: string[];
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
  kind: "ci_run" | "merge_commit",
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
 * pending event never hides a finished result.
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
  return {
    pr: pr.number,
    reason: null,
    facts: [
      evidence(
        deps,
        linked.nodeId,
        "ci_run",
        sha,
        { conclusion, pr: pr.number, changedPaths },
        ciRunKey(pr.repo, pr.number, sha, conclusion, result?.attempt),
      ),
    ],
  };
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

function prNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new MalformedPayload();
  return value;
}

/** What a handled event amounts to, reading the PR's live state from GitHub. */
async function examine(
  deps: IngestDeps,
  event: string,
  repo: string,
  payload: unknown,
): Promise<Finding[]> {
  const action = field(payload, "action");
  if (event === "pull_request") {
    const pull = field(payload, "pull_request");
    const number = prNumber(field(pull, "number"));
    if (action === "opened" || action === "reopened" || action === "synchronize") {
      const sha = str(field(field(pull, "head"), "sha"));
      const pr = await fetchPullRequest(deps, repo, number);
      return [isFinding(pr) ? pr : await ciRunFinding(deps, pr, sha, "pending")];
    }
    if (action === "closed") {
      if (field(pull, "merged") !== true)
        return [ignore(number, "closed without merging")];
      const pr = await fetchPullRequest(deps, repo, number);
      return [isFinding(pr) ? pr : await mergeFinding(deps, pr)];
    }
    return [ignore(number, "pull request action not used")];
  }
  if (event === "check_suite" || event === "workflow_run") {
    if (action !== "completed") return [ignore(null, "not a completion")];
    const subject = field(payload, event);
    const sha = str(field(subject, "head_sha"));
    const pulls = field(subject, "pull_requests");
    if (!Array.isArray(pulls)) throw new MalformedPayload();
    // GitHub lists only PRs whose head is in this repository, so a fork's run lists none.
    if (pulls.length === 0) return [ignore(null, "no pull request for this commit")];
    const findings: Finding[] = [];
    for (const pull of pulls) {
      const pr = await fetchPullRequest(deps, repo, prNumber(field(pull, "number")));
      findings.push(isFinding(pr) ? pr : await ciRunFinding(deps, pr, sha, "final"));
    }
    return findings;
  }
  // deployment_status and push: the runner runs its own preview or staging check on these
  // (ADR 0107); they are not evidence by themselves.
  return [ignore(null, "not evidence by itself")];
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

class DuplicateDelivery extends Error {}

/**
 * Records what one authenticated webhook delivery says. The delivery row and its evidence commit
 * together, so a replayed delivery id writes nothing, even when two copies race.
 */
export async function ingestDelivery(
  deps: IngestDeps,
  delivery: Delivery,
): Promise<IngestResult> {
  const repository = field(field(delivery.payload, "repository"), "full_name");
  const repo = typeof repository === "string" && repository !== "" ? repository : null;
  if (!HANDLED_EVENTS.has(delivery.event)) {
    return { outcome: "unhandled", reason: null, repo, pr: null, evidenceIds: [] };
  }

  let findings: Finding[] | null = null;
  if (repo !== null) {
    try {
      findings = await examine(deps, delivery.event, repo, delivery.payload);
    } catch (error) {
      if (!(error instanceof MalformedPayload)) throw error;
    }
  }
  const pr = findings?.find((f) => f.pr !== null)?.pr ?? null;

  try {
    return await deps.store.transaction(async (tx) => {
      const evidenceIds = findings ? await insertFacts(tx, findings) : [];
      const outcome: GithubDeliveryOutcome =
        findings === null
          ? "rejected"
          : evidenceIds.length > 0
            ? "recorded"
            : "ignored";
      const reason =
        findings === null
          ? "malformed payload"
          : outcome === "recorded"
            ? null
            : (findings.find((f) => f.reason !== null)?.reason ?? "already recorded");
      const fresh = await tx.recordGithubDelivery({
        deliveryId: delivery.id,
        eventType: delivery.event,
        repository: repo,
        receivedAt: deps.clock.now(),
        outcome,
        reason,
      });
      // Rolls back any evidence this copy inserted; the first copy owns the result.
      if (!fresh) throw new DuplicateDelivery();
      return { outcome, reason, repo, pr, evidenceIds };
    });
  } catch (error) {
    if (!(error instanceof DuplicateDelivery)) throw error;
    return { outcome: "duplicate", reason: null, repo, pr, evidenceIds: [] };
  }
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
