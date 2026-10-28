import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findSecretValues,
  secretForms,
  secretsFromEnv,
} from "../scripts/lib/find-secret-values.mjs";

const canary = "canary-value-0123456789";

describe("secret value scan (unit: IaC guard, ADR 0110)", () => {
  it("finds a value anywhere in a text and names only the text and the secret", () => {
    const hits = findSecretValues(
      [
        { name: "plan.txt", text: `binding = "${canary}"` },
        { name: "state.json", text: "ciphertext only" },
      ],
      { CANARY: canary },
    );
    expect(hits).toEqual([{ text: "plan.txt", secret: "CANARY", form: "plain" }]);
  });

  // A secret with a quote and a backslash, so JSON escaping actually changes it.
  const tricky = 'pa"ss\\word-0123456789';

  it.each([
    [
      "JSON-escaped (as in state.json)",
      JSON.stringify({ value: tricky }),
      "json-escaped",
    ],
    [
      "URL-encoded",
      `https://example.com/?token=${encodeURIComponent(tricky)}`,
      "url-encoded",
    ],
    ["base64", Buffer.from(tricky).toString("base64"), "base64"],
    [
      "base64 inside a longer blob (Basic auth)",
      `Basic ${Buffer.from(`user:${tricky}`).toString("base64")}`,
      "base64",
    ],
    [
      "base64 at the second alignment",
      Buffer.from(`ab${tricky}xyz`).toString("base64"),
      "base64",
    ],
    [
      "base64 at the first alignment",
      Buffer.from(`a${tricky}`).toString("base64"),
      "base64",
    ],
    // base64url equals base64 unless the text has + or /, so either name is a correct report.
    [
      "base64url",
      Buffer.from(`?${tricky}`).toString("base64url"),
      expect.stringMatching(/^base64/),
    ],
  ])("finds a secret that appears %s", (_label, text, form) => {
    expect(findSecretValues([{ name: "out.txt", text }], { SECRET: tricky })).toEqual([
      { text: "out.txt", secret: "SECRET", form },
    ]);
  });

  it("never offers a form shorter than the minimum length", () => {
    expect(secretForms("abcdefgh").every((form) => form.text.length >= 8)).toBe(true);
  });

  it("finds nothing in clean texts", () => {
    expect(
      findSecretValues([{ name: "plan.txt", text: "(sensitive value)" }], {
        CANARY: canary,
      }),
    ).toEqual([]);
  });

  it("refuses to scan for missing or very short values, so a scan cannot pass by checking nothing", () => {
    const { secrets, problems } = secretsFromEnv(["CANARY", "SHORT", "MISSING"], {
      CANARY: canary,
      SHORT: "abc",
    });
    expect(Object.keys(secrets)).toEqual(["CANARY"]);
    expect(problems).toEqual([
      "SHORT is shorter than 8 characters",
      "MISSING is not set",
    ]);
  });
});

describe("secret value scan CLI (integration: process boundary)", () => {
  const dir = mkdtempSync(join(tmpdir(), "find-secret-values-"));
  const dirty = join(dir, "plan.txt");
  const clean = join(dir, "state.json");
  writeFileSync(dirty, `value = "${canary}"`);
  writeFileSync(clean, "encrypted");
  const run = (files: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, ["scripts/find-secret-values.mjs", ...files], {
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8",
    });

  it("fails on a leak and never prints the value", () => {
    const result = run([dirty, clean], { SECRET_ENV_NAMES: "CANARY", CANARY: canary });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Secret value of CANARY found in");
    expect(result.stdout + result.stderr).not.toContain(canary);
  });

  it("passes on clean files", () => {
    expect(run([clean], { SECRET_ENV_NAMES: "CANARY", CANARY: canary }).status).toBe(0);
  });

  it("stops with exit 2 when a named secret is missing", () => {
    expect(run([clean], { SECRET_ENV_NAMES: "CANARY" }).status).toBe(2);
  });
});
