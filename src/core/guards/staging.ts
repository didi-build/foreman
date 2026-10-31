// Guards on staging: the check for the merge commit passed, or failed (ADR 0105).
import type { GuardCheck, GuardContext } from "../contracts.ts";
import type { Evidence } from "../store.ts";
import { latest, onCommit, readCheck, result } from "./evidence.ts";

/**
 * Staging checks that may end without a result for one merge commit before the item goes to the
 * Council: the first, and one re-dispatch (the contract's timeout: "Re-dispatch once, then the
 * Council", build plan M3.4, O-36).
 */
export const STAGING_CHECK_ATTEMPTS = 2;

/**
 * The staging checks that ended without a result for the node's latest merge commit since the
 * node entered its state (`staging_no_result`, oldest first), with that merge commit.
 */
export async function stagingNoResults(
  ctx: GuardContext,
): Promise<{ mergeSha: string | null; rows: Evidence[] }> {
  const merge = latest(
    await ctx.store.listEvidence({ nodeId: ctx.node.id, kind: "merge_commit" }),
  );
  if (!merge?.commitSha) return { mergeSha: null, rows: [] };
  const rows = (await onCommit(ctx, "staging_no_result", merge.commitSha)).filter(
    (e) => e.recordedAt.getTime() >= ctx.node.stateSince.getTime(),
  );
  return { mergeSha: merge.commitSha, rows };
}

/** The latest staging check for the latest merge commit, with its parsed result. */
async function stagingCheck(ctx: GuardContext, name: string) {
  const merge = latest(
    await ctx.store.listEvidence({ nodeId: ctx.node.id, kind: "merge_commit" }),
  );
  if (!merge?.commitSha)
    return { fail: result(name, false, [], "no merge commit recorded") };
  const check = latest(await onCommit(ctx, "staging_check", merge.commitSha));
  if (!check) {
    return {
      fail: result(
        name,
        false,
        [merge.id],
        `no staging check for merge ${merge.commitSha}`,
      ),
    };
  }
  const payload = readCheck(check.payload);
  if (!payload) {
    return {
      fail: result(
        name,
        false,
        [merge.id, check.id],
        "malformed staging_check payload",
      ),
    };
  }
  return { pass: payload.pass, ids: [merge.id, check.id], sha: merge.commitSha };
}

/** A staging check passed for the merge commit. */
export async function stagingCheckOnMergeCommit(
  ctx: GuardContext,
): Promise<GuardCheck> {
  const name = "staging_check_on_merge_commit";
  const found = await stagingCheck(ctx, name);
  if ("fail" in found) return found.fail as GuardCheck;
  return found.pass
    ? result(name, true, found.ids, `staging check passed for merge ${found.sha}`)
    : result(name, false, found.ids, `staging check failed for merge ${found.sha}`);
}

/** A staging check failed for the merge commit. */
export async function stagingCheckFailed(ctx: GuardContext): Promise<GuardCheck> {
  const name = "staging_check_failed";
  const found = await stagingCheck(ctx, name);
  if ("fail" in found) return found.fail as GuardCheck;
  return found.pass
    ? result(name, false, found.ids, `staging check passed for merge ${found.sha}`)
    : result(name, true, found.ids, `staging check failed for merge ${found.sha}`);
}
