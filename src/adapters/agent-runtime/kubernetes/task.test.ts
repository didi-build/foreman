import { describe, expect, it } from "vitest";

import type { AgentRole } from "../runtime.ts";
import { taskFileJson, type AgentTaskFile } from "./task.ts";

// Unit: the task file's `discussion` (ADR 0119 slice 6, D-483, D-484): a Council task only, with
// the chair, a cast of distinct personas other than the chair and a pull-in limit of 0 to 2. The
// image reads the file with the same check (src/agent-images/shared/task.ts).

const SCHEMA = { type: "object" };
const COUNCIL: AgentTaskFile = {
  foremanTask: 1,
  instructions: "Decide.",
  input: "The question.",
  outputSchema: SCHEMA,
};
const DISCUSSION = { chair: "product", cast: ["developer", "quality"], maxPullIns: 2 };
const IMAGE = {
  label: "Image 1: option a",
  mediaType: "image/png",
  data: "iVBORw0KGgo=",
};

const check = (role: AgentRole, task: object) =>
  taskFileJson(role, task as AgentTaskFile);

describe("a Council task's discussion (unit: task file, ADR 0119 slice 6)", () => {
  it("is taken on a Council task and on its visual call, and kept in the file as given", () => {
    const task = { ...COUNCIL, discussion: DISCUSSION };
    expect(JSON.parse(check("council", task))).toEqual(task);
    const visual = { ...task, images: [IMAGE] };
    expect(JSON.parse(check("council", visual))).toEqual(visual);
    for (const cast of [[], ["designer"], ["designer", "developer", "quality"]]) {
      for (const maxPullIns of [0, 1, 2]) {
        expect(() =>
          check("council", {
            ...COUNCIL,
            discussion: { chair: "product", cast, maxPullIns },
          }),
        ).not.toThrow();
      }
    }
  });

  it("leaves a Council task without one as it was", () => {
    expect(JSON.parse(check("council", COUNCIL))).toEqual(COUNCIL);
  });

  it("is refused on every other role", () => {
    const qa = {
      foremanTask: 1,
      instructions: "Review.",
      input: "diff",
      nodeId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
      evidenceIds: [],
    };
    const builder = {
      foremanTask: 1,
      instructions: "Build.",
      input: "The item.",
      allowedTools: ["Read"],
      nodeId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
      branch: "foreman/1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
    };
    const refused = /^only a Council task has a discussion$/;
    expect(() => check("triage", { ...COUNCIL, discussion: DISCUSSION })).toThrow(
      refused,
    );
    expect(() => check("qa", { ...qa, discussion: DISCUSSION })).toThrow(refused);
    expect(() =>
      check("qa", {
        ...qa,
        outputSchema: SCHEMA,
        images: [IMAGE],
        discussion: DISCUSSION,
      }),
    ).toThrow(refused);
    for (const role of ["developer", "designer"] as const) {
      expect(() => check(role, { ...builder, discussion: DISCUSSION })).toThrow(
        refused,
      );
    }
  });

  it.each([
    ["not an object", "product", /must have its chair, cast and maxPullIns only/],
    ["a list", [DISCUSSION], /must have its chair, cast and maxPullIns only/],
    [
      "a missing part",
      { chair: "product", cast: [] },
      /must have its chair, cast and maxPullIns only/,
    ],
    [
      "another field",
      { ...DISCUSSION, topic: "x" },
      /must have its chair, cast and maxPullIns only/,
    ],
    [
      "another chair",
      { ...DISCUSSION, chair: "developer" },
      /discussion chair must be product$/,
    ],
    [
      "an unknown chair",
      { ...DISCUSSION, chair: "cto" },
      /discussion chair must be product$/,
    ],
    [
      "a cast that is not a list",
      { ...DISCUSSION, cast: "developer" },
      /cast must be a list of at most 3 personas$/,
    ],
    [
      "a cast of four",
      { ...DISCUSSION, cast: ["developer", "designer", "quality", "developer"] },
      /cast must be a list of at most 3 personas$/,
    ],
    [
      "the chair in the cast",
      { ...DISCUSSION, cast: ["product"] },
      /cast must be personas other than the chair$/,
    ],
    [
      "an unknown persona in the cast",
      { ...DISCUSSION, cast: ["cto"] },
      /cast must be personas other than the chair$/,
    ],
    [
      "a cast entry that is not text",
      { ...DISCUSSION, cast: [1] },
      /cast must be personas other than the chair$/,
    ],
    [
      "a persona twice in the cast",
      { ...DISCUSSION, cast: ["quality", "quality"] },
      /cast lists a persona twice$/,
    ],
    [
      "three pull-ins",
      { ...DISCUSSION, maxPullIns: 3 },
      /maxPullIns must be a whole number from 0 to 2$/,
    ],
    [
      "a negative limit",
      { ...DISCUSSION, maxPullIns: -1 },
      /maxPullIns must be a whole number from 0 to 2$/,
    ],
    [
      "a fraction",
      { ...DISCUSSION, maxPullIns: 1.5 },
      /maxPullIns must be a whole number from 0 to 2$/,
    ],
    [
      "a limit as text",
      { ...DISCUSSION, maxPullIns: "2" },
      /maxPullIns must be a whole number from 0 to 2$/,
    ],
  ])("refuses %s, naming the part and never a value", (_, discussion, problem) => {
    expect(() => check("council", { ...COUNCIL, discussion })).toThrow(problem);
    expect(() => check("council", { ...COUNCIL, discussion })).not.toThrow(/cto|topic/);
  });
});
