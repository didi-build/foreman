// A small PNG reader and writer for the visual comparison (D-242, D-250). It reads the PNGs CI
// saves and writes the crops the QA visual run is given. Only what a browser screenshot uses:
// 8-bit greyscale, grey with alpha, RGB and RGBA, palette images, no interlacing. Anything else is
// refused with a fixed message, never a byte of the file. The pixels come back as RGBA rasters
// (src/core/visual-diff.ts), so the core never sees a file format.
//
// The writer is deterministic: the same raster always gives the same bytes (filter 0 on every
// row, zlib level 9, no text or time chunks), so a crop's SHA-256 is stable.
import { deflateSync, inflateSync } from "node:zlib";

import type { PngCodec } from "../../core/visual-comparison.ts";
import type { Raster } from "../../core/visual-diff.ts";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Screenshots larger than this are refused, so a bad file cannot ask for gigabytes. */
export const MAX_PNG_SIDE = 8000;

export class PngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PngError";
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const body = Buffer.concat([head.subarray(4), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, tail]);
}

/** Encodes an RGBA raster as a PNG. Deterministic. */
export function encodePng(raster: Raster): Buffer {
  const { width, height, data } = raster;
  if (data.length !== width * height * 4)
    throw new PngError("the raster size is wrong");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (width * 4 + 1);
    rows[at] = 0;
    rows.set(data.subarray(y * width * 4, (y + 1) * width * 4), at + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decodes a PNG into an RGBA raster. Errors name the problem, never the file's bytes. */
export function decodePng(bytes: Uint8Array): Raster {
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (file.length < 8 || !file.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngError("the file is not a PNG");
  }
  let width = 0;
  let height = 0;
  let colourType = -1;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const parts: Buffer[] = [];
  let at = 8;
  let ended = false;
  while (at + 12 <= file.length) {
    const length = file.readUInt32BE(at);
    const type = file.toString("latin1", at + 4, at + 8);
    if (at + 12 + length > file.length) throw new PngError("a PNG chunk is cut short");
    const data = file.subarray(at + 8, at + 8 + length);
    if (
      crc32(file.subarray(at + 4, at + 8 + length)) !==
      file.readUInt32BE(at + 8 + length)
    ) {
      throw new PngError("a PNG chunk fails its checksum");
    }
    if (type === "IHDR") {
      if (length !== 13) throw new PngError("the PNG header is malformed");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      colourType = data[9] ?? -1;
      if (depth !== 8) throw new PngError("only 8-bit PNGs are read");
      if (!Object.hasOwn(CHANNELS, colourType))
        throw new PngError("unknown PNG colour type");
      if (data[10] !== 0 || data[11] !== 0)
        throw new PngError("unknown PNG compression");
      if (data[12] !== 0) throw new PngError("interlaced PNGs are not read");
      if (width < 1 || height < 1 || width > MAX_PNG_SIDE || height > MAX_PNG_SIDE) {
        throw new PngError(`a PNG side must be 1 to ${MAX_PNG_SIDE} pixels`);
      }
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") transparency = Buffer.from(data);
    else if (type === "IDAT") parts.push(Buffer.from(data));
    else if (type === "IEND") {
      ended = true;
      break;
    }
    at += 12 + length;
  }
  if (!ended || width === 0) throw new PngError("the PNG is incomplete");
  if (colourType === 3 && !palette) throw new PngError("the PNG palette is missing");

  const channels = CHANNELS[colourType] as number;
  const stride = width * channels;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(parts));
  } catch {
    throw new PngError("the PNG image data cannot be read");
  }
  if (raw.length !== (stride + 1) * height)
    throw new PngError("the PNG image data is the wrong size");

  const lines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x] as number;
      const left = x >= channels ? (lines[out + x - channels] as number) : 0;
      const up = y > 0 ? (lines[out - stride + x] as number) : 0;
      const upLeft =
        y > 0 && x >= channels ? (lines[out - stride + x - channels] as number) : 0;
      let decoded: number;
      switch (filter) {
        case 0:
          decoded = value;
          break;
        case 1:
          decoded = value + left;
          break;
        case 2:
          decoded = value + up;
          break;
        case 3:
          decoded = value + ((left + up) >> 1);
          break;
        case 4:
          decoded = value + paeth(left, up, upLeft);
          break;
        default:
          throw new PngError("unknown PNG row filter");
      }
      lines[out + x] = decoded & 0xff;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    const v = (k: number) => lines[s + k] as number;
    switch (colourType) {
      case 0:
        data.set([v(0), v(0), v(0), 255], d);
        break;
      case 4:
        data.set([v(0), v(0), v(0), v(1)], d);
        break;
      case 2:
        data.set([v(0), v(1), v(2), 255], d);
        break;
      case 6:
        data.set([v(0), v(1), v(2), v(3)], d);
        break;
      case 3: {
        const index = v(0);
        const table = palette as Buffer;
        if (index * 3 + 2 >= table.length)
          throw new PngError("a PNG palette index is out of range");
        const alpha =
          transparency && index < transparency.length
            ? (transparency[index] as number)
            : 255;
        data.set(
          [
            table[index * 3] as number,
            table[index * 3 + 1] as number,
            table[index * 3 + 2] as number,
            alpha,
          ],
          d,
        );
        break;
      }
    }
  }
  return { width, height, data };
}

/** The codec as the core's port (src/core/visual-comparison.ts). */
export const pngCodec: PngCodec = { decode: decodePng, encode: encodePng };
