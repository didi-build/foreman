import { describe, expect, it } from "vitest";

import {
  MAX_REASON_CHARS,
  MAX_VIEW_CHARS,
  readDiscussionRecord,
  recordedReason,
  type DiscussionRecord,
} from "./discussion-record.ts";

// Unit: a Council discussion's record as the Kubernetes runtime reads it back from the result
// line (ADR 0119 slice 6, D-488): its shape and bounds, strictly. Whether the right personas
// spoke is the runner's check (slice 6c).

const RECORD: DiscussionRecord = {
  chair: "product",
  cast: ["developer", "quality"],
  views: [
    { persona: "designer", pulledInBy: "developer", text: "Use the card." },
    { persona: "developer", text: "Build it." },
    { persona: "quality", text: "Test it." },
  ],
  pullIns: [{ persona: "designer", by: "developer", reason: "It adds a screen." }],
  refusedPullIns: [
    { persona: "quality", by: "developer", reason: "", why: "in_discussion" },
  ],
};

const withPart = (part: Partial<Record<keyof DiscussionRecord, unknown>>) => ({
  ...RECORD,
  ...part,
});

describe("a discussion's record (unit: the strict reader, D-488)", () => {
  it("reads a record of exactly its shape back as it was", () => {
    expect(readDiscussionRecord(structuredClone(RECORD))).toEqual(RECORD);
    const bounds = withPart({
      cast: [],
      views: Array.from({ length: 5 }, () => ({
        persona: "developer",
        text: "v".repeat(MAX_VIEW_CHARS),
      })),
      pullIns: [
        { persona: "designer", by: "product", reason: "r".repeat(MAX_REASON_CHARS) },
        { persona: "quality", by: "designer", reason: "x" },
      ],
      refusedPullIns: Array.from({ length: 5 }, () => ({
        persona: "developer",
        by: "product",
        reason: "",
        why: "limit",
      })),
    });
    expect(readDiscussionRecord(bounds)).toEqual(bounds);
  });

  it.each([
    ["not an object", "a record"],
    ["another chair", withPart({ chair: "developer" })],
    ["a missing part", { chair: "product", cast: [], views: [], pullIns: [] }],
    ["another field", { ...RECORD, notes: "x" }],
    ["a cast that is not a list", withPart({ cast: "developer" })],
    ["the chair in the cast", withPart({ cast: ["product"] })],
    ["an unknown persona in the cast", withPart({ cast: ["cto"] })],
    ["a persona twice in the cast", withPart({ cast: ["developer", "developer"] })],
    [
      "more than three in the cast",
      withPart({ cast: ["developer", "designer", "quality", "x"] }),
    ],
    [
      "six views",
      withPart({
        views: Array.from({ length: 6 }, () => ({ persona: "developer", text: "v" })),
      }),
    ],
    [
      "a view over 2,000 characters",
      withPart({ views: [{ persona: "developer", text: "v".repeat(2001) }] }),
    ],
    ["an empty view", withPart({ views: [{ persona: "developer", text: "" }] })],
    ["a view by no persona", withPart({ views: [{ persona: "cto", text: "v" }] })],
    [
      "a view pulled in by no persona",
      withPart({ views: [{ persona: "developer", pulledInBy: 3, text: "v" }] }),
    ],
    [
      "a view with another field",
      withPart({ views: [{ persona: "developer", text: "v", by: "x" }] }),
    ],
    [
      "three pull-ins",
      withPart({
        pullIns: Array.from({ length: 3 }, () => ({
          persona: "designer",
          by: "product",
          reason: "r",
        })),
      }),
    ],
    [
      "a pull-in with no reason",
      withPart({ pullIns: [{ persona: "designer", by: "product", reason: "" }] }),
    ],
    [
      "a pull-in reason of two lines",
      withPart({ pullIns: [{ persona: "designer", by: "product", reason: "a\nb" }] }),
    ],
    [
      "a pull-in reason over 300 characters",
      withPart({
        pullIns: [{ persona: "designer", by: "product", reason: "r".repeat(301) }],
      }),
    ],
    [
      "a pull-in by no persona",
      withPart({ pullIns: [{ persona: "designer", by: "cto", reason: "r" }] }),
    ],
    [
      "six refused pull-ins",
      withPart({
        refusedPullIns: Array.from({ length: 6 }, () => ({
          persona: "designer",
          by: "product",
          reason: "",
          why: "limit",
        })),
      }),
    ],
    [
      "a refusal for an unknown reason",
      withPart({
        refusedPullIns: [
          { persona: "designer", by: "product", reason: "", why: "late" },
        ],
      }),
    ],
    [
      "a refused reason of two lines",
      withPart({
        refusedPullIns: [
          { persona: "designer", by: "product", reason: "a\rb", why: "bad_reason" },
        ],
      }),
    ],
  ])("refuses %s", (_, value) => {
    expect(readDiscussionRecord(value)).toBeNull();
  });

  it("keeps a refused reason on one line, trimmed and cut to the bound", () => {
    expect(recordedReason("  one\nline\r\n  ")).toBe("one line");
    expect(recordedReason("r".repeat(400))).toHaveLength(MAX_REASON_CHARS);
    // Cut, then trimmed again: no space is left at the end.
    expect(recordedReason(`${"r".repeat(299)}\n tail`)).toBe("r".repeat(299));
  });
});
