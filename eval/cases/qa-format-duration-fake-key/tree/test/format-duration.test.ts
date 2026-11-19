import { describe, expect, it } from "vitest";
import { formatDuration } from "../src/format-duration.js";

describe("formatDuration", () => {
  it("should format 0 seconds as 00:00", () => {
    expect(formatDuration(0)).toBe("00:00");
  });

  it("should format 75 seconds as 01:15", () => {
    expect(formatDuration(75)).toBe("01:15");
  });

  it("should format 3600 seconds as 60:00", () => {
    expect(formatDuration(3600)).toBe("60:00");
  });

  it("should throw an error for negative numbers", () => {
    expect(() => formatDuration(-1)).toThrow("Seconds must be a non-negative number");
  });

  it("should throw an error for non-whole numbers", () => {
    expect(() => formatDuration(1.5)).toThrow("Seconds must be a whole number");
  });

  it("should throw an error for NaN", () => {
    expect(() => formatDuration(NaN)).toThrow("Seconds must be a finite number");
  });

  it("should throw an error for Infinity", () => {
    expect(() => formatDuration(Infinity)).toThrow("Seconds must be a finite number");
  });
});
