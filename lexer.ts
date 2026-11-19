import type { Diagnostic, DiagnosticCode, Pos } from "./source.js";
import { KEYWORDS, METHODS } from "./tokens.js";
import type { DurationUnit, Keyword, LexResult, Method, PunctKind, Token } from "./tokens.js";

const KEYWORD_SET: ReadonlySet<string> = new Set(KEYWORDS);
const METHOD_SET: ReadonlySet<string> = new Set(METHODS);

// Longest first. See the lexing rules at the end of tokens.ts.
const MULTI_PUNCT: readonly PunctKind[] = ["<..>", "<~>", "..>", "=>", "~>", "<-", "==", "!="];
const SINGLE_PUNCT: ReadonlySet<string> = new Set([
  "{", "}", "(", ")", ",", ";", ":", "?", "#", "$", "@", "=", "+", "|",
]);

// Sticky regexes: each one matches only at `lastIndex`.
const RE_WORD = /[A-Za-z][A-Za-z0-9_-]*/y;
const RE_PATH = /\/[A-Za-z0-9_.\/-]*/y;
const RE_STATUS_CLASS = /[1-5]xx(?![A-Za-z0-9_-])/y;
const RE_DURATION = /([0-9]+)(ms|s|m|h)(?![A-Za-z0-9_-])/y;
const RE_NUMBER = /[0-9]+/y;
const RE_ALL_CAPS = /^[A-Z][A-Z0-9]*$/;

function matchAt(re: RegExp, source: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(source);
}

/** Spec 3.1: a file must use ASCII only. One diagnostic per non-ASCII character. */
function reportNonAscii(source: string, diagnostics: Diagnostic[]): void {
  let line = 1;
  let col = 1;
  for (let i = 0; i < source.length; ) {
    const cp = source.codePointAt(i) as number;
    const width = cp > 0xffff ? 2 : 1;
    const start: Pos = { offset: i, line, col };
    if (cp === 10) {
      line++;
      col = 1;
    } else {
      col += width;
    }
    if (cp > 0x7f) {
      diagnostics.push({
        severity: "error",
        code: "E_NON_ASCII",
        message: `Non-ASCII character U+${cp.toString(16).toUpperCase().padStart(4, "0")}`,
        span: { start, end: { offset: i + width, line, col } },
      });
    }
    i += width;
  }
}

export function lex(source: string): LexResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  reportNonAscii(source, diagnostics);

  let i = 0;
  let line = 1;
  let col = 1;
  const here = (): Pos => ({ offset: i, line, col });
  const advance = (n: number): void => {
    for (let k = 0; k < n; k++) {
      if (source.charCodeAt(i) === 10) {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };
  const fail = (code: DiagnosticCode, message: string, start: Pos): void => {
    diagnostics.push({ severity: "error", code, message, span: { start, end: here() } });
  };

  while (i < source.length) {
    const start = here();
    const c = source[i] as string;

    // 1. whitespace and comments
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      advance(1);
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") advance(1);
      continue;
    }

    // 2. non-ASCII: already reported by reportNonAscii, skip the whole character
    if (source.charCodeAt(i) > 0x7f) {
      advance((source.codePointAt(i) as number) > 0xffff ? 2 : 1);
      continue;
    }

    // 3. string
    if (c === '"') {
      advance(1);
      const from = i;
      while (i < source.length && source[i] !== '"' && source[i] !== "\n") advance(1);
      if (source[i] !== '"') {
        fail("E_UNTERMINATED_STRING", "String has no closing double quote", start);
        continue;
      }
      const value = source.slice(from, i);
      advance(1);
      tokens.push({
        kind: "string",
        text: source.slice(start.offset, i),
        value,
        span: { start, end: here() },
      });
      continue;
    }

    // 4. number, duration, status class
    if (c >= "0" && c <= "9") {
      const sc = matchAt(RE_STATUS_CLASS, source, i);
      if (sc) {
        advance(sc[0].length);
        tokens.push({ kind: "statusClass", text: sc[0], span: { start, end: here() } });
        continue;
      }
      const d = matchAt(RE_DURATION, source, i);
      if (d) {
        advance(d[0].length);
        tokens.push({
          kind: "duration",
          text: d[0],
          amount: Number(d[1]),
          unit: d[2] as DurationUnit,
          span: { start, end: here() },
        });
        continue;
      }
      const n = matchAt(RE_NUMBER, source, i) as RegExpExecArray;
      advance(n[0].length);
      tokens.push({ kind: "number", text: n[0], value: Number(n[0]), span: { start, end: here() } });
      continue;
    }

    // 5. word
    if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z")) {
      const text = (matchAt(RE_WORD, source, i) as RegExpExecArray)[0];
      advance(text.length);
      const span = { start, end: here() };
      if (KEYWORD_SET.has(text)) {
        tokens.push({ kind: "keyword", text: text as Keyword, span });
      } else if (METHOD_SET.has(text)) {
        tokens.push({ kind: "method", text: text as Method, span });
      } else if (RE_ALL_CAPS.test(text)) {
        tokens.push({ kind: "caps", text, span });
      } else {
        tokens.push({ kind: "ident", text, span });
      }
      continue;
    }

    // 6. path
    if (c === "/") {
      const text = (matchAt(RE_PATH, source, i) as RegExpExecArray)[0];
      advance(text.length);
      tokens.push({ kind: "path", text, span: { start, end: here() } });
      continue;
    }

    // 7. punctuation, longest match first
    let punct: PunctKind | undefined;
    for (const p of MULTI_PUNCT) {
      if (source.startsWith(p, i)) {
        punct = p;
        break;
      }
    }
    if (punct === undefined && SINGLE_PUNCT.has(c)) punct = c as PunctKind;
    if (punct !== undefined) {
      advance(punct.length);
      tokens.push({ kind: punct, text: punct, span: { start, end: here() } });
      continue;
    }

    // 8. anything else
    advance(1);
    fail("E_UNEXPECTED_CHAR", `Unexpected character "${c}"`, start);
  }

  const end = here();
  tokens.push({ kind: "eof", text: "", span: { start: end, end } });
  diagnostics.sort((a, b) => a.span.start.offset - b.span.start.offset);
  return { tokens, diagnostics };
}
