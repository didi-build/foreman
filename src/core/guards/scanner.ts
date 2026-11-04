// The guard on the runner's withdrawal of a scanner idea (D-301 (3), O-93): the runner-only move
// Submitted to Rejected (contracts/machine-1/idea.yaml), which only the scan's filing step asks
// for (src/core/scan-ideas.ts). It passes only when the idea is one the Scanner filed, it is in
// Submitted, and the latest scan of its project that ran, recorded after the idea was filed,
// certainly found none of the idea's keys: its own and each one folded into it, where every check
// those keys name ran over the key's file and listed all its findings (`scanFoundNone`,
// src/core/scan.ts). It reads the scan's own record, never the filing step's conclusion, and
// fails on a record it cannot read or one made before the scan listed what it found.
import type { GuardCheck, GuardContext } from "../contracts.ts";
import { IDEA_ENTRY } from "../ideas.ts";
import { scanFoundNone } from "../scan.ts";
import { isScannerIdea, readScanSummary, scannerIdeaKeys } from "../scan-ideas.ts";
import { result } from "./evidence.ts";

export const SCANNER_GONE_GUARD = "scanner_finding_gone";

/** The idea's findings are no longer found by the latest scan that ran (D-301 (3)). */
export async function scannerFindingGone(ctx: GuardContext): Promise<GuardCheck> {
  const fail = (detail: string) => result(SCANNER_GONE_GUARD, false, [], detail);
  const { node } = ctx;
  if (!isScannerIdea(node)) return fail("not an idea the Scanner filed");
  if (node.state !== IDEA_ENTRY.state) return fail("the idea is not in Submitted");
  const scan = await ctx.store.getLatestScan(node.projectId, "scanned");
  if (!scan || scan.commitSha === null) return fail("no scan of the project has run");
  if (scan.recordedAt.getTime() <= node.createdAt.getTime()) {
    return fail("no scan has run since the idea was filed");
  }
  const summary = readScanSummary(scan.summary);
  if (!summary?.listed || !summary.notRun) {
    return fail("the latest scan's record does not list what it found");
  }
  const updates = await ctx.store.listEvidence({
    nodeId: node.id,
    kind: "scan_scope_update",
  });
  const keys = scannerIdeaKeys(node, updates);
  if (keys.length === 0) return fail("the idea's findings cannot be read");
  if (
    !scanFoundNone(
      { counts: summary.counts, findings: summary.listed, notRun: summary.notRun },
      keys,
    )
  ) {
    return fail(
      "the latest scan found one of the idea's findings, or a check it needs did not run in full",
    );
  }
  const recorded = await ctx.store.listEvidence({
    nodeId: node.id,
    kind: "scan_not_found",
    commitSha: scan.commitSha,
  });
  return result(
    SCANNER_GONE_GUARD,
    true,
    recorded.map((e) => e.id),
    `no longer found by the scanner at commit ${scan.commitSha}`,
  );
}
