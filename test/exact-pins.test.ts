import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findNonExactPins } from "../scripts/lib/exact-pins.mjs";

describe("exact dependency pins (unit: repo tooling guard, ADR 0101)", () => {
  it("finds no ranges in this repo's package.json", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as Record<
      string,
      unknown
    >;
    expect(findNonExactPins(pkg)).toEqual([]);
  });

  it("flags caret, tilde, wildcard and tag versions in every pinned section", () => {
    const pkg = {
      dependencies: { a: "^1.2.3", ok: "1.2.3" },
      devDependencies: { b: "~1.2.3", c: "*" },
      overrides: { d: "latest" },
    };
    expect(findNonExactPins(pkg)).toEqual([
      { section: "dependencies", name: "a", version: "^1.2.3" },
      { section: "devDependencies", name: "b", version: "~1.2.3" },
      { section: "devDependencies", name: "c", version: "*" },
      { section: "overrides", name: "d", version: "latest" },
    ]);
  });

  it("also checks optional and peer dependencies", () => {
    const pkg = {
      optionalDependencies: { e: "^1.0.0" },
      peerDependencies: { f: ">=2" },
    };
    expect(findNonExactPins(pkg)).toEqual([
      { section: "optionalDependencies", name: "e", version: "^1.0.0" },
      { section: "peerDependencies", name: "f", version: ">=2" },
    ]);
  });

  it.each(["1.2.3-rc.1", "1.2.3-beta", "1.2.3+build.5"])(
    "accepts the exact version %s",
    (version) => {
      expect(findNonExactPins({ dependencies: { a: version } })).toEqual([]);
    },
  );

  it("makes npm save exact versions", () => {
    expect(readFileSync(".npmrc", "utf8")).toMatch(/^save-exact=true$/m);
  });
});
