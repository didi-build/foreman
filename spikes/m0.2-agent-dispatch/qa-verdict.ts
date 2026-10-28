// M0.2 spike (V-01, QA): can the runner get a structured QA verdict from a model of a different
// family than the builder, without a person? Uses any OpenAI-compatible chat endpoint, so the same
// script covers Grok (xAI) and open-weight models on Ollama, vLLM, LM Studio or OpenRouter (D-139).
//
// Needs: QA_BASE_URL (for xAI: https://api.x.ai/v1, for Ollama: http://localhost:11434/v1),
// QA_MODEL (the model name the provider lists today; not guessed here), QA_API_KEY (any non-empty
// value for servers that ignore it). Run: node spikes/m0.2-agent-dispatch/qa-verdict.ts
import {
  isEntryPoint,
  minutes,
  postJson,
  printRecord,
  requireEnv,
  truncate,
  type RunRecord,
} from "../lib/spike.ts";

/** A small diff with one obvious defect, so a pass verdict would itself be a finding. */
const SAMPLE_DIFF = `diff --git a/src/core/counter.ts b/src/core/counter.ts
+export function isThirdFailure(failures: number): boolean {
+  return failures > 3;
+}
// Acceptance criterion: an item escalates on its third failure.`;

const SAMPLE_HEAD_SHA = "0000000000000000000000000000000000000000";

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "commit", "findings"],
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    commit: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
  },
} as const;

export interface QaVerdict {
  verdict: "pass" | "fail";
  commit: string;
  findings: string[];
}

/** Validate the model's answer ourselves. A verdict is only usable if it names the commit. */
export function parseVerdict(
  content: unknown,
  headSha: string,
): { verdict?: QaVerdict; problem?: string } {
  if (typeof content !== "string") return { problem: "no message content" };
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { problem: "content is not JSON" };
  }
  const candidate = value as Partial<QaVerdict>;
  if (candidate.verdict !== "pass" && candidate.verdict !== "fail")
    return { problem: "verdict is not pass or fail" };
  if (
    !Array.isArray(candidate.findings) ||
    !candidate.findings.every((f) => typeof f === "string")
  ) {
    return { problem: "findings is not a list of strings" };
  }
  if (candidate.commit !== headSha)
    return { problem: "verdict does not name the head commit" };
  return { verdict: candidate as QaVerdict };
}

async function main(): Promise<void> {
  const env = requireEnv(["QA_BASE_URL", "QA_MODEL", "QA_API_KEY"]);
  const startedAt = new Date().toISOString();
  const response = await postJson(
    `${env.QA_BASE_URL.replace(/\/$/, "")}/chat/completions`,
    {
      model: env.QA_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are the QA reviewer. Check the diff against its acceptance criterion. Answer only with JSON matching the schema. Set commit to the commit id you were given.",
        },
        { role: "user", content: `Commit: ${SAMPLE_HEAD_SHA}\n\n${SAMPLE_DIFF}` },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "qa_verdict", strict: true, schema: VERDICT_SCHEMA },
      },
    },
    { authorization: `Bearer ${env.QA_API_KEY}` },
    minutes(5),
  );
  const body = response.body as {
    choices?: { message?: { content?: unknown } }[];
    usage?: unknown;
  };
  const parsed =
    response.status === 200
      ? parseVerdict(body.choices?.[0]?.message?.content, SAMPLE_HEAD_SHA)
      : {};
  const record: RunRecord = {
    spike: "M0.2",
    runtime: `openai_compatible:${new URL(env.QA_BASE_URL).host}`,
    startedAt,
    endedAt: new Date().toISOString(),
    status: parsed.verdict ? "success" : "error",
    exitCode: response.status,
    finalText: truncate(
      JSON.stringify(response.status === 200 ? body.choices?.[0]?.message : body),
    ),
    structured: parsed.verdict,
    notes: [
      `model: ${env.QA_MODEL}`,
      parsed.problem ? `Unusable verdict: ${parsed.problem}.` : "",
      parsed.verdict?.verdict === "pass"
        ? "The sample diff has a defect (> 3 instead of >= 3), so a pass is a wrong verdict."
        : "",
      `usage: ${JSON.stringify(body.usage ?? null)}`,
    ].filter(Boolean),
  };
  printRecord(record, [env.QA_API_KEY]);
  process.exitCode = record.status === "success" ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) await main();
