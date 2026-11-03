// Adapter seam: the PNG reader and writer on synthetic images. No files from outside the test.
import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { compareRasters, paintBox, solidRaster } from "../../core/visual-diff.ts";
import { decodePng, encodePng, PngError } from "./png.ts";

const picture = () =>
  paintBox(
    solidRaster(9, 7, [255, 255, 255, 255]),
    { x: 2, y: 1, width: 4, height: 3 },
    [10, 120, 30, 200],
  );

/** A hand-built PNG with one row filter used on every row, to exercise the reader. */
function filteredPng(filter: number): Buffer {
  const width = 3;
  const height = 2;
  const pixels = [
    [10, 20, 30],
    [40, 50, 60],
    [70, 80, 90],
    [15, 25, 35],
    [45, 55, 65],
    [75, 85, 95],
  ];
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = filter;
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        const value = (pixels[y * width + x] as number[])[c] as number;
        const left = x > 0 ? ((pixels[y * width + x - 1] as number[])[c] as number) : 0;
        const up = y > 0 ? ((pixels[(y - 1) * width + x] as number[])[c] as number) : 0;
        const predicted =
          filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : 0;
        raw[y * (width * 3 + 1) + 1 + x * 3 + c] = (value - predicted) & 0xff;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const chunks: Buffer[] = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ];
  const frame = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  chunks.push(
    frame("IHDR", header),
    frame("IDAT", deflateSync(raw)),
    frame("IEND", Buffer.alloc(0)),
  );
  return Buffer.concat(chunks);
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

describe("PNG", () => {
  it("round-trips a raster and writes the same bytes every time", () => {
    const bytes = encodePng(picture());
    expect(encodePng(picture()).equals(bytes)).toBe(true);
    const back = decodePng(bytes);
    expect(back.width).toBe(9);
    expect(Array.from(back.data)).toEqual(Array.from(picture().data));
  });

  it.each([0, 1, 2, 3])("reads RGB rows written with filter %i", (filter) => {
    const raster = decodePng(filteredPng(filter));
    expect(Array.from(raster.data.subarray(0, 8))).toEqual([
      10, 20, 30, 255, 40, 50, 60, 255,
    ]);
    expect(Array.from(raster.data.subarray(12, 16))).toEqual([15, 25, 35, 255]);
  });

  it("refuses what is not a PNG, a broken checksum and a cut file, naming no bytes", () => {
    expect(() => decodePng(Buffer.from("not a png"))).toThrow(PngError);
    const bytes = encodePng(picture());
    const broken = Buffer.from(bytes);
    broken[20] = (broken[20] as number) ^ 0xff;
    expect(() => decodePng(broken)).toThrow("checksum");
    expect(() => decodePng(bytes.subarray(0, bytes.length - 20))).toThrow(PngError);
  });

  it("feeds the comparison: a planted change survives the round trip", () => {
    const approved = decodePng(encodePng(picture()));
    const built = decodePng(
      encodePng(
        paintBox(picture(), { x: 3, y: 2, width: 1, height: 1 }, [255, 0, 0, 255]),
      ),
    );
    expect(compareRasters(approved, built).summary.changedPixels).toBe(1);
  });
});
