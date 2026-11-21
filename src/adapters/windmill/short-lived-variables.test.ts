// Seam: the Windmill adapter for the Set project secret form's short-lived secret variable (unit
// with a fake `fetch`, ADR 0118 appendix D, O-163). The exact requests (the job's own record by
// its id, and the delete of exactly the path found), what each answer gives, and that neither the
// token, the argument's text nor Windmill's answer reaches a result, an error or a log. Every
// token, address, path and value here is made up; nothing reaches Windmill.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWindmillShortLivedVariables,
  SECRET_ARG_PATH,
  SHORT_LIVED_VARIABLE_TIMEOUT_MS,
  type WindmillJobAccess,
} from "./short-lived-variables.ts";

const JOB: WindmillJobAccess = {
  api: "http://windmill-server.internal:8000/api/w/rehearsal",
  token: "fake-job-token-for-tests",
  jobId: "0192f0a0-1234-4abc-8def-0123456789ab",
};
const PATH = "u/test_only_user/secret_arg/TestOnly0123456789";
/** Obviously fake: what a box would hold if the password field did not work. */
const TYPED_VALUE = "test-only-typed-value-do-not-use";

interface Asked {
  url: string;
  init: RequestInit;
}

function fakeFetch(
  answer: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const asked: Asked[] = [];
  return {
    asked,
    fetch: async (url: string, init: RequestInit) => {
      asked.push({ url, init });
      return answer(url, init);
    },
  };
}

const record = (args: unknown, status = 200) =>
  new Response(JSON.stringify({ id: JOB.jobId, type: "QueuedJob", args }), { status });

function adapter(
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  job: () => WindmillJobAccess = () => JOB,
) {
  return createWindmillShortLivedVariables({ job, fetch });
}

function watchConsole() {
  return (["log", "info", "warn", "error", "debug"] as const).map((name) =>
    vi.spyOn(console, name).mockImplementation(() => undefined),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the short-lived variable's path, from the job's own record (unit, fake fetch, O-163)", () => {
  it("reads the job's own record with its token only, and gives the path of a password field's reference", async () => {
    const consoleCalls = watchConsole();
    const f = fakeFetch(() =>
      record({ project: "garden-notes", name: "MODEL_API_KEY", value: `$var:${PATH}` }),
    );
    expect(await adapter(f.fetch).find("value")).toEqual({
      kind: "variable",
      path: PATH,
    });
    expect(f.asked).toHaveLength(1);
    const [{ url, init }] = f.asked as [Asked];
    expect(url).toBe(`${JOB.api}/jobs_u/get/${JOB.jobId}`);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ authorization: `Bearer ${JOB.token}` });
    expect(init.redirect).toBe("error");
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(init).sort()).toEqual([
      "headers",
      "method",
      "redirect",
      "signal",
    ]);
    expect(SHORT_LIVED_VARIABLE_TIMEOUT_MS).toBe(10_000);
    for (const spy of consoleCalls) expect(spy).not.toHaveBeenCalled();
  });

  it("reads anything but a password field's reference as no reference, and never gives its text back", async () => {
    for (const held of [
      TYPED_VALUE,
      `$var:f/foreman/platform/cloudflare/d1-token`,
      `$var:u/test_only_user/other/${"x".repeat(8)}`,
      `$var:u/test_only_user/secret_arg/`,
      `$var:u/test_only_user/secret_arg/a/b`,
      `$var:u/1user/secret_arg/abc`,
      `$res:u/test_only_user/secret_arg/abc`,
      ` $var:${PATH}`,
      `$var:${PATH}\n`,
      "",
    ]) {
      const f = fakeFetch(() => record({ value: held }));
      const found = await adapter(f.fetch).find("value");
      expect(found, held).toEqual({ kind: "not_a_reference" });
      expect(JSON.stringify(found)).not.toContain(TYPED_VALUE);
    }
  });

  it("is unreadable on no answer, a status but 200, or an answer without the argument as a string, naming only the status", async () => {
    const cases: [() => Response | Promise<Response>, object][] = [
      [
        () => Promise.reject(new Error(`no route to ${JOB.token}`)),
        { kind: "unreadable" },
      ],
      [
        () => new Response(`{"error": "${TYPED_VALUE}"}`, { status: 403 }),
        { kind: "unreadable", status: 403 },
      ],
      [() => new Response("", { status: 404 }), { kind: "unreadable", status: 404 }],
      [() => new Response("not json", { status: 200 }), { kind: "unreadable" }],
      [() => new Response("[]", { status: 200 }), { kind: "unreadable" }],
      [() => record(null), { kind: "unreadable" }],
      [() => record({ project: "garden-notes" }), { kind: "unreadable" }],
      [() => record({ value: 7 }), { kind: "unreadable" }],
      [
        () => new Response(`{"args": {"value": "${"x".repeat(1024 * 1024)}"}}`),
        { kind: "unreadable" },
      ],
    ];
    for (const [answer, found] of cases) {
      const f = fakeFetch(answer);
      const result = await adapter(f.fetch).find("value");
      expect(result).toEqual(found);
      expect(JSON.stringify(result)).not.toMatch(
        new RegExp(`${TYPED_VALUE}|${JOB.token}`),
      );
    }
  });

  it("asks nothing outside a job, without a job id, or for an argument that is not a plain name", async () => {
    const f = fakeFetch(() => record({ value: `$var:${PATH}` }));
    const unconfigured = () => {
      throw new Error("WM_TOKEN is not set");
    };
    expect(await adapter(f.fetch, unconfigured).find("value")).toEqual({
      kind: "unreadable",
    });
    expect(
      await adapter(f.fetch, () => ({ ...JOB, jobId: "../../variables" })).find(
        "value",
      ),
    ).toEqual({ kind: "unreadable" });
    expect(await adapter(f.fetch).find("../args")).toEqual({ kind: "unreadable" });
    expect(f.asked).toEqual([]);
  });
});

describe("the short-lived variable's deletion (unit, fake fetch, O-163)", () => {
  it("deletes exactly the path found, with the job's token only, and reads no answer", async () => {
    const f = fakeFetch(
      () => new Response(`deleted variable ${PATH}`, { status: 200 }),
    );
    expect(await adapter(f.fetch).remove(PATH)).toEqual({ removed: true });
    const [{ url, init }] = f.asked as [Asked];
    expect(url).toBe(`${JOB.api}/variables/delete/${PATH}`);
    expect(init.method).toBe("DELETE");
    expect(init.headers).toEqual({ authorization: `Bearer ${JOB.token}` });
    expect(init.redirect).toBe("error");
    expect(init.body).toBeUndefined();
  });

  it("answers not removed, with the status when there was one, for any other answer or none", async () => {
    for (const [answer, removal] of [
      [() => new Response(null, { status: 204 }), { removed: true }],
      [
        () => new Response("forbidden", { status: 403 }),
        { removed: false, status: 403 },
      ],
      [
        () => new Response("not found", { status: 404 }),
        { removed: false, status: 404 },
      ],
      [() => new Response("", { status: 500 }), { removed: false, status: 500 }],
      [() => Promise.reject(new Error("no answer")), { removed: false }],
    ] as const) {
      const f = fakeFetch(answer);
      expect(await adapter(f.fetch).remove(PATH)).toEqual(removal);
    }
  });

  it("deletes nothing but a password field's variable, and nothing outside a job", async () => {
    const f = fakeFetch(() => new Response("", { status: 200 }));
    for (const path of [
      "f/foreman/platform/cloudflare/d1-token",
      "u/test_only_user/secret_arg/*",
      "u/test_only_user/secret_arg/../../f/foreman/x",
      "u/test_only_user/other/abc",
      `${PATH}?x=1`,
    ]) {
      expect(await adapter(f.fetch).remove(path), path).toEqual({ removed: false });
    }
    expect(
      await adapter(f.fetch, () => {
        throw new Error("not in a job");
      }).remove(PATH),
    ).toEqual({ removed: false });
    expect(f.asked).toEqual([]);
    expect(SECRET_ARG_PATH.test(PATH)).toBe(true);
  });
});
