import { describe, expect, it } from "vitest";

import { parseStateApiUpstream, stateApiPath } from "./state-api.ts";

describe("parseStateApiUpstream (unit: egress proxy state API setting, D-195)", () => {
  it("reads a cluster Service name or a private IPv4 address, with its port", () => {
    expect(
      parseStateApiUpstream("http://state-api.foreman-platform.svc.cluster.local:8080"),
    ).toEqual({ host: "state-api.foreman-platform.svc.cluster.local", port: 8080 });
    expect(parseStateApiUpstream("http://state-api.foreman-platform.svc")).toEqual({
      host: "state-api.foreman-platform.svc",
      port: 80,
    });
    expect(parseStateApiUpstream("http://10.245.0.17:8080/")).toEqual({
      host: "10.245.0.17",
      port: 8080,
    });
  });

  it("reads empty as the route turned off", () => {
    expect(parseStateApiUpstream("")).toBeUndefined();
  });

  const token = "state-token-not-real-0123456789";
  it.each([
    ["https", "https://state-api.foreman-platform.svc:8080"],
    ["credentials", `http://user:${token}@state-api.foreman-platform.svc:8080`],
    ["a path", "http://state-api.foreman-platform.svc:8080/v1"],
    ["a query", `http://state-api.foreman-platform.svc:8080/?t=${token}`],
    ["a fragment", "http://state-api.foreman-platform.svc:8080/#x"],
    ["a public name", "http://api.example.com:8080"],
    ["a public address", "http://140.82.112.3:8080"],
    ["the metadata address", "http://169.254.169.254"],
    ["an IPv6 address", "http://[fd00::1]:8080"],
    ["not a URL", token],
  ])("refuses %s without echoing the value", (_label, raw) => {
    let message = "";
    try {
      parseStateApiUpstream(raw);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(token);
    expect(message).not.toContain("foreman-platform");
    expect(message).not.toContain("example.com");
    expect(message).not.toContain("169.254");
  });
});

describe("stateApiPath (unit: egress proxy state API route, D-195)", () => {
  it.each([
    ["/state-api", "/"],
    ["/state-api/", "/"],
    ["/state-api/v1/runs/abc", "/v1/runs/abc"],
    ["/state-api?x=1", "/?x=1"],
    ["/state-api//other.example.com/x", "//other.example.com/x"],
  ])("routes %s to %s", (url, path) => {
    expect(stateApiPath(url)).toBe(path);
  });

  it.each([
    "/state-apix/v1",
    "/state-api@10.0.0.9/",
    "/state-api:9090/",
    "/anthropic/v1",
    "http://10.0.0.9/state-api/v1",
  ])("does not route %s", (url) => {
    expect(stateApiPath(url)).toBeUndefined();
  });
});
