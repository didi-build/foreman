// Unit tests for text Postgres can store (O-182). The Postgres store's own use, against a real
// database, is in test/db/store.test.ts.
import { describe, expect, it } from "vitest";

import { cutStorable, storableJson, storableText } from "./storable-text.ts";

const HIGH = "\ud83d"; // the first half of 😀 (U+1F600)
const LOW = "\ude00"; // its second half
const PAIR = `${HIGH}${LOW}`;

describe("storable text (unit: O-182)", () => {
  it("keeps text within the rules exactly as it is, emoji and accents included", () => {
    for (const text of [
      "",
      "plain",
      `a ${PAIR} b`,
      "café, naïve, 日本語",
      "tab\tnewline\n",
    ]) {
      expect(storableText(text)).toBe(text);
    }
  });

  it("replaces NUL and each lone surrogate half with U+FFFD, and nothing else", () => {
    expect(storableText("a\0b")).toBe("a�b");
    expect(storableText(`end ${HIGH}`)).toBe("end �");
    expect(storableText(`${LOW} start`)).toBe("� start");
    expect(storableText(`${HIGH}x${LOW}`)).toBe("�x�");
    expect(storableText(`${LOW}${HIGH}`)).toBe("��");
    expect(storableText(`${PAIR}\0${PAIR}`)).toBe(`${PAIR}�${PAIR}`);
  });

  it("cuts at a length without splitting a surrogate pair", () => {
    expect(cutStorable("abcdef", 4)).toBe("abcd");
    expect(cutStorable("abc", 4)).toBe("abc");
    // The pair would straddle the cut: it goes whole, one unit short.
    expect(cutStorable(`abc${PAIR}d`, 4)).toBe("abc");
    expect(cutStorable(`ab${PAIR}d`, 4)).toBe(`ab${PAIR}`);
    // A text within its bound is still made storable.
    expect(cutStorable("a\0", 4)).toBe("a�");
  });

  it("makes every string in a JSON value storable, keys included, and keeps the rest", () => {
    const value = {
      note: `cut ${HIGH}`,
      [`k\0`]: [1, true, null, "fine", { deep: `${LOW}x` }],
      count: 3,
    };
    expect(storableJson(value)).toEqual({
      note: "cut �",
      "k�": [1, true, null, "fine", { deep: "�x" }],
      count: 3,
    });
    expect(storableJson("x\0")).toBe("x�");
    expect(storableJson(null)).toBeNull();
    expect(storableJson(7)).toBe(7);
  });
});
