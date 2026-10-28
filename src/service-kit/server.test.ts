import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "./logger.ts";
import { sendJson, startService, type RunningService } from "./server.ts";

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

  it("answers 500 without details when the handler throws, and logs the error", async () => {
    const lines: string[] = [];
    running = await startService({
      name: "svc",
      port: 0,
      logger: createLogger("svc", (line) => lines.push(line)),
      handle: () => {
        throw new Error("handler broke");
      },
    });
    const response = await fetch(url("/x"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal error" });
    expect(lines.join("\n")).toContain("handler broke");
  });

  it("stops accepting connections after stop()", async () => {
    running = await startService({ name: "svc", port: 0, logger: quietLogger });
    const stopped = running;
    await stopped.stop();
    await expect(fetch(`http://127.0.0.1:${stopped.port}/health`)).rejects.toThrow();
  });
});
