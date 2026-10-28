import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

/** Rule ids ESLint reports for `code` as if it lived at `filePath`. */
async function violations(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((message) => message.ruleId ?? "parse-error");
}

describe("src/core/ import boundary (unit: lint config guard, ADR 0101)", () => {
  const corePath = "src/core/example.ts";

  it("accepts a core file that uses only node built-ins and relative core imports", async () => {
    const clean =
      'import { randomUUID } from "node:crypto";\nimport { x } from "./other.js";\nexport const id = (): string => randomUUID() + String(x);\n';
    expect(await violations(corePath, clean)).toEqual([]);
  });

  it.each([
    ["Windmill", 'import * as wmill from "windmill-client";\nexport { wmill };\n'],
    [
      "node:http",
      'import { createServer } from "node:http";\nexport { createServer };\n',
    ],
    ["bare https", 'import https from "https";\nexport { https };\n'],
    ["undici", 'import { request } from "undici";\nexport { request };\n'],
    ["pg driver", 'import pg from "pg";\nexport { pg };\n'],
    [
      "an adapter",
      'import { x } from "../adapters/github/client.js";\nexport { x };\n',
    ],
    ["the API", 'import { x } from "../api/server.js";\nexport { x };\n'],
    ["a flow", 'import { x } from "../../flows/merge.js";\nexport { x };\n'],
    [
      "a type-only adapter import",
      'import type { X } from "../adapters/linear/types.js";\nexport type Y = X;\n',
    ],
  ])("rejects importing %s", async (_label, code) => {
    expect(await violations(corePath, code)).toContain("no-restricted-imports");
  });

  it("rejects the global fetch", async () => {
    const code =
      'export const get = (): Promise<Response> => fetch("https://example.com");\n';
    expect(await violations(corePath, code)).toContain("no-restricted-globals");
  });

  it("rejects dynamic imports, which would slip past the import rules", async () => {
    const code = 'export const load = (): Promise<unknown> => import("node:http");\n';
    expect(await violations(corePath, code)).toContain("no-restricted-syntax");
  });
});

describe("Cloudflare boundary (unit: lint config guard, ADR 0101)", () => {
  const cloudflareImport =
    'import { Cloudflare } from "cloudflare";\nexport { Cloudflare };\n';

  it.each([
    "src/core/example.ts",
    "src/api/server.ts",
    "src/adapters/github/client.ts",
  ])("rejects a Cloudflare import in %s", async (filePath) => {
    expect(await violations(filePath, cloudflareImport)).toContain(
      "no-restricted-imports",
    );
  });

  it("allows a Cloudflare import in the deploy adapter", async () => {
    expect(
      await violations("src/adapters/deploy/cloudflare.ts", cloudflareImport),
    ).toEqual([]);
  });

  it("allows an adapter to import network modules", async () => {
    const code = 'import { request } from "undici";\nexport { request };\n';
    expect(await violations("src/adapters/github/client.ts", code)).toEqual([]);
  });
});
