// The runner's staging check (ADR 0107, O-35, O-116), in the deploy adapter, which owns where
// staging answers (ADR 0111 section 2). It reads the commit marker the staging site serves,
// `https://<slug>.didi.build/foreman-commit.txt` (`projectStagingUrl`, D-357, and
// `COMMIT_MARKER_FILE`, O-111), with a time limit and a size bound, and reports the commit staging
// serves. The core then requires a commit that contains the item's merge commit, by GitHub's
// compare (D-225 rule 1, O-39): the check itself passes on any commit it reads, and a served commit
// that does not count is the core's `another_commit`.
//
// - 200 with a body that is exactly 40 lowercase hex characters, with or without one newline (as
//   CI's probe accepts it): `pass`, with that commit.
// - 200 with any other body, or one longer than the bound: `no_result` `no_marker`. With the site's
//   single-page fallback a missing marker answers with the app's `index.html`, so this is the
//   answer of a site that serves no marker.
// - Any other status, a redirect (none is followed) or no answer: `no_result` `unreachable`.
// - No answer within the time limit: `no_result` `timed_out`.
// Nothing is thrown for a failure to reach staging, so the core records the attempt (O-36). No
// credential is used: staging is public.
//
// When the deploy carried a Worker module (`worker` in the request, ADR 0118 slice 3, O-159), a
// marker that passes is followed by one GET of `https://<slug>.didi.build/api/health`, with the
// same bounds. It is asked second, so the Worker answering is the version that serves the marker,
// as long as a location keeps serving a version once it has it (not confirmed: the first real
// Worker deploy, slice 5's template, shows it).
// - 200 with a JSON body that is exactly `{"status":"ok"}` (the template's answer, appendix E
//   item 2): `pass`.
// - Any other answer, its status or its body (the single-page fallback's `index.html` included,
//   which is what a site whose Worker does not run `/api` serves): `fail` `api_health`, with the
//   marker's commit, so the core counts it only when that commit counts.
// - No answer, or none in time: `no_result` `unreachable` or `timed_out`, as for the marker.
// Without `worker`, nothing but the marker is read, as before.
import { COMMIT_MARKER_FILE } from "../../core/preview-check.ts";
import { PROJECT_SLUG, projectStagingUrl } from "../../core/project-repository.ts";
import type {
  StagingCheckRequest,
  StagingCheckResult,
  StagingChecker,
} from "../../core/staging.ts";

/** How long one read of the marker may take. */
export const MARKER_TIMEOUT_MS = 10_000;
/** The marker is 41 bytes; a longer body is not a marker. */
export const MARKER_MAX_BYTES = 1024;

const MARKER = /^([0-9a-f]{40})\n?$/;

/** The Worker's health path, which only the Worker answers (`run_worker_first`, O-159). */
export const HEALTH_PATH = "/api/health";

/** One GET of a public address, with no redirect followed. */
export interface MarkerHttp {
  get(
    url: string,
    bounds: { timeoutMs: number; maxBytes: number },
  ): Promise<{ status: number; body: Uint8Array | null }>;
}

/** Thrown by a `MarkerHttp` when the read ran out of time. */
export class MarkerTimeoutError extends Error {
  constructor() {
    super("the staging marker did not answer in time");
    this.name = "MarkerTimeoutError";
  }
}

/** The marker's address for a project, or null when its slug makes no staging address. */
export function markerUrl(slug: string): string | null {
  return PROJECT_SLUG.test(slug)
    ? `${projectStagingUrl(slug)}/${COMMIT_MARKER_FILE}`
    : null;
}

/** The Worker's health address for a project, or null when its slug makes no staging address. */
export function healthUrl(slug: string): string | null {
  return PROJECT_SLUG.test(slug) ? `${projectStagingUrl(slug)}${HEALTH_PATH}` : null;
}

/** Whether the body is exactly the JSON object `{"status":"ok"}`. */
function isHealthy(body: Uint8Array | null): boolean {
  if (body === null) return false;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return false;
  }
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    (value as Record<string, unknown>).status === "ok"
  );
}

/** One bounded GET; a failure to answer becomes the result without a result it means. */
async function read(
  http: MarkerHttp,
  url: string,
): Promise<{ status: number; body: Uint8Array | null } | StagingCheckResult> {
  try {
    return await http.get(url, {
      timeoutMs: MARKER_TIMEOUT_MS,
      maxBytes: MARKER_MAX_BYTES,
    });
  } catch (error) {
    return {
      result: "no_result",
      reason: error instanceof MarkerTimeoutError ? "timed_out" : "unreachable",
    };
  }
}

export function createMarkerStagingChecker(
  http: MarkerHttp = createMarkerHttp(),
): StagingChecker {
  return {
    async check({ project, worker }: StagingCheckRequest): Promise<StagingCheckResult> {
      const url = markerUrl(project.slug);
      const health = healthUrl(project.slug);
      if (url === null || health === null) {
        return { result: "no_result", reason: "unreachable" };
      }
      const answer = await read(http, url);
      if ("result" in answer) return answer;
      if (answer.status !== 200) return { result: "no_result", reason: "unreachable" };
      const found =
        answer.body === null
          ? null
          : MARKER.exec(Buffer.from(answer.body).toString("latin1"));
      if (!found) return { result: "no_result", reason: "no_marker" };
      const servedCommitSha = found[1];
      if (!worker) return { result: "pass", servedCommitSha };

      // The Worker's health, asked after the marker (O-159).
      const probe = await read(http, health);
      if ("result" in probe) return probe;
      return probe.status === 200 && isHealthy(probe.body)
        ? { result: "pass", servedCommitSha }
        : { result: "fail", servedCommitSha, reason: "api_health" };
    },
  };
}

/**
 * The real port: `fetch` with no redirect followed, no cache, a time limit, and a body read only
 * up to the bound (null past it). Not used in tests.
 */
export function createMarkerHttp(): MarkerHttp {
  return {
    async get(url, { timeoutMs, maxBytes }) {
      let response: Response;
      try {
        response = await fetch(url, {
          redirect: "manual",
          cache: "no-store",
          headers: { "cache-control": "no-cache", "user-agent": "foreman-runner" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          throw new MarkerTimeoutError();
        }
        throw error;
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader?.read();
          if (!next || next.done) break;
          size += next.value.length;
          if (size > maxBytes) {
            await reader?.cancel();
            return { status: response.status, body: null };
          }
          chunks.push(next.value);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          throw new MarkerTimeoutError();
        }
        throw error;
      }
      return { status: response.status, body: Buffer.concat(chunks) };
    },
  };
}
