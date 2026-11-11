// Builds the embedded map ./files.ts reads, for the deploy's bundler (O-121). It runs at build
// time only, on a checkout, and is never part of a flow's bundle. The deploy slice calls
//
//   esbuild.build({ ..., define: bundleFilesDefine(description.bundle_files) })
//
// with `bundle_files` from flows/windmill.yaml, run from the repository root. Each entry is a
// file, or a folder ending in `/` that stands for every file under it. Every key is the file's path
// from the repository root and every value its bytes in base64, so each file reaches the bundle
// byte for byte, and the content hashes the runner records are the ones of the files in git. Keys
// are sorted, so the same checkout always gives the same bundle.
//
// A missing entry, a path that is not plain, an entry that names no file, and anything that is not
// a plain file or folder (a symbolic link) are refused, naming the path.
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";

import { BUNDLE_FILES_DEFINE } from "./files.ts";

/** A plain relative path, as `bundle_files` writes it: no `.`, `..` or empty segment. */
function isPlainEntry(entry: string): boolean {
  const path = entry.endsWith("/") ? entry.slice(0, -1) : entry;
  return (
    path !== "" &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** What a path is: a plain file, a folder, anything else (a symbolic link), or nothing. */
function kindOf(path: string): "file" | "folder" | "other" | "missing" {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? "file" : stat.isDirectory() ? "folder" : "other";
  } catch {
    return "missing";
  }
}

/** Every file under `dir`, as paths from the root joined with `/`. */
function filesUnder(root: string, dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(join(root, dir)).sort()) {
    const path = posix.join(dir, name);
    const kind = kindOf(join(root, path));
    if (kind === "folder") found.push(...filesUnder(root, path));
    else if (kind === "file") found.push(path);
    else throw new Error(`${path} is neither a plain file nor a folder`);
  }
  return found;
}

/** The map of every file `entries` names, from `root` (the repository root). */
export function embeddedBundleFiles(
  entries: readonly string[],
  root = ".",
): Record<string, string> {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (!isPlainEntry(entry)) throw new Error(`${entry} is not a plain relative path`);
    const wanted = entry.endsWith("/") ? "folder" : "file";
    if (kindOf(join(root, entry)) !== wanted) {
      throw new Error(`${entry} is not a ${wanted}`);
    }
    const found = wanted === "folder" ? filesUnder(root, entry.slice(0, -1)) : [entry];
    if (found.length === 0) throw new Error(`${entry} names no file`);
    for (const path of found) paths.add(path);
  }
  const map: Record<string, string> = {};
  for (const path of [...paths].sort()) {
    map[path] = readFileSync(join(root, path)).toString("base64");
  }
  return map;
}

/** The esbuild `define` that embeds the files: the global name and the map as JSON. */
export function bundleFilesDefine(
  entries: readonly string[],
  root = ".",
): Record<string, string> {
  return { [BUNDLE_FILES_DEFINE]: JSON.stringify(embeddedBundleFiles(entries, root)) };
}
