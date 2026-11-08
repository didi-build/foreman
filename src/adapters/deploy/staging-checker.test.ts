// Seam: the runner's staging check (unit with a fake HTTP port, O-35, O-116). It reads exactly
// `https://<slug>.didi.build/foreman-commit.txt` with its time limit and size bound, and reports
// the commit the marker names; every way staging fails to give one is a result without a result,
// never a throw. No network.
import { describe, expect, it } from "vitest";

import type { Project } from "../../core/store.ts";
import {
  createMarkerStagingChecker,
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
