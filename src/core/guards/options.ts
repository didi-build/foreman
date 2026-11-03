// The design track's merge check for exploration options (D-258, settles N-58). A design item
// keeps one branch and one PR, and in the spec step the Designer deletes the folders of the
// options Didi did not pick (D-253). This guard checks it before the runner merges: the PR at the
// head carries no option folder other than the approved option's. It reads the files the PR
// changes from the head `ci_run`'s `changedPaths`, as `privileged_paths_approved` does, and the
// approved option's folder from Didi's approval on the visual-approval request and the runner's
// screenshot of that option (`approvedOptionRecord`, src/core/visual-comparison.ts).
import type { GuardCheck, GuardContext } from "../contracts.ts";
import type { Evidence } from "../store.ts";
import { approvedOptionRecord } from "../visual-comparison.ts";
import { NO_HEAD, headCommit, readCiRun, result } from "./evidence.ts";

const NAME = "unpicked_options_removed";

/** At most this many folders are named in the detail; the rest are counted. */
export const MAX_NAMED_FOLDERS = 20;

/**
 * The option folder a changed path lies in, `design/<area>/<feature>/options/<name>` (D-243), or
 * null when it is in none. Any folder named `options` under `design/` with at least one folder
 * before it counts, whatever the option's name, so a folder with an unexpected name is not missed.
 */
export function optionFolderOf(path: string): string | null {
  const match = /^(design\/(?:[^/]+\/)+?options\/[^/]+)(?:\/|$)/.exec(path);
  return match ? (match[1] as string) : null;
}

/** The option folders in the PR at a head, or why they cannot be read (fails closed). */
export type OptionFolders =
  | { problem: string }
  | {
      /** Every option folder among the changed paths, sorted. */
      folders: string[];
      /** Those that are not the approved option's folder, sorted. */
      unpicked: string[];
      /** Whether an approved option's folder is recorded; read only when a folder is present. */
      approved: boolean;
    };

/**
 * The option folders among a `ci_run`'s `changedPaths`, and which of them are not the approved
 * option's folder. A problem when the payload is malformed or the changed paths are not recorded.
 * The approval is read only when an option folder is present. Reads only.
 */
export async function optionFoldersAt(
  store: GuardContext["store"],
  nodeId: string,
  ciRun: Evidence,
): Promise<OptionFolders> {
  const ci = readCiRun(ciRun.payload);
  if (!ci) return { problem: "malformed ci_run payload" };
  if (!ci.changedPaths) {
    return {
      problem:
        "the PR's changed paths are not recorded, so its option folders cannot be checked",
    };
  }
  const folders = [
    ...new Set(
      ci.changedPaths.map(optionFolderOf).filter((f): f is string => f !== null),
    ),
  ].sort();
  if (folders.length === 0) return { folders, unpicked: [], approved: false };
  const approved = await approvedOptionRecord(store, nodeId);
  return {
    folders,
    unpicked: folders.filter((f) => f !== approved?.path),
    approved: approved !== null,
  };
}

/**
 * The PR at the head no longer carries the folder of any exploration option Didi did not approve:
 * every option folder among the head `ci_run`'s `changedPaths` is the approved option's folder.
 * It fails closed when the changed paths are not recorded, and when an option folder is present
 * but no approved option's folder is recorded. The detail names the folders, never an id.
 */
export async function unpickedOptionsRemoved(ctx: GuardContext): Promise<GuardCheck> {
  const head = await headCommit(ctx);
  if (!head) return result(NAME, false, [], NO_HEAD);
  const ids = [head.ciRun.id];
  const found = await optionFoldersAt(ctx.store, ctx.node.id, head.ciRun);
  if ("problem" in found) return result(NAME, false, ids, found.problem);
  if (found.folders.length === 0) {
    return result(NAME, true, ids, `no option folder in the PR on head ${head.sha}`);
  }
  const { unpicked } = found;
  if (unpicked.length === 0) {
    return result(
      NAME,
      true,
      ids,
      `only the approved option's folder is in the PR on head ${head.sha}`,
    );
  }
  const named = unpicked.slice(0, MAX_NAMED_FOLDERS).join(", ");
  const more =
    unpicked.length > MAX_NAMED_FOLDERS
      ? ` and ${unpicked.length - MAX_NAMED_FOLDERS} more`
      : "";
  const why = found.approved
    ? "option folders Didi did not approve are still in the PR"
    : "no approved option's folder is recorded, and option folders are in the PR";
  return result(NAME, false, ids, `${why} on head ${head.sha}: ${named}${more}`);
}
