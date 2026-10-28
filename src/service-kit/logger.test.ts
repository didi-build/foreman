import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.ts";

describe("createLogger (unit: service kit, ADR 0111)", () => {
  const at = new Date("2026-10-28T12:00:00.000Z");

  it("writes one JSON object per line with the standard keys and fields", () => {
    const lines: string[] = [];
    createLogger(
      "svc",
      (line) => lines.push(line),
      () => at,
    ).info("started", { port: 8080 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      port: 8080,
      time: "2026-10-28T12:00:00.000Z",
      level: "info",
      service: "svc",
      message: "started",
    });
  });

  it("does not let fields overwrite the standard keys", () => {
    const lines: string[] = [];
    createLogger(
      "svc",
      (line) => lines.push(line),
      () => at,
    ).error("boom", { level: "info", service: "other" });
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: "error",
      service: "svc",
    });
  });
});
