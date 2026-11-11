// The one way code reads the repository files a flow needs when it runs (O-117, O-121): the
// contracts, the task types and the bot files under contracts/, and Supabase's CA certificate.
// `flows/windmill.yaml` lists them as `bundle_files`. A Windmill job may not see files beside its
// bundle (nsjail mounts only named files), so the deploy embeds them in each bundle, and this
// module reads them from there.
//
// How a bundle provides them: its bundler defines the global name in BUNDLE_FILES_DEFINE as a
// JSON object, each key a file's path from the repository root (`contracts/bots/qa.yaml`) and
// each value the file's bytes in base64. With esbuild that is the `define` option, built by
// `bundleFilesDefine` in ./embed.ts. Once the map is there, every read comes from it and nothing
// is read from disk: a path the map lacks is refused, never looked up on disk. Without the map
// (tests, local runs, the services' images), every read is the file on disk, relative to the
// working directory, exactly as before.
//
// Errors name the path, never a file's content.
import { readFileSync, readdirSync } from "node:fs";
import { posix } from "node:path";

/** The global name the bundler defines as the embedded map (esbuild `define`). */
export const BUNDLE_FILES_DEFINE = "__FOREMAN_BUNDLE_FILES__";

// Replaced by the bundler's `define`; undefined everywhere else.
declare const __FOREMAN_BUNDLE_FILES__: unknown;

export interface BundleFiles {
  /** The file's bytes. */
  read(path: string): Buffer;
  /** The names directly inside the folder `dir`, files and folders. */
  list(dir: string): string[];
}

/** A read the embedded map cannot serve. Names the path only. */
export class BundleFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleFileError";
  }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A plain relative path: no `.` or `..` segment, no empty segment, no leading `/`. */
function isPlainPath(path: string): boolean {
  return (
    path !== "" &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** The files on disk, relative to the working directory. */
const disk: BundleFiles = {
  read: (path) => readFileSync(path),
  list: (dir) => readdirSync(dir),
};

function embedded(map: unknown): BundleFiles {
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    throw new BundleFileError(
      "The bundle's embedded files are not a map of repository paths to base64 text.",
    );
  }
  const files = new Map<string, Buffer>();
  for (const [path, value] of Object.entries(map)) {
    if (!isPlainPath(path) || typeof value !== "string" || !BASE64.test(value)) {
      throw new BundleFileError(
        "The bundle's embedded files are not a map of repository paths to base64 text.",
      );
    }
    files.set(path, Buffer.from(value, "base64"));
  }
  // The key a caller's path has in the map, or null for one no key can match.
  const keyOf = (path: string): string | null => {
    const normal = posix.normalize(path).replace(/\/+$/, "");
    return isPlainPath(normal) ? normal : null;
  };
  return {
    read: (path) => {
      const key = keyOf(path);
      const bytes = key === null ? undefined : files.get(key);
      if (bytes === undefined) {
        throw new BundleFileError(`${path} is not among the bundle's files.`);
      }
      return Buffer.from(bytes);
    },
    list: (dir) => {
      const key = keyOf(dir);
      const names = new Set<string>();
      if (key !== null) {
        for (const path of files.keys()) {
          if (path.startsWith(`${key}/`)) {
            names.add(path.slice(key.length + 1).split("/")[0] ?? "");
          }
        }
      }
      if (names.size === 0) {
        throw new BundleFileError(`${dir} is not a folder among the bundle's files.`);
      }
      return [...names].sort();
    },
  };
}

/**
 * The bundle's files: the embedded map when one is given, the files on disk otherwise. Code reads
 * through `readBundledFile` and `listBundledFolder`; tests call this to check both paths.
 */
export function bundleFiles(map: unknown): BundleFiles {
  return map === undefined ? disk : embedded(map);
}

const definedMap: unknown =
  typeof __FOREMAN_BUNDLE_FILES__ === "undefined"
    ? undefined
    : __FOREMAN_BUNDLE_FILES__;
let active: BundleFiles | undefined;
const files = (): BundleFiles => (active ??= bundleFiles(definedMap));

/** The bytes of a bundle file, by its path from the repository root. */
export const readBundledFile = (path: string): Buffer => files().read(path);

/** The names directly inside a bundle folder, by its path from the repository root. */
export const listBundledFolder = (dir: string): string[] => files().list(dir);
