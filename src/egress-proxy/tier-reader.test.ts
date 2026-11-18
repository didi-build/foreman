import { randomBytes } from "node:crypto";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import type { RequestTier } from "./served-tiers.ts";
import {
  readServedTier,
  TIER_READ_LIMITS,
  type TierReadLimits,
} from "./tier-reader.ts";

// Unit: reading the served tier from a response body, fed chunk by chunk as the proxy feeds it
// (D-423, O-151). No network: bodies are built here, compressed with Node's zlib.

const JSON_TYPE = { "content-type": "application/json" };
const EVENTS = { "content-type": "text/event-stream; charset=utf-8" };

/** Splits a body into pieces of `size` bytes, so lines, events and characters cross chunks. */
function pieces(body: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < body.length; i += size) out.push(body.subarray(i, i + size));
  return out;
}

/**
 * Feeds a body to a reader, finishes it, and returns its one report. A second finish, as the
 * proxy's `close` after `end` gives, must change nothing.
 */
async function read(
  headers: Record<string, string>,
  body: Buffer | string,
  options: { size?: number; complete?: boolean; limits?: Partial<TierReadLimits> } = {},
): Promise<RequestTier> {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  const reports: RequestTier[] = [];
  await new Promise<void>((resolve) => {
    const reader = readServedTier(
      headers,
      (tier) => {
        reports.push(tier);
        resolve();
      },
      { ...TIER_READ_LIMITS, ...options.limits },
    );
    for (const chunk of pieces(bytes, options.size ?? 7)) reader.push(chunk);
    reader.finish(options.complete ?? true);
    reader.finish(false);
    reader.push(Buffer.from('data: {"service_tier":"priority"}\n\n'));
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(reports).toHaveLength(1);
  return reports[0] as RequestTier;
}

const completion = (fields: Record<string, unknown>) =>
  JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    choices: [
      { index: 0, message: { role: "assistant", content: "Done. Café, naïve, 完成." } },
    ],
    ...fields,
  });

/** One streamed chunk's event, with or without a tier. */
const chunk = (tier?: unknown, content = "Hé") =>
  `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content } }],
    ...(tier === undefined ? {} : { service_tier: tier }),
  })}\n\n`;
const stream = (...tiers: unknown[]) =>
  `: keep-alive\n\n${tiers.map((tier) => chunk(tier)).join("")}data: [DONE]\n\n`;

describe("a JSON body (unit: D-423)", () => {
  it.each([
    ["default", "standard"],
    ["flex", "flex"],
    ["priority", "priority"],
    ["scale", "unknown"],
    [null, "unknown"],
  ])("reads a top-level service_tier %j as %s", async (value, expected) => {
    expect(await read(JSON_TYPE, completion({ service_tier: value }))).toBe(expected);
  });

  it("is unknown without the field", async () => {
    expect(await read(JSON_TYPE, completion({}))).toBe("unknown");
  });

  it("reads only the top level, never a nested field or the model's own text", async () => {
    expect(await read(JSON_TYPE, completion({ usage: { service_tier: "flex" } }))).toBe(
      "unknown",
    );
    const echoed = JSON.stringify({
      choices: [
        { message: { content: '{"service_tier":"flex"} "service_tier":"flex"' } },
      ],
      service_tier: "default",
    });
    expect(await read(JSON_TYPE, echoed)).toBe("standard");
  });

  it("reads JSON media types with parameters and +json types", async () => {
    const body = completion({ service_tier: "flex" });
    expect(
      await read({ "content-type": "Application/JSON; charset=utf-8" }, body),
    ).toBe("flex");
    expect(await read({ "content-type": "application/vnd.example+json" }, body)).toBe(
      "flex",
    );
  });

  it("splits anywhere, a byte at a time included", async () => {
    expect(
      await read(JSON_TYPE, completion({ service_tier: "flex" }), { size: 1 }),
    ).toBe("flex");
  });

  it.each([
    ["cut short", completion({ service_tier: "flex" }), { complete: false }],
    ["malformed", '{"service_tier":"flex",', {}],
    ["empty", "", {}],
    ["a JSON list", '[{"service_tier":"flex"}]', {}],
    [
      "past its bound",
      completion({ service_tier: "flex" }),
      { limits: { maxJsonBytes: 64 } },
    ],
  ])("is unknown when %s", async (_label, body, options) => {
    expect(await read(JSON_TYPE, body, options)).toBe("unknown");
  });
});

describe("a server-sent event stream (unit: D-423)", () => {
  it("reads a tier that every chunk names", async () => {
    expect(await read(EVENTS, stream("flex", "flex", "flex"))).toBe("flex");
  });

  it("reads a tier that only the last chunk names", async () => {
    expect(await read(EVENTS, stream(undefined, undefined, "default"))).toBe(
      "standard",
    );
  });

  it("is mixed when the chunks name different tiers", async () => {
    expect(await read(EVENTS, stream("flex", "default"))).toBe("mixed");
  });

  it("is unknown when no chunk names a tier, or only values that are not one", async () => {
    expect(await read(EVENTS, stream(undefined, undefined))).toBe("unknown");
    expect(await read(EVENTS, stream("auto", "scale"))).toBe("unknown");
  });

  it("ignores values that are not a tier beside one that is", async () => {
    expect(await read(EVENTS, stream("auto", "flex"))).toBe("flex");
  });

  it("splits anywhere, through multibyte characters, a byte at a time included", async () => {
    const body = `${chunk(undefined, "日本語 ✓")}${chunk("flex", "é")}`;
    expect(await read(EVENTS, body, { size: 1 })).toBe("flex");
    expect(await read(EVENTS, body, { size: 5 })).toBe("flex");
  });

  it("reads carriage return line endings, data with no space, and comments and other fields", async () => {
    const body =
      ': comment\r\nevent: message\r\nid: 7\r\nretry: 1000\r\ndata:{"service_tier":"flex"}\r\n\r\n';
    expect(await read(EVENTS, body)).toBe("flex");
    // Each blank line ends its event, so two events are read apart, not joined.
    expect(await read(EVENTS, `${body}${body}`)).toBe("flex");
  });

  it("joins the data lines of one event", async () => {
    expect(await read(EVENTS, 'data: {"service_tier":\ndata: "default"}\n\n')).toBe(
      "standard",
    );
  });

  it("never takes the model's own text for the field", async () => {
    const body = chunk(undefined, '"service_tier":"default"') + chunk("flex");
    expect(await read(EVENTS, body)).toBe("flex");
    expect(await read(EVENTS, chunk(undefined, 'data: {"service_tier":"flex"}'))).toBe(
      "unknown",
    );
  });

  it("reads the last event of a stream that ends without a blank line", async () => {
    expect(await read(EVENTS, 'data: {"service_tier":"flex"}')).toBe("flex");
  });

  it("keeps what a stream cut short gave, and drops its unfinished event", async () => {
    expect(
      await read(EVENTS, `${chunk("flex")}data: {"service_tier":"default"}`, {
        complete: false,
      }),
    ).toBe("flex");
    expect(await read(EVENTS, chunk("flex").slice(0, 20), { complete: false })).toBe(
      "unknown",
    );
  });

  it("skips only the event of a line past its bound", async () => {
    const long = chunk("default", "x".repeat(400));
    const limits = { maxEventBytes: 200 };
    expect(await read(EVENTS, `${long}${chunk("flex")}`, { limits })).toBe("flex");
    expect(await read(EVENTS, `${long}${chunk("flex")}`, { limits, size: 4096 })).toBe(
      "flex",
    );
    expect(await read(EVENTS, long, { limits })).toBe("unknown");
    // The event's other data line alone would name a tier; with its long line it is not JSON.
    const partly = `data: {"service_tier":"default"}\ndata: ${"x".repeat(400)}\n\n`;
    expect(await read(EVENTS, `${partly}${chunk("flex")}`, { limits })).toBe("flex");
  });

  it("skips an event whose data lines together pass the bound", async () => {
    const many = `${'data: {"service_tier":"default",\n'}${'data: "pad": 0,\n'.repeat(20)}data: "end": 1}\n\n`;
    const limits = { maxEventBytes: 200 };
    expect(await read(EVENTS, `${many}${chunk("flex")}`, { limits })).toBe("flex");
  });
});

describe("a compressed body (unit: D-423)", () => {
  const flexJson = Buffer.from(completion({ service_tier: "flex" }));
  const flexStream = Buffer.from(stream(undefined, "flex", "flex"));

  it.each([
    ["gzip", gzipSync(flexJson)],
    ["x-gzip", gzipSync(flexJson)],
    ["GZIP", gzipSync(flexJson)],
    ["deflate", deflateSync(flexJson)],
    ["br", brotliCompressSync(flexJson)],
    ["identity, gzip", gzipSync(flexJson)],
  ])("reads a JSON body with content-encoding %s", async (encoding, body) => {
    expect(await read({ ...JSON_TYPE, "content-encoding": encoding }, body)).toBe(
      "flex",
    );
  });

  it.each([
    ["gzip", gzipSync(flexStream)],
    ["deflate", deflateSync(flexStream)],
    ["br", brotliCompressSync(flexStream)],
  ])("reads an event stream with content-encoding %s", async (encoding, body) => {
    expect(
      await read({ ...EVENTS, "content-encoding": encoding }, body, { size: 3 }),
    ).toBe("flex");
  });

  it.each([
    ["is corrupt", "gzip", Buffer.from("not gzip at all, but the proxy passes it on")],
    ["is cut off", "gzip", gzipSync(flexJson).subarray(0, 30)],
    // Even when the first coding alone would decode it.
    ["names two codings", "gzip, br", gzipSync(flexJson)],
    ["uses zstd", "zstd", Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0])],
    ["uses compress", "compress", Buffer.from("anything")],
  ])("is unknown when the body %s", async (_label, encoding, body) => {
    expect(await read({ ...JSON_TYPE, "content-encoding": encoding }, body)).toBe(
      "unknown",
    );
  });

  it("is unknown past the bound on decompressed bytes, however small the input", async () => {
    // Comment lines, then an event that names Flex: read whole, it would count as Flex.
    const padding = ": pad\n".repeat((4 * 1024 * 1024) / 6);
    const bomb = gzipSync(Buffer.from(`${padding}${chunk("flex")}`));
    expect(bomb.length).toBeLessThan(32 * 1024);
    expect(
      await read({ ...EVENTS, "content-encoding": "gzip" }, bomb, { size: 1024 }),
    ).toBe("flex");
    expect(
      await read({ ...EVENTS, "content-encoding": "gzip" }, bomb, {
        size: 1024,
        limits: { maxDecompressedBytes: 1024 * 1024 },
      }),
    ).toBe("unknown");
  });

  it("is unknown when more input waits for the decompressor than its bound", async () => {
    // Random text compresses badly, so the compressed body is far larger than the bound.
    const events = Array.from({ length: 100 }, () =>
      chunk("flex", randomBytes(256).toString("hex")),
    );
    const big = gzipSync(Buffer.from(events.join("")));
    expect(big.length).toBeGreaterThan(8 * 2048);
    expect(
      await read({ ...EVENTS, "content-encoding": "gzip" }, big, {
        size: 512,
        limits: { maxPendingCompressedBytes: 2048 },
      }),
    ).toBe("unknown");
  });
});

describe("what is not read (unit: D-423)", () => {
  it.each([
    ["text/plain", { "content-type": "text/plain" }],
    ["application/octet-stream", { "content-type": "application/octet-stream" }],
    ["no content type", {}],
  ])("is unknown for %s", async (_label, headers) => {
    expect(await read(headers, completion({ service_tier: "flex" }))).toBe("unknown");
  });
});

describe("the reader's contract with the proxy (unit: D-423)", () => {
  it("never throws out of push or finish, even when its report throws", () => {
    const reader = readServedTier(JSON_TYPE, () => {
      throw new Error("a broken counter");
    });
    expect(() => {
      reader.push(Buffer.from(completion({ service_tier: "flex" })));
      reader.finish(true);
    }).not.toThrow();
  });

  it("reports once, at the first finish, and ignores what comes after", async () => {
    const reports: RequestTier[] = [];
    const reader = readServedTier(EVENTS, (tier) => reports.push(tier));
    reader.push(Buffer.from(chunk("flex")));
    reader.finish(false);
    reader.push(Buffer.from(chunk("default")));
    reader.finish(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reports).toEqual(["flex"]);
  });

  it("never changes the chunks it is given", async () => {
    const body = gzipSync(flexBody());
    const before = Buffer.from(body);
    await read({ ...EVENTS, "content-encoding": "gzip" }, body, { size: 9 });
    expect(body.equals(before)).toBe(true);
    const plain = flexBody();
    const plainBefore = Buffer.from(plain);
    await read(EVENTS, plain, { size: 9 });
    expect(plain.equals(plainBefore)).toBe(true);
  });

  it.each([
    ["a JSON body", JSON_TYPE, Buffer.from(completion({ service_tier: "flex" }))],
    ["an event stream", EVENTS, flexBody()],
    ["a gzip body", { ...EVENTS, "content-encoding": "gzip" }, gzipSync(flexBody())],
  ])(
    "keeps its own copy of %s, so a chunk's memory reused after push changes nothing",
    async (_label, headers: Record<string, string>, body) => {
      const reports: RequestTier[] = [];
      const reader = readServedTier(headers, (tier) => reports.push(tier));
      // One buffer for every chunk, overwritten once each chunk is pushed, as a pool would.
      const shared = Buffer.alloc(16);
      for (const piece of pieces(body, 16)) {
        piece.copy(shared);
        reader.push(shared.subarray(0, piece.length));
        shared.fill(0x7b);
      }
      reader.finish(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(reports).toEqual(["flex"]);
    },
  );
});

function flexBody(): Buffer {
  return Buffer.from(stream("flex", "flex"));
}
