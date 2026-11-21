// A public DNS lookup for the New project form's check (src/core/new-project.ts `PublicNames`,
// ADR 0118 appendix C check 3, O-161): before the project's file exists, `<slug>.didi.build` must
// answer nothing, so a name the zone already uses for something else is never taken.
//
// The lookup asks the host's resolver (Node's `node:dns/promises` `Resolver`, the system's
// servers) for the name's IPv4 and IPv6 addresses and its alias (A, AAAA and CNAME). Any record
// means the name is in use. An answer that the name does not exist (`ENOTFOUND`) or has no record
// of that kind (`ENODATA`) means none of that kind. Any other failure (a timeout, a refused or
// failed query) throws, and the form refuses: a name is never taken as free on a lookup that did
// not answer. Nothing here logs, and the answers are never returned.
import { Resolver } from "node:dns/promises";

import type { PublicNames } from "../../core/new-project.ts";

/** The three lookups, as Node's resolver makes them; tests pass a fake. */
export interface DnsResolver {
  resolve4(host: string): Promise<unknown[]>;
  resolve6(host: string): Promise<unknown[]>;
  resolveCname(host: string): Promise<unknown[]>;
}

/** The codes that mean the name, or that kind of record, does not exist. */
const ABSENT = new Set(["ENOTFOUND", "ENODATA"]);

/** A lower-case DNS name of plain labels. */
const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A lookup that did not answer. Names nothing but the step. */
export class PublicNameLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicNameLookupError";
  }
}

export function createPublicNames(
  resolver: DnsResolver = new Resolver({ timeout: 5_000, tries: 2 }),
): PublicNames {
  return {
    async inUse(host) {
      if (!HOST.test(host)) throw new PublicNameLookupError("not a DNS name");
      const kinds = [
        (h: string) => resolver.resolve4(h),
        (h: string) => resolver.resolve6(h),
        (h: string) => resolver.resolveCname(h),
      ];
      for (const lookup of kinds) {
        let answers: unknown[];
        try {
          answers = await lookup(host);
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (typeof code === "string" && ABSENT.has(code)) continue;
          throw new PublicNameLookupError("the public DNS lookup did not answer");
        }
        if (Array.isArray(answers) && answers.length > 0) return true;
      }
      return false;
    },
  };
}
