// QA's verdict (ADR 0107, ADR 0112): pass or fail, findings by file path and line range, and the
// ids of the runner's evidence it relied on. The shape is the state API's `POST /qa-verdicts`
// body (src/api/routes.ts). The image checks it before posting, and the API and the runner check
// it again: a pass must cite at least one evidence id the runner supplied, and nothing else.

export interface Finding {
  path: string;
  startLine: number;
  endLine: number;
  note: string;
}

export interface QaVerdict {
  verdict: "pass" | "fail";
  findings: Finding[];
  evidenceIds: string[];
}

/** The structured-output schema the model's final answer must follow. */
export const VERDICT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings", "evidenceIds"],
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "startLine", "endLine", "note"],
        properties: {
          path: { type: "string" },
          startLine: { type: "integer" },
          endLine: { type: "integer" },
          note: { type: "string" },
        },
      },
    },
    evidenceIds: { type: "array", items: { type: "string" } },
  },
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The verdict from the model's final text, or the reason it is unusable. */
export function parseVerdict(
  text: string,
  suppliedEvidenceIds: readonly string[],
): { verdict: QaVerdict } | { problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: "the verdict is not JSON" };
  }
  if (!isObject(value)) return { problem: "the verdict is not an object" };
  const { verdict, findings, evidenceIds } = value;
  if (verdict !== "pass" && verdict !== "fail") {
    return { problem: "verdict is not pass or fail" };
  }
  if (!Array.isArray(findings) || findings.length > 200) {
    return { problem: "findings is not a list of at most 200 items" };
  }
  for (const f of findings) {
    if (
      !isObject(f) ||
      typeof f.path !== "string" ||
      f.path === "" ||
      f.path.length > 500 ||
      typeof f.note !== "string" ||
      f.note.trim() === "" ||
      f.note.length > 2000 ||
      !Number.isInteger(f.startLine) ||
      !Number.isInteger(f.endLine) ||
      (f.startLine as number) < 1 ||
      (f.endLine as number) < (f.startLine as number)
    ) {
      return { problem: "a finding needs a path, a note and a line range from line 1" };
    }
  }
  if (
    !Array.isArray(evidenceIds) ||
    !evidenceIds.every((id) => typeof id === "string")
  ) {
    return { problem: "evidenceIds is not a list" };
  }
  if (evidenceIds.some((id) => !suppliedEvidenceIds.includes(id))) {
    return { problem: "the verdict cites evidence the runner did not supply" };
  }
  if (verdict === "pass" && evidenceIds.length === 0) {
    return { problem: "a pass must cite the runner's evidence" };
  }
  return {
    verdict: {
      verdict,
      findings: findings.map((f) => ({
        path: f.path as string,
        startLine: f.startLine as number,
        endLine: f.endLine as number,
        note: f.note as string,
      })),
      evidenceIds: [...new Set(evidenceIds as string[])],
    },
  };
}

/**
 * Posts the verdict through the state API with the run's token (ADR 0112). The API takes the
 * commit from the run's dispatch record; the head commit is sent too, so a mismatch is refused.
 */
export async function postVerdict(options: {
  stateApiUrl: string;
  token: string;
  nodeId: string;
  headSha: string;
  verdict: QaVerdict;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; evidenceId: string } | { ok: false; status: number | null }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${options.stateApiUrl}/qa-verdicts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        nodeId: options.nodeId,
        commitSha: options.headSha,
        ...options.verdict,
      }),
    });
  } catch {
    return { ok: false, status: null };
  }
  if (response.status !== 201) return { ok: false, status: response.status };
  const body = (await response.json().catch(() => null)) as {
    evidenceId?: unknown;
  } | null;
  if (typeof body?.evidenceId !== "string")
    return { ok: false, status: response.status };
  return { ok: true, evidenceId: body.evidenceId };
}
