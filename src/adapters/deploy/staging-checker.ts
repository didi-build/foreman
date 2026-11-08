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
import { COMMIT_MARKER_FILE } from "../../core/preview-check.ts";
import { PROJECT_SLUG, projectStagingUrl } from "../../core/register-project.ts";
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

export function createMarkerStagingChecker(
  http: MarkerHttp = createMarkerHttp(),
): StagingChecker {
  return {
    async check({ project }: StagingCheckRequest): Promise<StagingCheckResult> {
      const url = markerUrl(project.slug);
      if (url === null) return { result: "no_result", reason: "unreachable" };
      let answer;
      try {
        answer = await http.get(url, {
          timeoutMs: MARKER_TIMEOUT_MS,
          maxBytes: MARKER_MAX_BYTES,
        });
      } catch (error) {
        return {
          result: "no_result",
          reason: error instanceof MarkerTimeoutError ? "timed_out" : "unreachable",
        };
      }
      if (answer.status !== 200) return { result: "no_result", reason: "unreachable" };
      const found =
        answer.body === null
          ? null
          : MARKER.exec(Buffer.from(answer.body).toString("latin1"));
      if (!found) return { result: "no_result", reason: "no_marker" };
      return { result: "pass", servedCommitSha: found[1] };
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
