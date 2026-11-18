// Reading the tier a model provider served from its response body (D-423, ADR 0114 section 8,
// O-151), for the proxy's tally (./served-tiers.ts). The proxy passes each response through
// unchanged (./proxy.ts) and hands this reader each chunk only after the chunk was passed on to
// the agent. The reader keeps its own copy of what it needs, never writes to the response, never
// throws and reports once, so a body it cannot read is counted `unknown` and the agent gets the
// same bytes, headers and timing either way. Nothing it reads is logged or kept after the report.
//
// What it reads: the top-level `service_tier` of a JSON body, or of each server-sent event of a
// stream. A chunk may carry the field or not: the chunks that name a tier decide, and chunks that
// name different tiers make the request `mixed`. Only the parsed top-level field counts, so text
// the model wrote that looks like the field does not. A body compressed with gzip, deflate or br
// is read from a decompressed copy. Any other encoding, more than one, or a body that is neither
// JSON nor an event stream is not read.
//
// Bounds, each per response: a JSON body is kept up to 1 MiB; a stream's current line and its
// current event up to 1 MiB each; compressed input waiting for the decompressor up to 1 MiB; and
// at most 64 MiB is decompressed. Past a bound the request is `unknown`, except that an over-long
// line skips only its own event. Decompression runs on Node's zlib thread pool, and Node's br
// decoder refuses the large-window form, so its window is at most 16 MiB. The proxy reads at most
// `MAX_CONCURRENT_TIER_READS` responses at once and counts any others `unknown`.
import type { IncomingHttpHeaders } from "node:http";
import type { Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import { tierOf, type RequestTier, type TallyTier } from "./served-tiers.ts";

export interface TierReadLimits {
  maxJsonBytes: number;
  maxEventBytes: number;
  maxPendingCompressedBytes: number;
  maxDecompressedBytes: number;
}

const MIB = 1024 * 1024;
export const TIER_READ_LIMITS: TierReadLimits = {
  maxJsonBytes: MIB,
  maxEventBytes: MIB,
  maxPendingCompressedBytes: MIB,
  maxDecompressedBytes: 64 * MIB,
};

/** The most responses the proxy reads at once; any others are counted `unknown`. */
export const MAX_CONCURRENT_TIER_READS = 4;

export interface TierReader {
  /** A chunk of the response body, given after it was passed on. Never throws. */
  push(chunk: Buffer): void;
  /** The body ended (`complete`) or was cut short. Only the first call counts. Never throws. */
  finish(complete: boolean): void;
}

/** What a body reads as, from what has been pushed. Throws only on a bug; the caller catches. */
interface Scanner {
  push(chunk: Buffer): void;
  result(complete: boolean): RequestTier;
}

interface InnerReader {
  push(chunk: Buffer): void;
  finish(complete: boolean): void;
  /** Release what the reader holds, without reporting. */
  stop(): void;
}

type Encoding = "identity" | "gzip" | "deflate" | "br";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A reader for one served response. `report` is called once with what the body read as, when it
 * has been read (for a compressed body, after the decompressor has finished).
 */
export function readServedTier(
  headers: IncomingHttpHeaders,
  report: (tier: RequestTier) => void,
  limits: TierReadLimits = TIER_READ_LIMITS,
): TierReader {
  let settled = false;
  let finished = false;
  const settle = (tier: RequestTier): void => {
    if (settled) return;
    settled = true;
    try {
      report(tier);
    } catch {
      // Counting is best effort. The response is never touched.
    }
  };
  let inner: InnerReader | undefined;
  try {
    inner = createReader(headers, settle, limits);
  } catch {
    inner = undefined;
  }
  const fail = (): void => {
    try {
      inner?.stop();
    } catch {
      // Already released.
    }
    settle("unknown");
  };
  return {
    push(chunk) {
      if (settled || finished || inner === undefined) return;
      try {
        inner.push(chunk);
      } catch {
        fail();
      }
    },
    finish(complete) {
      if (finished) return;
      finished = true;
      if (settled) return;
      if (inner === undefined) {
        settle("unknown");
        return;
      }
      try {
        inner.finish(complete);
      } catch {
        fail();
      }
    },
  };
}

function createReader(
  headers: IncomingHttpHeaders,
  settle: (tier: RequestTier) => void,
  limits: TierReadLimits,
): InnerReader {
  const kind = bodyKind(headers["content-type"]);
  const encoding = encodingOf(headers["content-encoding"]);
  if (kind === null || encoding === null) {
    return { push: () => {}, finish: () => settle("unknown"), stop: () => {} };
  }
  const scanner = kind === "json" ? jsonScanner(limits) : eventScanner(limits);
  if (encoding === "identity") {
    return {
      push: (chunk) => scanner.push(chunk),
      finish: (complete) => settle(scanner.result(complete)),
      stop: () => {},
    };
  }
  return decompressing(encoding, scanner, settle, limits);
}

/** JSON or an event stream, by the media type alone; anything else is not read. */
function bodyKind(contentType: string | undefined): "json" | "events" | null {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "text/event-stream") return "events";
  if (type === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(type)) {
    return "json";
  }
  return null;
}

/** The one content coding of a body, `identity` for none, or null when it is not read. */
function encodingOf(value: string | undefined): Encoding | null {
  const codings = (value ?? "")
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "" && coding !== "identity");
  if (codings.length === 0) return "identity";
  if (codings.length > 1) return null;
  const [only] = codings;
  if (only === "gzip" || only === "x-gzip") return "gzip";
  if (only === "deflate" || only === "br") return only;
  return null;
}

function decompressor(encoding: Exclude<Encoding, "identity">): Transform {
  if (encoding === "gzip") return createGunzip();
  if (encoding === "deflate") return createInflate();
  return createBrotliDecompress();
}

/**
 * Feeds a copy of each chunk to a decompressor and its output to the scanner. Too much input
 * waiting, too much output, or a stream the decompressor refuses makes the request `unknown`.
 */
function decompressing(
  encoding: Exclude<Encoding, "identity">,
  scanner: Scanner,
  settle: (tier: RequestTier) => void,
  limits: TierReadLimits,
): InnerReader {
  const zip = decompressor(encoding);
  let stopped = false;
  let output = 0;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    zip.destroy();
  };
  const giveUp = (): void => {
    stop();
    settle("unknown");
  };
  zip.on("error", giveUp);
  zip.on("data", (chunk: Buffer) => {
    if (stopped) return;
    try {
      output += chunk.length;
      if (output > limits.maxDecompressedBytes) {
        giveUp();
        return;
      }
      scanner.push(chunk);
    } catch {
      giveUp();
    }
  });
  zip.on("end", () => {
    if (stopped) return;
    try {
      const tier = scanner.result(true);
      stop();
      settle(tier);
    } catch {
      giveUp();
    }
  });
  return {
    push(chunk) {
      if (stopped) return;
      if (zip.writableLength + chunk.length > limits.maxPendingCompressedBytes) {
        giveUp();
        return;
      }
      zip.write(Buffer.from(chunk));
    },
    finish(complete) {
      if (stopped) return;
      if (complete) {
        zip.end();
        return;
      }
      const tier = scanner.result(false);
      stop();
      settle(tier);
    },
    stop,
  };
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** The tier the top-level `service_tier` of a parsed body names, or null. */
const namedTier = (value: unknown): TallyTier | null =>
  isObject(value) ? tierOf(value.service_tier) : null;

/** A JSON body: kept whole up to its bound, parsed once it has ended. */
function jsonScanner(limits: TierReadLimits): Scanner {
  let parts: Buffer[] = [];
  let size = 0;
  let over = false;
  return {
    push(chunk) {
      if (over) return;
      size += chunk.length;
      if (size > limits.maxJsonBytes) {
        over = true;
        parts = [];
        return;
      }
      parts.push(Buffer.from(chunk));
    },
    result(complete) {
      if (!complete || over) return "unknown";
      const text = Buffer.concat(parts).toString("utf8");
      parts = [];
      return namedTier(parseJson(text)) ?? "unknown";
    },
  };
}

/**
 * A server-sent event stream (the WHATWG event stream format): lines end at a line feed (a
 * carriage return before it is dropped), `data` lines of one event are joined by line feeds, and
 * a blank line ends the event. Each event's data is parsed as JSON on its own; `[DONE]`, comments
 * and other fields are skipped. Lines are split on the line feed byte, which never occurs inside a
 * multibyte UTF-8 character, so a character split across chunks is decoded whole.
 */
function eventScanner(limits: TierReadLimits): Scanner {
  const named = new Set<TallyTier>();
  // The start of the current line, copied, when a chunk ended inside it.
  let pending: Buffer[] = [];
  let pendingSize = 0;
  let lineTooLong = false;
  // The current event's data lines.
  let data: string[] = [];
  let dataSize = 0;
  let hasData = false;
  let eventTooLong = false;

  const dispatch = (): void => {
    if (hasData && !eventTooLong) {
      const text = data.join("\n");
      const tier = text === "[DONE]" ? null : namedTier(parseJson(text));
      if (tier !== null) named.add(tier);
    }
    data = [];
    dataSize = 0;
    hasData = false;
    eventTooLong = false;
  };

  const line = (text: string): void => {
    if (text === "") {
      dispatch();
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    if ((colon === -1 ? text : text.slice(0, colon)) !== "data") return;
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    hasData = true;
    if (eventTooLong) return;
    dataSize += value.length;
    if (dataSize > limits.maxEventBytes) {
      eventTooLong = true;
      data = [];
      return;
    }
    data.push(value);
  };

  const endLine = (last: Buffer): void => {
    if (!lineTooLong && pendingSize + last.length <= limits.maxEventBytes) {
      const bytes = pending.length === 0 ? last : Buffer.concat([...pending, last]);
      const text = bytes.toString("utf8");
      line(text.endsWith("\r") ? text.slice(0, -1) : text);
    } else {
      // A line past the bound is not read, and neither is the event it belongs to.
      hasData = true;
      eventTooLong = true;
      data = [];
    }
    pending = [];
    pendingSize = 0;
    lineTooLong = false;
  };

  const keep = (part: Buffer): void => {
    if (lineTooLong || part.length === 0) return;
    pendingSize += part.length;
    if (pendingSize > limits.maxEventBytes) {
      lineTooLong = true;
      pending = [];
      return;
    }
    pending.push(Buffer.from(part));
  };

  return {
    push(chunk) {
      let start = 0;
      for (let end = chunk.indexOf(0x0a, start); end !== -1;) {
        endLine(chunk.subarray(start, end));
        start = end + 1;
        end = chunk.indexOf(0x0a, start);
      }
      keep(chunk.subarray(start));
    },
    result(complete) {
      if (complete) {
        // A stream that ended without a final blank line still gives its last event.
        if (pendingSize > 0 || lineTooLong) endLine(Buffer.alloc(0));
        dispatch();
      }
      pending = [];
      data = [];
      if (named.size === 0) return "unknown";
      return named.size === 1 ? ([...named][0] as TallyTier) : "mixed";
    },
  };
}
