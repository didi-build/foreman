// Test support for Triage (build plan M3.6, D-265): a synthetic repository's repo map, a synthetic
// accepted plan, and Triage's good answer for it, with builders for the bad answers the runner
// must reject. Fake data only: no real repository, plan, person or model.
import type { RepoMap } from "../src/core/repo-map.ts";
import type { TriageAnswer, TriageItem } from "../src/core/triage.ts";

export const MAP_COMMIT = "c".repeat(40);
export const NEWER_COMMIT = "d".repeat(40);

/** A small synthetic repository at MAP_COMMIT. */
export const REPO_MAP: RepoMap = {
  commitSha: MAP_COMMIT,
  files: [
    { path: "README.md", exports: [], imports: [] },
    { path: "design/README.md", exports: [], imports: [] },
    { path: "docs/guide.md", exports: [], imports: [] },
    { path: "infra/main.tf", exports: [], imports: [] },
    { path: "package.json", exports: [], imports: [] },
    { path: "src/app.ts", exports: ["startApp"], imports: ["src/settings/store.ts"] },
    { path: "src/settings/store.ts", exports: ["readSettings"], imports: [] },
    { path: "wrangler.jsonc", exports: [], imports: [] },
  ],
  scripts: { check: "npm run lint && npm test", lint: "eslint .", test: "vitest run" },
};

/** The synthetic accepted plan, as the planning chat would have recorded it (D-261). */
export const PLAN = [
  "Plan: a settings page for the rehearsal app.",
  "1. Design the settings page.",
  "2. Wire the settings page into the app.",
  "3. Document the settings in the guide.",
  "4. Point a new subdomain at the app (a DNS change).",
  "5. Remove the old settings code, but not until the new page has run for a week.",
].join("\n");

export const DIRECTION = "Settings stay on one page. No account changes.";

const item = (
  fields: Partial<TriageItem> & Pick<TriageItem, "key" | "track">,
): TriageItem => ({
  title: `Item ${fields.key}`,
  description: `The ${fields.key} work.`,
  acceptanceCriteria: [`${fields.key} is done`],
  pathsInScope: ["src/app.ts"],
  checks: ["npm run check"],
  blockedBy: [],
  needsDidi: false,
  gate: "none",
  hold: false,
  ...fields,
});

/** Triage's good answer for PLAN: five items, three links, four tracks, one gate, one hold. */
export function goodAnswer(): TriageAnswer {
  return {
    items: [
      item({
        key: "settings-design",
        track: "design",
        pathsInScope: ["design"],
        checks: [],
      }),
      item({
        key: "settings-wire",
        track: "code",
        pathsInScope: ["src/app.ts", "src/settings/page.ts"],
        checks: ["npm run check", "npm run test"],
        blockedBy: ["settings-design"],
      }),
      item({
        key: "settings-docs",
        track: "docs",
        pathsInScope: ["docs/guide.md", "README.md"],
        checks: [],
        blockedBy: ["settings-wire"],
      }),
      item({
        key: "settings-dns",
        track: "infra",
        pathsInScope: ["infra/main.tf", "wrangler.jsonc"],
        checks: [],
        needsDidi: true,
        gate: "dns",
      }),
      item({
        key: "old-settings",
        track: "code",
        pathsInScope: ["src/settings"],
        blockedBy: ["settings-wire"],
        hold: true,
      }),
    ],
    note: "Item 5 waits a week after the new page ships, so it is on hold.",
  };
}

/** The good answer with one change. */
export function answerWith(change: (answer: TriageAnswer) => void): TriageAnswer {
  const answer = goodAnswer();
  change(answer);
  return answer;
}

const at = (answer: TriageAnswer, key: string): TriageItem => {
  const found = answer.items.find((i) => i.key === key);
  if (!found) throw new Error(`no item ${key}`);
  return found;
};

/** The bad answers D-265's success test names, each with the code the runner rejects it with. */
export const BAD_ANSWERS: { name: string; code: string; answer: () => TriageAnswer }[] =
  [
    {
      name: "a path missing from the repo map",
      code: "path_not_in_repo_map",
      answer: () =>
        answerWith((a) => {
          at(a, "settings-wire").pathsInScope.push("src/billing/invoice.ts");
        }),
    },
    {
      name: "an unknown check",
      code: "unknown_check",
      answer: () =>
        answerWith((a) => {
          at(a, "settings-wire").checks.push("npm run deploy");
        }),
    },
    {
      name: "a track that does not match the paths",
      code: "track_mismatch",
      answer: () =>
        answerWith((a) => {
          at(a, "settings-docs").pathsInScope.push("src/app.ts");
        }),
    },
    {
      name: "a blocking cycle",
      code: "blocking_cycle",
      answer: () =>
        answerWith((a) => {
          at(a, "settings-design").blockedBy.push("settings-docs");
        }),
    },
    {
      name: "a design item with no developer counterpart",
      code: "missing_design_counterpart",
      answer: () =>
        answerWith((a) => {
          at(a, "settings-wire").blockedBy = [];
        }),
    },
  ];
