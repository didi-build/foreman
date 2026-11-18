import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The shared setup file removes every inherited GIT_* variable before any test runs (D-416).
describe("the clean git environment for tests", () => {
  it("is loaded for every test file by the vitest config", () => {
    const config = readFileSync("vitest.config.ts", "utf8");
    expect(config).toContain('setupFiles: ["test/setup-git-env.ts"]');
  });

  it("leaves no GIT_* variable in a test's environment", () => {
    expect(Object.keys(process.env).filter((key) => key.startsWith("GIT_"))).toEqual(
      [],
    );
  });
});
