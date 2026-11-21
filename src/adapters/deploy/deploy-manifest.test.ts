// Seam: the build's deploy manifest, `foreman-deploy.json` (unit, ADR 0118 slice 3, O-159). Exactly
// four fields; the compatibility date from 2025-04-01 on; flags from the allow-list only; required
// secrets as names only, bounded, never a binding Foreman sets; a file over 16 KiB refused before
// it is read. Each refusal is fixed text that quotes nothing from the file. Synthetic data only.
import { describe, expect, it } from "vitest";

import {
  ALLOWED_COMPATIBILITY_FLAGS,
  DEPLOY_MANIFEST_MAX_BYTES,
  MANIFEST_REFUSALS,
  MAX_REQUIRED_SECRETS,
  MIN_COMPATIBILITY_DATE,
  parseDeployManifest,
} from "./deploy-manifest.ts";

const VALID = {
  schema: 1,
  compatibilityDate: "2026-10-26",
  compatibilityFlags: ["nodejs_compat"],
  requiredSecrets: ["MODEL_API_KEY", "SESSION_KEY_2"],
};

const bytes = (value: unknown): Uint8Array =>
  new Uint8Array(
    Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
  );
const parse = (value: unknown) => parseDeployManifest(bytes(value));
const reasonOf = (value: unknown) => {
  const result = parse(value);
  return result.ok ? null : result.reason;
};

describe("the build's deploy manifest (unit: ADR 0118 slice 3, O-159)", () => {
  it("gives the date, the flags and the secret names of a manifest with exactly its fields", () => {
    expect(parse(VALID)).toEqual({
      ok: true,
      manifest: {
        compatibilityDate: "2026-10-26",
        compatibilityFlags: ["nodejs_compat"],
        requiredSecrets: ["MODEL_API_KEY", "SESSION_KEY_2"],
      },
    });
    // No flags and no secrets is the template's first manifest.
    expect(parse({ ...VALID, compatibilityFlags: [], requiredSecrets: [] })).toEqual({
      ok: true,
      manifest: {
        compatibilityDate: "2026-10-26",
        compatibilityFlags: [],
        requiredSecrets: [],
      },
    });
    expect(ALLOWED_COMPATIBILITY_FLAGS).toEqual(["nodejs_compat"]);
  });

  it("refuses a file larger than 16 KiB before reading it", () => {
    const padded = `${JSON.stringify(VALID)}${" ".repeat(DEPLOY_MANIFEST_MAX_BYTES)}`;
    expect(reasonOf(padded)).toBe("manifest_too_large");
    expect(DEPLOY_MANIFEST_MAX_BYTES).toBe(16 * 1024);
    // At the bound, it is read.
    const exact = JSON.stringify(VALID);
    expect(
      parse(exact.padEnd(DEPLOY_MANIFEST_MAX_BYTES, " ")).ok,
      "exactly 16 KiB",
    ).toBe(true);
  });

  it("refuses a file that is not a JSON object with exactly schema 1 and the three fields", () => {
    const missing: Record<string, unknown> = { ...VALID };
    delete missing.requiredSecrets;
    for (const value of [
      "not json",
      "",
      "[]",
      "null",
      '"text"',
      missing,
      { ...VALID, extra: true },
      { ...VALID, bindings: [{ type: "d1", name: "DB", id: "x" }] },
      { ...VALID, schema: 2 },
      { ...VALID, schema: "1" },
    ]) {
      expect(reasonOf(value), JSON.stringify(value)).toBe("manifest_malformed");
    }
    // Bytes that are not UTF-8.
    expect(parseDeployManifest(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))).toEqual({
      ok: false,
      reason: "manifest_malformed",
    });
  });

  it("refuses a compatibility date that is not a real YYYY-MM-DD date from 2025-04-01 on", () => {
    expect(MIN_COMPATIBILITY_DATE).toBe("2025-04-01");
    for (const compatibilityDate of [
      "2026-02-30",
      "2026-13-01",
      "26-10-26",
      "2026-10-26T00:00:00Z",
      " 2026-10-26",
      "2025-03-31",
      "2021-11-02",
      20261026,
      null,
    ]) {
      expect(reasonOf({ ...VALID, compatibilityDate }), String(compatibilityDate)).toBe(
        "manifest_date",
      );
    }
    for (const compatibilityDate of ["2025-04-01", "2028-02-29", "2026-11-21"]) {
      expect(parse({ ...VALID, compatibilityDate }).ok, compatibilityDate).toBe(true);
    }
  });

  it("refuses a flag outside the allow-list, a flag twice, or flags that are not a list of names", () => {
    for (const compatibilityFlags of [
      ["assets_navigation_has_no_effect"],
      ["nodejs_compat", "nodejs_compat"],
      ["NODEJS_COMPAT"],
      ["experimental"],
      "nodejs_compat",
      [1],
      null,
    ]) {
      expect(
        reasonOf({ ...VALID, compatibilityFlags }),
        JSON.stringify(compatibilityFlags),
      ).toBe("manifest_flags");
    }
  });

  it("refuses required secrets that are not distinct names, bounded, other than DB and ASSETS", () => {
    for (const requiredSecrets of [
      ["model_api_key"],
      ["1KEY"],
      ["_KEY"],
      ["KEY-1"],
      [""],
      ["K".repeat(65)],
      ["DB"],
      ["ASSETS"],
      ["KEY", "KEY"],
      Array.from({ length: MAX_REQUIRED_SECRETS + 1 }, (_, i) => `KEY_${i}`),
      [{ name: "KEY", value: "a-secret-value" }],
      { KEY: "a-secret-value" },
      "KEY",
      null,
    ]) {
      const result = parse({ ...VALID, requiredSecrets });
      expect(result.ok ? null : result.reason, JSON.stringify(requiredSecrets)).toBe(
        "manifest_secrets",
      );
      // A value in the file is never carried, not even in the refusal.
      expect(JSON.stringify(result)).not.toContain("a-secret-value");
    }
    expect(MAX_REQUIRED_SECRETS).toBe(64);
    expect(
      parse({
        ...VALID,
        requiredSecrets: [
          "K".repeat(64),
          ...Array.from({ length: 63 }, (_, i) => `KEY_${i}`),
        ],
      }).ok,
    ).toBe(true);
  });

  it("names nothing from the file in any refusal text", () => {
    for (const text of Object.values(MANIFEST_REFUSALS)) {
      expect(text).toMatch(/^[A-Za-z0-9 ,.;:'()_/-]{1,200}$/);
      expect(text).not.toMatch(/—/);
    }
  });
});
