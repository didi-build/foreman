// Guards around review and the merge: CI, docs, the QA verdict (ADR 0112), privileged paths,
// production protection (ADR 0105), and the merge guard's no-conflict and round cap checks
// (build plan M3.3, D-218).
import type { GuardCheck, GuardContext } from "../contracts.ts";
import type { EvidenceKind } from "../store.ts";
import {
  NO_HEAD,
  headCommit,
  latest,
  onCommit,
  readCheck,
  readCiRun,
  readDocsNote,
  readMergeCheck,
  readQaVerdict,
  result,
} from "./evidence.ts";

/** A linked PR exists and CI passed on its current head commit. */
export async function ciGreenOnHead(ctx: GuardContext): Promise<GuardCheck> {
  const head = await headCommit(ctx);
  if (!head) return result("ci_green_on_head", false, [], NO_HEAD);
  const ci = readCiRun(head.ciRun.payload);
  if (!ci)
    return result(
      "ci_green_on_head",
      false,
      [head.ciRun.id],
      "malformed ci_run payload",
    );
  if (ci.conclusion !== "success") {
    return result(
      "ci_green_on_head",
      false,
      [head.ciRun.id],
      `CI is ${ci.conclusion} on head ${head.sha}`,
    );
  }
  return result(
    "ci_green_on_head",
    true,
    [head.ciRun.id],
    `CI green on head ${head.sha}`,
  );
}

/**
 * A docs note for the head commit says what changed or that there is no docs impact. Agents write
 * docs notes through the state API without a commit, so a note counts for the head when it names
 * the head commit, or names no commit and was recorded at or after the head's `ci_run`.
 */
export async function docsUpdatedOrNone(ctx: GuardContext): Promise<GuardCheck> {
  const head = await headCommit(ctx);
  if (!head) return result("docs_updated_or_none", false, [], NO_HEAD);
  const notes = (
    await ctx.store.listEvidence({ nodeId: ctx.node.id, kind: "docs_note" })
  ).filter(
    (e) =>
      e.commitSha === head.sha ||
      (e.commitSha === null &&
        e.recordedAt.getTime() >= head.ciRun.recordedAt.getTime()),
  );
  const note = latest(notes);
  if (!note) {
    return result(
      "docs_updated_or_none",
      false,
      [],
      `no docs note for head ${head.sha}`,
    );
  }
  const payload = readDocsNote(note.payload);
  if (!payload)
    return result(
      "docs_updated_or_none",
      false,
      [note.id],
      "malformed docs_note payload",
    );
  return result(
    "docs_updated_or_none",
    true,
    [note.id],
    payload.impact === "none" ? "no docs impact stated" : "docs updated",
  );
}

/** Evidence the runner writes from sources it reads itself; only these can back a QA verdict. */
const RUNNER_KINDS: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>([
  "ci_run",
  "test_report",
  "preview_check",
  "staging_check",
  "visual_comparison",
  "merge_commit",
  "spec_paths",
  "dispatch_record",
]);

/** Roles whose runs build the work, so QA must run on a different model (ADR 0112). */
const BUILDER_BOTS = new Set(["developer", "designer"]);

/**
 * ADR 0112: CI green and a preview check on the head commit (and, on the design track, a passing
 * visual comparison against the spec), a pass verdict on the head commit whose cited evidence is
 * runner evidence for this node and commit, and QA's model differs from every builder model for
 * the item (the independence rule while QA runs on Claude, D-158). Checking that cited files and
 * line ranges exist at the head commit is the runner's job when it records the verdict (M3.2).
 */
export async function qaVerdictIndependentOnHead(
  ctx: GuardContext,
): Promise<GuardCheck> {
  const name = "qa_verdict_independent_on_head";
  const head = await headCommit(ctx);
  if (!head) return result(name, false, [], NO_HEAD);
  const ids = [head.ciRun.id];
  const ci = readCiRun(head.ciRun.payload);
  if (ci?.conclusion !== "success") {
    return result(name, false, ids, `CI is not green on head ${head.sha}`);
  }

  const checks: [EvidenceKind, string][] = [["preview_check", "preview check"]];
  if (ctx.node.track === "design")
    checks.push(["visual_comparison", "visual comparison"]);
  for (const [kind, label] of checks) {
    const check = latest(await onCommit(ctx, kind, head.sha));
    if (!check) return result(name, false, ids, `no ${label} on head ${head.sha}`);
    ids.push(check.id);
    const payload = readCheck(check.payload);
    if (!payload) return result(name, false, ids, `malformed ${kind} payload`);
    if (!payload.pass)
      return result(name, false, ids, `${label} failed on head ${head.sha}`);
  }

  const verdictEvidence = latest(await onCommit(ctx, "qa_verdict", head.sha));
  if (!verdictEvidence)
    return result(name, false, ids, `no QA verdict on head ${head.sha}`);
  ids.push(verdictEvidence.id);
  const verdict = readQaVerdict(verdictEvidence.payload);
  if (!verdict) return result(name, false, ids, "malformed qa_verdict payload");
  if (verdict.verdict !== "pass")
    return result(name, false, ids, "the QA verdict is a fail");
  if (verdict.evidenceIds.length === 0) {
    return result(name, false, ids, "the pass cites no runner evidence");
  }
  const onHead = new Map(
    (await ctx.store.listEvidence({ nodeId: ctx.node.id, commitSha: head.sha })).map(
      (e) => [e.id, e],
    ),
  );
  const bad = verdict.evidenceIds.filter((id) => {
    const cited = onHead.get(id);
    return !cited || !RUNNER_KINDS.has(cited.kind);
  });
  if (bad.length > 0) {
    return result(
      name,
      false,
      ids,
      `cited evidence is not runner evidence for this node and head: ${bad.join(", ")}`,
    );
  }

  if (!verdictEvidence.runId)
    return result(name, false, ids, "the verdict names no QA run");
  const qaRun = await ctx.store.getRun(verdictEvidence.runId);
  if (!qaRun) return result(name, false, ids, "the verdict's QA run is not recorded");
  const builders = (await ctx.store.listRuns({ nodeId: ctx.node.id })).filter((r) =>
    BUILDER_BOTS.has(r.bot),
  );
  if (builders.length === 0)
    return result(name, false, ids, "no builder run recorded for the item");
  if (builders.some((r) => r.model === qaRun.model)) {
    return result(name, false, ids, `QA ran on the builder's model ${qaRun.model}`);
  }
  return result(name, true, ids, `independent QA pass on head ${head.sha}`);
}

/** Launchpad's privileged paths: migrations, PII and privacy, deploy workflows, `.github`, secrets. */
export const DEFAULT_PRIVILEGED_PATHS = [
  "**/migrations/**",
  ".github/**",
  "docs/privacy/**",
  "**/*secret*",
  "**/*secret*/**",
  "**/.env*",
];

/** `**` matches across folders, `*` within one path segment. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string;
    if (char === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * The privileged paths the head commit's PR touches: its `changedPaths` against the default list
 * and the project's extra paths. Null when there is no head or its changed paths are not
 * recorded. The merge (src/core/merge.ts) reads it to name the paths in its gate request.
 */
export async function privilegedPathsTouched(
  ctx: GuardContext,
): Promise<{ headSha: string; ciRunId: string; paths: string[] | null } | null> {
  const head = await headCommit(ctx);
  if (!head) return null;
  const ci = readCiRun(head.ciRun.payload);
  const at = { headSha: head.sha, ciRunId: head.ciRun.id };
  if (!ci?.changedPaths) return { ...at, paths: null };
  const project = await ctx.store.getProject(ctx.node.projectId);
  const extra = Array.isArray(project?.privilegedPathsExtra)
    ? project.privilegedPathsExtra.filter((p): p is string => typeof p === "string")
    : [];
  const patterns = [...DEFAULT_PRIVILEGED_PATHS, ...extra].map(globToRegExp);
  return {
    ...at,
    paths: ci.changedPaths.filter((path) => patterns.some((re) => re.test(path))),
  };
}

/** The PR touches no privileged path, or Didi approved this head commit. */
export async function privilegedPathsApproved(ctx: GuardContext): Promise<GuardCheck> {
  const name = "privileged_paths_approved";
  const found = await privilegedPathsTouched(ctx);
  if (!found) return result(name, false, [], NO_HEAD);
  const ids = [found.ciRunId];
  const sha = found.headSha;
  if (!found.paths) {
    return result(name, false, ids, "the PR's changed paths are not recorded");
  }
  const touched = found.paths;
  if (touched.length === 0) {
    return result(name, true, ids, "no privileged path touched");
  }
  const approved = (await ctx.store.listDecisionsForNode(ctx.node.id)).some((d) => {
    const scope = d.scope;
    return (
      d.status === "active" &&
      d.kind === "approval" &&
      d.byActor === "didi" &&
      typeof scope === "object" &&
      scope !== null &&
      !Array.isArray(scope) &&
      scope.kind === "privileged_path" &&
      scope.commitSha === sha
    );
  });
  if (!approved) {
    return result(
      name,
      false,
      ids,
      `privileged paths need Didi's approval for head ${sha}: ${touched.join(", ")}`,
    );
  }
  return result(name, true, ids, `Didi approved privileged paths on head ${sha}`);
}

/**
 * The repo does not deploy on push to main, or its production environment requires Didi. The
 * project check records either case as `prodRequiresApproval`; anything else fails.
 */
export async function prodEnvProtected(ctx: GuardContext): Promise<GuardCheck> {
  const project = await ctx.store.getProject(ctx.node.projectId);
  if (project?.prodRequiresApproval !== true) {
    return result(
      "prod_env_protected",
      false,
      [],
      "production is not confirmed to require Didi's approval",
    );
  }
  return result("prod_env_protected", true, [], "production requires Didi's approval");
}

/** A fail verdict on the head commit lists findings. */
export async function qaFailedWithFindings(ctx: GuardContext): Promise<GuardCheck> {
  const name = "qa_failed_with_findings";
  const head = await headCommit(ctx);
  if (!head) return result(name, false, [], NO_HEAD);
  const evidence = latest(await onCommit(ctx, "qa_verdict", head.sha));
  if (!evidence) return result(name, false, [], `no QA verdict on head ${head.sha}`);
  const verdict = readQaVerdict(evidence.payload);
  if (!verdict)
    return result(name, false, [evidence.id], "malformed qa_verdict payload");
  if (verdict.verdict !== "fail")
    return result(name, false, [evidence.id], "the QA verdict is a pass");
  if (verdict.findings.length === 0) {
    return result(name, false, [evidence.id], "the fail verdict lists no findings");
  }
  return result(
    name,
    true,
    [evidence.id],
    `${verdict.findings.length} finding(s) on head ${head.sha}`,
  );
}

/**
 * QA has not failed the current head (M3.5, closes O-41's gap): no `qa_verdict` on the head says
 * `fail`. A head QA already failed goes back to QA only as a new commit, so a done report on the
 * unchanged head is refused (and counted, P-03) instead of paying for QA on code it failed. A
 * malformed verdict on the head fails the guard, since it cannot be read as anything but a fail.
 */
export async function noFailedQaVerdictOnHead(ctx: GuardContext): Promise<GuardCheck> {
  const name = "no_failed_qa_verdict_on_head";
  const head = await headCommit(ctx);
  if (!head) return result(name, false, [], NO_HEAD);
  const verdicts = await onCommit(ctx, "qa_verdict", head.sha);
  const malformed = verdicts.filter((e) => !readQaVerdict(e.payload));
  if (malformed.length > 0) {
    return result(
      name,
      false,
      malformed.map((e) => e.id),
      "malformed qa_verdict payload",
    );
  }
  const failed = verdicts.filter((e) => readQaVerdict(e.payload)?.verdict === "fail");
  if (failed.length > 0) {
    return result(
      name,
      false,
      failed.map((e) => e.id),
      `QA failed head ${head.sha}: it goes back to QA only as a new commit`,
    );
  }
  return result(name, true, [], `QA has not failed head ${head.sha}`);
}

/**
 * This is not the third failed round. The guard runs before this round's failure is counted, so
 * this round is number `qa_round + 1`, and it passes while that is below `qa_round_cap`.
 */
export async function notThirdFailedRound(ctx: GuardContext): Promise<GuardCheck> {
  const cap = (await ctx.store.getSetting("qa_round_cap"))?.value;
  if (typeof cap !== "number") {
    return result(
      "not_third_failed_round",
      false,
      [],
      "qa_round_cap setting is not a number",
    );
  }
  const round = (await ctx.store.getCounter(ctx.node.id, "qa_round")) + 1;
  if (round >= cap) {
    return result(
      "not_third_failed_round",
      false,
      [],
      `failed round ${round} reaches the cap of ${cap}`,
    );
  }
  return result("not_third_failed_round", true, [], `failed round ${round} of ${cap}`);
}

/**
 * GitHub reports no merge conflict for the PR's current head: the newest `merge_check` on the head
 * commit says `mergeable: true`. It fails closed: no check on the head, a check for another commit
 * (stale), `false` (a conflict) and `null` (GitHub has not worked it out yet) all fail. The runner
 * records the check itself right before it merges (src/core/merge.ts, D-218).
 */
export async function noMergeConflictOnHead(ctx: GuardContext): Promise<GuardCheck> {
  const name = "no_merge_conflict_on_head";
  const head = await headCommit(ctx);
  if (!head) return result(name, false, [], NO_HEAD);
  const check = latest(await onCommit(ctx, "merge_check", head.sha));
  if (!check) return result(name, false, [], `no merge check on head ${head.sha}`);
  const payload = readMergeCheck(check.payload);
  if (!payload) return result(name, false, [check.id], "malformed merge_check payload");
  if (payload.mergeable === null) {
    return result(
      name,
      false,
      [check.id],
      `GitHub has not worked out whether head ${head.sha} merges cleanly`,
    );
  }
  if (!payload.mergeable) {
    return result(name, false, [check.id], `head ${head.sha} has a merge conflict`);
  }
  return result(name, true, [check.id], `no merge conflict on head ${head.sha}`);
}

/**
 * The item is not past the QA round cap: `qa_round` (failed QA rounds) is below `qa_round_cap`.
 * The merge counts no round, so unlike `not_third_failed_round` nothing is added: an item whose
 * second round failed may still merge on a pass, and one at the cap belongs to the Council
 * (`escalation_trigger_met`), whose resolution resets the counter (P-03).
 */
export async function qaRoundsBelowCap(ctx: GuardContext): Promise<GuardCheck> {
  const name = "qa_rounds_below_cap";
  const cap = (await ctx.store.getSetting("qa_round_cap"))?.value;
  if (typeof cap !== "number") {
    return result(name, false, [], "qa_round_cap setting is not a number");
  }
  const rounds = await ctx.store.getCounter(ctx.node.id, "qa_round");
  if (rounds >= cap) {
    return result(
      name,
      false,
      [],
      `${rounds} failed QA rounds reach the cap of ${cap}`,
    );
  }
  return result(name, true, [], `${rounds} failed QA rounds, below the cap of ${cap}`);
}
