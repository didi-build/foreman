// Seam: unit (the contracts-file adapter's bot files, docs/bot-files.md, ADR 0107). The real files
// in contracts/bots/ load and pass the check, with the values the decisions set; a malformed file
// fails with every problem named by file and field and never by value; a key pasted where a
// secret path belongs is refused; the Council's answers check against the schemas read from its
// bot file. With the real persona files (ADR 0119 slice 2): each task type's persona is D-458's,
// each run's instructions are composed from the shared base, the persona and the task's text, the
// Council's stay as the file gives them, and a persona change reaches exactly the versions of the
// roles whose composed text it changes.
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { outputProblem } from "../../core/output-schema.ts";
import {
  COMPOSED_HEADINGS,
  composeInstructions,
  type Personas,
} from "../../core/personas.ts";
import { REHEARSAL_RUN_LIMITS } from "../../core/runs.ts";
import { OPTION_MARKERS } from "../../core/visual-comparison.ts";
import {
  BOT_FILES_DIR,
  BOT_ROLES,
  botProfiles,
  instructionsFor,
  loadBotFiles,
  readBotFiles,
  runLimits,
  secretPathFor,
  taskTypeLimits,
  validateBotFiles,
  type RawBotFile,
} from "./bot-files.ts";
import { PERSONAS_DIR, readPersonas } from "./personas.ts";

const D196 = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(git *)", "Bash(npm *)"];
/** A value shaped like a provider key. Not a real key. */
const PASTED_KEY = "sk-ant-api03-not-a-real-key-0123456789abcdef";

const real = () => loadBotFiles();
const PERSONAS_READ = readPersonas();
/** The bot file check, with the real persona files unless a test gives others. */
const check = (
  raw: Record<(typeof BOT_ROLES)[number], RawBotFile>,
  personas: Personas = PERSONAS_READ,
) => validateBotFiles(raw, personas);
/** The real files with one role's parsed data changed. */
function withData(
  role: (typeof BOT_ROLES)[number],
  change: (data: Record<string, unknown>) => void,
): Record<(typeof BOT_ROLES)[number], RawBotFile> {
  const files = real();
  const data = structuredClone(files[role].data) as Record<string, unknown>;
  change(data);
  return { ...files, [role]: { ...files[role], data } };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** A folder with a copy of the real files, plus or minus some. */
function folder(edit: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "bot-files-"));
  dirs.push(dir);
  for (const role of BOT_ROLES) {
    writeFileSync(
      join(dir, `${role}.yaml`),
      readFileSync(join(BOT_FILES_DIR, `${role}.yaml`)),
    );
  }
  edit(dir);
  return dir;
}

describe("the bot files in contracts/bots (unit: contracts-file adapter)", () => {
  it("load and pass the check, each at its own content hash", () => {
    const { bots, problems } = check(real());
    expect(problems).toEqual([]);
    for (const role of BOT_ROLES) {
      expect(bots?.[role].role).toBe(role);
      expect(bots?.[role].version).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(bots?.[role].instructions.trim()).not.toBe("");
    }
    // A change of one byte is a new version.
    const dir = folder((d) =>
      writeFileSync(
        join(d, "qa.yaml"),
        `${readFileSync(join(d, "qa.yaml"), "utf8")}\n# changed\n`,
      ),
    );
    expect(loadBotFiles(dir).qa.version).not.toBe(real().qa.version);
    expect(loadBotFiles(dir).council.version).toBe(real().council.version);
  });

  it("run the Developer and Designer on OpenCode with D-196's tools, and the rest on the Messages API", () => {
    const bots = readBotFiles();
    for (const role of ["developer", "designer"] as const) {
      expect(bots[role].image).toBe("opencode");
      expect(bots[role].allowedTools).toEqual(D196);
      expect(bots[role].providers.every((p) => p.api !== undefined)).toBe(true);
    }
    for (const role of ["qa", "council", "triage"] as const) {
      expect(bots[role].image).toBe("claude-api");
      expect(bots[role].allowedTools).toBeUndefined();
      expect(bots[role].allowedHosts).toEqual([]);
    }
    // MagicPath stays off until D-190's gate, and only the Designer has the switch.
    expect(bots.designer.magicPath).toBe(false);
    expect(bots.developer.magicPath).toBeUndefined();
    expect(bots.qa.fetchAllowedHosts?.length).toBeGreaterThan(0);
    expect(Object.keys(bots.council.outputSchemas ?? {})).toEqual([
      "escalation",
      "reversal",
      "visual_call",
      "scanner_gone",
      "still_needed",
      "plan",
    ]);
    expect(Object.keys(bots.triage.outputSchemas ?? {})).toEqual(["answer"]);
  });

  it("give QA, Council and Triage DeepInfra's Anthropic endpoint beside Anthropic, Anthropic as before (O-152)", () => {
    const bots = readBotFiles();
    for (const role of ["qa", "council", "triage"] as const) {
      expect(bots[role].providers).toEqual([
        {
          name: "anthropic",
          upstream: "https://api.anthropic.com",
          credential: "x-api-key",
          secretPath: "projects/{project}/models/anthropic",
          baseUrlEnv: "ANTHROPIC_BASE_URL",
        },
        {
          name: "deepinfra",
          upstream: "https://api.deepinfra.com/anthropic",
          credential: "x-api-key",
          secretPath: "projects/{project}/models/deepinfra",
          baseUrlEnv: "ANTHROPIC_BASE_URL",
          messagesApi: { answer: "tool", promptCacheKey: true },
        },
      ]);
    }
    for (const role of ["developer", "designer"] as const) {
      expect(bots[role].providers.some((p) => p.messagesApi !== undefined)).toBe(false);
    }
  });

  it("tell the Designer to mark option components and to delete the options Didi did not pick (D-255, D-253)", () => {
    const text = readBotFiles().designer.instructions.replace(/\s+/g, " ");
    expect(text).toContain(
      'Wrap each component on an option page in an element with data-component="<name>" and, where it has variants, data-variant="<name>"',
    );
    expect(text).toContain(
      "Delete the folders of the options Didi did not pick; the approved option's folder stays.",
    );
    // The markers are the ones the runner's region lookup reads.
    expect(text).toContain(OPTION_MARKERS.component);
    expect(text).toContain(OPTION_MARKERS.variant);
  });

  it("carry D-185's caps, equal to the copy the tests use, and name no model", () => {
    const bots = readBotFiles();
    expect(runLimits(bots)).toEqual(REHEARSAL_RUN_LIMITS);
    for (const role of BOT_ROLES) {
      const data = real()[role].data as Record<string, unknown>;
      expect(Object.keys(data)).not.toContain("model");
    }
    expect(botProfiles(bots).council).toEqual({
      runtime: "claude-api",
      botVersion: bots.council.version,
      outputSchemas: bots.council.outputSchemas,
    });
    // Triage's answer schema, which the runner checks every answer against (D-262, M3.6).
    expect(botProfiles(bots).triage.outputSchemas).toEqual(bots.triage.outputSchemas);
  });

  it("name each provider key by a per-project secret path, never a value", () => {
    const bots = readBotFiles();
    for (const role of BOT_ROLES) {
      for (const provider of bots[role].providers) {
        expect(provider.secretPath).toBe(`projects/{project}/models/${provider.name}`);
      }
    }
    expect(secretPathFor("projects/{project}/models/anthropic", "rehearsal")).toBe(
      "projects/rehearsal/models/anthropic",
    );
  });

  it("check the Council's answers against the schemas read from its bot file", () => {
    const schemas = readBotFiles().council.outputSchemas ?? {};
    const escalation = schemas.escalation;
    const reversal = schemas.reversal;
    expect(
      outputProblem(escalation, {
        outcome: "resolve",
        note: "Split it.",
        changesProductDirection: false,
        passesGate: false,
      }),
    ).toBeNull();
    expect(
      outputProblem(escalation, {
        outcome: "maybe",
        note: "x",
        changesProductDirection: false,
        passesGate: false,
      }),
    ).toBe("outcome must be one of the schema's values");
    expect(outputProblem(escalation, { outcome: "resolve" })).toBe(
      "the answer note is missing",
    );
    expect(
      outputProblem(reversal, {
        verdicts: [{ nodeId: "n", verdict: "redo", note: "x", extra: PASTED_KEY }],
        note: "",
      }),
    ).toBe("verdicts[0] has a field the schema does not allow");
    expect(
      outputProblem(reversal, {
        verdicts: [{ nodeId: "n", verdict: "redo", note: "x" }],
        note: "",
      }),
    ).toBeNull();
  });
});

describe("a malformed bot file (unit: contracts-file adapter)", () => {
  it("fails with every problem, naming the file and the field, never the value", () => {
    const { bots, problems } = check(
      withData("developer", (d) => {
        d.model = PASTED_KEY;
        d.extra = PASTED_KEY;
        d.role = "qa";
        d.image = "claude-api";
        d.limits = { max_turns: 0, max_minutes: 90, max_usd: -1, max_agents: 2 };
        d.allowed_tools = [
          "Read",
          "Bash",
          "Bash(*)",
          "mcp__magicpath",
          PASTED_KEY + "()",
        ];
        d.allowed_hosts = ["github.com", "10.0.0.1"];
        d.instructions = "";
        d.output_schemas = { answer: { type: "object" } };
      }),
    );
    expect(bots).toBeUndefined();
    expect(problems).toEqual(
      expect.arrayContaining([
        "developer.yaml: model is not a bot file field: each run's route names the model (ADR 0114)",
        "developer.yaml: unknown field extra",
        "developer.yaml: role must be developer, the file's own role",
        "developer.yaml: image must be an agent image that runs the developer",
        "developer.yaml: instructions must be non-empty text",
        "developer.yaml: limits: unknown field max_agents",
        "developer.yaml: limits.max_turns must be a whole number above 0",
        "developer.yaml: limits.max_minutes must stay below 60, the GitHub token's lifetime",
        "developer.yaml: limits.max_usd must be an amount above 0",
        "developer.yaml: allowed_hosts[1] is not a plain host name (no IP address, port, wildcard or path)",
        "developer.yaml: allowed_tools[1] would allow every shell command",
        "developer.yaml: allowed_tools[2] would allow every shell command",
        "developer.yaml: allowed_tools[3] needs MagicPath switched on, for the Designer only (D-190)",
        "developer.yaml: allowed_tools[4] is not a tool name",
        "developer.yaml: output_schemas: a developer run has no structured answer here",
      ]),
    );
    expect(problems.join("\n")).not.toContain("sk-ant");
  });

  it("refuses a key pasted in place of a secret path, without repeating it", () => {
    for (const role of BOT_ROLES) {
      const { problems } = check(
        withData(role, (d) => {
          (d.providers as Record<string, unknown>[])[0].secret_path = PASTED_KEY;
        }),
      );
      expect(problems).toEqual([
        `${role}.yaml: providers[0].secret_path must be a secret path such as projects/{project}/models/<provider>, never a key`,
      ]);
    }
    // A path outside platform/ and projects/, or with a dot segment, is not a secret path either.
    for (const path of [
      "models/anthropic",
      "projects/../platform",
      "projects/{slug}/x",
    ]) {
      const { problems } = check(
        withData("qa", (d) => {
          (d.providers as Record<string, unknown>[])[0].secret_path = path;
        }),
      );
      expect(problems).toHaveLength(1);
    }
  });

  it("refuses a provider the run's image cannot use, and one the proxy would refuse", () => {
    const { problems } = check(
      withData("council", (d) => {
        d.providers = [
          {
            name: "deepinfra",
            upstream: "https://api.deepinfra.com",
            credential: "bearer",
            secret_path: "projects/{project}/models/deepinfra",
            api: { kind: "openai-compatible", path: "/v1/openai" },
          },
        ];
      }),
    );
    expect(problems).toEqual([
      "council.yaml: providers[0].base_url_env must be ANTHROPIC_BASE_URL, with no api, for the Messages API image",
    ]);
    const proxy = check(
      withData("developer", (d) => {
        (d.providers as Record<string, unknown>[])[1].upstream =
          "http://api.deepinfra.com";
      }),
    );
    expect(proxy.problems).toEqual([
      "developer.yaml: providers: entry 2 has an invalid upstream (an https URL with no credentials, query or fragment)",
    ]);
    const openCode = check(
      withData("designer", (d) => {
        delete (d.providers as Record<string, unknown>[])[0].api;
      }),
    );
    expect(openCode.problems).toEqual([
      "designer.yaml: providers[0].api is needed: the OpenCode image reads the provider's API",
    ]);
  });

  it("takes messages_api with its defaults on a Messages API provider only, and refuses a bad one by field (O-152)", () => {
    const council = (messagesApi: unknown, at = 0) =>
      check(
        withData("council", (d) => {
          (d.providers as Record<string, unknown>[])[at].messages_api = messagesApi;
        }),
      );
    // Each key is optional: the answer defaults to structured outputs, the key to off.
    expect(council({}).bots?.council.providers[0]?.messagesApi).toEqual({
      answer: "schema",
      promptCacheKey: false,
    });
    expect(
      council({ prompt_cache_key: true }).bots?.council.providers[0]?.messagesApi,
    ).toEqual({ answer: "schema", promptCacheKey: true });
    expect(council({ answer: "tool" }).bots?.council.providers[0]?.messagesApi).toEqual(
      {
        answer: "tool",
        promptCacheKey: false,
      },
    );
    expect(council({ answer: "json", prompt_cache_key: "yes" }).problems).toEqual([
      "council.yaml: providers[0].messages_api.answer must be schema or tool",
      "council.yaml: providers[0].messages_api.prompt_cache_key must be true or false",
    ]);
    expect(council({ answer: "tool", format: PASTED_KEY }, 1).problems).toEqual([
      "council.yaml: providers[1].messages_api: unknown field format",
    ]);
    expect(council("tool").problems).toEqual([
      "council.yaml: providers[0].messages_api must be a mapping of answer and prompt_cache_key",
    ]);
    const openCode = check(
      withData("developer", (d) => {
        (d.providers as Record<string, unknown>[])[1].messages_api = { answer: "tool" };
      }),
    );
    expect(openCode.problems).toEqual([
      "developer.yaml: providers[1].messages_api is only for the Messages API image (claude-api)",
    ]);
    for (const { problems } of [council({ answer: PASTED_KEY }), openCode]) {
      expect(problems.join("\n")).not.toContain("sk-ant");
    }
  });

  it("keeps MagicPath off, tools off the Messages API roles, and each role's hosts and schemas", () => {
    expect(
      check(
        withData("designer", (d) => {
          d.mcp = { magicpath: { enabled: true } };
        }),
      ).problems,
    ).toEqual([
      "designer.yaml: mcp.magicpath stays off until its new-credentials gate (D-190)",
    ]);
    expect(
      check(
        withData("qa", (d) => {
          d.allowed_tools = ["Read"];
          d.allowed_hosts = ["github.com"];
          d.mcp = { magicpath: { enabled: false } };
          delete d.fetch_allowed_hosts;
        }),
      ).problems,
    ).toEqual([
      "qa.yaml: allowed_hosts must be empty: a qa run reaches only its model provider and the state API",
      "qa.yaml: allowed_tools: a qa run has no tools",
      "qa.yaml: mcp is only for the Designer (D-196)",
      "qa.yaml: fetch_allowed_hosts must be a list of host names",
    ]);
    expect(
      check(
        withData("council", (d) => {
          d.output_schemas = {
            escalation: (d.output_schemas as Record<string, unknown>).escalation,
            visual_call: (d.output_schemas as Record<string, unknown>).visual_call,
            scanner_gone: (d.output_schemas as Record<string, unknown>).scanner_gone,
            still_needed: (d.output_schemas as Record<string, unknown>).still_needed,
            plan: (d.output_schemas as Record<string, unknown>).plan,
            reversal: {
              type: "object",
              properties: { a: { type: "string", pattern: "x" } },
            },
          };
        }),
      ).problems,
    ).toEqual([
      "council.yaml: output_schemas.reversal.additionalProperties must be false",
      "council.yaml: output_schemas.reversal.properties.a: keyword pattern is not supported on type string",
      "council.yaml: output_schemas.reversal.required must list distinct fields of its properties",
    ]);
    expect(
      check(
        withData("triage", (d) => {
          delete d.output_schemas;
        }),
      ).problems,
    ).toEqual(["triage.yaml: output_schemas must give exactly: answer"]);
  });

  it("declare all three context tools for QA, Triage, the Developer and the Designer, and none for the Council (ADR 0119 slice 3d, D-196)", () => {
    const bots = readBotFiles();
    for (const role of ["qa", "triage", "developer", "designer"] as const) {
      expect(bots[role].contextTools, role).toEqual([
        "search_decisions",
        "find_similar_items",
        "read_item_history",
      ]);
    }
    expect(bots.council.contextTools).toBeUndefined();
    expect(real().council.data as Record<string, unknown>).not.toHaveProperty(
      "context_tools",
    );
  });

  it("name the tools in the builders' task text, by the names OpenCode gives them (ADR 0119 slice 3d)", () => {
    const bots = readBotFiles();
    for (const role of ["developer", "designer"] as const) {
      const text = bots[role].instructions.replace(/\s+/g, " ");
      for (const tool of [
        "search_decisions",
        "find_similar_items",
        "read_item_history",
      ]) {
        expect(text, role).toContain(`foreman_${tool}`);
      }
      expect(text, role).toContain("package files and tool results");
    }
  });

  it("take context_tools for QA, Triage, the Developer and the Designer, each a known tool once (ADR 0119 slice 3c)", () => {
    for (const role of ["qa", "triage", "developer", "designer"] as const) {
      const { bots, problems } = check(
        withData(role, (d) => {
          d.context_tools = ["read_item_history", "search_decisions"];
        }),
      );
      expect(problems, role).toEqual([]);
      expect(bots?.[role].contextTools, role).toEqual([
        "read_item_history",
        "search_decisions",
      ]);
    }
    const problems = (role: (typeof BOT_ROLES)[number], value: unknown) =>
      check(
        withData(role, (d) => {
          d.context_tools = value;
        }),
      ).problems;
    expect(problems("council", ["search_decisions"])).toEqual([
      "council.yaml: context_tools: a council run gets no context tools",
    ]);
    const shape =
      "triage.yaml: context_tools must be a non-empty list of context tools (search_decisions, find_similar_items, read_item_history)";
    expect(problems("triage", [])).toEqual([shape]);
    expect(problems("triage", "search_decisions")).toEqual([shape]);
    expect(problems("triage", [3])).toEqual([shape]);
    expect(
      problems("qa", ["search_decisions", "Bash(curl *)", "search_decisions"]),
    ).toEqual([
      "qa.yaml: context_tools[1] is not a context tool",
      "qa.yaml: context_tools[2] repeats an earlier tool",
    ]);
    expect(JSON.stringify(problems("qa", ["Bash(curl *)"]))).not.toContain("curl");
  });

  it("take docs_lookup: true for QA, Triage, the Developer and the Designer, and nothing else (ADR 0119 slice 4b)", () => {
    for (const role of ["qa", "triage", "developer", "designer"] as const) {
      const { bots, problems } = check(
        withData(role, (d) => {
          d.docs_lookup = true;
        }),
      );
      expect(problems, role).toEqual([]);
      expect(bots?.[role].docsLookup, role).toBe(true);
      // The core reads it from the role's profile at the run's end (ADR 0119 slice 4c).
      if (bots) expect(botProfiles(bots)[role].docsLookup, role).toBe(true);
    }
    const problems = (role: (typeof BOT_ROLES)[number], value: unknown) =>
      check(
        withData(role, (d) => {
          d.docs_lookup = value;
        }),
      ).problems;
    expect(problems("council", true)).toEqual([
      "council.yaml: docs_lookup: a council run gets no documentation lookup",
    ]);
    for (const value of [false, "true", 1, null, ["vitest.dev"], { enabled: true }]) {
      expect(problems("developer", value), JSON.stringify(value)).toEqual([
        "developer.yaml: docs_lookup must be true when given",
      ]);
    }
    expect(JSON.stringify(problems("qa", ["vitest.dev"]))).not.toContain("vitest");
  });

  it("declare the documentation lookup for the Developer only, so far (ADR 0119 slice 4e, D-196, D-471)", () => {
    const bots = readBotFiles();
    expect(bots.developer.docsLookup).toBe(true);
    expect(botProfiles(bots).developer.docsLookup).toBe(true);
    for (const role of BOT_ROLES.filter((r) => r !== "developer")) {
      expect(bots[role].docsLookup, role).toBeUndefined();
      expect(botProfiles(bots)[role], role).not.toHaveProperty("docsLookup");
      expect(real()[role].data as Record<string, unknown>, role).not.toHaveProperty(
        "docs_lookup",
      );
    }
    const text = bots.developer.instructions.replace(/\s+/g, " ");
    expect(text).toContain("foreman_read_docs_page");
    expect(text).toContain('add "siteRequests" to the object');
  });

  it("give QA's visual comparison its answer schema and its own instructions, and no other role any (D-242)", () => {
    const bots = readBotFiles();
    expect(Object.keys(bots.qa.outputSchemas ?? {})).toEqual(["visual"]);
    expect(bots.qa.taskInstructions?.["qa:visual"]).toContain("cannot_tell");
    expect(botProfiles(bots).qa.outputSchemas).toEqual(bots.qa.outputSchemas);
    expect(
      check(
        withData("qa", (d) => {
          d.task_types = { allowed: ["qa:review"], default: "qa:review" };
        }),
      ).problems,
    ).toEqual([
      "qa.yaml: task_instructions.qa:visual must be an allowed task type other than the default",
      "qa.yaml: task_personas.qa:visual must be one of the role's allowed task types",
    ]);
    expect(
      check(
        withData("qa", (d) => {
          delete d.task_instructions;
          delete d.output_schemas;
        }),
      ).problems,
    ).toEqual([
      "qa.yaml: output_schemas must give exactly: visual",
      "qa.yaml: task_instructions must give exactly: qa:visual",
    ]);
    expect(
      check(
        withData("developer", (d) => {
          d.task_instructions = { "developer:infra": "Infra work." };
        }),
      ).problems,
    ).toEqual([
      "developer.yaml: task_instructions: a developer run has only its instructions",
    ]);
  });

  it("give the builders' close task type its own small limits and no new tool, and no other role any (D-318)", () => {
    const bots = readBotFiles();
    const small = { maxTurns: 1, maxMinutes: 5, maxUsd: 0.01 };
    expect(taskTypeLimits(bots)).toEqual({
      "developer:close": small,
      "designer:close": small,
    });
    // The close run uses the role's own tools list unchanged: no GitHub tool is added.
    expect(bots.developer.allowedTools).toEqual(D196);
    expect(bots.designer.allowedTools).toEqual(D196);
    expect(bots.developer.taskTypes).toMatchObject({
      allowed: expect.arrayContaining(["developer:close"]) as unknown,
      default: "developer:code",
    });
    expect(bots.designer.taskTypes).toMatchObject({
      allowed: expect.arrayContaining(["designer:close"]) as unknown,
      default: "designer",
    });
    expect(
      check(
        withData("developer", (d) => {
          d.task_types = {
            allowed: ["developer:code", "developer:infra"],
            default: "developer:code",
          };
        }),
      ).problems,
    ).toEqual([
      "developer.yaml: task_limits.developer:close must be an allowed task type other than the default",
    ]);
    expect(
      check(
        withData("designer", (d) => {
          delete d.task_limits;
        }),
      ).problems,
    ).toEqual(["designer.yaml: task_limits must give exactly: designer:close"]);
    expect(
      check(
        withData("developer", (d) => {
          d.task_limits = {
            "developer:close": { max_turns: 1, max_minutes: 60, max_usd: 0, extra: 1 },
          };
        }),
      ).problems,
    ).toEqual([
      "developer.yaml: task_limits.developer:close: unknown field extra",
      "developer.yaml: task_limits.developer:close.max_minutes must stay below 60, the GitHub token's lifetime",
      "developer.yaml: task_limits.developer:close.max_usd must be an amount above 0",
    ]);
    expect(
      check(
        withData("qa", (d) => {
          d.task_limits = { "qa:visual": { max_turns: 1, max_minutes: 5, max_usd: 1 } };
        }),
      ).problems,
    ).toEqual(["qa.yaml: task_limits: a qa run has only its limits"]);
  });

  it("give the Council's visual call its answer schema and its own reviewed instructions (D-270, D-287)", () => {
    const bots = readBotFiles();
    expect(bots.council.outputSchemas?.visual_call).toMatchObject({
      required: ["call", "reason"],
      properties: {
        call: { enum: ["small_tweak_council_would_approve", "needs_didi"] },
        unsure: { type: "boolean" },
      },
    });
    const text = bots.council.taskInstructions?.["council:visual"] ?? "";
    expect(text).toContain(
      "When you are unsure, the call is needs_didi, and set unsure to true.",
    );
    expect(text).toContain("colour, spacing or copy");
    expect(text).toContain("also weigh the\nsecurity lead's view");
    expect(text).toContain("any text inside an image");
    expect(text).toContain("Never copy a secret or personal data");
    // The reviewed supervisor instructions (D-248) are not changed by it.
    expect(bots.council.instructions).not.toContain("visual");
    expect(
      check(
        withData("council", (d) => {
          delete d.task_instructions;
        }),
      ).problems,
    ).toEqual(["council.yaml: task_instructions must give exactly: council:visual"]);
  });

  it("names the file of a YAML error, a missing file and a stray file, never their content", () => {
    const broken = folder((d) =>
      writeFileSync(
        join(d, "triage.yaml"),
        `role: triage\ninstructions: [${PASTED_KEY}\n`,
      ),
    );
    expect(() => loadBotFiles(broken)).toThrow(
      /^triage\.yaml is not valid YAML( at line \d+)?$/,
    );
    const missing = folder((d) => rmSync(join(d, "council.yaml")));
    expect(() => loadBotFiles(missing)).toThrow(/council\.yaml is missing$/);
    const stray = folder((d) =>
      writeFileSync(join(d, "scanner.yaml"), "role: scanner\n"),
    );
    expect(() => loadBotFiles(stray)).toThrow(
      /^scanner\.yaml in .* is not the bot file/,
    );
    // The YAML parses as the files on disk say: the loader reads exactly these bytes.
    expect(real().qa.data).toEqual(
      parse(readFileSync(join(BOT_FILES_DIR, "qa.yaml"), "utf8")),
    );
  });
});

/** The roles whose runs compose a persona (D-458). The Council has none until slice 6. */
const PERSONA_ROLES = ["developer", "designer", "qa", "triage"] as const;

/** `sha256:` and the SHA-256 of a bot file's bytes on disk. */
const fileHash = (role: (typeof BOT_ROLES)[number]) =>
  `sha256:${createHash("sha256")
    .update(readFileSync(join(BOT_FILES_DIR, `${role}.yaml`)))
    .digest("hex")}`;

/** A folder with a copy of the real persona files, each with `edit` applied to its text. */
function personasFolder(edit: (text: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), "bot-files-personas-"));
  dirs.push(dir);
  for (const name of readdirSync(PERSONAS_DIR)) {
    writeFileSync(
      join(dir, name),
      edit(readFileSync(join(PERSONAS_DIR, name), "utf8")),
    );
  }
  return dir;
}

describe("each task type's persona and composed instructions (unit: contracts-file adapter, ADR 0119 slice 2)", () => {
  it("map each task type that runs a model to D-458's persona, and give the Council none yet", () => {
    const bots = readBotFiles();
    expect(bots.triage.taskPersonas).toEqual({ triage: { persona: "product" } });
    expect(bots.developer.taskPersonas).toEqual({
      "developer:code": { persona: "developer" },
      "developer:infra": { persona: "developer" },
    });
    expect(bots.designer.taskPersonas).toEqual({
      designer: { persona: "designer", withCraftStandardsOf: "developer" },
    });
    expect(bots.qa.taskPersonas).toEqual({
      "qa:review": { persona: "quality" },
      "qa:visual": { persona: "quality", withCraftStandardsOf: "designer" },
    });
    expect(bots.council.taskPersonas).toBeUndefined();
  });

  it("give every allowed task type its text: the shared base, the persona, then the task's own text", () => {
    const bots = readBotFiles();
    for (const role of BOT_ROLES) {
      const { allowed } = bots[role].taskTypes as { allowed: string[] };
      expect(Object.keys(bots[role].runInstructions).sort(), role).toEqual(
        [...allowed].sort(),
      );
    }
    for (const role of PERSONA_ROLES) {
      for (const [taskType, persona] of Object.entries(bots[role].taskPersonas ?? {})) {
        const task = bots[role].taskInstructions?.[taskType] ?? bots[role].instructions;
        const text = instructionsFor(bots[role], taskType);
        expect(text, taskType).toBe(
          composeInstructions({ personas: PERSONAS_READ, ...persona, task }),
        );
        expect(text.startsWith(`${COMPOSED_HEADINGS.shared}\n\n`), taskType).toBe(true);
        expect(
          text.endsWith(`${COMPOSED_HEADINGS.task}\n\n${task.trimEnd()}`),
          taskType,
        ).toBe(true);
        expect(text.length, taskType).toBeLessThanOrEqual(32_000);
      }
    }
    // The extra craft standards only where D-458 asks for them.
    const also = "craft standards, which you also hold the work to:";
    expect(instructionsFor(bots.designer, "designer")).toContain(
      `The Developer's ${also}`,
    );
    expect(instructionsFor(bots.qa, "qa:visual")).toContain(`The Designer's ${also}`);
    for (const taskType of ["qa:review"]) {
      expect(instructionsFor(bots.qa, taskType)).not.toContain(also);
    }
    expect(instructionsFor(bots.triage, "triage")).not.toContain(also);
    expect(instructionsFor(bots.developer, "developer:code")).not.toContain(also);
  });

  it("keep the Council's text exactly as its file gives it, and give a close run the default's text", () => {
    const bots = readBotFiles();
    expect(instructionsFor(bots.council, "council")).toBe(bots.council.instructions);
    expect(instructionsFor(bots.council, "council:visual")).toBe(
      bots.council.taskInstructions?.["council:visual"],
    );
    expect(instructionsFor(bots.council, "council")).not.toContain(
      COMPOSED_HEADINGS.shared,
    );
    expect(instructionsFor(bots.developer, "developer:close")).toBe(
      instructionsFor(bots.developer, "developer:code"),
    );
    expect(instructionsFor(bots.designer, "designer:close")).toBe(
      instructionsFor(bots.designer, "designer"),
    );
    // The file's own text stays on the bot file, for the tests and images that read it.
    expect(bots.qa.instructions).not.toContain(COMPOSED_HEADINGS.shared);
  });

  it("refuse a task type the bot does not allow", () => {
    const bots = readBotFiles();
    expect(() => instructionsFor(bots.qa, "developer:code")).toThrow(
      "the qa bot file does not allow task type developer:code",
    );
    expect(() => instructionsFor(bots.triage, "constructor")).toThrow(
      "the triage bot file does not allow task type constructor",
    );
  });

  it("refuse a persona map that does not fit the role's task types, naming the file and the field, never a value", () => {
    expect(
      check(
        withData("triage", (d) => {
          delete d.task_personas;
        }),
      ).problems,
    ).toEqual([
      "triage.yaml: task_personas must map each task type that runs a model to its persona (D-458)",
    ]);
    expect(
      check(
        withData("council", (d) => {
          d.task_personas = { council: { persona: "product" } };
        }),
      ).problems,
    ).toEqual([
      "council.yaml: task_personas: the Council gets its personas in ADR 0119's slice 6",
    ]);
    const developer = check(
      withData("developer", (d) => {
        d.task_personas = {
          "developer:code": { persona: "developer" },
          "developer:close": { persona: "developer" },
          "qa:review": { persona: "quality" },
          [PASTED_KEY]: { persona: "quality" },
        };
      }),
    ).problems;
    expect(developer).toEqual([
      "developer.yaml: task_personas.developer:close: a close run starts no model (D-318), so it has no persona",
      "developer.yaml: task_personas.qa:review must be one of the role's allowed task types",
      "developer.yaml: task_personas: a key is not a task type id",
      "developer.yaml: task_personas.developer:infra is missing: every task type that runs a model has one",
    ]);
    const qa = check(
      withData("qa", (d) => {
        d.task_personas = {
          "qa:review": { persona: PASTED_KEY, extra: 1 },
          "qa:visual": { persona: "quality", with_craft_standards_of: "quality" },
        };
      }),
    ).problems;
    expect(qa).toEqual([
      "qa.yaml: task_personas.qa:review: unknown field extra",
      "qa.yaml: task_personas.qa:review.persona must be one of: product, developer, designer, quality",
      "qa.yaml: task_personas.qa:visual.with_craft_standards_of must be one of: product, developer, designer, quality, other than its persona",
    ]);
    const designer = check(
      withData("designer", (d) => {
        d.task_personas = { designer: "designer" };
      }),
    ).problems;
    expect(designer).toEqual([
      "designer.yaml: task_personas.designer must be a mapping of persona and, optionally, with_craft_standards_of",
    ]);
    const other = check(
      withData("designer", (d) => {
        d.task_personas = {
          designer: { persona: "designer", with_craft_standards_of: PASTED_KEY },
        };
      }),
    ).problems;
    expect(other).toEqual([
      "designer.yaml: task_personas.designer.with_craft_standards_of must be one of: product, developer, designer, quality, other than its persona",
    ]);
    for (const problems of [developer, qa, other]) {
      expect(problems.join("\n")).not.toContain("sk-ant");
    }
  });

  it("refuse a composed text over the 32,000 character limit, naming the file and the task type", () => {
    // Each file's own text fits the limit; the shared base and the persona take it over.
    const long = `Do the task.\n${"x".repeat(31_900)}\n`;
    expect(
      check(
        withData("triage", (d) => {
          d.instructions = long;
        }),
      ).problems,
    ).toEqual([
      "triage.yaml: the composed instructions of triage must be at most 32000 characters",
    ]);
    expect(
      check(
        withData("qa", (d) => {
          (d.task_instructions as Record<string, unknown>)["qa:visual"] = long;
        }),
      ).problems,
    ).toEqual([
      "qa.yaml: the composed instructions of qa:visual must be at most 32000 characters",
    ]);
    // The Council's text is not composed, so only the file's own limit applies to it.
    expect(
      check(
        withData("council", (d) => {
          d.instructions = long;
        }),
      ).problems,
    ).toEqual([]);
  });

  it("need a default task type that runs a model, whose text a close run carries", () => {
    expect(
      check(
        withData("developer", (d) => {
          d.task_types = {
            allowed: ["developer:code", "developer:infra", "developer:close"],
            default: "developer:review",
          };
        }),
      ).problems,
    ).toEqual([
      "developer.yaml: task_types.default must be an allowed task type that runs a model, whose instructions developer:close uses",
    ]);
  });

  it("version the Council by its file's hash, and a role with personas by its file and its composed texts", () => {
    const bots = readBotFiles();
    expect(bots.council.version).toBe(fileHash("council"));
    expect(bots.council.version).toBe(real().council.version);
    for (const role of PERSONA_ROLES) {
      expect(bots[role].version, role).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(bots[role].version, role).not.toBe(fileHash(role));
    }
    // A byte in a bot file is still a new version, for that role only.
    const dir = folder((d) =>
      writeFileSync(
        join(d, "qa.yaml"),
        `${readFileSync(join(d, "qa.yaml"), "utf8")}\n# changed\n`,
      ),
    );
    const changed = readBotFiles(dir);
    expect(changed.qa.version).not.toBe(bots.qa.version);
    for (const role of ["developer", "designer", "council", "triage"] as const) {
      expect(changed[role].version, role).toBe(bots[role].version);
    }
  });

  it("change the versions of exactly the roles whose composed text a persona change reaches", () => {
    const versions = (personas: Personas) => {
      const { bots, problems } = check(real(), personas);
      expect(problems).toEqual([]);
      return Object.fromEntries(BOT_ROLES.map((role) => [role, bots?.[role].version]));
    };
    const before = versions(PERSONAS_READ);
    const changedBy = (edit: (personas: Personas) => void) => {
      const personas = structuredClone(PERSONAS_READ);
      edit(personas);
      const after = versions(personas);
      return BOT_ROLES.filter((role) => after[role] !== before[role]);
    };
    expect(
      changedBy((p) => {
        p.personas.quality.lens = "You are Quality, reworded.";
      }),
    ).toEqual(["qa"]);
    expect(
      changedBy((p) => {
        p.personas.developer.craftStandards.push("A new standard.");
      }),
    ).toEqual(["developer", "designer"]);
    expect(
      changedBy((p) => {
        p.personas.designer.craftStandards[0] = "A reworded standard.";
      }),
    ).toEqual(["designer", "qa"]);
    // qa:visual holds the Designer's craft standards only, not what the Designer watches for.
    expect(
      changedBy((p) => {
        p.personas.designer.watchesFor.push("A new risk.");
      }),
    ).toEqual(["designer"]);
    expect(
      changedBy((p) => {
        p.personas.product.never.push("A new line.");
      }),
    ).toEqual(["triage"]);
    expect(
      changedBy((p) => {
        p.shared.intent.push("A new shared rule.");
      }),
    ).toEqual(["developer", "designer", "qa", "triage"]);
  });

  it("keep every version when a persona file changes only in its comments, and refuse bad persona files", () => {
    const bots = readBotFiles();
    const commented = readBotFiles(
      BOT_FILES_DIR,
      personasFolder((text) => `# A comment.\n${text}\n# Another comment.\n`),
    );
    for (const role of BOT_ROLES) {
      expect(commented[role].version, role).toBe(bots[role].version);
    }
    const empty = mkdtempSync(join(tmpdir(), "bot-files-personas-"));
    dirs.push(empty);
    expect(() => readBotFiles(BOT_FILES_DIR, empty)).toThrow(
      /^The persona files are invalid: shared\.yaml is missing/,
    );
  });
});
