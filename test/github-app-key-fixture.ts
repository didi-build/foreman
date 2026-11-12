// Test-only GitHub App keys and a JWT reader (O-125). Every key is generated when a test runs and
// lives only in memory: no key, real or made up, is ever committed as a file or a literal.
import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";

export interface TestAppKey {
  /** The private key in PEM, as GitHub generates an App's: PKCS#1 unless asked for PKCS#8. */
  privateKeyPem: string;
  publicKey: KeyObject;
}

/** A new 2048-bit RSA key for one test App. */
export function testAppKey(format: "pkcs1" | "pkcs8" = "pkcs1"): TestAppKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: format, format: "pem" }).toString(),
    publicKey,
  };
}

export interface ReadJwt {
  header: unknown;
  claims: unknown;
  /** Whether the RS256 signature verifies with the given public key. */
  verifiedBy(publicKey: KeyObject): boolean;
}

const part = (text: string): unknown =>
  JSON.parse(Buffer.from(text, "base64url").toString("utf8"));

/** Reads a JWT's three parts; throws on one that is not three base64url parts of JSON. */
export function readJwt(jwt: string): ReadJwt {
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) {
    throw new Error("not a JWT of three base64url parts");
  }
  const [header, claims, signature] = parts as [string, string, string];
  return {
    header: part(header),
    claims: part(claims),
    verifiedBy: (publicKey) =>
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
  };
}

/** Every line of a PEM's body, for checking that none of it is ever repeated. */
export function pemLines(pem: string): string[] {
  return pem
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("-----"));
}
