// Shared rules for the guards (ADR 0105, M2.2): which commit is the PR's head, the payload each
// evidence kind carries, and small readers that never throw on a malformed payload.
//
// The head commit. A guard that reads "on the current head commit" takes the head from the most
// recent `ci_run` evidence on the node (latest `recordedAt`, then id). GitHub ingestion (M2.3)
// records a `ci_run` for every new head commit as soon as its checks start (conclusion
// "pending"), so the latest `ci_run` names the head. Evidence for any other commit is stale and
// ignored (docs/schema.md). No `ci_run` means no linked PR yet, and every head-commit guard fails.
//
// The mergeable state. `no_merge_conflict_on_head` reads the newest `merge_check` on the head
// commit: GitHub's `mergeable` for that head, which the runner reads and records itself right
// before it merges (src/core/merge.ts). A check for any other commit is stale and ignored.
//
// The merge commit. Staging guards read the most recent `merge_commit` evidence; its `commitSha`
// is the merge commit on main, and staging checks must name that commit.
//
// Payloads are written by the runner from sources it reads itself, except `agent_report`,
// `docs_note` and `qa_verdict`, which agents write through the state API (ADR 0102). Every reader
// below returns null for a malformed payload, and the guard then fails with a detail.
import type { GuardCheck, GuardContext } from "../contracts.ts";
import type { Evidence, EvidenceKind, Json } from "../store.ts";

export interface CiRunPayload {
  conclusion: "success" | "failure" | "pending";
  /** The pull request number the commit belongs to. */
  pr: number;
  /** Files the PR changes, relative to the repo root. Read by `privileged_paths_approved`. */
  changedPaths?: string[];
}

export interface CheckPayload {
  /** `preview_check`, `staging_check` and `visual_comparison`: did the check pass. */
  pass: boolean;
}

/**
 * A staging check (M3.4, D-225). `servedCommitSha` is the commit staging served, and
 * `containment` how it relates to the merge commit by GitHub's compare (`identical` or `ahead`,
 * so the served commit contains the merge commit). A check recorded before D-225 has neither and
 * was recorded only when staging served the merge commit itself.
 */
export interface StagingCheckPayload extends CheckPayload {
  servedCommitSha?: string;
  containment?: "identical" | "ahead";
  /** With `containment` `ahead`: the served commit is on main, whose head was `mainHeadSha`. */
  onMain?: true;
  mainHeadSha?: string;
}

export interface MergeCheckPayload {
  pr: number;
  /** GitHub's answer for the head: true, false (a conflict), or null (not worked out yet). */
  mergeable: boolean | null;
}

export interface MergeCommitPayload {
  pr: number;
}

export interface DocsNotePayload {
  impact: "updated" | "none";
  note?: string;
}

export interface QaFinding {
  path: string;
  startLine: number;
  endLine: number;
  note: string;
}

/** As the state API stores it (src/api/routes.ts, ADR 0112). */
export interface QaVerdictPayload {
  verdict: "pass" | "fail";
  findings: QaFinding[];
  evidenceIds: string[];
}

/** One finding of a visual comparison: what differs, and the spec line it breaks (or empty). */
export interface VisualFindingPayload {
  what: string;
  specLine: string;
}

/**
 * A `visual_comparison` as the runner records it (src/core/visual-comparison.ts, O-66). Only the
 * fields the guards and the Designer's input read are checked here.
 */
export interface VisualComparisonPayload extends CheckPayload {
  outcome: "match" | "differs" | "cannot_tell";
  option: string;
  components: {
    component: string;
    variant: string;
    result: "match" | "differs" | "cannot_tell";
    findings: VisualFindingPayload[];
  }[];
}

export interface SpecPathsPayload {
  /** Files under the spec directory, for example `design/<area>/<feature>/spec.md`. */
  paths: string[];
  /** Components the spec lists, which the gallery must build. */
  components: string[];
  /** Every commit that touched the spec paths, with its author identity. */
  commits: { sha: string; author: string }[];
  /** What the spec adds beyond the plan, as the Designer declares it. Empty means none. */
  newFeatures: string[];
  newFlows: string[];
}

export interface TestReportPayload {
  suite: string;
  pass: boolean;
  /** For the gallery suite: the components the gallery build contains. */
  galleryComponents?: string[];
}

export interface AgentReportPayload {
  summary?: string;
  /** A bot asking to escalate must give a written reason. */
  escalate?: boolean;
  reason?: string;
}

const isRecord = (value: Json): value is { [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringList = (value: Json | undefined): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isPositiveInteger = (value: Json | undefined): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

export function readCiRun(payload: Json): CiRunPayload | null {
  if (!isRecord(payload)) return null;
  const { conclusion, pr, changedPaths } = payload;
  if (
    conclusion !== "success" &&
    conclusion !== "failure" &&
    conclusion !== "pending"
  ) {
    return null;
  }
  if (!isPositiveInteger(pr)) return null;
  if (changedPaths !== undefined && !isStringList(changedPaths)) return null;
  return { conclusion, pr, ...(changedPaths ? { changedPaths } : {}) };
}

export function readMergeCheck(payload: Json): MergeCheckPayload | null {
  if (!isRecord(payload) || !isPositiveInteger(payload.pr)) return null;
  const { mergeable } = payload;
  if (mergeable !== true && mergeable !== false && mergeable !== null) return null;
  return { pr: payload.pr, mergeable };
}

export function readCheck(payload: Json): CheckPayload | null {
  if (!isRecord(payload) || typeof payload.pass !== "boolean") return null;
  return { pass: payload.pass };
}

/**
 * Why a deploy or a check's served commit counts for the merge commit `mergeSha` (D-225, O-38):
 * `identical` when the commit is the merge commit, or `ahead` with `onMain: true` and main's head
 * when it contains the merge commit and is on main. A row with neither field is the M3.4 shape,
 * about the merge commit itself. Anything else proves nothing.
 */
export function readCoverProof(
  payload: Json,
  mergeSha: string,
  commitKey = "deployedSha",
):
  | { containment: "identical" }
  | { containment: "ahead"; onMain: true; mainHeadSha: string }
  | null {
  if (!isRecord(payload)) return null;
  const commit = payload[commitKey];
  const { containment, onMain, mainHeadSha } = payload;
  if (containment === undefined) {
    return commit === undefined || commit === mergeSha
      ? { containment: "identical" }
      : null;
  }
  if (typeof commit !== "string") return null;
  if (containment === "identical") {
    return commit === mergeSha ? { containment: "identical" } : null;
  }
  if (
    containment === "ahead" &&
    commit !== mergeSha &&
    onMain === true &&
    typeof mainHeadSha === "string" &&
    mainHeadSha !== ""
  ) {
    return { containment: "ahead", onMain: true, mainHeadSha };
  }
  return null;
}

/**
 * Why a staging deploy the runner made itself was refused (D-356, O-116): `file_set`, the build
 * CI kept is not a site the runner uploads (the change's own output, so D-225 rule 2 applies), or
 * `infrastructure`, Cloudflare, the deploy credential or GitHub's artifact refused or failed.
 */
export const INFRASTRUCTURE_CAUSE = "infrastructure";

/**
 * Whether a recorded `staging_deploy_failed` counts as a failed staging deploy (D-225 rule 2): every
 * one does except a refusal by infrastructure, which says nothing about the change and counts no
 * failure until Didi decides otherwise (N-103). Read by the guards, the staging check and the
 * Council's input alike, so the three cannot drift.
 */
export function countsAsFailedDeploy(payload: Json): boolean {
  return !isRecord(payload) || payload.cause !== INFRASTRUCTURE_CAUSE;
}

/**
 * The fixed reason and text the runner recorded with a refused staging deploy (O-116), or null.
 * Only a short code and a short plain text count, so nothing else recorded there is ever shown.
 */
export function readDeployRefusal(
  payload: Json,
): { reason: string; text: string } | null {
  if (!isRecord(payload)) return null;
  const { reason, text } = payload;
  if (typeof reason !== "string" || !/^[a-z_]{1,40}$/.test(reason)) return null;
  if (typeof text !== "string" || !/^[A-Za-z0-9 ,.;:'()_/-]{1,200}$/.test(text))
    return null;
  return { reason, text };
}

export function readStagingCheck(payload: Json): StagingCheckPayload | null {
  const check = readCheck(payload);
  if (!check || !isRecord(payload)) return null;
  const { servedCommitSha, containment } = payload;
  if (servedCommitSha === undefined && containment === undefined) return check;
  if (typeof servedCommitSha !== "string" || servedCommitSha === "") return null;
  if (containment !== "identical" && containment !== "ahead") return null;
  const { onMain, mainHeadSha } = payload;
  return {
    ...check,
    servedCommitSha,
    containment,
    ...(onMain === true ? { onMain } : {}),
    ...(typeof mainHeadSha === "string" ? { mainHeadSha } : {}),
  };
}

export function readDocsNote(payload: Json): DocsNotePayload | null {
  if (!isRecord(payload)) return null;
  if (payload.impact !== "updated" && payload.impact !== "none") return null;
  return { impact: payload.impact };
}

export function readQaVerdict(payload: Json): QaVerdictPayload | null {
  if (!isRecord(payload)) return null;
  const { verdict, findings, evidenceIds } = payload;
  if (verdict !== "pass" && verdict !== "fail") return null;
  if (!isStringList(evidenceIds) || !Array.isArray(findings)) return null;
  const parsed: QaFinding[] = [];
  for (const raw of findings) {
    if (!isRecord(raw)) return null;
    const { path, startLine, endLine, note } = raw;
    if (typeof path !== "string" || path === "" || typeof note !== "string")
      return null;
    if (!isPositiveInteger(startLine) || !isPositiveInteger(endLine)) return null;
    if (endLine < startLine) return null;
    parsed.push({ path, startLine, endLine, note });
  }
  return { verdict, findings: parsed, evidenceIds };
}

const VISUAL_RESULTS: readonly string[] = ["match", "differs", "cannot_tell"];

export function readVisualComparison(payload: Json): VisualComparisonPayload | null {
  if (!isRecord(payload) || typeof payload.pass !== "boolean") return null;
  const { outcome, option, components } = payload;
  if (typeof outcome !== "string" || !VISUAL_RESULTS.includes(outcome)) return null;
  if (typeof option !== "string" || !Array.isArray(components)) return null;
  const parsed: VisualComparisonPayload["components"] = [];
  for (const raw of components) {
    if (!isRecord(raw)) return null;
    const { component, variant, result: answer, findings } = raw;
    if (typeof component !== "string" || typeof variant !== "string") return null;
    if (typeof answer !== "string" || !VISUAL_RESULTS.includes(answer)) return null;
    if (!Array.isArray(findings)) return null;
    const read: VisualFindingPayload[] = [];
    for (const f of findings) {
      if (!isRecord(f) || typeof f.what !== "string" || typeof f.specLine !== "string")
        return null;
      read.push({ what: f.what, specLine: f.specLine });
    }
    parsed.push({
      component,
      variant,
      result: answer as VisualComparisonPayload["outcome"],
      findings: read,
    });
  }
  return {
    pass: payload.pass,
    outcome: outcome as VisualComparisonPayload["outcome"],
    option,
    components: parsed,
  };
}

/** The number of findings a visual comparison lists over all its components. */
export const visualFindingCount = (payload: VisualComparisonPayload): number =>
  payload.components.reduce((n, c) => n + c.findings.length, 0);

export function readSpecPaths(payload: Json): SpecPathsPayload | null {
  if (!isRecord(payload)) return null;
  const { paths, components, commits, newFeatures, newFlows } = payload;
  if (!isStringList(paths) || paths.length === 0) return null;
  if (
    !isStringList(components) ||
    !isStringList(newFeatures) ||
    !isStringList(newFlows)
  ) {
    return null;
  }
  if (!Array.isArray(commits) || commits.length === 0) return null;
  const parsedCommits: { sha: string; author: string }[] = [];
  for (const raw of commits) {
    if (
      !isRecord(raw) ||
      typeof raw.sha !== "string" ||
      typeof raw.author !== "string"
    ) {
      return null;
    }
    parsedCommits.push({ sha: raw.sha, author: raw.author });
  }
  return { paths, components, commits: parsedCommits, newFeatures, newFlows };
}

export function readTestReport(payload: Json): TestReportPayload | null {
  if (!isRecord(payload)) return null;
  const { suite, pass, galleryComponents } = payload;
  if (typeof suite !== "string" || typeof pass !== "boolean") return null;
  if (galleryComponents !== undefined && !isStringList(galleryComponents)) return null;
  return { suite, pass, ...(galleryComponents ? { galleryComponents } : {}) };
}

export function readAgentReport(payload: Json): AgentReportPayload | null {
  if (!isRecord(payload)) return null;
  const { escalate, reason } = payload;
  if (escalate !== undefined && typeof escalate !== "boolean") return null;
  if (reason !== undefined && typeof reason !== "string") return null;
  return {
    ...(escalate !== undefined ? { escalate } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

/** The last element: evidence lists come back oldest first. */
export const latest = <T>(items: T[]): T | undefined => items[items.length - 1];

/** The PR's current head commit and the `ci_run` that names it, or null when there is no PR yet. */
export async function headCommit(
  ctx: GuardContext,
): Promise<{ sha: string; ciRun: Evidence } | null> {
  const ciRun = latest(
    await ctx.store.listEvidence({ nodeId: ctx.node.id, kind: "ci_run" }),
  );
  if (!ciRun?.commitSha) return null;
  return { sha: ciRun.commitSha, ciRun };
}

/** Evidence of one kind for exactly this commit, oldest first. Other commits are stale. */
export function onCommit(
  ctx: GuardContext,
  kind: EvidenceKind,
  commitSha: string,
): Promise<Evidence[]> {
  return ctx.store.listEvidence({ nodeId: ctx.node.id, kind, commitSha });
}

/** Builds a guard result. `name` is set again by the library from the registry key. */
export const result = (
  name: string,
  pass: boolean,
  evidenceIds: string[],
  detail: string,
): GuardCheck => ({ name, pass, evidenceIds, detail });

export const NO_HEAD = "no linked pull request: no ci_run evidence names a head commit";
