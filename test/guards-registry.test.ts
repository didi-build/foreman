// Seam: the guard registry against ADR 0105 and the real contracts (M2.2). The ADR's guard table is
// the list; the registry must hold exactly those names, and the contract files must validate
// against the registry with no problems.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { loadAllContractFiles } from "../src/adapters/contracts-file/load.ts";
import { validateContracts } from "../src/core/contracts.ts";
import { GUARD_NAMES, GUARDS } from "../src/core/guards/index.ts";

/** Guard names from the first column of ADR 0105's guard table. */
function adrGuardNames(): string[] {
  const adr = readFileSync("docs/decisions/0105-contracts-as-data.md", "utf8");
  const section = adr.split("### The guard list")[1]?.split("### ")[0] ?? "";
  return [...section.matchAll(/^\| `([a-z_]+)`/gm)].map((m) => m[1] as string);
}

describe("guard registry (unit: registry against ADR 0105 and the contract files)", () => {
  it("reads 31 names from the ADR table (24 from M2.2, two from M3.3, one from M3.5, one from D-231, one from D-258, two from D-266), so the comparison below is not empty", () => {
    expect(adrGuardNames()).toHaveLength(31);
  });

  it("holds exactly the ADR's guards", () => {
    expect([...GUARD_NAMES].sort()).toEqual(adrGuardNames().sort());
  });

  it("has a function for every name", () => {
    for (const name of GUARD_NAMES) expect(typeof GUARDS[name], name).toBe("function");
  });

  it("validates the real contracts of both machines with no problems, and every guard is used", () => {
    const { contracts, problems } = validateContracts(
      loadAllContractFiles("c".repeat(40)).raw,
      GUARD_NAMES,
    );
    expect(problems).toEqual([]);
    const used = new Set(contracts?.transitions.flatMap((t) => t.guards));
    expect([...GUARD_NAMES].filter((name) => !used.has(name))).toEqual([]);
  });
});
