import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { markdownDocumentsNpmRunScript } from "../scripts/lib/npm-run-in-markdown.mjs";

/** Scripts omitted from AGENTS.md — lifecycle hooks or only invoked via `npm run check`. */
const EXEMPT = new Set([
  "prepare",
  "placeholders",
  "attribution",
  "conflict-markers",
  "test:watch",
]);

describe("AGENTS.md command table", () => {
  it("documents every package.json script (except exempt hooks/sub-steps)", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const agents = readFileSync("AGENTS.md", "utf8");
    const commandsSection = agents.split("## Commands")[1] ?? "";

    for (const name of Object.keys(pkg.scripts)) {
      if (EXEMPT.has(name)) continue;
      expect(
        markdownDocumentsNpmRunScript(commandsSection, name),
        `add \`npm run ${name}\` to AGENTS.md ## Commands`,
      ).toBe(true);
    }
  });
});
