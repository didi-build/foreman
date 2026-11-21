// Seam: the New project form's public DNS lookup (unit with a fake resolver, ADR 0118 appendix C
// check 3, O-161). Any address or alias is in use; a name that does not exist, or has no record
// of a kind, is not; any other failure throws, so the form refuses rather than take a name as
// free. No network.
import { describe, expect, it } from "vitest";

import { createPublicNames, type DnsResolver } from "./public-names.ts";

const failure = (code: string) => Object.assign(new Error(code), { code });

function resolver(answers: {
  a?: unknown[] | Error;
  aaaa?: unknown[] | Error;
  cname?: unknown[] | Error;
}) {
  const asked: string[] = [];
  const answer = (kind: string, value: unknown[] | Error | undefined) => {
    asked.push(kind);
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value ?? []);
  };
  const fake: DnsResolver = {
    resolve4: (host) => answer(`A ${host}`, answers.a ?? failure("ENOTFOUND")),
    resolve6: (host) => answer(`AAAA ${host}`, answers.aaaa ?? failure("ENOTFOUND")),
    resolveCname: (host) =>
      answer(`CNAME ${host}`, answers.cname ?? failure("ENOTFOUND")),
  };
  return { fake, asked };
}

const HOST = "garden-notes.didi.build";

describe("the public DNS lookup (unit, O-161)", () => {
  it("finds nothing for a name that does not exist, asking for addresses and an alias", async () => {
    const r = resolver({});
    expect(await createPublicNames(r.fake).inUse(HOST)).toBe(false);
    expect(r.asked).toEqual([`A ${HOST}`, `AAAA ${HOST}`, `CNAME ${HOST}`]);
    const empty = resolver({
      a: failure("ENODATA"),
      aaaa: [],
      cname: failure("ENODATA"),
    });
    expect(await createPublicNames(empty.fake).inUse(HOST)).toBe(false);
  });

  it("finds a name with any address or alias in use", async () => {
    for (const answers of [
      { a: ["192.0.2.1"] },
      { aaaa: ["2001:db8::1"] },
      { cname: ["elsewhere.example.test"] },
    ]) {
      expect(await createPublicNames(resolver(answers).fake).inUse(HOST)).toBe(true);
    }
  });

  it("throws when a lookup does not answer, and refuses a host that is not a DNS name", async () => {
    for (const code of ["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED", "EREFUSED"]) {
      await expect(
        createPublicNames(resolver({ aaaa: failure(code) }).fake).inUse(HOST),
      ).rejects.toThrow(/did not answer/);
    }
    await expect(
      createPublicNames(resolver({ a: new Error("odd") }).fake).inUse(HOST),
    ).rejects.toThrow(/did not answer/);
    for (const host of [
      "",
      "Garden.didi.build",
      "garden notes.didi.build",
      "didi",
      "-x.didi.build",
    ]) {
      const r = resolver({});
      await expect(createPublicNames(r.fake).inUse(host), host).rejects.toThrow(
        /not a DNS name/,
      );
      expect(r.asked).toEqual([]);
    }
  });
});
