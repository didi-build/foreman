// A fake of the screenshot bundles port for tests (src/core/visual-comparison.ts). Bundles are
// kept in memory by repository, commit and kind; nothing is read from CI or the network.
import type { BundleKind, ScreenshotBundles } from "../../core/visual-comparison.ts";

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
