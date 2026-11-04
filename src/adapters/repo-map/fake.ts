// Fakes of the repo map port (src/core/repo-map.ts) and the scan port (src/core/scan.ts) for tests. Maps are kept in memory by
// repository and commit; the default branch's head is the map put last for a repository. Nothing
// is read from a checkout or the network.
import type { RepoMap, RepoMaps } from "../../core/repo-map.ts";
import type { RepoScan, RepoScans } from "../../core/scan.ts";

export interface FakeRepoMaps extends RepoMaps {
  /** Adds a map; it becomes the repository's head. */
  put(repo: string, map: RepoMap): void;
  /** Every read, in order, as `repo@commit` or `repo@head`. */
  reads: string[];
}

export function createFakeRepoMaps(): FakeRepoMaps {
  const maps = new Map<string, RepoMap>();
  const heads = new Map<string, string>();
  const fake: FakeRepoMaps = {
    reads: [],
    put(repo, map) {
      maps.set(`${repo}@${map.commitSha}`, structuredClone(map));
      heads.set(repo, map.commitSha);
    },
    async read({ repo }, commitSha) {
      fake.reads.push(`${repo}@${commitSha ?? "head"}`);
      const sha = commitSha ?? heads.get(repo);
      const map = sha ? maps.get(`${repo}@${sha}`) : undefined;
      if (!map) throw new Error("the fake has no repo map for that commit");
      return structuredClone(map);
    },
  };
  return fake;
}

export interface FakeRepoScans extends RepoScans {
  /** The scan a repository gives next, or an error to throw. */
  put(repo: string, scan: RepoScan | Error): void;
  /** Every scan asked for, in order, by repository. */
  scans: string[];
}

/** A fake scan port: a repository with nothing put throws, as a missing Job result would. */
export function createFakeRepoScans(): FakeRepoScans {
  const results = new Map<string, RepoScan | Error>();
  const fake: FakeRepoScans = {
    scans: [],
    put(repo, scan) {
      results.set(repo, scan instanceof Error ? scan : structuredClone(scan));
    },
    async scan({ repo }) {
      fake.scans.push(repo);
      const result = results.get(repo);
      if (result === undefined)
        throw new Error("the fake has no scan for that repository");
      if (result instanceof Error) throw result;
      return structuredClone(result);
    },
  };
  return fake;
}
