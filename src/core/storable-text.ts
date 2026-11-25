// Text Postgres can store (O-182). A text column refuses NUL, and jsonb also refuses a lone
// surrogate half (a "\ud800" escape with no pair after it). Model text can hold either, and a cut
// at a fixed length can split a surrogate pair. A write that holds one fails the same way on every
// retry, so the Postgres store replaces each one with U+FFFD before it writes, through these
// functions. Text within the rules is kept exactly as it is. Pure: no imports beyond core types.
import type { Json } from "./store.ts";

/** A lone surrogate half, or NUL. */
const UNSTORABLE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|\0/g;

/** The text with each lone surrogate half and each NUL replaced by U+FFFD. */
export function storableText(text: string): string {
  return text.replace(UNSTORABLE, "�");
}

/**
 * The text cut to at most `max` UTF-16 units without splitting a surrogate pair, then made
 * storable. A text within `max` is only made storable.
 */
export function cutStorable(text: string, max: number): string {
  let cut = text;
  if (cut.length > max) {
    const last = cut.charCodeAt(max - 1);
    cut = cut.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
  }
  return storableText(cut);
}

/** A JSON value with every string in it, keys included, made storable. */
export function storableJson(value: Json): Json {
  if (typeof value === "string") return storableText(value);
  if (Array.isArray(value)) return value.map(storableJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        storableText(key),
        storableJson(inner),
      ]),
    );
  }
  return value;
}
