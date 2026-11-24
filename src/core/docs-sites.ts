// The trusted documentation sites and the requests to add one (ADR 0119 slice 4c, D-460, D-473 to
// D-475). One global list, the setting `trusted_docs_hosts` (D-474, migration 0033), holds the
// hosts every documentation lookup may read: a JSON array of canonical host names, each once.
// `readTrustedDocsHosts` is its one reading rule, for the task source (flows/lib/tasks.ts) and
// for the add below.
//
// A run whose bot file declares the lookup may end with `siteRequests` in its result
// (./site-requests.ts): at most 3 hosts it wants on the list, each with a one-line reason. The
// run-end flow calls `submit` for such a run beside the ideas from its findings
// (./finding-ideas.ts), before it records the run's end. The runner, not the agent, opens one
// approve-once request per host for Didi (D-473): kind `new_credentials` in the run's project,
// owner `didi`, not blocking, on no item (so `no_pending_gate` never reads it), on the topic
// `docs-site:<host>`, with the payload `{question, host, reason, foundBy: {role, nodeId, runId}}`.
// The question is fixed text; the reason is the run's own words, as the check bounds them (one
// line, at most 300 characters), kept as data. A host is skipped when it is on the list, when a
// request on its topic is open in any project, when the latest answered request on its topic
// was anything but Didi's Approve (D-475: never asked again), when that Approve's add is still
// due, and when the same run names it twice. At most 10 site requests are open at once across
// projects; past that a new one is dropped and counted. An expired request was never answered,
// so its host may be asked again later. A repeated run end finds the requests marked with its
// run and opens none.
//
// Didi's answer is recorded by the approval resume step as on any request. Then `afterAnswer`
// adds the one host on Didi's active Approve, and nothing on a Reject or a request for changes.
// The add is done once: one transaction reads the kill switch and dry run (either writes
// nothing), locks the list's row, checks that the request is the latest answered one on its
// topic, and writes the list with the existing setting write only when the host is missing and
// the list has not held it since the approval. So a repeated or concurrent answer adds nothing
// twice, and a host Didi later takes off the list by hand stays off. The reconcile flow's pass
// takes each Approve whose add is still due (`pending`, then `add`), once both switches are off.
//
// Every write here happens under the list's row lock, so two run ends, or a run end and an
// answer, take turns: the open count and the asked-once rule hold across projects. Plain logic
// over an injected store, clock and id source (D-162).
import { switchesHolding } from "./finding-ideas.ts";
import type { Clock, IdSource } from "./library.ts";
import { checkSiteRequests, isCanonicalHost, SITE_REQUESTS } from "./site-requests.ts";
import type {
  AgentRole,
  CurrentDecision,
  GateKind,
  GateRequest,
  Json,
  Run,
  SettingChange,
  Store,
  StoreOps,
} from "./store.ts";

/** The setting that holds the one trusted documentation list (D-474). */
export const TRUSTED_DOCS_HOSTS = "trusted_docs_hosts";
/** The most hosts the list may hold: as many as a run's spec and task file take. */
export const MAX_TRUSTED_DOCS_HOSTS = 50;
/** The most site requests open at once, across every project. */
export const MAX_OPEN_DOCS_SITE_REQUESTS = 10;
/** The topic of a site request: one per host. */
export const DOCS_SITE_PREFIX = "docs-site:";
export const docsSiteTopic = (host: string): string => `${DOCS_SITE_PREFIX}${host}`;
/** The approve-once kind "new secrets, credentials or wider permissions" (D-473). */
export const DOCS_SITE_KIND: GateKind = "new_credentials";
/** Who the settings log names for the runner's add. */
export const DOCS_SITE_WRITER = "runner";

/** The role as people say it, for the question. */
const ROLE_NAMES: Readonly<Record<AgentRole, string>> = {
  developer: "Developer",
  designer: "Designer",
  qa: "QA",
  triage: "Triage",
  council: "Council",
};

const isAgentRole = (bot: string): bot is AgentRole => Object.hasOwn(ROLE_NAMES, bot);

/** The fixed question on a site request. */
export const docsSiteQuestion = (role: AgentRole, host: string): string =>
  `A ${ROLE_NAMES[role]} run asks to add ${host} to the trusted documentation sites. Approve adds this one host for every run's lookup. Reject keeps it off, and it is not asked again.`;

/** The host a site request's topic names, or undefined for any other topic. */
export function docsSiteHost(topicKey: string): string | undefined {
  if (!topicKey.startsWith(DOCS_SITE_PREFIX)) return undefined;
  const host = topicKey.slice(DOCS_SITE_PREFIX.length);
  return isCanonicalHost(host) ? host : undefined;
}

/**
 * The hosts on the trusted list, or undefined when the value is not a list of at most
 * MAX_TRUSTED_DOCS_HOSTS canonical host names (the task file's rule), each once. A missing
 * setting, or null, is an empty list.
 */
export function readTrustedDocsHosts(value: Json | undefined): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_TRUSTED_DOCS_HOSTS) return undefined;
  if (!value.every(isCanonicalHost)) return undefined;
  if (new Set(value).size !== value.length) return undefined;
  return [...value];
}

export interface DocsSitesOptions {
  store: Store;
  clock: Clock;
  ids: IdSource;
}

/**
 * What `submit` did with a run's site requests. Counts only, never an id. `skipped` counts the
 * hosts already listed, already asked, not asked again or approved and waiting for their add;
 * `dropped` the ones past the open request limit.
 */
export type DocsSiteRequests =
  /** The result names no site requests, or the run's role is not an agent role. */
  | { step: "none" }
  | { step: "submitted"; opened: number; skipped: number; dropped: number }
  | { step: "already_submitted"; requests: number }
  | {
      step: "refused";
      reason: "bad_requests" | "no_list" | "bad_list" | "kill_switch" | "dry_run";
    };

/** What Didi's answer on one site request did to the list. */
export type DocsSiteAdd =
  | { step: "not_docs_site" }
  | {
      host: string;
      step:
        | "added"
        | "already_listed"
        | "already_added"
        | "not_approved"
        | "waiting"
        | "no_request"
        | "no_list"
        | "bad_list"
        | "list_full"
        | "kill_switch"
        | "dry_run";
    };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const field = (value: Json | undefined, key: string): Json | undefined =>
  isObject(value) ? (value as Record<string, Json>)[key] : undefined;

/** Whether the request was opened from this run's result. */
const fromRun = (request: GateRequest, runId: string): boolean =>
  field(field(request.payload, "foundBy"), "runId") === runId;

const isDidiApproval = (
  decision: CurrentDecision | null | undefined,
): decision is CurrentDecision =>
  decision?.kind === "approval" &&
  decision.byActor === "didi" &&
  decision.status === "active";

/** The newest answered request among these, by when it was answered, with its answer. */
async function latestAnswer(
  ops: Pick<StoreOps, "getDecision">,
  requests: readonly GateRequest[],
): Promise<{ request: GateRequest; decision: CurrentDecision | null } | undefined> {
  const answered = requests
    .filter((g) => g.status === "answered" && g.decisionId !== null)
    .sort(
      (a, b) =>
        (b.answeredAt?.getTime() ?? 0) - (a.answeredAt?.getTime() ?? 0) ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
  const [request] = answered;
  if (!request?.decisionId) return undefined;
  return { request, decision: await ops.getDecision(request.decisionId) };
}

/**
 * Whether the list has held the host in a change made at or after `since`: an approval's add is
 * done once, so a host Didi takes off by hand later is never added back for it.
 */
const heldSince = (
  changes: readonly SettingChange[],
  host: string,
  since: Date,
): boolean =>
  changes.some(
    (change) =>
      change.changedAt.getTime() >= since.getTime() &&
      Array.isArray(change.newValue) &&
      change.newValue.includes(host),
  );

/**
 * Whether the host may be asked about now, given every request on its topic: none is open, and
 * the latest answered one (if any) is Didi's Approve whose add is done, so the list held it and
 * Didi took it off later. A latest answer of anything else is never asked again (D-475), and an
 * Approve whose add is due waits for it.
 */
async function askable(
  ops: Pick<StoreOps, "getDecision">,
  requests: readonly GateRequest[],
  host: string,
  changes: readonly SettingChange[],
): Promise<boolean> {
  if (requests.some((g) => g.status === "open")) return false;
  const latest = await latestAnswer(ops, requests);
  if (!latest) return true;
  if (!isDidiApproval(latest.decision)) return false;
  return heldSince(changes, host, latest.decision.recordedAt);
}

export function createDocsSites({ store, clock, ids }: DocsSitesOptions) {
  /** Adds the host of one answered site request, once (see the module comment). */
  function add(gate: GateRequest): Promise<DocsSiteAdd> {
    const host = docsSiteHost(gate.topicKey);
    if (host === undefined) return Promise.resolve({ step: "not_docs_site" });
    return store.transaction(async (tx): Promise<DocsSiteAdd> => {
      const switches = await switchesHolding(tx);
      if (switches) return { host, step: switches };
      // The list's row first, so every writer of the list and of site requests takes turns.
      const listExists = await tx.lockSetting(TRUSTED_DOCS_HOSTS);
      // Read again: the request passed in may be the one read before the answer was recorded.
      const request = await tx.getGateRequest(gate.id);
      if (
        !request ||
        request.topicKey !== gate.topicKey ||
        request.kind !== DOCS_SITE_KIND ||
        request.owner !== "didi"
      ) {
        return { host, step: "no_request" };
      }
      if (request.status === "open") return { host, step: "waiting" };
      const latest = await latestAnswer(
        tx,
        await tx.listGateRequestsByTopic(request.topicKey),
      );
      // Only Didi's active Approve on the latest answer adds: a later Reject keeps the host off.
      if (latest?.request.id !== request.id || !isDidiApproval(latest.decision)) {
        return { host, step: "not_approved" };
      }
      if (!listExists) return { host, step: "no_list" };
      const trusted = readTrustedDocsHosts(
        (await tx.getSetting(TRUSTED_DOCS_HOSTS))?.value,
      );
      if (!trusted) return { host, step: "bad_list" };
      if (trusted.includes(host)) return { host, step: "already_listed" };
      const changes = await tx.listSettingChanges(TRUSTED_DOCS_HOSTS);
      if (heldSince(changes, host, latest.decision.recordedAt)) {
        return { host, step: "already_added" };
      }
      if (trusted.length >= MAX_TRUSTED_DOCS_HOSTS) return { host, step: "list_full" };
      await tx.setSetting({
        key: TRUSTED_DOCS_HOSTS,
        value: [...trusted, host].sort(),
        updatedBy: DOCS_SITE_WRITER,
        updatedAt: clock.now(),
      });
      return { host, step: "added" };
    });
  }

  return {
    /**
     * Opens one site request per host the run's result `structured` asks for, once per run. Call
     * it only for a successful run whose bot file declares the documentation lookup (the run-end
     * flow checks the bot file).
     */
    async submit(run: Run, structured: unknown): Promise<DocsSiteRequests> {
      const listed = isObject(structured) ? structured[SITE_REQUESTS] : undefined;
      if (listed === undefined) return { step: "none" };
      const role = run.bot;
      if (!isAgentRole(role)) return { step: "none" };
      const read = checkSiteRequests(listed);
      if ("problem" in read) return { step: "refused", reason: "bad_requests" };
      if (read.siteRequests.length === 0) return { step: "none" };
      return store.transaction(async (tx): Promise<DocsSiteRequests> => {
        const switches = await switchesHolding(tx);
        if (switches) return { step: "refused", reason: switches };
        // The list's row first: without the list nothing could be added, and nothing is locked.
        if (!(await tx.lockSetting(TRUSTED_DOCS_HOSTS))) {
          return { step: "refused", reason: "no_list" };
        }
        const trusted = readTrustedDocsHosts(
          (await tx.getSetting(TRUSTED_DOCS_HOSTS))?.value,
        );
        if (!trusted) return { step: "refused", reason: "bad_list" };
        const byHost = new Map<string, GateRequest[]>();
        for (const { host } of read.siteRequests) {
          if (!byHost.has(host)) {
            byHost.set(host, await tx.listGateRequestsByTopic(docsSiteTopic(host)));
          }
        }
        const earlier = [...byHost.values()].flat().filter((g) => fromRun(g, run.id));
        if (earlier.length > 0) {
          return { step: "already_submitted", requests: earlier.length };
        }
        const changes = await tx.listSettingChanges(TRUSTED_DOCS_HOSTS);
        let open = (
          await tx.listGateRequestsByTopic(DOCS_SITE_PREFIX, { prefix: true })
        ).filter((g) => g.status === "open").length;
        const at = clock.now();
        const seen = new Set<string>();
        let opened = 0;
        let skipped = 0;
        let dropped = 0;
        for (const { host, reason } of read.siteRequests) {
          const repeated = seen.has(host);
          seen.add(host);
          if (
            repeated ||
            trusted.includes(host) ||
            !(await askable(tx, byHost.get(host) ?? [], host, changes))
          ) {
            skipped += 1;
            continue;
          }
          if (open >= MAX_OPEN_DOCS_SITE_REQUESTS) {
            dropped += 1;
            continue;
          }
          await tx.insertGateRequest({
            id: ids.next(),
            projectId: run.projectId,
            // On no item, so it never holds one up (`no_pending_gate`).
            nodeId: null,
            topicKey: docsSiteTopic(host),
            kind: DOCS_SITE_KIND,
            owner: "didi",
            blocking: false,
            payload: {
              question: docsSiteQuestion(role, host),
              host,
              reason,
              foundBy: { role, nodeId: run.nodeId, runId: run.id },
            },
            approvalUrl: null,
            status: "open",
            decisionId: null,
            supersededBy: null,
            createdAt: at,
            answeredAt: null,
            lastNotifiedAt: null,
          });
          open += 1;
          opened += 1;
        }
        return { step: "submitted", opened, skipped, dropped };
      });
    },

    /** After Didi's answer on a site request: the one host's add on an Approve. */
    afterAnswer: (gate: GateRequest): Promise<DocsSiteAdd> => add(gate),

    /**
     * The site requests whose latest answer is Didi's active Approve and whose add is still due:
     * the ones the reconcile pass hands to `add`, which checks it all again under the lock.
     */
    async pending(): Promise<GateRequest[]> {
      const requests = await store.listGateRequestsByTopic(DOCS_SITE_PREFIX, {
        prefix: true,
      });
      const trusted =
        readTrustedDocsHosts((await store.getSetting(TRUSTED_DOCS_HOSTS))?.value) ?? [];
      const changes = await store.listSettingChanges(TRUSTED_DOCS_HOSTS);
      const byTopic = new Map<string, GateRequest[]>();
      for (const request of requests) {
        byTopic.set(request.topicKey, [
          ...(byTopic.get(request.topicKey) ?? []),
          request,
        ]);
      }
      const due: GateRequest[] = [];
      for (const [topic, onTopic] of byTopic) {
        const host = docsSiteHost(topic);
        if (host === undefined || trusted.includes(host)) continue;
        const latest = await latestAnswer(store, onTopic);
        if (!latest || !isDidiApproval(latest.decision)) continue;
        if (heldSince(changes, host, latest.decision.recordedAt)) continue;
        due.push(latest.request);
      }
      return due;
    },

    /** Adds the host of one answered site request, once: the reconcile pass's step. */
    add,
  };
}

export type DocsSites = ReturnType<typeof createDocsSites>;
