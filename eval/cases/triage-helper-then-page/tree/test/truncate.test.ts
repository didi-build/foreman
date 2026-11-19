import { describe, expect, it } from "vitest";
import { truncate } from "../src/truncate.js";

describe("truncate", () => {
  it("should return the input unchanged when its length is <= max", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello", 5)).toBe("hello");
    expect(truncate("", 5)).toBe("");
    // Specific cases from the plan
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("should truncate and add ellipsis when input is longer than max", () => {
    expect(truncate("hello world", 5)).toBe("hell…");
    expect(truncate("hello world", 10)).toBe("hello wor…");
    // Specific case from the plan
    expect(truncate("abcd", 3)).toBe("ab…");
  });

  it("should throw a RangeError when max is below 1", () => {
    expect(() => truncate("hello", 0)).toThrow(RangeError);
    expect(() => truncate("hello", -1)).toThrow(RangeError);
  });
});
