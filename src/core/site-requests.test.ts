import { describe, expect, it } from "vitest";

import {
  MAX_SITE_REASON,
  canonicalHostName,
  checkSiteRequests,
  isCanonicalHost,
  withinSiteRequestBounds,
} from "./site-requests.ts";

// Unit: the check of the documentation sites a run asks to add (ADR 0119 slice 4, D-460), shared
// by the OpenCode image and the runner, and the host name rule the task file's docs lookup hosts
// use.

const ask = (
  host: unknown,
  reason: unknown = "The Vitest docs explain the mock API.",
) => ({
  host,
  reason,
});
const problem = (value: unknown) =>
  (checkSiteRequests(value) as { problem?: string }).problem;

describe("the host name rule (unit)", () => {
  it.each([
    ["vitest.dev", "vitest.dev"],
    ["Docs.GitHub.com", "docs.github.com"],
    ["www.postgresql.org.", "www.postgresql.org"],
    ["xn--bcher-kva.de", "xn--bcher-kva.de"],
    ["a-b.c-d.example", "a-b.c-d.example"],
  ])("takes %s as %s", (name, canonical) => {
    expect(canonicalHostName(name)).toBe(canonical);
  });

  it.each([
    "",
    "localhost",
    "10.0.0.1",
    "[::1]",
    "::1",
    "vitest.dev:443",
    "https://vitest.dev",
    "vitest.dev/guide",
    "*.vitest.dev",
    "-bad.example",
    "bad-.example",
    "under_score.example",
    "a..b",
    "example.123",
    `${"a".repeat(64)}.example`,
    `${"a.".repeat(127)}example`,
    "vitest.dev ",
  ])("refuses %j", (name) => {
    expect(canonicalHostName(name)).toBeUndefined();
  });

  it("calls a host canonical only in its canonical form", () => {
    expect(isCanonicalHost("vitest.dev")).toBe(true);
    expect(isCanonicalHost("Vitest.dev")).toBe(false);
    expect(isCanonicalHost("vitest.dev.")).toBe(false);
    expect(isCanonicalHost(3)).toBe(false);
  });
});

describe("the site requests (unit: at most 3, each host and reason)", () => {
  it("reads none when the field is left out, and an empty list", () => {
    expect(checkSiteRequests(undefined)).toEqual({ siteRequests: [] });
    expect(checkSiteRequests([])).toEqual({ siteRequests: [] });
  });

  it("reads three, each host canonical and each reason trimmed", () => {
    expect(
      checkSiteRequests([
        ask("Vitest.dev.", "  Mocks are documented there.  "),
        ask("docs.github.com"),
        ask("www.typescriptlang.org", "x"),
      ]),
    ).toEqual({
      siteRequests: [
        { host: "vitest.dev", reason: "Mocks are documented there." },
        { host: "docs.github.com", reason: "The Vitest docs explain the mock API." },
        { host: "www.typescriptlang.org", reason: "x" },
      ],
    });
  });

  it("refuses a fourth request and anything that is not a list", () => {
    const four = ["a.dev", "b.dev", "c.dev", "d.dev"].map((host) => ask(host));
    expect(problem(four)).toBe("siteRequests must be a list of at most 3 items");
    expect(problem(ask("a.dev"))).toBe(
      "siteRequests must be a list of at most 3 items",
    );
    expect(problem("a.dev")).toBe("siteRequests must be a list of at most 3 items");
  });

  it.each([
    ["no reason", [{ host: "a.dev" }]],
    ["an extra field", [{ ...ask("a.dev"), url: "https://a.dev/x" }]],
    ["a host that is not text", [ask(3)]],
    ["a reason that is not text", [ask("a.dev", ["why"])]],
    ["not an object", ["a.dev"]],
    ["null", [null]],
  ])("refuses a request with %s", (_case, value) => {
    expect(problem(value)).toBe("each of siteRequests must have host and reason only");
  });

  it.each([
    "https://vitest.dev/guide/",
    "vitest.dev:443",
    "10.0.0.1",
    "*.vitest.dev",
    "localhost",
    "",
  ])("refuses the host %j, never repeating it", (host) => {
    const text = problem([ask(host)]);
    expect(text).toBe(
      "a site request's host must be a plain host name, with no scheme, path, port, IP address or wildcard",
    );
    if (host !== "") expect(text).not.toContain(host);
  });

  it("holds each reason to one line of 1 to 300 characters after trimming", () => {
    const rule = `a site request's reason must be one line of 1 to ${MAX_SITE_REASON} characters`;
    expect(checkSiteRequests([ask("a.dev", "r".repeat(300))])).toHaveProperty(
      "siteRequests",
    );
    expect(checkSiteRequests([ask("a.dev", ` ${"r".repeat(300)} `)])).toHaveProperty(
      "siteRequests",
    );
    expect(problem([ask("a.dev", "r".repeat(301))])).toBe(rule);
    expect(problem([ask("a.dev", "   ")])).toBe(rule);
    expect(problem([ask("a.dev", "one\ntwo")])).toBe(rule);
    expect(problem([ask("a.dev", "one\rtwo")])).toBe(rule);
  });

  it("cuts a reason back to its bound after a longer replacement", () => {
    expect(
      withinSiteRequestBounds({
        host: "a.dev",
        reason: `${"r".repeat(299)} [redacted]`,
      }),
    ).toEqual({ host: "a.dev", reason: "r".repeat(299) });
    expect(
      checkSiteRequests([withinSiteRequestBounds({ host: "a.dev", reason: "ok" })]),
    ).toEqual({
      siteRequests: [{ host: "a.dev", reason: "ok" }],
    });
  });
});
