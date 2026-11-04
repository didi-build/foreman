// The repo map port on Kubernetes (src/core/repo-map.ts `RepoMaps`, D-251, D-267, D-275 (2),
// O-87). The runner never downloads or parses a project's code itself: for each map it
//
// 1. mints a runner App installation token with `contents: read` for the one repository (D-267),
//    and with no commit asked for reads the default branch's head (two small answers, no code);
// 2. creates, in the project's agent namespace, the token's Secret, the two NetworkPolicies, the
//    egress proxy that allows only GitHub (`REPO_MAP_HOSTS`) and the repo map Job
//    (`repoMapStage`), with the same Role the agent runs use and no new right;
// 3. waits for the Job, polling with a bound a little past the Job's own deadline;
// 4. deletes the token's Secret as soon as the Job has ended, reads the Job's result line from its
//    pod's log (bounded), and decodes and checks the map as untrusted data (../../repo-map/
//    result.ts): its shape, sizes, paths and commit;
// 5. deletes every object of the read, whatever happened, Jobs first.
//
// Until the runner App is registered (D-178) the token port refuses with `NotBuiltError` before
// anything else (flows/lib/compose.ts), so no cluster object is made and no cluster token is
// read. Nothing here logs, and errors name a step, never a token or a value from the Job.
//
// The Scanner's stage 1 (D-300, O-92) uses the same read with the Job in scan mode
// (`createKubernetesRepoScans`): the same steps, objects, token and bounds, and the result is
// checked as the scan's findings (src/core/scan.ts `checkScanResult`) instead of a map.
import type { RepoMap, RepoMapProject, RepoMaps } from "../../../core/repo-map.ts";
import { checkScanResult, type RepoScan, type RepoScans } from "../../../core/scan.ts";
import {
  GitHubReadError,
  REPOSITORY,
  type GitHubHttp,
  type RunnerAppTokens,
} from "../../github/runner-app-tokens.ts";
import { FULL_SHA, readHeadCommit } from "../../repo-map/github.ts";
import { decodeRepoMapResult, RESULT_LOG_BYTES } from "../../repo-map/result.ts";
import { KubernetesApiError, type KubernetesClient } from "./client.ts";
import {
  checkSettings,
  repoMapSecret,
  repoMapStage,
  type KubernetesRunSettings,
  type RepoMapJobSpec,
  type RepoReadMode,
} from "./manifests.ts";
import {
  LABEL_COMPONENT,
  agentNamespace,
  checkRunId,
  repoMapNames,
  runSelector,
} from "./names.ts";
import type { RunObjectKind } from "./objects.ts";
import { jobState, parseAgentResult } from "./result.ts";

/** The cluster client and the run settings, built on first use (flows/lib/compose.ts). */
export interface RepoMapCluster {
  client: KubernetesClient;
  settings: KubernetesRunSettings;
}

export interface KubernetesRepoMapsOptions {
  tokens: RunnerAppTokens;
  /** GitHub's API, for the default branch's head only. */
  http: GitHubHttp;
  /** Called only after the token was minted, so a refused token never reads the cluster token. */
  cluster: () => Promise<RepoMapCluster>;
  /** A fresh id per read, for its object names. */
  ids: { next(): string };
  /** Waits between two polls. Tests pass one that moves the fake Job on. */
  wait?: (ms: number) => Promise<void>;
  /** Milliseconds now, for the wait's bound. */
  now?: () => number;
}

/** A map read whose Job did not give a usable map. The message names the step only. */
export class RepoMapJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoMapJobError";
  }
}

/** Between two reads of the Job's state. */
export const REPO_MAP_POLL_MS = 5_000;
/** The result is the last line; a few lines before it are allowed for. */
const LOG_TAIL_LINES = 10;
/** At most this much of the image's own error text goes into the runner's error. */
const ERROR_TEXT_CHARS = 200;

type Owned = [RunObjectKind, string];

/** The image's error text as plain words only, cut short: it came from the Job. */
const plainError = (text: string): string =>
  text
    .replace(/[^A-Za-z0-9 .,:;()_/-]+/g, " ")
    .trim()
    .slice(0, ERROR_TEXT_CHARS);

/** What the Job is called in errors, by mode. */
const JOB_LABEL: Record<RepoReadMode, string> = {
  map: "the repo map Job",
  scan: "the scan Job",
};

/** The Job's checked `structured` result, decoded for its mode. */
type Decode<T> = (structured: unknown, commitSha: string) => T;

/** One read of a repository in the repo map Job, in one mode, decoded by `decode`. */
function createRepoReadJobs<T>(
  options: KubernetesRepoMapsOptions,
  mode: RepoReadMode,
  decode: Decode<T>,
) {
  const { tokens, http, ids } = options;
  const label = JOB_LABEL[mode];
  const wait =
    options.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = options.now ?? (() => Date.now());

  async function remove(
    client: KubernetesClient,
    namespace: string,
    owned: readonly Owned[],
  ): Promise<void> {
    let failure: unknown;
    for (const [kind, name] of owned) {
      try {
        await client.delete(kind, namespace, name, { propagationPolicy: "Background" });
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  async function runJob(
    { client, settings }: RepoMapCluster,
    spec: RepoMapJobSpec,
    token: string,
  ): Promise<T> {
    const namespace = agentNamespace(spec.projectSlug);
    const n = repoMapNames(spec.mapId);
    // Checked and built before anything is created, so a bad input creates nothing.
    checkSettings(settings);
    const secret = repoMapSecret(spec, token);
    const stage = repoMapStage(spec, settings);
    const everything: Owned[] = [
      ["Job", n.job],
      ["Job", n.proxyJob],
      ["Service", n.proxyService],
      ["NetworkPolicy", n.policy],
      ["NetworkPolicy", n.proxyPolicy],
      ["Secret", n.githubTokenSecret],
    ];
    let read: T;
    try {
      await client.create(secret);
      for (const policy of stage.policies) await client.create(policy);
      await client.create(stage.proxyJob);
      const service = await client.create(stage.proxyService);
      if (!service.clusterIP) {
        throw new KubernetesApiError(
          `create Service in ${namespace}`,
          0,
          "NoClusterIP",
        );
      }
      await client.create(stage.clientJob(service.clusterIP));

      // The Job's own deadline stops it; the runner waits a little longer, then gives up.
      const boundMs =
        (settings.repoMapMaxMinutes * 60 +
          settings.terminationGracePeriodSeconds +
          settings.proxyDeadlineMarginSeconds) *
        1000;
      const startedAt = now();
      let state = jobState(await client.getJob(namespace, n.job));
      while (state === "running" || state === "stopping") {
        if (now() - startedAt >= boundMs) {
          throw new RepoMapJobError(`${label} did not end in time`);
        }
        await wait(REPO_MAP_POLL_MS);
        state = jobState(await client.getJob(namespace, n.job));
      }
      // The Job has ended: its token goes now, before its result is read.
      await remove(client, namespace, [["Secret", n.githubTokenSecret]]);
      if (state === "gone") throw new RepoMapJobError(`${label} was deleted`);
      if (state === "deadline") {
        throw new RepoMapJobError(`${label} passed its deadline`);
      }

      const pods = await client.listPods(namespace, {
        ...runSelector(spec.mapId),
        [LABEL_COMPONENT]: "repo-map",
      });
      const pod = pods.map((p) => p.metadata.name).sort()[0];
      const log =
        pod === undefined
          ? null
          : await client.readPodLog(namespace, pod, {
              container: "repo-map",
              tailLines: LOG_TAIL_LINES,
              limitBytes: RESULT_LOG_BYTES,
            });
      const result = parseAgentResult(log);
      if (result === null || result.status !== "success" || state !== "complete") {
        const said = plainError(result?.errorText ?? "");
        throw new RepoMapJobError(`${label} failed${said === "" ? "" : `: ${said}`}`);
      }
      read = decode(result.structured, spec.commitSha);
    } catch (error) {
      // Every object goes, Jobs first; the first error is the one reported.
      await remove(client, namespace, everything).catch(() => undefined);
      throw error;
    }
    // Every object goes, Jobs first. A failed delete fails the read: an object may be left.
    await remove(client, namespace, everything);
    return read;
  }

  return {
    async read(project: RepoMapProject, commitSha?: string): Promise<T> {
      if (!REPOSITORY.test(project.repo)) {
        throw new GitHubReadError("not a repository name");
      }
      agentNamespace(project.slug);
      if (commitSha !== undefined && !FULL_SHA.test(commitSha)) {
        throw new GitHubReadError("a commit must be a full 40-character sha");
      }
      // Minted for this read only, with contents read on this repository only (D-267).
      const token = await tokens.mint({
        repository: project.repo,
        permission: "contents",
      });
      const sha = commitSha ?? (await readHeadCommit(http, project.repo, token));
      const cluster = await options.cluster();
      const spec: RepoMapJobSpec = {
        mapId: checkRunId(ids.next()),
        mode,
        projectSlug: project.slug,
        repository: project.repo,
        commitSha: sha,
      };
      return runJob(cluster, spec, token);
    },
  };
}

export function createKubernetesRepoMaps(options: KubernetesRepoMapsOptions): RepoMaps {
  const jobs = createRepoReadJobs<RepoMap>(options, "map", decodeRepoMapResult);
  return { read: (project, commitSha) => jobs.read(project, commitSha) };
}

/** The Scanner's stage 1 on Kubernetes (D-300, O-92): the repo map Job in scan mode, at the head. */
export function createKubernetesRepoScans(
  options: KubernetesRepoMapsOptions,
): RepoScans {
  const jobs = createRepoReadJobs<RepoScan>(options, "scan", checkScanResult);
  return { scan: (project) => jobs.read(project) };
}
