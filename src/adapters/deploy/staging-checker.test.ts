// Seam: the runner's staging check (unit with a fake HTTP port, O-35, O-116, O-159). It reads exactly
// `https://<slug>.didi.build/foreman-commit.txt` with its time limit and size bound, and reports
// the commit the marker names; every way staging fails to give one is a result without a result,
// never a throw. When the deploy carried a Worker, it then reads `/api/health`: exactly
// `{"status":"ok"}` with 200 passes, any other answer fails with that commit, and no answer is no
// result. Without a Worker, nothing else is read. No network.
import { describe, expect, it } from "vitest";

import type { Project } from "../../core/store.ts";
import {
  createMarkerStagingChecker,
  HEALTH_PATH,
  healthUrl,
  MARKER_MAX_BYTES,
  MARKER_TIMEOUT_MS,
  MarkerTimeoutError,
  markerUrl,
  type MarkerHttp,
} from "./staging-checker.ts";

const COMMIT = "c".repeat(40);
const PROJECT = { slug: "rehearsal" } as Project;

function fakeHttp(answer: { status: number; body: string | null } | Error) {
  const asked: { url: string; timeoutMs: number; maxBytes: number }[] = [];
  const http: MarkerHttp = {
    async get(url, bounds) {
      asked.push({ url, ...bounds });
      if (answer instanceof Error) throw answer;
      return {
        status: answer.status,
        body: answer.body === null ? null : new Uint8Array(Buffer.from(answer.body)),
      };
    },
  };
  return { http, asked };
}

const check = (http: MarkerHttp, project: Project = PROJECT) =>
  createMarkerStagingChecker(http).check({ project, commitSha: "a".repeat(40) });

describe("the staging check reads the served commit marker (unit, O-116)", () => {
  it("reads the marker at the project's staging address, bounded, and reports its commit", async () => {
    for (const body of [`${COMMIT}\n`, COMMIT]) {
      const { http, asked } = fakeHttp({ status: 200, body });
      expect(await check(http)).toEqual({ result: "pass", servedCommitSha: COMMIT });
      expect(asked).toEqual([
        {
          url: "https://rehearsal.didi.build/foreman-commit.txt",
          timeoutMs: MARKER_TIMEOUT_MS,
          maxBytes: MARKER_MAX_BYTES,
        },
      ]);
    }
    expect(MARKER_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(MARKER_MAX_BYTES).toBeLessThanOrEqual(4096);
  });

  it("gives no result for a page that is not a marker, such as the single-page fallback, or one past the bound", async () => {
    for (const body of [
      "<!doctype html><html></html>",
      `${COMMIT}\n\n`,
      COMMIT.toUpperCase(),
      "c".repeat(39),
      "",
      null,
    ]) {
      const { http } = fakeHttp({ status: 200, body });
      expect(await check(http), JSON.stringify(body)).toEqual({
        result: "no_result",
        reason: "no_marker",
      });
    }
  });

  it("gives no result when staging answers with another status, a redirect, or not at all, or runs out of time", async () => {
    for (const status of [404, 403, 500, 301, 302]) {
      const { http } = fakeHttp({ status, body: `${COMMIT}\n` });
      expect(await check(http), String(status)).toEqual({
        result: "no_result",
        reason: "unreachable",
      });
    }
    expect(await check(fakeHttp(new TypeError("fetch failed")).http)).toEqual({
      result: "no_result",
      reason: "unreachable",
    });
    expect(await check(fakeHttp(new MarkerTimeoutError()).http)).toEqual({
      result: "no_result",
      reason: "timed_out",
    });
  });

  it("reads nothing for a slug that makes no staging address", async () => {
    const { http, asked } = fakeHttp({ status: 200, body: COMMIT });
    for (const slug of ["", "Rehearsal", "a/b", "evil.example.com#"]) {
      expect(await check(http, { slug } as Project)).toEqual({
        result: "no_result",
        reason: "unreachable",
      });
      expect(markerUrl(slug)).toBeNull();
    }
    expect(asked).toEqual([]);
  });
});

const MARKER_URL = "https://rehearsal.didi.build/foreman-commit.txt";
const HEALTH_URL = "https://rehearsal.didi.build/api/health";

type Answer = { status: number; body: string | null } | Error;

/** A fake staging site that answers each address as given, and keeps what was asked. */
function fakeSite(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const http: MarkerHttp = {
    async get(url, bounds) {
      asked.push(url);
      expect(bounds).toEqual({
        timeoutMs: MARKER_TIMEOUT_MS,
        maxBytes: MARKER_MAX_BYTES,
      });
      const answer = answers[url];
      if (answer === undefined) throw new Error(`the fake site has no ${url}`);
      if (answer instanceof Error) throw answer;
      return {
        status: answer.status,
        body: answer.body === null ? null : new Uint8Array(Buffer.from(answer.body)),
      };
    },
  };
  return { http, asked };
}

const withWorker = (http: MarkerHttp) =>
  createMarkerStagingChecker(http).check({
    project: PROJECT,
    commitSha: "a".repeat(40),
    worker: true,
  });

const MARKER_OK: Answer = { status: 200, body: `${COMMIT}\n` };

describe("the staging check probes the Worker's health when the deploy carried one (unit, O-159)", () => {
  it('passes when /api/health answers exactly {"status":"ok"} with 200, asked after the marker', async () => {
    for (const body of ['{"status":"ok"}', '{ "status": "ok" }\n']) {
      const { http, asked } = fakeSite({
        [MARKER_URL]: MARKER_OK,
        [HEALTH_URL]: { status: 200, body },
      });
      expect(await withWorker(http), body).toEqual({
        result: "pass",
        servedCommitSha: COMMIT,
      });
      expect(asked).toEqual([MARKER_URL, HEALTH_URL]);
    }
    expect(HEALTH_PATH).toBe("/api/health");
    expect(healthUrl("rehearsal")).toBe(HEALTH_URL);
    expect(healthUrl("Rehearsal")).toBeNull();
  });

  it("fails, with the marker's commit, on any other answer from /api/health", async () => {
    for (const health of [
      { status: 200, body: '{"status":"placeholder"}' },
      { status: 200, body: '{"status":"ok","extra":1}' },
      { status: 200, body: '"ok"' },
      { status: 200, body: "<!doctype html><html></html>" },
      { status: 200, body: "" },
      { status: 200, body: null },
      { status: 404, body: '{"status":"ok"}' },
      { status: 500, body: '{"status":"ok"}' },
      { status: 503, body: null },
      { status: 302, body: null },
    ]) {
      const { http } = fakeSite({ [MARKER_URL]: MARKER_OK, [HEALTH_URL]: health });
      expect(await withWorker(http), JSON.stringify(health)).toEqual({
        result: "fail",
        servedCommitSha: COMMIT,
        reason: "api_health",
      });
    }
  });

  it("gives no result when /api/health does not answer, or not in time", async () => {
    for (const [error, reason] of [
      [new TypeError("fetch failed"), "unreachable"],
      [new MarkerTimeoutError(), "timed_out"],
    ] as const) {
      const { http } = fakeSite({ [MARKER_URL]: MARKER_OK, [HEALTH_URL]: error });
      expect(await withWorker(http)).toEqual({ result: "no_result", reason });
    }
  });

  it("asks nothing of the Worker when the marker gives no result, nor when the deploy had no Worker", async () => {
    const noMarker = fakeSite({ [MARKER_URL]: { status: 200, body: "<html></html>" } });
    expect(await withWorker(noMarker.http)).toEqual({
      result: "no_result",
      reason: "no_marker",
    });
    expect(noMarker.asked).toEqual([MARKER_URL]);
    const assetsOnly = fakeSite({ [MARKER_URL]: MARKER_OK });
    expect(await check(assetsOnly.http)).toEqual({
      result: "pass",
      servedCommitSha: COMMIT,
    });
    expect(assetsOnly.asked).toEqual([MARKER_URL]);
  });
});
