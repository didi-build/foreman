// Seam: unit. The visual comparison model test (D-242, D-249) on fake model adapters only: the
// synthetic set, the scoring, and the refusal to reach a real provider without the flag and the
// key. No network and no real key.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { compareRasters, crop } from "../../src/core/visual-diff.ts";
import {
  API_KEY_ENV,
  constantModel,
  openAiCompatibleModel,
  pixelOracleModel,
  requestFor,
  runModelTest,
  scriptedModel,
  selectModel,
} from "./harness.ts";
import { syntheticPairs } from "./pairs.ts";
import { main } from "./run.ts";

/** Shaped like a key so a leak would be found. Not a real key. */
const FAKE_KEY = "sk-not-a-real-key-0123456789abcdef";

describe("the synthetic set", () => {
  it("has 20 pairs, half identical, half with one planted difference of each kind", () => {
    const pairs = syntheticPairs();
    expect(pairs).toHaveLength(20);
    expect(pairs.filter((p) => p.planted === null)).toHaveLength(10);
    expect(new Set(pairs.map((p) => p.planted).filter(Boolean))).toEqual(
      new Set(["colour", "spacing", "copy", "missing_state", "font", "alignment"]),
    );
    // The same bytes every time.
    const digest = (list: typeof pairs) =>
      createHash("sha256")
        .update(list.map((p) => `${p.id}:${p.note}`).join())
        .update(Buffer.concat(list.flatMap((p) => [p.optionPage.data, p.built.data])))
        .digest("hex");
    expect(digest(syntheticPairs())).toBe(digest(pairs));
  });

  it("locates the planted difference and finds none in an identical pair", () => {
    for (const pair of syntheticPairs()) {
      const { summary } = compareRasters(
        crop(pair.optionPage, pair.region),
        pair.built,
      );
      if (pair.planted === null) expect(summary.changedPixels, pair.id).toBe(0);
      else expect(summary.changedPixels, pair.id).toBeGreaterThan(0);
    }
  });

  it("builds each request as the runner builds a run's task: two labelled images and the schema", () => {
    const request = requestFor(
      syntheticPairs()[1] as ReturnType<typeof syntheticPairs>[number],
    );
    expect(request.images.map((i) => i.label)).toEqual([
      "Image 1: the approved option, component status-button, variant Default",
      "Image 2: the built component at the head commit, component status-button, variant Default",
    ]);
    expect(request.input.startsWith("<run_input>")).toBe(true);
    expect(request.system).toContain("cannot_tell");
    expect(request.schema).toHaveProperty("properties.components");
  });
});

describe("the scoring", () => {
  it("scores a model that judges from the located difference as perfect", async () => {
    const record = await runModelTest(pixelOracleModel());
    expect(record).toMatchObject({
      pairs: 20,
      runsPerPair: 3,
      falsePassRate: 0,
      falseFailRate: 0,
      consistency: 1,
      cannotTellRate: 0,
      unusableRate: 0,
    });
  });

  it("gives a model that always says match a false-pass rate of 1", async () => {
    const record = await runModelTest(constantModel("match"));
    expect(record.falsePassRate).toBe(1);
    expect(record.falseFailRate).toBe(0);
  });

  it("counts cannot_tell, inconsistency, unusable answers and failed calls", async () => {
    const one = syntheticPairs().slice(0, 2);
    const answer = (result: string) => ({
      components: [
        {
          component: "status-button",
          variant: "Default",
          result,
          findings: result === "match" ? [] : [{ what: "x", specLine: "" }],
        },
      ],
    });
    const record = await runModelTest(
      scriptedModel([
        answer("match"),
        answer("cannot_tell"),
        { components: [] },
        answer("differs"),
        new Error("down"),
        answer("differs"),
      ]),
      { pairs: one },
    );
    expect(record.results.map((r) => r.answers)).toEqual([
      ["match", "cannot_tell", "unusable"],
      ["differs", "call_failed", "differs"],
    ]);
    expect(record.consistency).toBe(0);
    expect(record.cannotTellRate).toBe(0.167);
    expect(record.unusableRate).toBe(0.333);
    expect(record.falsePassRate).toBe(0);
  });
});

describe("the real provider guard", () => {
  it("uses the fake unless --real is given, and refuses --model without --real", () => {
    expect(selectModel([], { [API_KEY_ENV]: FAKE_KEY })).toMatchObject({ real: false });
    expect(selectModel(["--model", "m"], { [API_KEY_ENV]: FAKE_KEY })).toMatchObject({
      exitCode: 3,
    });
  });

  it("refuses --real without the key or a model, naming the setting and never a value", () => {
    expect(selectModel(["--real", "--model", "m"], {})).toEqual({
      refused: `--real needs ${API_KEY_ENV} in the environment`,
      exitCode: 2,
    });
    expect(selectModel(["--real"], { [API_KEY_ENV]: FAKE_KEY })).toEqual({
      refused: "--real needs --model <id>",
      exitCode: 2,
    });
    expect(
      selectModel(["--real", "--api", "openai", "--model", "m"], {
        [API_KEY_ENV]: FAKE_KEY,
      }),
    ).toMatchObject({ exitCode: 2 });
  });

  it("builds a real adapter only with both, and never prints the key", async () => {
    const choice = selectModel(["--real", "--model", "claude-test-model"], {
      [API_KEY_ENV]: FAKE_KEY,
    });
    expect(choice).toMatchObject({ real: true });
    if (!("model" in choice)) throw new Error("refused");
    expect(choice.model.name).toBe("anthropic:claude-test-model");
    expect(JSON.stringify(choice.model)).not.toContain(FAKE_KEY);
    const lines: string[] = [];
    expect(
      await main(["--real"], { [API_KEY_ENV]: FAKE_KEY }, (l) => lines.push(l)),
    ).toBe(2);
    expect(lines.join("\n")).not.toContain(FAKE_KEY);
  });

  it("names only the status when an OpenAI-compatible call fails, never the key", async () => {
    const model = openAiCompatibleModel({
      apiKey: FAKE_KEY,
      model: "m",
      baseUrl: "http://127.0.0.1:9",
      fetchImpl: async () => new Response(`bad key ${FAKE_KEY}`, { status: 401 }),
    });
    const request = requestFor(
      syntheticPairs()[0] as ReturnType<typeof syntheticPairs>[number],
    );
    await expect(model.answer(request)).rejects.toThrow(
      "the model call failed with status 401",
    );
    await model.answer(request).catch((error: Error) => {
      expect(error.message).not.toContain(FAKE_KEY);
    });
  });

  it("prints one redacted record for the fake run", async () => {
    const lines: string[] = [];
    expect(await main([], {}, (l) => lines.push(l))).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({
      real: false,
      falsePassRate: 0,
    });
  });
});
