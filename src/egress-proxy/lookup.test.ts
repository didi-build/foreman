import { describe, expect, it } from "vitest";

import { parseAllowedHosts } from "./hosts.ts";
import {
  hasRequestBody,
  LOOKUP_BODY_LIMIT,
  LOOKUP_USER_AGENT,
  lookupRequestHeaders,
  lookupResponseHeaders,
  lookupTarget,
  MAX_LOOKUP_PATH_LENGTH,
} from "./lookup.ts";

// Unit: the documentation lookup route's pure parts (ADR 0119 slice 4a, D-460, D-472).

const HOSTS = parseAllowedHosts("docs.example.com,vitest.dev");

describe("lookupTarget (unit: the lookup route's host and path, ADR 0119 slice 4a)", () => {
  it.each([
    ["/lookup/docs.example.com/guide/intro", "docs.example.com", "/guide/intro"],
    ["/lookup/docs.example.com", "docs.example.com", "/"],
    ["/lookup/docs.example.com/", "docs.example.com", "/"],
    ["/lookup/docs.example.com?q=csv", "docs.example.com", "/?q=csv"],
    [
      "/lookup/vitest.dev/api/expect?q=CSV%20export&x=1&x=%E2%9C%93",
      "vitest.dev",
      "/api/expect?q=CSV%20export&x=1&x=%E2%9C%93",
    ],
    // Case and one trailing dot name the same host, as for CONNECT.
    ["/lookup/Docs.Example.COM./guide", "docs.example.com", "/guide"],
    // Encoded and dotted paths pass on unchanged: they stay on the listed host.
    [
      "/lookup/docs.example.com/a%2F..%2Fb/../c",
      "docs.example.com",
      "/a%2F..%2Fb/../c",
    ],
    [
      "/lookup/docs.example.com//other.example.com/x",
      "docs.example.com",
      "//other.example.com/x",
    ],
    [
      "/lookup/docs.example.com/a@other.example.com:443/",
      "docs.example.com",
      "/a@other.example.com:443/",
    ],
  ])("reads %s as %s with path %s", (url, host, path) => {
    expect(lookupTarget(url, HOSTS)).toEqual({ ok: true, host, path });
  });

  it.each([
    undefined,
    "/lookupx/docs.example.com/",
    "/lookup-docs/docs.example.com/",
    "/anthropic/v1/messages",
    "/state-api/lookup/docs.example.com/",
    "http://docs.example.com/lookup/docs.example.com/",
  ])("does not route %s", (url) => {
    expect(lookupTarget(url, HOSTS)).toBeUndefined();
  });

  it.each([
    ["no host", "/lookup"],
    ["an empty host", "/lookup/"],
    ["a query and no host", "/lookup?docs.example.com"],
    ["an empty first segment", "/lookup//docs.example.com/guide"],
    ["a port", "/lookup/docs.example.com:443/guide"],
    ["user info", "/lookup/user@docs.example.com/guide"],
    ["an IPv4 literal", "/lookup/140.82.112.3/guide"],
    ["an IPv6 literal", "/lookup/[2606:4700::1]/guide"],
    ["a wildcard", "/lookup/*.example.com/guide"],
    ["an encoded dot", "/lookup/docs%2eexample.com/guide"],
    ["one label", "/lookup/localhost/guide"],
  ])("refuses %s as an invalid host, naming no host", (_label, url) => {
    expect(lookupTarget(url, HOSTS)).toEqual({
      ok: false,
      reason: "invalid host name",
    });
  });

  it.each([
    [
      "a suffix trick",
      "/lookup/docs.example.com.evil.com/x",
      "docs.example.com.evil.com",
    ],
    ["the listed host's parent", "/lookup/example.com/x", "example.com"],
    [
      "a subdomain of a listed host",
      "/lookup/api.docs.example.com/x",
      "api.docs.example.com",
    ],
    ["a host off the list", "/lookup/Other.Example.org/x", "other.example.org"],
  ])("refuses %s as not listed, naming its canonical host", (_label, url, host) => {
    expect(lookupTarget(url, HOSTS)).toEqual({
      ok: false,
      reason: "host not listed",
      host,
    });
  });

  it("refuses every host when the list is empty", () => {
    expect(lookupTarget("/lookup/docs.example.com/x", new Set())).toEqual({
      ok: false,
      reason: "host not listed",
      host: "docs.example.com",
    });
  });

  it("takes a path and query of at most 2,000 characters (D-472)", () => {
    const longest = `/${"a".repeat(MAX_LOOKUP_PATH_LENGTH - 1)}`;
    expect(lookupTarget(`/lookup/docs.example.com${longest}`, HOSTS)).toEqual({
      ok: true,
      host: "docs.example.com",
      path: longest,
    });
    expect(lookupTarget(`/lookup/docs.example.com${longest}b`, HOSTS)).toEqual({
      ok: false,
      reason: "invalid path",
      host: "docs.example.com",
    });
  });

  it.each([
    ["a fragment", "/lookup/docs.example.com/guide#intro"],
    ["a space", "/lookup/docs.example.com/a b"],
    ["a control character", "/lookup/docs.example.com/a\tb"],
    ["a character past ASCII", "/lookup/docs.example.com/café"],
  ])("refuses a path with %s", (_label, url) => {
    expect(lookupTarget(url, HOSTS)).toEqual({
      ok: false,
      reason: "invalid path",
      host: "docs.example.com",
    });
  });
});

describe("hasRequestBody (unit: a lookup has no body)", () => {
  it.each([
    [{}, false],
    [{ "content-length": "0" }, false],
    [{ "content-length": "00" }, false],
    [{ "content-length": "1" }, true],
    [{ "content-length": "x" }, true],
    [{ "transfer-encoding": "chunked" }, true],
  ])("reads %j as %s", (headers, expected) => {
    expect(hasRequestBody(headers)).toBe(expected);
  });
});

describe("lookupRequestHeaders (unit: built from scratch)", () => {
  it("is exactly the fixed accept, identity encoding and a generic user agent", () => {
    expect(lookupRequestHeaders()).toEqual({
      accept:
        "text/html, application/xhtml+xml, text/plain, text/markdown;q=0.9, */*;q=0.1",
      "accept-encoding": "identity",
      "user-agent": LOOKUP_USER_AGENT,
    });
    expect(LOOKUP_USER_AGENT.toLowerCase()).not.toMatch(/foreman|didi|rehearsal/);
  });
});

describe("lookupResponseHeaders (unit: only what the tool needs comes back)", () => {
  const upstream = {
    "content-type": "text/html; charset=utf-8",
    "content-length": "1234",
    "content-encoding": "identity",
    location: "/guide/next",
    "set-cookie": ["session=upstream-cookie-value; Secure"],
    "cache-control": "no-store",
    server: "upstream-server",
    "x-powered-by": "upstream",
    "strict-transport-security": "max-age=1",
    connection: "keep-alive",
    "transfer-encoding": "chunked",
  };

  it("keeps the type, length and encoding, and drops everything else", () => {
    expect(lookupResponseHeaders(200, upstream)).toEqual({
      "content-type": "text/html; charset=utf-8",
      "content-length": "1234",
      "content-encoding": "identity",
    });
  });

  it.each([301, 302, 303, 307, 308])("keeps the location of a %s", (status) => {
    expect(lookupResponseHeaders(status, upstream).location).toBe("/guide/next");
  });

  it.each([200, 201, 404, 500])("drops a location on a %s", (status) => {
    expect(lookupResponseHeaders(status, upstream).location).toBeUndefined();
  });

  it("drops a length past the limit, since the body is cut, and a length that is not a number", () => {
    expect(
      lookupResponseHeaders(200, { "content-length": String(LOOKUP_BODY_LIMIT) }),
    ).toEqual({ "content-length": String(LOOKUP_BODY_LIMIT) });
    expect(
      lookupResponseHeaders(200, { "content-length": String(LOOKUP_BODY_LIMIT + 1) }),
    ).toEqual({});
    expect(lookupResponseHeaders(200, { "content-length": "12, 12" })).toEqual({});
  });

  it("sends nothing it was not given", () => {
    expect(lookupResponseHeaders(200, {})).toEqual({});
  });
});
