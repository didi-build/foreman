import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

/** Rule ids ESLint reports for `code` as if it lived at `filePath`. */
async function violations(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((message) => message.severity === 2)
    .map((message) => message.ruleId ?? "parse-error");
}

const coreBlocked = (rules: string[]): boolean =>
  rules.some((rule) =>
    [
      "foreman/core-imports",
      "no-restricted-globals",
      "no-eval",
      "no-implied-eval",
      "no-new-func",
      "no-restricted-syntax",
    ].includes(rule),
  );

describe("src/core/ boundary is an allow-list (unit: lint config guard, ADR 0101)", () => {
  it("accepts relative imports inside the core and the allowed pure Node modules", async () => {
    const clean = [
      'import { randomUUID } from "node:crypto";',
      'import { inspect } from "node:util";',
      'import { x } from "./other.ts";',
      'import { y } from "../core/guards/y.ts";',
      'export * from "./more.ts";',
      "export const id = (): string => randomUUID() + inspect(x) + String(y);",
    ].join("\n");
    expect(await violations("src/core/sub/example.ts", clean)).toEqual([]);
  });

  it.each([
    ["Windmill", 'import * as w from "windmill-client";'],
    ["node:http", 'import h from "node:http";'],
    ["bare https", 'import h from "https";'],
    ["node:tls", 'import t from "node:tls";'],
    ["node:dns", 'import d from "node:dns";'],
    ["node:child_process", 'import c from "node:child_process";'],
    ["node:fs", 'import f from "node:fs";'],
    ["undici", 'import { request } from "undici";'],
    ["got", 'import got from "got";'],
    ["ws", 'import ws from "ws";'],
    ["@octokit/rest", 'import { Octokit } from "@octokit/rest";'],
    ["@supabase/supabase-js", 'import { createClient } from "@supabase/supabase-js";'],
    ["pg", 'import pg from "pg";'],
    ["cloudflare:workers", 'import { env } from "cloudflare:workers";'],
    ["an adapter", 'import { x } from "../adapters/github/client.ts";'],
    ["the API", 'import { x } from "../api/server.ts";'],
    ["the service kit", 'import { x } from "../service-kit/config.ts";'],
    ["a flow", 'import { x } from "../../flows/merge.ts";'],
    [
      "a type-only adapter import",
      'import type { X } from "../adapters/linear/types.ts";',
    ],
    ["a re-export from outside", 'export { x } from "../adapters/github/client.ts";'],
    ["an export-all from a package", 'export * from "got";'],
  ])("rejects importing %s", async (_label, code) => {
    expect(coreBlocked(await violations("src/core/example.ts", code))).toBe(true);
  });

  it.each([
    ["fetch", 'export const f = () => fetch("https://example.com");'],
    [
      "globalThis.fetch",
      'export const f = () => globalThis.fetch("https://example.com");',
    ],
    ["WebSocket", 'export const s = () => new WebSocket("wss://example.com");'],
    ["process.env", "export const t = () => process.env.TOKEN;"],
    ["require", 'export const h = () => require("node:http");'],
  ])("rejects the global %s", async (_label, code) => {
    expect(coreBlocked(await violations("src/core/example.ts", code))).toBe(true);
  });

  it("rejects createRequire and dynamic imports, which would slip past import checks", async () => {
    expect(
      coreBlocked(
        await violations(
          "src/core/example.ts",
          'import { createRequire } from "node:module";\nexport const r = createRequire("x");',
        ),
      ),
    ).toBe(true);
    expect(
      coreBlocked(
        await violations(
          "src/core/example.ts",
          'export const l = () => import("node:http");',
        ),
      ),
    ).toBe(true);
  });

  it.each([
    "example.mjs",
    "example.js",
    "example.cjs",
    "example.mts",
    "example.cts",
    "example.tsx",
  ])("applies to %s files too", async (fileName) => {
    expect(
      coreBlocked(
        await violations(
          `src/core/${fileName}`,
          'import h from "node:http";\nexport { h };',
        ),
      ),
    ).toBe(true);
  });

  it.each([
    [
      "eslint-disable-next-line",
      '// eslint-disable-next-line\nimport h from "node:http";\nexport { h };',
    ],
    [
      "eslint-disable-next-line for the rule",
      '// eslint-disable-next-line foreman/core-imports\nimport h from "node:http";\nexport { h };',
    ],
    [
      "eslint-disable block",
      '/* eslint-disable */\nimport h from "node:http";\nexport { h };',
    ],
    [
      "inline rule config",
      '/* eslint foreman/core-imports: "off" */\nimport h from "node:http";\nexport { h };',
    ],
  ])("cannot be switched off with an inline %s comment", async (_label, code) => {
    expect(coreBlocked(await violations("src/core/example.ts", code))).toBe(true);
  });

  it.each([
    ["eval", 'export const f = () => eval("fetch");'],
    ["new Function", 'export const f = () => new Function("return fetch")();'],
    [
      "an indirect Function call",
      'export const f = () => (0, Function)("return fetch")();',
    ],
    [
      "a .constructor call",
      'export const f = () => (() => 0).constructor("return fetch")();',
    ],
    [
      "a new .constructor",
      'export const f = () => new (() => 0).constructor("return fetch")();',
    ],
    [
      "a string passed to setTimeout",
      'export const f = () => setTimeout("fetch()", 0);',
    ],
  ])("rejects code built from strings: %s", async (_label, code) => {
    expect(coreBlocked(await violations("src/core/example.ts", code))).toBe(true);
  });

  it("lets a core unit test import vitest, which sits next to the code", async () => {
    const test = [
      'import { describe, expect, it } from "vitest";',
      'import { x } from "./example.ts";',
      'describe("example (unit)", () => it("works", () => expect(x).toBe(1)));',
    ].join("\n");
    expect(await violations("src/core/example.test.ts", test)).toEqual([]);
  });

  it("does not let core code that is not a test import vitest", async () => {
    expect(
      coreBlocked(
        await violations(
          "src/core/example.ts",
          'import { vi } from "vitest";\nexport const v = vi;',
        ),
      ),
    ).toBe(true);
  });

  it("keeps every other core rule for core unit tests", async () => {
    expect(
      coreBlocked(
        await violations(
          "src/core/example.test.ts",
          'import h from "node:http";\nexport { h };',
        ),
      ),
    ).toBe(true);
    expect(
      coreBlocked(
        await violations(
          "src/core/example.test.ts",
          'export const f = () => fetch("x");',
        ),
      ),
    ).toBe(true);
  });
});

describe("Cloudflare boundary covers every code folder (unit: lint config guard, ADR 0101, essential 9)", () => {
  const cloudflareImport =
    'import { Cloudflare } from "cloudflare";\nexport { Cloudflare };\n';

  it.each([
    "src/core/example.ts",
    "src/api/server.ts",
    "src/adapters/github/client.ts",
    "flows/merge.ts",
    "contracts/load.ts",
    "scripts/tool.mjs",
    "src/api/server.mjs",
  ])("rejects a Cloudflare import in %s", async (filePath) => {
    const rules = await violations(filePath, cloudflareImport);
    expect(
      rules.some(
        (rule) => rule === "no-restricted-imports" || rule === "foreman/core-imports",
      ),
    ).toBe(true);
  });

  it("rejects cloudflare: runtime modules outside the deploy adapter", async () => {
    expect(
      await violations(
        "src/api/server.ts",
        'import { env } from "cloudflare:workers";\nexport { env };\n',
      ),
    ).toContain("no-restricted-imports");
  });

  it("allows Cloudflare in the deploy adapter", async () => {
    expect(
      await violations("src/adapters/deploy/cloudflare.ts", cloudflareImport),
    ).toEqual([]);
  });

  it("allows an adapter to import network modules", async () => {
    expect(
      await violations(
        "src/adapters/github/client.ts",
        'import { request } from "undici";\nexport { request };\n',
      ),
    ).toEqual([]);
  });
});
