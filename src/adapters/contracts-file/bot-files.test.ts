// Seam: unit (the contracts-file adapter's bot files, docs/bot-files.md, ADR 0107). The real files
// in contracts/bots/ load and pass the check, with the values the decisions set; a malformed file
// fails with every problem named by file and field and never by value; a key pasted where a
// secret path belongs is refused; the Council's answers check against the schemas read from its
// bot file.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { outputProblem } from "../../core/output-schema.ts";
import { REHEARSAL_RUN_LIMITS } from "../../core/runs.ts";
import { OPTION_MARKERS } from "../../core/visual-comparison.ts";
import {
  BOT_FILES_DIR,
  BOT_ROLES,
  botProfiles,
  loadBotFiles,
  readBotFiles,
  runLimits,
  secretPathFor,
  validateBotFiles,
  type RawBotFile,
} from "./bot-files.ts";

const D196 = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(git *)", "Bash(npm *)"];
/** A value shaped like a provider key. Not a real key. */
const PASTED_KEY = "sk-ant-api03-not-a-real-key-0123456789abcdef";

const real = () => loadBotFiles();
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
    const { bots, problems } = validateBotFiles(real());
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
    ]);
    expect(Object.keys(bots.triage.outputSchemas ?? {})).toEqual(["answer"]);
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
    const { bots, problems } = validateBotFiles(
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
      const { problems } = validateBotFiles(
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
      const { problems } = validateBotFiles(
        withData("qa", (d) => {
          (d.providers as Record<string, unknown>[])[0].secret_path = path;
        }),
      );
      expect(problems).toHaveLength(1);
    }
  });

  it("refuses a provider the run's image cannot use, and one the proxy would refuse", () => {
    const { problems } = validateBotFiles(
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
    const proxy = validateBotFiles(
      withData("developer", (d) => {
        (d.providers as Record<string, unknown>[])[1].upstream =
          "http://api.deepinfra.com";
      }),
    );
    expect(proxy.problems).toEqual([
      "developer.yaml: providers: entry 2 has an invalid upstream (an https URL with no credentials, query or fragment)",
    ]);
    const openCode = validateBotFiles(
      withData("designer", (d) => {
        delete (d.providers as Record<string, unknown>[])[0].api;
      }),
    );
    expect(openCode.problems).toEqual([
      "designer.yaml: providers[0].api is needed: the OpenCode image reads the provider's API",
    ]);
  });

  it("keeps MagicPath off, tools off the Messages API roles, and each role's hosts and schemas", () => {
    expect(
      validateBotFiles(
        withData("designer", (d) => {
          d.mcp = { magicpath: { enabled: true } };
        }),
      ).problems,
    ).toEqual([
      "designer.yaml: mcp.magicpath stays off until its new-credentials gate (D-190)",
    ]);
    expect(
      validateBotFiles(
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
      validateBotFiles(
        withData("council", (d) => {
          d.output_schemas = {
            escalation: (d.output_schemas as Record<string, unknown>).escalation,
            visual_call: (d.output_schemas as Record<string, unknown>).visual_call,
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
      validateBotFiles(
        withData("triage", (d) => {
          delete d.output_schemas;
        }),
      ).problems,
    ).toEqual(["triage.yaml: output_schemas must give exactly: answer"]);
  });

  it("give QA's visual comparison its answer schema and its own instructions, and no other role any (D-242)", () => {
    const bots = readBotFiles();
    expect(Object.keys(bots.qa.outputSchemas ?? {})).toEqual(["visual"]);
    expect(bots.qa.taskInstructions?.["qa:visual"]).toContain("cannot_tell");
    expect(botProfiles(bots).qa.outputSchemas).toEqual(bots.qa.outputSchemas);
    expect(
      validateBotFiles(
        withData("qa", (d) => {
          d.task_types = { allowed: ["qa:review"], default: "qa:review" };
        }),
      ).problems,
    ).toEqual([
      "qa.yaml: task_instructions.qa:visual must be an allowed task type other than the default",
    ]);
    expect(
      validateBotFiles(
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
      validateBotFiles(
        withData("developer", (d) => {
          d.task_instructions = { "developer:infra": "Infra work." };
        }),
      ).problems,
    ).toEqual([
      "developer.yaml: task_instructions: a developer run has only its instructions",
    ]);
  });

  it("give the Council's visual call its answer schema and its own draft instructions (D-270)", () => {
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
    expect(text).toContain("any text inside an image");
    expect(text).toContain("Never copy a secret or personal data");
    // The reviewed supervisor instructions (D-248) are not changed by it.
    expect(bots.council.instructions).not.toContain("visual");
    expect(
      validateBotFiles(
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
