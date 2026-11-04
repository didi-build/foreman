// Seam: the daily check flow f/foreman/daily_check (build plan M4.4, O-91) with fake adapters on
// the memory store. The generator itself is tested in test/daily-check.test.ts; this covers what
// the flow adds: the result Didi reads in Windmill (the check as JSON and as plain text), the
// fresh-request flow each held item names, and that the flow writes nothing under any switch.
// Synthetic data only.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { run as dailyCheck } from "../../flows/daily-check.ts";
import { run as requestRelease } from "../../flows/hold-release-request.ts";
import { HOLD_RELEASE_REQUEST_FLOW_PATH } from "../../flows/lib/held-items.ts";
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
  it("returns the check as JSON and as plain text, with each held item's fresh-request flow", async () => {
    const f = await createFlowFixture();
    const held = await rejectedHeldItem(f, "Not this week.");
    const blocked = await f.node("blocked", { title: "Build the page" });
    const result = await dailyCheck(f.deps);
    // Windmill keeps the result as JSON: it survives the round trip.
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      check: { switches: { killSwitch: false, dryRun: true } },
    });
    expect(result.check.projects).toMatchObject([
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
    expect(result.text).toContain(`start ${HOLD_RELEASE_REQUEST_FLOW_PATH} with`);
    expect(result.text.split("\n").length).toBeLessThan(30);

    // The entry's input is what the fresh release request flow takes: Didi starts it, not this.
    const [entry] = result.check.projects[0]?.heldItems ?? [];
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
      const result = await dailyCheck(f.deps);
      expect(result.check.projects[0]?.heldItems).toHaveLength(1);
      expect(await f.footprint(held.id, blocked.id)).toBe(before);
      expect(await f.store.listGateRequests(f.projectId, topic)).toHaveLength(1);
      expect(f.runtime.started).toEqual([]);
    }
    const result = await dailyCheck(f.deps);
    expect(result.check.switches).toEqual({ killSwitch: true, dryRun: false });
    expect(result.text).toContain("Kill switch: on");
  });

  it("calls nothing that writes, sends or opens a request", () => {
    const source = readFileSync("flows/daily-check.ts", "utf8");
    expect(source).not.toMatch(
      /requestAgain|openGateRequest|answerGateRequest|transaction|fetch\(/,
    );
  });
});
