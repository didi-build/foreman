import { describe, expect, it } from "vitest";
import { isRealTeam, writtenByApp } from "./linear.ts";

describe("Linear spike guards (unit: spike M0.3)", () => {
  it.each(["DIDI", "didi", " DIDI "])("refuses the real team key %j", (key) => {
    expect(isRealTeam(key)).toBe(true);
  });

  it("allows a test team key", () => {
    expect(isRealTeam("PFTEST")).toBe(false);
  });

  it("counts an issue as the app's only when botActor is set and no person created it", () => {
    expect(writtenByApp({ botActor: { name: "PF" }, creator: null })).toBe(true);
    expect(writtenByApp({ botActor: { name: "PF" }, creator: { id: "u1" } })).toBe(
      false,
    );
    expect(writtenByApp({ botActor: null, creator: null })).toBe(false);
  });

  it("counts a comment as the app's only when no user wrote it", () => {
    expect(writtenByApp({ botActor: { name: "PF" }, user: null })).toBe(true);
    expect(writtenByApp({ botActor: { name: "PF" }, user: { id: "u1" } })).toBe(false);
  });

  it("treats a missing node as not written by the app", () => {
    expect(writtenByApp(undefined)).toBe(false);
  });
});
