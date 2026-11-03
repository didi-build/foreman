// The model test for the visual comparison (D-242, D-249, docs/costs.md section 7). It sends each
// synthetic pair (./pairs.ts) through the same input builder the runner uses
// (src/core/visual-comparison.ts: `locatedPair`, `visualTaskInput`), with QA's real `qa:visual`
// instructions and answer schema from contracts/bots/qa.yaml and the Messages API image's fixed
// frame, to a model adapter, three times, and scores the answers with the runner's own check
// (`readVisualAnswer`): false-pass rate, false-fail rate, consistency over the runs, the
// cannot_tell rate and unusable answers.
//
// The adapters: fakes for tests and a dry run, and two real ones (Anthropic's Messages API, and
// an OpenAI-compatible chat endpoint such as DeepInfra's). A real adapter is built only with the
// explicit `--real` flag and an API key in `VISUAL_TEST_API_KEY` (`selectModel`); without both it
// refuses. The key is never printed: the record is redacted, and errors name a status only.
// Running it for real is Didi's credential gate.
import Anthropic from "@anthropic-ai/sdk";

import { pngCodec } from "../../src/adapters/screenshots/png.ts";
import { readBotFiles } from "../../src/adapters/contracts-file/bot-files.ts";
import { firstMessage } from "../../src/agent-images/claude-api/loop.ts";
import { fencedInput, systemText } from "../../src/agent-images/claude-api/prompts.ts";
import type { OutputSchema } from "../../src/core/output-schema.ts";
import { outputProblem } from "../../src/core/output-schema.ts";
import {
  locatedPair,
  readVisualAnswer,
  specSection,
  VISUAL_SCHEMA,
  VISUAL_TASK_TYPE,
  visualTaskInput,
  type ComponentResult,
} from "../../src/core/visual-comparison.ts";
import { syntheticPairs, type SyntheticPair } from "./pairs.ts";

export interface TaskImageData {
  label: string;
  mediaType: "image/png";
  data: string;
}

/** What one model call gets: the same pieces a `qa:visual` run's task file holds. */
export interface VisualModelRequest {
  system: string;
  input: string;
  images: TaskImageData[];
  schema: OutputSchema;
}

export interface VisualModel {
  /** For the record: the adapter and the model id. Never a key. */
  name: string;
  /** The model's answer as parsed JSON. Throws on a failed call. */
  answer(request: VisualModelRequest): Promise<unknown>;
}

const COMPONENT = "status-button";
const VARIANT = "Default";
const NODE = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Synthetic status button",
};
const HEAD = "0".repeat(40);
const OPTION = { name: "a", commitSha: "1".repeat(40) };

/** QA's instructions and answer schema for `qa:visual`, from the real bot file. */
export function visualBotParts(): { instructions: string; schema: OutputSchema } {
  const qa = readBotFiles().qa;
  const instructions = qa.taskInstructions?.[VISUAL_TASK_TYPE];
  const schema = qa.outputSchemas?.[VISUAL_SCHEMA];
  if (!instructions || !schema) throw new Error("qa.yaml has no qa:visual parts");
  return { instructions, schema };
}

/** The request for one synthetic pair, built exactly as the runner builds a run's task. */
export function requestFor(pair: SyntheticPair): VisualModelRequest {
  const { instructions, schema } = visualBotParts();
  const visual = locatedPair(
    COMPONENT,
    VARIANT,
    pair.optionPage,
    pair.region,
    pair.built,
    specSection(pair.spec, COMPONENT),
  );
  const { input, images } = visualTaskInput(
    NODE,
    { ready: true, headSha: HEAD, option: OPTION, pairs: [visual] },
    pngCodec,
  );
  return {
    system: systemText("qa", instructions, true),
    input: fencedInput(input),
    images: images.map((i) => ({
      label: i.label,
      mediaType: "image/png",
      data: Buffer.from(i.png).toString("base64"),
    })),
    schema,
  };
}

export type RunAnswer = ComponentResult | "unusable" | "call_failed";

export interface PairScore {
  id: string;
  planted: SyntheticPair["planted"];
  note: string;
  answers: RunAnswer[];
  consistent: boolean;
}

export interface ModelTestRecord {
  model: string;
  pairs: number;
  runsPerPair: number;
  /** Planted runs answered `match`, over all planted runs. The first rank. */
  falsePassRate: number;
  /** Identical runs answered `differs`, over all identical runs. The second rank. */
  falseFailRate: number;
  /** Pairs whose runs all gave the same answer. The third rank. */
  consistency: number;
  cannotTellRate: number;
  /** Answers the runner would refuse, and calls that failed, over all runs. */
  unusableRate: number;
  results: PairScore[];
}

const rate = (count: number, of: number): number =>
  of === 0 ? 0 : Math.round((count / of) * 1000) / 1000;

/** Sends every pair `runs` times and scores the answers with the runner's own check. */
export async function runModelTest(
  model: VisualModel,
  options: { runs?: number; pairs?: SyntheticPair[] } = {},
): Promise<ModelTestRecord> {
  const runs = options.runs ?? 3;
  const pairs = options.pairs ?? syntheticPairs();
  const results: PairScore[] = [];
  for (const pair of pairs) {
    const request = requestFor(pair);
    const answers: RunAnswer[] = [];
    for (let n = 0; n < runs; n++) {
      let raw: unknown;
      try {
        raw = await model.answer(request);
      } catch {
        answers.push("call_failed");
        continue;
      }
      if (outputProblem(request.schema, raw)) {
        answers.push("unusable");
        continue;
      }
      const read = readVisualAnswer(raw, [{ component: COMPONENT, variant: VARIANT }]);
      answers.push(
        "answer" in read
          ? (read.answer.components[0]?.result ?? "unusable")
          : "unusable",
      );
    }
    results.push({
      id: pair.id,
      planted: pair.planted,
      note: pair.note,
      answers,
      consistent: answers.every((a) => a === answers[0]),
    });
  }
  const all = results.flatMap((r) => r.answers);
  const planted = results.filter((r) => r.planted !== null).flatMap((r) => r.answers);
  const identical = results.filter((r) => r.planted === null).flatMap((r) => r.answers);
  return {
    model: model.name,
    pairs: results.length,
    runsPerPair: runs,
    falsePassRate: rate(planted.filter((a) => a === "match").length, planted.length),
    falseFailRate: rate(
      identical.filter((a) => a === "differs").length,
      identical.length,
    ),
    consistency: rate(results.filter((r) => r.consistent).length, results.length),
    cannotTellRate: rate(all.filter((a) => a === "cannot_tell").length, all.length),
    unusableRate: rate(
      all.filter((a) => a === "unusable" || a === "call_failed").length,
      all.length,
    ),
    results,
  };
}

// ---- Fake adapters ------------------------------------------------------------------------------

const oneAnswer = (result: ComponentResult) => ({
  components: [
    {
      component: COMPONENT,
      variant: VARIANT,
      result,
      findings: result === "match" ? [] : [{ what: "A fake finding.", specLine: "" }],
    },
  ],
});

/** Answers from the runner's pixel summary alone: `match` exactly when no pixel changed. */
export function pixelOracleModel(): VisualModel {
  return {
    name: "fake:pixel-oracle",
    answer: async (request) =>
      oneAnswer(
        request.input.includes("found no changed pixels") ? "match" : "differs",
      ),
  };
}

/** Always answers the same: a model that never looks. */
export function constantModel(result: ComponentResult): VisualModel {
  return { name: `fake:always-${result}`, answer: async () => oneAnswer(result) };
}

/** Answers from a fixed list in turn, for tests of consistency and unusable answers. */
export function scriptedModel(answers: unknown[]): VisualModel {
  let i = 0;
  return {
    name: "fake:scripted",
    answer: async () => {
      const next = answers[i % answers.length];
      i += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

// ---- Real adapters, behind the flag and the key -------------------------------------------------

export const API_KEY_ENV = "VISUAL_TEST_API_KEY";
export const BASE_URL_ENV = "VISUAL_TEST_BASE_URL";

/** Anthropic's Messages API, with the same multi-image first message as the image's loop. */
export function anthropicModel(options: {
  apiKey: string;
  model: string;
  baseUrl?: string;
}): VisualModel {
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: 0,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
  });
  return {
    name: `anthropic:${options.model}`,
    async answer(request) {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model: options.model,
          max_tokens: 4000,
          system: request.system,
          messages: [{ role: "user", content: firstMessage(request) }],
          output_config: { format: { type: "json_schema", schema: request.schema } },
        });
      } catch (error) {
        const status = error instanceof Anthropic.APIError ? error.status : undefined;
        throw new Error(
          `the model call failed${status ? ` with status ${status}` : ""}`,
        );
      }
      const text = message.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("");
      return JSON.parse(text) as unknown;
    },
  };
}

/** An OpenAI-compatible chat endpoint (DeepInfra's, docs/costs.md section 7), images as data URLs. */
export function openAiCompatibleModel(options: {
  apiKey: string;
  model: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): VisualModel {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    name: `openai-compatible:${options.model}`,
    async answer(request) {
      const response = await fetchImpl(
        `${options.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            max_tokens: 4000,
            messages: [
              { role: "system", content: request.system },
              {
                role: "user",
                content: [
                  { type: "text", text: request.input },
                  ...request.images.flatMap((i) => [
                    { type: "text", text: i.label },
                    {
                      type: "image_url",
                      image_url: { url: `data:${i.mediaType};base64,${i.data}` },
                    },
                  ]),
                ],
              },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: "visual", strict: true, schema: request.schema },
            },
          }),
        },
      );
      if (!response.ok)
        throw new Error(`the model call failed with status ${response.status}`);
      const body = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return JSON.parse(body.choices?.[0]?.message?.content ?? "") as unknown;
    },
  };
}

export type ModelChoice =
  | { model: VisualModel; real: boolean; secrets: string[] }
  | { refused: string; exitCode: 2 | 3 };

/**
 * The adapter the command line asks for. Without `--real` it is the pixel-oracle fake. With
 * `--real` it needs `--model <id>` and the key in `VISUAL_TEST_API_KEY`, and for `--api openai`
 * the endpoint in `VISUAL_TEST_BASE_URL`; anything missing refuses, naming the setting, never a
 * value.
 */
export function selectModel(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): ModelChoice {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (!argv.includes("--real")) {
    if (argv.includes("--model") || argv.includes("--api")) {
      return { refused: "--model and --api need --real", exitCode: 3 };
    }
    return { model: pixelOracleModel(), real: false, secrets: [] };
  }
  const model = flag("--model");
  if (!model || model.startsWith("--"))
    return { refused: "--real needs --model <id>", exitCode: 2 };
  const apiKey = env[API_KEY_ENV];
  if (!apiKey)
    return { refused: `--real needs ${API_KEY_ENV} in the environment`, exitCode: 2 };
  const api = flag("--api") ?? "anthropic";
  const baseUrl = env[BASE_URL_ENV];
  if (api === "openai") {
    if (!baseUrl) return { refused: `--api openai needs ${BASE_URL_ENV}`, exitCode: 2 };
    return {
      model: openAiCompatibleModel({ apiKey, model, baseUrl }),
      real: true,
      secrets: [apiKey],
    };
  }
  if (api !== "anthropic")
    return { refused: "--api must be anthropic or openai", exitCode: 2 };
  return {
    model: anthropicModel({ apiKey, model, ...(baseUrl ? { baseUrl } : {}) }),
    real: true,
    secrets: [apiKey],
  };
}
