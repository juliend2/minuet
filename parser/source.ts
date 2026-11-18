/** Position in a source file. `offset` starts at 0. `line` and `col` start at 1. */
export interface Pos {
  offset: number;
  line: number;
  col: number;
}

/** Half-open range: `start` is included, `end` is not. */
export interface Span {
  start: Pos;
  end: Pos;
}

export type Severity = "error" | "warning";

/** Every diagnostic has a stable code. Comments give the spec section. */
export type DiagnosticCode =
  // lexical and syntax
  | "E_NON_ASCII" // 3.1
  | "E_UNEXPECTED_CHAR"
  | "E_UNTERMINATED_STRING" // 3.10
  | "E_SYNTAX"
  // names
  | "E_UNDECLARED_ACTOR"
  | "E_BROWSER_NOT_DECLARED" // 4: a file that uses ~> must declare B
  // checks (spec section 12)
  | "E_LOOP_CONTROL_OUTSIDE_LOOP" // break / continue
  | "E_HTTP_TO_HUMAN" // => to or from U
  | "E_SUGAR_NEEDS_GET" // 11.4
  | "E_FRAGMENT_PLACEMENT" // #{ } outside 3xx, Location or ..>
  | "W_REPLIES_NOT_EXHAUSTIVE"
  | "W_LOOP_UNBOUNDED";

export interface Diagnostic {
  severity: Severity;
  code: DiagnosticCode;
  message: string;
  span: Span;
}
