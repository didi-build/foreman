import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

/** A port that is free right now, so the test can pass a real PORT through the environment. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function startSample(env: Record<string, string>) {
  const child = spawn(process.execPath, ["src/sample-service/main.ts"], {
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

describe("sample service process (integration: container conventions, ADR 0111)", () => {
  // Windows has no POSIX SIGTERM, so a clean exit on SIGTERM cannot be observed there. Containers run
  // Linux, and CI runs this test on Linux.
  it.skipIf(process.platform === "win32")(
    "starts from environment config, serves /health, logs JSON and exits 0 on SIGTERM",
    async () => {
      const port = await freePort();
      const sample = startSample({ PORT: String(port) });
      await waitFor(() => sample.stdout().includes('"listening"'));

      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);

      const firstLine = sample.stdout().split("\n")[0] ?? "";
      expect(JSON.parse(firstLine)).toMatchObject({
        level: "info",
        service: "sample-service",
        message: "listening",
        port,
      });

      sample.child.kill("SIGTERM");
      expect(await sample.exited).toBe(0);
    },
  );

  it("refuses to start with an invalid setting, naming it without its value", async () => {
    const sample = startSample({ PORT: "not-a-port-value" });
    expect(await sample.exited).toBe(1);
    expect(sample.stdout()).toContain("PORT is not a port number");
    expect(sample.stdout()).not.toContain("not-a-port-value");
  });
});
