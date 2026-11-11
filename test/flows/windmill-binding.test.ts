// Seam: the Windmill binding of a flow's environment (unit, with a fake `fetch` and a fake job
// environment, D-370, D-371, O-121). It checks the exact requests (address, method, headers,
// redirects and the time limit), what each answer gives, and that every refusal is fixed text
// naming the variable or the path and never the token, a value or Windmill's answer. Nothing
// reaches a real Windmill: every token, address and value here is made up.
import { afterEach, describe, expect, it, vi } from "vitest";

import { SECRET_PATHS, VALUE_NAMES } from "../../flows/lib/environment.ts";
import {
  READ_USAGE_SCOPE,
  READ_VARIABLES_SCOPE,
  WINDMILL_READ_TIMEOUT_MS,
  windmillEnvironment,
  WindmillNotConfiguredError,
  WindmillReadError,
  windmillVariablePath,
  type WindmillFetch,
} from "../../flows/lib/windmill.ts";

/** Made up for these tests. */
const TOKEN = "fake-job-token-for-tests";
const SECRET_VALUE = "fake-secret-value-for-tests";
const JOB_ENV = {
  WM_TOKEN: TOKEN,
  WM_WORKSPACE: "rehearsal",
  BASE_INTERNAL_URL: "http://windmill-server.internal:8000",
};
const API = "http://windmill-server.internal:8000/api/w/rehearsal";

interface Asked {
  url: string;
  init: RequestInit;
}

/** A fake `fetch` that answers each request with `answer(url)` and keeps what it was asked. */
function fakeFetch(answer: (url: string) => Response | Promise<Response>) {
  const asked: Asked[] = [];
  const fetch: WindmillFetch = async (url, init) => {
    asked.push({ url, init });
    return answer(url);
  };
  return { fetch, asked };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

/** Every console method, so a test can check the binding wrote nothing. */
function watchConsole() {
  return (["log", "info", "warn", "error", "debug"] as const).map((name) =>
    vi.spyOn(console, name).mockImplementation(() => undefined),
  );
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Windmill binding's reads (unit with a fake fetch, D-370, O-121)", () => {
  it("reads a secret as the secret variable at f/foreman/<path>, with the job's token only", async () => {
    const consoleCalls = watchConsole();
    const f = fakeFetch(() => json(SECRET_VALUE));
    const env = windmillEnvironment({ env: JOB_ENV, fetch: f.fetch });
    expect(await env.secret(SECRET_PATHS.database)).toBe(SECRET_VALUE);
    expect(f.asked).toHaveLength(1);
    const [{ url, init }] = f.asked as [Asked];
    expect(url).toBe(
      `${API}/variables/get_value/f/foreman/platform/state-store/runner-database-url`,
    );
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(init.redirect).toBe("error");
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(init).sort()).toEqual([
      "headers",
      "method",
      "redirect",
      "signal",
    ]);
    for (const spy of consoleCalls) expect(spy).not.toHaveBeenCalled();
  });

  it("reads a run's model key at its project path, and every fixed secret at its path", async () => {
    const f = fakeFetch(() => json(SECRET_VALUE));
    const env = windmillEnvironment({ env: JOB_ENV, fetch: f.fetch });
    await env.secret("projects/demo/models/anthropic");
    for (const path of Object.values(SECRET_PATHS)) await env.secret(path);
    expect(f.asked.map((a) => a.url)).toEqual([
      `${API}/variables/get_value/f/foreman/projects/demo/models/anthropic`,
      ...Object.values(SECRET_PATHS).map(
        (path) => `${API}/variables/get_value/f/foreman/${path}`,
      ),
    ]);
  });

  it("reads a plain value as the plain variable at f/foreman/<name>, exactly as stored", async () => {
    const stored = '{"repoMapMaxMinutes": 5}\n';
    const f = fakeFetch(() => json(stored));
    const env = windmillEnvironment({ env: JOB_ENV, fetch: f.fetch });
    expect(await env.value(VALUE_NAMES.agentRunSettings)).toBe(stored);
    expect(f.asked.map((a) => a.url)).toEqual([
      `${API}/variables/get_value/f/foreman/agent_run_settings`,
    ]);
    expect(f.asked[0]?.init.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
  });

  it("reads Windmill's own execution count for the workspace, a number as text (D-167)", async () => {
    for (const [body, count] of [
      ["0", 0],
      ["1234", 1234],
      ["8000\n", 8000],
    ] as const) {
      const f = fakeFetch(() => new Response(body, { status: 200 }));
      const env = windmillEnvironment({ env: JOB_ENV, fetch: f.fetch });
      expect(await env.executionsThisMonth()).toBe(count);
      expect(f.asked.map((a) => [a.url, a.init.method, a.init.headers])).toEqual([
        [`${API}/workspaces/usage`, "GET", { authorization: `Bearer ${TOKEN}` }],
      ]);
      expect(f.asked[0]?.init.redirect).toBe("error");
    }
  });

  it("uses BASE_URL when BASE_INTERNAL_URL is not set, as Bun and Node jobs have it, and drops a trailing slash", async () => {
    const f = fakeFetch(() => json("v"));
    await windmillEnvironment({
      env: {
        ...JOB_ENV,
        BASE_INTERNAL_URL: undefined,
        BASE_URL: "http://127.0.0.1:8000/",
      },
      fetch: f.fetch,
    }).value(VALUE_NAMES.specVersion);
    await windmillEnvironment({
      env: { ...JOB_ENV, BASE_URL: "http://other.internal:9000" },
      fetch: f.fetch,
    }).value(VALUE_NAMES.specVersion);
    expect(f.asked.map((a) => a.url)).toEqual([
      "http://127.0.0.1:8000/api/w/rehearsal/variables/get_value/f/foreman/spec_version",
      `${API}/variables/get_value/f/foreman/spec_version`,
    ]);
  });

  it("gives each read its own time limit", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const f = fakeFetch(() => json("v"));
    await windmillEnvironment({ env: JOB_ENV, fetch: f.fetch }).value("spec_version");
    expect(timeout).toHaveBeenCalledWith(WINDMILL_READ_TIMEOUT_MS);
    expect(WINDMILL_READ_TIMEOUT_MS).toBe(10_000);
  });
});

describe("the Windmill binding's refusals (unit with a fake fetch, O-121)", () => {
  it.each([
    ["WM_TOKEN", { ...JOB_ENV, WM_TOKEN: undefined }, "WM_TOKEN is not set"],
    ["WM_TOKEN", { ...JOB_ENV, WM_TOKEN: "" }, "WM_TOKEN is not set"],
    ["WM_TOKEN", { ...JOB_ENV, WM_TOKEN: "two words" }, "WM_TOKEN is not a token"],
    ["WM_TOKEN", { ...JOB_ENV, WM_TOKEN: "line\nbreak" }, "WM_TOKEN is not a token"],
    [
      "WM_WORKSPACE",
      { ...JOB_ENV, WM_WORKSPACE: undefined },
      "WM_WORKSPACE is not set",
    ],
    [
      "WM_WORKSPACE",
      { ...JOB_ENV, WM_WORKSPACE: "a/../b" },
      "WM_WORKSPACE is not a workspace id",
    ],
    [
      "the address",
      { ...JOB_ENV, BASE_INTERNAL_URL: undefined },
      "BASE_INTERNAL_URL and BASE_URL are not set",
    ],
    [
      "the address",
      { ...JOB_ENV, BASE_INTERNAL_URL: "not a url" },
      "BASE_INTERNAL_URL is not a URL",
    ],
    [
      "the address",
      { ...JOB_ENV, BASE_INTERNAL_URL: "ftp://windmill.internal" },
      "BASE_INTERNAL_URL is not an http or https address with nothing else",
    ],
    [
      "the address",
      { ...JOB_ENV, BASE_INTERNAL_URL: "http://user:pass@windmill.internal" },
      "BASE_INTERNAL_URL is not an http or https address with nothing else",
    ],
    [
      "the address",
      { ...JOB_ENV, BASE_INTERNAL_URL: "http://windmill.internal/?a=b" },
      "BASE_INTERNAL_URL is not an http or https address with nothing else",
    ],
    [
      "the address",
      { ...JOB_ENV, BASE_INTERNAL_URL: undefined, BASE_URL: "file:///etc" },
      "BASE_URL is not an http or https address with nothing else",
    ],
  ])(
    "refuses every read without %s in shape, sending nothing (%#)",
    async (_what, jobEnv, problem) => {
      const f = fakeFetch(() => json(SECRET_VALUE));
      const env = windmillEnvironment({ env: jobEnv, fetch: f.fetch });
      const reads = [
        [
          env.secret(SECRET_PATHS.database),
          "the secret variable at f/foreman/platform/state-store/runner-database-url",
        ],
        [
          env.value(VALUE_NAMES.specVersion),
          "the plain variable at f/foreman/spec_version",
        ],
        [env.executionsThisMonth(), "the workspace's execution count"],
      ] as const;
      for (const [read, what] of reads) {
        const error = await refusal(read);
        expect(error).toBeInstanceOf(WindmillNotConfiguredError);
        expect(error.message).toBe(`${problem}, so ${what} cannot be read`);
        for (const value of Object.values(jobEnv)) {
          if (value && value.length > 3) expect(error.message).not.toContain(value);
        }
      }
      expect(f.asked).toEqual([]);
    },
  );

  it("refuses a path that is not plain lower-case segments before asking Windmill", async () => {
    const f = fakeFetch(() => json(SECRET_VALUE));
    const env = windmillEnvironment({ env: JOB_ENV, fetch: f.fetch });
    for (const path of [
      "",
      "../f/other/secret",
      "platform//token",
      "platform/./token",
      "Platform/Token",
      "/platform/token",
      "platform/token?x=1",
      "platform/token#x",
      "platform/token/",
      "platform/to ken",
      "platform/%2e%2e",
    ]) {
      const error = await refusal(env.secret(path));
      expect(error).toBeInstanceOf(WindmillReadError);
      expect(error.message).toBe(
        "A secret path or value name must be plain lower-case segments.",
      );
      await expect(env.value(path)).rejects.toThrow(WindmillReadError);
    }
    expect(f.asked).toEqual([]);
    expect(windmillVariablePath("platform/agent-cluster/runner-token")).toBe(
      "f/foreman/platform/agent-cluster/runner-token",
    );
  });

  it.each([302, 400, 401, 403, 404, 500, 503])(
    "refuses Windmill's status %i, naming the path and the status, never the answer",
    async (status) => {
      const f = fakeFetch(
        () => new Response(`Variable not found ${SECRET_VALUE} ${TOKEN}`, { status }),
      );
      const env = windmillEnvironment({ env: JOB_ENV, fetch: f.fetch });
      const secret = await refusal(env.secret(SECRET_PATHS.clusterToken));
      expect(secret).toBeInstanceOf(WindmillReadError);
      expect(secret.message).toBe(
        `Windmill refused the read of the secret variable at f/foreman/platform/agent-cluster/runner-token (status ${status})`,
      );
      const count = await refusal(env.executionsThisMonth());
      expect(count.message).toBe(
        `Windmill refused the read of the workspace's execution count (status ${status})`,
      );
      for (const error of [secret, count]) {
        expect(error.message).not.toContain(SECRET_VALUE);
        expect(error.message).not.toContain(TOKEN);
      }
    },
  );

  it("refuses when Windmill does not answer, without the error's own text", async () => {
    const f = fakeFetch(() => {
      throw new TypeError(`fetch failed for ${TOKEN}`);
    });
    const env = windmillEnvironment({ env: JOB_ENV, fetch: f.fetch });
    const error = await refusal(env.value(VALUE_NAMES.clusterEndpoint));
    expect(error).toBeInstanceOf(WindmillReadError);
    expect(error.message).toBe(
      "Windmill did not answer the read of the plain variable at f/foreman/agent_cluster_endpoint",
    );
  });

  it("refuses a variable's answer that is not a JSON string, never showing it", async () => {
    for (const body of [
      SECRET_VALUE,
      `"${SECRET_VALUE}`,
      JSON.stringify({ value: SECRET_VALUE }),
      JSON.stringify([SECRET_VALUE]),
      "null",
      "42",
      "",
    ]) {
      const f = fakeFetch(() => new Response(body, { status: 200 }));
      const env = windmillEnvironment({ env: JOB_ENV, fetch: f.fetch });
      const error = await refusal(env.secret(SECRET_PATHS.stagingDeployToken));
      expect(error).toBeInstanceOf(WindmillReadError);
      expect(error.message).toBe(
        "Windmill's answer for the secret variable at f/foreman/platform/cloudflare/staging-deploy-token is not a JSON string",
      );
    }
  });

  it("refuses an execution count that is not a whole number, never showing it", async () => {
    for (const body of [
      "",
      "-1",
      "12.5",
      "1e3",
      "abc",
      "0x10",
      `"12"`,
      "1".repeat(16),
    ]) {
      const f = fakeFetch(() => new Response(body, { status: 200 }));
      const env = windmillEnvironment({ env: JOB_ENV, fetch: f.fetch });
      const error = await refusal(env.executionsThisMonth());
      expect(error).toBeInstanceOf(WindmillReadError);
      expect(error.message).toBe(
        "Windmill's answer for the workspace's execution count is not a whole number",
      );
    }
  });

  it("refuses an answer that is cut off", async () => {
    const f = fakeFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(SECRET_VALUE));
            },
          }),
          { status: 200 },
        ),
    );
    const error = await refusal(
      windmillEnvironment({ env: JOB_ENV, fetch: f.fetch }).secret(
        SECRET_PATHS.database,
      ),
    );
    expect(error.message).toBe(
      "Windmill's answer to the read of the secret variable at f/foreman/platform/state-store/runner-database-url was cut off",
    );
  });

  it("names the scopes the deploy caps each job token to (D-371)", () => {
    expect(READ_VARIABLES_SCOPE).toBe("variables:read:f/foreman/*");
    expect(READ_USAGE_SCOPE).toBe("workspaces:read");
  });
});
