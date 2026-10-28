// M0.2 spike (V-04): can the runner start a Cursor cloud agent against a GitHub repo and read its
// result without a person? Cursor has no role yet; this only records whether it could have one.
// UNVERIFIED: the request body follows the v0 API as described in secondary sources. v1 is in public
// beta (https://cursor.com/docs/cloud-agent/api/endpoints). Check both before trusting a "no".
//
// Needs: CURSOR_API_KEY and SCRATCH_REPO_URL (https URL of a throwaway GitHub repo, never a real
// project). Cursor bills cloud agents at API prices. Run: node spikes/m0.2-agent-dispatch/cursor.ts
import {
  isEntryPoint,
  getJson,
  minutes,
  postJson,
  printRecord,
  requireEnv,
  truncate,
  type RunRecord,
} from "../lib/spike.ts";

const API = "https://api.cursor.com/v0/agents";
const TASK =
  'Create a file named SPIKE_CURSOR.md in the repository root containing exactly the line "hello from the cursor spike". Change nothing else.';
const TERMINAL = new Set(["FINISHED", "ERROR", "EXPIRED", "CANCELLED"]);
const POLL_EVERY_MS = 15_000;
const GIVE_UP_AFTER_MS = minutes(20);

export function cursorStatus(body: unknown): string {
  return typeof body === "object" && body !== null && "status" in body
    ? String(body.status)
    : "UNKNOWN";
}

async function main(): Promise<void> {
  const env = requireEnv(["CURSOR_API_KEY", "SCRATCH_REPO_URL"]);
  const auth = {
    authorization: `Basic ${Buffer.from(`${env.CURSOR_API_KEY}:`).toString("base64")}`,
  };
  const startedAt = new Date().toISOString();
  const notes: string[] = [];

  const created = await postJson(
    API,
    { prompt: { text: TASK }, source: { repository: env.SCRATCH_REPO_URL } },
    auth,
    minutes(1),
  );
  const agentId =
    typeof created.body === "object" && created.body !== null && "id" in created.body
      ? String(created.body.id)
      : undefined;
  if (created.status >= 300 || !agentId) {
    notes.push(
      `Create failed with HTTP ${created.status}. Check the request body against the current API docs.`,
    );
    finish({
      status: "error",
      exitCode: created.status,
      finalText: truncate(JSON.stringify(created.body)),
    });
    return;
  }

  // The runner, not the agent, decides when to stop waiting. Forum reports describe runs that never finish.
  const deadline = Date.now() + GIVE_UP_AFTER_MS;
  let last = created;
  while (Date.now() < deadline && !TERMINAL.has(cursorStatus(last.body))) {
    await new Promise((resolve) => setTimeout(resolve, POLL_EVERY_MS));
    last = await getJson(`${API}/${agentId}`, auth, minutes(1));
  }
  const status = cursorStatus(last.body);
  notes.push(
    `Last status: ${status}. Check the scratch repo for the branch or PR the agent opened.`,
  );
  finish({
    status: !TERMINAL.has(status)
      ? "timeout"
      : status === "FINISHED"
        ? "success"
        : "error",
    exitCode: last.status,
    finalText: truncate(JSON.stringify(last.body)),
  });

  function finish(result: Pick<RunRecord, "status" | "exitCode" | "finalText">): void {
    const record: RunRecord = {
      spike: "M0.2",
      runtime: "cursor_cloud_agent_v0",
      startedAt,
      endedAt: new Date().toISOString(),
      ...result,
      notes,
    };
    printRecord(record, [env.CURSOR_API_KEY]);
    process.exitCode = record.status === "success" ? 0 : 1;
  }
}

if (isEntryPoint(import.meta.url)) await main();
