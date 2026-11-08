// Seam: unit, plain functions with no store. The daily check's page (D-319, D-320, O-100,
// src/core/daily-check-render.ts): every recorded value escaped as HTML text, links only to an
// `https:` staging address and to the Windmill pages the caller names as relative paths, the same
// sections and order as the plain text, an empty check, and the switches note. The check is built
// by hand with synthetic data; the generator is tested in test/daily-check.test.ts.
import { describe, expect, it } from "vitest";

import {
  DAILY_CHECK_DATA_NOTICE,
  NO_SCAN_YET,
  PRODUCTION_DEPLOY_NOT_BUILT,
  SPEND_THRESHOLDS_NOT_BUILT,
  type DailyCheck,
  type ProjectCheck,
} from "../src/core/daily-check.ts";
import {
  escapeHtml,
  renderDailyCheck,
  renderDailyCheckHtml,
  stagingHref,
} from "../src/core/daily-check-render.ts";
import { SCAN_CHECKS, type ScanCheckId } from "../src/core/scan.ts";

const FLOW = "f/foreman/hold_release_request";
const PAGE = "/scripts/get/f/foreman/hold_release_request";
const PAGES = { flowPages: { [FLOW]: PAGE } };
const NOW = new Date("2026-11-04T11:00:00Z");
const AGO = new Date("2026-11-04T09:00:00Z");
const ID = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROJECT_ID = ID(900);
const RUN_ID = ID(901);
const GATE_ID = ID(902);

const SCRIPT = "<script>alert(1)</script>";
const IMG = '"><img src=x onerror=alert(1)>';

const noFindings = (): Record<ScanCheckId, number> =>
  Object.fromEntries(SCAN_CHECKS.map((c) => [c, 0])) as Record<ScanCheckId, number>;

function project(slug: string, extra: Partial<ProjectCheck> = {}): ProjectCheck {
  return {
    projectId: PROJECT_ID,
    slug,
    name: slug,
    waitingItems: 0,
    moved: [],
    plannedInDryRun: [],
    blocked: [],
    staging: { url: null, onStaging: [], passedInWindow: [] },
    questions: [],
    heldItems: [],
    spend: {
      runsEnded: 0,
      costUsd: 0,
      unpricedRuns: 0,
      tokens: { input: 0, output: 0 },
      runsActive: 0,
    },
    scan: {
      lastScanAt: null,
      outcome: null,
      commitSha: null,
      failure: null,
      findingsByCheck: noFindings(),
      findings: 0,
      newIdeas: [],
      merged: 0,
      overCap: 0,
      cap: null,
      foldedInto: [],
      withdrawn: [],
      notWithdrawn: [],
      askedCouncil: [],
      note: NO_SCAN_YET,
    },
    stalled: { items: [], runs: [] },
    councilAccepted: [],
    cancels: [],
    ...extra,
  };
}

function check(projects: ProjectCheck[], extra: Partial<DailyCheck> = {}): DailyCheck {
  return {
    generatedAt: NOW,
    window: { from: new Date(NOW.getTime() - 24 * 3_600_000), to: NOW, hours: 24 },
    switches: { killSwitch: false, dryRun: false },
    dataNotice: DAILY_CHECK_DATA_NOTICE,
    projects,
    quietProjects: [],
    productionDeployApproval: { items: [], note: PRODUCTION_DEPLOY_NOT_BUILT },
    spendNote: SPEND_THRESHOLDS_NOT_BUILT,
    stalledAfterMinutes: 120,
    stalledNote: null,
    projectSetup: null,
    ...extra,
  };
}

const item = (n: number, title: string) => ({
  nodeId: ID(n),
  title,
  state: "blocked",
  stateLabel: "Blocked",
});

const held = (n: number, title: string, flow = FLOW) => ({
  nodeId: ID(n),
  projectId: PROJECT_ID,
  title,
  state: "ready_for_dev",
  heldSince: AGO,
  heldForMinutes: 120,
  reworkOf: null,
  lastNote: { text: IMG, outcome: "rejected", answeredAt: AGO },
  freshRequest: { flow, input: { nodeId: ID(n) } },
});

/** A project with an entry in every section, every recorded value hostile. */
const hostile = (stagingUrl: string | null): ProjectCheck =>
  project("rehearsal", {
    name: SCRIPT,
    waitingItems: 2,
    moved: [
      {
        ...item(1, SCRIPT),
        fromState: "ready_for_dev",
        fromLabel: "Ready for dev",
        toState: "in_development",
        toLabel: "In development",
        at: AGO,
        actorKind: "bot",
        reason: IMG,
      },
    ],
    plannedInDryRun: [
      {
        ...item(2, IMG),
        fromState: "ready_for_dev",
        fromLabel: "Ready for dev",
        toState: "in_development",
        toLabel: "In development",
        at: AGO,
        actorKind: "runner",
        reason: null,
      },
    ],
    blocked: [
      {
        ...item(3, SCRIPT),
        blockedSince: AGO,
        reason: IMG,
        waitingOn: [item(1, IMG)],
        holdsUp: 1,
      },
    ],
    staging: {
      url: stagingUrl,
      onStaging: [{ ...item(4, SCRIPT), since: AGO }],
      passedInWindow: [{ ...item(5, IMG), since: AGO }],
    },
    questions: [
      {
        gateRequestId: GATE_ID,
        nodeId: ID(3),
        title: SCRIPT,
        kind: "escalation",
        blocking: true,
        waitingSince: AGO,
        waitingForMinutes: 120,
        question: IMG,
      },
    ],
    councilAccepted: [
      {
        nodeId: ID(6),
        title: SCRIPT,
        acceptedAt: AGO,
        planFirstLine: IMG,
        reason: SCRIPT,
      },
    ],
    heldItems: [held(7, SCRIPT)],
    stalled: {
      items: [
        {
          nodeId: ID(8),
          projectId: PROJECT_ID,
          title: IMG,
          state: "ready_for_dev",
          stateLabel: "Ready for dev",
          role: "developer",
          readySince: AGO,
          stalledForMinutes: 120,
          waits: [{ code: "guard_failed", guard: "plan_attached", detail: SCRIPT }],
        },
      ],
      runs: [
        {
          runId: RUN_ID,
          projectId: PROJECT_ID,
          nodeId: ID(9),
          bot: "developer",
          lastActivityAt: AGO,
          budgetMinutes: 60,
          idleMinutes: 120,
          title: SCRIPT,
        },
      ],
    },
    scan: {
      ...project("x").scan,
      lastScanAt: AGO,
      outcome: "scanned",
      commitSha: "a".repeat(40),
      findings: 1,
      findingsByCheck: { ...noFindings(), doc_link_missing: 1 },
      newIdeas: [
        { nodeId: ID(10), title: SCRIPT, check: "doc_link_missing", class: "drift" },
      ],
      cap: 5,
      note: null,
    },
    cancels: [
      {
        nodeId: ID(11),
        title: IMG,
        stateLabel: "Cancelled",
        how: "didi",
        note: SCRIPT,
        finished: false,
        ideaRejected: null,
        items: [{ ...item(11, IMG), pullRequest: 12, close: null }],
      },
    ],
  });

/** Every tag in the page: only the renderer's own, with only style, href and rel. */
const tags = (html: string): string[] => html.match(/<[^>]*>/g) ?? [];
const ALLOWED_TAG =
  /^<\/?(div|section|h2|h3|h4|p|ul|li|a)((?: (?:style|href|rel)="[^"<>]*")*)>$/;

/** The page's words, one per block, as a reader sees them. */
function words(html: string): string[] {
  return html
    .replace(/<\/(h2|h3|h4|p|li)>/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .split("\n")
    .filter((l) => l !== "");
}

/** The text's lines as the page shows them: no list dash, no heading marks, no colon after a label. */
const textBlocks = (text: string): string[] =>
  text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.replace(/^- /, "").replace(/^== (.*) ==$/, "$1"));

describe("the daily check's page (unit: D-319, D-320, O-100)", () => {
  it("escapes every recorded value as HTML text, so a hostile title stays inert", () => {
    const html = renderDailyCheckHtml(
      check([hostile(`https://staging.example.test/${IMG}`)]),
      PAGES,
    );
    // Every `<` on the page opens one of the renderer's own tags, with no attribute but style,
    // href and rel: the payloads are text.
    for (const tag of tags(html)) expect(tag).toMatch(ALLOWED_TAG);
    expect(html).not.toMatch(/<script|<img|<form|<iframe|<style|<link/i);
    expect(html).toContain(escapeHtml(JSON.stringify(SCRIPT)));
    expect(html).toContain("&quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;");
    expect(html).toContain(escapeHtml(JSON.stringify(IMG)));
    // The staging address with markup in its path: still a link, its markup percent-encoded in
    // the address and escaped in the text.
    const anchors = tags(html).filter((t) => t.startsWith("<a "));
    expect(anchors).toEqual([
      `<a href="https://staging.example.test/%22%3E%3Cimg%20src=x%20onerror=alert(1)%3E" rel="noreferrer">`,
      `<a href="${PAGE}">`,
    ]);
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;",
    );
  });

  it("links a staging address only when it is an https address with no user name or password", () => {
    const linked = (url: string) =>
      renderDailyCheckHtml(
        check([project("p", { staging: { url, onStaging: [], passedInWindow: [] } })]),
        PAGES,
      );
    expect(linked("https://p.staging.example.test")).toContain(
      `<p style="margin:0.25em 0"><a href="https://p.staging.example.test/" rel="noreferrer">https://p.staging.example.test</a></p>`,
    );
    for (const url of [
      "http://p.staging.example.test",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      // A user name and password in the address (built here so no scanner reads it as one).
      `https://${["name", "word"].join(":")}@p.staging.example.test`,
      `https://name@p.staging.example.test`,
      "//p.staging.example.test",
      "/relative/path",
      "p.staging.example.test",
      "",
    ]) {
      const html = linked(url);
      expect(stagingHref(url)).toBeNull();
      expect(tags(html).filter((t) => t.startsWith("<a "))).toEqual([]);
      expect(words(html)).toContain(url === "" ? "Staging" : url);
    }
  });

  it("links a held item only to the Windmill page the caller names, as a relative path", () => {
    const page = (flowPages: Record<string, string>, flow = FLOW) =>
      renderDailyCheckHtml(
        check([project("p", { heldItems: [held(1, "Remove the old page", flow)] })]),
        {
          flowPages,
        },
      );
    const html = page({ [FLOW]: PAGE });
    // The flow's path and the item's input stay beside the link, so it reads without a click.
    expect(html).toContain(
      `start <a href="${PAGE}">${FLOW}</a> with {&quot;nodeId&quot;:&quot;${ID(1)}&quot;}`,
    );
    // A flow the caller did not name, or a page that is not plainly relative, is text only.
    for (const [flowPages, flow] of [
      [{ [FLOW]: PAGE }, "f/foreman/other"],
      [{}, FLOW],
      [{ [FLOW]: "https://windmill.example.test/scripts/get/x" }, FLOW],
      [{ [FLOW]: "//windmill.example.test/x" }, FLOW],
      [{ [FLOW]: "/scripts/../../x" }, FLOW],
      [{ [FLOW]: "/scripts/get/x?token=abc" }, FLOW],
      [{ [FLOW]: "javascript:alert(1)" }, FLOW],
      [{ [FLOW]: '/x" onclick="alert(1)' }, FLOW],
    ] as const) {
      const text = page(flowPages, flow);
      expect(tags(text).filter((t) => t.startsWith("<a "))).toEqual([]);
      expect(text).toContain(`start ${flow} with`);
    }
  });

  it("says what the text says, in the same sections and order, and shows no other id", () => {
    const c = check(
      [
        hostile("https://staging.example.test"),
        project("second", { waitingItems: 0, moved: [] }),
      ],
      {
        quietProjects: ["quiet"],
        stalledNote:
          "reconcile_interval_minutes is missing or invalid: no stalled items list",
      },
    );
    const html = renderDailyCheckHtml(c, PAGES);
    const text = renderDailyCheck(c);
    const shown = words(html);
    // Each text line is one block on the page, or a label and its line ("Staging: ...").
    const expected = textBlocks(text).flatMap((l) => {
      const labelled = /^(Staging|Spend|Scan): (.*)$/.exec(l);
      if (labelled) return [labelled[1] ?? "", labelled[2] ?? ""];
      return [l.replace(/^(.*\(\d+\)):$/, "$1")];
    });
    expect(shown).toEqual(expected);
    expect(
      [...html.matchAll(/<h4[^>]*>([^<]*)<\/h4>/g)].map((m) => m[1]).slice(0, 11),
    ).toEqual([
      "Moved (1)",
      "Planned in dry run, nothing moved (1)",
      "Blocked (1)",
      "Staging",
      "Questions waiting for Didi (1)",
      "Accepted by the Council (1)",
      "Held with no open release request (1)",
      "Spend",
      "Stalled (2)",
      "Scan",
      "Stopped (1)",
    ]);
    expect(
      [...html.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((m) => m[1]?.split(" ")[0]),
    ).toEqual(["rehearsal", "second"]);
    // Only item ids and the gate request id, as the text: no run or project id.
    const ids = (s: string) => new Set(s.match(/[0-9a-f]{8}-[0-9a-f-]{27}/g));
    expect(ids(html)).toEqual(ids(text));
    expect(html).not.toContain(RUN_ID);
    expect(html).not.toContain(PROJECT_ID);
    expect(html).toContain(GATE_ID);
  });

  it("shows an empty check and an empty project plainly", () => {
    const empty = renderDailyCheckHtml(check([], { quietProjects: ["quiet"] }), PAGES);
    expect(words(empty)).toEqual([
      "Daily check, 2026-11-04 11:00 UTC, covering the 24 hours from 2026-11-03 11:00 UTC.",
      "Kill switch: off. Dry run: off.",
      DAILY_CHECK_DATA_NOTICE,
      "Nothing moved and nothing is waiting.",
      `Spend across projects: $0.00. ${SPEND_THRESHOLDS_NOT_BUILT}`,
      `Production deploy approval: ${PRODUCTION_DEPLOY_NOT_BUILT}`,
      "Nothing to show for: quiet.",
    ]);
    const one = renderDailyCheckHtml(check([project("p")]), PAGES);
    expect(one).not.toContain("<ul");
    expect(words(one)).toContain("Moved (0)");
    expect(words(one)).toContain("no staging address recorded");
    expect(words(one)).toContain(NO_SCAN_YET);
  });

  it("says when the kill switch or dry run is on", () => {
    const html = renderDailyCheckHtml(
      check([], { switches: { killSwitch: true, dryRun: true } }),
      PAGES,
    );
    expect(words(html)[1]).toBe(
      "Kill switch: on (the runner acts on nothing). Dry run: on (the runner plans moves and makes none).",
    );
  });
});

describe("the daily check's project setup lines (unit, D-358, O-114)", () => {
  const setup = {
    failed: [
      {
        slug: "garden-notes",
        message: "Bootstrap failed for garden-notes; run the register form again",
      },
    ],
    unreadable: ["seed-swap", "tool-library"],
  };

  it("says each failed setup, and the ones it could not read, before the projects, in the text and on the page", () => {
    const c = check([project("p")], { projectSetup: setup });
    const text = renderDailyCheck(c).split("\n");
    const failed = text.indexOf(
      "Bootstrap failed for garden-notes; run the register form again.",
    );
    expect(failed).toBeGreaterThan(0);
    expect(text[failed + 1]).toBe(
      "Bootstrap's runs could not be read for: seed-swap, tool-library. Whether their setup finished is not shown.",
    );
    expect(failed).toBeLessThan(text.findIndex((l) => l.startsWith("== p")));
    const html = renderDailyCheckHtml(c, PAGES);
    expect(html).toContain(
      "Bootstrap failed for garden-notes; run the register form again.",
    );
    expect(html.indexOf("<h3")).toBeGreaterThan(0);
    expect(html.indexOf("Bootstrap failed")).toBeLessThan(html.indexOf("<h3"));
  });

  it("says nothing about setup when none failed or it was not read", () => {
    for (const projectSetup of [null, { failed: [], unreadable: [] }]) {
      const c = check([], { projectSetup });
      expect(renderDailyCheck(c)).not.toContain("Bootstrap");
      expect(renderDailyCheckHtml(c, PAGES)).not.toContain("Bootstrap");
    }
  });
});
