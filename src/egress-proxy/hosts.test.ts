import { describe, expect, it } from "vitest";

import { canonicalHost, checkConnectTarget, parseAllowedHosts } from "./hosts.ts";

const allowed = parseAllowedHosts("github.com, api.github.com,registry.npmjs.org");

describe("allow-list matching (unit: egress proxy host check, ADR 0106 section 2)", () => {
  it("allows an exact host on port 443", () => {
    expect(checkConnectTarget("github.com:443", allowed)).toEqual({
      ok: true,
      host: "github.com",
    });
    expect(checkConnectTarget("api.github.com:443", allowed)).toMatchObject({
      ok: true,
    });
  });

  it("treats case and one trailing dot as the same name, and nothing more", () => {
    expect(checkConnectTarget("GitHub.COM:443", allowed)).toEqual({
      ok: true,
      host: "github.com",
    });
    expect(checkConnectTarget("github.com.:443", allowed)).toEqual({
      ok: true,
      host: "github.com",
    });
    expect(checkConnectTarget("github.com..:443", allowed)).toMatchObject({
      ok: false,
    });
  });

  it.each([
    ["github.com.evil.com:443", "host not allowed"],
    ["evilgithub.com:443", "host not allowed"],
    ["evil.github.com:443", "host not allowed"],
    ["gist.github.com:443", "host not allowed"],
    ["github.co:443", "host not allowed"],
    ["github.com:80", "port not allowed"],
    ["github.com:8443", "port not allowed"],
    ["github.com:0443", "port not allowed"],
    ["github.com", "port not allowed"],
    ["github.com:", "port not allowed"],
    ["140.82.112.3:443", "ip address target"],
    ["[::1]:443", "ip address target"],
    ["[2606:4700::1]:443", "ip address target"],
    ["github.com%00.evil.com:443", "invalid host name"],
    ["github.com/x:443", "invalid host name"],
    ["user@github.com:443", "invalid host name"],
    ["*.github.com:443", "invalid host name"],
    ["localhost:443", "invalid host name"],
    [":443", "invalid host name"],
  ])("refuses %s (%s)", (target, reason) => {
    expect(checkConnectTarget(target, allowed)).toMatchObject({ ok: false, reason });
  });

  it("refuses a missing target", () => {
    expect(checkConnectTarget(undefined, allowed)).toMatchObject({ ok: false });
  });
});

describe("parseAllowedHosts (unit: egress proxy settings)", () => {
  it("stores canonical names", () => {
    expect([...parseAllowedHosts("API.GitHub.com., github.com")]).toEqual([
      "api.github.com",
      "github.com",
    ]);
  });

  it.each([
    "10.0.0.1",
    "github.com:443",
    "*.github.com",
    "https://github.com",
    "github",
    "",
  ])("refuses %j without echoing it", (entry) => {
    const run = () => parseAllowedHosts(`github.com,${entry}`);
    expect(run).toThrow(/entry 2 is not a plain host name/);
    if (entry !== "") {
      try {
        run();
      } catch (error) {
        expect((error as Error).message).not.toContain(entry);
      }
    }
  });

  it("reads an empty list as no CONNECT host at all (QA, Council and Triage)", () => {
    expect(parseAllowedHosts("").size).toBe(0);
    expect(parseAllowedHosts("  ").size).toBe(0);
    expect(checkConnectTarget("github.com:443", parseAllowedHosts(""))).toMatchObject({
      ok: false,
      reason: "host not allowed",
    });
  });

  it("canonicalHost refuses names that look like IPv4 addresses", () => {
    expect(canonicalHost("1.2.3.4")).toBeUndefined();
    expect(canonicalHost("example.123")).toBeUndefined();
  });
});
