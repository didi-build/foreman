// The runner's screenshot bundles port (src/core/visual-comparison.ts `ScreenshotBundles`, D-242,
// D-267, N-52 option a). CI uploads each bundle as a workflow artifact named
// `foreman-screenshots-<kind>` (`gallery`, `options` or `head-options`, D-281), holding `manifest.json` and the files the
// manifest names. With a read-only installation token of the runner App that carries only
// `actions: read` for that one repository, the runner looks the bundle up by commit: it lists the
// workflow runs of the commit asked for (`head_sha`), then each run's artifacts of that name, and
// takes the newest one that has not expired, so it never pages through other commits' artifacts
// (D-276). It downloads it and reads it in memory (./zip.ts), and returns with it the id of the
// workflow run the artifact came from, which option capture links Didi to (O-89). No artifact
// for the commit is no bundle (null), which the visual comparison refuses with its fixed reason.
// The manifest is returned as parsed JSON, or null when it is missing or not JSON; the visual
// comparison checks its shape and every file's SHA-256 strictly.
//
// CI's Screenshots workflow makes the bundles (scripts/render-screenshots.ts, O-81); the runner
// mints the token with its App's key (flows/lib/compose.ts, O-125). Tests pass fakes.
//
// The listing of one run's artifacts by name, the choice of the newest unexpired one and the
// bounded download are shared with the staging deploy's read of CI's `staging-site` build
// (src/adapters/github/staging-builds.ts, O-116).
import type {
  BundleKind,
  ScreenshotBundle,
  ScreenshotBundles,
} from "../../core/visual-comparison.ts";
import {
  GitHubReadError,
  REPOSITORY,
  type GitHubHttp,
  type RunnerAppTokens,
} from "../github/runner-app-tokens.ts";
import { readZip } from "./zip.ts";

const FULL_SHA = /^[0-9a-f]{40}$/;

/** The artifact name CI gives a bundle of each kind. */
export const artifactName = (kind: BundleKind): string => `foreman-screenshots-${kind}`;

/** The bundle's manifest inside the artifact. */
export const MANIFEST = "manifest.json";

/** The largest artifact the runner downloads, compressed. */
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
/** The largest listing the runner reads. */
const MAX_LISTING_BYTES = 4 * 1024 * 1024;
/** The most workflow runs of one commit the runner looks in (re-runs and other workflows). */
export const MAX_RUNS_PER_COMMIT = 20;

export interface Artifact {
  id: number;
  /** The workflow run whose artifact listing named it. */
  runId: number;
  name: string;
  expired: boolean;
  createdAt: string;
}

function json(body: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new GitHubReadError(`the ${what} listing is not JSON`);
  }
}

/** The ids of the commit's workflow runs, newest first; a run on another commit is dropped. */
function runIds(body: Uint8Array, commitSha: string): number[] {
  const list = (json(body, "workflow run") as { workflow_runs?: unknown })
    .workflow_runs;
  if (!Array.isArray(list))
    throw new GitHubReadError("the workflow run listing has no list");
  return list
    .flatMap((raw: unknown): number[] => {
      const r = raw as Record<string, unknown>;
      return Number.isSafeInteger(r.id) && r.head_sha === commitSha
        ? [r.id as number]
        : [];
    })
    .sort((a, b) => b - a)
    .slice(0, MAX_RUNS_PER_COMMIT);
}

/** One run's artifacts of one name, unexpired or not, as GitHub lists them. */
export async function listRunArtifacts(
  http: GitHubHttp,
  request: { repo: string; runId: number; name: string; token: string },
): Promise<Artifact[]> {
  const { repo, runId, name, token } = request;
  const listing = await http.get({
    path: `/repos/${repo}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(name)}`,
    token,
    accept: "json",
    maxBytes: MAX_LISTING_BYTES,
  });
  if (listing.status !== 200) {
    throw new GitHubReadError(`listing the artifacts failed with ${listing.status}`);
  }
  return artifacts(listing.body, runId);
}

/** The newest unexpired artifact named `name` among `candidates`, or undefined. */
export function newestArtifact(
  candidates: readonly Artifact[],
  name: string,
): Artifact | undefined {
  return candidates
    .filter((a) => a.name === name && !a.expired)
    .sort((a, b) =>
      a.createdAt === b.createdAt ? b.id - a.id : a.createdAt < b.createdAt ? 1 : -1,
    )[0];
}

/** An artifact's zip file, at most `MAX_ARTIFACT_BYTES`. */
export async function downloadArtifact(
  http: GitHubHttp,
  request: { repo: string; id: number; token: string },
): Promise<Uint8Array> {
  const download = await http.get({
    path: `/repos/${request.repo}/actions/artifacts/${request.id}/zip`,
    token: request.token,
    accept: "raw",
    maxBytes: MAX_ARTIFACT_BYTES,
  });
  if (download.status !== 200) {
    throw new GitHubReadError(
      `downloading the artifact failed with ${download.status}`,
    );
  }
  return download.body;
}

function artifacts(body: Uint8Array, runId: number): Artifact[] {
  const list = (json(body, "artifact") as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(list))
    throw new GitHubReadError("the artifact listing has no list");
  return list.flatMap((raw: unknown): Artifact[] => {
    const a = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(a.id) || typeof a.name !== "string") return [];
    return [
      {
        id: a.id as number,
        runId,
        name: a.name,
        expired: a.expired === true,
        createdAt: typeof a.created_at === "string" ? a.created_at : "",
      },
    ];
  });
}

export interface GitHubScreenshotBundlesOptions {
  tokens: RunnerAppTokens;
  http: GitHubHttp;
}

export function createGitHubScreenshotBundles({
  tokens,
  http,
}: GitHubScreenshotBundlesOptions): ScreenshotBundles {
  return {
    async read(
      repo: string,
      commitSha: string,
      kind: BundleKind,
    ): Promise<ScreenshotBundle | null> {
      if (!REPOSITORY.test(repo)) throw new GitHubReadError("not a repository name");
      if (!FULL_SHA.test(commitSha)) {
        throw new GitHubReadError("a commit must be a full 40-character sha");
      }
      // Minted for this read only, with actions read on this repository only (D-267).
      const token = await tokens.mint({ repository: repo, permission: "actions" });
      const name = artifactName(kind);
      const runs = await http.get({
        path: `/repos/${repo}/actions/runs?head_sha=${commitSha}&per_page=${MAX_RUNS_PER_COMMIT}`,
        token,
        accept: "json",
        maxBytes: MAX_LISTING_BYTES,
      });
      if (runs.status !== 200) {
        throw new GitHubReadError(
          `listing the workflow runs failed with ${runs.status}`,
        );
      }
      const candidates: Artifact[] = [];
      for (const runId of runIds(runs.body, commitSha)) {
        candidates.push(
          ...(await listRunArtifacts(http, { repo, runId, name, token })),
        );
      }
      const found = newestArtifact(candidates, name);
      if (!found) return null;
      const files = readZip(
        await downloadArtifact(http, { repo, id: found.id, token }),
      );
      const raw = files.get(MANIFEST);
      let manifest: unknown = null;
      if (raw) {
        try {
          manifest = JSON.parse(Buffer.from(raw).toString("utf8")) as unknown;
        } catch {
          manifest = null;
        }
      }
      return {
        manifest,
        workflowRunId: found.runId,
        file: async (path) => {
          const bytes = files.get(path);
          return bytes ? new Uint8Array(bytes) : null;
        },
      };
    },
  };
}
