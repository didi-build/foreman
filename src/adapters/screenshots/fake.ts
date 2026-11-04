// Fakes of the screenshot bundles port and the repo folders port for tests
// (src/core/visual-comparison.ts), and of the repository visibility port option capture checks
// before it links Didi to CI's run (src/core/option-capture.ts, O-89). Bundles are kept in memory
// by repository, commit and kind, folder ids by repository, commit and path, and visibility by
// repository; nothing is read from CI, GitHub or the network.
import type { RepoVisibility } from "../../core/option-capture.ts";
import type {
  BundleKind,
  RepoFolders,
  ScreenshotBundles,
} from "../../core/visual-comparison.ts";

export interface FakeBundle {
  manifest: unknown;
  files: Map<string, Uint8Array>;
  /** The workflow run the bundle came from; `FAKE_WORKFLOW_RUN_ID` unless given. */
  workflowRunId?: number;
}

/** The workflow run id a fake bundle carries unless the test gives one. */
export const FAKE_WORKFLOW_RUN_ID = 4242;

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
        workflowRunId: bundle.workflowRunId ?? FAKE_WORKFLOW_RUN_ID,
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

export interface FakeRepoVisibility extends RepoVisibility {
  /** A repository's answer: private, public, or a failed read. Unset repositories are private. */
  set(repo: string, answer: "private" | "public" | "fail"): void;
  /** Every repository asked about, in order. */
  reads: string[];
}

export function createFakeRepoVisibility(): FakeRepoVisibility {
  const answers = new Map<string, "private" | "public" | "fail">();
  const fake: FakeRepoVisibility = {
    reads: [],
    set(repo, answer) {
      answers.set(repo, answer);
    },
    async isPrivate(repo) {
      fake.reads.push(repo);
      const answer = answers.get(repo) ?? "private";
      if (answer === "fail") throw new Error("the fake visibility read failed");
      return answer === "private";
    },
  };
  return fake;
}
