/**
 * Minimal JSONC helpers (dependency-free). String and comment handling adapted from
 * the MIT-licensed jsonc-parser project (Microsoft); see LICENSES/jsonc-parser-MIT.txt.
 */

const UTF8_BOM = "\uFEFF";

/**
 * @param {string} text
 * @returns {string}
 */
export function stripLeadingUtf8Bom(text) {
  return text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text;
}

/**
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function skipWhitespaceAndComments(text, start) {
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\u00A0") {
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i += 1;
      }
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

/**
 * @param {string} text
 * @param {number} start
 * @returns {{ value: string; end: number }}
 */
function readJsonString(text, start) {
  if (text[start] !== '"') {
    throw new Error(`Expected string at offset ${start}`);
  }
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === '"') {
      const slice = text.slice(start, i + 1);
      return { value: JSON.parse(slice), end: i + 1 };
    }
    i += 1;
  }
  throw new Error(`Unterminated string at offset ${start}`);
}

/**
 * @param {string} text
 * @param {number} start
 * @param {string} open
 * @param {string} close
 * @returns {number}
 */
function skipComposite(text, start, open, close) {
  if (text[start] !== open) {
    throw new Error(`Expected ${open} at offset ${start}`);
  }
  let depth = 1;
  let i = start + 1;
  while (i < text.length && depth > 0) {
    i = skipWhitespaceAndComments(text, i);
    if (i >= text.length) {
      break;
    }
    const ch = text[i];
    if (ch === '"') {
      i = readJsonString(text, i).end;
      continue;
    }
    if (ch === open) {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === close) {
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i += 1;
      }
      i += 2;
      continue;
    }
    i += 1;
  }
  return i;
}

/**
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function skipValue(text, start) {
  let i = skipWhitespaceAndComments(text, start);
  const ch = text[i];
  if (ch === '"') {
    return readJsonString(text, i).end;
  }
  if (ch === "{") {
    return skipComposite(text, i, "{", "}");
  }
  if (ch === "[") {
    return skipComposite(text, i, "[", "]");
  }
  while (i < text.length && ",}]".indexOf(text[i]) === -1) {
    i += 1;
  }
  return i;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function jsoncToJsonText(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i += 1;
      }
      i += 2;
      out += " ";
      continue;
    }
    if (ch === '"') {
      const { end } = readJsonString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\u00A0") {
      out += ch === "\u00A0" ? " " : ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return stripTrailingCommas(out);
}

/**
 * @param {string} jsonText
 * @returns {string}
 */
function stripTrailingCommas(jsonText) {
  let out = "";
  let i = 0;
  while (i < jsonText.length) {
    const ch = jsonText[i];
    if (ch === '"') {
      const { end } = readJsonString(jsonText, i);
      out += jsonText.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ",") {
      let j = skipWhitespaceAndComments(jsonText, i + 1);
      if (jsonText[j] === "}" || jsonText[j] === "]") {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function parseJsoncObject(text) {
  const jsonText = jsoncToJsonText(stripLeadingUtf8Bom(text));
  let value;
  try {
    value = JSON.parse(jsonText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`wrangler.jsonc parse error: ${message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("wrangler.jsonc must be a JSON object");
  }
  return value;
}

/**
 * @param {string} text
 * @param {string} key
 * @param {string} expectedValue
 * @param {string} newValue
 * @returns {string}
 */
export function replaceTopLevelStringProperty(text, key, expectedValue, newValue) {
  const body = stripLeadingUtf8Bom(text);
  let i = skipWhitespaceAndComments(body, 0);
  if (body[i] !== "{") {
    throw new Error("wrangler.jsonc must be a JSON object");
  }
  i = skipWhitespaceAndComments(body, i + 1);
  while (i < body.length) {
    i = skipWhitespaceAndComments(body, i);
    if (body[i] === "}") {
      break;
    }
    if (body[i] === ",") {
      i += 1;
      continue;
    }
    const keyRead = readJsonString(body, i);
    i = skipWhitespaceAndComments(body, keyRead.end);
    if (body[i] !== ":") {
      throw new Error(`Expected ':' after key at offset ${i}`);
    }
    const valueStart = skipWhitespaceAndComments(body, i + 1);
    if (keyRead.value === key) {
      if (body[valueStart] !== '"') {
        throw new Error(`Top-level "${key}" must be a string`);
      }
      const valueRead = readJsonString(body, valueStart);
      if (valueRead.value !== expectedValue) {
        throw new Error(
          `wrangler.jsonc name must be "${expectedValue}" before rename (found "${String(valueRead.value)}")`,
        );
      }
      const escapedNew = JSON.stringify(newValue);
      return body.slice(0, valueStart) + escapedNew + body.slice(valueRead.end);
    }
    i = skipValue(body, valueStart);
    i = skipWhitespaceAndComments(body, i);
    if (body[i] === ",") {
      i += 1;
    }
  }
  throw new Error(`Top-level "${key}" not found`);
}
