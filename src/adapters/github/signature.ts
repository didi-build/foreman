// Webhook signatures (ADR 0113 section 2): HMAC-SHA256 over the raw bytes, compared in constant
// time. Never logs or returns the secret or the expected signature.
import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

/** The `X-Hub-Signature-256` value GitHub sends for `body`. */
export function signWebhook(secret: string, body: Buffer | string): string {
  return PREFIX + createHmac("sha256", secret).update(body).digest("hex");
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (secret === "" || signatureHeader === undefined) return false;
  const expected = Buffer.from(signWebhook(secret, rawBody), "utf8");
  const given = Buffer.from(signatureHeader, "utf8");
  // timingSafeEqual needs equal lengths; a length mismatch is a wrong signature either way.
  return given.length === expected.length && timingSafeEqual(given, expected);
}
