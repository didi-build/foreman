// Seam: each flow entry as the deploy bundles it (integration: esbuild on the real entries, O-121).
// Every entry in flows/windmill.yaml is bundled once, as Windmill's codebase mode runs it (CommonJS
// on Node), and its input graph is checked: no TypeScript compiler (it runs only in the repo map
// Job's image), no repository module but the bundle files reader touches the file system, and no
// flow carries Windmill's run route, so none starts another Windmill job. Then a small probe that
// imports the real loaders is bundled with the files embedded by `bundleFilesDefine` and run with
// Node in an empty folder: it reads the same bytes as the files on disk, refuses what the map
// lacks instead of reading the disk, and keeps the CA certificate's checks. Nothing is deployed
// and nothing reaches Windmill.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { build, type BuildOptions, type Metafile } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { bundleFilesDefine } from "../../src/adapters/bundle-files/embed.ts";
import { BUNDLE_FILES_DEFINE } from "../../src/adapters/bundle-files/files.ts";
import { loadBotFiles } from "../../src/adapters/contracts-file/bot-files.ts";
import {
  loadAllContractFiles,
  loadTaskTypesFile,
} from "../../src/adapters/contracts-file/load.ts";
import {
  readDatabaseCa,
  SUPABASE_CA_PATH,
} from "../../src/adapters/store-postgres/tls.ts";

const ROOT = resolve(".");
const description = parse(readFileSync("flows/windmill.yaml", "utf8")) as {
  bundle_files: string[];
  flows: { name: string; entry: string }[];
};
const entries = [...new Set(description.flows.map((flow) => flow.entry))].sort();

/** The options the deploy's bundle job is expected to use (research note, section 1). */
const BUNDLE_OPTIONS = {
  absWorkingDir: ROOT,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["pg-native"],
  logLevel: "silent",
} satisfies BuildOptions;

const TYPESCRIPT_PACKAGE = /(^|\/)node_modules\/typescript\//;
const FILE_SYSTEM = /^(node:)?fs(\/promises)?$/;
const READER = "src/adapters/bundle-files/files.ts";

let metafile: Metafile;
let outputs: Map<string, { inputs: string[]; text: string }>;

beforeAll(async () => {
  const result = await build({
    ...BUNDLE_OPTIONS,
    entryPoints: entries.map((entry) => `./${entry}`),
    outdir: "bundle-test-out",
    write: false,
    metafile: true,
  });
  metafile = result.metafile;
  const texts = new Map(result.outputFiles.map((file) => [file.path, file.text]));
  outputs = new Map(
    Object.entries(metafile.outputs)
      .filter(([, output]) => output.entryPoint !== undefined)
      .map(([path, output]) => [
        output.entryPoint ?? "",
        {
          inputs: Object.keys(output.inputs),
          text: texts.get(resolve(ROOT, path)) ?? "",
        },
      ]),
  );
}, 120_000);

describe("each flow entry's bundle (integration: esbuild, O-121)", () => {
  it("bundles every entry the description lists", () => {
    expect([...outputs.keys()].sort()).toEqual(entries);
    for (const entry of entries) {
      expect(outputs.get(entry)?.text.length, entry).toBeGreaterThan(0);
    }
  });

  it.each(entries)("%s carries no TypeScript compiler", (entry) => {
    const inputs = outputs.get(entry)?.inputs ?? [];
    expect(inputs).toContain(entry);
    expect(inputs.filter((input) => TYPESCRIPT_PACKAGE.test(input))).toEqual([]);
    expect(inputs).not.toContain("src/adapters/repo-map/typescript.ts");
    expect(inputs).not.toContain("src/adapters/repo-map/github.ts");
  });

  it("the check finds the compiler where it is: the repo map Job's own module", async () => {
    const result = await build({
      ...BUNDLE_OPTIONS,
      entryPoints: ["./src/adapters/repo-map/github.ts"],
      outdir: "bundle-test-out",
      write: false,
      metafile: true,
    });
    expect(
      Object.keys(result.metafile.inputs).some((i) => TYPESCRIPT_PACKAGE.test(i)),
    ).toBe(true);
  });

  it("reads the file system through the bundle files reader only", () => {
    const readers = Object.entries(metafile.inputs)
      .filter(([path]) => !path.includes("node_modules/"))
      .filter(([, input]) => input.imports.some((i) => FILE_SYSTEM.test(i.path)))
      .map(([path]) => path);
    expect(readers).toEqual([READER]);
  });

  it.each(entries)("%s starts no Windmill job: it holds no run route", (entry) => {
    expect(outputs.get(entry)?.text).not.toMatch(/jobs\/run|jobs_u\//);
  });
});

/** A probe of every loader the flows use, printed as JSON; a refusal prints its message. */
const PROBE = `
import { createHash } from "node:crypto";
import { loadBotFiles } from "./src/adapters/contracts-file/bot-files.ts";
import { loadAllContractFiles, loadTaskTypesFile } from "./src/adapters/contracts-file/load.ts";
import { readDatabaseCa } from "./src/adapters/store-postgres/tls.ts";
const attempt = (read: () => unknown) => {
  try {
    return read();
  } catch (error) {
    return { refused: (error as Error).message };
  }
};
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
console.log(JSON.stringify({
  contracts: attempt(() => loadAllContractFiles("probe").contentHash),
  taskTypes: attempt(() => sha(JSON.stringify(loadTaskTypesFile()))),
  bots: attempt(() => Object.fromEntries(Object.entries(loadBotFiles()).map(([r, f]) => [r, f.version]))),
  ca: attempt(() => sha(readDatabaseCa())),
}));
`;

const work: string[] = [];
afterAll(() => {
  for (const dir of work.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Bundles the probe with `define`, runs it with Node in `cwd` and returns what it printed. */
async function runProbe(
  define: Record<string, string> | undefined,
  cwd: string | "empty",
): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "bundle-probe-"));
  work.push(dir);
  const outfile = join(dir, "probe.cjs");
  await build({
    ...BUNDLE_OPTIONS,
    stdin: { contents: PROBE, resolveDir: ROOT, loader: "ts", sourcefile: "probe.ts" },
    outfile,
    ...(define === undefined ? {} : { define }),
  });
  const empty = join(dir, "empty");
  if (cwd === "empty") mkdirSync(empty);
  const printed = execFileSync(process.execPath, [outfile], {
    cwd: cwd === "empty" ? empty : cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  return JSON.parse(printed) as Record<string, unknown>;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("the bundle files embedded by the deploy (integration: esbuild and Node, O-121)", () => {
  it("reads from the bundle exactly what the files on disk hold, in a folder that has none of them", async () => {
    const fromDisk = {
      contracts: loadAllContractFiles("probe").contentHash,
      taskTypes: sha(JSON.stringify(loadTaskTypesFile())),
      bots: Object.fromEntries(
        Object.entries(loadBotFiles()).map(([role, file]) => [role, file.version]),
      ),
      ca: sha(readDatabaseCa()),
    };
    expect(
      await runProbe(bundleFilesDefine(description.bundle_files), "empty"),
    ).toEqual(fromDisk);
  }, 60_000);

  it("without the embedded map, the same bundle finds nothing there, so the bundle is what served", async () => {
    const printed = await runProbe(undefined, "empty");
    for (const key of ["contracts", "taskTypes", "bots"]) {
      expect(printed[key], key).toHaveProperty("refused");
    }
    expect(printed.ca).toEqual({
      refused: `The database CA certificate is missing at ${SUPABASE_CA_PATH}.`,
    });
  }, 60_000);

  it("refuses a file the map lacks even where the disk has it, and keeps the CA certificate's checks", async () => {
    const withoutCa = await runProbe(bundleFilesDefine(["contracts/"]), ROOT);
    expect(withoutCa.contracts).toBe(loadAllContractFiles("probe").contentHash);
    expect(withoutCa.ca).toEqual({
      refused: `The database CA certificate is missing at ${SUPABASE_CA_PATH}.`,
    });
    const notCa = await runProbe(
      {
        [BUNDLE_FILES_DEFINE]: JSON.stringify({
          [SUPABASE_CA_PATH]: Buffer.from("not a certificate\n").toString("base64"),
        }),
      },
      ROOT,
    );
    expect(notCa.ca).toEqual({
      refused: `The database CA certificate at ${SUPABASE_CA_PATH} is not a PEM CA certificate.`,
    });
    expect(notCa.contracts).toEqual({
      refused: "contracts/machine-1 is not a folder among the bundle's files.",
    });
  }, 60_000);
});
