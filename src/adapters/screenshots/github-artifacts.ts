// The runner's screenshot bundles port (src/core/visual-comparison.ts `ScreenshotBundles`, D-242,
// D-267, N-52 option a). CI uploads each bundle as a workflow artifact named
// `foreman-screenshots-<kind>` (`gallery` or `options`), holding `manifest.json` and the files the
// manifest names. The runner lists the repository's artifacts of that name with a read-only
// installation token of the runner App that carries only `actions: read` for that one repository,
// takes the newest one that has not expired and whose workflow run's head commit is the commit
// asked for, downloads it and reads it in memory (./zip.ts). No artifact for the commit is no
// bundle (null), which the visual comparison refuses with its fixed reason. The manifest is
// returned as parsed JSON, or null when it is missing or not JSON; the visual comparison checks
// its shape and every file's SHA-256 strictly.
//
// CI's render step that makes the bundles needs a browser and is not built (N-52); until the
// runner App is registered (D-178) the token port refuses with `NotBuiltError`
// (flows/lib/compose.ts). Tests pass fakes.
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

interface Artifact {
  id: number;
  name: string;
  expired: boolean;
  createdAt: string;
  headSha: string | null;
}

function artifacts(body: Uint8Array): Artifact[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new GitHubReadError("the artifact listing is not JSON");
  }
  const list = (parsed as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(list))
    throw new GitHubReadError("the artifact listing has no list");
  return list.flatMap((raw: unknown): Artifact[] => {
    const a = raw as Record<string, unknown>;
    const run = a.workflow_run as Record<string, unknown> | null | undefined;
    if (!Number.isSafeInteger(a.id) || typeof a.name !== "string") return [];
    return [
      {
        id: a.id as number,
        name: a.name,
        expired: a.expired === true,
        createdAt: typeof a.created_at === "string" ? a.created_at : "",
        headSha: typeof run?.head_sha === "string" ? run.head_sha : null,
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
      const listing = await http.get({
        path: `/repos/${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
        token,
        accept: "json",
        maxBytes: MAX_LISTING_BYTES,
      });
      if (listing.status !== 200) {
        throw new GitHubReadError(
          `listing the artifacts failed with ${listing.status}`,
        );
      }
      const found = artifacts(listing.body)
        .filter((a) => a.name === name && !a.expired && a.headSha === commitSha)
        .sort((a, b) =>
          a.createdAt === b.createdAt
            ? b.id - a.id
            : a.createdAt < b.createdAt
              ? 1
              : -1,
        )[0];
      if (!found) return null;
      const download = await http.get({
        path: `/repos/${repo}/actions/artifacts/${found.id}/zip`,
        token,
        accept: "raw",
        maxBytes: MAX_ARTIFACT_BYTES,
      });
      if (download.status !== 200) {
        throw new GitHubReadError(
          `downloading the artifact failed with ${download.status}`,
        );
      }
      const files = readZip(download.body);
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
        file: async (path) => {
          const bytes = files.get(path);
          return bytes ? new Uint8Array(bytes) : null;
        },
      };
    },
  };
}
