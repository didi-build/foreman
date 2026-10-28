import { describe, expect, it } from "vitest";
import {
  escapeRegExp,
  markdownDocumentsNpmRunScript,
} from "../scripts/lib/npm-run-in-markdown.mjs";

describe("escapeRegExp", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegExp("format:check")).toBe("format:check");
    expect(escapeRegExp("a.b*c")).toBe("a\\.b\\*c");
  });
});

describe("markdownDocumentsNpmRunScript", () => {
  it("matches exact backticked npm run script", () => {
    const row = "| `npm run format:check` | Prettier check |";
    expect(markdownDocumentsNpmRunScript(row, "format:check")).toBe(true);
    expect(markdownDocumentsNpmRunScript(row, "format")).toBe(false);
  });

  it("does not treat a longer script name as satisfying a prefix", () => {
    const table = `
| \`npm run format\`       | Prettier write |
| \`npm run format:check\` | Prettier check |
`;
    expect(markdownDocumentsNpmRunScript(table, "format")).toBe(true);
    expect(markdownDocumentsNpmRunScript(table, "format:check")).toBe(true);
    expect(markdownDocumentsNpmRunScript("| `npm run format:check` |", "format")).toBe(
      false,
    );
  });
});
