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
      'import { createHash } from "node:crypto";',
      'import { inspect } from "node:util";',
      'import { x } from "./other.ts";',
      'import { y } from "../core/guards/y.ts";',
      'export * from "./more.ts";',
      'export const id = (): string => createHash("sha256").update(inspect(x) + String(y)).digest("hex");',
      "export const at = (iso: string): number => new Date(iso).getTime();",
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

  it.each([
    ["Date.now", "export const t = () => Date.now();"],
    ["new Date()", "export const t = () => new Date();"],
    ["Date()", "export const t = () => Date();"],
    ["performance.now", "export const t = () => performance.now();"],
    ["Math.random", "export const r = () => Math.random();"],
    ["the crypto global", "export const r = () => crypto.randomUUID();"],
    [
      "randomUUID from node:crypto",
      'import { randomUUID } from "node:crypto";\nexport const r = randomUUID;',
    ],
    [
      "randomBytes through a namespace",
      'import * as c from "node:crypto";\nexport const r = () => c.randomBytes(8);',
    ],
    [
      "webcrypto",
      'import { webcrypto } from "node:crypto";\nexport const r = webcrypto;',
    ],
  ])("keeps the core deterministic: rejects %s (D-162)", async (_label, code) => {
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

describe("flow layer boundary (unit: lint config guard, ADR 0101, build plan M3.1)", () => {
  const layer = (rules: string[]) => rules.includes("layers/layer-imports");

  it("lets a flow entry import the composition module, the core and the adapters", async () => {
    const clean = [
      'import { createLibrary } from "../src/core/library.ts";',
      'import type { AgentRuntime } from "../src/adapters/agent-runtime/runtime.ts";',
      'import { withFlowDeps } from "./lib/compose.ts";',
      "export const main = () => withFlowDeps(createLibrary, {} as AgentRuntime<1, 2>);",
    ].join("\n");
    expect(await violations("flows/example.ts", clean)).toEqual([]);
  });

  it.each([
    ["a package", 'import pg from "pg";'],
    ["Windmill's client", 'import * as wmill from "windmill-client";'],
    ["a Node module", 'import { readFileSync } from "node:fs";'],
    ["the API", 'import { x } from "../src/api/routes.ts";'],
    ["the service kit", 'import { x } from "../src/service-kit/config.ts";'],
    ["another flow", 'import { run } from "./dispatch.ts";'],
    ["a re-export from outside", 'export { x } from "../src/api/routes.ts";'],
  ])("rejects a flow entry importing %s", async (_label, code) => {
    expect(layer(await violations("flows/example.ts", code))).toBe(true);
  });

  it("rejects a dynamic import and an inline disable in a flow entry", async () => {
    expect(
      layer(await violations("flows/example.ts", 'export const m = import("pg");')),
    ).toBe(true);
    const disabled = [
      "/* eslint-disable */",
      'import pg from "pg";',
      "export { pg };",
    ].join("\n");
    expect(layer(await violations("flows/example.ts", disabled))).toBe(true);
  });

  it("lets the composition module build the pool, and nothing more", async () => {
    expect(
      await violations(
        "flows/lib/example.ts",
        'import pg from "pg";\nimport { randomUUID } from "node:crypto";\nexport { pg, randomUUID };\n',
      ),
    ).toEqual([]);
    expect(
      layer(
        await violations(
          "flows/lib/example.ts",
          'import got from "got";\nexport { got };\n',
        ),
      ),
    ).toBe(true);
  });

  it.each([
    ["the API", "src/api/example.ts"],
    ["an adapter", "src/adapters/github/example.ts"],
    ["a service", "src/github-receiver/example.ts"],
  ])("rejects %s importing a flow", async (_label, file) => {
    const depth = file.split("/").length - 1;
    const code = `import { run } from "${"../".repeat(depth)}flows/dispatch.ts";\nexport { run };\n`;
    expect(layer(await violations(file, code))).toBe(true);
  });
});
