// The runner's ports for `BOOTSTRAP_TOKEN`'s access (src/core/bootstrap-access.ts, D-358 lock (2),
// O-114), on GitHub's REST API (all read 2026-11-07):
//
// - `grant` and `remove`: GitHub's "Add selected repository to an organization secret",
//   `PUT /orgs/didi-build/actions/secrets/BOOTSTRAP_TOKEN/repositories/<repository_id>`, and
//   "Remove selected repository from an organization secret", the same path with `DELETE`. Each
//   answers 204 when done and 409 when the secret is not shared with selected repositories. The id
//   comes from `GET /repos/didi-build/<name>` with the same change token (its `metadata: read`),
//   checked against the name. One change token per call (./bootstrap-tokens.ts).
// - `list`: "List selected repositories for an organization secret",
//   `GET /orgs/didi-build/actions/secrets/BOOTSTRAP_TOKEN/repositories`, 100 a page, with the list
//   token.
// - `restart`: "Create a workflow dispatch event",
//   `POST /repos/didi-build/<name>/actions/workflows/bootstrap.yml/dispatches` with exactly
//   `{"ref":"main"}`, which answers 204, with the restart token. A repository the form created
//   seconds earlier may not have its workflows yet, and GitHub then answers 404 (2026-11-13,
//   O-114): that one answer is tried again with the same token after `RESTART_RETRY_DELAYS_MS`,
//   about a minute in all. A 404 starts no run, so a later 204 is the only start. Any other answer
//   stops at once.
// - `latestRestart`: "List workflow runs for a workflow",
//   `GET /repos/didi-build/<name>/actions/workflows/bootstrap.yml/runs?event=workflow_dispatch&per_page=1`,
//   newest first, with the runner App's read-only `actions` token for that one repository (D-267).
//
// A refused mint, a failed call or any other answer is refused, naming the step and, when GitHub
// answered, its status, and nothing else is tried again. The runner mints each token with its App's key (flows/lib/compose.ts, O-125).
// Tests pass fakes. Nothing here logs, and no token or id is kept.
import {
  BOOTSTRAP_REF,
  BOOTSTRAP_SECRET,
  BOOTSTRAP_WORKFLOW_FILE,
  GITHUB_ORGANIZATION,
  isBootstrapWorkflowPath,
  isRepositoryName,
  RESTART_EVENT,
  type BootstrapAccess,
  type BootstrapRun,
  type BootstrapRuns,
  type GitHubChange,
} from "../../core/bootstrap-access.ts";
import type { BootstrapTokens } from "./bootstrap-tokens.ts";
import type { GitHubPostHttp } from "./post-http.ts";
import {
  GitHubReadError,
  type GitHubHttp,
  type RunnerAppTokens,
} from "./runner-app-tokens.ts";
import type { GitHubWriteHttp } from "./write-http.ts";

/** The secret's list of selected repositories on GitHub's API. */
export const SECRET_REPOSITORIES_PATH = `/orgs/${GITHUB_ORGANIZATION}/actions/secrets/${BOOTSTRAP_SECRET}/repositories`;

/** The repositories one page of the list holds, GitHub's most. */
const PAGE_SIZE = 100;
/** The most pages the list reads: far more repositories than the organization has. */
const MAX_PAGES = 10;
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function json(body: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

const refused = (
  step: "token" | "not_selected" | "call",
  status?: number,
): GitHubChange => ({
  kind: "refused",
  step,
  ...(status === undefined ? {} : { status }),
});

/**
 * The waits before each further try of Bootstrap's restart while GitHub answers 404 because a
 * repository created moments ago has no workflows yet (O-114): about a minute in all.
 */
export const RESTART_RETRY_DELAYS_MS: readonly number[] = [
  5_000, 10_000, 15_000, 30_000,
];

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export interface GitHubBootstrapAccessOptions {
  tokens: Pick<BootstrapTokens, "secretsChange" | "secretsList">;
  http: GitHubHttp;
  write: GitHubWriteHttp;
}

export function createGitHubBootstrapAccess({
  tokens,
  http,
  write,
}: GitHubBootstrapAccessOptions): BootstrapAccess {
  /** GitHub's id for `didi-build/<name>`, read with the change token, or null. */
  async function repositoryId(token: string, name: string): Promise<number | null> {
    const answer = await http.get({
      path: `/repos/${GITHUB_ORGANIZATION}/${name}`,
      token,
      accept: "json",
      maxBytes: MAX_ANSWER_BYTES,
    });
    if (answer.status !== 200) return null;
    const body = json(answer.body);
    if (!isObject(body) || body.full_name !== `${GITHUB_ORGANIZATION}/${name}`)
      return null;
    return typeof body.id === "number" && Number.isSafeInteger(body.id) && body.id > 0
      ? body.id
      : null;
  }

  async function change(method: "PUT" | "DELETE", name: string): Promise<GitHubChange> {
    if (!isRepositoryName(name)) return refused("call");
    let token: string;
    try {
      // Minted for this one change, and never again with a wider request (D-358).
      token = await tokens.secretsChange(name);
    } catch {
      return refused("token");
    }
    try {
      const id = await repositoryId(token, name);
      if (id === null) return refused("call");
      const answer = await write.send({
        method,
        path: `${SECRET_REPOSITORIES_PATH}/${id}`,
        token,
        maxBytes: MAX_ANSWER_BYTES,
      });
      if (answer.status === 204) return { kind: "done" };
      return refused(answer.status === 409 ? "not_selected" : "call");
    } catch {
      return refused("call");
    }
  }

  return {
    grant: (name) => change("PUT", name),
    remove: (name) => change("DELETE", name),

    async list() {
      const token = await tokens.secretsList();
      const names: string[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const answer = await http.get({
          path: `${SECRET_REPOSITORIES_PATH}?per_page=${PAGE_SIZE}&page=${page}`,
          token,
          accept: "json",
          maxBytes: MAX_ANSWER_BYTES,
        });
        if (answer.status !== 200) {
          throw new GitHubReadError(
            `listing the secret's repositories failed with ${answer.status}`,
          );
        }
        const body = json(answer.body);
        if (
          !isObject(body) ||
          typeof body.total_count !== "number" ||
          !Array.isArray(body.repositories)
        ) {
          throw new GitHubReadError("the secret's repository list is not one");
        }
        for (const repository of body.repositories as unknown[]) {
          const name = isObject(repository) ? repository.name : undefined;
          if (
            !isRepositoryName(name) ||
            !isObject(repository) ||
            repository.full_name !== `${GITHUB_ORGANIZATION}/${name}`
          ) {
            throw new GitHubReadError(
              "the secret's repository list names another owner",
            );
          }
          names.push(name);
        }
        if (body.repositories.length < PAGE_SIZE || names.length >= body.total_count)
          return names;
      }
      throw new GitHubReadError(
        "the secret's repository list is longer than the runner reads",
      );
    },
  };
}

export interface GitHubBootstrapRunsOptions {
  tokens: Pick<BootstrapTokens, "restart">;
  /** The runner App's read-only tokens (D-267): `actions: read` for one repository. */
  readTokens: RunnerAppTokens;
  http: GitHubHttp;
  post: GitHubPostHttp;
  /** The waits between the restart's tries on a 404. Tests pass short ones. */
  retryDelaysMs?: readonly number[];
  wait?: (ms: number) => Promise<void>;
}

/** The run GitHub's answer names first, or null when it names none. Throws on any other shape. */
export function newestRunOf(body: unknown): BootstrapRun | null {
  if (!isObject(body) || !Array.isArray(body.workflow_runs))
    throw new GitHubReadError("the run list is not one");
  const run: unknown = body.workflow_runs[0];
  if (run === undefined) return null;
  if (
    !isObject(run) ||
    run.event !== RESTART_EVENT ||
    !isBootstrapWorkflowPath(run.path) ||
    typeof run.status !== "string" ||
    !(typeof run.conclusion === "string" || run.conclusion === null)
  ) {
    throw new GitHubReadError("the newest run is not a restarted Bootstrap run");
  }
  return { event: run.event, status: run.status, conclusion: run.conclusion };
}

export function createGitHubBootstrapRuns({
  tokens,
  readTokens,
  http,
  post,
  retryDelaysMs = RESTART_RETRY_DELAYS_MS,
  wait = sleep,
}: GitHubBootstrapRunsOptions): BootstrapRuns {
  const workflowPath = (name: string) =>
    `/repos/${GITHUB_ORGANIZATION}/${name}/actions/workflows/${BOOTSTRAP_WORKFLOW_FILE}`;
  return {
    async restart(name) {
      if (!isRepositoryName(name)) return refused("call");
      let token: string;
      try {
        // Minted for this one start, and never again with a wider request (D-358).
        token = await tokens.restart(name);
      } catch {
        return refused("token");
      }
      for (let attempt = 0; ; attempt += 1) {
        let status: number;
        try {
          const answer = await post.post({
            path: `${workflowPath(name)}/dispatches`,
            token,
            body: { ref: BOOTSTRAP_REF },
            maxBytes: MAX_ANSWER_BYTES,
          });
          status = answer.status;
        } catch {
          return refused("call");
        }
        if (status === 204) return { kind: "done" };
        const delay = retryDelaysMs[attempt];
        if (status !== 404 || delay === undefined) return refused("call", status);
        await wait(delay);
      }
    },

    async latestRestart(name) {
      if (!isRepositoryName(name)) throw new GitHubReadError("not a repository name");
      const token = await readTokens.mint({
        repository: `${GITHUB_ORGANIZATION}/${name}`,
        permission: "actions",
      });
      const answer = await http.get({
        path: `${workflowPath(name)}/runs?event=${RESTART_EVENT}&per_page=1`,
        token,
        accept: "json",
        maxBytes: MAX_ANSWER_BYTES,
      });
      // No Bootstrap workflow on the repository: no run of it either.
      if (answer.status === 404) return null;
      if (answer.status !== 200) {
        throw new GitHubReadError(
          `reading Bootstrap's runs failed with ${answer.status}`,
        );
      }
      return newestRunOf(json(answer.body));
    },
  };
}
