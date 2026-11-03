// Locating differences before the model looks (D-250, D-249, docs/costs.md section 7). For one
// component, the runner compares the approved option's crop with the built component's
// screenshot, pixel by pixel, and hands the model the two crops and a short summary of where they
// differ and by how much, so the model judges located changes instead of hunting for them.
//
// Plain, deterministic code over RGBA rasters: no file format (the PNG codec is an adapter,
// src/adapters/screenshots/png.ts), no clock, no randomness. The same two rasters always give the
// same summary.
//
// How two images are lined up. A browser screenshot of a component and a crop of a page rarely
// have the same margins, so each image is first cut to its content: the smallest box holding
// every pixel that differs from the image's background (its top-left pixel). The two content
// boxes are then compared from their top-left corners over the larger of the two sizes; where one
// image is smaller, the missing pixels count as the other image's background, so a missing row of
// content shows up as a change and empty margin does not. Transparent pixels are laid on white.
//
// What counts as changed. A pixel is changed when any colour channel differs by more than the
// threshold (0 to 255). Changed pixels are grouped into square cells; touching changed cells form
// one region, reported as a box with its count of changed pixels and its largest channel
// difference. Regions are listed largest first, at most `maxRegions`.

export interface Raster {
  width: number;
  height: number;
  /** RGBA, row by row, 4 bytes a pixel. */
  data: Uint8Array;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChangedRegion extends Region {
  changedPixels: number;
  /** The largest channel difference in the region, 0 to 255. */
  maxDelta: number;
}

export interface DiffOptions {
  /** A channel difference above this marks a pixel changed. */
  threshold: number;
  /** The side of a grouping cell, in pixels. */
  cell: number;
  maxRegions: number;
}

export const DIFF_DEFAULTS: DiffOptions = { threshold: 24, cell: 8, maxRegions: 8 };

export interface DiffSummary {
  /** Each image's content box, in its own coordinates. */
  approvedContent: Region;
  builtContent: Region;
  /** Whether the two content boxes have the same width and height. */
  sameSize: boolean;
  /** Pixels compared: the larger width times the larger height of the two content boxes. */
  comparedPixels: number;
  changedPixels: number;
  /** Changed pixels as a percentage of compared pixels, to two decimals. */
  changedPercent: number;
  maxDelta: number;
  /** Changed regions in the compared area (from the content boxes' top-left), largest first. */
  regions: ChangedRegion[];
  /** Regions left out past `maxRegions`. */
  regionsOmitted: number;
}

export class VisualDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisualDiffError";
  }
}

function checkRaster(raster: Raster): void {
  const { width, height, data } = raster;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    data.length !== width * height * 4
  ) {
    throw new VisualDiffError("a raster's size does not match its pixels");
  }
}

/** A raster of one colour. */
export function solidRaster(
  width: number,
  height: number,
  rgba: readonly [number, number, number, number],
): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { width, height, data };
}

/** Paints a box of one colour onto a copy of the raster, clipped to its edges. */
export function paintBox(
  raster: Raster,
  box: Region,
  rgba: readonly [number, number, number, number],
): Raster {
  const data = new Uint8Array(raster.data);
  for (
    let y = Math.max(0, box.y);
    y < Math.min(raster.height, box.y + box.height);
    y++
  ) {
    for (
      let x = Math.max(0, box.x);
      x < Math.min(raster.width, box.x + box.width);
      x++
    ) {
      data.set(rgba, (y * raster.width + x) * 4);
    }
  }
  return { width: raster.width, height: raster.height, data };
}

/** The part of a raster inside `region`, which must lie inside it. */
export function crop(raster: Raster, region: Region): Raster {
  checkRaster(raster);
  const { x, y, width, height } = region;
  if (
    ![x, y, width, height].every(Number.isSafeInteger) ||
    x < 0 ||
    y < 0 ||
    width < 1 ||
    height < 1 ||
    x + width > raster.width ||
    y + height > raster.height
  ) {
    throw new VisualDiffError("the crop region is not inside the image");
  }
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * raster.width + x) * 4;
    data.set(raster.data.subarray(from, from + width * 4), row * width * 4);
  }
  return { width, height, data };
}

/** The pixel at (x, y) laid on white, as [r, g, b]. */
function onWhite(raster: Raster, x: number, y: number): [number, number, number] {
  const i = (y * raster.width + x) * 4;
  const d = raster.data;
  const a = d[i + 3] as number;
  const mix = (c: number) => Math.round((c * a + 255 * (255 - a)) / 255);
  return [mix(d[i] as number), mix(d[i + 1] as number), mix(d[i + 2] as number)];
}

const delta = (a: readonly number[], b: readonly number[]): number =>
  Math.max(
    Math.abs((a[0] as number) - (b[0] as number)),
    Math.abs((a[1] as number) - (b[1] as number)),
    Math.abs((a[2] as number) - (b[2] as number)),
  );

/**
 * The smallest box holding every pixel that differs from the image's background (its top-left
 * pixel) by more than `threshold`. The whole image when every pixel is background.
 */
export function contentBox(
  raster: Raster,
  threshold = DIFF_DEFAULTS.threshold,
): Region {
  checkRaster(raster);
  const background = onWhite(raster, 0, 0);
  let minX = raster.width;
  let minY = raster.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      if (delta(onWhite(raster, x, y), background) > threshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, width: raster.width, height: raster.height };
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function checkOptions(options: DiffOptions): void {
  const { threshold, cell, maxRegions } = options;
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 254) {
    throw new VisualDiffError("the threshold must be a whole number from 0 to 254");
  }
  if (!Number.isInteger(cell) || cell < 1 || cell > 256) {
    throw new VisualDiffError("the cell must be a whole number from 1 to 256");
  }
  if (!Number.isInteger(maxRegions) || maxRegions < 1 || maxRegions > 100) {
    throw new VisualDiffError("maxRegions must be a whole number from 1 to 100");
  }
}

/**
 * Lines the two images up by their content and compares them (see the header). Returns the
 * summary and the two content crops the model is shown.
 */
export function compareRasters(
  approved: Raster,
  built: Raster,
  options: DiffOptions = DIFF_DEFAULTS,
): { summary: DiffSummary; approvedCrop: Raster; builtCrop: Raster } {
  checkRaster(approved);
  checkRaster(built);
  checkOptions(options);
  const approvedContent = contentBox(approved, options.threshold);
  const builtContent = contentBox(built, options.threshold);
  const a = crop(approved, approvedContent);
  const b = crop(built, builtContent);
  const aBackground = onWhite(approved, 0, 0);
  const bBackground = onWhite(built, 0, 0);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const columns = Math.ceil(width / options.cell);
  const rows = Math.ceil(height / options.cell);
  const cellChanged = new Uint32Array(columns * rows);
  const cellDelta = new Uint8Array(columns * rows);

  let changedPixels = 0;
  let maxDelta = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inA = x < a.width && y < a.height;
      const inB = x < b.width && y < b.height;
      const pa = inA ? onWhite(a, x, y) : bBackground;
      const pb = inB ? onWhite(b, x, y) : aBackground;
      const d = delta(pa, pb);
      if (d > options.threshold) {
        changedPixels += 1;
        if (d > maxDelta) maxDelta = d;
        const c = Math.floor(y / options.cell) * columns + Math.floor(x / options.cell);
        cellChanged[c] = (cellChanged[c] as number) + 1;
        if (d > (cellDelta[c] as number)) cellDelta[c] = d;
      }
    }
  }

  // Touching changed cells (4-neighbour) form one region. Cells are visited in row order, so the
  // regions come out in a fixed order before sorting.
  const seen = new Uint8Array(columns * rows);
  const found: ChangedRegion[] = [];
  for (let start = 0; start < columns * rows; start++) {
    if (seen[start] || cellChanged[start] === 0) continue;
    const stack = [start];
    seen[start] = 1;
    let minC = columns;
    let minR = rows;
    let maxC = -1;
    let maxR = -1;
    let pixels = 0;
    let worst = 0;
    while (stack.length > 0) {
      const c = stack.pop() as number;
      const col = c % columns;
      const row = Math.floor(c / columns);
      pixels += cellChanged[c] as number;
      worst = Math.max(worst, cellDelta[c] as number);
      minC = Math.min(minC, col);
      minR = Math.min(minR, row);
      maxC = Math.max(maxC, col);
      maxR = Math.max(maxR, row);
      const next = [
        col > 0 ? c - 1 : -1,
        col < columns - 1 ? c + 1 : -1,
        row > 0 ? c - columns : -1,
        row < rows - 1 ? c + columns : -1,
      ];
      for (const n of next) {
        if (n >= 0 && !seen[n] && (cellChanged[n] as number) > 0) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    const x = minC * options.cell;
    const y = minR * options.cell;
    found.push({
      x,
      y,
      width: Math.min(width, (maxC + 1) * options.cell) - x,
      height: Math.min(height, (maxR + 1) * options.cell) - y,
      changedPixels: pixels,
      maxDelta: worst,
    });
  }
  found.sort((p, q) => q.changedPixels - p.changedPixels || p.y - q.y || p.x - q.x);
  const compared = width * height;
  return {
    summary: {
      approvedContent,
      builtContent,
      sameSize: a.width === b.width && a.height === b.height,
      comparedPixels: compared,
      changedPixels,
      changedPercent: Math.round((changedPixels / compared) * 10_000) / 100,
      maxDelta,
      regions: found.slice(0, options.maxRegions),
      regionsOmitted: Math.max(0, found.length - options.maxRegions),
    },
    approvedCrop: a,
    builtCrop: b,
  };
}

const box = (r: Region): string => `${r.width}x${r.height} at (${r.x}, ${r.y})`;

/** The summary in a few plain lines for the model's input. Numbers only, no image content. */
export function diffSummaryText(summary: DiffSummary): string {
  const lines = [
    `Approved content: ${summary.approvedContent.width}x${summary.approvedContent.height} pixels. Built content: ${summary.builtContent.width}x${summary.builtContent.height} pixels${summary.sameSize ? " (same size)" : " (sizes differ)"}.`,
  ];
  if (summary.changedPixels === 0) {
    lines.push("The pixel comparison found no changed pixels.");
    return lines.join("\n");
  }
  lines.push(
    `The pixel comparison found ${summary.changedPixels} changed pixels (${summary.changedPercent}% of ${summary.comparedPixels}), largest channel difference ${summary.maxDelta} of 255.`,
    "Changed regions, measured from the top-left corner of each crop, largest first:",
    ...summary.regions.map(
      (r, i) =>
        `${i + 1}. ${box(r)}: ${r.changedPixels} changed pixels, largest difference ${r.maxDelta}`,
    ),
  );
  if (summary.regionsOmitted > 0) {
    lines.push(`${summary.regionsOmitted} smaller regions are not listed.`);
  }
  return lines.join("\n");
}
