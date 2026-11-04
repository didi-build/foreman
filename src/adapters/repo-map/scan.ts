// The Scanner's stage 1 read (D-299, D-300, O-92), inside the repo map Job's scan mode only
// (src/agent-images/repo-map/). It downloads the archive at one commit as the map does
// (./github.ts `readArchiveAt`), keeping the text of the Markdown and contract files besides the
// code, builds the repo map for the gallery registry's resolved imports (./typescript.ts, which
// parses and never runs code), parses each contract file as YAML (parse only), and runs the fixed
// checks (src/core/scan.ts). Its result is the checks' findings, counted and bounded, and where a
// check could not run (`scanNotRun`, D-301, O-93): the registry check with no registry, and a file
// whose text was too large to keep; the runner checks it again as untrusted data. Nothing here
// runs project code or writes anywhere.
import { parseAllDocuments } from "yaml";

import {
  GALLERY_REGISTRY,
  isContractFile,
  runScanChecks,
  scanNotRun,
  scanReadsText,
  scanResult,
  type ScanInput,
} from "../../core/scan.ts";
import type { GitHubHttp } from "../github/runner-app-tokens.ts";
import { readArchiveAt } from "./github.ts";
import { buildRepoMap } from "./typescript.ts";

/** The line of a YAML text's first problem, 0 when it has none, null when its line is unknown. */
export function yamlProblemLine(text: string): number | null | 0 {
  let documents: ReturnType<typeof parseAllDocuments>;
  try {
    documents = parseAllDocuments(text);
  } catch {
    return null;
  }
  const list = Array.isArray(documents) ? documents : [documents];
  for (const document of list) {
    const error = document.errors[0];
    if (error) return error.linePos?.[0]?.line ?? null;
  }
  return 0;
}

/**
 * The checks' input from an unpacked checkout (path to text, as `readTarball` gives it), with
 * the files whose text was too large to keep.
 */
export function scanInputFrom(
  commitSha: string,
  files: ReadonlyMap<string, string>,
  tooLarge: ReadonlySet<string> = new Set(),
): ScanInput {
  const paths = [...files.keys()].sort();
  const texts = new Map<string, string>();
  for (const path of paths) {
    if (scanReadsText(path) || /\.gallery\.tsx?$/.test(path)) {
      texts.set(path, files.get(path) ?? "");
    }
  }
  // The registry's imports as the repo map resolves them (a `.js` specifier finds its `.ts`).
  const registry = files.has(GALLERY_REGISTRY)
    ? buildRepoMap(commitSha, files).files.find((f) => f.path === GALLERY_REGISTRY)
    : undefined;
  const unparsableContracts: { path: string; line: number | null }[] = [];
  for (const path of paths) {
    if (!isContractFile(path)) continue;
    const line = yamlProblemLine(files.get(path) ?? "");
    if (line !== 0) unparsableContracts.push({ path, line });
  }
  return {
    paths,
    texts,
    registryImports: registry ? registry.imports : null,
    unparsableContracts,
    unread: paths.filter((p) => tooLarge.has(p)),
  };
}

/** The scan of the code at `commitSha`: the archive downloaded, unpacked in memory and checked. */
export async function readScanAt(
  http: GitHubHttp,
  repo: string,
  commitSha: string,
  token: string,
) {
  const tooLarge = new Set<string>();
  const files = await readArchiveAt(
    http,
    repo,
    commitSha,
    token,
    scanReadsText,
    tooLarge,
  );
  const input = scanInputFrom(commitSha, files, tooLarge);
  return scanResult(commitSha, runScanChecks(input), scanNotRun(input));
}
