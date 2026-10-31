// Seam: unit. The run cost rules (ADR 0114 sections 2, 5 and 8, O-25): which tier is priced, the
// cache-write rule, the highest-cost rule for a supported tier with no price, and the strict check
// of a recorded price. Pure functions, no store. Recording the cost at a run's end is in
// runs.test.ts.
import { describe, expect, it } from "vitest";

import { parseRunPrice, pricedTier, runCostUsd, tierCostUsd } from "./run-cost.ts";
import { firstRunPrice } from "./routing-testing.ts";
import type { RunPrice } from "./routing.ts";

const OPEN: RunPrice = {
  tiers: ["standard", "flex"],
  pricePerMTok: {
    standard: { input: 0.3, cachedInput: 0.1, output: 1 },
    flex: { input: 0.24, cachedInput: 0.08, output: 0.8 },
  },
};

const MILLION = {
  uncachedInput: 1_000_000,
  cachedInput: 1_000_000,
  cacheWriteInput: 1_000_000,
  output: 1_000_000,
};

describe("the priced tier (ADR 0114 section 8)", () => {
  it.each([
    ["flex", "flex"],
    ["standard", "standard"],
    ["priority", "standard"],
    ["mixed", "standard"],
    [null, "standard"],
  ] as const)("prices a run served at %s at %s", (served, tier) => {
    expect(pricedTier(OPEN, served)).toBe(tier);
  });
});

describe("the cost", () => {
  it("prices each kind of token apart, cache writes at cacheWrite when listed", () => {
    // Sonnet 5.5: 2 + 0.2 + 2.5 + 10.
    expect(runCostUsd(firstRunPrice("claude-sonnet-5-5"), MILLION, "standard")).toBe(
      14.7,
    );
    expect(
      tierCostUsd(
        { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
        { uncachedInput: 1000, cachedInput: 0, output: 1000 },
      ),
    ).toBeCloseTo(0.012, 12);
  });

  it("prices cache writes at the uncached input rate when the catalog lists none", () => {
    expect(runCostUsd(OPEN, MILLION, "flex")).toBe(1.36);
    expect(
      runCostUsd(
        OPEN,
        { uncachedInput: 0, cachedInput: 0, cacheWriteInput: 10, output: 0 },
        "standard",
      ),
    ).toBe(0.000003);
  });

  it("prices a supported tier with no price at the highest cost any price gives", () => {
    const noFlexPrice: RunPrice = {
      tiers: ["standard", "flex", "priority"],
      pricePerMTok: {
        standard: { input: 1, cachedInput: 0.1, output: 2 },
        priority: { input: 1.5, cachedInput: 0.15, output: 3 },
      },
    };
    expect(runCostUsd(noFlexPrice, MILLION, "flex")).toBe(1.5 + 0.15 + 1.5 + 3);
  });

  it("is deterministic and rounds to a billionth of a dollar", () => {
    const tokens = { uncachedInput: 1, cachedInput: 3, output: 7 };
    const one = runCostUsd(OPEN, tokens, "standard");
    expect(one).toBe(runCostUsd(structuredClone(OPEN), { ...tokens }, "standard"));
    // 1 x 0.3 + 3 x 0.1 + 7 x 1, per million, with no float noise.
    expect(one).toBe(0.0000076);
  });
});

describe("the recorded price, checked strictly", () => {
  it("accepts a catalog entry", () => {
    const problems: string[] = [];
    expect(parseRunPrice("model_price", OPEN, "flex", problems)).toEqual(OPEN);
    expect(problems).toEqual([]);
  });

  it.each([
    [null, "model_price must be an object"],
    [{ ...OPEN, extra: 1 }, "model_price: unknown field extra"],
    [{ ...OPEN, tiers: [] }, "model_price.tiers must be a non-empty list"],
    [{ ...OPEN, tiers: ["standard", "standard"] }, "model_price.tiers must be"],
    [
      { ...OPEN, pricePerMTok: { batch: {} } },
      "model_price.pricePerMTok: unknown tier batch",
    ],
    [
      { ...OPEN, pricePerMTok: { standard: { input: -1, cachedInput: 0, output: 0 } } },
      "model_price.pricePerMTok.standard.input must be a number",
    ],
    [
      { ...OPEN, pricePerMTok: { flex: OPEN.pricePerMTok.flex } },
      "has no Standard price",
    ],
    [
      { ...OPEN, pricePerMTok: { standard: OPEN.pricePerMTok.standard } },
      "has no price for the requested tier",
    ],
  ])("refuses a bad price, naming the field: %j", (value, problem) => {
    const problems: string[] = [];
    expect(parseRunPrice("model_price", value, "flex", problems)).toBeNull();
    expect(problems.join("\n")).toContain(problem);
  });

  it("needs no price for a requested tier the provider does not support", () => {
    const problems: string[] = [];
    const price = firstRunPrice("claude-sonnet-5-5");
    expect(parseRunPrice("model_price", price, "flex", problems)).toEqual(price);
    expect(problems).toEqual([]);
  });
});
