// Seam: unit. The runner's check of a Council discussion (ADR 0119 slice 6c, D-483, D-484, D-488,
// O-180): `checkDiscussion` takes a record that follows every rule for each question kind's cast,
// and refuses each broken rule with its own fixed code; a pull-in refused for the limit needs the
// kind's own way to Didi; `discussionScope` keeps the record as the image gave it, each text
// within its bound and storable. The wiring into the Council's record is tested on the memory
// store in test/council-discussion-record.test.ts.
import { describe, expect, it } from "vitest";

import {
  checkDiscussion,
  discussionScope,
  DISCUSSION_REFUSALS,
  takesWayToDidi,
  type DiscussedAnswer,
  type DiscussionRefusal,
  type ExpectedDiscussion,
} from "./council-discussion.ts";
import {
  MAX_REASON_CHARS,
  MAX_VIEW_CHARS,
  type DiscussionRecord,
  type DiscussionView,
  type PullIn,
  type RefusedPullIn,
} from "./discussion-record.ts";
import type { PersonaId } from "./personas.ts";

/** Each question kind's answer that takes its way to Didi, and those that do not (D-484). */
const ANSWERS = {
  escalation: {
    didi: [{ kind: "escalation", answer: { outcome: "cannot_resolve" } }],
    not: [{ kind: "escalation", answer: { outcome: "resolve" } }],
  },
  reversal: {
    didi: [
      {
        kind: "reversal",
        answer: {
          verdicts: [
            { nodeId: "a", verdict: "cannot_decide", note: "" },
            { nodeId: "b", verdict: "cannot_decide", note: "" },
          ],
        },
      },
    ],
    not: [
      {
        kind: "reversal",
        answer: {
          verdicts: [
            { nodeId: "a", verdict: "cannot_decide", note: "" },
            { nodeId: "b", verdict: "redo", note: "" },
          ],
        },
      },
      {
        kind: "reversal",
        answer: { verdicts: [{ nodeId: "a", verdict: "still_valid", note: "" }] },
      },
      // No item to send: the answer has no way to Didi at all.
      { kind: "reversal", answer: { verdicts: [] } },
    ],
  },
  visual_call: {
    didi: [{ kind: "visual_call", answer: { call: "needs_didi" } }],
    not: [
      { kind: "visual_call", answer: { call: "small_tweak_council_would_approve" } },
    ],
  },
  scanner_gone: {
    didi: [{ kind: "scanner_gone", answer: { verdict: "cannot_decide" } }],
    not: [
      { kind: "scanner_gone", answer: { verdict: "stop" } },
      { kind: "scanner_gone", answer: { verdict: "keep" } },
    ],
  },
  still_needed: {
    didi: [{ kind: "still_needed", answer: { verdict: "cannot_decide" } }],
    not: [
      { kind: "still_needed", answer: { verdict: "stop" } },
      { kind: "still_needed", answer: { verdict: "keep" } },
    ],
  },
  plan: {
    didi: [
      { kind: "plan", answer: { needsDidi: { needed: "yes", reason: "Scope." } } },
    ],
    not: [
      { kind: "plan", answer: { needsDidi: { needed: "no", reason: "Docs only." } } },
      { kind: "plan", answer: { needsDidi: { needed: "unsure", reason: "Unclear." } } },
    ],
  },
} satisfies Record<
  DiscussedAnswer["kind"],
  { didi: DiscussedAnswer[]; not: DiscussedAnswer[] }
>;

/** The personas other than the chair. */
const PULLABLE: PersonaId[] = ["developer", "designer", "quality"];

type Kind = keyof typeof ANSWERS;
const KINDS = Object.keys(ANSWERS) as Kind[];

/** A cast `councilCast` gives each kind with the real table, for one question of the kind. */
const CASTS: Record<Kind, PersonaId[]> = {
  escalation: ["developer", "quality"],
  reversal: ["developer"],
  visual_call: ["designer", "quality"],
  scanner_gone: ["developer"],
  still_needed: ["developer"],
  plan: ["developer", "designer"],
};

const view = (persona: PersonaId, pulledInBy?: PersonaId): DiscussionView => ({
  persona,
  ...(pulledInBy ? { pulledInBy } : {}),
  text: `The ${persona}'s view.`,
});

const pullIn = (persona: PersonaId, by: PersonaId): PullIn => ({
  persona,
  by,
  reason: `It needs the ${persona}.`,
});

const refused = (
  persona: PersonaId,
  by: PersonaId,
  why: RefusedPullIn["why"],
): RefusedPullIn => ({ persona, by, reason: "One more view.", why });

/** A record in which each persona of the cast gives one view, and nothing else happens. */
const recordOf = (
  cast: PersonaId[],
  extra: Partial<DiscussionRecord> = {},
): DiscussionRecord => ({
  chair: "product",
  cast,
  views: cast.map((persona) => view(persona)),
  pullIns: [],
  refusedPullIns: [],
  ...extra,
});

const expectedOf = (
  kind: Kind,
  extra: Partial<ExpectedDiscussion> = {},
): ExpectedDiscussion => ({
  chair: "product",
  cast: CASTS[kind],
  maxPullIns: 2,
  answer: ANSWERS[kind].not[0] as DiscussedAnswer,
  ...extra,
});

const refusal = (value: unknown, expected: ExpectedDiscussion) => {
  const checked = checkDiscussion(value, expected);
  return "refused" in checked ? checked.refused : "ok";
};

describe("a discussion that follows every rule (unit: checkDiscussion, D-483, D-488)", () => {
  it("is taken for every question kind's cast, and given back as read", () => {
    for (const kind of KINDS) {
      const record = recordOf(CASTS[kind]);
      expect(checkDiscussion(structuredClone(record), expectedOf(kind)), kind).toEqual({
        discussion: record,
      });
    }
    // A reversal that made nothing stale: Product decides alone, with no view.
    expect(refusal(recordOf([]), expectedOf("reversal", { cast: [] }))).toBe("ok");
  });

  it("takes pull-ins by a cast member, the chair and an earlier pull-in, each pulled-in persona speaking once", () => {
    // The Developer pulls in the Designer, who pulls in Quality: each pulled-in view comes back
    // to its puller as a tool result, so it is recorded before the puller's own view.
    const chained = recordOf(["developer"], {
      pullIns: [pullIn("designer", "developer"), pullIn("quality", "designer")],
      views: [
        view("quality", "designer"),
        view("designer", "developer"),
        view("developer"),
      ],
    });
    for (const kind of ["still_needed", "scanner_gone", "reversal"] as const) {
      expect(refusal(chained, expectedOf(kind, { cast: ["developer"] })), kind).toBe(
        "ok",
      );
    }
    const byChair = recordOf(["developer", "quality"], {
      pullIns: [pullIn("designer", "product")],
      views: [view("developer"), view("quality"), view("designer", "product")],
    });
    expect(refusal(byChair, expectedOf("escalation"))).toBe("ok");
    // Refusals other than the limit's need no way to Didi.
    const otherRefusals = recordOf(["developer", "quality"], {
      refusedPullIns: [
        refused("quality", "developer", "in_discussion"),
        { ...refused("designer", "quality", "bad_reason"), reason: "" },
      ],
    });
    expect(refusal(otherRefusals, expectedOf("escalation"))).toBe("ok");
  });
});

describe("a discussion that breaks a rule (unit: checkDiscussion's fixed codes, D-483, D-484)", () => {
  it("names each rule with its own code, and no code quotes the record", () => {
    expect(DISCUSSION_REFUSALS).toEqual([
      "not_a_record",
      "wrong_chair",
      "wrong_cast",
      "too_many_pull_ins",
      "pull_in_in_discussion",
      "pull_in_by_outsider",
      "pull_in_reason",
      "chair_view",
      "outside_view",
      "repeated_view",
      "view_pulled_in_by",
      "missing_view",
      "limit_without_didi",
    ]);
    for (const code of DISCUSSION_REFUSALS) expect(code).toMatch(/^[a-z_]{1,40}$/);
  });

  it("refuses what is not a record within its bounds (not_a_record)", () => {
    const record = recordOf(["developer"]);
    for (const value of [
      null,
      {},
      "a discussion",
      { ...record, note: "extra" },
      { ...record, cast: ["product"] },
      {
        ...record,
        views: [{ persona: "developer", text: "x".repeat(MAX_VIEW_CHARS + 1) }],
      },
      { ...record, pullIns: [{ ...pullIn("designer", "developer"), reason: "a\nb" }] },
      { ...record, views: [{ persona: "analyst", text: "An old panel's view." }] },
    ]) {
      expect(refusal(value, expectedOf("still_needed"))).toBe("not_a_record");
    }
  });

  it("refuses another chair than the table's (wrong_chair)", () => {
    expect(
      refusal(
        recordOf(["quality"]),
        expectedOf("still_needed", { chair: "developer", cast: ["quality"] }),
      ),
    ).toBe("wrong_chair");
  });

  it("refuses a cast other than the question's, in its order, for every kind (wrong_cast)", () => {
    for (const kind of KINDS) {
      const cast = CASTS[kind];
      const others: PersonaId[][] = [
        [...cast, PULLABLE.find((persona) => !cast.includes(persona)) as PersonaId],
        cast.slice(1),
        [],
      ];
      if (cast.length > 1) others.push([...cast].reverse());
      for (const other of others) {
        expect(
          refusal(recordOf(other), expectedOf(kind)),
          `${kind} ${other.join()}`,
        ).toBe("wrong_cast");
      }
    }
    expect(refusal(recordOf(["developer"]), expectedOf("reversal", { cast: [] }))).toBe(
      "wrong_cast",
    );
  });

  it("refuses more pull-ins than the table allows (too_many_pull_ins)", () => {
    const one = recordOf(["developer", "quality"], {
      pullIns: [pullIn("designer", "developer")],
      views: [view("designer", "developer"), view("developer"), view("quality")],
    });
    expect(refusal(one, expectedOf("escalation", { maxPullIns: 1 }))).toBe("ok");
    expect(refusal(one, expectedOf("escalation", { maxPullIns: 0 }))).toBe(
      "too_many_pull_ins",
    );
    const two = recordOf([], {
      pullIns: [pullIn("developer", "product"), pullIn("designer", "developer")],
      views: [view("designer", "developer"), view("developer", "product")],
    });
    expect(refusal(two, expectedOf("reversal", { cast: [] }))).toBe("ok");
    expect(refusal(two, expectedOf("reversal", { cast: [], maxPullIns: 1 }))).toBe(
      "too_many_pull_ins",
    );
  });

  it("refuses a pull-in of someone already in the discussion (pull_in_in_discussion)", () => {
    const cases: PullIn[][] = [
      [pullIn("quality", "developer")],
      [pullIn("product", "developer")],
      [pullIn("designer", "developer"), pullIn("designer", "quality")],
    ];
    for (const pullIns of cases) {
      const record = recordOf(["developer", "quality"], {
        pullIns,
        views: [view("developer"), view("quality"), view("designer", "developer")],
      });
      expect(refusal(record, expectedOf("escalation"))).toBe("pull_in_in_discussion");
    }
  });

  it("refuses a pull-in asked by someone not in the discussion yet (pull_in_by_outsider)", () => {
    const cases: PullIn[][] = [
      [pullIn("designer", "quality")],
      [pullIn("designer", "designer")],
      // Quality is pulled in only after it asked.
      [pullIn("designer", "quality"), pullIn("quality", "developer")],
    ];
    for (const pullIns of cases) {
      const record = recordOf(["developer"], {
        pullIns,
        views: [view("developer"), ...pullIns.map((p) => view(p.persona, p.by))],
      });
      expect(refusal(record, expectedOf("plan", { cast: ["developer"] }))).toBe(
        "pull_in_by_outsider",
      );
    }
  });

  it("refuses a pull-in whose reason is blank (pull_in_reason)", () => {
    const record = recordOf(["developer"], {
      pullIns: [{ ...pullIn("designer", "developer"), reason: "   " }],
      views: [view("designer", "developer"), view("developer")],
    });
    expect(refusal(record, expectedOf("still_needed"))).toBe("pull_in_reason");
  });

  it("refuses a view from the chair, for every kind (chair_view)", () => {
    for (const kind of KINDS) {
      const record = recordOf(CASTS[kind]);
      record.views.push(view("product"));
      expect(refusal(record, expectedOf(kind)), kind).toBe("chair_view");
    }
  });

  it("refuses a view from someone neither in the cast nor pulled in (outside_view)", () => {
    const record = recordOf(["developer"], {
      views: [view("developer"), view("quality")],
    });
    expect(refusal(record, expectedOf("scanner_gone"))).toBe("outside_view");
  });

  it("refuses a second view from the same persona (repeated_view)", () => {
    const cast = recordOf(["developer", "quality"], {
      views: [view("developer"), view("quality"), view("developer")],
    });
    expect(refusal(cast, expectedOf("escalation"))).toBe("repeated_view");
    const pulled = recordOf(["developer"], {
      pullIns: [pullIn("designer", "developer")],
      views: [
        view("designer", "developer"),
        view("designer", "developer"),
        view("developer"),
      ],
    });
    expect(refusal(pulled, expectedOf("still_needed"))).toBe("repeated_view");
  });

  it("refuses a view that names the wrong puller (view_pulled_in_by)", () => {
    const pullIns = [pullIn("designer", "developer")];
    for (const views of [
      [view("designer"), view("developer")],
      [view("designer", "product"), view("developer")],
      [view("designer", "developer"), view("developer", "product")],
    ]) {
      expect(
        refusal(
          recordOf(["developer"], { pullIns, views }),
          expectedOf("still_needed"),
        ),
      ).toBe("view_pulled_in_by");
    }
  });

  it("refuses a discussion in which a speaker gave no view, for every kind (missing_view)", () => {
    for (const kind of KINDS) {
      const record = recordOf(CASTS[kind]);
      record.views.shift();
      expect(refusal(record, expectedOf(kind)), kind).toBe("missing_view");
    }
    const silentPullIn = recordOf(["developer"], {
      pullIns: [pullIn("designer", "developer")],
    });
    expect(refusal(silentPullIn, expectedOf("plan", { cast: ["developer"] }))).toBe(
      "missing_view",
    );
  });
});

describe("a pull-in refused for the limit (unit: checkDiscussion, D-484)", () => {
  /** For each kind, a discussion at its table's limit in which one more pull-in was refused. */
  const overLimit: Record<
    Kind,
    { expected: Partial<ExpectedDiscussion>; record: DiscussionRecord }
  > = {
    escalation: {
      expected: { maxPullIns: 0 },
      record: recordOf(["developer", "quality"], {
        refusedPullIns: [refused("designer", "developer", "limit")],
      }),
    },
    // The one case today's table allows (two pull-ins): a reversal that made nothing stale.
    reversal: {
      expected: { cast: [] },
      record: recordOf([], {
        pullIns: [pullIn("developer", "product"), pullIn("designer", "developer")],
        views: [view("designer", "developer"), view("developer", "product")],
        refusedPullIns: [refused("quality", "designer", "limit")],
      }),
    },
    visual_call: {
      expected: { maxPullIns: 0 },
      record: recordOf(["designer", "quality"], {
        refusedPullIns: [refused("developer", "quality", "limit")],
      }),
    },
    scanner_gone: {
      expected: { cast: ["developer"], maxPullIns: 1 },
      record: recordOf(["developer"], {
        pullIns: [pullIn("designer", "developer")],
        views: [view("designer", "developer"), view("developer")],
        refusedPullIns: [refused("quality", "product", "limit")],
      }),
    },
    still_needed: {
      expected: { cast: ["developer"], maxPullIns: 1 },
      record: recordOf(["developer"], {
        pullIns: [pullIn("quality", "developer")],
        views: [view("quality", "developer"), view("developer")],
        refusedPullIns: [refused("designer", "quality", "limit")],
      }),
    },
    plan: {
      expected: { cast: ["developer"], maxPullIns: 1 },
      record: recordOf(["developer"], {
        pullIns: [pullIn("designer", "product")],
        views: [view("developer"), view("designer", "product")],
        refusedPullIns: [refused("quality", "product", "limit")],
      }),
    },
  };

  it("is taken only with the kind's own way to Didi, for every kind", () => {
    for (const kind of KINDS) {
      const { expected, record } = overLimit[kind];
      for (const answer of ANSWERS[kind].didi) {
        expect(refusal(record, expectedOf(kind, { ...expected, answer })), kind).toBe(
          "ok",
        );
      }
      for (const answer of ANSWERS[kind].not) {
        expect(
          refusal(record, expectedOf(kind, { ...expected, answer })),
          `${kind} ${JSON.stringify(answer.answer)}`,
        ).toBe("limit_without_didi" satisfies DiscussionRefusal);
      }
      // The same discussion with no refusal over the limit needs no way to Didi.
      const within = { ...record, refusedPullIns: [] };
      for (const answer of ANSWERS[kind].not) {
        expect(refusal(within, expectedOf(kind, { ...expected, answer })), kind).toBe(
          "ok",
        );
      }
    }
  });

  it("reads each kind's way to Didi exactly as its schema gives it", () => {
    for (const kind of KINDS) {
      for (const answer of ANSWERS[kind].didi)
        expect(takesWayToDidi(answer), kind).toBe(true);
      for (const answer of ANSWERS[kind].not)
        expect(takesWayToDidi(answer), kind).toBe(false);
    }
  });
});

describe("what a Council decision keeps of a discussion (unit: discussionScope, D-488)", () => {
  it("keeps the chair, the cast, each view with its puller, each pull-in and each refused one", () => {
    const record = recordOf(["developer"], {
      pullIns: [pullIn("designer", "developer")],
      views: [view("designer", "developer"), view("developer")],
      refusedPullIns: [refused("quality", "product", "limit")],
    });
    expect(discussionScope(record)).toEqual({
      chair: "product",
      cast: ["developer"],
      views: [
        { persona: "designer", pulledInBy: "developer", text: "The designer's view." },
        { persona: "developer", text: "The developer's view." },
      ],
      pullIns: [
        { persona: "designer", by: "developer", reason: "It needs the designer." },
      ],
      refusedPullIns: [
        { persona: "quality", by: "product", reason: "One more view.", why: "limit" },
      ],
    });
    expect(discussionScope(recordOf([]))).toEqual({
      chair: "product",
      cast: [],
      views: [],
      pullIns: [],
      refusedPullIns: [],
    });
  });

  it("cuts a view at 2,000 characters and a reason at 300 again, never inside a surrogate pair", () => {
    const long = (n: number) => "v".repeat(n);
    const record = recordOf(["developer"], {
      views: [{ persona: "developer", text: long(MAX_VIEW_CHARS + 50) }],
      refusedPullIns: [
        {
          ...refused("quality", "developer", "bad_reason"),
          reason: long(MAX_REASON_CHARS + 5),
        },
      ],
    });
    const kept = discussionScope(record) as {
      views: { text: string }[];
      refusedPullIns: { reason: string }[];
    };
    expect(kept.views[0]?.text).toBe(long(MAX_VIEW_CHARS));
    expect(kept.refusedPullIns[0]?.reason).toBe(long(MAX_REASON_CHARS));
    // A pair across the bound is dropped whole, not split.
    const astral = `${long(MAX_VIEW_CHARS - 1)}\u{1f600}more`;
    const cut = discussionScope(
      recordOf(["developer"], { views: [{ persona: "developer", text: astral }] }),
    ) as { views: { text: string }[] };
    expect(cut.views[0]?.text).toBe(long(MAX_VIEW_CHARS - 1));
    // Within the bound, a pair is kept whole.
    const whole = discussionScope(
      recordOf(["developer"], {
        views: [{ persona: "developer", text: "Ship it \u{1f600}." }],
      }),
    ) as { views: { text: string }[] };
    expect(whole.views[0]?.text).toBe("Ship it \u{1f600}.");
  });

  it("replaces a lone surrogate half or NUL, which Postgres's jsonb refuses, and nothing else", () => {
    const record = recordOf(["developer"], {
      views: [{ persona: "developer", text: "half \ud83d and \ude00 and \u0000 end" }],
      refusedPullIns: [
        {
          ...refused("quality", "developer", "bad_reason"),
          reason: `${"r".repeat(299)}\ud83d`,
        },
      ],
    });
    const kept = discussionScope(record) as {
      views: { text: string }[];
      refusedPullIns: { reason: string }[];
    };
    expect(kept.views[0]?.text).toBe("half \ufffd and \ufffd and \ufffd end");
    expect(kept.refusedPullIns[0]?.reason).toBe(`${"r".repeat(299)}\ufffd`);
    const plain = 'Quotes "x", <view>, line one; and \u00e9.';
    const same = discussionScope(
      recordOf(["developer"], { views: [{ persona: "developer", text: plain }] }),
    ) as { views: { text: string }[] };
    expect(same.views[0]?.text).toBe(plain);
  });
});
