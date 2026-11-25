// Names and labels for a run's objects (ADR 0106). Every name is derived from the run id, so the
// runner can delete each object by name: its Role has no `list` on Secrets, Services,
// NetworkPolicies or PersistentVolumeClaims, on purpose. Labels tie every object to its run too,
// for queries and for listing the run's Jobs and Pods, which the Role does allow.
import type { AgentRole } from "../runtime.ts";
import type { Labels } from "./objects.ts";

/** Run ids are lowercase UUIDs or similar: short enough for every derived name (63 characters). */
const RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** Project slugs, as in `agents-<slug>` (ADR 0106 section 1). */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,45}[a-z0-9])?$/;

export const LABEL_RUN_ID = "foreman/run-id";
export const LABEL_PROJECT = "foreman/project";
export const LABEL_ROLE = "foreman/role";
export const LABEL_COMPONENT = "foreman/component";
/** Marks the weekly model test's own namespace (D-433), which is no project's. */
export const LABEL_PURPOSE = "foreman/purpose";
export const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";
export const MANAGED_BY = "foreman-runner";

/**
 * The pods of a run. The QA fetch step has its own proxy, so the QA pod's proxy never allows
 * GitHub (ADR 0106 sections 3 and 5). QA's review may have a browser pod with no network but its
 * agent pod (ADR 0119 slice 5b, D-476). The repo map Job and its proxy are the pods of one map read
 * (D-275 (2)), which is not a run.
 */
export type Component =
  | "agent"
  | "proxy"
  | "fetch"
  | "fetch-proxy"
  | "browser"
  | "repo-map"
  | "repo-map-proxy"
  | "eval"
  | "eval-proxy";

/**
 * The role label of a Job's objects: an agent run's role, `repo-map` for the repo map's own Job,
 * which is the runner's work and runs no agent (D-275 (2)), or `eval` for the weekly model test's
 * Job (D-432, D-433).
 */
export type JobRole = AgentRole | "repo-map" | "eval";

export function checkRunId(runId: string): string {
  if (!RUN_ID.test(runId)) {
    throw new Error("run id must be 1 to 40 lowercase letters, digits or -");
  }
  return runId;
}

export function checkSlug(slug: string): string {
  if (!SLUG.test(slug)) {
    throw new Error("project slug must be 1 to 47 lowercase letters, digits or -");
  }
  return slug;
}

/** The project's agent namespace (ADR 0106 section 1). */
export function agentNamespace(slug: string): string {
  return `agents-${checkSlug(slug)}`;
}

/**
 * The weekly model test's own namespace (D-433, O-156). Every project's namespace is
 * `agents-<slug>`, so a name that does not start with `agents-` can never be one, whatever slug a
 * project takes; `foreman-` is the prefix of Foreman's own namespaces (`foreman-runner`,
 * `foreman-platform`).
 */
export const EVAL_NAMESPACE = "foreman-eval";

/** The fixed names of every object a run can own. */
export function runNames(runId: string) {
  const base = `run-${checkRunId(runId)}`;
  return {
    agentJob: `${base}-agent`,
    proxyJob: `${base}-proxy`,
    proxyService: `${base}-proxy`,
    agentPolicy: `${base}-agent`,
    proxyPolicy: `${base}-proxy`,
    fetchJob: `${base}-fetch`,
    fetchProxyJob: `${base}-fetch-proxy`,
    fetchProxyService: `${base}-fetch-proxy`,
    fetchPolicy: `${base}-fetch`,
    fetchProxyPolicy: `${base}-fetch-proxy`,
    workspaceClaim: `${base}-workspace`,
    stateTokenSecret: `${base}-state-api-token`,
    githubTokenSecret: `${base}-github-token`,
    modelSecret: `${base}-model-credentials`,
    taskSecret: `${base}-task`,
    // QA's browser (ADR 0119 slice 5b, D-476).
    browserJob: `${base}-browser`,
    browserService: `${base}-browser`,
    browserPolicy: `${base}-browser`,
    agentBrowserPolicy: `${base}-agent-browser`,
    siteSecret: `${base}-site`,
  };
}

export type RunNames = ReturnType<typeof runNames>;

/**
 * The fixed names of the objects of one repo map read (D-275 (2)), from its own id. `map-`, not
 * `run-`, so they never meet a run's names.
 */
export function repoMapNames(mapId: string) {
  const base = `map-${checkRunId(mapId)}`;
  return {
    job: base,
    policy: base,
    proxyJob: `${base}-proxy`,
    proxyService: `${base}-proxy`,
    proxyPolicy: `${base}-proxy`,
    githubTokenSecret: `${base}-github-token`,
  };
}

/**
 * The fixed names of the objects of one weekly model test Job (D-432, D-433), from its own id.
 * `eval-`, not `run-` or `map-`, so they never meet a run's or a map read's names.
 */
export function evalNames(jobId: string) {
  const base = `eval-${checkRunId(jobId)}`;
  return {
    job: base,
    policy: base,
    proxyJob: `${base}-proxy`,
    proxyService: `${base}-proxy`,
    proxyPolicy: `${base}-proxy`,
    modelSecret: `${base}-model-credentials`,
  };
}

/** Labels that find every object of one run. */
export function runSelector(runId: string): Labels {
  return { [LABEL_RUN_ID]: checkRunId(runId) };
}

/** Labels that find one component's pods in one run. Used by the run's NetworkPolicies. */
export function componentSelector(runId: string, component: Component): Labels {
  return { ...runSelector(runId), [LABEL_COMPONENT]: component };
}

/**
 * Who a Job's objects belong to: a run, or one repo map read (whose id stands in the run id), in
 * the project's agent namespace; or the weekly model test's Job, whose id stands in the run id, in
 * its own namespace with no project (D-433).
 */
export type JobOwner =
  | { runId: string; projectSlug: string; role: AgentRole | "repo-map" }
  | { runId: string; role: "eval" };

/** The namespace a Job owner's objects live in. */
export function ownerNamespace(owner: JobOwner): string {
  return "projectSlug" in owner ? agentNamespace(owner.projectSlug) : EVAL_NAMESPACE;
}

export function runLabels(run: JobOwner, component?: Component): Labels {
  return {
    [LABEL_MANAGED_BY]: MANAGED_BY,
    [LABEL_RUN_ID]: checkRunId(run.runId),
    ...("projectSlug" in run ? { [LABEL_PROJECT]: checkSlug(run.projectSlug) } : {}),
    [LABEL_ROLE]: run.role,
    ...(component ? { [LABEL_COMPONENT]: component } : {}),
  };
}
