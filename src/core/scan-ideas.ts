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
// - Dedupe: a finding whose key is on an open scanner idea of the project, or on an idea whose
//   work items (`split_into`) are not all finished, is merged: nothing new is recorded for it.
// - Cap: at most `SCAN_IDEA_CAP` (5) new ideas per scan; new findings past it, and findings the
//   Job only counted, are counted as over the cap and not filed. The next scan finds them again.
// - Switches: under the kill switch or in dry run it writes nothing, as ./finding-ideas.ts.
// Plain logic over an injected store, clock, id source and the contracts (D-162).
import { isTerminalState, type Contracts } from "./contracts.ts";
import { insertIdea, switchesHolding } from "./finding-ideas.ts";
import type { Clock, IdSource } from "./library.ts";
import {
  SCAN_CHECKS,
  scanDedupeKey,
  scanIdea,
  type RepoScan,
  type ScanCheckId,
  type ScanClass,
} from "./scan.ts";
import type { Json, Node, Store, StoreOps } from "./store.ts";

/** The mark on an idea the Scanner created (P-14). */
export const SCANNER_SOURCE = "scanner";
/** Stage 1: fixed checks, no model (D-299). */
export const SCANNER_STAGE = "fixed-checks";
/** At most this many new ideas per scan of one project (D-300). */
export const SCAN_IDEA_CAP = 5;
/** Who records a scan. */
export const SCANNER_ACTOR = "runner:scanner";

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

/** What a scan found and filed: the record the daily check reads. */
export interface ScanSummary {
  /** Every finding by check, including any the Job only counted. */
  counts: Record<ScanCheckId, number>;
  findings: number;
  newIdeas: ScanNewIdea[];
  /** Findings already on an open idea or item: nothing new recorded. */
  merged: number;
  /** Findings past the cap, filed by no idea this time. */
  overCap: number;
  cap: number;
}

export interface ScanIdeasOptions {
  store: Store;
  clock: Clock;
  ids: IdSource;
  contracts: Contracts;
}

export type ScanFiling =
  | { step: "filed"; summary: ScanSummary }
  | { step: "refused"; reason: "no_project" | "kill_switch" | "dry_run" };

export type ScanFailureRecord =
  | { step: "recorded" }
  | { step: "refused"; reason: "no_project" | "kill_switch" | "dry_run" };

const field = (value: Json | undefined, key: string): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value[key]
    : undefined;

export function createScanIdeas({ store, clock, ids, contracts }: ScanIdeasOptions) {
  const terminal = (state: string) => isTerminalState(contracts, state);

  /** The dedupe keys of the project's scanner ideas that are open, or whose items are. */
  async function openKeys(tx: StoreOps, projectId: string): Promise<Set<string>> {
    const nodes = await tx.listNodes({ projectId });
    const byId = new Map(nodes.map((n): [string, Node] => [n.id, n]));
    const keys = new Set<string>();
    for (const node of nodes) {
      const key = field(node.body, "dedupeKey");
      if (
        node.type !== "idea" ||
        field(node.body, "source") !== SCANNER_SOURCE ||
        typeof key !== "string" ||
        keys.has(key)
      ) {
        continue;
      }
      if (!terminal(node.state)) {
        keys.add(key);
        continue;
      }
      const items = await tx.listEdges({ fromNode: node.id, type: "split_into" });
      if (
        items.some((edge) => {
          const item = byId.get(edge.toNode);
          return item !== undefined && !terminal(item.state);
        })
      ) {
        keys.add(key);
      }
    }
    return keys;
  }

  return {
    /** Files the scan's new findings as ideas, at most the cap, and records the scan. */
    async file(projectId: string, scan: RepoScan): Promise<ScanFiling> {
      return store.transaction(async (tx): Promise<ScanFiling> => {
        const switches = await switchesHolding(tx);
        if (switches) return { step: "refused", reason: switches };
        if (!(await tx.lockProject(projectId))) {
          return { step: "refused", reason: "no_project" };
        }
        const open = await openKeys(tx, projectId);
        const at = clock.now();
        const newIdeas: ScanNewIdea[] = [];
        let merged = 0;
        for (const finding of scan.findings) {
          if (open.has(scanDedupeKey(finding))) {
            merged += 1;
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
          newIdeas.push({
            nodeId: id,
            title: idea.title,
            check: idea.check,
            class: idea.class,
          });
        }
        const findings = SCAN_CHECKS.reduce((sum, c) => sum + scan.counts[c], 0);
        const summary: ScanSummary = {
          counts: { ...scan.counts },
          findings,
          newIdeas,
          merged,
          overCap: findings - merged - newIdeas.length,
          cap: SCAN_IDEA_CAP,
        };
        await tx.insertScan({
          id: ids.next(),
          projectId,
          commitSha: scan.commitSha,
          outcome: "scanned",
          summary: summary as unknown as Json,
          recordedBy: SCANNER_ACTOR,
          recordedAt: at,
        });
        return { step: "filed", summary };
      });
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

/**
 * A recorded summary read back for the daily check, or null when it does not have the shape this
 * module writes. The runner wrote it, but it is read as data all the same.
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
  return {
    counts: Object.fromEntries(
      SCAN_CHECKS.map((c) => [c, field(counts, c) as number]),
    ) as Record<ScanCheckId, number>,
    findings,
    newIdeas: ideas,
    merged,
    overCap,
    cap,
  };
}

/** A recorded failure's step, or null when the summary names none this module writes. */
export function readScanFailure(summary: Json): ScanFailure | null {
  const failure = field(summary, "failure");
  return typeof failure === "string" && Object.hasOwn(SCAN_FAILURE_TEXT, failure)
    ? (failure as ScanFailure)
    : null;
}
