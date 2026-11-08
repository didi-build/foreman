// The daily check's two renderings (build plan M4.4, O-91, D-319, D-320, O-100): short plain text,
// and a page for reading on a phone, which the flow f/foreman/daily_check returns for Windmill to
// render in its run's result. Plain functions with no I/O.
//
// Both come from one document: the check's lines, in the same sections and order, each line made
// of pieces. A piece is fixed words (which may carry ids, counts, state names and other plain
// values), recorded text quoted as data, the project's recorded staging address, or the Windmill
// path of a flow Didi can start. So the two renderings cannot drift apart: the page says exactly
// what the text says.
//
// The page treats everything from the store as untrusted. Every piece is escaped as HTML text, and
// only two kinds of link are made:
// - a project's recorded staging address, when it is an absolute `https:` address with no user
//   name or password; any other address is shown as text;
// - the Windmill page of a flow the caller names in `flowPages`, as a path on Windmill's own
//   origin, behind its sign-in (D-295), never a public or signed-token link. A path that is not
//   plainly relative (one leading slash, then letters, digits, `_`, `-`, `.` and `/`, no `..`) is
//   shown as text.
// The text next to each link says the same thing (the address, or the flow's path and the item id
// it takes), so the page still works if Windmill does not make links clickable. Small inline
// styles only: no script, no external resource, no image and no form. As in the text, no approval
// link, topic key, decision, run or evidence id is shown: only item ids and gate request ids.
import {
  NO_SCAN_YET,
  REOPEN_LATER,
  type CancelEntry,
  type CheckItem,
  type DailyCheck,
  type MovedItem,
  type ProjectCheck,
  type ScanSection,
  type StalledSection,
} from "./daily-check.ts";
import type { CancelHow } from "./cancel.ts";
import type { CloseStatus } from "./pr-close.ts";
import { SCAN_CHECKS } from "./scan.ts";
import { STALL_WAIT_TEXT, type StallWait } from "./stalls.ts";

const MINUTE_MS = 60_000;

/** A piece of a line (see above). */
export type Piece =
  string | { quoted: string } | { stagingUrl: string } | { flow: string };
type Line = Piece[];

/** A section of a project: its label, an optional line after it, and its entries. */
interface Section {
  label: Line;
  text: Line | null;
  items: Line[];
}

interface CheckDocument {
  intro: Line[];
  /** Projects whose setup failed, and those whose setup could not be read (O-114). */
  setup: Line[];
  /** Said when no project has anything to show. */
  nothing: Line | null;
  projects: { heading: Line; sections: Section[] }[];
  footer: Line[];
}

type Part = Piece | Line | number;

/** A line from a template: fixed words, with pieces and lines spliced in. */
function line(strings: TemplateStringsArray, ...values: Part[]): Line {
  const out: Line = [];
  strings.forEach((words, i) => {
    if (words !== "") out.push(words);
    const value = values[i];
    if (value === undefined) return;
    if (Array.isArray(value)) out.push(...value);
    else out.push(typeof value === "number" ? String(value) : value);
  });
  return out;
}

const quoted = (text: string): Piece => ({ quoted: text });

function joined(lines: readonly Line[], separator: string): Line {
  return lines.flatMap((l, i) => (i === 0 ? l : [separator, ...l]));
}

const when = (at: Date): string =>
  `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Whole minutes as "3 d 4 h", "2 h 5 min" or "40 min". */
export function duration(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return mins > 0 ? `${hours} h ${mins} min` : `${hours} h`;
  return `${mins} min`;
}

const item = (i: CheckItem): Line => line`${quoted(i.title)} (item ${i.nodeId})`;
const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;
const usd = (value: number): string => `$${value.toFixed(2)}`;

const listed = (label: string, items: Line[]): Section => ({
  label: [`${label} (${items.length})`],
  text: null,
  items,
});

function projectSections(p: ProjectCheck, to: Date): Section[] {
  const minutesSince = (at: Date) =>
    Math.max(0, Math.floor((to.getTime() - at.getTime()) / MINUTE_MS));
  const moveLine = (m: MovedItem): Line =>
    line`${item(m)}: ${m.fromLabel} to ${m.toLabel}, ${when(m.at)}, by ${m.actorKind}${
      m.reason ? line`. Reason: ${quoted(m.reason)}` : []
    }`;

  const sections: Section[] = [listed("Moved", p.moved.map(moveLine))];
  if (p.plannedInDryRun.length > 0) {
    sections.push(
      listed("Planned in dry run, nothing moved", p.plannedInDryRun.map(moveLine)),
    );
  }
  sections.push(
    listed(
      "Blocked",
      p.blocked.map(
        (b) =>
          line`${item(b)} in ${b.stateLabel} for ${duration(minutesSince(b.blockedSince))}, holds up ${plural(b.holdsUp, "item")}. Why: ${quoted(b.reason)}${
            b.waitingOn.length > 0
              ? line`. Waits on: ${joined(b.waitingOn.map(item), ", ")}`
              : []
          }`,
      ),
    ),
    {
      label: ["Staging"],
      text:
        p.staging.url !== null
          ? [{ stagingUrl: p.staging.url }]
          : ["no staging address recorded"],
      items: [
        ...p.staging.onStaging.map(
          (s) =>
            line`on staging, waiting on its check: ${item(s)} since ${when(s.since)}`,
        ),
        ...p.staging.passedInWindow.map(
          (s) => line`passed its staging check: ${item(s)} at ${when(s.since)}`,
        ),
      ],
    },
    listed(
      "Questions waiting for Didi",
      p.questions.map(
        (q) =>
          line`${q.blocking ? "[blocking] " : ""}${q.kind}${
            q.nodeId
              ? line` on ${q.title !== null ? quoted(q.title) : "an item"} (item ${q.nodeId})`
              : []
          }, waiting ${duration(q.waitingForMinutes)} (request ${q.gateRequestId})${
            q.question !== null ? line`: ${quoted(q.question)}` : []
          }`,
      ),
    ),
    listed(
      "Accepted by the Council",
      p.councilAccepted.map(
        (a) =>
          line`${quoted(a.title)} (item ${a.nodeId}), ${when(a.acceptedAt)}. Plan: ${quoted(a.planFirstLine)}. Why Didi was not needed: ${quoted(a.reason)}`,
      ),
    ),
    listed(
      "Held with no open release request",
      p.heldItems.map(
        (h) =>
          line`${quoted(h.title)} (item ${h.nodeId}), held ${duration(h.heldForMinutes)}${
            h.reworkOf ? `, rework of item ${h.reworkOf}` : ""
          }${
            h.lastNote
              ? line`. Didi's last note (${h.lastNote.outcome}, ${when(h.lastNote.answeredAt)}): ${quoted(h.lastNote.text)}`
              : ". No note from Didi"
          }. To ask for a fresh release request, start ${{ flow: h.freshRequest.flow }} with ${JSON.stringify(h.freshRequest.input)}`,
      ),
    ),
  );
  const s = p.spend;
  sections.push(
    {
      label: ["Spend"],
      text: [
        `${plural(s.runsEnded, "run")} ended, ${usd(s.costUsd)}` +
          (s.unpricedRuns > 0
            ? ` (${plural(s.unpricedRuns, "run")} with no recorded cost)`
            : "") +
          `, ${s.tokens.input} input and ${s.tokens.output} output tokens; ${plural(s.runsActive, "run")} active`,
      ],
      items: [],
    },
    stalledSection(p.stalled, to),
    scanSection(p.scan),
  );
  if (p.cancels.length > 0) sections.push(listed("Stopped", p.cancels.map(cancelLine)));
  return sections;
}

/** What a stalled item waits on, as one phrase per wait. */
function waitText(wait: StallWait): Line {
  const text = STALL_WAIT_TEXT[wait.code];
  if (wait.code === "usage_exhausted_wait") {
    return [
      `${text} (${wait.detail ?? "cause not recorded"})` +
        (wait.until
          ? `, until ${when(wait.until)}`
          : ", with no wait setting to end it"),
    ];
  }
  const guard = wait.guard !== undefined ? `: ${wait.guard}` : "";
  return line`${text}${guard}${wait.detail !== null ? line` (${quoted(wait.detail)})` : []}`;
}

/** Both kinds in one list, longest stalled first (D-302). */
function stalledSection(stalled: StalledSection, to: Date): Section {
  const entries: { since: Date; line: Line }[] = [
    ...stalled.items.map((i) => ({
      since: i.readySince,
      line: line`ready, no run started: ${quoted(i.title)} (item ${i.nodeId}) in ${i.stateLabel} for ${duration(i.stalledForMinutes)}. Waits on: ${joined(i.waits.map(waitText), "; ")}`,
    })),
    ...stalled.runs.map((r) => ({
      since: r.lastActivityAt,
      line: line`run quiet: the ${r.bot} run on ${
        r.nodeId
          ? line`${r.title !== null ? quoted(r.title) : "an item"} (item ${r.nodeId})`
          : "no item"
      }, no activity for ${duration(Math.max(0, Math.floor((to.getTime() - r.lastActivityAt.getTime()) / MINUTE_MS)))}${
        r.budgetMinutes !== null
          ? `, past its budget of ${duration(Math.round(r.budgetMinutes))}`
          : ", its time budget cannot be read"
      }`,
    })),
  ].sort((a, b) => a.since.getTime() - b.since.getTime());
  return listed(
    "Stalled",
    entries.map((e) => e.line),
  );
}

const CANCEL_WHO: Record<CancelHow, string> = {
  council: "the Council cancelled it, on a plan the Council accepted",
  didi_confirmed:
    "Didi approved the Council's recommendation to cancel it, on a plan Didi approved",
  didi: "Didi cancelled it",
};

/** What the check says of a close run's outcome (D-318). */
const CLOSE_TEXT: Record<Extract<CloseStatus, { status: "ended" }>["outcome"], string> =
  {
    closed: "closed by its bot's close run",
    already_closed: "was already closed when its bot's close run read it",
    already_merged: "was already merged when its bot's close run read it",
    not_found: "was not found on GitHub by its bot's close run",
    refused:
      "left open: its head is not the item's branch, so its bot's close run refused it; close it by hand if it should be closed",
    failed:
      "left open: its bot's close run failed, and none is started again; close it by hand",
  };

/** An item's pull request and its close, for the Stopped list. Merged items have none to close. */
function pullRequestLine(i: CancelEntry["items"][number]): string {
  if (i.pullRequest === null || i.state === "verifying_on_staging") return "";
  const pr = `, its pull request #${i.pullRequest}`;
  if (i.close === null) return `${pr} is closed by its bot once the item is cancelled`;
  if (i.close.status === "none")
    return `${pr} waits for its bot's close run, which starts once admitted`;
  if (i.close.status === "running")
    return `${pr} is being closed by its bot's close run`;
  return `${pr} ${CLOSE_TEXT[i.close.outcome]}`;
}

function cancelLine(c: CancelEntry): Line {
  const items: Line =
    c.items.length === 0
      ? ["no work items"]
      : joined(
          c.items.map(
            (i) =>
              line`${item(i)} ${i.stateLabel}${
                i.state === "verifying_on_staging"
                  ? " (merged: it finishes normally)"
                  : ""
              }${pullRequestLine(i)}`,
          ),
          "; ",
        );
  const words = c.how === "didi" ? "Didi's reason" : "The Council's note";
  const state: Line = c.ideaRejected
    ? line`Its idea ${quoted(c.ideaRejected.title)} (item ${c.ideaRejected.nodeId}) moved to Rejected ${when(c.ideaRejected.at)}.`
    : c.finished
      ? ["Every item is finished."]
      : [
          "Still being cancelled: an item waits for its run to end or finishes normally.",
        ];
  return line`${quoted(c.title)} (item ${c.nodeId}): ${CANCEL_WHO[c.how]}. ${words}: ${quoted(c.note)}. Work items: ${items}. ${state} ${REOPEN_LATER}`;
}

function scanSection(scan: ScanSection): Section {
  const section = (text: Line, items: Line[] = []): Section => ({
    label: ["Scan"],
    text,
    items,
  });
  if (scan.lastScanAt === null) return section([scan.note ?? NO_SCAN_YET]);
  const ran = `last ran ${when(scan.lastScanAt)}${scan.commitSha ? ` at commit ${scan.commitSha.slice(0, 12)}` : ""}`;
  if (scan.outcome === "failed") {
    return section([`${ran}, and failed: ${scan.failure ?? "the scan failed"}.`]);
  }
  if (scan.note !== null) return section([`${ran}. ${scan.note}`]);
  const byCheck = SCAN_CHECKS.filter((c) => scan.findingsByCheck[c] > 0)
    .map((c) => `${c} ${scan.findingsByCheck[c]}`)
    .join(", ");
  const folded = scan.foldedInto.reduce((n, f) => n + f.findings, 0);
  return section(
    [
      `${ran}: ${plural(scan.findings, "finding")}${byCheck === "" ? "" : ` (${byCheck})`}; ` +
        `${plural(scan.newIdeas.length, "new idea")}, ${scan.merged} merged as duplicates, ` +
        `${folded} folded into open ideas, ${scan.overCap} over the cap of ${scan.cap ?? 0}.`,
    ],
    [
      ...scan.newIdeas.map(
        (idea) =>
          line`new idea ${quoted(idea.title)} (item ${idea.nodeId}), ${idea.class}, ${idea.check}`,
      ),
      ...scan.foldedInto.map(
        (f) =>
          line`folded into ${quoted(f.title)} (item ${f.nodeId}): ${plural(f.findings, "new finding")}`,
      ),
      ...scan.withdrawn.map(
        (w) =>
          line`withdrawn ${quoted(w.title)} (item ${w.nodeId}): no longer found, moved from Submitted to Rejected. ${REOPEN_LATER}`,
      ),
      ...scan.notWithdrawn.map(
        (w) =>
          line`no longer found, not withdrawn yet: ${quoted(w.title)} (item ${w.nodeId}), still in Submitted`,
      ),
      ...scan.askedCouncil.map(
        (a) =>
          line`no longer found, asked the Council: ${quoted(a.title)} (item ${a.nodeId}), in ${a.state}`,
      ),
    ],
  );
}

/** The check as one document, which both renderings read. */
function documentOf(check: DailyCheck): CheckDocument {
  const { killSwitch, dryRun } = check.switches;
  const footer: Line[] = [
    [
      `Spend across projects: ${usd(check.projects.reduce((sum, p) => sum + p.spend.costUsd, 0))}. ${check.spendNote}`,
    ],
    [`Production deploy approval: ${check.productionDeployApproval.note}`],
  ];
  if (check.stalledNote !== null) {
    footer.push([`Stalled items: not listed. ${check.stalledNote}.`]);
  }
  if (check.quietProjects.length > 0) {
    footer.push([`Nothing to show for: ${check.quietProjects.join(", ")}.`]);
  }
  const setup: Line[] = (check.projectSetup?.failed ?? []).map((f) => [
    `${f.message}.`,
  ]);
  if (check.projectSetup && check.projectSetup.unreadable.length > 0) {
    setup.push([
      `Bootstrap's runs could not be read for: ${check.projectSetup.unreadable.join(", ")}. Whether their setup finished is not shown.`,
    ]);
  }
  return {
    intro: [
      [
        `Daily check, ${when(check.generatedAt)}, covering the ${check.window.hours} hours from ${when(check.window.from)}.`,
      ],
      [
        `Kill switch: ${killSwitch ? "on (the runner acts on nothing)" : "off"}. Dry run: ${dryRun ? "on (the runner plans moves and makes none)" : "off"}.`,
      ],
      [check.dataNotice],
    ],
    setup,
    nothing:
      check.projects.length === 0 ? ["Nothing moved and nothing is waiting."] : null,
    projects: check.projects.map((p) => ({
      heading: line`${p.slug} (${quoted(p.name)}): ${plural(p.waitingItems, "item")} waiting`,
      sections: projectSections(p, check.generatedAt),
    })),
    footer,
  };
}

// The plain text.

const pieceText = (piece: Piece): string =>
  typeof piece === "string"
    ? piece
    : "quoted" in piece
      ? // Quoted on one line, escaped, so it cannot read as part of the check.
        JSON.stringify(piece.quoted)
      : "stagingUrl" in piece
        ? piece.stagingUrl
        : piece.flow;

const lineText = (l: Line): string => l.map(pieceText).join("");

/** The check as short plain text, for the flow's result. */
export function renderDailyCheck(check: DailyCheck): string {
  const doc = documentOf(check);
  const lines = doc.intro.map(lineText);
  if (doc.setup.length > 0) lines.push("", ...doc.setup.map(lineText));
  if (doc.nothing) lines.push("", lineText(doc.nothing));
  for (const project of doc.projects) {
    lines.push("", `== ${lineText(project.heading)} ==`);
    for (const s of project.sections) {
      lines.push(
        `${lineText(s.label)}:${s.text ? ` ${lineText(s.text)}` : ""}`,
        ...s.items.map((i) => `- ${lineText(i)}`),
      );
    }
  }
  lines.push("", ...doc.footer.map(lineText));
  return lines.join("\n");
}

// The page.

export interface DailyCheckPageOptions {
  /**
   * The Windmill page of each flow the check may name, by the flow's path, as a path on
   * Windmill's own origin (D-295). Only these flows become links.
   */
  flowPages: Readonly<Record<string, string>>;
}

/** Escapes text for HTML, both as element text and inside a double-quoted attribute. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The staging address as a link target, or null when it may not be one (see above). */
export function stagingHref(recorded: string): string | null {
  let url: URL;
  try {
    url = new URL(recorded);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
    return null;
  return url.href;
}

/** A plainly relative path on Windmill's own origin: no scheme, host, `..`, query or fragment. */
const RELATIVE_PAGE = /^\/(?!\/)[A-Za-z0-9_\-./]*$/;

function flowHref(flow: string, options: DailyCheckPageOptions): string | null {
  if (!Object.hasOwn(options.flowPages, flow)) return null;
  const page = options.flowPages[flow];
  return page !== undefined && RELATIVE_PAGE.test(page) && !page.includes("..")
    ? page
    : null;
}

const link = (href: string, text: string, rel = ""): string =>
  `<a href="${escapeHtml(href)}"${rel ? ` rel="${rel}"` : ""}>${escapeHtml(text)}</a>`;

function pieceHtml(piece: Piece, options: DailyCheckPageOptions): string {
  if (typeof piece === "string") return escapeHtml(piece);
  if ("quoted" in piece) return escapeHtml(JSON.stringify(piece.quoted));
  if ("stagingUrl" in piece) {
    const href = stagingHref(piece.stagingUrl);
    return href === null
      ? escapeHtml(piece.stagingUrl)
      : link(href, piece.stagingUrl, "noreferrer");
  }
  const href = flowHref(piece.flow, options);
  return href === null ? escapeHtml(piece.flow) : link(href, piece.flow);
}

const STYLE = {
  page: "font-family:system-ui,-apple-system,sans-serif;font-size:16px;line-height:1.5;max-width:40rem;margin:0 auto;padding:8px;overflow-wrap:anywhere;word-break:break-word",
  title: "font-size:1.25em;margin:0 0 0.5em",
  p: "margin:0.25em 0",
  notice: "margin:0.25em 0;font-size:0.875em;opacity:0.8",
  project:
    "margin-top:1.25em;padding-top:0.5em;border-top:1px solid rgba(128,128,128,0.5)",
  heading: "font-size:1.125em;margin:0.25em 0",
  label: "font-size:1em;margin:0.75em 0 0.25em",
  list: "margin:0.25em 0;padding-left:1.25em",
  entry: "margin:0.25em 0",
} as const;

/**
 * The check as a page for reading on a phone: the same lines as the text, in the same order,
 * as HTML with small inline styles (see above).
 */
export function renderDailyCheckHtml(
  check: DailyCheck,
  options: DailyCheckPageOptions,
): string {
  const doc = documentOf(check);
  const html = (l: Line): string => l.map((p) => pieceHtml(p, options)).join("");
  const el = (tag: string, style: string, inner: string): string =>
    `<${tag} style="${style}">${inner}</${tag}>`;
  const [first, ...rest] = doc.intro;
  const out: string[] = [
    el("h2", STYLE.title, html(first ?? [])),
    ...rest.map((l, i) =>
      el("p", i === rest.length - 1 ? STYLE.notice : STYLE.p, html(l)),
    ),
  ];
  if (doc.setup.length > 0) {
    out.push(
      el(
        "section",
        STYLE.project,
        doc.setup.map((l) => el("p", STYLE.p, html(l))).join(""),
      ),
    );
  }
  if (doc.nothing) out.push(el("p", STYLE.p, html(doc.nothing)));
  for (const project of doc.projects) {
    const parts = [el("h3", STYLE.heading, html(project.heading))];
    for (const s of project.sections) {
      parts.push(el("h4", STYLE.label, html(s.label)));
      if (s.text) parts.push(el("p", STYLE.p, html(s.text)));
      if (s.items.length > 0) {
        parts.push(
          el(
            "ul",
            STYLE.list,
            s.items.map((i) => el("li", STYLE.entry, html(i))).join(""),
          ),
        );
      }
    }
    out.push(el("section", STYLE.project, parts.join("")));
  }
  out.push(
    el(
      "section",
      STYLE.project,
      doc.footer.map((l) => el("p", STYLE.p, html(l))).join(""),
    ),
  );
  return el("div", STYLE.page, out.join(""));
}
