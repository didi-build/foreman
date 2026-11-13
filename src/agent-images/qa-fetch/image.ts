// QA's fetch step (ADR 0106 section 5, ADR 0112, D-159, D-184, O-124): a short-lived Job before
// QA's review, and the only pod that holds QA's read-only installation token for the one
// repository. It checks its settings and the workspace, downloads the archive of exactly the
// run's head commit from GitHub's API (`/repos/{owner}/{repo}/tarball/{sha}`, which redirects to
// codeload.github.com) through its own egress proxy, which allows only the GitHub hosts in QA's
// bot file, and unpacks it into the run's volume (./unpack.ts). QA's pod then mounts that volume
// read-only at the same path and reads the commit from its own settings, so nothing else is
// written: no marker file.
//
// The token is never logged, never written to disk and never a process argument: it goes only
// into the request's Authorization header, which `fetch` drops when GitHub's answer redirects to
// the download host, and it is removed from the result line. The runner reads only how the Job
// ended (src/adapters/agent-runtime/kubernetes/runtime.ts): exit 0 starts QA's review, anything
// else fails the run closed. Like every job image it prints one result line last (ADR 0106
// section 4); a refusal is fixed text that names a setting or a step, never a value.
//
// Node's `fetch` goes through HTTPS_PROXY only when NODE_USE_ENV_PROXY is 1, which the Dockerfile
// sets; it is checked here too, so a direct connection is never tried. A connection that fails
// before GitHub answers (the proxy not ready yet) is tried again a few times (../shared/
// job-kit.ts); an answer GitHub gave is never retried.
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";

import {
  MIN_SECRET_LENGTH,
  secretForms,
} from "../../../scripts/lib/find-secret-values.mjs";
import { REPOSITORY } from "../../core/github.ts";
import { isPlainRelativePath } from "../../adapters/github/archive-path.ts";
import { githubApiGet } from "../../adapters/github/runner-app-tokens.ts";
import { readConfig, text, type Setting } from "../../service-kit/config.ts";
import { matching, retryConnects } from "../shared/job-kit.ts";
import {
  errorResult,
  exitCode,
  printResult,
  type AgentResult,
} from "../shared/result.ts";
import { FETCH_LIMITS, FetchRefusal, REFUSED, unpackArchive } from "./unpack.ts";

const RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const PR_NUMBER = /^[1-9][0-9]{0,9}$/;
/** Printable ASCII with no space: a value that fits a header and that the scan can look for. */
const TOKEN = /^[\x21-\x7e]{1,1000}$/;
/** The folder a new ext4 volume starts with, which may be there before the tree. */
const LOST_AND_FOUND = "lost+found";

const repository: Setting<string> = {
  env: "FOREMAN_REPOSITORY",
  parse: (raw) => {
    const name = raw.split("/")[1];
    if (!REPOSITORY.test(raw) || name === "." || name === "..") {
      throw new Error("is not owner/name");
    }
    return raw;
  },
};

const workspace: Setting<string> = {
  env: "FOREMAN_WORKSPACE",
  parse: (raw) => {
    if (
      !raw.startsWith("/") ||
      raw.length > 1000 ||
      !isPlainRelativePath(raw.slice(1))
    ) {
      throw new Error("is not a plain absolute path");
    }
    return raw;
  },
};

const githubToken: Setting<string> = {
  env: "GITHUB_TOKEN",
  parse: (raw) => {
    if (!TOKEN.test(raw) || raw.length < MIN_SECRET_LENGTH)
      throw new Error("is not a token");
    return raw;
  },
};

const SETTINGS = {
  runId: matching("FOREMAN_RUN_ID", RUN_ID, "is not a run id"),
  repository,
  headSha: matching("FOREMAN_HEAD_SHA", FULL_SHA, "is not a full commit"),
  prNumber: matching("FOREMAN_PR_NUMBER", PR_NUMBER, "is not a pull request number"),
  workspace,
  githubToken,
  proxy: text("HTTPS_PROXY"),
  envProxy: matching("NODE_USE_ENV_PROXY", /^1$/, "is not 1"),
};

/** GitHub's answer to the archive request, its body still arriving. */
export interface ArchiveAnswer {
  status: number;
  /** The `Content-Length` GitHub gave, or null. */
  declaredBytes: number | null;
  /** The body as it arrives. Stopping early closes the download. */
  body: AsyncIterable<Uint8Array>;
  /** Drops a body that will not be read. */
  discard(): Promise<void>;
}

/** The download port. Production: `fetch` through the proxy. Tests pass a fake. */
export interface ArchiveHttp {
  get(path: string, token: string): Promise<ArchiveAnswer>;
}

/** The real download port: one GET of GitHub's API, the redirect followed (`githubApiGet`). */
export function createArchiveHttp(): ArchiveHttp {
  return {
    async get(path, token) {
      const response = await githubApiGet(path, token, "download");
      const length = response.headers.get("content-length");
      return {
        status: response.status,
        declaredBytes: length === null ? null : Number(length),
        body: bodyOf(response),
        discard: async () => {
          await response.body?.cancel();
        },
      };
    },
  };
}

async function* bodyOf(response: Response): AsyncGenerator<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export interface QaFetchImageDeps {
  /** GitHub's API. Production: `fetch` through the proxy. */
  http?: ArchiveHttp;
  write?: (line: string) => void;
  wait?: (ms: number) => Promise<void>;
}

const DOWNLOAD_FAILED = "the archive could not be downloaded";
const WORKSPACE_NOT_FOLDER = "the workspace is not a folder";
const WORKSPACE_NOT_EMPTY = "the workspace is not empty";

/** The workspace must be a folder, not a link, holding nothing but a new volume's lost+found. */
async function checkWorkspace(path: string): Promise<void> {
  let entries: Dirent[] | undefined;
  try {
    const info = await lstat(path);
    if (info.isDirectory()) entries = await readdir(path, { withFileTypes: true });
  } catch {
    entries = undefined;
  }
  if (entries === undefined) throw new FetchRefusal(WORKSPACE_NOT_FOLDER);
  if (entries.some((e) => e.name !== LOST_AND_FOUND || !e.isDirectory())) {
    throw new FetchRefusal(WORKSPACE_NOT_EMPTY);
  }
}

/** Runs the Job; returns its exit code. The result line is the last thing written. */
export async function runQaFetchImage(
  env: NodeJS.ProcessEnv,
  deps: QaFetchImageDeps = {},
): Promise<number> {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const wait =
    deps.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let settings: ReturnType<typeof readConfig<typeof SETTINGS>>;
  try {
    settings = readConfig(SETTINGS, env);
  } catch (error) {
    const result = errorResult(error instanceof Error ? error.message : "bad settings");
    printResult(result, [env.GITHUB_TOKEN ?? ""], write);
    return exitCode(result);
  }
  const { headSha, githubToken: token } = settings;
  let result: AgentResult;
  try {
    await checkWorkspace(settings.workspace);
    const http = deps.http ?? createArchiveHttp();
    const path = `/repos/${settings.repository}/tarball/${headSha}`;
    let answer: ArchiveAnswer;
    try {
      answer = await retryConnects(() => http.get(path, token), wait);
    } catch {
      throw new FetchRefusal(DOWNLOAD_FAILED);
    }
    if (answer.status !== 200) {
      await answer.discard().catch(() => {});
      throw new FetchRefusal(`downloading the archive failed with ${answer.status}`);
    }
    if (
      answer.declaredBytes !== null &&
      answer.declaredBytes > FETCH_LIMITS.archiveBytes
    ) {
      await answer.discard().catch(() => {});
      throw new FetchRefusal(REFUSED.tooLarge);
    }
    const summary = await unpackArchive(answer.body, {
      workspace: settings.workspace,
      commitSha: headSha,
      secretTexts: secretForms(token).map((form) => form.text),
    });
    result = {
      ...errorResult(""),
      status: "success",
      structured: { commitSha: headSha, ...summary },
    };
  } catch (error) {
    result = errorResult(
      error instanceof FetchRefusal ? error.message : "the fetch step failed",
    );
  }
  printResult(result, [token], write);
  return exitCode(result);
}
