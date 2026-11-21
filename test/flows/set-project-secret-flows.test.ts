// Seam: the called flow `f/foreman/set_project_secret` (flow, ADR 0118 appendix D, D-440, O-163)
// on the memory store, through the flow layer's deps (`flowDepsFor`) with the fake deploy target
// and the fake short-lived variable; then with the real Cloudflare target behind a fake HTTP port
// and the real Windmill binding behind a fake `fetch` and job environment, so the exact secret put
// and the job's own record and delete are seen; and with the composition's credential port, which
// refuses until Didi creates the staging deploy token, so nothing is sent. The rules themselves
// are in test/set-project-secret.test.ts. The value is made up and is checked to be in no result,
// record or log, and to reach only the one put. Nothing reaches Cloudflare or Windmill.
import { afterEach, describe, expect, it, vi } from "vitest";

import { run as setProjectSecret } from "../../flows/set-project-secret.ts";
import {
  unbuiltStagingDeployCredentials,
  windmillD1Credentials,
} from "../../flows/lib/compose.ts";
import { windmillShortLivedVariables } from "../../flows/lib/windmill.ts";
import {
  createCloudflareStagingTarget,
  type CloudflareAnswer,
  type CloudflareRequest,
} from "../../src/adapters/deploy/cloudflare-staging.ts";
import { FAKE_SECRET_ARG_PATH } from "../../src/adapters/windmill/fake-short-lived-variables.ts";
import { createFlowFixture } from "./flow-fixture.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const JOB_ID = "0192f0a0-1234-4abc-8def-0123456789ab";
/** Obviously fake: never a real key. */
const VALUE = "test-only-secret-value-do-not-use-0123456789";
const INPUT = {
  project: "rehearsal",
  name: "MODEL_API_KEY",
  value: VALUE,
  runId: JOB_ID,
};

/** The D1 token's port with nothing stored: the secret form never reads it. */
const noD1Credentials = windmillD1Credentials({
  secret: async (path) => {
    throw new Error(`the form read ${path}`);
  },
});

/** A fake Cloudflare that keeps every request and accepts each secret put. */
function fakeCloudflare() {
  const sent: CloudflareRequest[] = [];
  return {
    sent,
    http: {
      async send(request: CloudflareRequest): Promise<CloudflareAnswer> {
        sent.push(structuredClone(request));
        // Cloudflare's answer may echo the value; the target reads only `success`.
        return { status: 200, body: { success: true, result: request.json } };
      },
    },
  };
}

function watchConsole() {
  return (["log", "info", "warn", "error", "debug"] as const).map((name) =>
    vi.spyOn(console, name).mockImplementation(() => undefined),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Didi's Set project secret flow (flow, ADR 0118 appendix D, O-163)", () => {
  it("deletes the short-lived variable, puts the secret on the staging Worker and records its name, answering with no value", async () => {
    const consoleCalls = watchConsole();
    const f = await createFlowFixture();
    await f.live();
    const result = await setProjectSecret(f.deps, INPUT);
    expect(result).toMatchObject({
      outcome: "set",
      project: "rehearsal",
      name: "MODEL_API_KEY",
      shortLivedVariable: { step: "deleted" },
    });
    expect(f.shortLivedVariables.calls).toEqual([
      "find value",
      `remove ${FAKE_SECRET_ARG_PATH}`,
    ]);
    expect([...(f.stagingTarget.secretNames.get("rehearsal") ?? [])]).toEqual([
      "MODEL_API_KEY",
    ]);
    const records = await f.store.listProjectSecretNames(f.projectId);
    expect(records).toMatchObject([
      {
        name: "MODEL_API_KEY",
        windmillRunId: JOB_ID,
        recordedBy: "runner:set-project-secret",
      },
    ]);
    expect(JSON.stringify([result, records])).not.toContain(VALUE);
    for (const spy of consoleCalls) expect(spy).not.toHaveBeenCalled();
  });

  it("sets nothing under the kill switch, and in dry run deletes the variable and sets nothing", async () => {
    const killed = await createFlowFixture();
    await killed.live();
    await killed.killed();
    expect(await setProjectSecret(killed.deps, INPUT)).toMatchObject({
      outcome: "refused",
      reason: "kill_switch",
      shortLivedVariable: { step: "not_reached" },
    });
    expect(killed.shortLivedVariables.calls).toEqual([]);
    // The fixture starts in dry run.
    const dry = await createFlowFixture();
    expect(await setProjectSecret(dry.deps, INPUT)).toMatchObject({
      outcome: "dry_run",
      shortLivedVariable: { step: "deleted" },
    });
    expect(dry.shortLivedVariables.calls).toEqual([
      "find value",
      `remove ${FAKE_SECRET_ARG_PATH}`,
    ]);
    for (const f of [killed, dry]) {
      expect(f.stagingTarget.secretNames.size).toBe(0);
      expect(await f.store.listProjectSecretNames(f.projectId)).toEqual([]);
    }
  });

  it("with the real Cloudflare target and Windmill binding, sends exactly the put, the job's own read and the delete, the value only in the put", async () => {
    const f = await createFlowFixture();
    await f.live();
    const cloudflare = fakeCloudflare();
    const windmill: { url: string; method: string; authorization: string }[] = [];
    const deps = {
      ...f.deps,
      stagingTarget: createCloudflareStagingTarget({
        credentials: {
          read: async () => ({
            accountId: ACCOUNT,
            token: "fake-token-for-tests-0123456789",
          }),
        },
        d1Credentials: noD1Credentials,
        http: cloudflare.http,
      }),
      shortLivedVariables: windmillShortLivedVariables({
        env: {
          WM_TOKEN: "fake-job-token-for-tests",
          WM_WORKSPACE: "rehearsal",
          WM_JOB_ID: JOB_ID,
          BASE_INTERNAL_URL: "http://windmill-server.internal:8000",
        },
        fetch: async (url, init) => {
          windmill.push({
            url,
            method: String(init.method),
            authorization: (init.headers as Record<string, string>).authorization ?? "",
          });
          return url.includes("/jobs_u/get/")
            ? new Response(
                JSON.stringify({
                  args: { ...INPUT, value: `$var:${FAKE_SECRET_ARG_PATH}` },
                }),
                { status: 200 },
              )
            : new Response("deleted", { status: 200 });
        },
      }),
    };
    const result = await setProjectSecret(deps, INPUT);
    expect(result).toMatchObject({
      outcome: "set",
      shortLivedVariable: { step: "deleted" },
    });
    const api = "http://windmill-server.internal:8000/api/w/rehearsal";
    expect(windmill).toEqual([
      {
        url: `${api}/jobs_u/get/${JOB_ID}`,
        method: "GET",
        authorization: "Bearer fake-job-token-for-tests",
      },
      {
        url: `${api}/variables/delete/${FAKE_SECRET_ARG_PATH}`,
        method: "DELETE",
        authorization: "Bearer fake-job-token-for-tests",
      },
    ]);
    expect(cloudflare.sent).toEqual([
      {
        method: "PUT",
        path: `/accounts/${ACCOUNT}/workers/scripts/rehearsal-staging/secrets`,
        bearer: "fake-token-for-tests-0123456789",
        json: { name: "MODEL_API_KEY", text: VALUE, type: "secret_text" },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(VALUE);
    expect(JSON.stringify(windmill)).not.toContain(VALUE);
  });

  it("with the composition's credential port, refuses the put with the target's reason, sends nothing and records nothing, and still deletes the variable", async () => {
    const f = await createFlowFixture();
    await f.live();
    const cloudflare = fakeCloudflare();
    const deps = {
      ...f.deps,
      stagingTarget: createCloudflareStagingTarget({
        credentials: unbuiltStagingDeployCredentials(),
        d1Credentials: noD1Credentials,
        http: cloudflare.http,
      }),
    };
    const result = await setProjectSecret(deps, INPUT);
    expect(result).toMatchObject({
      outcome: "refused",
      reason: "put_refused",
      target: {
        reason: "credential_unavailable",
        text: "the staging deploy credential is not available",
      },
      shortLivedVariable: { step: "deleted" },
    });
    expect(cloudflare.sent).toEqual([]);
    expect(await f.store.listProjectSecretNames(f.projectId)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(VALUE);
  });
});
