import type { Diagnostic, Span } from "./source";

export const KEYWORDS = [
  "actors", "flow", "given", "assert", "wait", "until", "within",
  "break", "continue", "fail", "alt", "or", "opt", "par", "and",
  "loop", "do", "else", "body",
] as const;
export type Keyword = (typeof KEYWORDS)[number];

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type Method = (typeof METHODS)[number];

export const DURATION_UNITS = ["ms", "s", "m", "h"] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

/**
 * Punctuation and operators. The kind is the text itself.
 *
 * Match longest first, in this order:
 *   "<..>"  "<~>"  "..>"  "..."  "=>"  "~>"  "<-"  "=="  "!="
 * then the single characters.
 */
export type PunctKind =
  // delimiters
  | "{" | "}" | "(" | ")" | "," | ";" | ":"
  // part sigils (a sigil is followed by "{")
  | "?" | "#" | "$" | "@"
  // operators
  | "=" | "+" | "|" | "==" | "!="
  // arrows
  | "=>" | "~>" | "<~>" | "<..>" | "..>" | "<-"
  // map rest entry
  | "...";

/**
 * Token kinds without extra data.
 *
 *  caps        All-caps word: /^[A-Z][A-Z0-9]*$/ that is not a method.
 *              The parser decides: an actor (if declared) or a constant (S256).
 *  ident       Any other word: /^[A-Za-z][A-Za-z0-9_-]*$/ that is not a keyword.
 *              Variable names, function names, and map keys (WWW-Authenticate).
 *  path        A whole path, one token: /^\/[A-Za-z0-9_.\/-]*$/  (for example /.well-known/jwks)
 *  statusClass A status class: /^[1-5]xx$/
 *  eof         End of input.
 */
export type SimpleKind = PunctKind | "caps" | "ident" | "path" | "statusClass" | "eof";

export type Token =
  | { kind: SimpleKind; text: string; span: Span }
  | { kind: "keyword"; text: Keyword; span: Span }
  | { kind: "method"; text: Method; span: Span }
  /** Double-quoted, no escapes in 0.1. `value` has no quotes. */
  | { kind: "string"; text: string; value: string; span: Span }
  /** Digits only. The parser reads a 3-digit number as a status code where one is expected. */
  | { kind: "number"; text: string; value: number; span: Span }
  /** Digits and a unit with no space: 5s, 250ms. */
  | { kind: "duration"; text: string; amount: number; unit: DurationUnit; span: Span };

export type TokenKind = Token["kind"];

export interface LexResult {
  tokens: Token[]; // always ends with an "eof" token
  diagnostics: Diagnostic[];
}

/*
 * Lexing rules, in order:
 *  1. Skip whitespace and "//" comments up to the end of the line.
 *  2. Report E_NON_ASCII for any character above 0x7F, then skip it.
 *  3. '"' starts a string. No closing quote on the same line: E_UNTERMINATED_STRING.
 *  4. A digit starts a number, a duration (digits + unit), or a statusClass (digit + "xx").
 *  5. A letter starts a word. Read letters, digits, "_" and "-", then classify:
 *       keyword -> "keyword", method -> "method", all caps -> "caps", otherwise "ident".
 *  6. "/" starts a path: read letters, digits, "_", ".", "-" and "/" as one token.
 *  7. Punctuation: longest match first (see PunctKind).
 *  8. Anything else: E_UNEXPECTED_CHAR, then skip it.
 */
