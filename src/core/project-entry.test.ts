import { describe, expect, it } from "vitest";

import {
  DEPLOY_TARGETS,
  PROJECT_ENTRY_REFUSALS,
  PROJECT_ENTRY_SLUG,
  isProjectEntrySlug,
  isProjectsMarker,
  parseProjectEntry,
  parseProjectQuota,
  projectFileName,
  type ProjectEntryRefusal,
} from "./project-entry.ts";

// Unit: the settings repository's entry rules (ADR 0118 appendix A, D-377, D-436, D-441, O-157).
// Synthetic files only, made here; the rehearsal's own file is the one appendix A gives.

const QUOTA = {
  pods: 12,
  cpu: "6",
  memory: "5Gi",
  ephemeralStorage: "11Gi",
  storage: "3Gi",
  persistentVolumeClaims: 3,
};

const REHEARSAL = {
  schema: 1,
  slug: "rehearsal",
  displayName: "Rehearsal",
  purpose: "Foreman rehearsal: a throwaway project for testing the factory end to end.",
  collectsPersonalData: true,
  quota: QUOTA,
  deployTarget: "cloudflare",
  createdOn: "2026-11-13",
};

const parse = (value: unknown, fileName = "rehearsal.json") =>
  parseProjectEntry(
    fileName,
    typeof value === "string" ? value : JSON.stringify(value),
  );

const refusalOf = (value: unknown, fileName?: string): ProjectEntryRefusal | null => {
  const result = parse(value, fileName);
  return result.ok ? null : result.reason;
};

describe("a project file (unit: ADR 0118 appendix A, O-157)", () => {
  it("reads the rehearsal's file as appendix A gives it, every field kept", () => {
    expect(parse(REHEARSAL)).toEqual({ ok: true, entry: REHEARSAL });
    const cluster = { ...REHEARSAL, slug: "foreman", deployTarget: "cluster" };
    expect(parse(cluster, "foreman.json")).toEqual({ ok: true, entry: cluster });
    expect(DEPLOY_TARGETS).toEqual(["cloudflare", "cluster"]);
  });

  it("refuses anything that is not one JSON object", () => {
    expect(refusalOf("not json")).toBe("not_json");
    expect(refusalOf("")).toBe("not_json");
    expect(refusalOf("[]")).toBe("not_an_object");
    expect(refusalOf("null")).toBe("not_an_object");
    expect(refusalOf('"rehearsal"')).toBe("not_an_object");
  });

  it("refuses a missing field and an extra one", () => {
    for (const field of Object.keys(REHEARSAL)) {
      const rest: Record<string, unknown> = { ...REHEARSAL };
      delete rest[field];
      expect(refusalOf(rest), field).toBe("fields");
    }
    expect(refusalOf({ ...REHEARSAL, size: "large" })).toBe("fields");
    expect(refusalOf({ ...REHEARSAL, private: false })).toBe("fields");
  });

  it("refuses another schema", () => {
    for (const schema of [0, 2, "1", 1.5, null]) {
      expect(refusalOf({ ...REHEARSAL, schema }), String(schema)).toBe("schema");
    }
  });

  it("holds the slug to the agent namespace's rule with no two hyphens together, and the file name to the slug", () => {
    for (const good of ["rehearsal", "shop-2", "a", "0x", "a-b-c", "a".repeat(47)]) {
      expect(isProjectEntrySlug(good), good).toBe(true);
      expect(refusalOf({ ...REHEARSAL, slug: good }, projectFileName(good)), good).toBe(
        null,
      );
    }
    for (const bad of [
      "",
      "Rehearsal",
      "-x",
      "x-",
      "a--b",
      "xn--abc",
      "a_b",
      "a.b",
      "a/b",
      "a b",
      "a\n",
      "é",
      "a".repeat(48),
      7,
      null,
    ]) {
      expect(isProjectEntrySlug(bad), JSON.stringify(bad)).toBe(false);
      expect(refusalOf({ ...REHEARSAL, slug: bad }), JSON.stringify(bad)).toBe("slug");
    }
    expect(PROJECT_ENTRY_SLUG.test("a".repeat(47))).toBe(true);
    for (const name of [
      "shop.json",
      "rehearsal",
      "rehearsal.JSON",
      "rehearsal.json.bak",
    ]) {
      expect(refusalOf(REHEARSAL, name), name).toBe("file_name");
    }
  });

  it("holds the display name and the purpose to one trimmed line, 60 and 200 characters at most", () => {
    const one = (text: string, field: "displayName" | "purpose") =>
      refusalOf({ ...REHEARSAL, [field]: text });
    expect(one("x".repeat(60), "displayName")).toBe(null);
    expect(one("x".repeat(200), "purpose")).toBe(null);
    for (const [field, reason, max] of [
      ["displayName", "display_name", 60],
      ["purpose", "purpose", 200],
    ] as const) {
      for (const bad of [
        "",
        " ",
        " Rehearsal",
        "Rehearsal ",
        "Two\nlines",
        "Two\rlines",
        "Zero​width",
        "Bell\u0007",
        "x".repeat(max + 1),
      ]) {
        expect(one(bad, field), `${field} ${JSON.stringify(bad)}`).toBe(reason);
      }
      expect(refusalOf({ ...REHEARSAL, [field]: 7 })).toBe(reason);
    }
  });

  it("takes the personal-data answer as true or false only", () => {
    expect(refusalOf({ ...REHEARSAL, collectsPersonalData: false })).toBe(null);
    for (const bad of ["yes", "true", 1, null]) {
      expect(refusalOf({ ...REHEARSAL, collectsPersonalData: bad })).toBe(
        "personal_data",
      );
    }
  });

  it("takes the quota in full, with whole counts and plain quantities", () => {
    const withoutPods: Record<string, unknown> = { ...QUOTA };
    delete withoutPods.pods;
    expect(parseProjectQuota(QUOTA)).toEqual(QUOTA);
    expect(parseProjectQuota({ ...QUOTA, cpu: "500m", storage: "0" })).not.toBeNull();
    expect(
      parseProjectQuota({ ...QUOTA, pods: 0, persistentVolumeClaims: 0 }),
    ).not.toBeNull();
    const bad: unknown[] = [
      null,
      [],
      "standard",
      { ...QUOTA, extra: 1 },
      withoutPods,
      { ...QUOTA, pods: -1 },
      { ...QUOTA, pods: 1.5 },
      { ...QUOTA, pods: "12" },
      { ...QUOTA, persistentVolumeClaims: "3" },
      { ...QUOTA, cpu: 6 },
      { ...QUOTA, cpu: "-6" },
      { ...QUOTA, cpu: "0.5" },
      { ...QUOTA, cpu: "06" },
      { ...QUOTA, memory: "5 Gi" },
      { ...QUOTA, memory: "5gi" },
      { ...QUOTA, memory: "5Pi" },
      { ...QUOTA, ephemeralStorage: "" },
      { ...QUOTA, storage: "3Gi\n" },
    ];
    for (const quota of bad) {
      expect(parseProjectQuota(quota), JSON.stringify(quota)).toBeNull();
      expect(refusalOf({ ...REHEARSAL, quota }), JSON.stringify(quota)).toBe("quota");
    }
  });

  it("takes only the two deploy targets", () => {
    for (const bad of ["Cloudflare", "aws", "", null, ["cloudflare"]]) {
      expect(refusalOf({ ...REHEARSAL, deployTarget: bad }), String(bad)).toBe(
        "deploy_target",
      );
    }
  });

  it("takes createdOn as a real calendar date written YYYY-MM-DD", () => {
    for (const good of ["2026-11-13", "2028-02-29", "2026-12-31", "2000-01-01"]) {
      expect(refusalOf({ ...REHEARSAL, createdOn: good }), good).toBe(null);
    }
    for (const bad of [
      "2026-02-29",
      "2100-02-29",
      "2026-04-31",
      "2026-13-01",
      "2026-00-10",
      "2026-11-1",
      "26-11-13",
      "2026/11/13",
      "2026-11-13T00:00:00Z",
      "1999-12-31",
      20261113,
      null,
    ]) {
      expect(refusalOf({ ...REHEARSAL, createdOn: bad }), String(bad)).toBe(
        "created_on",
      );
    }
  });

  it("answers each refusal with fixed text that quotes nothing from the file", () => {
    const marker = "unique-marker-0001";
    const files: [unknown, string?][] = [
      [`${marker} not json`],
      [{ ...REHEARSAL, [marker]: 1 }],
      [{ ...REHEARSAL, slug: marker.toUpperCase() }],
      [{ ...REHEARSAL, displayName: `${marker}\n` }],
      [{ ...REHEARSAL, deployTarget: marker }],
      [REHEARSAL, `${marker}.json`],
    ];
    for (const [value, name] of files) {
      const result = parse(value, name);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toBe(PROJECT_ENTRY_REFUSALS[result.reason]);
        expect(result.message).not.toContain(marker);
      }
    }
  });
});

describe("the marker (unit: ADR 0118 appendix A)", () => {
  it("is exactly one object with schema 1", () => {
    expect(isProjectsMarker('{ "schema": 1 }\n')).toBe(true);
    expect(isProjectsMarker('{"schema":1}')).toBe(true);
    for (const bad of [
      "",
      "not json",
      "{}",
      '{"schema": 2}',
      '{"schema": "1"}',
      '{"schema": 1, "projects": []}',
      "[1]",
      "1",
    ]) {
      expect(isProjectsMarker(bad), bad).toBe(false);
    }
  });
});
