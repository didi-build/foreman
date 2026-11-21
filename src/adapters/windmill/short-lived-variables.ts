// The short-lived secret variable behind a Windmill password field (ADR 0118 appendix D, D-440,
// O-163), read and deleted from inside the Set project secret form's own job, with its own token.
//
// What Windmill does with a password field (its docs and its source on main, read 2026-11-20 for
// ADR 0118: `mintEphemeralSecret` in frontend/src/lib/components/secretArgUtils.ts and
// `transform_json_value` in backend/windmill-worker/src/common.rs): as the user types, the form
// saves the value as a secret variable at `u/<username>/secret_arg/<random>`, set to expire 7
// days later, and the job's arguments hold only `$var:<that path>`. When the job starts, the
// worker reads that variable with the job's own token and passes the value to `main`.
//
// - `find(argument)`: `GET <api>/jobs_u/get/<job id>`, the job's own record, which Windmill leaves
//   open to the job's own token whatever its scopes (`is_own_job_runtime_route` in
//   backend/windmill-api-auth/src/scopes.rs). Only `args.<argument>` is read. A string
//   `$var:u/<user>/secret_arg/<id>` gives that path. Any other string, the value as typed or a
//   reference to another variable, is `not_a_reference`. No answer, a status other than 200, or an
//   answer that is not a JSON object whose `args` holds the argument as a string is `unreadable`.
// - `remove(path)`: `DELETE <api>/variables/delete/<path>`, for a path of that shape and no other,
//   with the job's token, whose scope `variables:write:u/<user>/secret_arg/*` covers it (write
//   includes read, which the worker's own read needs). Any 2xx is removed.
//
// The token goes in the Authorization header and nowhere else. The argument's text, Windmill's
// answer and the variable's path never reach an error, a log or a result beyond `find`'s path: a
// string that is not a reference may be the value itself. Nothing here logs, and neither call
// throws. Confirmed only at the first real run (O-163): the record route and the arguments' shape
// in its answer, the random part's characters, the delete route and its status codes.

import type {
  ShortLivedVariableFind,
  ShortLivedVariableRemoval,
  ShortLivedVariables,
} from "../../core/set-project-secret.ts";

/** What the job's own calls need: its API address, its token and its id. */
export interface WindmillJobAccess {
  /** `<internal address>/api/w/<workspace>`, with no trailing slash. */
  api: string;
  /** The job's own token (`WM_TOKEN`). Never logged, returned or put in an error. */
  token: string;
  /** The job's own id (`WM_JOB_ID`), a UUID. */
  jobId: string;
}

/** The part of `fetch` the adapter uses; tests pass a fake. */
export type WindmillJobFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface WindmillShortLivedVariablesOptions {
  /** The job's access, read when a call needs it. Throws when the job's environment lacks it. */
  job: () => WindmillJobAccess;
  fetch: WindmillJobFetch;
  /** How long one call may take, answer included. */
  timeoutMs?: number;
}

/** The prefix of a variable reference in a job's arguments. */
export const VARIABLE_REFERENCE = "$var:";

/**
 * A password field's short-lived secret variable: `u/<username>/secret_arg/<random>`. The username
 * follows the rule the Windmill deploy checks (a letter, then letters, digits or underscores); the
 * username rule and the random part's characters are confirmed at the first real run.
 */
export const SECRET_ARG_PATH =
  /^u\/[A-Za-z][A-Za-z0-9_]{0,49}\/secret_arg\/[A-Za-z0-9_-]{1,128}$/;

/** How long one call may take: the Windmill binding's read limit (flows/lib/windmill.ts). */
export const SHORT_LIVED_VARIABLE_TIMEOUT_MS = 10_000;

/** The job's record is a small JSON document; a longer answer is not read. */
export const JOB_RECORD_MAX_CHARS = 1024 * 1024;

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An argument's name, as a form's `main` declares it. */
const ARGUMENT = /^[a-z][A-Za-z0-9]{0,31}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function createWindmillShortLivedVariables(
  options: WindmillShortLivedVariablesOptions,
): ShortLivedVariables {
  const timeoutMs = options.timeoutMs ?? SHORT_LIVED_VARIABLE_TIMEOUT_MS;

  /** The job's access, or null when its environment lacks it or its id is not a UUID. */
  const access = (): WindmillJobAccess | null => {
    try {
      const job = options.job();
      return JOB_ID.test(job.jobId) ? job : null;
    } catch {
      return null;
    }
  };

  const call = (url: string, method: "GET" | "DELETE", token: string) =>
    options.fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });

  return {
    async find(argument: string): Promise<ShortLivedVariableFind> {
      const job = access();
      if (job === null || !ARGUMENT.test(argument)) return { kind: "unreadable" };
      let response: Response;
      try {
        response = await call(`${job.api}/jobs_u/get/${job.jobId}`, "GET", job.token);
      } catch {
        return { kind: "unreadable" };
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "unreadable", status: response.status };
      }
      let record: unknown;
      try {
        const text = await response.text();
        if (text.length > JOB_RECORD_MAX_CHARS) return { kind: "unreadable" };
        record = JSON.parse(text) as unknown;
      } catch {
        return { kind: "unreadable" };
      }
      const args = isRecord(record) ? record.args : undefined;
      const held = isRecord(args) ? args[argument] : undefined;
      if (typeof held !== "string") return { kind: "unreadable" };
      const path = held.startsWith(VARIABLE_REFERENCE)
        ? held.slice(VARIABLE_REFERENCE.length)
        : null;
      return path !== null && SECRET_ARG_PATH.test(path)
        ? { kind: "variable", path }
        : { kind: "not_a_reference" };
    },

    async remove(path: string): Promise<ShortLivedVariableRemoval> {
      const job = access();
      if (job === null || !SECRET_ARG_PATH.test(path)) return { removed: false };
      let response: Response;
      try {
        response = await call(
          `${job.api}/variables/delete/${path}`,
          "DELETE",
          job.token,
        );
      } catch {
        return { removed: false };
      }
      // Windmill's answer is never read.
      await response.body?.cancel().catch(() => undefined);
      return response.status >= 200 && response.status < 300
        ? { removed: true }
        : { removed: false, status: response.status };
    },
  };
}
