// Seam: the real contracts through the library (ADR 0105 success check 3). Loads the files
// through the adapter, validates them with zero problems, and walks a work item through the
// code track and the design track on the memory store with fake guards, plus escalation from
// a working state and the return to it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadContractFiles } from "../src/adapters/contracts-file/load.ts";
import { validateContracts, type GuardRegistry } from "../src/core/contracts.ts";
import { createLibrary, type Clock, type IdSource } from "../src/core/library.ts";
import { createMemoryStore } from "../src/core/memory-store.ts";
import type { Track } from "../src/core/store.ts";
import { GUARD_NAMES } from "./lib/guard-names.ts";

const PROJECT = "00000000-0000-4000-8000-000000000001";
const RUNNER = { kind: "runner" as const, id: "runner" };
const RECONCILE = { kind: "reconcile" as const, ref: null };

/** Every guard passes, so the walk exercises only the contracts' legal moves. */
const GUARDS: GuardRegistry = Object.fromEntries(
  GUARD_NAMES.map((name) => [
    name,
    async () => ({ name, pass: true, evidenceIds: [] }),
  ]),
);

function fixedClock(): Clock {
  let tick = 0;
  return { now: () => new Date(Date.UTC(2026, 9, 29, 0, 0, tick++)) };
}

function sequentialIds(): IdSource {
  let n = 0;
  return { next: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` };
}

async function setup() {
  const loaded = loadContractFiles("c".repeat(40));
  const { contracts, problems } = validateContracts(loaded.raw, GUARD_NAMES);
  expect(problems).toEqual([]);
  expect(contracts).toBeDefined();
  const store = createMemoryStore();
  const clock = fixedClock();
  await store.insertProject({
    id: PROJECT,
    slug: "rehearsal",
    name: "Rehearsal",
    repo: "didi-build/rehearsal",
    linearProjectId: null,
    galleryPathOverride: null,
    privilegedPathsExtra: [],
    prodRequiresApproval: false,
    stagingUrl: null,
    createdAt: clock.now(),
  });
  for (const [key, value] of [
    ["kill_switch", false],
    ["dry_run", false],
  ] as const) {
    await store.setSetting({ key, value, updatedBy: "test", updatedAt: clock.now() });
  }
  const library = createLibrary({
    store,
    contracts: contracts as NonNullable<typeof contracts>,
    guards: GUARDS,
    clock,
    ids: sequentialIds(),
  });
  return { library, store };
}

type LibraryOf = Awaited<ReturnType<typeof setup>>["library"];

async function walk(
  library: LibraryOf,
  nodeId: string,
  states: string[],
): Promise<void> {
  for (const toState of states) {
    const result = await library.requestTransition({
      nodeId,
      toState,
      trigger: RECONCILE,
      actor: RUNNER,
      blockedReason: toState.startsWith("escalated") ? "stuck" : undefined,
    });
    expect(result.outcome, `move to ${toState}: ${result.reason ?? ""}`).toBe(
      "applied",
    );
  }
}

const newItem = (
  library: LibraryOf,
  track: Track,
  state: string,
  blockedReason?: string,
) =>
  library.createNode({
    projectId: PROJECT,
    type: "work_item",
    track,
    state,
    ownerRole: "runner",
    title: "An item",
    agentReady: true,
    blockedReason,
  });

describe("the real contracts drive the library (contract walkthrough, ADR 0105)", () => {
  it("content hash is stable across loads and is a sha256", () => {
    const first = loadContractFiles("c".repeat(40));
    const second = loadContractFiles("c".repeat(40));
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.files).toEqual(["code.yaml", "design.yaml", "escalation.yaml"]);
  });

  it("walks the code track from Blocked to Done, with the QA fail loop", async () => {
    const { library } = await setup();
    const node = await newItem(library, "code", "blocked", "waits on the design item");
    await walk(library, node.id, [
      "ready_for_dev",
      "in_development",
      "in_qa_review",
      "in_development", // the QA fail loop
      "in_qa_review",
      "verifying_on_staging",
      "done",
    ]);
  });

  it("walks the design track from Ready for design exploration to Done", async () => {
    const { library } = await setup();
    const node = await newItem(library, "design", "ready_for_design_exploration");
    await walk(library, node.id, [
      "in_design_exploration",
      "waiting_for_didi",
      "in_design_exploration", // Didi asked for changes (fallback move)
      "waiting_for_didi",
      "writing_spec",
      "building_components",
      "in_qa_review",
      "verifying_on_staging",
      "done",
    ]);
  });

  it("escalates from In development to the Council and returns to In development", async () => {
    const { library, store } = await setup();
    const node = await newItem(library, "code", "ready_for_dev");
    await walk(library, node.id, ["in_development", "escalated_to_council"]);
    expect((await store.getNode(node.id))?.blockedReason).toBe("stuck");
    await walk(library, node.id, ["in_development"]);
    expect((await store.getNode(node.id))?.state).toBe("in_development");
  });

  it("escalates on to Didi and still returns to the working state", async () => {
    const { library } = await setup();
    const node = await newItem(library, "design", "ready_for_design_exploration");
    await walk(library, node.id, [
      "in_design_exploration",
      "escalated_to_council",
      "escalated_to_didi",
      "in_design_exploration",
    ]);
  });

  it("rejects a return to a state the item did not come from", async () => {
    const { library } = await setup();
    const node = await newItem(library, "code", "ready_for_dev");
    await walk(library, node.id, ["in_development", "escalated_to_council"]);
    const wrong = await library.requestTransition({
      nodeId: node.id,
      toState: "ready_for_dev",
      trigger: RECONCILE,
      actor: RUNNER,
    });
    expect(wrong).toMatchObject({ outcome: "rejected", reason: "illegal_move" });
  });

  it("rejects a move whose tracks do not include the node's track", async () => {
    const { library } = await setup();
    const code = await newItem(library, "code", "blocked", "waits");
    await walk(library, code.id, ["ready_for_dev", "in_development", "in_qa_review"]);
    const crossTrack = await library.requestTransition({
      nodeId: code.id,
      toState: "building_components",
      trigger: RECONCILE,
      actor: RUNNER,
    });
    expect(crossTrack).toMatchObject({ outcome: "rejected", reason: "illegal_move" });
  });
});

describe("the contracts-file loader (contract walkthrough, ADR 0105)", () => {
  it("rejects a state declared in two files", () => {
    const dir = mkdtempSync(join(tmpdir(), "foreman-contracts-"));
    const state = "states:\n  done:\n    label: Done\n    owner: Runner\n";
    writeFileSync(join(dir, "a.yaml"), `part: code\n${state}`);
    writeFileSync(join(dir, "b.yaml"), `part: design\n${state}`);
    expect(() => loadContractFiles("c".repeat(40), dir)).toThrow(
      /declared in both a\.yaml and b\.yaml/,
    );
  });
});
