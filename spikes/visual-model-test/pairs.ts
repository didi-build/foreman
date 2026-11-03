// The synthetic test set for the visual comparison model test (D-242, D-249, D-250,
// docs/costs.md section 7): 20 pairs, drawn in code, the same every time. Half are identical; half
// have exactly one planted difference, of six kinds: colour, spacing, copy, a missing state,
// font and alignment. Each pair is an option page with the component marked as a region, and a
// gallery screenshot of the built component at another offset, as CI would save them. No real
// design, no personal data, no network.
import {
  paintBox,
  solidRaster,
  type Raster,
  type Region,
} from "../../src/core/visual-diff.ts";

type Rgba = readonly [number, number, number, number];

export type PlantedKind =
  "colour" | "spacing" | "copy" | "missing_state" | "font" | "alignment";

/** What one component looks like. Text is drawn as dark blocks, one per letter. */
export interface ComponentLook {
  fill: Rgba;
  width: number;
  height: number;
  /** One width per letter of the label. */
  letters: number[];
  /** The letters' height: a stand-in for font size and weight. */
  letterHeight: number;
  /** Space between the left edge and the label. */
  padding: number;
  align: "left" | "center";
  /** A small status dot on the right: the component's state. */
  stateDot: boolean;
}

export interface SyntheticPair {
  id: string;
  /** Null for an identical pair. */
  planted: PlantedKind | null;
  /** What the planted difference is, for the record. */
  note: string;
  optionPage: Raster;
  region: Region;
  built: Raster;
  spec: string;
}

const WHITE: Rgba = [255, 255, 255, 255];
const INK: Rgba = [25, 25, 30, 255];
const DOT: Rgba = [30, 170, 80, 255];
const FILLS: Rgba[] = [
  [20, 60, 200, 255],
  [200, 70, 30, 255],
  [40, 140, 90, 255],
  [120, 50, 160, 255],
  [230, 180, 40, 255],
];

function draw(raster: Raster, x: number, y: number, look: ComponentLook): Raster {
  let r = paintBox(raster, { x, y, width: look.width, height: look.height }, look.fill);
  const labelWidth = look.letters.reduce((sum, w) => sum + w + 2, -2);
  let at =
    look.align === "left"
      ? x + look.padding
      : x + Math.floor((look.width - labelWidth) / 2);
  const top = y + Math.floor((look.height - look.letterHeight) / 2);
  for (const w of look.letters) {
    r = paintBox(r, { x: at, y: top, width: w, height: look.letterHeight }, INK);
    at += w + 2;
  }
  if (look.stateDot) {
    r = paintBox(
      r,
      {
        x: x + look.width - 12,
        y: y + Math.floor(look.height / 2) - 3,
        width: 6,
        height: 6,
      },
      DOT,
    );
  }
  return r;
}

/** The base look of pair `i`: a different colour, size and label for each. */
function baseLook(i: number): ComponentLook {
  return {
    fill: FILLS[i % FILLS.length] as Rgba,
    width: 120 + (i % 3) * 20,
    height: 36 + (i % 2) * 8,
    letters: [6, 5, 7, 5, 6, 4].slice(0, 4 + (i % 3)),
    letterHeight: 8,
    padding: 14,
    align: "left",
    stateDot: true,
  };
}

/** The one planted change of each kind. */
function plant(look: ComponentLook, kind: PlantedKind, strong: boolean): ComponentLook {
  switch (kind) {
    case "colour": {
      const [r, g, b, a] = look.fill;
      const shift = strong ? 80 : 40;
      return {
        ...look,
        fill: [Math.min(255, r + shift), g, Math.max(0, b - shift), a],
      };
    }
    case "spacing":
      return { ...look, padding: look.padding + (strong ? 8 : 3) };
    case "copy":
      return strong
        ? { ...look, letters: [...look.letters.slice(0, -1)] }
        : { ...look, letters: look.letters.map((w, i) => (i === 1 ? w + 3 : w)) };
    case "missing_state":
      return { ...look, stateDot: false };
    case "font":
      return { ...look, letterHeight: look.letterHeight + (strong ? 4 : 2) };
    case "alignment":
      return { ...look, align: look.align === "left" ? "center" : "left" };
  }
}

const KINDS: readonly PlantedKind[] = [
  "colour",
  "spacing",
  "copy",
  "missing_state",
  "font",
  "alignment",
];

const SPEC = [
  "## Status button",
  "",
  "- The fill is the brand colour shown in the approved option.",
  "- The label starts 14 pixels from the left edge and is vertically centred.",
  "- The label text is exactly as in the approved option.",
  "- A green status dot shows on the right when the item is active.",
  "- Label letters are 8 pixels high.",
].join("\n");

/** The 20 pairs, in a fixed order: identical and planted alternate. */
export function syntheticPairs(): SyntheticPair[] {
  const pairs: SyntheticPair[] = [];
  for (let i = 0; i < 20; i++) {
    const look = baseLook(i);
    const kindIndex = Math.floor(i / 2);
    const planted =
      i % 2 === 1 ? (KINDS[kindIndex % KINDS.length] as PlantedKind) : null;
    // The second round of kinds is the subtle one: a smaller change of the same kind.
    const strong = kindIndex < KINDS.length;
    const builtLook = planted ? plant(look, planted, strong) : look;
    const page = draw(solidRaster(360, 200, WHITE), 60, 50, look);
    const built = draw(
      solidRaster(look.width + 40, look.height + 40, WHITE),
      20,
      20,
      builtLook,
    );
    pairs.push({
      id: `pair-${String(i + 1).padStart(2, "0")}`,
      planted,
      note: planted
        ? planted === "missing_state" || planted === "alignment"
          ? `${planted} change`
          : `${strong ? "clear" : "subtle"} ${planted} change`
        : "identical",
      optionPage: page,
      region: { x: 50, y: 40, width: look.width + 20, height: look.height + 20 },
      built,
      spec: SPEC,
    });
  }
  return pairs;
}
