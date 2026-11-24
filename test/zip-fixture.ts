// Test support: small zip files made in memory, as GitHub serves a workflow artifact, for the
// staging site's file set (O-116) and the browser host's site (ADR 0119 slice 5b). Each entry is
// stored or deflated, and may carry a Unix mode in its external attributes (a symbolic link is
// `0o120777`), made on a Unix host. Synthetic only. The writer itself is plain JavaScript
// (./fixtures/zip.mjs), so the browser canary can use it inside the agent image.
import { storedZip as writeZip } from "./fixtures/zip.mjs";

export interface ZipFixtureEntry {
  name: string;
  data: string | Uint8Array;
  deflate?: boolean;
  /** A Unix mode, for example `0o100644` for a file or `0o120777` for a link. */
  mode?: number;
}

/** A zip of the entries, in order. */
export function storedZip(entries: readonly ZipFixtureEntry[]): Uint8Array {
  return writeZip(entries);
}
