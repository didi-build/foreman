import { describe, expect, it } from "vitest";

import { parseProviders, routeToProvider } from "./providers.ts";

const anthropic = {
  name: "anthropic",
  upstream: "https://api.anthropic.com",
  credential: "x-api-key",
  secretPath: "projects/rehearsal/models/anthropic",
};

describe("parseProviders (unit: egress proxy provider settings, ADR 0106 section 5)", () => {
  it("parses each credential style", () => {
    const providers = parseProviders(
      JSON.stringify([
        anthropic,
        {
          name: "openai-style",
          upstream: "https://models.example.com/v1/openai",
          credential: "bearer",
          secretPath: "projects/rehearsal/models/openai-style",
        },
        { name: "local", upstream: "https://model.example.com", credential: "none" },
      ]),
    );
    expect(providers.map((p) => [p.name, p.credential, p.secretPath])).toEqual([
      ["anthropic", "x-api-key", "projects/rehearsal/models/anthropic"],
      ["openai-style", "bearer", "projects/rehearsal/models/openai-style"],
      ["local", "none", undefined],
    ]);
    expect(providers[0]?.upstream.hostname).toBe("api.anthropic.com");
  });

  it("accepts the weekly model test's own key paths, which belong to no project (D-433)", () => {
    const providers = parseProviders(
      JSON.stringify([{ ...anthropic, secretPath: "eval/models/anthropic" }]),
    );
    expect(providers[0]?.secretPath).toBe("eval/models/anthropic");
  });

  it("accepts an empty list, for a proxy that serves no model traffic (the QA fetch step)", () => {
    expect(parseProviders("[]")).toEqual([]);
  });

  const secretLooking = "sk-ant-not-a-real-key-0123456789";
  it.each([
    ["not JSON", "{", /not valid JSON/],
    ["an object", "{}", /must be a JSON array/],
    ["a non-object entry", "[1]", /entry 1 is not an object/],
    ["an unknown field", [{ ...anthropic, key: secretLooking }], /unknown field/],
    ["a bad name", [{ ...anthropic, name: "Anthropic!" }], /invalid name/],
    ["the reserved name health", [{ ...anthropic, name: "health" }], /invalid name/],
    [
      "the reserved name state-api (D-195)",
      [{ ...anthropic, name: "state-api" }],
      /invalid name/,
    ],
    [
      "the reserved name lookup (ADR 0119 slice 4a)",
      [{ ...anthropic, name: "lookup" }],
      /invalid name/,
    ],
    ["a repeated name", [anthropic, anthropic], /entry 2 repeats/],
    [
      "plain http",
      [{ ...anthropic, upstream: "http://api.anthropic.com" }],
      /upstream/,
    ],
    [
      "credentials in the URL",
      [{ ...anthropic, upstream: `https://user:${secretLooking}@api.anthropic.com` }],
      /upstream/,
    ],
    [
      "a query",
      [{ ...anthropic, upstream: `https://api.anthropic.com/?key=${secretLooking}` }],
      /upstream/,
    ],
    [
      "a fragment",
      [{ ...anthropic, upstream: "https://api.anthropic.com/#x" }],
      /upstream/,
    ],
    ["not a URL", [{ ...anthropic, upstream: secretLooking }], /upstream/],
    ["an unknown style", [{ ...anthropic, credential: "cookie" }], /credential style/],
    ["no secret path", [{ ...anthropic, secretPath: undefined }], /secret path/],
    [
      "a secret value as path",
      [{ ...anthropic, secretPath: secretLooking }],
      /secret path/,
    ],
    [
      "a path outside the store",
      [{ ...anthropic, secretPath: "../etc/x" }],
      /secret path/,
    ],
    [
      "a path in no area of the store",
      [{ ...anthropic, secretPath: "evaluation/models/anthropic" }],
      /secret path/,
    ],
    [
      "a secret path with style none",
      [{ ...anthropic, credential: "none" }],
      /secret path but credential style none/,
    ],
  ])("refuses %s, naming the problem but never a value", (_label, input, pattern) => {
    const raw = typeof input === "string" ? input : JSON.stringify(input);
    let message = "";
    try {
      parseProviders(raw);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(pattern);
    expect(message).not.toContain(secretLooking);
    expect(message).not.toContain("api.anthropic.com");
  });
});

describe("routeToProvider (unit: egress proxy model routes)", () => {
  const providers = parseProviders(
    JSON.stringify([
      anthropic,
      {
        name: "based",
        upstream: "https://models.example.com/v1/openai/",
        credential: "none",
      },
    ]),
  );

  it.each([
    ["/anthropic/v1/messages", "anthropic", "/v1/messages"],
    ["/anthropic/v1/messages?beta=true", "anthropic", "/v1/messages?beta=true"],
    ["/anthropic", "anthropic", "/"],
    ["/anthropic?x=1", "anthropic", "/?x=1"],
    ["/based/chat/completions", "based", "/v1/openai/chat/completions"],
    ["/based", "based", "/v1/openai"],
  ])("routes %s to %s at %s", (url, name, path) => {
    const route = routeToProvider(url, providers);
    expect(route?.provider.name).toBe(name);
    expect(route?.upstreamPath).toBe(path);
  });

  it("routes the Messages API image's DeepInfra entry to DeepInfra's Anthropic endpoint with its x-api-key style (O-152)", () => {
    const [deepinfra] = parseProviders(
      JSON.stringify([
        {
          name: "deepinfra",
          upstream: "https://api.deepinfra.com/anthropic",
          credential: "x-api-key",
          secretPath: "projects/rehearsal/models/deepinfra",
        },
      ]),
    );
    const route = routeToProvider(
      "/deepinfra/v1/messages",
      deepinfra ? [deepinfra] : [],
    );
    expect(route?.provider.credential).toBe("x-api-key");
    expect(route?.provider.secretPath).toBe("projects/rehearsal/models/deepinfra");
    expect(new URL(route?.upstreamPath ?? "", route?.provider.upstream).href).toBe(
      "https://api.deepinfra.com/anthropic/v1/messages",
    );
  });

  it.each([
    "/anthropicx/v1",
    "/",
    "/health",
    "/other/v1",
    "http://anthropic/v1",
    "anthropic/v1",
  ])("does not route %s", (url) => {
    expect(routeToProvider(url, providers)).toBeUndefined();
  });
});
