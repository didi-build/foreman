// Reads the subset of YAML a workflow file uses, with no package, for the bootstrap isolation
// check (D-358 lock 1, O-113). Block mappings and sequences, plain and quoted one-line scalars,
// literal and folded block scalars, one-line flow sequences and `{}`. Every scalar stays a
// string. Anything else is refused, so the check fails closed: anchors, aliases, tags, flow
// mappings, multi-line plain or quoted scalars, document markers, complex keys and tabs.

export class WorkflowYamlError extends Error {}

const KEY_RE =
  /^(?:"([^"\\]*)"|'([^']*)'|([A-Za-z0-9_$][A-Za-z0-9_.$/-]*))[ ]*:(?:[ ]+(.*)|)$/;

/**
 * @typedef {{ text: string; no: number }} Line
 * @typedef {{ lines: Line[]; i: number }} Reader
 */

/**
 * @param {number} no
 * @param {string} message
 * @returns {never}
 */
function refuse(no, message) {
  throw new WorkflowYamlError(`line ${no}: ${message}`);
}

/** @param {Line} line */
function isBlank(line) {
  const trimmed = line.text.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/** @param {Line} line */
function indentOf(line) {
  const match = line.text.match(/^[ \t]*/);
  const lead = match ? match[0] : "";
  if (lead.includes("\t")) {
    refuse(line.no, "tabs in indentation are not read");
  }
  return lead.length;
}

/** @param {Reader} r */
function skipBlank(r) {
  while (r.i < r.lines.length && isBlank(r.lines[r.i])) r.i += 1;
}

/** @param {Reader} r */
function peek(r) {
  skipBlank(r);
  return r.i < r.lines.length ? r.lines[r.i] : null;
}

/** @param {string} content */
function isSequenceItem(content) {
  return content === "-" || content.startsWith("- ") || content.startsWith("-\t");
}

/**
 * The text before an unquoted ` #` comment.
 *
 * @param {string} text
 */
function stripComment(text) {
  const at = text.search(/(^|[ \t])#/);
  return (at === -1 ? text : text.slice(0, at)).trimEnd();
}

/**
 * @param {string} text
 * @param {number} no
 * @returns {{ value: string; rest: string }}
 */
function readDoubleQuoted(text, no) {
  let out = "";
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      return { value: out, rest: text.slice(i + 1) };
    }
    if (ch === "\\") {
      const next = text[i + 1];
      /** @type {Record<string, string>} */
      const escapes = { '"': '"', "\\": "\\", "/": "/", n: "\n", t: "\t" };
      if (next === undefined || !(next in escapes)) {
        refuse(no, "this escape in a double-quoted scalar is not read");
      }
      out += escapes[next];
      i += 1;
      continue;
    }
    out += ch;
  }
  return refuse(no, "multi-line double-quoted scalars are not read");
}

/**
 * @param {string} text
 * @param {number} no
 * @returns {{ value: string; rest: string }}
 */
function readSingleQuoted(text, no) {
  let out = "";
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'") {
      if (text[i + 1] === "'") {
        out += "'";
        i += 1;
        continue;
      }
      return { value: out, rest: text.slice(i + 1) };
    }
    out += ch;
  }
  return refuse(no, "multi-line single-quoted scalars are not read");
}

/**
 * A one-line scalar or flow sequence after `key: ` or `- `.
 *
 * @param {string} raw
 * @param {number} no
 * @returns {string | string[] | Record<string, never>}
 */
function readInline(raw, no) {
  const text = raw.trim();
  const first = text[0];
  if (first === '"' || first === "'") {
    const { value, rest } =
      first === '"' ? readDoubleQuoted(text, no) : readSingleQuoted(text, no);
    if (stripComment(rest) !== "") {
      refuse(no, "text after a quoted scalar is not read");
    }
    return value;
  }
  if (first === "[") {
    const body = stripComment(text);
    if (!body.endsWith("]")) {
      refuse(no, "multi-line flow sequences are not read");
    }
    const inner = body.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => {
      const value = item.trim();
      if (value === "" || /[[\]{}"'&*!|>%@`#]/.test(value) || value.includes(": ")) {
        refuse(no, "this flow sequence item is not read");
      }
      return value;
    });
  }
  if (first === "{") {
    if (stripComment(text) !== "{}") {
      refuse(no, "flow mappings are not read");
    }
    return {};
  }
  if (first !== undefined && "&*!%@`|>".includes(first)) {
    refuse(no, `scalars starting with ${first} are not read`);
  }
  const value = stripComment(text);
  if (value.includes(": ") || value.endsWith(":") || value.startsWith("- ")) {
    refuse(no, "this plain scalar is not read");
  }
  return value;
}

/**
 * A literal (`|`) or folded (`>`) block scalar whose header is on line `no`.
 *
 * @param {Reader} r
 * @param {string} header
 * @param {number} ownerIndent
 * @param {number} no
 * @returns {string}
 */
function readBlockScalar(r, header, ownerIndent, no) {
  const match = stripComment(header).match(/^([|>])([+-]?)$/);
  if (!match) {
    refuse(no, "block scalar indentation indicators are not read");
  }
  const [, style, chomp] = /** @type {RegExpMatchArray} */ (match);
  /** @type {Line[]} */
  const raw = [];
  while (r.i < r.lines.length) {
    const line = r.lines[r.i];
    if (line.text.trim() !== "" && indentOf(line) <= ownerIndent) break;
    raw.push(line);
    r.i += 1;
  }
  const firstContent = raw.find((line) => line.text.trim() !== "");
  if (!firstContent) {
    return "";
  }
  const contentIndent = indentOf(firstContent);
  const body = raw.map((line) => {
    if (line.text.trim() === "") return "";
    if (indentOf(line) < contentIndent) {
      refuse(line.no, "a block scalar line is indented less than its first line");
    }
    return line.text.slice(contentIndent);
  });
  let end = body.length;
  while (end > 0 && body[end - 1] === "") end -= 1;
  const content = body.slice(0, end);
  const trailing = body.length - end;

  let text;
  if (style === "|") {
    text = content.join("\n");
  } else {
    if (content.some((line) => /^\s/.test(line))) {
      refuse(no, "more-indented lines in a folded scalar are not read");
    }
    text = "";
    for (let i = 0; i < content.length; i += 1) {
      const line = content[i];
      if (i === 0) {
        text = line;
      } else if (line === "") {
        text += "\n";
      } else {
        text += content[i - 1] === "" ? line : ` ${line}`;
      }
    }
  }
  if (chomp === "-") return text;
  if (chomp === "+") return `${text}\n${"\n".repeat(trailing)}`;
  return `${text}\n`;
}

/**
 * The value after `key:` or `- `: inline, a block scalar, or a nested block.
 *
 * @param {Reader} r
 * @param {string} rest
 * @param {number} ownerIndent
 * @param {number} no
 * @param {boolean} allowSameIndentSequence
 */
function readValue(r, rest, ownerIndent, no, allowSameIndentSequence) {
  const trimmed = rest.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    const next = peek(r);
    if (!next) return null;
    const indent = indentOf(next);
    if (indent > ownerIndent) return readBlock(r, indent);
    if (
      allowSameIndentSequence &&
      indent === ownerIndent &&
      isSequenceItem(next.text.slice(indent))
    ) {
      return readSequence(r, indent);
    }
    return null;
  }
  if (trimmed[0] === "|" || trimmed[0] === ">") {
    return readBlockScalar(r, trimmed, ownerIndent, no);
  }
  const value = readInline(trimmed, no);
  const next = peek(r);
  if (next && indentOf(next) > ownerIndent) {
    refuse(
      next.no,
      "multi-line plain scalars and nested blocks after a value are not read",
    );
  }
  return value;
}

/**
 * @param {Reader} r
 * @param {number} indent
 * @param {{ key: string; rest: string; no: number }} [first] a pair already read from `- key: value`
 * @returns {Record<string, unknown>}
 */
function readMapping(r, indent, first) {
  /** @type {Record<string, unknown>} */
  const map = {};
  /**
   * @param {string} key
   * @param {string} rest
   * @param {number} no
   */
  const add = (key, rest, no) => {
    if (key === "__proto__" || Object.prototype.hasOwnProperty.call(map, key)) {
      refuse(no, `duplicate or reserved key ${key}`);
    }
    map[key] = readValue(r, rest, indent, no, true);
  };
  if (first) add(first.key, first.rest, first.no);
  for (;;) {
    const line = peek(r);
    if (!line) break;
    const lineIndent = indentOf(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) refuse(line.no, "unexpected indentation");
    const content = line.text.slice(indent);
    if (isSequenceItem(content)) refuse(line.no, "a sequence item inside a mapping");
    const pair = readKey(content, line.no);
    r.i += 1;
    add(pair.key, pair.rest, line.no);
  }
  return map;
}

/**
 * @param {string} content
 * @param {number} no
 * @returns {{ key: string; rest: string }}
 */
function readKey(content, no) {
  const match = content.match(KEY_RE);
  if (!match) {
    refuse(no, "expected `key: value`");
  }
  const [, doubleQuoted, singleQuoted, plain, rest] = /** @type {RegExpMatchArray} */ (
    match
  );
  return { key: doubleQuoted ?? singleQuoted ?? plain, rest: rest ?? "" };
}

/**
 * @param {Reader} r
 * @param {number} indent
 * @returns {unknown[]}
 */
function readSequence(r, indent) {
  const items = [];
  for (;;) {
    const line = peek(r);
    if (!line) break;
    const lineIndent = indentOf(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) refuse(line.no, "unexpected indentation");
    const content = line.text.slice(indent);
    if (!isSequenceItem(content)) break;
    r.i += 1;
    const after = content.slice(1);
    const rest = after.trimStart();
    if (rest === "" || rest.startsWith("#")) {
      items.push(readValue(r, "", indent, line.no, false));
      continue;
    }
    if (isSequenceItem(rest)) refuse(line.no, "nested inline sequences are not read");
    const column = indent + 1 + (after.length - rest.length);
    if (KEY_RE.test(rest)) {
      const pair = readKey(rest, line.no);
      items.push(readMapping(r, column, { ...pair, no: line.no }));
      continue;
    }
    items.push(readValue(r, rest, indent, line.no, false));
  }
  return items;
}

/**
 * @param {Reader} r
 * @param {number} indent
 */
function readBlock(r, indent) {
  const line = /** @type {Line} */ (peek(r));
  return isSequenceItem(line.text.slice(indent))
    ? readSequence(r, indent)
    : readMapping(r, indent);
}

/**
 * @param {string} text a workflow file
 * @returns {unknown} its content; every scalar a string, an empty value null
 */
export function parseWorkflowYaml(text) {
  const lines = text
    .split("\n")
    .map((raw, i) => ({ text: raw.replace(/\r$/, ""), no: i + 1 }));
  if (lines.length > 0 && lines[lines.length - 1].text === "") {
    lines.pop();
  }
  for (const line of lines) {
    const trimmed = line.text.trim();
    if (trimmed === "---" || trimmed === "..." || trimmed.startsWith("%")) {
      refuse(line.no, "document markers and directives are not read");
    }
  }
  /** @type {Reader} */
  const r = { lines, i: 0 };
  const first = peek(r);
  if (!first) return null;
  if (indentOf(first) !== 0) refuse(first.no, "the document must start at column 0");
  const value = readBlock(r, 0);
  const left = peek(r);
  if (left) refuse(left.no, "unexpected content");
  return value;
}
