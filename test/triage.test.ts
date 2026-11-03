// Seam: unit. The runner's checks of Triage's answer (D-262, D-264, D-241), the track rule and its
// decision point (P-11), and Triage's input (D-251), against Triage's real answer schema
// (contracts/bots/triage.yaml) and a synthetic repo map. The flows around them are in
// test/flows/triage-flows.test.ts.
import { describe, expect, it } from "vitest";

import { readBotFiles } from "../src/adapters/contracts-file/bot-files.ts";
import {
  checkTriageAnswer,
  pathTrack,
  trackDecisionPoint,
  trackInputHash,
  triageInput,
} from "../src/core/triage.ts";
import {
  answerWith,
  BAD_ANSWERS,
  goodAnswer,
  MAP_COMMIT,
  PLAN,
  REPO_MAP,
} from "./triage-fixture.ts";

const SCHEMA = readBotFiles().triage.outputSchemas?.answer ?? {};

const check = (answer: unknown) => checkTriageAnswer(SCHEMA, answer, REPO_MAP);
const code = (answer: unknown) => {
  const result = check(answer);
  return "rejection" in result ? result.rejection.code : "accepted";
};

describe("Triage's answer schema (contracts/bots/triage.yaml, D-262)", () => {
  it("is no longer a draft and asks for paths, checks, the gate and the hold flag", () => {
    const bot = readBotFiles().triage;
    const item = (
      SCHEMA.properties as Record<string, { items: { required: string[] } }>
    ).items.items;
    expect(item.required).toEqual(
      expect.arrayContaining(["pathsInScope", "checks", "gate", "hold"]),
    );
    expect(bot.instructions).toMatch(/repo map brief/);
    expect(bot.instructions).toMatch(/npm run <script>/);
  });
});

describe("the runner's checks of Triage's answer (unit, D-262, D-264, D-241)", () => {
  it("accepts the good answer for the synthetic plan", () => {
    expect(code(goodAnswer())).toBe("accepted");
  });

  it.each(BAD_ANSWERS)("rejects $name whole ($code)", ({ answer, code: expected }) => {
    expect(code(answer())).toBe(expected);
  });

  it("rejects an answer that does not fit the schema, naming the field and not its value", () => {
    const result = check(
      answerWith((a) => Object.assign(a.items[0] ?? {}, { track: "ops" })),
    );
    expect(result).toMatchObject({ rejection: { code: "schema" } });
    if ("rejection" in result) expect(result.rejection.reason).not.toMatch(/ops/);
    expect(code({ items: [] })).toBe("schema");
  });

  it("names the item and the value in a path or check reason", () => {
    const result = check(BAD_ANSWERS[0]?.answer());
    if (!("rejection" in result)) throw new Error("not rejected");
    expect(result.rejection.reason).toContain("settings-wire");
    expect(result.rejection.reason).toContain('"src/billing/invoice.ts"');
    expect(result.rejection.reason).toContain(MAP_COMMIT);
  });

  it("allows a new file only inside a folder that exists, and refuses paths outside the repository", () => {
    const withPath = (path: string) =>
      code(answerWith((a) => a.items[1]?.pathsInScope.push(path)));
    expect(withPath("src/settings/new.ts")).toBe("accepted");
    expect(withPath("src/new-folder/new.ts")).toBe("path_not_in_repo_map");
    expect(withPath("../outside.ts")).toBe("bad_path");
    expect(withPath("/etc/passwd")).toBe("bad_path");
  });

  it("checks blockedBy keys, the empty answer, duplicate keys and items with no paths", () => {
    expect(code(answerWith((a) => a.items[1]?.blockedBy.push("nope")))).toBe(
      "blocked_by_unknown_key",
    );
    expect(code(answerWith((a) => a.items[1]?.blockedBy.push("settings-wire")))).toBe(
      "blocked_by_itself",
    );
    expect(code({ items: [], note: "" })).toBe("no_items");
    expect(
      code(
        answerWith((a) => Object.assign(a.items[2] ?? {}, { key: "settings-wire" })),
      ),
    ).toBe("duplicate_key");
    expect(
      code(answerWith((a) => Object.assign(a.items[2] ?? {}, { pathsInScope: [] }))),
    ).toBe("no_paths");
  });

  it("lets a design item that only restyles go without a counterpart when the note names it", () => {
    const restyle = answerWith((a) => {
      const wire = a.items[1];
      if (wire) wire.blockedBy = [];
      a.note = "settings-design only restyles the existing buttons.";
    });
    expect(code(restyle)).toBe("accepted");
  });

  it("needs a gate on every needsDidi item and none on any other", () => {
    expect(
      code(answerWith((a) => Object.assign(a.items[3] ?? {}, { gate: "none" }))),
    ).toBe("needs_didi_without_gate");
    expect(
      code(answerWith((a) => Object.assign(a.items[1] ?? {}, { gate: "spend" }))),
    ).toBe("gate_without_needs_didi");
  });

  it("rejects an answer past its bounds", () => {
    const many = answerWith((a) => {
      const first = a.items[3];
      if (!first) throw new Error("no item 4");
      for (let i = 0; i < 50; i++) a.items.push({ ...first, key: `extra-${i}` });
    });
    expect(code(many)).toBe("bounds");
    expect(
      code(answerWith((a) => Object.assign(a.items[0] ?? {}, { title: "two\nlines" }))),
    ).toBe("bounds");
  });
});

describe("the track rule and its decision point (unit, D-264, P-11)", () => {
  it("says infra for infra/ and deploy configuration only, docs for docs/ and README only, else code", () => {
    expect(pathTrack(["infra/main.tf", "wrangler.jsonc"])).toBe("infra");
    expect(pathTrack(["docs/guide.md", "README.md", "src/README.md"])).toBe("docs");
    expect(pathTrack(["docs/guide.md", "infra/main.tf"])).toBe("code");
    expect(pathTrack(["src/app.ts"])).toBe("code");
    expect(pathTrack(["infrastructure/x.tf"])).toBe("code");
  });

  it("records Triage's track with the rule's view and a confidence", () => {
    expect(
      trackDecisionPoint.decide({ proposed: "docs", pathsInScope: ["docs/a.md"] }),
    ).toEqual({
      output: { track: "docs", pathTrack: "docs", agrees: true },
      confidence: 1,
    });
    expect(
      trackDecisionPoint.decide({ proposed: "design", pathsInScope: ["design"] }),
    ).toEqual({
      output: { track: "design", pathTrack: null, agrees: true },
      confidence: 0.5,
    });
    expect(
      trackDecisionPoint.decide({ proposed: "infra", pathsInScope: ["src/a.ts"] })
        .confidence,
    ).toBe(0);
  });

  it("hashes the item's words and paths, the same each time", () => {
    const item = { title: "T", description: "D", pathsInScope: ["src/a.ts"] };
    expect(trackInputHash(item)).toMatch(/^[0-9a-f]{64}$/);
    expect(trackInputHash(item)).toBe(trackInputHash({ ...item }));
    expect(trackInputHash({ ...item, title: "U" })).not.toBe(trackInputHash(item));
  });
});

describe("Triage's input (unit, D-251, D-262)", () => {
  const input = (extra: Partial<Parameters<typeof triageInput>[0]> = {}) =>
    triageInput({
      idea: { id: "idea-1", title: "Settings page" },
      plan: PLAN,
      map: REPO_MAP,
      lastRejection: null,
      councilNote: null,
      ...extra,
    });

  it("quotes the plan verbatim and frames the brief as data naming its commit", () => {
    const text = input();
    for (const line of PLAN.split("\n")) expect(text).toContain(`> ${line}`);
    expect(text).toContain(`at commit ${MAP_COMMIT}`);
    expect(text).toMatch(/not instructions/);
    expect(text).toContain("> - check: npm run lint && npm test");
    expect(text).not.toMatch(/Why your last answer/);
  });

  it("carries the last rejection's reason and the Council's note, quoted", () => {
    const text = input({
      lastRejection: "unknown_check: item x\n## Not a heading",
      councilNote: "Split the design item.",
    });
    expect(text).toContain("## Why your last answer was rejected");
    expect(text).toContain("> ## Not a heading");
    expect(text).toContain("> Split the design item.");
  });
});
