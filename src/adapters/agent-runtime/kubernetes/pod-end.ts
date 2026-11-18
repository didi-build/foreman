// A run's pod, and how it ended (D-415). When an agent run's Job leaves no readable result, the
// run-end flow's result shows next to `bad_output` the pod's end reason, one word from the fixed
// list below (any other word reads as `other`), and the main container's exit code as a whole
// number. Kubernetes' free-text messages are never read: the pod's type (./objects.ts) does not
// declare them. As D-385 chose, nothing is stored and nothing is logged. A missing pod, or a
// status this cannot read, gives no detail and never an error.
import type { ContainerStatus, PodStatus } from "./objects.ts";

/**
 * The end reasons kept, each a word Kubernetes itself writes: for a container that terminated
 * (`state.terminated.reason`), and for a pod the kubelet ended or refused (`status.reason`).
 */
export const POD_END_REASONS = [
  "OOMKilled",
  "Error",
  "Completed",
  "ContainerCannotRun",
  "StartError",
  "ContainerStatusUnknown",
  "DeadlineExceeded",
  "Evicted",
  "Terminated",
  "UnexpectedAdmissionError",
  "OutOfcpu",
  "OutOfmemory",
] as const;

export type PodEndReason = (typeof POD_END_REASONS)[number] | "other";

/** How the run's pod ended, as far as it can be read. Each field may be missing. */
export interface PodEnd {
  /** The pod's own reason when it has one of the list, else its main container's; or `other`. */
  podReason?: PodEndReason;
  /** The main container's exit code. */
  exitCode?: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const KNOWN: ReadonlySet<string> = new Set(POD_END_REASONS);

/** Kubernetes keeps an exit code as a 32-bit integer. */
const isExitCode = (value: unknown): value is number =>
  Number.isInteger(value) &&
  (value as number) >= -(2 ** 31) &&
  (value as number) < 2 ** 31;

/** The named container's `state.terminated`, when it is there and readable. */
function terminated(
  pod: PodStatus,
  container: string,
): Record<string, unknown> | undefined {
  const statuses: unknown = isObject(pod.status)
    ? pod.status.containerStatuses
    : undefined;
  if (!Array.isArray(statuses)) return undefined;
  const main = statuses.find(
    (entry: unknown): entry is ContainerStatus =>
      isObject(entry) && entry.name === container,
  );
  const state: unknown = main?.state;
  return isObject(state) && isObject(state.terminated) ? state.terminated : undefined;
}

const named = (pod: unknown): pod is PodStatus =>
  isObject(pod) && isObject(pod.metadata) && typeof pod.metadata.name === "string";

const created = (pod: PodStatus): number => {
  const time = Date.parse(pod.metadata.creationTimestamp ?? "");
  return Number.isNaN(time) ? -Infinity : time;
};

/** Ended: the pod's phase says so, or its main container has terminated. */
const ended = (pod: PodStatus, container: string): boolean => {
  const phase: unknown = isObject(pod.status) ? pod.status.phase : undefined;
  return (
    phase === "Succeeded" ||
    phase === "Failed" ||
    terminated(pod, container) !== undefined
  );
};

/**
 * The run's pod among a Job's pods: the newest one that has ended, else the newest. Ties, and pods
 * with no readable creation time, go by name, the first one first. A pod with no name is skipped.
 * Null when there is none.
 */
export function runPod(pods: readonly unknown[], container: string): PodStatus | null {
  const readable = pods.filter(named);
  const order = (a: PodStatus, b: PodStatus) =>
    created(b) - created(a) ||
    (a.metadata.name < b.metadata.name
      ? -1
      : a.metadata.name > b.metadata.name
        ? 1
        : 0);
  const done = readable.filter((pod) => ended(pod, container)).sort(order);
  return done[0] ?? readable.sort(order)[0] ?? null;
}

/**
 * How the pod ended: its end reason and its main container's exit code, each only when it can
 * be read; null when neither can. Never throws.
 */
export function podEnd(pod: PodStatus | null, container: string): PodEnd | null {
  if (pod === null) return null;
  const end = terminated(pod, container);
  const said = [
    isObject(pod.status) ? pod.status.reason : undefined,
    end?.reason,
  ].filter((reason): reason is string => typeof reason === "string" && reason !== "");
  const known = said.find((reason) => KNOWN.has(reason)) as PodEndReason | undefined;
  const podReason: PodEndReason | undefined =
    known ?? (said.length > 0 ? "other" : undefined);
  const code = end?.exitCode;
  const exitCode = isExitCode(code) ? code : undefined;
  if (podReason === undefined && exitCode === undefined) return null;
  return {
    ...(podReason === undefined ? {} : { podReason }),
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}
