import { describe, expect, it } from "vitest";
import { validateWorkerSlug } from "../scripts/lib/worker-slug.mjs";

describe("validateWorkerSlug (unit)", () => {
  it("accepts valid slugs", () => {
    expect(validateWorkerSlug("smoke-test")).toEqual({ ok: true });
    expect(validateWorkerSlug("a")).toEqual({ ok: true });
    expect(validateWorkerSlug("app42")).toEqual({ ok: true });
  });

  it("rejects invalid characters and edge dashes", () => {
    expect(validateWorkerSlug("-bad")).toMatchObject({ ok: false });
    expect(validateWorkerSlug("bad-")).toMatchObject({ ok: false });
    expect(validateWorkerSlug("MyApp")).toMatchObject({ ok: false });
  });

  it("rejects slugs longer than 63 characters", () => {
    expect(validateWorkerSlug("a".repeat(64))).toMatchObject({ ok: false });
  });
});
