// Test support for the Council's call on a visual approval (D-263, D-270): a design item in
// Waiting for Didi on the reconcile fixture, with the runner's screenshot of each option, CI's
// options bundle at the capture commit in a fake port, and an open `visual_approval` request owned
// by Didi that lists the options. Synthetic images only, drawn in code.
import { createHash } from "node:crypto";

import {
  createFakeScreenshotBundles,
  type FakeScreenshotBundles,
} from "../src/adapters/screenshots/fake.ts";
import { encodePng } from "../src/adapters/screenshots/png.ts";
import { visualApprovalTopic } from "../src/core/guards/design.ts";
import type { GateRequest } from "../src/core/store.ts";
import {
  optionScreenshotPayload,
  type OptionShot,
} from "../src/core/visual-comparison.ts";
import { paintBox, solidRaster } from "../src/core/visual-diff.ts";
import { REPO, type ReconcileFixture } from "./reconcile-fixture.ts";

export const CALL_OPTION_COMMIT = "a".repeat(40);

/** A valid answer for the call's schema. */
export const CALL = {
  call: "small_tweak_council_would_approve",
  reason: "Only the button's colour changes, inside the existing look.",
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface VisualCallSetup {
  screenshots: FakeScreenshotBundles;
  nodeId: string;
  gate: GateRequest;
  /** The PNG bytes of each option page, by option name. */
  pages: Map<string, Uint8Array>;
}

export async function setupVisualCall(
  f: ReconcileFixture,
  options: string[] = ["a", "b"],
  screenshots: FakeScreenshotBundles = createFakeScreenshotBundles(),
): Promise<VisualCallSetup> {
  const node = await f.node("waiting_for_didi", {
    track: "design",
    ownerRole: "didi",
    title: "Example button",
    body: { description: "Make the export button easier to see." },
  });
  const pages = new Map<string, Uint8Array>();
  const shots: OptionShot[] = options.map((option, i) => {
    const page = encodePng(
      paintBox(
        solidRaster(120, 80, [255, 255, 255, 255]),
        { x: 10 + i * 5, y: 20, width: 60, height: 20 },
        [20, 60 + i * 40, 200, 255],
      ),
    );
    pages.set(option, page);
    return {
      option,
      path: `design/gallery/example-button/options/${option}`,
      file: `options/${option}.png`,
      sha256: sha256(page),
      width: 120,
      height: 80,
      regions: [],
    };
  });
  screenshots.put(REPO, CALL_OPTION_COMMIT, "options", {
    manifest: {
      foremanScreenshots: 1,
      kind: "options",
      commit: CALL_OPTION_COMMIT,
      options: shots,
    },
    files: new Map(shots.map((s) => [s.file, pages.get(s.option) as Uint8Array])),
  });
  for (const shot of shots) {
    await f.evidence(node.id, "screenshot", optionScreenshotPayload(shot), {
      commitSha: CALL_OPTION_COMMIT,
    });
  }
  const gate = await f.openGate(node.id, visualApprovalTopic(node.id), {
    kind: "visual_approval",
    owner: "didi",
    payload: { options },
  });
  return { screenshots, nodeId: node.id, gate, pages };
}
