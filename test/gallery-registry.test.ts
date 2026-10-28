import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("component gallery scaffolding (unit)", () => {
  it("registers the example button and keeps spec separate", () => {
    const registry = readFileSync("gallery/registry.ts", "utf8");
    expect(registry).toContain("exampleButtonGallery");
    const spec = readFileSync("design/gallery/example-button/spec.md", "utf8");
    expect(spec).toContain("ExampleButton");
    const component = readFileSync(
      "components/example-button/ExampleButton.tsx",
      "utf8",
    );
    expect(component).toContain("export function ExampleButton");
  });
});
