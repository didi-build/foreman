// A GitHub App's signed token (a JWT), made from the App's private key (D-365, D-368, D-370,
// O-125). The runner signs one with each App's own key to ask GitHub for that App's installation
// tokens (./narrow-tokens.ts, ./installation-tokens.ts). GitHub's "Generating a JSON Web Token
// (JWT) for a GitHub App": RS256, `iat` 60 seconds in the past against clock drift, `exp` no more
// than 10 minutes after it, and `iss` the App's client ID or its App ID. Here `iss` is the App ID
// Didi stores beside the key (runbook step 15), and `exp` is 9 minutes from now, inside GitHub's
// cap. Node's `node:crypto` only.
//
// The key and the App id are checked once, when the signer is made: the key must be a PEM private
// key, PKCS#1 as GitHub generates it or PKCS#8, with surrounding whitespace and CRLF or CR line
// ends allowed, and RSA; the id must be a positive whole number. Each refusal is fixed text naming the
// App, never the key, a signed value or any part of them. A new JWT is made for each call and is
// never kept or logged. Nothing here logs.
import { createPrivateKey, sign, type KeyObject } from "node:crypto";

import type { Clock } from "../../core/library.ts";
import type { GitHubAppJwt } from "./narrow-tokens.ts";

/** The four GitHub Apps (D-156, D-365), each with its own key and id. */
export type GitHubAppRole = "runner" | "developer" | "designer" | "qa";

/** How each App is named in an error. */
export const GITHUB_APP_NAMES: Readonly<Record<GitHubAppRole, string>> = {
  runner: "runner App",
  developer: "Developer App",
  designer: "Designer App",
  qa: "QA App",
};

/** `iat` is this far in the past, as GitHub advises against clock drift. */
export const JWT_BACKDATE_SECONDS = 60;
/** `exp` is this far in the future; GitHub refuses more than 10 minutes. */
export const JWT_LIFETIME_SECONDS = 9 * 60;

/** A key or an App id the signer cannot use. Names the App, never the key or a token. */
export class GitHubAppJwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAppJwtError";
  }
}

export interface GitHubAppJwtOptions {
  /** The App the key belongs to, for the errors. */
  role: GitHubAppRole;
  /** The App's id, from its page (D-368). */
  appId: number;
  /** The App's private key in PEM, as GitHub generated it. Never logged. */
  privateKeyPem: string;
  clock: Clock;
}

/**
 * A GitHub id as Didi stores it in a plain variable: decimal digits, with surrounding whitespace
 * allowed. Anything else is `NaN`, which the signer and the mint refuse.
 */
export function parseGitHubId(text: string): number {
  const trimmed = typeof text === "string" ? text.trim() : "";
  return /^[0-9]{1,16}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** The App's key, checked: a PEM private key, RSA. */
function rsaPrivateKey(pem: string, app: string): KeyObject {
  const text = typeof pem === "string" ? pem.replace(/\r\n?/g, "\n").trim() : "";
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: text, format: "pem" });
  } catch {
    throw new GitHubAppJwtError(`The ${app}'s private key is not a PEM private key`);
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new GitHubAppJwtError(`The ${app}'s private key is not an RSA key`);
  }
  return key;
}

const HEADER = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
  "base64url",
);

/** A signer for one App: checks its id and key now, and makes a new JWT on each `sign`. */
export function createGitHubAppJwt({
  role,
  appId,
  privateKeyPem,
  clock,
}: GitHubAppJwtOptions): GitHubAppJwt {
  const app = GITHUB_APP_NAMES[role];
  if (!Number.isSafeInteger(appId) || appId <= 0) {
    throw new GitHubAppJwtError(`The ${app}'s id is not a positive whole number`);
  }
  const key = rsaPrivateKey(privateKeyPem, app);
  const unsigned = () => {
    const now = Math.floor(clock.now().getTime() / 1000);
    if (!Number.isSafeInteger(now)) {
      throw new GitHubAppJwtError(`The ${app}'s token has no valid time to sign at`);
    }
    const claims = {
      iat: now - JWT_BACKDATE_SECONDS,
      exp: now + JWT_LIFETIME_SECONDS,
      iss: String(appId),
    };
    return `${HEADER}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  };
  return {
    async sign() {
      const input = unsigned();
      let signature: Buffer;
      try {
        signature = sign("sha256", Buffer.from(input), key);
      } catch {
        throw new GitHubAppJwtError(`The ${app}'s token could not be signed`);
      }
      return `${input}.${signature.toString("base64url")}`;
    },
  };
}
