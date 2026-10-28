import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_NPM_CI_ARGS,
  gitPushArgs,
} from "../scripts/lib/bootstrap-install.mjs";

describe("bootstrap install helpers (unit)", () => {
  it("uses npm ci --ignore-scripts for nodrift install", () => {
    expect(BOOTSTRAP_NPM_CI_ARGS).toEqual(["ci", "--ignore-scripts"]);
  });

  it("builds git push argv without credentials in the remote URL", () => {
    const token = "secret-pat-value";
    const args = gitPushArgs("org/repo");
    for (const arg of args) {
      expect(arg).not.toContain(token);
    }
    expect(args).toEqual(["push", "https://github.com/org/repo.git", "HEAD"]);
    expect(args[1]).not.toContain(token);
  });
});
