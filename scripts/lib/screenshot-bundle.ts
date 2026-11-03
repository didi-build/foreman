// The plain parts of CI's render step for the screenshot bundles (D-242, D-255, D-275 point 1,
// D-281): which option folders to render, file names inside a bundle, the regions an option page marks,
// writing the bundle and checking it with the runner's own manifest check
// (src/core/visual-comparison.ts `readScreenshotManifest`) and PNG reader. The browser part is in
// scripts/render-screenshots.ts. Problems are fixed text plus the repository path they concern.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { MANIFEST } from "../../src/adapters/screenshots/github-artifacts.ts";
import { pngCodec } from "../../src/adapters/screenshots/png.ts";
import {
  readScreenshotManifest,
  regionFromMarker,
  type BundleKind,
  type GalleryShot,
  type OptionRegion,
  type OptionShot,
  type SpecFile,
} from "../../src/core/visual-comparison.ts";
import type { Region } from "../../src/core/visual-diff.ts";

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

// ---- Option folders ------------------------------------------------------------------------------

/** An option folder `design/<area>/<feature>/options/<name>` and the file under it. */
const OPTION_FILE = /^(design\/[^/]+\/[^/]+\/options\/([^/]+))\/./;
/** Option names as the runner's manifest check takes them. */
const OPTION_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The page CI renders in each option folder. */
export const OPTION_PAGE = "index.html";

export interface OptionFolder {
  option: string;
  path: string;
}

/**
 * The option folders to render, from the commit's tracked files. With `changed` (the files the
 * pull request changes), only folders with a changed file under them. A folder whose name the
 * manifest would refuse, a folder without `index.html`, or two folders of the same option name
 * are problems, so the step fails instead of writing a bundle the runner refuses.
 */
export function optionFolders(
  tracked: readonly string[],
  changed?: readonly string[],
): { folders: OptionFolder[] } | { problem: string } {
  const found = listOptionFolders(tracked, changed);
  if ("problem" in found) return found;
  const names = new Set(found.folders.map((f) => f.option));
  if (names.size !== found.folders.length) {
    return { problem: "two option folders in this pull request have the same name" };
  }
  return found;
}

/**
 * Every option folder tracked at the commit, for the `head-options` bundle the visual comparison
 * reads (D-281). After a feature's spec step only its approved option's folder stays (D-253), so
 * this is one folder per designed feature plus the options of features still being explored.
 * Option names repeat across features, so folders are told apart by path, not by name. A folder
 * whose name the manifest would refuse, or one without `index.html`, is a problem.
 */
export function headOptionFolders(
  tracked: readonly string[],
): { folders: OptionFolder[] } | { problem: string } {
  return listOptionFolders(tracked);
}

function listOptionFolders(
  tracked: readonly string[],
  changed?: readonly string[],
): { folders: OptionFolder[] } | { problem: string } {
  const files = new Map<string, Set<string>>();
  for (const file of tracked) {
    const m = OPTION_FILE.exec(file);
    if (!m) continue;
    const folder = m[1] as string;
    const set = files.get(folder) ?? new Set<string>();
    set.add(file.slice(folder.length + 1));
    files.set(folder, set);
  }
  const touched = (folder: string) =>
    changed === undefined || changed.some((f) => f.startsWith(`${folder}/`));
  const folders: OptionFolder[] = [];
  for (const [path, inside] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!touched(path)) continue;
    const option = path.slice(path.lastIndexOf("/") + 1);
    if (!OPTION_NAME.test(option)) {
      return {
        problem: `${path}: an option folder's name must be lowercase letters, digits and hyphens`,
      };
    }
    if (!inside.has(OPTION_PAGE)) {
      return { problem: `${path}: an option folder has no ${OPTION_PAGE} to render` };
    }
    folders.push({ option, path });
  }
  return { folders };
}

// ---- File names inside a bundle ------------------------------------------------------------------

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "") || "variant";

/** A gallery shot's file: the entry, the variant's place in its entry and its name. */
export const galleryShotFile = (component: string, index: number, variant: string) =>
  `shots/${component}/${String(index + 1).padStart(2, "0")}-${slug(variant)}.png`;

/** A spec file's copy in the gallery bundle. */
export const specFile = (specPath: string) => `specs/${specPath}`;

/** An option page's file in the options bundle. */
export const optionPageFile = (path: string) => `pages/${path}.png`;

// ---- Regions -------------------------------------------------------------------------------------

/** One element of an option page with a `data-component` attribute, as the browser reports it. */
export interface MarkedElement {
  attributes: Record<string, string | undefined>;
  /** Its box on the whole page, in CSS pixels, before rounding. */
  box: Region;
}

/**
 * The regions an option page marks (D-255), on a page of the given size. Each box is rounded out to
 * whole pixels and kept inside the page. A marker with a bad name, an element with no visible box,
 * or the same component and variant marked twice is a problem, so the step fails.
 */
export function optionRegions(
  marked: readonly MarkedElement[],
  page: { width: number; height: number },
): { regions: OptionRegion[] } | { problem: string } {
  const regions: OptionRegion[] = [];
  const seen = new Set<string>();
  for (const { attributes, box } of marked) {
    const x0 = Math.max(0, Math.floor(box.x));
    const y0 = Math.max(0, Math.floor(box.y));
    const x1 = Math.min(page.width, Math.ceil(box.x + box.width));
    const y1 = Math.min(page.height, Math.ceil(box.y + box.height));
    const rounded = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    const region = regionFromMarker(attributes, rounded);
    if (!region) {
      return {
        problem:
          "a data-component or data-variant marker is not a gallery name (lowercase letters, digits and hyphens for the component)",
      };
    }
    if (rounded.width < 1 || rounded.height < 1) {
      return {
        problem: `the marked component ${region.component} has no visible box on the page`,
      };
    }
    const key = `${region.component}\n${region.variant ?? ""}`;
    if (seen.has(key)) {
      return {
        problem: `the page marks component ${region.component}${region.variant === null ? "" : ` variant ${region.variant}`} twice`,
      };
    }
    seen.add(key);
    regions.push(region);
  }
  return { regions };
}

// ---- Writing and checking a bundle ---------------------------------------------------------------

export type BundleManifest =
  | {
      foremanScreenshots: 1;
      kind: "gallery";
      commit: string;
      shots: GalleryShot[];
      specs: SpecFile[];
    }
  | {
      foremanScreenshots: 1;
      kind: "options" | "head-options";
      commit: string;
      options: OptionShot[];
    };

/** A rendered gallery variant before it is written. */
export interface RenderedShot {
  component: string;
  variant: string;
  /** The variant's place in its entry, for its file name. */
  index: number;
  specPath: string;
  png: Uint8Array;
}

/** A rendered option page before it is written. */
export interface RenderedOption extends OptionFolder {
  png: Uint8Array;
  regions: OptionRegion[];
}

export interface Bundle {
  manifest: BundleManifest;
  files: Map<string, Uint8Array>;
}

const size = (png: Uint8Array) => {
  const raster = pngCodec.decode(png);
  return { width: raster.width, height: raster.height };
};

/** The gallery bundle: each shot's PNG and each spec file once, with the version 1 manifest. */
export function galleryBundle(
  commit: string,
  shots: readonly RenderedShot[],
  specs: ReadonlyMap<string, Uint8Array>,
): Bundle {
  const files = new Map<string, Uint8Array>();
  const manifestShots: GalleryShot[] = shots.map((s) => {
    const file = galleryShotFile(s.component, s.index, s.variant);
    files.set(file, s.png);
    return {
      component: s.component,
      variant: s.variant,
      file,
      sha256: sha256(s.png),
      ...size(s.png),
      specPath: s.specPath,
    };
  });
  const manifestSpecs: SpecFile[] = [...specs].map(([path, bytes]) => {
    const file = specFile(path);
    files.set(file, bytes);
    return { path, file, sha256: sha256(bytes) };
  });
  return {
    manifest: {
      foremanScreenshots: 1,
      kind: "gallery",
      commit,
      shots: manifestShots,
      specs: manifestSpecs,
    },
    files,
  };
}

/**
 * The options bundle, or with `kind` the `head-options` bundle (D-281): each option page's PNG
 * and the regions it marks. The file is named by the folder, so two features' options of one name
 * never share a file.
 */
export function optionsBundle(
  commit: string,
  options: readonly RenderedOption[],
  kind: "options" | "head-options" = "options",
): Bundle {
  const files = new Map<string, Uint8Array>();
  const manifestOptions: OptionShot[] = options.map((o) => {
    const file = optionPageFile(o.path);
    files.set(file, o.png);
    return {
      option: o.option,
      path: o.path,
      file,
      sha256: sha256(o.png),
      ...size(o.png),
      regions: o.regions,
    };
  });
  return {
    manifest: {
      foremanScreenshots: 1,
      kind,
      commit,
      options: manifestOptions,
    },
    files,
  };
}

/** Writes the bundle's files and `manifest.json` into an empty or new folder. */
export function writeBundle(dir: string, bundle: Bundle): void {
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length > 0) throw new Error(`${dir} is not empty`);
  for (const [file, bytes] of bundle.files) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(bundle.manifest, null, 2)}\n`);
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(dir, join(d.parentPath, d.name)).split(sep).join("/"))
    .sort();
}

export interface BundleSummary {
  kind: BundleKind;
  /** Gallery shots or option pages. */
  images: number;
  /** Spec files (gallery) or marked regions (options). */
  extras: number;
}

/**
 * Reads a written bundle back as the runner will: the manifest through the runner's strict check
 * for this commit and kind, every file it names present with its SHA-256, every PNG readable by
 * the runner's PNG reader at the size the manifest gives, and no file the manifest does not name.
 */
export function checkBundle(
  dir: string,
  commit: string,
  kind: BundleKind,
): { summary: BundleSummary } | { problem: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
  } catch {
    return { problem: "manifest.json is missing or not JSON" };
  }
  const read = readScreenshotManifest(raw, commit, kind);
  if ("problem" in read) return { problem: read.problem };
  const manifest = read.manifest;
  const images =
    manifest.kind === "gallery"
      ? manifest.shots.map((s) => ({
          file: s.file,
          sha256: s.sha256,
          w: s.width,
          h: s.height,
        }))
      : manifest.options.map((o) => ({
          file: o.file,
          sha256: o.sha256,
          w: o.width,
          h: o.height,
        }));
  const others = manifest.kind === "gallery" ? manifest.specs : [];
  const named = new Set<string>([MANIFEST]);
  for (const { file, sha256: hash } of [...images, ...others]) {
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(join(dir, file));
    } catch {
      return { problem: `the bundle has no file ${file}` };
    }
    if (sha256(bytes) !== hash)
      return { problem: `${file} does not match its SHA-256` };
    named.add(file);
  }
  for (const { file, w, h } of images) {
    let got: { width: number; height: number };
    try {
      got = size(readFileSync(join(dir, file)));
    } catch {
      return { problem: `${file} is not a PNG the runner can read` };
    }
    if (got.width !== w || got.height !== h) {
      return { problem: `${file} is not the size the manifest gives` };
    }
  }
  const extra = listFiles(dir).filter((f) => !named.has(f));
  if (extra.length > 0)
    return { problem: `the bundle has a file the manifest does not name: ${extra[0]}` };
  return {
    summary: {
      kind,
      images: images.length,
      extras:
        manifest.kind === "gallery"
          ? manifest.specs.length
          : manifest.options.reduce((n, o) => n + o.regions.length, 0),
    },
  };
}
