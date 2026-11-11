// The Windmill binding of a flow's environment (D-370, D-371, O-121). Inside a Windmill job it
// reads, with the job's own token and nothing else:
//
// - a secret: the secret variable at `f/foreman/<path>`, which Windmill encrypts with the
//   workspace's key;
// - a plain value: the plain variable at `f/foreman/<name>`, the `windmill_path` that
//   flows/windmill.yaml gives (test/flows/windmill-description.test.ts holds the two together);
// - the month's execution count: Windmill's own counter for the workspace, the number its plan
//   limit is checked against (D-167, D-369).
//
// Windmill sets the job's environment (its source, version 1.865.0: `get_reserved_variables` in
// windmill-common `variables.rs`, and `get_common_bun_proc_envs` in windmill-worker
// `bun_executor.rs`): `WM_TOKEN`, a token that acts as the user the job runs as, `WM_WORKSPACE`,
// and the API's internal address, `BASE_INTERNAL_URL` for most languages and `BASE_URL` for Bun
// and Node jobs; Windmill's own client reads them in the same order. The token reaches only what
// the script's `job_token_scopes` allow (D-371): `variables:read:f/foreman/*` for every flow, plus
// `workspaces:read` on the reconcile flow, the only one that reads the count.
//
// Nothing here logs, and nothing returns a value except to its caller. Each refusal is fixed text
// that names the variable or the path and, for an answer, its status: never the token, a value or
// Windmill's answer. A job without these environment variables (tests, local runs) is refused.
import { parseWindmillWorkspace } from "../../src/adapters/windmill/client.ts";
import type { FlowEnvironment } from "./environment.ts";

/** The folder every flow, secret and value lives in (`workspace_folder` in flows/windmill.yaml). */
export const WINDMILL_FOLDER = "f/foreman";

/** The scope every flow's script caps its job token to (`job_token_scopes`, D-371). */
export const READ_VARIABLES_SCOPE = `variables:read:${WINDMILL_FOLDER}/*`;

/** Added on the reconcile flow only, for the execution count. Windmill cannot limit it to paths. */
export const READ_USAGE_SCOPE = "workspaces:read";

/** The environment variables Windmill sets in every job. None is read for anything else. */
export const WINDMILL_JOB_ENV = {
  token: "WM_TOKEN",
  workspace: "WM_WORKSPACE",
  internalUrl: "BASE_INTERNAL_URL",
  baseUrl: "BASE_URL",
} as const;

/** How long one read may take, answer included. */
export const WINDMILL_READ_TIMEOUT_MS = 10_000;

/** A secret path or a value name, below the folder: plain lower-case segments. */
const VARIABLE_PATH = /^[a-z0-9][a-z0-9_-]{0,62}(?:\/[a-z0-9][a-z0-9_-]{0,62}){0,7}$/;
const TOKEN = /^[\x21-\x7e]+$/;
const COUNT = /^[0-9]{1,15}$/;

/** The job's environment variables are missing or out of shape. Names the variable only. */
export class WindmillNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindmillNotConfiguredError";
  }
}

/** A read Windmill did not answer as expected. Names the path and the status only. */
export class WindmillReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindmillReadError";
  }
}

/** The Windmill variable that holds a secret path or a value name (D-370). */
export function windmillVariablePath(pathOrName: string): string {
  if (!VARIABLE_PATH.test(pathOrName)) {
    throw new WindmillReadError(
      "A secret path or value name must be plain lower-case segments.",
    );
  }
  return `${WINDMILL_FOLDER}/${pathOrName}`;
}

/** The part of `fetch` the binding uses; tests pass a fake. */
export type WindmillFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface WindmillEnvironmentOptions {
  /** Where the job's variables are read. The process's environment by default. */
  env?: Record<string, string | undefined>;
  fetch?: WindmillFetch;
}

interface Job {
  token: string;
  /** `<internal address>/api/w/<workspace>`, with no trailing slash. */
  api: string;
}

/** The job's token, workspace and API address, or a refusal naming the variable. */
function jobOf(env: Record<string, string | undefined>, what: string): Job {
  function refuse(problem: string): never {
    throw new WindmillNotConfiguredError(`${problem}, so ${what} cannot be read`);
  }
  const {
    token: tokenName,
    workspace: workspaceName,
    internalUrl,
    baseUrl,
  } = WINDMILL_JOB_ENV;
  const token = env[tokenName] ?? "";
  if (token === "") refuse(`${tokenName} is not set`);
  if (!TOKEN.test(token)) refuse(`${tokenName} is not a token`);
  const rawWorkspace = env[workspaceName] ?? "";
  if (rawWorkspace === "") refuse(`${workspaceName} is not set`);
  let workspace: string;
  try {
    workspace = parseWindmillWorkspace(rawWorkspace);
  } catch {
    refuse(`${workspaceName} is not a workspace id`);
  }
  // Windmill's own client reads BASE_INTERNAL_URL first, then BASE_URL.
  const urlName = (env[internalUrl] ?? "") !== "" ? internalUrl : baseUrl;
  const rawUrl = env[urlName] ?? "";
  if (rawUrl === "") refuse(`${internalUrl} and ${baseUrl} are not set`);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    refuse(`${urlName} is not a URL`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    refuse(`${urlName} is not an http or https address with nothing else`);
  }
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return { token, api: `${base}/api/w/${workspace}` };
}

/** One GET to the job's workspace API with its token. Resolves to the answer's text. */
async function read(
  options: Required<WindmillEnvironmentOptions>,
  route: string,
  what: string,
): Promise<string> {
  const job = jobOf(options.env, what);
  let response: Response;
  try {
    response = await options.fetch(`${job.api}/${route}`, {
      method: "GET",
      headers: { authorization: `Bearer ${job.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(WINDMILL_READ_TIMEOUT_MS),
    });
  } catch {
    throw new WindmillReadError(`Windmill did not answer the read of ${what}`);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new WindmillReadError(
      `Windmill refused the read of ${what} (status ${response.status})`,
    );
  }
  try {
    return await response.text();
  } catch {
    throw new WindmillReadError(`Windmill's answer to the read of ${what} was cut off`);
  }
}

/** A variable's value: Windmill answers `get_value` with the value as a JSON string. */
async function variable(
  options: Required<WindmillEnvironmentOptions>,
  path: string,
  what: string,
): Promise<string> {
  const body = await read(options, `variables/get_value/${path}`, what);
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new WindmillReadError(`Windmill's answer for ${what} is not a JSON string`);
  }
  if (typeof value !== "string") {
    throw new WindmillReadError(`Windmill's answer for ${what} is not a JSON string`);
  }
  return value;
}

export function windmillEnvironment(
  options: WindmillEnvironmentOptions = {},
): FlowEnvironment {
  const resolved: Required<WindmillEnvironmentOptions> = {
    env: options.env ?? process.env,
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
  };
  return {
    secret: async (path) => {
      const at = windmillVariablePath(path);
      return variable(resolved, at, `the secret variable at ${at}`);
    },
    value: async (name) => {
      const at = windmillVariablePath(name);
      return variable(resolved, at, `the plain variable at ${at}`);
    },
    executionsThisMonth: async () => {
      const what = "the workspace's execution count";
      const body = (await read(resolved, "workspaces/usage", what)).trim();
      if (!COUNT.test(body)) {
        throw new WindmillReadError(
          `Windmill's answer for ${what} is not a whole number`,
        );
      }
      return Number(body);
    },
  };
}
