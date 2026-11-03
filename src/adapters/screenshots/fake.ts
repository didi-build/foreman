// Fakes of the screenshot bundles port and the repo folders port for tests
// (src/core/visual-comparison.ts). Bundles are kept in memory by repository, commit and kind, and
// folder ids by repository, commit and path; nothing is read from CI, GitHub or the network.
import type {
  BundleKind,
  RepoFolders,
  ScreenshotBundles,
} from "../../core/visual-comparison.ts";

export interface FakeBundle {
  manifest: unknown;
  files: Map<string, Uint8Array>;
}

export interface FakeScreenshotBundles extends ScreenshotBundles {
  put(repo: string, commitSha: string, kind: BundleKind, bundle: FakeBundle): void;
  /** Every read, in order, as `repo@commit:kind`. */
  reads: string[];
}

export function createFakeScreenshotBundles(): FakeScreenshotBundles {
  const bundles = new Map<string, FakeBundle>();
  const key = (repo: string, commitSha: string, kind: BundleKind) =>
    `${repo}@${commitSha}:${kind}`;
  const fake: FakeScreenshotBundles = {
    reads: [],
    put(repo, commitSha, kind, bundle) {
      bundles.set(key(repo, commitSha, kind), bundle);
    },
    async read(repo, commitSha, kind) {
      fake.reads.push(key(repo, commitSha, kind));
      const bundle = bundles.get(key(repo, commitSha, kind));
      if (!bundle) return null;
      return {
        manifest: structuredClone(bundle.manifest),
        file: async (path) => {
          const bytes = bundle.files.get(path);
          return bytes ? new Uint8Array(bytes) : null;
        },
      };
    },
  };
  return fake;
}

export interface FakeRepoFolders extends RepoFolders {
  /** Sets a folder's tree id at a commit; null removes it. */
  put(repo: string, commitSha: string, path: string, id: string | null): void;
  /** Every read, in order, as `repo@commit:path`. */
  reads: string[];
}

export function createFakeRepoFolders(): FakeRepoFolders {
  const ids = new Map<string, string>();
  const key = (repo: string, commitSha: string, path: string) =>
    `${repo}@${commitSha}:${path}`;
  const fake: FakeRepoFolders = {
    reads: [],
    put(repo, commitSha, path, id) {
      if (id === null) ids.delete(key(repo, commitSha, path));
      else ids.set(key(repo, commitSha, path), id);
    },
    async folderId(repo, commitSha, path) {
      fake.reads.push(key(repo, commitSha, path));
      return ids.get(key(repo, commitSha, path)) ?? null;
    },
  };
  return fake;
}
