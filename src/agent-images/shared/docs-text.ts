// The text of one documentation page, for the `read_docs_page` tool (./docs-lookup.ts, ADR 0119
// slice 4b). Node built-ins only and no dependency: a small HTML reader that keeps what a person
// reads on the page and drops the rest.
//
// - **Read.** Tags, attributes, comments and the raw text of `script`, `style` and the like are
//   read by hand, and the open elements are kept on a stack with the few implied ends real pages
//   lean on (`p`, `li`, `dt`, `dd`, table rows and cells, `head`), so every element ends inside
//   its parent. Nothing on the page runs, and nothing is fetched.
// - **Dropped.** Comments, `script`, `style`, `noscript`, `template`, `svg`, `iframe`, `head`, any
//   element with `hidden` or `aria-hidden="true"`, with everything inside them, and also `title`
//   (a head's, when the page leaves out its head tag), `noembed` and `noframes`.
// - **Where it starts.** The first `<main>`, else the first `<article>`, else the body. With a
//   fragment, the text starts at the element whose `id` (or an `<a>`'s `name`) it names, and runs
//   to the end of that root, or of the body when the element is outside it. A fragment no element
//   has gives the page from its start with a fixed note.
// - **Written.** Headings become `#` lines, list items `- ` lines (indented when nested), table
//   rows one line with ` | ` between cells, `pre` a fenced block kept verbatim and inline `code`
//   in backticks, verbatim. Other text has its white space collapsed. Entities are decoded. A
//   link keeps its URL, as `[text](url)`, only when it is an https URL on a listed host, which the
//   tool can read next; any other link is its text alone. Images are left out.
// - text/plain and text/markdown pages are passed through as text (`plainText`).
//
// The caller frames the text as data, removes secret values and cuts it to its bound.
import { canonicalHostName } from "../../core/site-requests.ts";

export interface PageTextOptions {
  /** The run's trusted hosts, canonical. Only links to these keep their URL. */
  listedHosts: readonly string[];
  /** The URL's fragment, decoded, without `#`. Empty or left out: the whole page. */
  fragment?: string;
  /** The page's own URL, against which relative links resolve. */
  url: string;
}

/** The note before the text when the URL's fragment names no element on the page. */
export const NO_FRAGMENT_NOTE =
  "(No element on this page has the id in the URL's fragment, so the text starts at the top of the page.)";

/** A page's text from text/plain or text/markdown: lines kept, control characters removed. */
export function plainText(text: string): string {
  return cleanControls(text.replace(/\r\n?/g, "\n")).trim();
}

// ---------------------------------------------------------------------------------------------
// Entities

const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  zwnj: "\u200c",
  zwj: "\u200d",
  shy: "\u00ad",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  minus: "\u2212",
  lsquo: "\u2018",
  rsquo: "\u2019",
  sbquo: "\u201a",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bdquo: "\u201e",
  laquo: "\u00ab",
  raquo: "\u00bb",
  lsaquo: "\u2039",
  rsaquo: "\u203a",
  bull: "\u2022",
  middot: "\u00b7",
  times: "\u00d7",
  divide: "\u00f7",
  plusmn: "\u00b1",
  deg: "\u00b0",
  para: "\u00b6",
  sect: "\u00a7",
  euro: "\u20ac",
  pound: "\u00a3",
  yen: "\u00a5",
  cent: "\u00a2",
  larr: "\u2190",
  uarr: "\u2191",
  rarr: "\u2192",
  darr: "\u2193",
  harr: "\u2194",
  lArr: "\u21d0",
  rArr: "\u21d2",
  hArr: "\u21d4",
  le: "\u2264",
  ge: "\u2265",
  ne: "\u2260",
  asymp: "\u2248",
  infin: "\u221e",
  hyphen: "\u2010",
  dagger: "\u2020",
  Dagger: "\u2021",
  prime: "\u2032",
  check: "\u2713",
  grave: "`",
  lowbar: "_",
  ast: "*",
  num: "#",
  verbar: "|",
  vert: "|",
  lbrace: "{",
  rbrace: "}",
  lbrack: "[",
  rbrack: "]",
  lpar: "(",
  rpar: ")",
  colon: ":",
  semi: ";",
  comma: ",",
  period: ".",
  excl: "!",
  quest: "?",
  dollar: "$",
  percnt: "%",
  plus: "+",
  equals: "=",
  sol: "/",
  bsol: "\\",
  Hat: "^",
  tilde: "\u02dc",
  commat: "@",
};

/** HTML's names for U+00A0 to U+00FF, in order: accented letters and Latin-1's signs. */
const LATIN_1 =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(
    " ",
  );
const ENTITIES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    LATIN_1.map((name, i) => [name, String.fromCharCode(0xa0 + i)]),
  ),
  ...NAMED,
};

const ENTITY = /&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));?/g;

const fromCodePoint = (code: number): string =>
  code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
    ? "\ufffd"
    : String.fromCodePoint(code);

/** Decimal, hexadecimal and the common named entities. An unknown name stays as it is. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    ENTITY,
    (whole, decimal?: string, hex?: string, name?: string) => {
      if (decimal !== undefined) return fromCodePoint(Number(decimal));
      if (hex !== undefined) return fromCodePoint(parseInt(hex, 16));
      // A named entity needs its `;`, except the few pages often leave it off.
      const known = Object.hasOwn(ENTITIES, name ?? "")
        ? ENTITIES[name as string]
        : undefined;
      if (known === undefined) return whole;
      if (
        !whole.endsWith(";") &&
        !["amp", "lt", "gt", "quot", "nbsp"].includes(name ?? "")
      ) {
        return whole;
      }
      return known;
    },
  );
}

/** Control characters other than tab and newline, which no page text needs. */
const cleanControls = (text: string): string =>
  text.replace(/\p{Cc}/gu, (c) => (c === "\n" || c === "\t" ? c : ""));

// ---------------------------------------------------------------------------------------------
// Reading the page: tokens, then well-nested events

type Attributes = Map<string, string>;

type Event =
  | { kind: "open"; name: string; attrs: Attributes; close: number }
  | { kind: "close"; open: number }
  | { kind: "text"; text: string };

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements whose content is raw text up to their own end tag: never parsed as markup. */
const RAW_TEXT = new Set([
  "script",
  "style",
  "noscript",
  "iframe",
  "xmp",
  "noembed",
  "noframes",
  "textarea",
  "title",
]);

/** Elements dropped with all they hold. */
const DROPPED = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "head",
  // A head's title, also when the page leaves out its head tag.
  "title",
  // Raw markup for browsers without embeds or frames, never text a reader sees.
  "noembed",
  "noframes",
]);

/** What `head` may hold. Anything else ends it, as a browser ends it. */
const HEAD_CONTENT = new Set([
  "base",
  "link",
  "meta",
  "title",
  "style",
  "script",
  "noscript",
  "template",
]);

/** Opening one of these ends an open `p`. */
const CLOSES_P = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "center",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "ul",
  "li",
  "dd",
  "dt",
]);

/** An end tag or an implied end never reaches past one of these, unless it names it. */
const SCOPE = new Set([
  "html",
  "body",
  "table",
  "td",
  "th",
  "caption",
  "template",
  "button",
  "object",
  "marquee",
  "applet",
]);

/** A list item's implied end stops at these (HTML's special elements, less address, div, p). */
const LIST_STOP = new Set([
  "ul",
  "ol",
  "menu",
  "dl",
  "table",
  "td",
  "th",
  "body",
  "html",
  "template",
  "article",
  "aside",
  "blockquote",
  "section",
  "nav",
  "main",
  "header",
  "footer",
  "figure",
  "details",
  "fieldset",
  "form",
]);

const NAME_CHAR = /[A-Za-z0-9:_-]/;
const NOTHING: ReadonlySet<string> = new Set();
const TABLE: ReadonlySet<string> = new Set(["table"]);
const ROW: ReadonlySet<string> = new Set(["tr", "table"]);
const SELECT: ReadonlySet<string> = new Set(["select"]);

/**
 * The most elements open at once. A deeper element is read as if it ended at once, so its content
 * joins its parent's: the stack, and every search of it, stays bounded on any page.
 */
const MAX_DEPTH = 128;

interface Token {
  kind: "open" | "close" | "text";
  name: string;
  attrs: Attributes;
  selfClosing: boolean;
  text: string;
}

/** Reads one tag's attributes from `html` at `start`, to its `>`. Quoted values may hold `>`. */
function readTag(
  html: string,
  start: number,
): { attrs: Attributes; selfClosing: boolean; end: number } {
  const attrs: Attributes = new Map();
  let i = start;
  let selfClosing = false;
  const n = html.length;
  while (i < n) {
    const c = html[i] as string;
    if (c === ">") return { attrs, selfClosing, end: i + 1 };
    if (c === "/") {
      selfClosing = html[i + 1] === ">";
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    let nameEnd = i;
    while (nameEnd < n && !/[\s/>=]/.test(html[nameEnd] as string)) nameEnd += 1;
    if (nameEnd === i) nameEnd = i + 1;
    const name = html.slice(i, nameEnd).toLowerCase();
    i = nameEnd;
    while (i < n && /\s/.test(html[i] as string)) i += 1;
    let value = "";
    if (html[i] === "=") {
      i += 1;
      while (i < n && /\s/.test(html[i] as string)) i += 1;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        const valueEnd = close === -1 ? n : close;
        value = html.slice(i + 1, valueEnd);
        i = valueEnd + 1;
      } else {
        let valueEnd = i;
        while (valueEnd < n && !/[\s>]/.test(html[valueEnd] as string)) valueEnd += 1;
        value = html.slice(i, valueEnd);
        i = valueEnd;
      }
    }
    if (!attrs.has(name)) attrs.set(name, decodeEntities(value));
    selfClosing = false;
  }
  return { attrs, selfClosing, end: n };
}

/** The page as tokens: tags, text (entities decoded) and raw text. Comments are left out. */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const n = html.length;
  let i = 0;
  let textStart = 0;
  const flushText = (end: number) => {
    if (end > textStart) {
      tokens.push({
        kind: "text",
        name: "",
        attrs: new Map(),
        selfClosing: false,
        text: decodeEntities(html.slice(textStart, end)),
      });
    }
  };
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    const next = html[lt + 1] ?? "";
    if (html.startsWith("<!--", lt)) {
      flushText(lt);
      // From the second dash, so `<!-->` and `<!--->` end at once, as a browser ends them.
      const close = html.indexOf("-->", lt + 2);
      i = close === -1 ? n : close + 3;
      textStart = i;
      continue;
    }
    if (next === "!" || next === "?") {
      flushText(lt);
      const close = html.indexOf(">", lt + 2);
      i = close === -1 ? n : close + 1;
      textStart = i;
      continue;
    }
    const isClose = next === "/";
    const nameStart = isClose ? lt + 2 : lt + 1;
    if (!/[A-Za-z]/.test(html[nameStart] ?? "")) {
      // A `<` that starts no tag is text.
      i = lt + 1;
      continue;
    }
    flushText(lt);
    let nameEnd = nameStart;
    while (nameEnd < n && NAME_CHAR.test(html[nameEnd] as string)) nameEnd += 1;
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const tag = readTag(html, nameEnd);
    tokens.push({
      kind: isClose ? "close" : "open",
      name,
      attrs: isClose ? new Map() : tag.attrs,
      selfClosing: tag.selfClosing,
      text: "",
    });
    i = tag.end;
    textStart = i;
    if (!isClose && RAW_TEXT.has(name)) {
      // Raw text runs to the element's own end tag, whatever it holds. The name is one of
      // RAW_TEXT's, so it is safe in the pattern.
      const endTag = new RegExp(`</${name}(?![A-Za-z0-9:_-])`, "gi");
      endTag.lastIndex = i;
      const end = endTag.exec(html)?.index ?? n;
      tokens.push({
        kind: "text",
        name: "",
        attrs: new Map(),
        selfClosing: false,
        text: html.slice(i, end),
      });
      i = end;
      textStart = i;
    }
  }
  flushText(n);
  return tokens;
}

/** The tokens as events in which every open element has its close, within its parent. */
function buildEvents(tokens: readonly Token[]): Event[] {
  const events: Event[] = [];
  /** Open elements: their name and their open event's index. */
  const stack: { name: string; at: number }[] = [];
  /** How many `svg` and `math` elements are open: inside them `/>` ends an element. */
  let foreign = 0;
  const closeTop = () => {
    const top = stack.pop() as { name: string; at: number };
    if (top.name === "svg" || top.name === "math") foreign -= 1;
    const at = events.length;
    events.push({ kind: "close", open: top.at });
    (events[top.at] as Extract<Event, { kind: "open" }>).close = at;
  };
  /** Closes up to and including the nearest open `first` or `second`, stopping at `stop`. */
  const closeNearest = (first: string, second: string, stop: ReadonlySet<string>) => {
    for (let k = stack.length - 1; k >= 0; k -= 1) {
      const name = (stack[k] as { name: string }).name;
      if (name === first || name === second) {
        while (stack.length > k) closeTop();
        return;
      }
      if (stop.has(name)) return;
    }
  };
  let html = false;
  let body = false;
  for (const token of tokens) {
    // `head` ends at the first thing that does not belong in it.
    if (stack.at(-1)?.name === "head") {
      const belongs =
        (token.kind === "text" && token.text.trim() === "") ||
        (token.kind === "open" && HEAD_CONTENT.has(token.name)) ||
        (token.kind === "close" && token.name !== "body" && token.name !== "html");
      if (!belongs) closeTop();
    }
    if (token.kind === "text") {
      events.push({ kind: "text", text: token.text });
      continue;
    }
    const { name } = token;
    if (token.kind === "close") {
      // The body and the document end with the page: text after them is still the page's.
      if (name === "body" || name === "html") continue;
      closeNearest(name, name, SCOPE.has(name) ? NOTHING : SCOPE);
      continue;
    }
    // A second `html` or `body` tag adds nothing.
    if (name === "html") {
      if (html) continue;
      html = true;
    }
    if (name === "body") {
      if (body) continue;
      body = true;
    }
    if (foreign === 0) {
      if (CLOSES_P.has(name)) closeNearest("p", "p", SCOPE);
      if (name === "li") closeNearest("li", "li", LIST_STOP);
      if (name === "dt" || name === "dd") closeNearest("dt", "dd", LIST_STOP);
      if (name === "tr") closeNearest("tr", "tr", TABLE);
      if (name === "td" || name === "th") closeNearest("td", "th", ROW);
      if (name === "thead" || name === "tbody" || name === "tfoot") {
        closeNearest("thead", "tbody", TABLE);
        closeNearest("tfoot", "tfoot", TABLE);
      }
      if (name === "a") closeNearest("a", "a", SCOPE);
      if (name === "option") closeNearest("option", "option", SELECT);
    }
    const isForeign = name === "svg" || name === "math";
    const at = events.length;
    events.push({ kind: "open", name, attrs: token.attrs, close: -1 });
    if (
      VOID.has(name) ||
      (token.selfClosing && (foreign > 0 || isForeign)) ||
      stack.length >= MAX_DEPTH
    ) {
      events.push({ kind: "close", open: at });
      (events[at] as Extract<Event, { kind: "open" }>).close = at + 1;
      continue;
    }
    if (isForeign) foreign += 1;
    stack.push({ name, at });
  }
  while (stack.length > 0) closeTop();
  return events;
}

const isDropped = (name: string, attrs: Attributes): boolean =>
  DROPPED.has(name) ||
  attrs.has("hidden") ||
  (attrs.get("aria-hidden") ?? "").trim().toLowerCase() === "true";

// ---------------------------------------------------------------------------------------------
// Writing the text

const HEADING = /^h([1-6])$/;
/** Elements that start and end on a line of their own. */
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "center",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "hgroup",
  "html",
  "legend",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "section",
  "summary",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "ul",
]);
/** Blocks set off by a blank line. The rest start on a new line only. */
const PARAGRAPH = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "dl",
  "figure",
  "footer",
  "header",
  "main",
  "nav",
  "ol",
  "p",
  "section",
  "table",
  "ul",
]);

/** The text writer: inline words with collapsed spaces, lines, blank lines and indents. */
class Writer {
  private parts: string[] = [];
  /** How many newlines the output ends with (2 or more: a blank line). */
  private trailing = 2;
  private space = false;
  private marker: string | null = null;
  /** The open links, outermost first: their URL, and whether their `[` is written. */
  links: { url: string | null; started: boolean }[] = [];
  indent = "";

  private put(text: string) {
    if (text === "") return;
    this.parts.push(text);
    const match = /\n*$/.exec(text) as RegExpExecArray;
    this.trailing =
      match[0].length === text.length ? this.trailing + text.length : match[0].length;
  }

  /** Starts the next text on a new line, or after a blank line. */
  breakLine(blank: boolean) {
    this.closeLinks();
    const want = blank ? 2 : 1;
    if (this.trailing < want) this.put("\n".repeat(want - this.trailing));
    this.space = false;
  }

  /** The `- ` of a list item: written before the item's first word. */
  listMarker(text: string) {
    this.breakLine(false);
    this.marker = text;
  }

  private startWord() {
    if (this.trailing > 0) {
      this.put(this.marker ?? this.indent);
      this.marker = null;
    } else if (this.space) {
      this.put(" ");
    }
    this.space = false;
    const link = this.links.at(-1);
    if (link?.url && !link.started) {
      this.put("[");
      link.started = true;
    }
  }

  /** Inline text: white space collapsed to one space between words. */
  text(text: string) {
    const words = text.split(/[ \t\n\r\f]+/);
    if (/^[ \t\n\r\f]/.test(text)) this.space = true;
    words.forEach((word, index) => {
      if (index > 0) this.space = true;
      if (word === "") return;
      this.startWord();
      this.put(word);
    });
  }

  /** One inline word that keeps its spaces: inline code. */
  word(text: string) {
    this.startWord();
    this.put(text);
  }

  /** A block kept verbatim between fence lines. */
  fenced(text: string) {
    this.breakLine(true);
    const body = text.replace(/^\n/, "").replace(/\s+$/, "");
    this.put(`\`\`\`\n${body}\n\`\`\``);
    this.breakLine(true);
  }

  rule() {
    this.breakLine(true);
    this.put("---");
    this.breakLine(true);
  }

  /** Writes `](url)` after each started link, so a link's text never spans lines. */
  private closeLinks() {
    for (const link of this.links) {
      if (link.url && link.started) {
        this.put(`](${link.url})`);
        link.started = false;
      }
    }
  }

  endLink() {
    const link = this.links.pop();
    if (link?.url && link.started) this.put(`](${link.url})`);
  }

  result(): string {
    return this.parts
      .join("")
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}

/** A link's URL when the tool could read it next: https on a listed host, port 443, no user. */
function keptLink(
  href: string | undefined,
  base: string,
  listed: ReadonlySet<string>,
): string | null {
  if (href === undefined || href.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(href.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
    return null;
  if (url.port !== "") return null;
  const host = canonicalHostName(url.hostname);
  if (host === undefined || !listed.has(host)) return null;
  url.hostname = host;
  return url.href;
}

/** The verbatim text of the events from `open` to its close: tags left out, `br` a newline. */
function verbatim(events: readonly Event[], open: number): string {
  const end = (events[open] as Extract<Event, { kind: "open" }>).close;
  let text = "";
  for (let i = open + 1; i < end; i += 1) {
    const event = events[i] as Event;
    if (event.kind === "text") text += event.text;
    else if (event.kind === "open") {
      if (isDropped(event.name, event.attrs)) i = event.close;
      else if (event.name === "br") text += "\n";
    }
  }
  return text;
}

/** The index of the open event of the first element `match` takes, outside dropped ones. */
function findOpen(
  events: readonly Event[],
  from: number,
  to: number,
  match: (name: string, attrs: Attributes) => boolean,
): number {
  for (let i = from; i < to; i += 1) {
    const event = events[i] as Event;
    if (event.kind !== "open") continue;
    if (isDropped(event.name, event.attrs)) {
      i = event.close;
      continue;
    }
    if (match(event.name, event.attrs)) return i;
  }
  return -1;
}

/**
 * The text of an HTML page, as the module's header describes: what a reader sees, from the
 * page's main content, or from the fragment's element when the URL has one.
 */
export function pageText(html: string, options: PageTextOptions): string {
  const events = buildEvents(tokenize(html));
  const listed = new Set(options.listedHosts);
  const closeOf = (open: number) =>
    (events[open] as Extract<Event, { kind: "open" }>).close;

  // A `<base href>` in the head changes where relative links point.
  let base = options.url;
  for (const event of events) {
    if (event.kind === "open" && event.name === "base" && event.attrs.has("href")) {
      try {
        base = new URL(event.attrs.get("href") as string, options.url).href;
      } catch {
        // A base that is not a URL is ignored, as a browser ignores it.
      }
      break;
    }
  }

  const bodyAt = findOpen(events, 0, events.length, (name) => name === "body");
  const body: [number, number] =
    bodyAt === -1 ? [0, events.length] : [bodyAt, closeOf(bodyAt)];
  const mainAt = findOpen(events, body[0], body[1], (name) => name === "main");
  const articleAt =
    mainAt === -1
      ? findOpen(events, body[0], body[1], (name) => name === "article")
      : -1;
  const rootAt = mainAt !== -1 ? mainAt : articleAt;
  let range: [number, number] = rootAt === -1 ? body : [rootAt, closeOf(rootAt) + 1];

  const writer = new Writer();
  const fragment = options.fragment ?? "";
  if (fragment !== "") {
    const target = findOpen(
      events,
      0,
      events.length,
      (name, attrs) =>
        attrs.get("id") === fragment ||
        (name === "a" && attrs.get("name") === fragment),
    );
    if (target === -1) {
      writer.text(NO_FRAGMENT_NOTE);
      writer.breakLine(true);
    } else {
      if (target < range[0] || target >= range[1]) range = body;
      range = [target, range[1]];
    }
  }

  /** The open list items' depth, for their indents. */
  let lists = 0;
  /** For each open table row, whether a cell has started. */
  const rows: boolean[] = [];
  /** The close index of each element whose end needs work, with the work. */
  const ends = new Map<number, () => void>();

  for (let i = range[0]; i < range[1]; i += 1) {
    const event = events[i] as Event;
    if (event.kind === "text") {
      writer.text(event.text);
      continue;
    }
    if (event.kind === "close") {
      ends.get(i)?.();
      ends.delete(i);
      continue;
    }
    const { name, attrs, close } = event;
    if (isDropped(name, attrs)) {
      i = close;
      continue;
    }
    const heading = HEADING.exec(name);
    if (heading) {
      writer.breakLine(true);
      writer.text(`${"#".repeat(Number(heading[1]))} `);
      ends.set(close, () => writer.breakLine(true));
      continue;
    }
    if (name === "pre") {
      writer.fenced(cleanControls(verbatim(events, i)));
      i = close;
      continue;
    }
    if (name === "code") {
      const code = cleanControls(verbatim(events, i));
      if (code.includes("\n")) writer.fenced(code);
      else if (code.trim() !== "") writer.word(`\`${code}\``);
      i = close;
      continue;
    }
    if (name === "br") {
      writer.breakLine(false);
      continue;
    }
    if (name === "hr") {
      writer.rule();
      continue;
    }
    if (name === "img") continue;
    if (name === "a") {
      writer.links.push({
        url: keptLink(attrs.get("href"), base, listed),
        started: false,
      });
      ends.set(close, () => writer.endLink());
      continue;
    }
    if (name === "li") {
      const outer = writer.indent;
      writer.listMarker(`${outer}- `);
      writer.indent = `${outer}  `;
      lists += 1;
      ends.set(close, () => {
        writer.breakLine(false);
        writer.indent = outer;
        lists -= 1;
      });
      continue;
    }
    if (name === "tr") {
      writer.breakLine(false);
      rows.push(false);
      ends.set(close, () => {
        rows.pop();
        writer.breakLine(false);
      });
      continue;
    }
    if (name === "td" || name === "th") {
      if (rows.length > 0) {
        if (rows[rows.length - 1]) writer.text(" | ");
        rows[rows.length - 1] = true;
      }
      continue;
    }
    if (BLOCK.has(name)) {
      const blank = PARAGRAPH.has(name) && lists === 0;
      writer.breakLine(blank);
      ends.set(close, () => writer.breakLine(blank));
    }
  }
  return cleanControls(writer.result());
}
