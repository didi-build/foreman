// Seam: the runner's read of the site QA will browse (unit with fakes, D-267, ADR 0119 slice 5a,
// O-174). The read mints a read-only `actions` token for the one repository, lists the artifacts
// named `qa-site` of exactly the preview check's run, downloads the newest unexpired one within
// 900 KiB, refuses a larger one before and after the download, and reads the zip with the staging
// deploy's reader. A listing or download GitHub refuses is no site with its fixed reason. A fake
// token port and a fake HTTP port stand in for GitHub, with zips made in memory; at the end the
// real read and the core's check run together. No network, no real repository or token.
import { describe, expect, it } from "vitest";

import { storedZip, type ZipFixtureEntry } from "../../../test/zip-fixture.ts";
import {
  checkQaSite,
  QA_SITE_LIMITS,
  QA_SITE_MAX_ZIP_BYTES,
  QA_SITE_REASONS,
} from "../../core/qa-site.ts";
import type { Evidence, Json } from "../../core/store.ts";
import { createGitHubQaSites } from "./qa-sites.ts";
import {
  GitHubReadError,
  type GitHubGetRequest,
  type GitHubGetResponse,
  type RunnerAppTokenRequest,
  type RunnerAppTokens,
} from "./runner-app-tokens.ts";

const REPO = "didi-build/foreman";
const HEAD = "e".repeat(40);
const RUN = 77;
const LISTING = `/repos/${REPO}/actions/runs/${RUN}/artifacts?name=qa-site`;
const DOWNLOAD = (id: number) => `/repos/${REPO}/actions/artifacts/${id}/zip`;

/** A site as CI's preview check keeps it. */
const SITE: ZipFixtureEntry[] = [
  { name: "index.html", data: "<html></html>", deflate: true },
  { name: "assets/", data: "" },
  { name: "assets/index-1.js", data: "console.log(1)", deflate: true },
  { name: "foreman-commit.txt", data: `${HEAD}\n` },
];
const SITE_ZIP = storedZip(SITE);

const json = (value: unknown) => new Uint8Array(Buffer.from(JSON.stringify(value)));

const artifact = (fields: Record<string, unknown> = {}) => ({
  id: 5,
  name: "qa-site",
  expired: false,
  created_at: "2026-11-24T10:00:00Z",
  size_in_bytes: SITE_ZIP.length,
  ...fields,
});

type Answer = GitHubGetResponse | (() => never);

function fakes(answers: Record<string, Answer>) {
  const minted: RunnerAppTokenRequest[] = [];
  const asked: GitHubGetRequest[] = [];
  const tokens: RunnerAppTokens = {
    async mint(request) {
      minted.push(request);
      return "fake-actions-read-token";
    },
  };
  const sites = createGitHubQaSites({
    tokens,
    http: {
      async get(request) {
        asked.push(request);
        const answer = answers[request.path] ?? { status: 404, body: json({}) };
        return typeof answer === "function" ? answer() : answer;
      },
    },
  });
  return { sites, minted, asked };
}

/** One listing of `artifacts` and the download of each id, answering `zip`. */
const listed = (artifacts: unknown[], zip: Uint8Array = SITE_ZIP) => ({
  [LISTING]: { status: 200, body: json({ artifacts }) },
  [DOWNLOAD(5)]: { status: 200, body: zip },
  [DOWNLOAD(6)]: { status: 200, body: zip },
  [DOWNLOAD(7)]: { status: 200, body: zip },
});

describe("the read of QA's site (unit, fake GitHub, O-174)", () => {
  it("downloads the newest unexpired qa-site artifact of exactly the preview check's run", async () => {
    const { sites, minted, asked } = fakes(
      listed([
        artifact({ id: 5, created_at: "2026-11-24T10:00:00Z" }),
        artifact({ id: 6, created_at: "2026-11-24T11:00:00Z", expired: true }),
        artifact({ id: 7, name: "staging-site", created_at: "2026-11-24T12:00:00Z" }),
      ]),
    );
    const read = await sites.read(REPO, RUN);
    expect(read.found).toBe(true);
    if (!read.found) return;
    expect(read.zip).toEqual(SITE_ZIP);
    expect(read.entries.map((e) => e.path)).toEqual([
      "index.html",
      "assets/index-1.js",
      "foreman-commit.txt",
    ]);
    expect(Buffer.from(read.entries[0]!.bytes).toString()).toBe("<html></html>");
    expect(minted).toEqual([{ repository: REPO, permission: "actions" }]);
    expect(asked.map((a) => [a.path, a.accept, a.maxBytes])).toEqual([
      [LISTING, "json", 4 * 1024 * 1024],
      [DOWNLOAD(5), "download", QA_SITE_MAX_ZIP_BYTES],
    ]);
    for (const a of asked) expect(a.token).toBe("fake-actions-read-token");
  });

  it("finds none when the run keeps no unexpired qa-site, and downloads nothing", async () => {
    for (const artifacts of [
      [],
      [artifact({ expired: true })],
      [artifact({ name: "staging-site" }), artifact({ name: "qa-site-old" })],
    ]) {
      const { sites, asked } = fakes(listed(artifacts));
      expect(await sites.read(REPO, RUN)).toEqual({ found: false, reason: "missing" });
      expect(asked.map((a) => a.path)).toEqual([LISTING]);
    }
  });

  it("refuses a zip over 900 KiB by its listed size before the download, and by its bytes after", async () => {
    const before = fakes(
      listed([artifact({ size_in_bytes: QA_SITE_MAX_ZIP_BYTES + 1 })]),
    );
    expect(await before.sites.read(REPO, RUN)).toEqual({
      found: false,
      reason: "zip_too_large",
    });
    expect(before.asked.map((a) => a.path)).toEqual([LISTING]);

    // The listing says it fits, but the bytes that came do not (a port that did not cut it off).
    const big = new Uint8Array(QA_SITE_MAX_ZIP_BYTES + 1);
    big.set(SITE_ZIP);
    const after = fakes(listed([artifact({ size_in_bytes: 100 })], big));
    expect(await after.sites.read(REPO, RUN)).toEqual({
      found: false,
      reason: "zip_too_large",
    });
    expect(after.asked.map((a) => a.path)).toEqual([LISTING, DOWNLOAD(5)]);

    // At the bound, and with no size listed, it is downloaded within the bound and read.
    for (const size of [QA_SITE_MAX_ZIP_BYTES, undefined, "large", -1]) {
      const at = fakes(listed([artifact({ size_in_bytes: size })]));
      expect((await at.sites.read(REPO, RUN)).found, String(size)).toBe(true);
      expect(at.asked[1]?.maxBytes).toBe(QA_SITE_MAX_ZIP_BYTES);
    }
  });

  it("gives a refused download or listing as no site, never GitHub's words", async () => {
    for (const status of [403, 404, 410, 500]) {
      const { sites } = fakes({
        ...listed([artifact()]),
        [DOWNLOAD(5)]: { status, body: json({ message: "secret words" }) },
      });
      expect(await sites.read(REPO, RUN), String(status)).toEqual({
        found: false,
        reason: "download_refused",
      });
    }
    const listing = fakes({ [LISTING]: { status: 500, body: json({}) } });
    expect(await listing.sites.read(REPO, RUN)).toEqual({
      found: false,
      reason: "download_refused",
    });
    // The real port refuses a body over its bound with a GitHubReadError.
    const cut = fakes({
      ...listed([artifact()]),
      [DOWNLOAD(5)]: () => {
        throw new GitHubReadError("GitHub's answer is larger than 921600 bytes");
      },
    });
    expect(await cut.sites.read(REPO, RUN)).toEqual({
      found: false,
      reason: "download_refused",
    });
    const malformed = fakes({
      [LISTING]: { status: 200, body: json({ nothing: [] }) },
    });
    expect(await malformed.sites.read(REPO, RUN)).toEqual({
      found: false,
      reason: "download_refused",
    });
  });

  it("throws on an error that is not GitHub's refusal, and on a name or run id out of shape before minting", async () => {
    const broken = fakes({
      [LISTING]: () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(broken.sites.read(REPO, RUN)).rejects.toThrow(TypeError);
    const { sites, minted } = fakes(listed([artifact()]));
    await expect(sites.read("not a repo", RUN)).rejects.toThrow(/repository name/);
    await expect(sites.read(REPO, 0)).rejects.toThrow(/run id/);
    await expect(sites.read(REPO, 1.5)).rejects.toThrow(/run id/);
    expect(minted).toEqual([]);
  });

  it("refuses a zip its reader refuses, with the staging deploy's reader and QA's bounds", async () => {
    const cases: [Uint8Array, string][] = [
      [new Uint8Array([1, 2, 3]), "archive_unreadable"],
      [storedZip([...SITE, { name: "../outside.html", data: "x" }]), "path_not_plain"],
      [storedZip([...SITE, { name: "/etc/passwd", data: "x" }]), "path_not_plain"],
      [
        storedZip(
          Array.from({ length: QA_SITE_LIMITS.files * 2 + 1 }, (_, i) => ({
            name: `f/${i}`,
            data: "",
          })),
        ),
        "too_many_files",
      ],
      [
        storedZip([
          ...SITE,
          {
            name: "big.bin",
            data: new Uint8Array(QA_SITE_LIMITS.fileBytes + 1),
            deflate: true,
          },
        ]),
        "file_too_large",
      ],
      [
        storedZip([
          ...SITE,
          ...[0, 1, 2].map((i) => ({
            name: `large-${i}.bin`,
            data: new Uint8Array(12 * 1024 * 1024),
            deflate: true,
          })),
        ]),
        "too_large",
      ],
    ];
    for (const [zip, reason] of cases) {
      expect(zip.length, reason).toBeLessThanOrEqual(QA_SITE_MAX_ZIP_BYTES);
      const { sites } = fakes(listed([artifact({ size_in_bytes: zip.length })], zip));
      expect(await sites.read(REPO, RUN), reason).toEqual({ found: false, reason });
    }
  });
});

describe("the read and the core's check together (unit, fake GitHub and store, O-174)", () => {
  const rows = (changedPaths: string[]): Evidence[] =>
    (
      [
        ["ci_run", { conclusion: "success", pr: 3, changedPaths }],
        [
          "preview_check",
          { pass: true, conclusion: "success", pr: 3, workflowRunId: RUN, jobId: 1 },
        ],
      ] as const
    ).map(([kind, payload], i) => ({
      id: `e-${i}`,
      nodeId: "node-1",
      runId: null,
      kind,
      ref: "r",
      commitSha: HEAD,
      payload: payload as Json,
      recordedBy: "runner",
      recordedAt: new Date(Date.UTC(2026, 10, 24, 12, i)),
      supersedesId: null,
    }));
  const store = (changedPaths: string[]) => ({
    async listEvidence(filter: { nodeId: string; kind?: string; commitSha?: string }) {
      return rows(changedPaths).filter(
        (e) => e.kind === filter.kind && e.commitSha === filter.commitSha,
      );
    },
  });
  const request = { nodeId: "node-1", repo: REPO, headSha: HEAD };

  it("gives the site CI kept for the head commit", async () => {
    const { sites } = fakes(listed([artifact()]));
    expect(await checkQaSite({ store: store(["src/app.ts"]), sites }, request)).toEqual(
      {
        browser: true,
        site: {
          commitSha: HEAD,
          workflowRunId: RUN,
          zip: SITE_ZIP,
          files: 3,
          bytes: 68,
        },
      },
    );
  });

  it("refuses a link in the zip, a marker of another commit, and a PR that changes the server", async () => {
    const link = fakes(
      listed(
        [artifact()],
        storedZip([...SITE, { name: "a.html", data: "/etc", mode: 0o120777 }]),
      ),
    );
    expect(await checkQaSite({ store: store([]), sites: link.sites }, request)).toEqual(
      {
        browser: false,
        reason: "symlink",
        text: QA_SITE_REASONS.symlink,
      },
    );
    const other = fakes(
      listed(
        [artifact()],
        storedZip([
          ...SITE.slice(0, 3),
          { name: "foreman-commit.txt", data: `${"f".repeat(40)}\n` },
        ]),
      ),
    );
    expect(
      await checkQaSite({ store: store([]), sites: other.sites }, request),
    ).toMatchObject({
      browser: false,
      reason: "marker_mismatch",
    });
    const server = fakes(listed([artifact()]));
    expect(
      await checkQaSite(
        { store: store([".github/scripts/serve-site.mjs"]), sites: server.sites },
        request,
      ),
    ).toEqual({
      browser: false,
      reason: "pipeline_changed",
      text: "the pull request changes the site build or its server",
    });
    expect(server.asked).toEqual([]);
    expect(server.minted).toEqual([]);
  });
});
