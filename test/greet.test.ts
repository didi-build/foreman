import { describe, expect, it } from "vitest";
import { greet } from "../src/greet.js";

describe("greet (unit)", () => {
  it("returns a greeting for a non-empty name", () => {
    expect(greet("Launchpad")).toBe("Hello, Launchpad!");
  });

  it("rejects blank names", () => {
    expect(() => greet("   ")).toThrow(/name is required/);
  });
});
