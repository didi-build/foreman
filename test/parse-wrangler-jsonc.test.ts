import { describe, expect, it } from "vitest";
import {
  parseWranglerJsonc,
  replaceWranglerWorkerName,
} from "../scripts/lib/parse-wrangler-jsonc.mjs";

const TEMPLATE_WRANGLER = `{
  // Worker display name in Cloudflare
  "name": "launchpad",
  "compatibility_date": "2026-10-26",
  "assets": {
    "directory": "./dist/gallery",
    "not_found_handling": "single-page-application",
  },
}`;

describe("parseWranglerJsonc (unit)", () => {
  it("parses line comments and trailing commas", () => {
    const config = parseWranglerJsonc(TEMPLATE_WRANGLER);
    expect(config.name).toBe("launchpad");
  });

  it("parses block and multi-line comments", () => {
    const text = `{
  /* block */
  "name": "launchpad",
  /*
   * multi
   */
  "compatibility_date": "2026-10-26",
}`;
    expect(parseWranglerJsonc(text).name).toBe("launchpad");
  });

  it("preserves // inside double-quoted strings (e.g. $schema URL)", () => {
    const text = `{
  "$schema": "https://example.com/path//segment",
  "name": "launchpad"
}`;
    const config = parseWranglerJsonc(text);
    expect(config.$schema).toBe("https://example.com/path//segment");
  });

  it('does not strip literal ", }" inside strings', () => {
    const text = `{
  "name": "launchpad",
  "note": "comma, } and [1, ] inside"
}`;
    expect(parseWranglerJsonc(text).note).toBe("comma, } and [1, ] inside");
  });

  it("parses trailing commas inside arrays such as [1, ]", () => {
    const text = `{
  "name": "launchpad",
  "items": [1, ],
}`;
    expect(parseWranglerJsonc(text).items).toEqual([1]);
  });

  it("handles escaped quotes before line comments", () => {
    const text = `{
  "name": "launchpad",
  "hint": "say \\"hello\\" // not a comment"
}`;
    expect(parseWranglerJsonc(text).hint).toBe('say "hello" // not a comment');
  });

  it("throws on malformed JSONC instead of ignoring parse errors", () => {
    const text = `{
  "name": "launchpad",
  "broken":
}`;
    expect(() => parseWranglerJsonc(text)).toThrow(/parse error/i);
  });

  it("throws when whitespace would merge JSON tokens outside strings", () => {
    expect(() => parseWranglerJsonc('{"a": 1 2}')).toThrow(/parse error/i);
    expect(() => parseWranglerJsonc('{"a": tr ue}')).toThrow(/parse error/i);
    expect(() => parseWranglerJsonc('{"a": 1\u00A02}')).toThrow(/parse error/i);
  });

  it("throws when block comments would merge JSON tokens outside strings", () => {
    expect(() => parseWranglerJsonc('{"a": 1/**/2}')).toThrow(/parse error/i);
    expect(() => parseWranglerJsonc('{"a": tr/**/ue}')).toThrow(/parse error/i);
  });

  it("parses values separated from tokens by block comments", () => {
    expect(parseWranglerJsonc('{"a": /**/1}')).toEqual({ a: 1 });
  });

  it("throws when expectedName does not match top-level name", () => {
    const text = `{
  "name": "other",
}`;
    expect(() => replaceWranglerWorkerName(text, "launchpad", "smoke-test")).toThrow(
      /must be "launchpad"/,
    );
  });

  it("renames only the top-level name when a nested name appears first", () => {
    const text = `{
  "assets": {
    "name": "launchpad"
  },
  "name": "launchpad",
  "compatibility_date": "2026-10-26",
}`;
    const renamed = replaceWranglerWorkerName(text, "launchpad", "smoke-test");
    expect(parseWranglerJsonc(renamed).name).toBe("smoke-test");
    expect(parseWranglerJsonc(renamed).assets).toEqual({ name: "launchpad" });
    expect(renamed).toContain('"name": "launchpad"');
    expect(renamed).toContain('"name": "smoke-test"');
  });

  it("keeps line comments when renaming the worker", () => {
    const renamed = replaceWranglerWorkerName(
      TEMPLATE_WRANGLER,
      "launchpad",
      "smoke-test",
    );
    expect(renamed).toContain("// Worker display name");
    expect(parseWranglerJsonc(renamed).name).toBe("smoke-test");
  });

  it("preserves leading whitespace and NBSP before { through rename", () => {
    const nbsp = "\u00A0";
    const text = `  ${nbsp}{
  "name": "launchpad",
}`;
    const renamed = replaceWranglerWorkerName(text, "launchpad", "smoke-test");
    expect(renamed.startsWith(`  ${nbsp}{`)).toBe(true);
    expect(parseWranglerJsonc(renamed).name).toBe("smoke-test");
  });

  it("preserves a mid-string U+FEFF byte for byte through rename", () => {
    const bom = "\uFEFF";
    const text = `{
  "name": "launchpad",
  "note": "has${bom}bom inside"
}`;
    const renamed = replaceWranglerWorkerName(text, "launchpad", "smoke-test");
    expect(renamed).toContain(`has${bom}bom inside`);
    expect(renamed.indexOf(bom)).toBe(renamed.indexOf("has") + 3);
    expect(parseWranglerJsonc(renamed).note).toBe(`has${bom}bom inside`);
  });

  it("parses and renames wrangler.jsonc with a leading UTF-8 BOM (BOM dropped on write)", () => {
    const bom = "\uFEFF";
    const text = `${bom}{
  "name": "launchpad",
  "compatibility_date": "2026-10-26",
}`;
    expect(parseWranglerJsonc(text).name).toBe("launchpad");
    const renamed = replaceWranglerWorkerName(text, "launchpad", "smoke-test");
    expect(renamed.startsWith(bom)).toBe(false);
    expect(parseWranglerJsonc(renamed).name).toBe("smoke-test");
  });

  it("keeps block comments when renaming the worker", () => {
    const text = `{
  /* worker id */
  "name": "launchpad",
}`;
    const renamed = replaceWranglerWorkerName(text, "launchpad", "smoke-test");
    expect(renamed).toContain("/* worker id */");
    expect(parseWranglerJsonc(renamed).name).toBe("smoke-test");
  });
});
