// The repo map Job (D-251, D-267, D-275 (2), O-87): download the archive of one repository at
// one commit through the Job's egress proxy, which allows only GitHub, unpack it in memory, build
// the map with the TypeScript compiler, which parses and never runs the code, and print the map
// as the one result line (src/adapters/repo-map/result.ts). It holds one credential, the runner
// App's `contents: read` token for that repository, and writes nothing anywhere but its result.
//
// The same Job has a second mode for the Scanner's stage 1 (D-299, D-300, O-92):
// `FOREMAN_JOB_MODE=scan` reads the same archive the same way, runs the fixed checks
// (src/core/scan.ts, through src/adapters/repo-map/scan.ts) and prints their findings instead of
// the map. Left unset, the mode is `map`.
//
// Node's `fetch` goes through HTTPS_PROXY only when NODE_USE_ENV_PROXY is 1, which the Dockerfile
// sets; it is checked here too, so a direct connection is never tried. A connection that fails
// before GitHub answers (the proxy not ready yet) is tried again a few times; an answer GitHub
// gave is never retried.
import { readConfig, text, type Setting } from "../../service-kit/config.ts";
import {
  createGitHubHttp,
  REPOSITORY,
  type GitHubHttp,
} from "../../adapters/github/runner-app-tokens.ts";
import { FULL_SHA, readRepoMapAt } from "../../adapters/repo-map/github.ts";
import { encodeRepoMapResult } from "../../adapters/repo-map/result.ts";
import { readScanAt } from "../../adapters/repo-map/scan.ts";
import {
  errorResult,
  exitCode,
  printResult,
  type AgentResult,
} from "../shared/result.ts";

const RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const matching = (env: string, pattern: RegExp, problem: string): Setting<string> => ({
  env,
  parse: (raw) => {
    if (!pattern.test(raw)) throw new Error(problem);
    return raw;
  },
});

const SETTINGS = {
  runId: matching("FOREMAN_RUN_ID", RUN_ID, "is not a run id"),
  repository: matching("FOREMAN_REPOSITORY", REPOSITORY, "is not owner/name"),
  commitSha: matching("FOREMAN_COMMIT_SHA", FULL_SHA, "is not a full commit"),
  githubToken: text("GITHUB_TOKEN"),
  proxy: text("HTTPS_PROXY"),
  envProxy: matching("NODE_USE_ENV_PROXY", /^1$/, "is not 1"),
  mode: {
    ...matching("FOREMAN_JOB_MODE", /^(map|scan)$/, "is not map or scan"),
    fallback: "map",
  },
};

/** Tries of a request whose connection failed before any answer. */
export const CONNECT_TRIES = 5;
const RETRY_MS = 3_000;

export interface RepoMapImageDeps {
  /** GitHub's API. Production: `fetch` through the proxy. */
  http?: GitHubHttp;
  write?: (line: string) => void;
  wait?: (ms: number) => Promise<void>;
}

/** Tries a request again only when it failed before GitHub answered (fetch's TypeError). */
function retryingConnects(
  http: GitHubHttp,
  wait: (ms: number) => Promise<void>,
): GitHubHttp {
  return {
    async get(request) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await http.get(request);
        } catch (error) {
          if (!(error instanceof TypeError) || attempt >= CONNECT_TRIES) throw error;
          await wait(RETRY_MS);
        }
      }
    },
  };
}

/** Runs the Job; returns its exit code. The result line is the last thing written. */
export async function runRepoMapImage(
  env: NodeJS.ProcessEnv,
  deps: RepoMapImageDeps = {},
): Promise<number> {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const wait =
    deps.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let settings: ReturnType<typeof readConfig<typeof SETTINGS>>;
  try {
    settings = readConfig(SETTINGS, env);
  } catch (error) {
    const result = errorResult(error instanceof Error ? error.message : "bad settings");
    printResult(result, [], write);
    return exitCode(result);
  }
  const secrets = [settings.githubToken];
  let result: AgentResult;
  try {
    const http = retryingConnects(deps.http ?? createGitHubHttp(), wait);
    const read = [
      http,
      settings.repository,
      settings.commitSha,
      settings.githubToken,
    ] as const;
    const structured =
      settings.mode === "scan"
        ? await readScanAt(...read)
        : encodeRepoMapResult(await readRepoMapAt(...read));
    result = { ...errorResult(""), status: "success", structured };
  } catch (error) {
    result = errorResult(
      error instanceof Error
        ? error.message
        : settings.mode === "scan"
          ? "the scan could not be run"
          : "the repo map could not be built",
    );
  }
  printResult(result, secrets, write);
  return exitCode(result);
}
