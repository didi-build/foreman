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
export const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";
export const MANAGED_BY = "foreman-runner";

/**
 * The pods of a run. The QA fetch step has its own proxy, so the QA pod's proxy never allows
 * GitHub (ADR 0106 sections 3 and 5).
 */
export type Component = "agent" | "proxy" | "fetch" | "fetch-proxy";

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
  };
}

export type RunNames = ReturnType<typeof runNames>;

/** Labels that find every object of one run. */
export function runSelector(runId: string): Labels {
  return { [LABEL_RUN_ID]: checkRunId(runId) };
}

/** Labels that find one component's pods in one run. Used by the run's NetworkPolicies. */
export function componentSelector(runId: string, component: Component): Labels {
  return { ...runSelector(runId), [LABEL_COMPONENT]: component };
}

export function runLabels(
  run: { runId: string; projectSlug: string; role: AgentRole },
  component?: Component,
): Labels {
  return {
    [LABEL_MANAGED_BY]: MANAGED_BY,
    [LABEL_RUN_ID]: checkRunId(run.runId),
    [LABEL_PROJECT]: checkSlug(run.projectSlug),
    [LABEL_ROLE]: run.role,
    ...(component ? { [LABEL_COMPONENT]: component } : {}),
  };
}
