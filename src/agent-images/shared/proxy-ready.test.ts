// The wait for the run's egress proxy (O-133). Unit: a fake `fetch` and a fake clock, so no test
// waits and nothing reaches a network.
import { describe, expect, it } from "vitest";
import { fixedRunError } from "../../adapters/agent-runtime/run-failure.ts";
import {
  PROXY_NOT_READY,
  PROXY_READY_POLL_MS,
  PROXY_READY_TIMEOUT_MS,
  proxyOrigin,
  waitForProxy,
} from "./proxy-ready.ts";

const MODEL_BASE = "http://10.245.0.10:8080/anthropic";

function fakes(answers: Array<number | "refused">) {
  let clock = 0;
  const asked: string[] = [];
  const waits: number[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    asked.push(String(url));
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next === "refused") throw new TypeError("fetch failed");
    return new Response("{}", { status: next ?? 200 });
  }) as typeof fetch;
  const wait = async (ms: number) => {
    waits.push(ms);
    clock += ms;
  };
  return { deps: { fetchImpl, wait, now: () => clock }, asked, waits };
}

describe("waiting for the run's egress proxy (unit: proxy-ready.ts, O-133)", () => {
  it("asks the proxy's own /health, from the URL the image reads that points at it", async () => {
    expect(proxyOrigin(MODEL_BASE)).toBe("http://10.245.0.10:8080");
    const f = fakes([200]);
    await waitForProxy(MODEL_BASE, f.deps);
    expect(f.asked).toEqual(["http://10.245.0.10:8080/health"]);
    expect(f.waits).toEqual([]);
  });

  it("checks again while the proxy refuses or is not ready, then goes on", async () => {
    const f = fakes(["refused", "refused", 503, 200]);
    await waitForProxy(MODEL_BASE, f.deps);
    expect(f.asked).toHaveLength(4);
    expect(f.waits).toEqual([
      PROXY_READY_POLL_MS,
      PROXY_READY_POLL_MS,
      PROXY_READY_POLL_MS,
    ]);
  });

  it("gives up after its bound with the fixed sentence the run-end result keeps (D-385)", async () => {
    const f = fakes(["refused"]);
    await expect(waitForProxy(MODEL_BASE, f.deps)).rejects.toThrow(PROXY_NOT_READY);
    expect(f.waits.reduce((a, b) => a + b, 0)).toBe(PROXY_READY_TIMEOUT_MS);
    expect(fixedRunError(PROXY_NOT_READY)).toBe(PROXY_NOT_READY);
  });
});
