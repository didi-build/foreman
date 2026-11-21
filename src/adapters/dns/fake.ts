// A fake of the public DNS lookup (src/core/new-project.ts `PublicNames`, O-161), for the core
// and flow tests. Synthetic names only; nothing reaches a resolver.
import type { PublicNames } from "../../core/new-project.ts";

export interface FakePublicNames extends PublicNames {
  /** The names a lookup finds. */
  inUseNames: Set<string>;
  /** Makes every lookup throw, as a lookup that did not answer. */
  fail: boolean;
  /** Each name looked up, in order. */
  lookups: string[];
}

export function createFakePublicNames(): FakePublicNames {
  const fake: FakePublicNames = {
    inUseNames: new Set(),
    fail: false,
    lookups: [],
    async inUse(host) {
      fake.lookups.push(host);
      if (fake.fail) throw new Error("the fake lookup did not answer");
      return fake.inUseNames.has(host);
    },
  };
  return fake;
}
