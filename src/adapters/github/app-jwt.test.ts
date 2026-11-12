// Seam: a GitHub App's signed token (unit, D-365, D-368, O-125). Keys are generated when the test
// runs (test/github-app-key-fixture.ts), never committed. With a fixed clock: the RS256 signature
// verifies with the App's public key and with no other, the header and the claims are exactly
// GitHub's (`iat` 60 seconds back, `exp` 9 minutes on, `iss` the App ID); PKCS#1 and PKCS#8, CRLF
// and surrounding whitespace are taken; a key that is not a PEM private key or not RSA, and an App
// id that is not a positive whole number, are refused with fixed text naming the App and no part
// of the key. No network.
import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { pemLines, readJwt, testAppKey } from "../../../test/github-app-key-fixture.ts";
import {
  createGitHubAppJwt,
  GitHubAppJwtError,
  parseGitHubId,
  type GitHubAppRole,
} from "./app-jwt.ts";

const APP_ID = 123456;
/** 2026-11-12T10:00:00.750Z: the claims use whole seconds, rounded down. */
const NOW = Date.UTC(2026, 10, 12, 10, 0, 0, 750);
const NOW_SECONDS = Math.floor(NOW / 1000);
const fixedClock = (ms = NOW) => ({ now: () => new Date(ms) });

const KEY = testAppKey();
const OTHER = testAppKey();

function signer(privateKeyPem: string, role: GitHubAppRole = "runner", appId = APP_ID) {
  return createGitHubAppJwt({ role, appId, privateKeyPem, clock: fixedClock() });
}

/** The error a call throws, or a failure when it throws none. */
function thrown(call: () => unknown): Error {
  try {
    call();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a refusal");
}

describe("a GitHub App's JWT (unit, D-365, D-368, O-125)", () => {
  it("is RS256 over exactly GitHub's header and claims, verified by the App's public key only", async () => {
    const jwt = readJwt(await signer(KEY.privateKeyPem).sign());
    expect(jwt.header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(jwt.claims).toEqual({
      iat: NOW_SECONDS - 60,
      exp: NOW_SECONDS + 9 * 60,
      iss: String(APP_ID),
    });
    expect(jwt.verifiedBy(KEY.publicKey)).toBe(true);
    expect(jwt.verifiedBy(OTHER.publicKey)).toBe(false);
  });

  it("writes the header and claims in that order, as compact JSON", async () => {
    const [header, claims] = (await signer(KEY.privateKeyPem).sign()).split(".");
    expect(Buffer.from(header ?? "", "base64url").toString()).toBe(
      '{"alg":"RS256","typ":"JWT"}',
    );
    expect(Buffer.from(claims ?? "", "base64url").toString()).toBe(
      `{"iat":${NOW_SECONDS - 60},"exp":${NOW_SECONDS + 540},"iss":"${APP_ID}"}`,
    );
  });

  it("makes a new JWT at the clock's time on each call, within GitHub's 10 minutes", async () => {
    let now = NOW;
    const jwt = createGitHubAppJwt({
      role: "developer",
      appId: APP_ID,
      privateKeyPem: KEY.privateKeyPem,
      clock: { now: () => new Date(now) },
    });
    const first = await jwt.sign();
    now += 61_000;
    const second = readJwt(await jwt.sign());
    expect(second.claims).toMatchObject({ iat: NOW_SECONDS + 1 });
    expect(second.verifiedBy(KEY.publicKey)).toBe(true);
    expect(await jwt.sign()).not.toBe(first);
    const { iat, exp } = second.claims as { iat: number; exp: number };
    expect(exp - iat).toBeLessThanOrEqual(10 * 60);
  });

  it("takes PKCS#8 too, and the PEM with CRLF or CR line ends and surrounding whitespace", async () => {
    const pkcs8 = testAppKey("pkcs8");
    expect(pkcs8.privateKeyPem).toMatch(/^-----BEGIN PRIVATE/);
    expect(KEY.privateKeyPem).toMatch(/^-----BEGIN RSA PRIVATE/);
    for (const [pem, publicKey] of [
      [pkcs8.privateKeyPem, pkcs8.publicKey],
      [KEY.privateKeyPem.replace(/\n/g, "\r\n"), KEY.publicKey],
      // OpenSSL reads CRLF itself but not a lone CR, which is made a line end here.
      [KEY.privateKeyPem.replace(/\n/g, "\r"), KEY.publicKey],
      [`\n  ${KEY.privateKeyPem}\n\n`, KEY.publicKey],
      [`${KEY.privateKeyPem.trimEnd()}`, KEY.publicKey],
    ] as const) {
      expect(readJwt(await signer(pem).sign()).verifiedBy(publicKey)).toBe(true);
    }
  });

  it("refuses what is not a PEM private key, naming the App and never the key", () => {
    const { publicKey } = KEY;
    const encrypted = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey.export({
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: "made-up-passphrase-for-this-test",
    });
    const body = KEY.privateKeyPem.split("\n");
    const notKeys = [
      "",
      "   \n",
      "not a key",
      KEY.privateKeyPem.slice(0, 200),
      // Its body damaged: one base64 line dropped.
      [...body.slice(0, 3), ...body.slice(4)].join("\n"),
      publicKey.export({ type: "spki", format: "pem" }).toString(),
      encrypted.toString(),
      // A string of the key's body without its PEM lines.
      pemLines(KEY.privateKeyPem).join(""),
    ];
    for (const pem of notKeys) {
      const error = thrown(() => signer(pem, "qa"));
      expect(error, pem.slice(0, 40)).toBeInstanceOf(GitHubAppJwtError);
      expect(error.message).toBe("The QA App's private key is not a PEM private key");
      expect(error.cause).toBeUndefined();
    }
  });

  it("refuses a key that is not RSA: Ed25519, EC and RSA-PSS", () => {
    const pkcs8 = (type: "ed25519" | "rsa-pss") =>
      (type === "ed25519"
        ? generateKeyPairSync("ed25519")
        : generateKeyPairSync("rsa-pss", { modulusLength: 2048 })
      ).privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString();
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "sec1", format: "pem" })
      .toString();
    for (const pem of [pkcs8("ed25519"), pkcs8("rsa-pss"), ec]) {
      const error = thrown(() => signer(pem, "designer"));
      expect(error).toBeInstanceOf(GitHubAppJwtError);
      expect(error.message).toBe("The Designer App's private key is not an RSA key");
      for (const line of pemLines(pem)) expect(error.message).not.toContain(line);
    }
  });

  it("refuses an App id that is not a positive whole number, before the key is read", () => {
    for (const appId of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 53]) {
      const error = thrown(() => signer("not even read", "developer", appId));
      expect(error, String(appId)).toBeInstanceOf(GitHubAppJwtError);
      expect(error.message).toBe(
        "The Developer App's id is not a positive whole number",
      );
    }
  });

  it("refuses to sign at a clock that is not a time", async () => {
    const jwt = createGitHubAppJwt({
      role: "runner",
      appId: APP_ID,
      privateKeyPem: KEY.privateKeyPem,
      clock: { now: () => new Date(Number.NaN) },
    });
    await expect(jwt.sign()).rejects.toThrow(
      new GitHubAppJwtError("The runner App's token has no valid time to sign at"),
    );
  });

  it("names no part of the key or of a JWT in any refusal", async () => {
    const jwt = await signer(KEY.privateKeyPem).sign();
    const secrets = [...pemLines(KEY.privateKeyPem), ...jwt.split(".")];
    const refusals = [
      thrown(() => signer(KEY.privateKeyPem.slice(0, 300))),
      thrown(() => signer(`${KEY.privateKeyPem}`, "runner", 0)),
      thrown(() =>
        signer(
          generateKeyPairSync("ed25519")
            .privateKey.export({ type: "pkcs8", format: "pem" })
            .toString(),
        ),
      ),
    ];
    for (const error of refusals) {
      for (const secret of secrets) {
        expect(error.message).not.toContain(secret);
        expect(String(error.stack)).not.toContain(secret);
      }
    }
  });
});

describe("a GitHub id as Didi stores it (unit, O-125)", () => {
  it("reads decimal digits, with surrounding whitespace, and nothing else", () => {
    expect(parseGitHubId("123456")).toBe(123456);
    expect(parseGitHubId(" 42\n")).toBe(42);
    expect(parseGitHubId("007")).toBe(7);
    for (const text of ["", " ", "12a", "1e3", "0x10", "-5", "1.5", "1 2", "١٢"]) {
      expect(parseGitHubId(text), text).toBeNaN();
    }
    // Past 16 digits is not read; 16 digits past the safe range is refused by the signer.
    expect(parseGitHubId("1".repeat(17))).toBeNaN();
    expect(Number.isSafeInteger(parseGitHubId("9".repeat(16)))).toBe(false);
  });
});
