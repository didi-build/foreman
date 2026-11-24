// Seam: unit, a fake store of recorded evidence and a fake `QaSites` port. The site QA will
// browse (ADR 0119 slice 5a, D-476 to D-480, O-174): the head's changed paths and preview check
// come from the runner's evidence on that commit; a PR that changes the site's build or its
// server gets no browser and nothing is read; the port is asked for exactly the preview check's
// run; and the site passes only with plain paths, no link, within the bounds, with `index.html`
// and the marker of the head at its root. Each refusal is its fixed reason, which fits "No browser
// in this run: <reason>" and names nothing from the build. Synthetic entries; no network.
import { describe, expect, it } from "vitest";

import type { BuiltSiteEntry } from "./built-site.ts";
import {
  checkQaSite,
  isQaSitePipelinePath,
  QA_SITE_ARTIFACT,
  QA_SITE_LIMITS,
  QA_SITE_MAX_ZIP_BYTES,
  QA_SITE_PIPELINE_PATHS,
  QA_SITE_REASONS,
  type QaSiteCheck,
  type QaSiteRead,
  type QaSites,
} from "./qa-site.ts";
import type { Evidence, EvidenceKind, Json, StoreOps } from "./store.ts";

const NODE = "node-1";
const REPO = "didi-build/foreman";
const HEAD = "c".repeat(40);
const OTHER = "d".repeat(40);
const RUN = 4242;
const ZIP = new Uint8Array([0x50, 0x4b, 5, 6]);
const MIB = 1024 * 1024;

const bytes = (data: string | Uint8Array) =>
  typeof data === "string" ? new TextEncoder().encode(data) : data;
const file = (path: string, data: string | Uint8Array = "x", symlink = false) =>
  ({ path, bytes: bytes(data), symlink }) satisfies BuiltSiteEntry;

/** A site as CI's preview check keeps it: the gallery's files and the marker of the head. */
const SITE = [
  file("index.html", '<html><script src="/assets/index-1.js"></script></html>'),
  file("assets/index-1.js", "console.log(1)"),
  file("assets/index-1.css", "a{}"),
  file("foreman-commit.txt", `${HEAD}\n`),
];

let ids = 0;
function evidence(kind: EvidenceKind, payload: Json, commitSha = HEAD): Evidence {
  ids += 1;
  return {
    id: `e-${ids}`,
    nodeId: NODE,
    runId: null,
    kind,
    ref: "r",
    commitSha,
    payload,
    recordedBy: "runner",
    recordedAt: new Date(Date.UTC(2026, 10, 24, 12, ids)),
    supersedesId: null,
  };
}

const ciRun = (changedPaths?: string[], commitSha = HEAD) =>
  evidence(
    "ci_run",
    { conclusion: "success", pr: 7, ...(changedPaths ? { changedPaths } : {}) },
    commitSha,
  );
const previewCheck = (fields: Record<string, Json> = {}, commitSha = HEAD) =>
  evidence(
    "preview_check",
    {
      pass: true,
      conclusion: "success",
      pr: 7,
      workflowRunId: RUN,
      jobId: 9,
      ...fields,
    },
    commitSha,
  );

/** The usual evidence on the head: a PR that changes app code, and a passing preview check. */
const recorded = () => [ciRun(["src/app.ts", "README.md"]), previewCheck()];

/** Oldest first, filtered as the store filters, by node, kind and commit. */
function fakeStore(rows: Evidence[]): Pick<StoreOps, "listEvidence"> {
  return {
    async listEvidence({ nodeId, kind, commitSha }) {
      return rows.filter(
        (e) =>
          e.nodeId === nodeId &&
          (kind === undefined || e.kind === kind) &&
          (commitSha === undefined || e.commitSha === commitSha),
      );
    },
  };
}

function fakeSites(answer: QaSiteRead) {
  const asked: [string, number][] = [];
  const sites: QaSites = {
    async read(repo, workflowRunId) {
      asked.push([repo, workflowRunId]);
      return answer;
    },
  };
  return { sites, asked };
}

const found = (entries: BuiltSiteEntry[], zip = ZIP): QaSiteRead => ({
  found: true,
  zip,
  entries,
});

async function check(
  answer: QaSiteRead,
  rows: Evidence[] = recorded(),
  headSha = HEAD,
): Promise<{ result: QaSiteCheck; asked: [string, number][] }> {
  const { sites, asked } = fakeSites(answer);
  const result = await checkQaSite(
    { store: fakeStore(rows), sites },
    { nodeId: NODE, repo: REPO, headSha },
  );
  return { result, asked };
}

const refusal = (result: QaSiteCheck) =>
  result.browser ? null : { reason: result.reason, text: result.text };

const noBrowser = (reason: keyof typeof QA_SITE_REASONS) => ({
  reason,
  text: QA_SITE_REASONS[reason],
});

describe("the site QA will browse (unit, ADR 0119 slice 5a, O-174)", () => {
  it("gives the site of the preview check's run when every rule passes", async () => {
    const { result, asked } = await check(found(SITE));
    expect(result).toEqual({
      browser: true,
      site: {
        commitSha: HEAD,
        workflowRunId: RUN,
        zip: ZIP,
        files: 4,
        bytes: SITE.reduce((sum, e) => sum + e.bytes.length, 0),
      },
    });
    expect(asked).toEqual([[REPO, RUN]]);
  });

  it("reads the run of the latest preview check on the head, never one on another commit", async () => {
    const rows = [
      ciRun(["src/app.ts"]),
      previewCheck({ workflowRunId: 100 }),
      previewCheck({ workflowRunId: 200 }),
      previewCheck({ workflowRunId: 300 }, OTHER),
      ciRun([".github/workflows/ci.yml"], OTHER),
    ];
    const { result, asked } = await check(found(SITE), rows);
    expect(result.browser).toBe(true);
    expect(asked).toEqual([[REPO, 200]]);
  });

  it("refuses a head that is not a full commit sha, reading nothing", async () => {
    for (const head of ["", "C".repeat(40), "c".repeat(39), `${HEAD}\n`]) {
      const { result, asked } = await check(found(SITE), recorded(), head);
      expect(refusal(result), JSON.stringify(head)).toEqual(noBrowser("head_unknown"));
      expect(asked).toEqual([]);
    }
  });
});

describe("the pipeline rule, like D-279's (unit, O-174)", () => {
  it("names the workflow and the two scripts the preview check runs, and nothing else", () => {
    expect(QA_SITE_PIPELINE_PATHS).toEqual([
      ".github/workflows/ci.yml",
      ".github/scripts/preview-check.mjs",
      ".github/scripts/serve-site.mjs",
    ]);
    for (const path of QA_SITE_PIPELINE_PATHS)
      expect(isQaSitePipelinePath(path)).toBe(true);
    for (const path of [
      ".github/workflows/screenshots.yml",
      ".github/scripts/build-images.sh",
      ".github/workflows/ci.yml.bak",
      "x/.github/workflows/ci.yml",
      "src/app.ts",
    ]) {
      expect(isQaSitePipelinePath(path), path).toBe(false);
    }
  });

  it("gives no browser to a PR that changes the site build or its server, reading nothing", async () => {
    expect(QA_SITE_REASONS.pipeline_changed).toBe(
      "the pull request changes the site build or its server",
    );
    for (const path of QA_SITE_PIPELINE_PATHS) {
      const rows = [ciRun(["src/app.ts", path]), previewCheck()];
      const { result, asked } = await check(found(SITE), rows);
      expect(refusal(result), path).toEqual(noBrowser("pipeline_changed"));
      expect(asked).toEqual([]);
    }
  });

  it("fails closed when the head's changed paths are not recorded", async () => {
    for (const rows of [
      [previewCheck()],
      [ciRun(), previewCheck()],
      [
        evidence("ci_run", { conclusion: "success", pr: 7, changedPaths: "src/a.ts" }),
        previewCheck(),
      ],
      [evidence("ci_run", "not a payload"), previewCheck()],
      [ciRun(["src/a.ts"], OTHER), previewCheck()],
    ]) {
      const { result, asked } = await check(found(SITE), rows);
      expect(refusal(result)).toEqual(noBrowser("changed_paths_unknown"));
      expect(asked).toEqual([]);
    }
  });

  it("reads the latest ci_run on the head, so a later push that changes the pipeline is refused", async () => {
    const rows = [
      ciRun(["src/app.ts"]),
      ciRun([".github/scripts/serve-site.mjs"]),
      previewCheck(),
    ];
    expect(refusal((await check(found(SITE), rows)).result)).toEqual(
      noBrowser("pipeline_changed"),
    );
  });
});

describe("the preview check's run (unit, O-174)", () => {
  it("needs a preview check on the head that names its run and passed", async () => {
    const cases: [Evidence[], keyof typeof QA_SITE_REASONS][] = [
      [[ciRun([])], "no_preview_check"],
      [[ciRun([]), previewCheck({}, OTHER)], "no_preview_check"],
      [[ciRun([]), previewCheck({ workflowRunId: null })], "no_preview_check"],
      [[ciRun([]), previewCheck({ workflowRunId: 0 })], "no_preview_check"],
      [[ciRun([]), previewCheck({ workflowRunId: "4242" })], "no_preview_check"],
      [[ciRun([]), previewCheck({ workflowRunId: 1.5 })], "no_preview_check"],
      [[ciRun([]), previewCheck({ pass: "yes" })], "no_preview_check"],
      [
        [ciRun([]), previewCheck({ pass: false, conclusion: "failure" })],
        "preview_check_failed",
      ],
      [
        [ciRun([]), previewCheck(), previewCheck({ pass: false })],
        "preview_check_failed",
      ],
    ];
    for (const [rows, reason] of cases) {
      const { result, asked } = await check(found(SITE), rows);
      expect(refusal(result), JSON.stringify(rows.at(-1)?.payload)).toEqual(
        noBrowser(reason),
      );
      expect(asked).toEqual([]);
    }
  });

  it("gives the port's refusal as its fixed reason", async () => {
    for (const reason of [
      "missing",
      "zip_too_large",
      "download_refused",
      "archive_unreadable",
      "path_not_plain",
      "too_many_files",
      "file_too_large",
      "too_large",
    ] as const) {
      const { result, asked } = await check({ found: false, reason });
      expect(refusal(result), reason).toEqual(noBrowser(reason));
      expect(asked).toEqual([[REPO, RUN]]);
    }
  });
});

describe("the site's files (unit, O-174)", () => {
  it("refuses a path that is not plain, whatever read the zip", async () => {
    for (const path of [
      "/etc/passwd",
      "../outside.html",
      "a/../../b.html",
      "./index.html",
      "a\\b.html",
      "a\u0001.html",
      "folder/",
      "",
    ]) {
      const { result } = await check(found([...SITE, file(path)]));
      expect(refusal(result), JSON.stringify(path)).toEqual(
        noBrowser("path_not_plain"),
      );
    }
  });

  it("refuses a symbolic link", async () => {
    const { result } = await check(
      found([...SITE, file("link.html", "/etc/passwd", true)]),
    );
    expect(refusal(result)).toEqual(noBrowser("symlink"));
  });

  it("holds the bounds: 900 KiB zipped, 2,000 files, 16 MiB a file and 32 MiB in all", async () => {
    expect(QA_SITE_MAX_ZIP_BYTES).toBe(900 * 1024);
    expect(QA_SITE_LIMITS).toEqual({
      files: 2_000,
      fileBytes: 16 * MIB,
      totalBytes: 32 * MIB,
    });

    const zipAt = (size: number) => found(SITE, new Uint8Array(size));
    expect((await check(zipAt(QA_SITE_MAX_ZIP_BYTES))).result.browser).toBe(true);
    expect(refusal((await check(zipAt(QA_SITE_MAX_ZIP_BYTES + 1))).result)).toEqual(
      noBrowser("zip_too_large"),
    );

    const more = (n: number) =>
      Array.from({ length: n }, (_, i) => file(`f/${i}.txt`, ""));
    expect(
      (await check(found([...SITE, ...more(QA_SITE_LIMITS.files - SITE.length)])))
        .result.browser,
    ).toBe(true);
    expect(
      refusal(
        (await check(found([...SITE, ...more(QA_SITE_LIMITS.files - SITE.length + 1)])))
          .result,
      ),
    ).toEqual(noBrowser("too_many_files"));

    const big = (n: number) => file("big.bin", new Uint8Array(n));
    expect(
      (await check(found([...SITE, big(QA_SITE_LIMITS.fileBytes)]))).result.browser,
    ).toBe(true);
    expect(
      refusal(
        (await check(found([...SITE, big(QA_SITE_LIMITS.fileBytes + 1)]))).result,
      ),
    ).toEqual(noBrowser("file_too_large"));

    const third = Math.ceil(QA_SITE_LIMITS.totalBytes / 3);
    const large = [0, 1, 2].map((i) => file(`large-${i}.bin`, new Uint8Array(third)));
    expect(refusal((await check(found([...SITE, ...large]))).result)).toEqual(
      noBrowser("too_large"),
    );
  });

  it("needs the site's own layout: index.html at the root", async () => {
    const noIndex = SITE.filter((e) => e.path !== "index.html");
    for (const entries of [
      noIndex,
      [...noIndex, file("sub/index.html")],
      // The staging deploy's new layout (O-159) is not a site to browse.
      [
        file("foreman-deploy.json", "{}"),
        file("assets/index.html"),
        file("assets/foreman-commit.txt", `${HEAD}\n`),
        file("worker/index.js", "export default {}"),
        file("foreman-commit.txt", `${HEAD}\n`),
      ],
    ]) {
      expect(refusal((await check(found(entries))).result)).toEqual(
        noBrowser("index_missing"),
      );
    }
  });

  it("needs the marker at the root, exactly the head commit and a newline", async () => {
    const noMarker = SITE.filter((e) => e.path !== "foreman-commit.txt");
    expect(refusal((await check(found(noMarker))).result)).toEqual(
      noBrowser("marker_missing"),
    );
    expect(
      refusal(
        (await check(found([...noMarker, file("sub/foreman-commit.txt", `${HEAD}\n`)])))
          .result,
      ),
    ).toEqual(noBrowser("marker_missing"));
    for (const data of [
      `${OTHER}\n`,
      HEAD,
      `${HEAD}\n\n`,
      ` ${HEAD}\n`,
      `${HEAD.toUpperCase()}\n`,
    ]) {
      const { result } = await check(
        found([...noMarker, file("foreman-commit.txt", data)]),
      );
      expect(refusal(result), JSON.stringify(data)).toEqual(
        noBrowser("marker_mismatch"),
      );
    }
  });
});

describe("the reasons (unit, D-479)", () => {
  it("are fixed text that fits 'No browser in this run: <reason>' and names nothing from a build", () => {
    for (const [reason, text] of Object.entries(QA_SITE_REASONS)) {
      expect(text, reason).toMatch(/^[a-zC]/);
      expect(text, reason).not.toMatch(/[.\n]$/);
      expect(text.length, reason).toBeLessThanOrEqual(100);
      expect(text, reason).not.toMatch(/—/);
    }
    // Only the fixed names a reason may hold.
    const named = Object.values(QA_SITE_REASONS)
      .join(" ")
      .match(/[\w-]+\.[a-z]+/g);
    expect(new Set(named)).toEqual(new Set(["index.html", "foreman-commit.txt"]));
    expect(QA_SITE_ARTIFACT).toBe("qa-site");
  });

  it("never quote a path or a file's content from the build", async () => {
    const secret = "do-not-echo-this";
    const answers: QaSiteRead[] = [
      found([...SITE, file(`../${secret}.html`)]),
      found([...SITE, file(`${secret}.html`, secret, true)]),
      found([file(`${secret}/index.html`), file("foreman-commit.txt", secret)]),
      found([file("index.html", secret), file("foreman-commit.txt", secret)]),
    ];
    for (const answer of answers) {
      const { result } = await check(answer);
      expect(result.browser).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
});
