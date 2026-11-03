// Unit: the plain parts of CI's render step (scripts/lib/screenshot-bundle.ts): which option
// folders it renders (the changed ones, and every one at the head for D-281), the regions an option page marks (D-255), and the bundle it writes, read back
// with the runner's own manifest check. Also the screenshots workflow as written. No browser.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { artifactName } from "../src/adapters/screenshots/github-artifacts.ts";
import { encodePng } from "../src/adapters/screenshots/png.ts";
import { readScreenshotManifest } from "../src/core/visual-comparison.ts";
import {
  checkBundle,
  galleryBundle,
  galleryShotFile,
  headOptionFolders,
  optionFolders,
  optionRegions,
  optionsBundle,
  sha256,
  writeBundle,
} from "../scripts/lib/screenshot-bundle.ts";

const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);
const SPEC = "design/gallery/example-button/spec.md";

const png = (width: number, height: number, grey = 200): Uint8Array =>
  encodePng({ width, height, data: new Uint8Array(width * height * 4).fill(grey) });

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-bundle-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("option folders to render", () => {
  const tracked = [
    "design/README.md",
    "design/auth/sign-in/spec.md",
    "design/auth/sign-in/options/bold/index.html",
    "design/auth/sign-in/options/bold/bold.css",
    "design/auth/sign-in/options/calm/index.html",
    "design/billing/plans/options/dense/index.html",
    "components/example-button/ExampleButton.tsx",
  ];

  it("finds every option folder with its name, in path order", () => {
    expect(optionFolders(tracked)).toEqual({
      folders: [
        { option: "bold", path: "design/auth/sign-in/options/bold" },
        { option: "calm", path: "design/auth/sign-in/options/calm" },
        { option: "dense", path: "design/billing/plans/options/dense" },
      ],
    });
  });

  it("keeps only folders the pull request changes", () => {
    expect(
      optionFolders(tracked, [
        "design/auth/sign-in/options/bold/bold.css",
        "README.md",
      ]),
    ).toEqual({
      folders: [{ option: "bold", path: "design/auth/sign-in/options/bold" }],
    });
    expect(optionFolders(tracked, ["design/auth/sign-in/spec.md"])).toEqual({
      folders: [],
    });
  });

  it("ignores options folders outside design/<area>/<feature>/options/<name>/", () => {
    expect(
      optionFolders(["design/options/x/index.html", "src/a/b/options/c/index.html"]),
    ).toEqual({ folders: [] });
  });

  it("refuses a name the manifest would refuse, a folder with no page, and a name used twice", () => {
    expect(optionFolders(["design/a/b/options/Bold/index.html"])).toEqual({
      problem: expect.stringContaining("lowercase letters, digits and hyphens"),
    });
    expect(optionFolders(["design/a/b/options/bold/page.html"])).toEqual({
      problem: expect.stringContaining("no index.html"),
    });
    expect(
      optionFolders([
        "design/a/b/options/bold/index.html",
        "design/c/d/options/bold/index.html",
      ]),
    ).toEqual({ problem: expect.stringContaining("same name") });
  });

  it("renders every option folder at the head, two features' options of one name included (D-281)", () => {
    const both = [
      ...tracked,
      "design/billing/plans/options/bold/index.html",
      "design/billing/plans/spec.md",
    ];
    expect(headOptionFolders(both)).toEqual({
      folders: [
        { option: "bold", path: "design/auth/sign-in/options/bold" },
        { option: "calm", path: "design/auth/sign-in/options/calm" },
        { option: "bold", path: "design/billing/plans/options/bold" },
        { option: "dense", path: "design/billing/plans/options/dense" },
      ],
    });
    expect(headOptionFolders(["design/a/b/options/Bold/index.html"])).toEqual({
      problem: expect.stringContaining("lowercase letters, digits and hyphens"),
    });
    expect(headOptionFolders(["design/a/b/options/bold/page.html"])).toEqual({
      problem: expect.stringContaining("no index.html"),
    });
    expect(headOptionFolders(["design/README.md"])).toEqual({ folders: [] });
  });
});

describe("regions from an option page's markers (D-255)", () => {
  const page = { width: 1280, height: 900 };
  const marked = (component: string, variant: string | undefined, box: number[]) => ({
    attributes: {
      "data-component": component,
      ...(variant === undefined ? {} : { "data-variant": variant }),
    },
    box: {
      x: box[0] as number,
      y: box[1] as number,
      width: box[2] as number,
      height: box[3] as number,
    },
  });

  it("rounds each box out to whole pixels and records the variant or null", () => {
    expect(
      optionRegions(
        [
          marked("example-button", "Primary", [24.5, 40.2, 100.1, 30]),
          marked("example-card", undefined, [24, 100, 334, 80]),
        ],
        page,
      ),
    ).toEqual({
      regions: [
        {
          component: "example-button",
          variant: "Primary",
          x: 24,
          y: 40,
          width: 101,
          height: 31,
        },
        {
          component: "example-card",
          variant: null,
          x: 24,
          y: 100,
          width: 334,
          height: 80,
        },
      ],
    });
  });

  it("keeps a box inside the page", () => {
    expect(
      optionRegions([marked("wide", undefined, [-10, 880, 2000, 50])], page),
    ).toEqual({
      regions: [
        { component: "wide", variant: null, x: 0, y: 880, width: 1280, height: 20 },
      ],
    });
  });

  it("refuses a bad name, an element with no box, and a component variant marked twice", () => {
    expect(
      optionRegions([marked("Not A Name", undefined, [0, 0, 10, 10])], page),
    ).toEqual({
      problem: expect.stringContaining("not a gallery name"),
    });
    expect(optionRegions([marked("hidden", undefined, [5, 5, 0, 0])], page)).toEqual({
      problem: expect.stringContaining("hidden has no visible box"),
    });
    expect(
      optionRegions(
        [
          marked("b", "Primary", [0, 0, 10, 10]),
          marked("b", "Primary", [0, 20, 10, 10]),
        ],
        page,
      ),
    ).toEqual({ problem: expect.stringContaining("variant Primary twice") });
  });
});

describe("writing a bundle and reading it back with the runner's check", () => {
  const spec = new TextEncoder().encode("# ExampleButton\n");
  const shots = [
    {
      component: "example-button",
      variant: "Primary",
      index: 0,
      specPath: SPEC,
      png: png(173, 74),
    },
    {
      component: "example-button",
      variant: "Big Wide",
      index: 1,
      specPath: SPEC,
      png: png(200, 80, 90),
    },
  ];

  it("writes the gallery manifest in version 1 with every file and hash", () => {
    const dir = scratch();
    writeBundle(dir, galleryBundle(COMMIT, shots, new Map([[SPEC, spec]])));
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest).toEqual({
      foremanScreenshots: 1,
      kind: "gallery",
      commit: COMMIT,
      shots: [
        {
          component: "example-button",
          variant: "Primary",
          file: "shots/example-button/01-primary.png",
          sha256: sha256(shots[0]!.png),
          width: 173,
          height: 74,
          specPath: SPEC,
        },
        {
          component: "example-button",
          variant: "Big Wide",
          file: "shots/example-button/02-big-wide.png",
          sha256: sha256(shots[1]!.png),
          width: 200,
          height: 80,
          specPath: SPEC,
        },
      ],
      specs: [{ path: SPEC, file: `specs/${SPEC}`, sha256: sha256(spec) }],
    });
    expect("manifest" in readScreenshotManifest(manifest, COMMIT, "gallery")).toBe(
      true,
    );
    expect(checkBundle(dir, COMMIT, "gallery")).toEqual({
      summary: { kind: "gallery", images: 2, extras: 1 },
    });
  });

  it("names a variant's file by its place, so two names that look alike do not collide", () => {
    expect(galleryShotFile("x", 0, "A b")).not.toBe(galleryShotFile("x", 1, "a-b"));
    expect(galleryShotFile("x", 2, "!!")).toBe("shots/x/03-variant.png");
  });

  it("writes the options manifest with the page's size and regions", () => {
    const dir = scratch();
    const regions = [
      {
        component: "example-button",
        variant: "Primary",
        x: 24,
        y: 40,
        width: 100,
        height: 30,
      },
    ];
    writeBundle(
      dir,
      optionsBundle(COMMIT, [
        {
          option: "bold",
          path: "design/auth/sign-in/options/bold",
          png: png(1280, 900),
          regions,
        },
      ]),
    );
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest.options).toEqual([
      {
        option: "bold",
        path: "design/auth/sign-in/options/bold",
        file: "pages/design/auth/sign-in/options/bold.png",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        width: 1280,
        height: 900,
        regions,
      },
    ]);
    expect(checkBundle(dir, COMMIT, "options")).toEqual({
      summary: { kind: "options", images: 1, extras: 1 },
    });
  });

  it("writes a head-options bundle with two features' options of one name that the runner's check accepts (D-281)", () => {
    const dir = scratch();
    writeBundle(
      dir,
      optionsBundle(
        COMMIT,
        [
          {
            option: "bold",
            path: "design/auth/sign-in/options/bold",
            png: png(40, 30),
            regions: [],
          },
          {
            option: "bold",
            path: "design/billing/plans/options/bold",
            png: png(50, 20),
            regions: [],
          },
        ],
        "head-options",
      ),
    );
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest.kind).toBe("head-options");
    expect(manifest.options.map((o: { file: string }) => o.file)).toEqual([
      "pages/design/auth/sign-in/options/bold.png",
      "pages/design/billing/plans/options/bold.png",
    ]);
    expect(checkBundle(dir, COMMIT, "head-options")).toEqual({
      summary: { kind: "head-options", images: 2, extras: 0 },
    });
    expect(checkBundle(dir, COMMIT, "options")).toEqual({
      problem: "the manifest is of the other kind",
    });
  });

  it("refuses to write into a folder that is not empty", () => {
    const dir = scratch();
    writeFileSync(join(dir, "stale.png"), "x");
    expect(() =>
      writeBundle(dir, galleryBundle(COMMIT, shots, new Map([[SPEC, spec]]))),
    ).toThrow(/not empty/);
  });

  it("fails the check on another commit or kind, a changed or missing file, a wrong size and an extra file", () => {
    const write = () => {
      const dir = scratch();
      writeBundle(dir, galleryBundle(COMMIT, shots, new Map([[SPEC, spec]])));
      return dir;
    };
    expect(checkBundle(write(), OTHER, "gallery")).toEqual({
      problem: "the manifest names another commit",
    });
    expect(checkBundle(write(), COMMIT, "options")).toEqual({
      problem: "the manifest is not version 1 of the screenshot manifest",
    });

    let dir = write();
    writeFileSync(join(dir, "shots/example-button/01-primary.png"), png(173, 74, 10));
    expect(checkBundle(dir, COMMIT, "gallery")).toEqual({
      problem: "shots/example-button/01-primary.png does not match its SHA-256",
    });

    dir = write();
    rmSync(join(dir, `specs/${SPEC}`));
    expect(checkBundle(dir, COMMIT, "gallery")).toEqual({
      problem: `the bundle has no file specs/${SPEC}`,
    });

    dir = write();
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    manifest.shots[0].width = 174;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    expect(checkBundle(dir, COMMIT, "gallery")).toEqual({
      problem: "shots/example-button/01-primary.png is not the size the manifest gives",
    });

    dir = write();
    writeFileSync(join(dir, "notes.txt"), "x");
    expect(checkBundle(dir, COMMIT, "gallery")).toEqual({
      problem: "the bundle has a file the manifest does not name: notes.txt",
    });

    dir = scratch();
    expect(checkBundle(dir, COMMIT, "gallery")).toEqual({
      problem: "manifest.json is missing or not JSON",
    });
  });
});

describe("the screenshots workflow (.github/workflows/screenshots.yml)", () => {
  const text = readFileSync(".github/workflows/screenshots.yml", "utf8");
  const workflow = parseYaml(text) as {
    on: Record<string, unknown>;
    permissions: Record<string, unknown>;
    jobs: Record<
      string,
      {
        permissions: Record<string, string>;
        steps: { uses?: string; run?: string; with?: Record<string, unknown> }[];
      }
    >;
  };
  const job = workflow.jobs["render-screenshots"]!;

  it("runs on pull requests with no permission beyond contents: read and no secrets", () => {
    expect(Object.keys(workflow.on)).toEqual(["pull_request"]);
    expect(workflow.permissions).toEqual({});
    expect(job.permissions).toEqual({ contents: "read" });
    expect(text).not.toMatch(/secrets\./);
  });

  it("renders at the PR head, not the merge commit", () => {
    const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("${{ github.event.pull_request.head.sha }}");
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("pins every action by full commit SHA", () => {
    for (const step of job.steps.filter((s) => s.uses)) {
      expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });

  it("uploads each bundle under the artifact name the runner reads", () => {
    const uploads = job.steps.filter((s) =>
      s.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(uploads.map((s) => s.with?.name)).toEqual([
      artifactName("gallery"),
      artifactName("options"),
      artifactName("head-options"),
    ]);
    expect(uploads.map((s) => s.with?.path)).toEqual([
      "screenshots/gallery/",
      "screenshots/options/",
      "screenshots/head-options/",
    ]);
  });

  it("renders every option folder at the head in the same job as the gallery, with the same browser (D-281)", () => {
    const runs = job.steps.flatMap((s) => (s.run ? [s.run] : []));
    const gallery = runs.findIndex((r) => r.includes("--kind gallery"));
    const head = runs.findIndex((r) => r.includes("--kind head-options"));
    expect(gallery).toBeGreaterThanOrEqual(0);
    expect(head).toBeGreaterThan(gallery);
    expect(runs[head]).toContain('--commit "$HEAD_SHA"');
    expect(runs[head]).toContain("--browser chrome");
    expect(runs[head]).not.toContain("--changed-since");
  });

  it("drives the browser through playwright-core at an exact version", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies["playwright-core"]).toMatch(/^\d+\.\d+\.\d+$/);
    const runs = job.steps.flatMap((s) => (s.run ? [s.run] : [])).join("\n");
    expect(runs).toContain("--kind gallery");
    expect(runs).toContain("--kind options");
    expect(runs.match(/--browser chrome/g)).toHaveLength(3);
  });
});
