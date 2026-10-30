import { describe, expect, it } from "vitest";

import { downstreamResponseHeaders, upstreamRequestHeaders } from "./headers.ts";

const agentHeaders = {
  host: "10.0.0.5:8080",
  "content-type": "application/json",
  "content-length": "42",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "prompt-caching-2024-07-31",
  "x-api-key": "agent-placeholder-key",
  authorization: "Bearer agent-placeholder-token",
  "api-key": "agent-azure-key",
  "x-goog-api-key": "agent-google-key",
  "proxy-authorization": "Basic agent-proxy-auth",
  connection: "keep-alive, x-drop-me",
  "x-drop-me": "1",
  "keep-alive": "timeout=5",
  "transfer-encoding": "chunked",
  accept: "text/event-stream",
};

describe("upstreamRequestHeaders (unit: egress proxy credential rewrite, ADR 0106 section 5)", () => {
  it("drops the agent's credentials and sets the provider's x-api-key", () => {
    const out = upstreamRequestHeaders(agentHeaders, "x-api-key", "provider-key");
    expect(out["x-api-key"]).toBe("provider-key");
    expect(out.authorization).toBeUndefined();
    expect(out["api-key"]).toBeUndefined();
    expect(out["x-goog-api-key"]).toBeUndefined();
    expect(out["proxy-authorization"]).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("agent-");
  });

  it("drops the agent's credentials and sets a bearer token", () => {
    const out = upstreamRequestHeaders(agentHeaders, "bearer", "provider-token");
    expect(out.authorization).toBe("Bearer provider-token");
    expect(out["x-api-key"]).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("agent-");
  });

  it("drops the agent's credentials and sets none for style none", () => {
    const out = upstreamRequestHeaders(agentHeaders, "none", undefined);
    expect(out.authorization).toBeUndefined();
    expect(out["x-api-key"]).toBeUndefined();
  });

  it("keeps every other end-to-end header unchanged, and drops host and hop-by-hop ones", () => {
    const out = upstreamRequestHeaders(agentHeaders, "x-api-key", "provider-key");
    expect(out).toEqual({
      "content-type": "application/json",
      "content-length": "42",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      accept: "text/event-stream",
      "x-api-key": "provider-key",
    });
  });

  it("refuses to send a request without the provider's credential", () => {
    expect(() => upstreamRequestHeaders(agentHeaders, "bearer", undefined)).toThrow(
      /credential is missing/,
    );
  });
});

describe("downstreamResponseHeaders (unit: egress proxy response headers)", () => {
  it("passes end-to-end headers and drops hop-by-hop ones", () => {
    expect(
      downstreamResponseHeaders({
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "request-id": "req_1",
        "set-cookie": ["a=1", "b=2"],
        connection: "keep-alive",
        "transfer-encoding": "chunked",
      }),
    ).toEqual({
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "request-id": "req_1",
      "set-cookie": ["a=1", "b=2"],
    });
  });
});
