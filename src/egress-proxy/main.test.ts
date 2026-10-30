import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

import { secretEnvName } from "../service-kit/config.ts";

// Integration: the service process with config only from the environment (ADR 0111). It makes no
// outside connection: nothing here asks for a tunnel or a model request.

const SECRET_PATH = "projects/test/models/anthropic";
const KEY_VALUE = "process-test-key-value-123456";

const baseEnv = {
  RUN_ID: "run_process_test",
  ALLOWED_HOSTS: "github.com",
  MODEL_PROVIDERS: JSON.stringify([
    {
      name: "anthropic",
      upstream: "https://api.anthropic.com",
      credential: "x-api-key",
      secretPath: SECRET_PATH,
    },
  ]),
  MAX_MODEL_REQUESTS: "200",
  [secretEnvName(SECRET_PATH)]: KEY_VALUE,
};

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function startProxy(env: Record<string, string>) {
  const child = spawn(process.execPath, ["src/egress-proxy/main.ts"], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  return { child, exited, stdout: () => stdout };
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("egress proxy process (integration: container conventions, ADR 0111)", () => {
  it.skipIf(process.platform === "win32")(
    "starts from environment config, serves /health, logs JSON without secrets and exits 0 on SIGTERM",
    async () => {
      const port = await freePort();
      const proxy = startProxy({ ...baseEnv, PORT: String(port) });
      await waitFor(() => proxy.stdout().includes('"listening"'));

      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
      const firstLine = proxy.stdout().split("\n")[0] ?? "";
      expect(JSON.parse(firstLine)).toMatchObject({
        service: "egress-proxy",
        message: "listening",
        runId: "run_process_test",
        allowedHosts: ["github.com"],
        providers: ["anthropic"],
      });

      proxy.child.kill("SIGTERM");
      expect(await proxy.exited).toBe(0);
      expect(proxy.stdout()).not.toContain(KEY_VALUE);
    },
  );

  it("refuses to start without a provider's credential, naming the setting only", async () => {
    const env: Record<string, string> = { ...baseEnv };
    delete env[secretEnvName(SECRET_PATH)];
    const proxy = startProxy(env);
    expect(await proxy.exited).toBe(1);
    expect(proxy.stdout()).toContain(`${secretEnvName(SECRET_PATH)} is not set`);
  });

  it("refuses to start with a bad allow-list, naming the setting without its value", async () => {
    const proxy = startProxy({ ...baseEnv, ALLOWED_HOSTS: "169.254.169.254" });
    expect(await proxy.exited).toBe(1);
    expect(proxy.stdout()).toContain("ALLOWED_HOSTS entry 1 is not a plain host name");
    expect(proxy.stdout()).not.toContain("169.254.169.254");
  });
});
