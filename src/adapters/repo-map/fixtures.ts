// Synthetic archives for the repo map's tests: a gzip'd tar shaped like the one GitHub serves for
// a commit (`git archive`: a global pax header, the top folder, then the entries). Not a real
// repository; nothing here reaches the network.
import { gzipSync } from "node:zlib";

export const FIXTURE_REPO = "didi-build/rehearsal";
export const FIXTURE_SHA = "c".repeat(40);
export const FIXTURE_TOP = `didi-build-rehearsal-${FIXTURE_SHA.slice(0, 7)}`;

export type TarEntry = { path: string; text?: string; type?: string; pax?: boolean };

export function tarHeader(
  name: string,
  size: number,
  type: string,
  prefix = "",
): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block.write(type, 156);
  block.write("ustar\0", 257);
  block.write("00", 263);
  block.write(prefix, 345, 155, "utf8");
  return block;
}

const pad = (data: Buffer) =>
  Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

/** A gzip'd tar like `git archive` makes: a global pax header, the top folder, then entries. */
export function tarball(entries: TarEntry[], top = FIXTURE_TOP): Uint8Array {
  const blocks: Buffer[] = [];
  const global = Buffer.from(`52 comment=${FIXTURE_SHA}\n`);
  blocks.push(tarHeader("pax_global_header", global.length, "g"), pad(global));
  blocks.push(tarHeader(`${top}/`, 0, "5"));
  for (const entry of entries) {
    const data = Buffer.from(entry.text ?? "");
    const type = entry.type ?? "0";
    if (entry.pax) {
      const record = `path=${entry.path}\n`;
      let length = record.length + 3;
      length = `${length} ${record}`.length;
      const pax = Buffer.from(`${length} ${record}`);
      blocks.push(tarHeader("PaxHeader", pax.length, "x"), pad(pax));
      blocks.push(tarHeader("cut", data.length, type), pad(data));
    } else {
      blocks.push(tarHeader(entry.path, data.length, type), pad(data));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** A small checkout: a package.json with one script, a README, two code files that import. */
export const FIXTURE_ENTRIES: TarEntry[] = [
  { path: `${FIXTURE_TOP}/package.json`, text: '{"scripts":{"check":"vitest run"}}' },
  { path: `${FIXTURE_TOP}/README.md`, text: "# Rehearsal" },
  {
    path: `${FIXTURE_TOP}/src/app.ts`,
    text: 'import { read } from "./store.js";\nexport const app = read;',
  },
  { path: `${FIXTURE_TOP}/src/store.ts`, text: "export function read() {}" },
  { path: `${FIXTURE_TOP}/node_modules/x/index.js`, text: "export const x = 1;" },
  { path: `${FIXTURE_TOP}/.git/config`, text: "[core]" },
  { path: `${FIXTURE_TOP}/src/link.ts`, type: "2" },
];
