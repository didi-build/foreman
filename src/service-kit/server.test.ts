import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "./logger.ts";
import { pathOnly, sendJson, startService, type RunningService } from "./server.ts";

const quietLogger = createLogger("test", () => {});
let running: RunningService | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

const url = (path: string): string => `http://127.0.0.1:${running?.port}${path}`;

describe("startService (unit: service kit, ADR 0111)", () => {
  it("answers GET /health with 200 and the service name", async () => {
    running = await startService({ name: "svc", port: 0, logger: quietLogger });
    const response = await fetch(url("/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "svc" });
  });

  it("answers 404 for unknown paths", async () => {
    running = await startService({ name: "svc", port: 0, logger: quietLogger });
    expect((await fetch(url("/nope"))).status).toBe(404);
  });

  it("passes other requests to the service's handler", async () => {
    running = await startService({
      name: "svc",
      port: 0,
      logger: quietLogger,
      handle: (request, response) => {
        if (request.url !== "/hello") return false;
        sendJson(response, 200, { hello: true });
        return true;
      },
    });
    expect(await (await fetch(url("/hello"))).json()).toEqual({ hello: true });
  });

  it("answers 500 without details when the handler throws, and logs no secrets", async () => {
    const lines: string[] = [];
    running = await startService({
      name: "svc",
      port: 0,
      logger: createLogger("svc", (line) => lines.push(line)),
      handle: () => {
        throw new Error("upstream said: token=secret-value-123456");
      },
    });
    const response = await fetch(url("/x?token=query-secret-123456"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal error" });
    const logged = lines.join("\n");
    expect(logged).toContain('"path":"/x"');
    expect(logged).toContain('"errorType":"Error"');
    expect(logged).not.toContain("secret-value-123456");
    expect(logged).not.toContain("query-secret-123456");
  });

  it("stops accepting connections after stop()", async () => {
    running = await startService({ name: "svc", port: 0, logger: quietLogger });
    const stopped = running;
    await stopped.stop();
    await expect(fetch(`http://127.0.0.1:${stopped.port}/health`)).rejects.toThrow();
  });
});

describe("pathOnly (unit: service kit, ADR 0102)", () => {
  it.each([
    ["/a/b?token=x", "/a/b"],
    ["/a#frag", "/a"],
    [undefined, "/"],
  ])("turns %j into %j", (input, expected) => {
    expect(pathOnly(input)).toBe(expected);
  });
});
