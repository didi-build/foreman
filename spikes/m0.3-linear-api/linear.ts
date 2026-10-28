// M0.3 spike (V-02): can Linear's API create and rename statuses, and can an app create issues and
// comments under its own identity? Schema: github.com/linear/linear packages/sdk/src/schema.graphql
//
// Needs: LINEAR_TOKEN (an OAuth token from an app installed with actor=app, scope read,write) and
// LINEAR_TEST_TEAM_KEY (the key of a TEST team) and LINEAR_EXPECTED_WORKSPACE (the url key of the
// workspace the token must belong to). Never the real Didi Build team or workspace.
// Run: node spikes/m0.3-linear-api/linear.ts
import {
  isEntryPoint,
  minutes,
  postJson,
  printRecord,
  requireEnv,
  truncate,
  type RunRecord,
} from "../lib/spike.ts";

const ENDPOINT = "https://api.linear.app/graphql";
/** Keys of real teams this spike must never touch. */
const REAL_TEAM_KEYS = new Set(["DIDI"]);

export function isRealTeam(teamKey: string): boolean {
  return REAL_TEAM_KEYS.has(teamKey.trim().toUpperCase());
}

export interface CapabilityResult {
  capability: string;
  ok: boolean;
  detail: string;
}

/** True when an issue or comment was written by the app, not by a person. */
export function writtenByApp(
  node: { botActor?: unknown; creator?: unknown; user?: unknown } | undefined,
): boolean {
  if (!node) return false;
  const person = "creator" in node ? node.creator : node.user;
  return (
    node.botActor !== null &&
    node.botActor !== undefined &&
    (person === null || person === undefined)
  );
}

async function main(): Promise<void> {
  const env = requireEnv([
    "LINEAR_TOKEN",
    "LINEAR_TEST_TEAM_KEY",
    "LINEAR_EXPECTED_WORKSPACE",
  ]);
  if (isRealTeam(env.LINEAR_TEST_TEAM_KEY)) {
    console.error(
      `Refusing to run against team ${env.LINEAR_TEST_TEAM_KEY}. Use a test team.`,
    );
    process.exit(3);
  }
  const startedAt = new Date().toISOString();
  const results: CapabilityResult[] = [];

  async function gql(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const response = await postJson(
      ENDPOINT,
      { query, variables },
      { authorization: `Bearer ${env.LINEAR_TOKEN}` },
      minutes(1),
    );
    return (response.body ?? {}) as Record<string, unknown>;
  }
  const errorsOf = (body: Record<string, unknown>): string =>
    truncate(JSON.stringify(body.errors ?? null), 600);
  const dataOf = <T>(body: Record<string, unknown>, path: string[]): T | undefined =>
    path.reduce<unknown>(
      (value, key) => (value as Record<string, unknown> | undefined)?.[key],
      body.data,
    ) as T | undefined;

  // The token must belong to the workspace named for the spike, so a token for the real workspace
  // cannot be used by mistake.
  const viewer = await gql(`query { organization { urlKey } }`);
  const workspace = dataOf<string>(viewer, ["organization", "urlKey"]);
  if (workspace !== env.LINEAR_EXPECTED_WORKSPACE) {
    console.error(
      "Refusing to run: the token's workspace is not LINEAR_EXPECTED_WORKSPACE.",
    );
    process.exit(3);
  }

  const teams = await gql(`query { teams { nodes { id key } } }`);
  const team = dataOf<{ id: string; key: string }[]>(teams, ["teams", "nodes"])?.find(
    (t) => t.key === env.LINEAR_TEST_TEAM_KEY,
  );
  if (!team) {
    results.push({
      capability: "find test team",
      ok: false,
      detail: `Team key not visible to this token. ${errorsOf(teams)}`,
    });
    return finish();
  }

  const suffix = startedAt.replace(/[^0-9]/g, "").slice(0, 12);
  const created = await gql(
    `mutation($t:String!,$n:String!){ workflowStateCreate(input:{teamId:$t,name:$n,type:"started",color:"#f2c94c"}){ success workflowState{ id name } } }`,
    { t: team.id, n: `PF spike ${suffix}` },
  );
  const stateId = dataOf<string>(created, [
    "workflowStateCreate",
    "workflowState",
    "id",
  ]);
  results.push({
    capability: "create a status as the app",
    ok: Boolean(stateId),
    detail: stateId
      ? "created"
      : `failed (expected if the app lacks the admin scope). ${errorsOf(created)}`,
  });

  if (stateId) {
    const renamed = await gql(
      `mutation($id:String!,$n:String!){ workflowStateUpdate(id:$id,input:{name:$n}){ success workflowState{ name } } }`,
      { id: stateId, n: `PF spike renamed ${suffix}` },
    );
    const ok = dataOf<boolean>(renamed, ["workflowStateUpdate", "success"]) === true;
    results.push({
      capability: "rename a status",
      ok,
      detail: ok ? "renamed" : errorsOf(renamed),
    });
  }

  const issue = await gql(
    `mutation($t:String!,$s:String){ issueCreate(input:{teamId:$t,title:"PF spike issue",description:"Created by the M0.3 spike.",stateId:$s}){ success issue{ id identifier creator{ id } botActor{ name type } } } }`,
    { t: team.id, s: stateId ?? null },
  );
  const issueNode = dataOf<{
    id: string;
    identifier: string;
    creator?: unknown;
    botActor?: unknown;
  }>(issue, ["issueCreate", "issue"]);
  results.push({
    capability: "create an issue as the app",
    ok: writtenByApp(issueNode),
    detail: issueNode
      ? `${issueNode.identifier}: botActor ${JSON.stringify(issueNode.botActor)}, creator ${JSON.stringify(issueNode.creator ?? null)}`
      : errorsOf(issue),
  });

  if (issueNode) {
    const comment = await gql(
      `mutation($i:String!){ commentCreate(input:{issueId:$i,body:"Comment from the M0.3 spike."}){ success comment{ id user{ id } botActor{ name type } } } }`,
      { i: issueNode.id },
    );
    const commentNode = dataOf<{ user?: unknown; botActor?: unknown }>(comment, [
      "commentCreate",
      "comment",
    ]);
    results.push({
      capability: "comment as the app",
      ok: writtenByApp(commentNode),
      detail: commentNode
        ? `botActor ${JSON.stringify(commentNode.botActor)}, user ${JSON.stringify(commentNode.user ?? null)}`
        : errorsOf(comment),
    });
  }
  finish();

  function finish(): void {
    const record: RunRecord = {
      spike: "M0.3",
      runtime: "linear_graphql",
      startedAt,
      endedAt: new Date().toISOString(),
      status: results.length > 0 && results.every((r) => r.ok) ? "success" : "error",
      exitCode: null,
      finalText: `${results.filter((r) => r.ok).length} of ${results.length} capabilities worked`,
      structured: results,
      notes: [
        "Clean up by hand in the test team: archive the spike issue, then the spike status.",
      ],
    };
    printRecord(record, [env.LINEAR_TOKEN]);
    process.exitCode = record.status === "success" ? 0 : 1;
  }
}

if (isEntryPoint(import.meta.url)) await main();
