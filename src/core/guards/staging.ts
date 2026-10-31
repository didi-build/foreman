// Guards on staging: the check for the merge commit passed, or failed, or a staging deploy covering
// the merge commit failed (ADR 0105, D-225).
import type { GuardCheck, GuardContext } from "../contracts.ts";
import type { Evidence, Json } from "../store.ts";
import {
  latest,
  onCommit,
  readCoverProof,
  readStagingCheck,
  result,
} from "./evidence.ts";

const field = (value: Json, key: string): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value[key]
    : undefined;

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

/**
 * What the staging guards read for the latest merge commit: a recorded failed staging deploy that
 * covers it (D-225), else the latest staging check with its parsed result. A failed deploy or a
 * check counts only when its commit is the merge commit, or contains it (`containment` `ahead`)
 * and is on main (`onMain` with main's head), as the row itself records (D-225, O-38, O-39).
 */
async function stagingCheck(
  ctx: GuardContext,
  name: string,
): Promise<
  | { fail: GuardCheck }
  | { deployFailed: true; ids: string[]; sha: string; deployedSha: string }
  | { deployFailed: false; pass: boolean; ids: string[]; sha: string; on: string }
> {
  const merge = latest(
    await ctx.store.listEvidence({ nodeId: ctx.node.id, kind: "merge_commit" }),
  );
  if (!merge?.commitSha)
    return { fail: result(name, false, [], "no merge commit recorded") };
  const sha = merge.commitSha;
  const failedDeploy = latest(
    (await onCommit(ctx, "staging_deploy_failed", sha)).filter(
      (e) => readCoverProof(e.payload, sha) !== null,
    ),
  );
  if (failedDeploy) {
    const deployed = field(failedDeploy.payload, "deployedSha");
    return {
      deployFailed: true,
      ids: [merge.id, failedDeploy.id],
      sha,
      deployedSha: typeof deployed === "string" ? deployed : sha,
    };
  }
  const check = latest(await onCommit(ctx, "staging_check", sha));
  if (!check) {
    return {
      fail: result(name, false, [merge.id], `no staging check for merge ${sha}`),
    };
  }
  const ids = [merge.id, check.id];
  const payload = readStagingCheck(check.payload);
  if (!payload) {
    return { fail: result(name, false, ids, "malformed staging_check payload") };
  }
  const served = payload.servedCommitSha ?? sha;
  if (readCoverProof(check.payload, sha, "servedCommitSha") === null) {
    return {
      fail: result(
        name,
        false,
        ids,
        `the staging check ran on ${served}, which is not shown to contain merge ${sha} and be on main`,
      ),
    };
  }
  return { deployFailed: false, pass: payload.pass, ids, sha, on: served };
}

const onServed = (found: { sha: string; on: string }): string =>
  found.on === found.sha
    ? ""
    : ` (staging served ${found.on}, which contains it and is on main)`;

/**
 * A staging check passed for the merge commit, on staging serving it or a commit that contains
 * it, and no failed staging deploy covering it is recorded.
 */
export async function stagingCheckOnMergeCommit(
  ctx: GuardContext,
): Promise<GuardCheck> {
  const name = "staging_check_on_merge_commit";
  const found = await stagingCheck(ctx, name);
  if ("fail" in found) return found.fail;
  if (found.deployFailed) {
    return result(
      name,
      false,
      found.ids,
      `the staging deploy of ${found.deployedSha} failed for merge ${found.sha}`,
    );
  }
  return found.pass
    ? result(
        name,
        true,
        found.ids,
        `staging check passed for merge ${found.sha}${onServed(found)}`,
      )
    : result(name, false, found.ids, `staging check failed for merge ${found.sha}`);
}

/**
 * A staging check failed for the merge commit, or a staging deploy of the merge commit or of a
 * commit that contains it failed (D-225).
 */
export async function stagingCheckFailed(ctx: GuardContext): Promise<GuardCheck> {
  const name = "staging_check_failed";
  const found = await stagingCheck(ctx, name);
  if ("fail" in found) return found.fail;
  if (found.deployFailed) {
    return result(
      name,
      true,
      found.ids,
      `the staging deploy of ${found.deployedSha} failed for merge ${found.sha}`,
    );
  }
  return found.pass
    ? result(name, false, found.ids, `staging check passed for merge ${found.sha}`)
    : result(
        name,
        true,
        found.ids,
        `staging check failed for merge ${found.sha}${onServed(found)}`,
      );
}
