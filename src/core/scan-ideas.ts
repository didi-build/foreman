// The Scanner's stage 1 files its findings as ideas (D-150, D-299, D-300, O-92). After a scan of
// one project's repository (./scan.ts), the runner, not the Job, creates one idea per new finding
// in Machine 1's entry state, the same front door a run's findings use (./finding-ideas.ts,
// D-244), and records the scan (migration 0017) so the daily check can show what it found
// (./daily-check.ts). The Council sizes each idea; nothing here moves a node, opens a gate
// request, opens a PR or changes code.
//
// Each idea's fields (P-14): `body.source` is `scanner`, `body.class` the check's class (`bug` or
// `drift`), `body.check` the check id, `body.evidence` the file and line, `body.confidence` 1 (a
// fixed check is certain), `body.dedupeKey` the check and what the finding is about, never its line
// (./scan.ts `scanDedupeKey`), and `body.foundBy` the scanner stage and the commit. The title and
// description come from the runner's own table of checks, with only a checked path from the Job.
//
// Safeguards (P-14, D-300), in one transaction that locks the project row, so two scans of the
// same project take turns:
// - Dedupe: a finding whose key is one of an open scanner idea's keys (its own, and the ones folded
//   into it), or of an idea whose work items (`split_into`) are not all finished, is merged:
//   nothing new is recorded for it. So is a finding whose key is a Parked or Rejected scanner
//   idea's, until that idea is reopened (D-301 (1)).
// - Fold in (D-301 (2)): a new finding with the same check and the same file as a scanner idea
//   that was open when the scan began, or that this scan filed earlier (D-304), is added to the
//   oldest such idea as `scan_scope_update`
//   evidence on the scan's commit, `{check, path, line, target, dedupeKey}`, append-only. Its key
//   is then the idea's, so later scans merge it. Folded findings do not count toward the cap.
// - Cap: at most `SCAN_IDEA_CAP` (5) new ideas per scan; new findings past it, and findings the
//   Job only counted, are counted as over the cap and not filed. The next scan finds them again.
// - Clean up (D-301 (3)): each scanner idea open when the scan began, none of whose keys the scan
//   found, where every check its keys name ran over its file and listed all its findings
//   (`scanFoundNone`, ./scan.ts), gets `scan_not_found` evidence on the scan's commit, once per
//   commit. One still in Submitted is then withdrawn: after the transaction the runner asks for
//   the runner-only move Submitted to Rejected, guarded by `scanner_finding_gone`
//   (./guards/scanner.ts), with the trigger `scan:<scan id>`; the move's transaction closes the
//   idea's open plan-approval request as cancelled, so Didi is not left answering about a
//   withdrawn idea (D-316 (4)). One further along is never moved
//   and none of its work items is touched: when its `scan_not_found` is new and no question is
//   open on `scanner-gone:<idea id>`, a Council question opens there (./council.ts), so at most
//   one is open per idea and it is asked once per commit.
// - Switches: under the kill switch or in dry run it writes nothing, as ./finding-ideas.ts, so a
//   held scan folds and cleans up nothing either; a failed scan only records its failure.
// Plain logic over an injected store, clock, id source, the contracts and guards (D-162).
import { isTerminalState, type Contracts, type GuardRegistry } from "./contracts.ts";
import { insertIdea, switchesHolding } from "./finding-ideas.ts";
import { IDEA_ENTRY } from "./ideas.ts";
import {
  createLibrary,
  type Clock,
  type IdSource,
  type TransitionOutcome,
} from "./library.ts";
import {
  isPlainRepoPath,
  SCAN_CHECKS,
  scanDedupeKey,
  scanFoundNone,
  scanIdea,
  type RepoScan,
  type ScanCheckId,
  type ScanClass,
  type ScanFinding,
  type ScanKey,
  type ScanNotRun,
} from "./scan.ts";
import { planApprovalTopic } from "./plans.ts";
import type { Evidence, GateRequest, Json, Node, Store, StoreOps } from "./store.ts";

/** The mark on an idea the Scanner created (P-14). */
export const SCANNER_SOURCE = "scanner";
/** Stage 1: fixed checks, no model (D-299). */
export const SCANNER_STAGE = "fixed-checks";
/** At most this many new ideas per scan of one project (D-300). */
export const SCAN_IDEA_CAP = 5;
/** Who records a scan. */
export const SCANNER_ACTOR = "runner:scanner";

/** Where a withdrawn scanner idea goes (D-301 (3)), and the states that absorb (D-301 (1)). */
export const WITHDRAWN_STATE = "rejected";
export const PARKED_OR_REJECTED: readonly string[] = ["parked", WITHDRAWN_STATE];
/** The withdrawal's trigger names the scan: `scan:<scan id>`. */
export const SCAN_TRIGGER_PREFIX = "scan:";
/** The Council question on whether to stop a scanner idea that is no longer found. */
export const SCANNER_GONE_PREFIX = "scanner-gone:";
export const scannerGoneTopic = (nodeId: string): string =>
  `${SCANNER_GONE_PREFIX}${nodeId}`;

/** The fixed reason recorded on an idea the scan no longer finds. */
export const notFoundText = (commitSha: string): string =>
  `No longer found by the scanner at commit ${commitSha}.`;

/** The question the Council is asked about such an idea further along (D-301 (3)). */
export const SCANNER_GONE_QUESTION =
  "The Scanner no longer finds any of this idea's findings. Should the idea be stopped?";

/** The step a failed scan stopped at: a fixed name, never an error's text. */
export type ScanFailure = "github" | "cluster" | "job" | "result" | "other";

export const SCAN_FAILURE_TEXT: Record<ScanFailure, string> = {
  github: "reading the repository from GitHub failed",
  cluster: "creating or reading the scan Job on the cluster failed",
  job: "the scan Job failed or did not end in time",
  result: "the scan Job's result was refused as malformed",
  other: "the scan stopped on an unexpected error",
};

/** A new idea, as the scan's summary names it. */
export interface ScanNewIdea {
  nodeId: string;
  title: string;
  check: ScanCheckId;
  class: ScanClass;
}

/** A new finding folded into an open idea (D-301 (2)). */
export interface ScanFolded {
  nodeId: string;
  title: string;
  check: ScanCheckId;
  dedupeKey: string;
}

/** An open idea none of whose findings the scan found (D-301 (3)). */
export interface ScanGone {
  nodeId: string;
  title: string;
  /** The idea's state when the scan ran. */
  state: string;
  /** `withdraw`: still in Submitted, so the runner asks for the move to Rejected. */
  action: "withdraw" | "asked_council";
}

/** What a scan found and filed: the record the daily check reads. */
export interface ScanSummary {
  /** Every finding by check, including any the Job only counted. */
  counts: Record<ScanCheckId, number>;
  findings: number;
  newIdeas: ScanNewIdea[];
  /** Findings already on an open, parked or rejected idea or an open item: nothing new recorded. */
  merged: number;
  /** New findings folded into an open idea (D-301 (2)); not counted toward the cap. */
  folded: ScanFolded[];
  /** Findings past the cap, filed by no idea this time. */
  overCap: number;
  cap: number;
  /** Open ideas the scan no longer found (D-301 (3)). */
  gone: ScanGone[];
  /**
   * The findings the Job listed and where a check did not run, as checked, so the guard
   * `scanner_finding_gone` reads what the scan found. Absent from a record made before D-301.
   */
  listed?: ScanFinding[];
  notRun?: ScanNotRun[];
}

export interface ScanIdeasOptions {
  store: Store;
  clock: Clock;
  ids: IdSource;
  contracts: Contracts;
  guards: GuardRegistry;
}

/** The withdrawal of one idea still in Submitted: the library's answer to the move. */
export interface ScanWithdrawal {
  nodeId: string;
  outcome: TransitionOutcome;
  reason?: string;
}

export type ScanFiling =
  | { step: "filed"; summary: ScanSummary; withdrawals: ScanWithdrawal[] }
  | { step: "refused"; reason: "no_project" | "kill_switch" | "dry_run" };

export type ScanFailureRecord =
  | { step: "recorded" }
  | { step: "refused"; reason: "no_project" | "kill_switch" | "dry_run" };

const field = (value: Json | undefined, key: string): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value[key]
    : undefined;

/** A scope update's finding, or null when the evidence is not of the shape the runner writes. */
export function readScopeUpdate(evidence: Pick<Evidence, "payload">): ScanKey | null {
  const check = field(evidence.payload, "check");
  const path = field(evidence.payload, "path");
  const dedupeKey = field(evidence.payload, "dedupeKey");
  if (
    typeof check !== "string" ||
    !(SCAN_CHECKS as readonly string[]).includes(check) ||
    !isPlainRepoPath(path) ||
    typeof dedupeKey !== "string" ||
    !dedupeKey.startsWith(`scanner:${check}:${path}`)
  ) {
    return null;
  }
  return { check: check as ScanCheckId, path, dedupeKey };
}

/**
 * Closes the open plan-approval request on a withdrawn idea as cancelled (D-316 (4)), in the
 * withdrawal's own transaction. Answered and closed requests are left as they are.
 */
async function cancelPlanRequest(
  tx: Pick<StoreOps, "listGateRequests" | "closeGateRequest">,
  projectId: string,
  ideaId: string,
  at: Date,
): Promise<null> {
  for (const gate of await tx.listGateRequests(projectId, planApprovalTopic(ideaId))) {
    if (gate.status === "open")
      await tx.closeGateRequest(gate.id, { status: "cancelled", at });
  }
  return null;
}

/** Whether a node is an idea the Scanner filed. */
export const isScannerIdea = (node: Pick<Node, "type" | "body">): boolean =>
  node.type === "idea" && field(node.body, "source") === SCANNER_SOURCE;

/**
 * A scanner idea's keys: its own (`body.check`, the first evidence path and `body.dedupeKey`)
 * and each one folded into it by a `scan_scope_update` (D-301 (2)). Empty when its own fields
 * cannot be read, so such an idea is never taken as no longer found; a scope update that cannot
 * be read is left out, and then too the idea is never taken as no longer found.
 */
export function scannerIdeaKeys(
  node: Pick<Node, "type" | "body">,
  scopeUpdates: readonly Pick<Evidence, "payload">[],
): ScanKey[] {
  if (!isScannerIdea(node)) return [];
  const first = Array.isArray(field(node.body, "evidence"))
    ? ((field(node.body, "evidence") as Json[])[0] ?? null)
    : null;
  const ownKey = readScopeUpdate({
    payload: {
      check: field(node.body, "check") ?? null,
      path: field(first, "path") ?? null,
      dedupeKey: field(node.body, "dedupeKey") ?? null,
    },
  });
  if (ownKey === null) return [];
  const folded = scopeUpdates.map(readScopeUpdate);
  if (folded.some((k) => k === null)) return [];
  return [ownKey, ...(folded as ScanKey[])];
}

/** A scanner idea of the project as the scan reads it in its transaction. */
interface ScannerIdea {
  node: Node;
  /** Its own key and the folded ones, as recorded (for the dedupe). */
  dedupeKeys: string[];
  /** The keys the clean up reads (./scan.ts `ScanKey`), or empty when they cannot be read. */
  keys: ScanKey[];
  /** Open as O-92 defines it: not terminal, or terminal with an unfinished work item. */
  open: boolean;
}

export function createScanIdeas({
  store,
  clock,
  ids,
  contracts,
  guards,
}: ScanIdeasOptions) {
  const terminal = (state: string) => isTerminalState(contracts, state);
  const library = createLibrary({ store, contracts, guards, clock, ids });

  /** The project's scanner ideas, each with its keys and whether it is open. */
  async function scannerIdeas(tx: StoreOps, projectId: string): Promise<ScannerIdea[]> {
    const nodes = await tx.listNodes({ projectId });
    const byId = new Map(nodes.map((n): [string, Node] => [n.id, n]));
    const found: ScannerIdea[] = [];
    for (const node of nodes) {
      if (!isScannerIdea(node)) continue;
      const updates = await tx.listEvidence({
        nodeId: node.id,
        kind: "scan_scope_update",
      });
      const own = field(node.body, "dedupeKey");
      const dedupeKeys = [
        ...(typeof own === "string" ? [own] : []),
        ...updates
          .map((e) => field(e.payload, "dedupeKey"))
          .filter((k): k is string => typeof k === "string"),
      ];
      let open = !terminal(node.state);
      if (!open) {
        const items = await tx.listEdges({ fromNode: node.id, type: "split_into" });
        open = items.some((edge) => {
          const item = byId.get(edge.toNode);
          return item !== undefined && !terminal(item.state);
        });
      }
      found.push({ node, dedupeKeys, keys: scannerIdeaKeys(node, updates), open });
    }
    // Oldest first, so a fold-in picks the oldest matching idea.
    return found.sort(
      (a, b) =>
        a.node.createdAt.getTime() - b.node.createdAt.getTime() ||
        (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0),
    );
  }

  /** Opens the Council question on an idea the scan no longer finds, unless one is open. */
  async function askCouncil(
    tx: StoreOps,
    node: Node,
    commitSha: string,
    at: Date,
  ): Promise<void> {
    const topicKey = scannerGoneTopic(node.id);
    if (await tx.findOpenGateRequest(node.projectId, topicKey)) return;
    const gate: GateRequest = {
      id: ids.next(),
      projectId: node.projectId,
      nodeId: node.id,
      topicKey,
      kind: "council_question",
      owner: "council",
      blocking: false,
      payload: { question: SCANNER_GONE_QUESTION, commitSha },
      approvalUrl: null,
      status: "open",
      decisionId: null,
      supersededBy: null,
      createdAt: at,
      answeredAt: null,
      lastNotifiedAt: null,
    };
    await tx.insertGateRequest(gate);
  }

  return {
    /**
     * Files the scan's new findings as ideas, at most the cap, folds new findings into open
     * ideas, records what the scan no longer finds and the scan itself, in one transaction; then
     * withdraws each idea still in Submitted that it no longer finds (D-301).
     */
    async file(projectId: string, scan: RepoScan): Promise<ScanFiling> {
      const filed = await store.transaction(async (tx) => {
        const switches = await switchesHolding(tx);
        if (switches) return { step: "refused" as const, reason: switches };
        if (!(await tx.lockProject(projectId))) {
          return { step: "refused" as const, reason: "no_project" as const };
        }
        const ideas = await scannerIdeas(tx, projectId);
        const absorbing = new Set(
          ideas
            .filter((i) => i.open || PARKED_OR_REJECTED.includes(i.node.state))
            .flatMap((i) => i.dedupeKeys),
        );
        const openByFile = new Map<string, ScannerIdea>();
        for (const idea of ideas) {
          const own = idea.keys[0];
          const where = own && `${own.check}\u0000${own.path}`;
          if (idea.open && where && !openByFile.has(where)) openByFile.set(where, idea);
        }
        const at = clock.now();
        const scanId = ids.next();
        const ref = `${SCAN_TRIGGER_PREFIX}${scanId}`;
        const newIdeas: ScanNewIdea[] = [];
        const filedByFile = new Map<string, { id: string; title: string }>();
        const folded: ScanFolded[] = [];
        let merged = 0;
        for (const finding of scan.findings) {
          const dedupeKey = scanDedupeKey(finding);
          if (absorbing.has(dedupeKey)) {
            merged += 1;
            continue;
          }
          const where = `${finding.check}\u0000${finding.path}`;
          // An idea open when the scan began, or one this scan filed earlier for the same check
          // and file (D-304), so the result does not depend on which day a finding first shows.
          const into = openByFile.get(where)?.node ?? filedByFile.get(where);
          if (into) {
            await tx.insertEvidence({
              id: ids.next(),
              nodeId: into.id,
              runId: null,
              kind: "scan_scope_update",
              ref,
              commitSha: scan.commitSha,
              payload: { ...finding, dedupeKey },
              recordedBy: SCANNER_ACTOR,
              recordedAt: at,
              supersedesId: null,
            });
            absorbing.add(dedupeKey);
            folded.push({
              nodeId: into.id,
              title: into.title,
              check: finding.check,
              dedupeKey,
            });
            continue;
          }
          if (newIdeas.length >= SCAN_IDEA_CAP) continue;
          const idea = scanIdea(finding, scan.commitSha);
          const id = ids.next();
          await insertIdea(tx, {
            id,
            projectId,
            title: idea.title,
            body: {
              source: SCANNER_SOURCE,
              description: idea.description,
              class: idea.class,
              check: idea.check,
              evidence: idea.evidence,
              confidence: idea.confidence,
              dedupeKey: idea.dedupeKey,
              foundBy: { scanner: SCANNER_STAGE, commitSha: scan.commitSha },
            },
            at,
          });
          filedByFile.set(where, { id, title: idea.title });
          newIdeas.push({
            nodeId: id,
            title: idea.title,
            check: idea.check,
            class: idea.class,
          });
        }
        // Clean up: only ideas open when the scan began, and only when the scan certainly
        // found none of their keys.
        const gone: ScanGone[] = [];
        const toWithdraw: string[] = [];
        for (const idea of ideas) {
          if (!idea.open || !scanFoundNone(scan, idea.keys)) continue;
          const { node } = idea;
          const recorded = await tx.listEvidence({
            nodeId: node.id,
            kind: "scan_not_found",
            commitSha: scan.commitSha,
          });
          if (recorded.length === 0) {
            await tx.insertEvidence({
              id: ids.next(),
              nodeId: node.id,
              runId: null,
              kind: "scan_not_found",
              ref,
              commitSha: scan.commitSha,
              payload: { note: notFoundText(scan.commitSha) },
              recordedBy: SCANNER_ACTOR,
              recordedAt: at,
              supersedesId: null,
            });
          }
          if (node.state === IDEA_ENTRY.state) {
            toWithdraw.push(node.id);
            gone.push({
              nodeId: node.id,
              title: node.title,
              state: node.state,
              action: "withdraw",
            });
            continue;
          }
          // Never moved, and no work item is touched: the Council is asked, once per commit.
          if (recorded.length === 0) await askCouncil(tx, node, scan.commitSha, at);
          gone.push({
            nodeId: node.id,
            title: node.title,
            state: node.state,
            action: "asked_council",
          });
        }
        const findings = SCAN_CHECKS.reduce((sum, c) => sum + scan.counts[c], 0);
        const summary: ScanSummary = {
          counts: { ...scan.counts },
          findings,
          newIdeas,
          merged,
          folded,
          overCap: findings - merged - folded.length - newIdeas.length,
          cap: SCAN_IDEA_CAP,
          gone,
          listed: scan.findings.map((f) => ({ ...f })),
          notRun: scan.notRun.map((n) => ({ ...n })),
        };
        await tx.insertScan({
          id: scanId,
          projectId,
          commitSha: scan.commitSha,
          outcome: "scanned",
          summary: summary as unknown as Json,
          recordedBy: SCANNER_ACTOR,
          recordedAt: at,
        });
        return { step: "filed" as const, summary, toWithdraw, ref };
      });
      if (filed.step === "refused") return filed;
      const withdrawals: ScanWithdrawal[] = [];
      for (const nodeId of filed.toWithdraw) {
        const move = await library.requestTransitionOnce(
          {
            nodeId,
            toState: WITHDRAWN_STATE,
            trigger: { kind: "event", ref: filed.ref },
            actor: { kind: "runner", id: SCANNER_ACTOR },
            runnerOnly: true,
            reason: notFoundText(scan.commitSha),
          },
          // Didi is not left answering about a withdrawn idea (D-316 (4)).
          (tx) => cancelPlanRequest(tx, projectId, nodeId, clock.now()),
        );
        withdrawals.push({
          nodeId,
          outcome: move.outcome,
          ...(move.reason ? { reason: move.reason } : {}),
        });
      }
      return { step: "filed", summary: filed.summary, withdrawals };
    },

    /** Records that a scan failed, by the step's fixed name only. */
    async recordFailure(
      projectId: string,
      failure: ScanFailure,
      commitSha: string | null = null,
    ): Promise<ScanFailureRecord> {
      return store.transaction(async (tx): Promise<ScanFailureRecord> => {
        const switches = await switchesHolding(tx);
        if (switches) return { step: "refused", reason: switches };
        if (!(await tx.lockProject(projectId))) {
          return { step: "refused", reason: "no_project" };
        }
        await tx.insertScan({
          id: ids.next(),
          projectId,
          commitSha,
          outcome: "failed",
          summary: { failure },
          recordedBy: SCANNER_ACTOR,
          recordedAt: clock.now(),
        });
        return { step: "recorded" };
      });
    },
  };
}

export type ScanIdeasModule = ReturnType<typeof createScanIdeas>;

const isCount = (n: Json | undefined): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0;

const isCheck = (value: Json | undefined): value is ScanCheckId =>
  typeof value === "string" && (SCAN_CHECKS as readonly string[]).includes(value);
const isText = (value: Json | undefined): value is string => typeof value === "string";

/** A list field of a summary: each entry read, `[]` when absent, null when any entry is bad. */
function readList<T>(
  value: Json | undefined,
  read: (entry: Json) => T | null,
): T[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const entry of value) {
    const one = read(entry);
    if (one === null) return null;
    out.push(one);
  }
  return out;
}

const readFolded = (e: Json): ScanFolded | null => {
  const [nodeId, title, check, dedupeKey] = [
    "nodeId",
    "title",
    "check",
    "dedupeKey",
  ].map((k) => field(e, k));
  return isText(nodeId) && isText(title) && isCheck(check) && isText(dedupeKey)
    ? { nodeId, title, check, dedupeKey }
    : null;
};

const readGone = (e: Json): ScanGone | null => {
  const [nodeId, title, state, action] = ["nodeId", "title", "state", "action"].map(
    (k) => field(e, k),
  );
  return isText(nodeId) &&
    isText(title) &&
    isText(state) &&
    (action === "withdraw" || action === "asked_council")
    ? { nodeId, title, state, action }
    : null;
};

const readListed = (e: Json): ScanFinding | null => {
  const [check, path, line, target] = ["check", "path", "line", "target"].map((k) =>
    field(e, k),
  );
  return isCheck(check) &&
    isText(path) &&
    (line === null || isCount(line)) &&
    (target === null || isText(target))
    ? { check, path, line, target }
    : null;
};

const readNotRun = (e: Json): ScanNotRun | null => {
  const check = field(e, "check");
  const path = field(e, "path");
  return isCheck(check) && (path === null || isText(path)) ? { check, path } : null;
};

/**
 * A recorded summary read back for the daily check and the guard `scanner_finding_gone`, or null
 * when it does not have the shape this module writes. The runner wrote it, but it is read as data
 * all the same. A record made before D-301 has no fold-ins, no clean up and no listing: the first
 * two read as none, and `listed` and `notRun` are left out.
 */
export function readScanSummary(summary: Json): ScanSummary | null {
  const counts = field(summary, "counts");
  const newIdeas = field(summary, "newIdeas");
  const findings = field(summary, "findings");
  const merged = field(summary, "merged");
  const overCap = field(summary, "overCap");
  const cap = field(summary, "cap");
  if (
    !isCount(findings) ||
    !isCount(merged) ||
    !isCount(overCap) ||
    !isCount(cap) ||
    !Array.isArray(newIdeas) ||
    !SCAN_CHECKS.every((c) => isCount(field(counts, c)))
  ) {
    return null;
  }
  const ideas: ScanNewIdea[] = [];
  for (const idea of newIdeas) {
    const nodeId = field(idea, "nodeId");
    const title = field(idea, "title");
    const check = field(idea, "check");
    const cls = field(idea, "class");
    if (
      typeof nodeId !== "string" ||
      typeof title !== "string" ||
      typeof check !== "string" ||
      !(SCAN_CHECKS as readonly string[]).includes(check) ||
      (cls !== "bug" && cls !== "drift")
    ) {
      return null;
    }
    ideas.push({ nodeId, title, check: check as ScanCheckId, class: cls });
  }
  const folded = readList(field(summary, "folded"), readFolded);
  const gone = readList(field(summary, "gone"), readGone);
  const hasListing = field(summary, "listed") !== undefined;
  const listed = readList(field(summary, "listed"), readListed);
  const notRun = readList(field(summary, "notRun"), readNotRun);
  if (folded === null || gone === null || listed === null || notRun === null)
    return null;
  if (hasListing !== (field(summary, "notRun") !== undefined)) return null;
  return {
    counts: Object.fromEntries(
      SCAN_CHECKS.map((c) => [c, field(counts, c) as number]),
    ) as Record<ScanCheckId, number>,
    findings,
    newIdeas: ideas,
    merged,
    folded,
    overCap,
    cap,
    gone,
    ...(hasListing ? { listed, notRun } : {}),
  };
}

/** A recorded failure's step, or null when the summary names none this module writes. */
export function readScanFailure(summary: Json): ScanFailure | null {
  const failure = field(summary, "failure");
  return typeof failure === "string" && Object.hasOwn(SCAN_FAILURE_TEXT, failure)
    ? (failure as ScanFailure)
    : null;
}
