// Seam: the New project form's settings on GitHub (unit with fakes, D-436, D-442, D-443, ADR 0118
// appendix A, O-161). Fake token ports and fake HTTP ports stand in for the runner App and
// GitHub; the answers are synthetic, in the shapes GitHub's "Get repository content", "List
// commits" and "Create or update file contents" give. Foreman's standard size read from main, the
// project file and its newest commit, and the create-only write: exactly one PUT with no `sha`,
// its answers, and nothing ever sent to replace a file. No network, no real token.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { STANDARD_QUOTA } from "./new-project-fake.ts";
import { createGitHubProjectSettings, standardQuotaOf } from "./project-settings.ts";
import type {
  GitHubGetRequest,
  GitHubHttp,
  RunnerAppTokenRequest,
} from "./runner-app-tokens.ts";
import type { GitHubWriteHttp, GitHubWriteRequest } from "./write-http.ts";

const READ_TOKEN = "fake-read-token-not-real";
const WRITE_TOKEN = "fake-write-token-not-real";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const FILE_TEXT = readFileSync(
  "test/fixtures/foreman-projects/projects/rehearsal.json",
  "utf8",
);

type Answer = { status: number; body: unknown };

/** GitHub's contents answer for a file. */
const fileAnswer = (
  path: string,
  text: string,
  extra: Record<string, unknown> = {},
) => ({
  type: "file",
  path,
  encoding: "base64",
  content: Buffer.from(text, "utf8").toString("base64"),
  ...extra,
});

function fakes(
  options: { gets?: Answer[]; put?: Answer | "throw"; refuseWrite?: boolean } = {},
) {
  const readMints: RunnerAppTokenRequest[] = [];
  const gets: GitHubGetRequest[] = [];
  const writes: GitHubWriteRequest[] = [];
  let writeMints = 0;
  const answers = [...(options.gets ?? [])];
  const encode = (body: unknown) =>
    new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  const http: GitHubHttp = {
    async get(request) {
      gets.push(request);
      const answer = answers.shift() ?? { status: 500, body: "" };
      return { status: answer.status, body: encode(answer.body) };
    },
  };
  const write: GitHubWriteHttp = {
    async send(request) {
      writes.push(structuredClone(request));
      const answer = options.put ?? { status: 500, body: "" };
      if (answer === "throw") throw new Error("no answer");
      return { status: answer.status, body: encode(answer.body) };
    },
  };
  const settings = createGitHubProjectSettings({
    readTokens: {
      async mint(request) {
        readMints.push(request);
        return READ_TOKEN;
      },
    },
    writeTokens: {
      async mint() {
        writeMints += 1;
        if (options.refuseWrite) throw new Error("refused");
        return WRITE_TOKEN;
      },
    },
    http,
    write,
  });
  return { settings, readMints, gets, writes, writeMints: () => writeMints };
}

const SETTINGS_PATH = "infra/kubernetes/settings/production.json";

describe("Foreman's standard size on main (unit with fakes, D-436, O-161)", () => {
  it("reads production.json on didi-build/foreman's main with a contents read token for that one repository", async () => {
    const text = readFileSync(SETTINGS_PATH, "utf8");
    const f = fakes({ gets: [{ status: 200, body: fileAnswer(SETTINGS_PATH, text) }] });
    expect(await f.settings.standardQuota()).toEqual(STANDARD_QUOTA);
    expect(f.readMints).toEqual([
      { repository: "didi-build/foreman", permission: "contents" },
    ]);
    expect(f.gets).toEqual([
      {
        path: `/repos/didi-build/foreman/contents/${SETTINGS_PATH}?ref=main`,
        token: READ_TOKEN,
        accept: "json",
        maxBytes: 2 * 1024 * 1024,
      },
    ]);
    expect(f.writes).toEqual([]);
  });

  it("throws on a failed read, another file, or a standard size not in full", async () => {
    const answers: Answer[] = [
      { status: 404, body: { message: "Not Found" } },
      { status: 200, body: "not json" },
      { status: 200, body: fileAnswer("elsewhere.json", "{}") },
      { status: 200, body: fileAnswer(SETTINGS_PATH, "{}", { encoding: "utf-8" }) },
      { status: 200, body: fileAnswer(SETTINGS_PATH, "{}") },
    ];
    for (const answer of answers)
      await expect(
        fakes({ gets: [answer] }).settings.standardQuota(),
      ).rejects.toThrow();
    expect(() => standardQuotaOf("not json")).toThrow(/not JSON/);
    expect(() =>
      standardQuotaOf(JSON.stringify({ projectStandardQuota: { pods: 12 } })),
    ).toThrow(/standard quota in full/);
  });
});

describe("a project's file on the settings repository (unit with fakes, D-442, O-161)", () => {
  const path = "projects/rehearsal.json";

  it("reads the file and its newest commit on main with one contents read token for foreman-projects", async () => {
    const f = fakes({
      gets: [
        { status: 200, body: fileAnswer(path, FILE_TEXT) },
        { status: 200, body: [{ sha: COMMIT }, { sha: "f".repeat(40) }] },
      ],
    });
    expect(await f.settings.readFile("rehearsal")).toEqual({
      text: FILE_TEXT,
      commit: COMMIT,
    });
    expect(f.readMints).toEqual([
      { repository: "didi-build/foreman-projects", permission: "contents" },
    ]);
    expect(f.gets.map((g) => [g.path, g.token])).toEqual([
      [`/repos/didi-build/foreman-projects/contents/${path}?ref=main`, READ_TOKEN],
      [
        `/repos/didi-build/foreman-projects/commits?sha=main&path=${path}&per_page=1`,
        READ_TOKEN,
      ],
    ]);
  });

  it("reads a missing file as none, and throws on any other answer", async () => {
    const none = fakes({ gets: [{ status: 404, body: { message: "Not Found" } }] });
    expect(await none.settings.readFile("rehearsal")).toBeNull();
    expect(none.gets).toHaveLength(1);
    const answers: Answer[][] = [
      [{ status: 403, body: {} }],
      [{ status: 200, body: fileAnswer("projects/other.json", FILE_TEXT) }],
      [{ status: 200, body: [fileAnswer(path, FILE_TEXT)] }],
      [
        { status: 200, body: fileAnswer(path, FILE_TEXT) },
        { status: 500, body: "" },
      ],
      [
        { status: 200, body: fileAnswer(path, FILE_TEXT) },
        { status: 200, body: [] },
      ],
      [
        { status: 200, body: fileAnswer(path, FILE_TEXT) },
        { status: 200, body: [{ sha: "main" }] },
      ],
    ];
    for (const gets of answers)
      await expect(fakes({ gets }).settings.readFile("rehearsal")).rejects.toThrow();
    await expect(fakes().settings.readFile("../x")).rejects.toThrow(
      /not a project slug/,
    );
  });
});

describe("the create-only write (unit with fakes, D-442, D-443, O-161)", () => {
  const path = "projects/garden-notes.json";
  const request = {
    slug: "garden-notes",
    text: FILE_TEXT,
    message: "Add project garden-notes (New project form, ADR 0118)",
  };
  const created = { content: { path, sha: "b".repeat(40) }, commit: { sha: COMMIT } };

  it("sends exactly one PUT with the message, the text in base64 and main, and no sha", async () => {
    const f = fakes({ put: { status: 201, body: created } });
    expect(await f.settings.createFile(request)).toEqual({
      kind: "created",
      commit: COMMIT,
    });
    expect(f.writeMints()).toBe(1);
    expect(f.readMints).toEqual([]);
    expect(f.writes).toEqual([
      {
        method: "PUT",
        path: `/repos/didi-build/foreman-projects/contents/${path}`,
        token: WRITE_TOKEN,
        body: {
          message: request.message,
          content: Buffer.from(FILE_TEXT, "utf8").toString("base64"),
          branch: "main",
        },
        maxBytes: 256 * 1024,
      },
    ]);
    expect(Object.keys(f.writes[0]?.body ?? {})).not.toContain("sha");
  });

  it("answers not created when GitHub keeps a file there, or does not show what it made, and never sends again", async () => {
    for (const put of [
      { status: 422, body: { message: '"sha" wasn\'t supplied.' } },
      { status: 409, body: { message: "conflict" } },
      {
        status: 201,
        body: { content: { path: "projects/other.json" }, commit: { sha: COMMIT } },
      },
      { status: 201, body: { content: { path }, commit: { sha: "main" } } },
      { status: 201, body: "not json" },
    ]) {
      const f = fakes({ put });
      expect(await f.settings.createFile(request), JSON.stringify(put)).toEqual({
        kind: "not_created",
      });
      expect(f.writes).toHaveLength(1);
    }
  });

  it("refuses another answer with its status, a refused token, and bad requests before minting", async () => {
    for (const status of [200, 401, 403, 404, 500]) {
      const f = fakes({ put: { status, body: {} } });
      expect(await f.settings.createFile(request)).toEqual({
        kind: "refused",
        step: "call",
        status,
      });
    }
    const dropped = fakes({ put: "throw" });
    expect(await dropped.settings.createFile(request)).toEqual({
      kind: "refused",
      step: "call",
    });
    const refused = fakes({ refuseWrite: true });
    expect(await refused.settings.createFile(request)).toEqual({
      kind: "refused",
      step: "token",
    });
    expect(refused.writes).toEqual([]);
    for (const bad of [
      { ...request, slug: "../foreman" },
      { ...request, slug: "Garden" },
      { ...request, text: "x".repeat(16 * 1024 + 1) },
      { ...request, message: "" },
      { ...request, message: "two\nlines" },
    ]) {
      const f = fakes({ put: { status: 201, body: created } });
      expect(await f.settings.createFile(bad)).toEqual({
        kind: "refused",
        step: "call",
      });
      expect([f.writeMints(), f.writes]).toEqual([0, []]);
    }
  });
});
