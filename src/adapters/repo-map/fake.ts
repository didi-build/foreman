// A fake of the repo map port for tests (src/core/repo-map.ts). Maps are kept in memory by
// repository and commit; the default branch's head is the map put last for a repository. Nothing
// is read from a checkout or the network.
import type { RepoMap, RepoMaps } from "../../core/repo-map.ts";

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
    async read(repo, commitSha) {
      fake.reads.push(`${repo}@${commitSha ?? "head"}`);
      const sha = commitSha ?? heads.get(repo);
      const map = sha ? maps.get(`${repo}@${sha}`) : undefined;
      if (!map) throw new Error("the fake has no repo map for that commit");
      return structuredClone(map);
    },
  };
  return fake;
}
