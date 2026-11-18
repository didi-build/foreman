import { describe, expect, it } from "vitest";

import { createLogger } from "../service-kit/logger.ts";
import {
  emptyTally,
  parseServedTiersLog,
  SERVED_TIERS_MESSAGE,
  servedTierOf,
  servedTiersFields,
  tierOf,
  type ServedTierTally,
} from "./served-tiers.ts";

// Unit: the tally line's format, its parser and the run's tier from it (D-423, O-151). The lines
// are written by the proxy's own logger, as `createEgressProxy` writes them.

const RUN_ID = "run-tier-test";

const tally = (counts: Partial<ServedTierTally>): ServedTierTally => ({
  ...emptyTally(),
  ...counts,
});

/** A tally line exactly as the proxy logs it, with a fixed clock. */
function tallyLine(counts: Partial<ServedTierTally>, runId = RUN_ID): string {
  let line = "";
  const logger = createLogger(
    "egress-proxy",
    (written) => (line = written),
    () => new Date("2026-11-18T10:00:00Z"),
  );
  logger.info(SERVED_TIERS_MESSAGE, { runId, ...servedTiersFields(tally(counts)) });
  return line;
}

/** Another line of the proxy's log, through the same logger. */
function otherLine(message: string, fields: Record<string, unknown> = {}): string {
  let line = "";
  createLogger("egress-proxy", (written) => (line = written)).info(message, {
    runId: RUN_ID,
    ...fields,
  });
  return line;
}

describe("tier names (unit: D-423)", () => {
  it.each([
    ["default", "standard"],
    ["flex", "flex"],
    ["priority", "priority"],
    ["standard", null],
    ["auto", null],
    ["scale", null],
    ["FLEX", null],
    ["", null],
    [null, null],
    [undefined, null],
    [1, null],
  ])("reads %j as %j", (value, expected) => {
    expect(tierOf(value)).toBe(expected);
  });
});

describe("the run's tier from its tally (unit: D-423)", () => {
  it.each<[string, Partial<ServedTierTally>, string | null]>([
    ["every request on Flex", { flex: 31 }, "flex"],
    ["Flex with some unknown", { flex: 30, unknown: 2 }, "flex"],
    ["every request on Standard", { standard: 4 }, "standard"],
    ["every request on Priority", { priority: 1 }, "priority"],
    ["Flex and Standard", { flex: 30, standard: 1 }, "mixed"],
    ["one mixed request", { flex: 3, mixed: 1 }, "mixed"],
    ["only a mixed request", { mixed: 1 }, "mixed"],
    ["only unknown requests", { unknown: 5 }, null],
    ["no request", {}, null],
  ])("%s", (_label, counts, expected) => {
    expect(servedTierOf(tally(counts))).toBe(expected);
  });
});

describe("the tally line (unit: format and parser, D-423)", () => {
  it("is one JSON line of counts only, with the proxy's standard keys last", () => {
    expect(tallyLine({ flex: 2, unknown: 1 })).toBe(
      `{"runId":"${RUN_ID}","servedTiers":{"standard":0,"flex":2,"priority":0,"mixed":0,"unknown":1},` +
        `"time":"2026-11-18T10:00:00.000Z","level":"info","service":"egress-proxy","message":"served tiers"}`,
    );
  });

  it("copies the counts, so a later count cannot change a line already built", () => {
    const counts = tally({ flex: 1 });
    const fields = servedTiersFields(counts);
    counts.flex = 9;
    expect(fields.servedTiers.flex).toBe(1);
  });

  it("reads the newest tally line, past later lines of other kinds", () => {
    const log = [
      otherLine("listening", { port: 8080 }),
      tallyLine({ flex: 1 }),
      otherLine("model request", { status: 200 }),
      tallyLine({ flex: 2, unknown: 1 }),
      otherLine("tunnel closed", { host: "github.com" }),
      otherLine("state api request", { status: 200 }),
      "a line that is not JSON",
      "",
    ].join("\n");
    expect(parseServedTiersLog(log, RUN_ID)).toEqual(tally({ flex: 2, unknown: 1 }));
  });

  it("skips a cut first line of a log tail", () => {
    const line = tallyLine({ standard: 3 });
    const log = `${line.slice(40)}\n${otherLine("tunnel closed")}\n`;
    expect(parseServedTiersLog(log, RUN_ID)).toBeNull();
    expect(parseServedTiersLog(`${line.slice(40)}\n${line}`, RUN_ID)).toEqual(
      tally({ standard: 3 }),
    );
  });

  it.each([
    ["no log", null],
    ["an empty log", ""],
    [
      "a log with no tally line",
      `${otherLine("listening")}\n${otherLine("model request")}`,
    ],
  ])("gives null for %s", (_label, log) => {
    expect(parseServedTiersLog(log, RUN_ID)).toBeNull();
  });

  it("never takes a tally from text inside another line's field", () => {
    const nested = otherLine("tunnel refused", { host: tallyLine({ flex: 9 }) });
    expect(parseServedTiersLog(nested, RUN_ID)).toBeNull();
  });

  const good = tallyLine({ flex: 2 });
  const edited = (edit: (line: Record<string, unknown>) => void): string => {
    const line = JSON.parse(good) as Record<string, unknown>;
    edit(line);
    return JSON.stringify(line);
  };
  it.each([
    ["another run's", tallyLine({ flex: 5 }, "run-other")],
    ["another service's", edited((l) => (l.service = "agent"))],
    ["a warning's", edited((l) => (l.level = "warn"))],
    ["one with no counts", edited((l) => delete l.servedTiers)],
    ["one whose counts are a list", edited((l) => (l.servedTiers = [1, 2, 3, 4, 5]))],
    [
      "one missing a count",
      edited((l) => delete (l.servedTiers as Record<string, unknown>).unknown),
    ],
    [
      "one with an extra count",
      edited((l) => ((l.servedTiers as Record<string, unknown>).scale = 1)),
    ],
    [
      "one with a negative count",
      edited((l) => ((l.servedTiers as Record<string, unknown>).flex = -1)),
    ],
    [
      "one with a fractional count",
      edited((l) => ((l.servedTiers as Record<string, unknown>).flex = 1.5)),
    ],
    [
      "one with a count as text",
      edited((l) => ((l.servedTiers as Record<string, unknown>).flex = "2")),
    ],
  ])(
    "gives null when the newest tally line is %s, never an older one",
    (_label, bad) => {
      expect(parseServedTiersLog(good, RUN_ID)).toEqual(tally({ flex: 2 }));
      expect(parseServedTiersLog(`${good}\n${bad}\n`, RUN_ID)).toBeNull();
    },
  );
});
