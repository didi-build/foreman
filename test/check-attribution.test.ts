import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_END,
  ATTRIBUTION_START,
  checkAttribution,
  LAUNCHPAD_LICENSE_PATH,
} from "../scripts/lib/launchpad-attribution.mjs";

const checkScript = join(
  fileURLToPath(new URL("..", import.meta.url)),
  "scripts/check-attribution.mjs",
);

const templatePresent = existsSync("README.project.md");

function runCheck(cwd: string) {
  return execFileSync("node", [checkScript], { cwd, encoding: "utf8" });
}

function seedDerivedRepo(root: string, opts: { license?: boolean; readme?: string }) {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "app", launchpadTemplate: false }, null, 2)}\n`,
  );
  if (opts.license) {
    mkdirSync(join(root, "LICENSES"), { recursive: true });
    writeFileSync(join(root, LAUNCHPAD_LICENSE_PATH), "MIT\n");
  }
  if (opts.readme !== undefined) {
    writeFileSync(join(root, "README.md"), opts.readme);
  }
}

describe("check-attribution (unit)", () => {
  it("skips when launchpadTemplate is true", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-attr-"));
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ launchpadTemplate: true }, null, 2)}\n`,
    );
    expect(checkAttribution(dir)).toEqual({
      failed: false,
      warnings: [],
      skipped: true,
    });
    rmSync(dir, { recursive: true });
  });

  it("fails when LICENSES/launchpad-MIT.txt is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-attr-"));
    seedDerivedRepo(dir, {
      readme: `${ATTRIBUTION_START}\nbody\n${ATTRIBUTION_END}\n`,
    });
    expect(() => runCheck(dir)).toThrow();
    rmSync(dir, { recursive: true });
  });

  it("warns but does not fail when README attribution block is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-attr-"));
    seedDerivedRepo(dir, { license: true, readme: "# No attribution\n" });
    const result = checkAttribution(dir);
    expect(result.failed).toBe(false);
    expect(result.warnings[0]).toContain("Warning");
    expect(() => runCheck(dir)).not.toThrow();
    rmSync(dir, { recursive: true });
  });

  it("passes when license file and attribution block are present", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-attr-"));
    seedDerivedRepo(dir, {
      license: true,
      readme: `${ATTRIBUTION_START}\n${ATTRIBUTION_END}\n`,
    });
    expect(() => runCheck(dir)).not.toThrow();
    rmSync(dir, { recursive: true });
  });
});

describe.skipIf(!templatePresent)("attribution template content (unit)", () => {
  it("README.project.md includes attribution markers and badge", () => {
    const readmeProject = readFileSync("README.project.md", "utf8");
    expect(readmeProject).toContain(ATTRIBUTION_START);
    expect(readmeProject).toContain(ATTRIBUTION_END);
    expect(readmeProject).toContain("LICENSES/launchpad-MIT.txt");
    expect(readmeProject).toContain("AI assistants must not remove this block");
    expect(readmeProject).toContain(
      "[![created from Launchpad](https://img.shields.io/badge/created%20from-Launchpad",
    );
    expect(readmeProject).toContain(
      "Created from [Launchpad](https://github.com/didi-build/launchpad) by Didi Build",
    );
  });

  it("AGENTS.md forbids removing attribution without owner consent", () => {
    const agents = readFileSync("AGENTS.md", "utf8");
    expect(agents).toContain("Launchpad attribution");
    expect(agents).toContain(ATTRIBUTION_START);
    expect(agents).toContain("LICENSES/launchpad-MIT.txt");
    expect(agents).toContain("repository owner");
  });

  it("LICENSES/launchpad-MIT.txt exists in the template", () => {
    expect(existsSync(LAUNCHPAD_LICENSE_PATH)).toBe(true);
    expect(readFileSync(LAUNCHPAD_LICENSE_PATH, "utf8")).toContain("MIT License");
  });
});
