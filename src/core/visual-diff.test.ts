// Unit seam: locating differences on synthetic rasters (D-250). No files, no network.
import { describe, expect, it } from "vitest";

import {
  compareRasters,
  contentBox,
  crop,
  diffSummaryText,
  paintBox,
  solidRaster,
  VisualDiffError,
  type Raster,
} from "./visual-diff.ts";

type Rgba = readonly [number, number, number, number];
const WHITE: Rgba = [255, 255, 255, 255];
const BLUE: Rgba = [20, 60, 200, 255];
const DARK: Rgba = [30, 30, 30, 255];

/** A white page with a blue button and a dark label line inside it. */
function button(
  offsetX = 10,
  offsetY = 10,
  colour: Rgba = BLUE,
  labelWidth = 40,
): Raster {
  let r = solidRaster(120, 60, WHITE);
  r = paintBox(r, { x: offsetX, y: offsetY, width: 80, height: 30 }, colour);
  return paintBox(
    r,
    { x: offsetX + 10, y: offsetY + 12, width: labelWidth, height: 6 },
    DARK,
  );
}

describe("contentBox", () => {
  it("finds the box around everything that is not the background", () => {
    expect(contentBox(button())).toEqual({ x: 10, y: 10, width: 80, height: 30 });
  });

  it("is the whole image when there is only background", () => {
    expect(contentBox(solidRaster(5, 4, WHITE))).toEqual({
      x: 0,
      y: 0,
      width: 5,
      height: 4,
    });
  });

  it("lays transparent pixels on white", () => {
    const clear = solidRaster(6, 6, [0, 0, 0, 0]);
    expect(
      contentBox(paintBox(clear, { x: 2, y: 3, width: 1, height: 1 }, DARK)),
    ).toEqual({
      x: 2,
      y: 3,
      width: 1,
      height: 1,
    });
  });
});

describe("crop", () => {
  it("cuts a region and refuses one outside the image", () => {
    const part = crop(button(), { x: 10, y: 10, width: 4, height: 2 });
    expect(part.width).toBe(4);
    expect(Array.from(part.data.subarray(0, 4))).toEqual([...BLUE]);
    expect(() => crop(button(), { x: 100, y: 0, width: 40, height: 1 })).toThrow(
      VisualDiffError,
    );
  });
});

describe("compareRasters", () => {
  it("finds no change between identical images, whatever their margins", () => {
    const { summary } = compareRasters(button(10, 10), button(25, 5));
    expect(summary.changedPixels).toBe(0);
    expect(summary.sameSize).toBe(true);
    expect(summary.regions).toEqual([]);
    expect(diffSummaryText(summary)).toContain("no changed pixels");
  });

  it("locates a colour change and reports its size", () => {
    const { summary } = compareRasters(button(), button(10, 10, [200, 40, 40, 255]));
    expect(summary.changedPixels).toBe(80 * 30 - 40 * 6);
    expect(summary.maxDelta).toBe(180);
    expect(summary.regions).toHaveLength(1);
    expect(summary.regions[0]).toMatchObject({ x: 0, y: 0, width: 80, height: 30 });
  });

  it("locates a small copy change inside the component", () => {
    const { summary } = compareRasters(button(), button(10, 10, BLUE, 30));
    expect(summary.changedPixels).toBe(10 * 6);
    expect(summary.regions).toHaveLength(1);
    const region = summary.regions[0];
    expect(region?.x).toBeLessThanOrEqual(40);
    expect((region?.x ?? 0) + (region?.width ?? 0)).toBeGreaterThanOrEqual(50);
  });

  it("counts content missing from one image as changed, and empty margin as not", () => {
    const tall = paintBox(button(), { x: 10, y: 45, width: 80, height: 5 }, DARK);
    const { summary } = compareRasters(tall, button());
    expect(summary.sameSize).toBe(false);
    expect(summary.changedPixels).toBe(80 * 5);
    expect(diffSummaryText(summary)).toContain("sizes differ");
  });

  it("ignores differences at or under the threshold", () => {
    const { summary } = compareRasters(button(), button(10, 10, [30, 70, 210, 255]));
    expect(summary.changedPixels).toBe(0);
  });

  it("is deterministic and caps the regions it lists", () => {
    let dotted = button();
    for (let i = 0; i < 5; i++) {
      dotted = paintBox(dotted, { x: 12 + i * 15, y: 11, width: 2, height: 2 }, WHITE);
    }
    const options = { threshold: 24, cell: 4, maxRegions: 3 };
    const first = compareRasters(button(), dotted, options).summary;
    expect(compareRasters(button(), dotted, options).summary).toEqual(first);
    expect(first.regions).toHaveLength(3);
    expect(first.regionsOmitted).toBe(2);
  });

  it("refuses a raster whose size does not match its pixels and bad options", () => {
    const broken = { width: 3, height: 3, data: new Uint8Array(4) };
    expect(() => compareRasters(broken, button())).toThrow(VisualDiffError);
    expect(() =>
      compareRasters(button(), button(), { threshold: 300, cell: 8, maxRegions: 8 }),
    ).toThrow(VisualDiffError);
  });
});
