import { describe, expect, it } from "vitest";
import { slugify } from "../src/slugify.js";

describe("slugify", () => {
  it("should convert 'Hello, World!' to 'hello-world'", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
  });

  it("should convert '  Foreman 2.0  ' to 'foreman-2-0'", () => {
    expect(slugify("  Foreman 2.0  ")).toBe("foreman-2-0");
  });

  it("should return lowercase output", () => {
    expect(slugify("UPPERCASE TEXT")).toBe("uppercase-text");
  });

  it("should not have leading or trailing hyphens", () => {
    expect(slugify("-leading hyphen")).toBe("leading-hyphen");
    expect(slugify("trailing hyphen-")).toBe("trailing-hyphen");
    expect(slugify("---multiple---hyphens---")).toBe("multiple-hyphens");
  });

  it("should convert runs of non-alphanumeric characters to single hyphens", () => {
    expect(slugify("a!!!b???c")).toBe("a-b-c");
    expect(slugify("spaces   and    tabs")).toBe("spaces-and-tabs");
  });

  it("should return empty string for empty input", () => {
    expect(slugify("")).toBe("");
  });

  it("should return empty string for input with only non-alphanumeric characters", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("@#$%^&*()")).toBe("");
  });
});
