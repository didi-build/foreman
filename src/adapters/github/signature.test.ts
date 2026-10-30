import { describe, expect, it } from "vitest";

import { signWebhook, verifyWebhookSignature } from "./signature.ts";

const SECRET = "test-only-webhook-secret";
const BODY = Buffer.from('{"action":"opened"}');

describe("webhook signatures (unit: GitHub adapter, ADR 0113 section 2)", () => {
  it("accepts GitHub's HMAC-SHA256 of the exact raw bytes", () => {
    expect(verifyWebhookSignature(SECRET, BODY, signWebhook(SECRET, BODY))).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["another secret's", signWebhook("another-secret", BODY)],
    ["another body's", signWebhook(SECRET, '{"action":"closed"}')],
    ["unprefixed", signWebhook(SECRET, BODY).slice("sha256=".length)],
    ["sha1", `sha1=${"0".repeat(40)}`],
    ["truncated", signWebhook(SECRET, BODY).slice(0, -1)],
  ])("rejects a %s signature", (_label, header) => {
    expect(verifyWebhookSignature(SECRET, BODY, header)).toBe(false);
  });

  it("rejects every signature when no secret is configured", () => {
    expect(verifyWebhookSignature("", BODY, signWebhook("", BODY))).toBe(false);
  });

  it("checks the bytes, so a re-serialized body does not pass", () => {
    const spaced = Buffer.from('{ "action": "opened" }');
    expect(verifyWebhookSignature(SECRET, spaced, signWebhook(SECRET, BODY))).toBe(
      false,
    );
  });
});
