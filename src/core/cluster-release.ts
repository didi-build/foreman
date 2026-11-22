// Foreman's release, as the daily check shows it (ADR 0118 appendix G, D-441, D-449, slice 9,
// O-166). An item of a project on Foreman's own cluster target is Done at merge (./staging.ts),
// because Foreman has no staging and a release of Foreman is production (D-007). What is left is
// Didi's: copy the new image pins into infra/kubernetes/settings/production.json and approve the
// Platform workflow's apply. Until that apply, the daily check shows "Foreman upgrade waiting for
// your Platform apply".
//
// The signal, read from GitHub with the runner App's existing read tokens for the project's
// repository only (D-267), never from the store, as the add-only applies are (O-158):
//
// - Built: the newest successful run of the Images workflow on main, and the four platform images
//   its artifact `foreman-images` gives (`settingsFile.platform.images`, written by
//   .github/scripts/build-images.sh). Each Images run rebuilds every image, so the newest run's
//   images hold every change merged before its commit.
// - Applied: the newest Platform run on main that left the cluster matching its commit: its plan
//   (`kubectl-diff`) succeeded, and its reviewed apply (`kubectl-apply`) and its add-only apply
//   each succeeded or were skipped, the condition the workflow itself puts on its cluster Secrets
//   job. Then the platform images pinned in production.json at that run's commit, which is what
//   that run applied.
//
// The upgrade waits while the two sets differ: the newest build is not what the cluster runs.
// Each image is compared by its full reference, pinned by digest, so a tag never counts. With no
// build on main nothing waits; with no Platform run among the newest that left the cluster
// matching its commit, the build waits. A read that fails says so with fixed text, never quiet.
// The Windmill side of a release (the agent images in agent-runs.json) is not part of this
// signal: appendix G names the Platform apply.
//
// Only Foreman is on the cluster target (appendix G): a product on the cluster is a later
// decision (D-439), so the reads are made only for a project whose row names `cluster`, and its
// repository holds the Images and Platform workflows. Plain logic over a port (D-162); the
// adapter is src/adapters/github/cluster-releases.ts. Reads only.
import type { Project } from "./store.ts";

/** D-449's line, word for word. */
export const FOREMAN_UPGRADE_WAITING =
  "Foreman upgrade waiting for your Platform apply";

/** The platform images a Platform apply runs, as production.json names them. */
export const PLATFORM_IMAGE_KEYS = [
  "stateApi",
  "receiver",
  "egressProxy",
  "runWatcher",
] as const;

export type PlatformImageKey = (typeof PLATFORM_IMAGE_KEYS)[number];
export type PlatformImages = Record<PlatformImageKey, string>;

/** An image reference as the Images workflow writes it: Foreman's registry, pinned by digest. */
export const PINNED_IMAGE =
  /^ghcr\.io\/didi-build\/foreman-[a-z0-9-]{1,60}@sha256:[0-9a-f]{64}$/;

const FULL_SHA = /^[0-9a-f]{40}$/;

/** Exactly the four platform images, each pinned by digest; null for anything else. */
export function parsePlatformImages(value: unknown): PlatformImages | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== [...PLATFORM_IMAGE_KEYS].sort().join(",")) return null;
  for (const key of PLATFORM_IMAGE_KEYS) {
    const ref = record[key];
    if (typeof ref !== "string" || !PINNED_IMAGE.test(ref)) return null;
  }
  return record as PlatformImages;
}

/** The newest successful Images run on main: its number, commit and platform images. */
export interface ImagesBuild {
  runNumber: number;
  commitSha: string;
  images: PlatformImages;
}

/** The newest Platform run on main that left the cluster matching its commit, and its pins. */
export interface PlatformApplied {
  runNumber: number;
  commitSha: string;
  images: PlatformImages;
}

/** What the daily check reads from GitHub (src/adapters/github/cluster-releases.ts). */
export interface ClusterReleases {
  /** Null when main has no successful Images run. Throws when it cannot be read. */
  latestBuild(repo: string): Promise<ImagesBuild | null>;
  /**
   * Null when none of the newest Platform runs on main left the cluster matching its commit.
   * Throws when it cannot be read.
   */
  latestApplied(repo: string): Promise<PlatformApplied | null>;
}

/** One cluster-target project's release, as the check shows it. */
export interface ClusterRelease {
  slug: string;
  /**
   * `waiting`: the newest build is not what the cluster runs. `applied`: it is. `no_build`: main
   * has no successful Images run. `unreadable`: GitHub could not be read, so it is not known.
   */
  state: "waiting" | "applied" | "no_build" | "unreadable";
  build: ImagesBuild | null;
  applied: PlatformApplied | null;
  /** What could not be read, for `unreadable`. */
  unreadable?: "build" | "applied";
}

const sameImages = (a: PlatformImages, b: PlatformImages): boolean =>
  PLATFORM_IMAGE_KEYS.every((key) => a[key] === b[key]);

/** Each registered cluster-target project's release, by slug. Reads only. */
export async function clusterReleases(
  deps: { clusterReleases: ClusterReleases },
  projects: readonly Project[],
): Promise<ClusterRelease[]> {
  const out: ClusterRelease[] = [];
  const onCluster = projects
    .filter((p) => p.deployTarget === "cluster")
    .sort((a, b) => a.slug.localeCompare(b.slug));
  for (const project of onCluster) {
    const base = { slug: project.slug, build: null, applied: null };
    let build: ImagesBuild | null;
    try {
      build = await deps.clusterReleases.latestBuild(project.repo);
    } catch {
      out.push({ ...base, state: "unreadable", unreadable: "build" });
      continue;
    }
    if (build === null) {
      out.push({ ...base, state: "no_build" });
      continue;
    }
    let applied: PlatformApplied | null;
    try {
      applied = await deps.clusterReleases.latestApplied(project.repo);
    } catch {
      out.push({ ...base, build, state: "unreadable", unreadable: "applied" });
      continue;
    }
    const runs = applied !== null && sameImages(build.images, applied.images);
    out.push({ ...base, build, applied, state: runs ? "applied" : "waiting" });
  }
  return out;
}

const short = (sha: string): string => (FULL_SHA.test(sha) ? sha.slice(0, 7) : sha);

/** The check's line for one release, or null when nothing waits and nothing failed. */
export function clusterReleaseLine(release: ClusterRelease): string | null {
  if (release.state === "unreadable") {
    return release.unreadable === "build"
      ? `Whether a Foreman upgrade waits for your Platform apply is not shown: the newest Images run on main and its foreman-images artifact could not be read from GitHub (the artifact is kept 30 days).`
      : `Whether a Foreman upgrade waits for your Platform apply is not shown: the Platform workflow's newest runs on main could not be read from GitHub.`;
  }
  if (release.state !== "waiting" || release.build === null) return null;
  const built = `the images built from commit ${short(release.build.commitSha)} (Images run #${release.build.runNumber})`;
  const runs =
    release.applied === null
      ? "no recent Platform run on main shows the cluster matching its commit"
      : `the cluster runs the pins of commit ${short(release.applied.commitSha)} (Platform run #${release.applied.runNumber})`;
  return `${FOREMAN_UPGRADE_WAITING}: ${built} are not applied; ${runs}. Copy the pins from that Images run's foreman-images artifact into infra/kubernetes/settings/production.json, merge, and approve the Platform apply.`;
}
