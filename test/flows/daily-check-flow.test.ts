// Seam: the daily check flow f/foreman/daily_check (build plan M4.4, O-91) with fake adapters on
// the memory store. The generator and its renderings are tested in test/daily-check.test.ts and
// test/daily-check-render.test.ts; this covers what the flow adds: the result Didi reads as a page
// in the flow's Windmill run (D-320, O-100: Windmill's `render_all`, the page first, then the
// check as JSON and as plain text), the link and the fresh-request flow each held item names, and
// that the flow writes nothing under any switch. Synthetic data only.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { run as dailyCheck } from "../../flows/daily-check.ts";
import { run as requestRelease } from "../../flows/hold-release-request.ts";
import {
  HOLD_RELEASE_REQUEST_FLOW_PATH,
  HOLD_RELEASE_REQUEST_PAGE,
} from "../../flows/lib/held-items.ts";
import { approvalDecision } from "../../src/core/approvals.ts";
import { holdReleaseRequest, holdReleaseTopic } from "../../src/core/hold-release.ts";
import { createLibrary } from "../../src/core/library.ts";
import { createFlowFixture, type FlowFixture } from "./flow-fixture.ts";

async function rejectedHeldItem(f: FlowFixture, words: string) {
  const library = createLibrary(f.deps);
  const node = await f.node("ready_for_dev", {
    title: "Remove the old page",
    hold: true,
  });
  const request = await library.openGateRequest(
    holdReleaseRequest(node, {
      title: node.title,
      description: "Delete the old page.",
      ideaId: "60000000-0000-4000-8000-000000000001",
      note: "Hold until the new page has run a week.",
    }),
  );
  await library.answerGateRequest(
    request.id,
    approvalDecision(request, { choice: "reject", words, approvers: ["anonymous"] }),
  );
  return node;
}

describe("the daily check flow (flow: fake adapters, M4.4)", () => {
  it("returns the page, then the check as JSON and as plain text, with each held item's link and fresh-request flow", async () => {
    const f = await createFlowFixture();
    const held = await rejectedHeldItem(f, "Not this week.");
    const blocked = await f.node("blocked", { title: "Build the page" });
    const result = await dailyCheck(f.deps);
    // Windmill renders a result whose only key is `render_all`, each view in turn: the page
    // first, then the data as JSON. It keeps the result as JSON: it survives the round trip.
    expect(Object.keys(result)).toEqual(["render_all"]);
    expect(result.render_all.map((view) => Object.keys(view))).toEqual([
      ["html"],
      ["json"],
    ]);
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      render_all: [
        {},
        { json: { check: { switches: { killSwitch: false, dryRun: true } } } },
      ],
    });
    const [{ html }, { json }] = result.render_all;
    expect(json.check.projects).toMatchObject([
      {
        slug: "rehearsal",
        waitingItems: 2,
        blocked: [{ nodeId: blocked.id }],
        heldItems: [
          {
            nodeId: held.id,
            lastNote: { text: "Not this week." },
            freshRequest: {
              flow: HOLD_RELEASE_REQUEST_FLOW_PATH,
              input: { nodeId: held.id },
            },
          },
        ],
      },
    ]);
    expect(json.text).toContain(`start ${HOLD_RELEASE_REQUEST_FLOW_PATH} with`);
    expect(json.text.split("\n").length).toBeLessThan(30);
    // The page links the held item to the fresh release request's Windmill page, a path on
    // Windmill's own origin behind its sign-in (D-295), with the flow's path and the item id as
    // text beside it. No other link: the project records no staging address.
    expect(HOLD_RELEASE_REQUEST_PAGE).toBe(
      "/scripts/get/f/foreman/hold_release_request",
    );
    expect(html).toContain(
      `start <a href="${HOLD_RELEASE_REQUEST_PAGE}">${HOLD_RELEASE_REQUEST_FLOW_PATH}</a> with {&quot;nodeId&quot;:&quot;${held.id}&quot;}`,
    );
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain("Dry run: on");

    // The entry's input is what the fresh release request flow takes: Didi starts it, not this.
    const [entry] = json.check.projects[0]?.heldItems ?? [];
    await f.live();
    expect(
      await requestRelease(f.deps, entry?.freshRequest.input ?? { nodeId: "" }),
    ).toMatchObject({
      nodeId: held.id,
      step: "opened",
    });
  });

  it("writes nothing and asks nothing, under the kill switch, in dry run and live", async () => {
    const f = await createFlowFixture();
    const held = await rejectedHeldItem(f, "Not yet.");
    const blocked = await f.node("blocked");
    const before = await f.footprint(held.id, blocked.id);
    const topic = holdReleaseTopic(held.id);
    for (const step of ["dry_run", "live", "killed"] as const) {
      if (step === "live") await f.live();
      if (step === "killed") await f.killed();
      const [, { json }] = (await dailyCheck(f.deps)).render_all;
      expect(json.check.projects[0]?.heldItems).toHaveLength(1);
      expect(await f.footprint(held.id, blocked.id)).toBe(before);
      expect(await f.store.listGateRequests(f.projectId, topic)).toHaveLength(1);
      expect(f.runtime.started).toEqual([]);
    }
    const [{ html }, { json }] = (await dailyCheck(f.deps)).render_all;
    expect(json.check.switches).toEqual({ killSwitch: true, dryRun: false });
    expect(json.text).toContain("Kill switch: on");
    expect(html).toContain("Kill switch: on (the runner acts on nothing)");
  });

  it("calls nothing that writes, sends or opens a request", () => {
    const source = readFileSync("flows/daily-check.ts", "utf8");
    expect(source).not.toMatch(
      /requestAgain|openGateRequest|answerGateRequest|transaction|fetch\(/,
    );
  });
});
