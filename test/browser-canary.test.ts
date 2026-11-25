// Broader: the browser canary (ADR 0119 slice 5b, D-476) with real Chromium. The fixture page
// (test/fixtures/browser-canary/site/) tries every way a page has to reach a local canary and the
// browser host's own API, and the canary must see nothing (test/fixtures/browser-canary/canary.mjs).
// The same canary runs inside the built Messages API image, with a read-only root, user 1000 and
// every capability dropped, in CI's container check (scripts/check-agent-container.sh). Skipped
// when Chromium's headless shell at playwright-core's revision is not installed, which is the case
// in CI's test job. Only 127.0.0.1 is used.
import { describe, expect, it } from "vitest";

import { ATTEMPTS, runCanary } from "./fixtures/browser-canary/canary.mjs";
import { headlessShellInstalled } from "./headless-shell.ts";

describe("the browser canary's page (unit: what it tries)", () => {
  it("tries every way the browser must block, and the host's own API", () => {
    for (const attempt of [
      "fetch",
      "img",
      "iframe",
      "form",
      "websocket",
      "eventsource",
      "beacon",
      "window.open",
      "service worker",
      "webrtc",
      "worker",
      "host api json",
      "host api text",
      "host api beacon",
      "host api form",
    ]) {
      expect(ATTEMPTS).toContain(attempt);
    }
  });
});

describe.skipIf(!headlessShellInstalled)(
  "the browser canary (broader: real Chromium)",
  { timeout: 120_000 },
  () => {
    it("lets nothing reach the canary or the host's API, and notes each blocked request by scheme and host only", async () => {
      const found = await runCanary({
        hostEntry: "src/agent-images/claude-api/browser-host.ts",
      });
      expect(found.problems).toEqual([]);
      expect(found.ok).toBe(true);
      expect(found.canaryRecords).toBe(true);
      expect(found.canary).toEqual({
        connections: 0,
        requests: 0,
        upgrades: 0,
        packets: 0,
      });
      expect(found.attempts).toEqual(ATTEMPTS);
      expect(found.hostRequests).toBe(found.ownRequests);
      expect(found.backend).toBe(503);
      for (const blocked of found.blocked) {
        expect(Object.keys(blocked).sort()).toEqual(["host", "kind", "scheme"]);
      }
    });
  },
);
