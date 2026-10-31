// Keeps repository code out of OpenCode's start (docs/spikes/opencode-runtime.md, finding 6a).
// OpenCode 1.19.5 imports plugins from a `.opencode` folder and from the `plugin` list of an
// `opencode.json` it finds from its working folder upward, even with `--pure` and
// OPENCODE_DISABLE_PROJECT_CONFIG. A plugin runs inside OpenCode's process, before any tool rule,
// so the wrapper refuses to start when its working folder or any folder above it holds one of
// these. A file committed by an earlier run then fails the next run visibly instead of running.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const REPOSITORY_CONFIG_NAMES = [".opencode", "opencode.json", "opencode.jsonc"];

/** Throws, naming the file but not the folder, when OpenCode would load repository config. */
export function refuseRepositoryConfig(
  workDir: string,
  exists: (path: string) => boolean = existsSync,
): void {
  let folder = resolve(workDir);
  for (;;) {
    for (const name of REPOSITORY_CONFIG_NAMES) {
      if (exists(resolve(folder, name))) {
        throw new Error(
          `the working folder or a folder above it has ${name}, which OpenCode would load; the run is refused`,
        );
      }
    }
    const parent = dirname(folder);
    if (parent === folder) return;
    folder = parent;
  }
}
