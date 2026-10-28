import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findBareNegationIfLines,
  isBareNegationIfLine,
  scanWorkflowYaml,
} from "../scripts/check-workflow-yaml.mjs";

describe("check-workflow-yaml (unit)", () => {
  it("flags bare if lines that start with !", () => {
    expect(isBareNegationIfLine("        if: !cancelled()")).toBe(true);
    expect(isBareNegationIfLine("        if: ${{ !cancelled() }}")).toBe(false);
    expect(isBareNegationIfLine('        if: "!cancelled()"')).toBe(false);
    expect(isBareNegationIfLine("        if: always() && !cancelled()")).toBe(false);
  });

  it("finds line numbers for invalid if values", () => {
    const text = `jobs:
  preview:
    steps:
      - name: x
        if: !cancelled()
`;
    expect(findBareNegationIfLines(text)).toEqual([
      { line: 5, content: "        if: !cancelled()" },
    ]);
  });

  it("passes real workflow files in the repo", () => {
    const issues = scanWorkflowYaml(process.cwd());
    expect(issues).toEqual([]);
  });

  it("reports invalid workflow fixtures", () => {
    const root = mkdtempSync(join(tmpdir(), "launchpad-wf-yaml-"));
    const dir = join(root, ".github", "workflows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "bad.yml"),
      `name: bad
on: push
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - if: !cancelled()
        run: echo hi
`,
    );
    const issues = scanWorkflowYaml(root);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.hits).toHaveLength(1);
  });
});
