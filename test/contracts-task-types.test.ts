// Seam: unit, repo guard (ADR 0114 section 1, ADR 0105). contracts/task-types.yaml and each bot
// file's task_types (contracts/bots/) load through the contracts-file adapter and pass the core's
// check, and the core tests' copy of them (TEST_TASK_TYPES) matches the files.
import { describe, expect, it } from "vitest";

import {
  botTaskTypes,
  readBotFiles,
} from "../src/adapters/contracts-file/bot-files.ts";
import { loadTaskTypesFile } from "../src/adapters/contracts-file/load.ts";
import { TEST_TASK_TYPES } from "../src/core/routing-testing.ts";
import { validateTaskTypes } from "../src/core/task-types.ts";

describe("contracts/task-types.yaml and the bot files' task types (unit: repo guard, ADR 0114 section 1)", () => {
  it("is valid and equals the copy the core tests use", () => {
    const { taskTypes, problems } = validateTaskTypes(
      TEST_TASK_TYPES.version,
      loadTaskTypesFile(),
      botTaskTypes(readBotFiles()),
    );
    expect(problems).toEqual([]);
    expect(taskTypes).toEqual(TEST_TASK_TYPES);
  });

  it("names the six task types of ADR 0114 section 1 and QA's visual comparison (D-242)", () => {
    expect(Object.keys(TEST_TASK_TYPES.meanings).sort()).toEqual([
      "council",
      "designer",
      "developer:code",
      "developer:infra",
      "qa:review",
      "qa:visual",
      "triage",
    ]);
  });
});
