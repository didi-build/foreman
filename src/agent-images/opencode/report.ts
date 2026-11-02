// The run's report, read from the model's final message (N-44, D-235, O-61). The bot file's
// instructions ask the Developer and the Designer to end their final message with exactly one
// fenced block whose info string is `foreman-report`, holding one JSON object:
//
//   ```foreman-report
//   {"pullRequestTitle": "Add the login form", "docsNote": {"impact": "none"}}
//   ```
//
// `docsNote` is the state API's `docs_note` payload (docs/guards.md): `{"impact": "none"}`,
// optionally with a `note`, or `{"impact": "updated", "note": "<what changed in the docs>"}`.
// The check is strict: no block, two blocks, text that is not that object, an unknown field, or
// a field of the wrong shape is a problem the run fails on. Nothing is guessed or filled in.
// The rest of the final message, without the block, becomes the PR's description.

export interface DocsNote {
  impact: "updated" | "none";
  note?: string;
}

export interface RunReport {
  pullRequestTitle: string;
  docsNote: DocsNote;
  /** The final message without the block, trimmed. */
  summary: string;
}

export const REPORT_INFO_STRING = "foreman-report";
const MAX_TITLE = 200;
const MAX_NOTE = 2000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

/** A block opens on a line of three backticks and the info string, and closes on a line of three backticks. Either may be indented. */
const OPENING = /^[ \t]*```foreman-report[ \t]*$/;
const CLOSING = /^[ \t]*```[ \t]*$/;

/** The report in the final message, or the reason it is unusable. */
export function parseRunReport(
  finalText: string,
): { report: RunReport } | { problem: string } {
  const lines = finalText.split(/\r?\n/);
  const openings = lines.flatMap((line, i) => (OPENING.test(line) ? [i] : []));
  if (openings.length === 0) return { problem: "there is no foreman-report block" };
  if (openings.length > 1)
    return { problem: "there is more than one foreman-report block" };
  const start = openings[0] as number;
  const end = lines.findIndex((line, i) => i > start && CLOSING.test(line));
  if (end === -1) return { problem: "the foreman-report block is not closed" };

  let value: unknown;
  try {
    value = JSON.parse(lines.slice(start + 1, end).join("\n"));
  } catch {
    return { problem: "the foreman-report block is not JSON" };
  }
  if (!isObject(value) || !onlyKeys(value, ["pullRequestTitle", "docsNote"])) {
    return {
      problem:
        "the foreman-report block must be an object with pullRequestTitle and docsNote only",
    };
  }
  const title = value.pullRequestTitle;
  if (
    typeof title !== "string" ||
    title.trim() === "" ||
    title.length > MAX_TITLE ||
    /[\r\n]/.test(title)
  ) {
    return {
      problem: `pullRequestTitle must be one line of 1 to ${MAX_TITLE} characters`,
    };
  }
  const note = value.docsNote;
  if (!isObject(note) || !onlyKeys(note, ["impact", "note"])) {
    return {
      problem: "docsNote must be an object with impact and an optional note only",
    };
  }
  if (note.impact !== "updated" && note.impact !== "none") {
    return { problem: "docsNote.impact must be updated or none" };
  }
  if (
    note.note !== undefined &&
    (typeof note.note !== "string" ||
      note.note.trim() === "" ||
      note.note.length > MAX_NOTE)
  ) {
    return { problem: `docsNote.note must be text of 1 to ${MAX_NOTE} characters` };
  }
  if (note.impact === "updated" && note.note === undefined) {
    return { problem: "docsNote.note must say what changed when impact is updated" };
  }
  const summary = [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n").trim();
  return {
    report: {
      pullRequestTitle: title.trim(),
      docsNote: {
        impact: note.impact,
        ...(typeof note.note === "string" ? { note: note.note } : {}),
      },
      summary,
    },
  };
}

/**
 * Posts the docs note through the state API with the run's token (ADR 0102, `POST /reports`).
 * The API records it with no commit, by the run's role, for the run's own node only. Its `ref`
 * is the PR's link, the evidence the In development state names.
 */
export async function postDocsNote(options: {
  stateApiUrl: string;
  token: string;
  nodeId: string;
  pullRequestUrl: string;
  docsNote: DocsNote;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true } | { ok: false; status: number | null }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${options.stateApiUrl}/reports`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        nodeId: options.nodeId,
        kind: "docs_note",
        ref: options.pullRequestUrl,
        payload: options.docsNote,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, status: null };
  }
  // The body is not needed: the evidence id is a database id and is not passed on.
  await response.body?.cancel().catch(() => {});
  return response.status === 201
    ? { ok: true }
    : { ok: false, status: response.status };
}
