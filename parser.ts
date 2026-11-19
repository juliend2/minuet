import { lex } from "./lexer.js";
import type { Diagnostic, DiagnosticCode, Pos, Span } from "./source.js";
import type { Token, TokenKind } from "./tokens.js";
import type {
  Action, ActorDef, ActorName, ActorsDecl, Alt, Arg, Bind, Call, Decl, Deliver, Expr, Field,
  Flow, Given, HttpRequest, HttpResponse, Label, Local, Loop, MapNode, MapPartKind, Message,
  Opt, Par, Part, Program, Reply, RequestTarget, StatusMatch, Stmt, Talk, Target, UrlSuffix,
} from "./ast.js";

export interface ParseResult {
  program: Program;
  diagnostics: Diagnostic[];
}

/** Lex and parse one source file. Never throws: errors are in `diagnostics`. */
export function parse(source: string): ParseResult {
  const lexed = lex(source);
  const parser = new Parser(lexed.tokens);
  const program = parser.parseProgram();
  const seen = new Set<string>();
  const diagnostics = [...lexed.diagnostics, ...parser.diagnostics]
    .sort((a, b) => a.span.start.offset - b.span.start.offset)
    .filter((d) => {
      const key = `${d.code}@${d.span.start.offset}:${d.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { program, diagnostics };
}

// ------------------------------------------------------------------ helpers

class ParseError extends Error {
  readonly span: Span;
  constructor(message: string, span: Span) {
    super(message);
    this.span = span;
  }
}

const STMT_ARROWS: ReadonlySet<string> = new Set(["=>", "~>", "<~>", "<..>", "..>"]);
const STMT_KEYWORDS: ReadonlySet<string> = new Set(["given", "alt", "opt", "par", "loop"]);
const SIGIL_KIND: Record<string, MapPartKind> = {
  "?": "query",
  "#": "fragment",
  $: "form",
  "@": "headers",
};

function describe(t: Token): string {
  return t.kind === "eof" ? "end of file" : `"${t.text}"`;
}

/** Actor names come only from `actors` declarations (spec 3.4). Scan them first, so order does not matter. */
function collectActors(tokens: Token[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t?.kind !== "keyword" || t.text !== "actors") continue;
    let j = i + 1;
    for (;;) {
      const n = tokens[j];
      const eq = tokens[j + 1];
      const label = tokens[j + 2];
      if (n?.kind === "caps" && eq?.kind === "=" && label?.kind === "ident") {
        names.add(n.text);
        j += 3;
      } else {
        break;
      }
      if (tokens[j]?.kind === ",") j++;
      else break;
    }
  }
  return names;
}

// ------------------------------------------------------------------- parser

class Parser {
  readonly diagnostics: Diagnostic[] = [];
  private pos = 0;
  private depth = 0; // number of "{" consumed and not yet closed
  private lastEnd: Pos;
  private readonly actors: Set<string>;

  constructor(private readonly tokens: Token[]) {
    this.lastEnd = tokens[0]?.span.start ?? { offset: 0, line: 1, col: 1 };
    this.actors = collectActors(tokens);
  }

  // ---- cursor ----

  private peek(k = 0): Token {
    return this.tokens[Math.min(this.pos + k, this.tokens.length - 1)] as Token;
  }
  private next(): Token {
    const t = this.peek();
    if (t.kind !== "eof") {
      this.pos++;
      this.lastEnd = t.span.end;
      if (t.kind === "{") this.depth++;
      else if (t.kind === "}") this.depth--;
    }
    return t;
  }
  private at(kind: TokenKind, k = 0): boolean {
    return this.peek(k).kind === kind;
  }
  private atKeyword(text: string, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === "keyword" && t.text === text;
  }
  private eat(kind: TokenKind): Token | undefined {
    return this.at(kind) ? this.next() : undefined;
  }
  private expect(kind: TokenKind, what: string = `"${kind}"`): Token {
    if (!this.at(kind)) throw this.err(`Expected ${what} but found ${describe(this.peek())}`);
    return this.next();
  }
  private startPos(): Pos {
    return this.peek().span.start;
  }
  private spanFrom(start: Pos): Span {
    return { start, end: this.lastEnd };
  }
  private err(message: string, tok: Token = this.peek()): ParseError {
    return new ParseError(message, tok.span);
  }
  private diag(code: DiagnosticCode, message: string, span: Span): void {
    this.diagnostics.push({ severity: "error", code, message, span });
  }
  private report(e: unknown): void {
    if (!(e instanceof ParseError)) throw e;
    this.diag("E_SYNTAX", e.message, e.span);
  }

  // ---- recovery ----

  private isStmtStartAt(i: number): boolean {
    const t = this.tokens[i];
    if (!t) return false;
    if (t.kind === "keyword") return STMT_KEYWORDS.has(t.text);
    if (t.kind === "caps") {
      const n = this.tokens[i + 1];
      return n !== undefined && (n.kind === ":" || STMT_ARROWS.has(n.kind));
    }
    return false;
  }

  /** Skip to the next statement of the block that is open at `blockDepth`, or to its closing brace. */
  private syncStmt(blockDepth: number): void {
    while (!this.at("eof")) {
      const t = this.peek();
      if (this.depth <= blockDepth && (t.kind === "}" || this.isStmtStartAt(this.pos))) break;
      this.next();
    }
  }

  private syncTop(): void {
    while (!this.at("eof") && !this.atKeyword("actors") && !this.atKeyword("flow")) this.next();
  }

  // ---- program ----

  parseProgram(): Program {
    const start = this.startPos();
    const decls: Decl[] = [];
    while (!this.at("eof")) {
      const before = this.pos;
      try {
        if (this.atKeyword("actors")) decls.push(this.parseActors());
        else if (this.atKeyword("flow")) decls.push(this.parseFlow());
        else throw this.err(`Expected "actors" or "flow" but found ${describe(this.peek())}`);
      } catch (e) {
        this.report(e);
        this.syncTop();
        if (this.pos === before) this.next();
      }
    }
    return { kind: "program", decls, span: this.spanFrom(start) };
  }

  private parseActors(): ActorsDecl {
    const start = this.startPos();
    this.next(); // actors
    const actors: ActorDef[] = [];
    do {
      const s = this.startPos();
      const name = this.peek();
      if (name.kind === "method") throw this.err(`${name.text} is reserved and cannot be an actor name`);
      if (name.kind !== "caps") throw this.err(`Expected an actor name but found ${describe(name)}`);
      this.next();
      this.expect("=");
      const label = this.peek();
      if (label.kind !== "ident") throw this.err(`Expected an actor label but found ${describe(label)}`);
      this.next();
      actors.push({ name: name.text, label: label.text, span: this.spanFrom(s) } satisfies ActorDef);
    } while (this.eat(","));
    return { kind: "actors", actors, span: this.spanFrom(start) };
  }

  private parseFlow(): Flow {
    const start = this.startPos();
    this.next(); // flow
    let name = this.expect("ident", "a flow name").text;
    while (this.at("+") && this.at("ident", 1)) {
      this.next();
      name += "+" + this.next().text;
    }
    const body = this.parseBlock();
    return { kind: "flow", name, body, span: this.spanFrom(start) };
  }

  private parseBlock(): Stmt[] {
    this.expect("{");
    const blockDepth = this.depth;
    const stmts: Stmt[] = [];
    while (!this.at("}") && !this.at("eof")) {
      const before = this.pos;
      try {
        stmts.push(this.parseStmt());
      } catch (e) {
        this.report(e);
        this.syncStmt(blockDepth);
        if (this.pos === before) this.next();
      }
    }
    this.expect("}");
    return stmts;
  }

  // ---- statements ----

  private parseStmt(): Stmt {
    const t = this.peek();
    if (t.kind === "keyword") {
      switch (t.text) {
        case "given":
          return this.parseGiven();
        case "alt":
          return this.parseAlt();
        case "opt":
          return this.parseOpt();
        case "par":
          return this.parsePar();
        case "loop":
          return this.parseLoop();
        default:
          throw this.err(`Unexpected ${describe(t)}`);
      }
    }
    if (t.kind === "caps") return this.parseActorStmt();
    throw this.err(`Expected a statement but found ${describe(t)}`);
  }

  private actorRef(): ActorName {
    const t = this.peek();
    if (t.kind !== "caps") throw this.err(`Expected an actor but found ${describe(t)}`);
    this.next();
    if (!this.actors.has(t.text)) {
      this.diag("E_UNDECLARED_ACTOR", `Actor ${t.text} is not declared`, t.span);
    }
    return t.text;
  }

  private parseActorStmt(): Local | Talk | Message | Deliver {
    const start = this.startPos();
    const from = this.actorRef();
    const second = this.peek();

    if (second.kind === ":") {
      this.next();
      const actions = this.parseActions();
      return { kind: "local", actor: from, actions, span: this.spanFrom(start) };
    }
    if (second.kind === "..>") {
      this.next();
      const to = this.actorRef();
      const parts = this.parseParts();
      return { kind: "deliver", from, to, parts, span: this.spanFrom(start) };
    }
    if (second.kind === "=>" || second.kind === "~>" || second.kind === "<~>" || second.kind === "<..>") {
      this.next();
      const to = this.actorRef();
      if (second.kind === "<~>" || second.kind === "<..>" || this.at(":")) {
        this.expect(":");
        const labels = this.parseLabels();
        return { kind: "talk", from, arrow: second.kind, to, labels, span: this.spanFrom(start) };
      }
      const http = this.parseHttp();
      return { kind: "message", from, arrow: second.kind, to, http, span: this.spanFrom(start) };
    }
    throw this.err(`Expected ":" or an arrow after actor ${from} but found ${describe(second)}`);
  }

  private parseGiven(): Given {
    const start = this.startPos();
    this.next(); // given
    const actor = this.actorRef();
    this.expect(":");
    const binds: Bind[] = [this.parseBind()];
    while (this.eat(",")) binds.push(this.parseBind());
    return { kind: "given", actor, binds, span: this.spanFrom(start) };
  }

  private parseBind(): Bind {
    const start = this.startPos();
    const name = this.expect("ident", "a variable name").text;
    let optional = false;
    let defaultValue: Expr | undefined;
    if (this.eat("?")) {
      optional = true;
      if (this.at("=")) {
        this.diag("E_SYNTAX", "An optional input cannot have a default value", this.peek().span);
        this.next();
        this.parseExpr(); // parse and drop, to keep going
      }
    } else if (this.eat("=")) {
      defaultValue = this.parseExpr();
    }
    const bind: Bind = { name, optional, span: this.spanFrom(start) };
    if (defaultValue) bind.defaultValue = defaultValue;
    return bind;
  }

  private parseLabels(): Label[] {
    const labels: Label[] = [this.parseLabel()];
    while (this.eat(",")) labels.push(this.parseLabel());
    return labels;
  }

  private parseLabel(): Label {
    const start = this.startPos();
    const t = this.peek();
    if (t.kind !== "ident") throw this.err(`Expected a label but found ${describe(t)}`);
    if (this.at("(", 1)) return this.parseCall();
    this.next();
    return { kind: "var", name: t.text, span: this.spanFrom(start) };
  }

  // ---- control ----

  private parseAlt(): Alt {
    const start = this.startPos();
    this.next();
    const branches = [this.parseBlock()];
    while (this.atKeyword("or")) {
      this.next();
      branches.push(this.parseBlock());
    }
    return { kind: "alt", branches, span: this.spanFrom(start) };
  }

  private parseOpt(): Opt {
    const start = this.startPos();
    this.next();
    const body = this.parseBlock();
    return { kind: "opt", body, span: this.spanFrom(start) };
  }

  private parsePar(): Par {
    const start = this.startPos();
    this.next();
    const branches = [this.parseBlock()];
    while (this.atKeyword("and")) {
      this.next();
      branches.push(this.parseBlock());
    }
    return { kind: "par", branches, span: this.spanFrom(start) };
  }

  private parseLoop(): Loop {
    const start = this.startPos();
    this.next();
    let limit: Loop["limit"];
    if (this.atKeyword("within") || this.atKeyword("until")) {
      const kind = this.next().text === "within" ? "within" : "until";
      limit = { kind, expr: this.parseExpr() };
    }
    const body = this.parseBlock();
    const loop: Loop = { kind: "loop", body, span: this.spanFrom(start) };
    if (limit) loop.limit = limit;
    return loop;
  }

  // ---- actions ----

  private parseActions(): Action[] {
    const actions = [this.parseAction()];
    while (this.eat(";")) actions.push(this.parseAction());
    return actions;
  }

  private parseAction(): Action {
    const start = this.startPos();
    const t = this.peek();
    if (t.kind === "keyword") {
      switch (t.text) {
        case "assert": {
          this.next();
          const expr = this.parseExpr();
          return { kind: "assert", expr, span: this.spanFrom(start) };
        }
        case "wait": {
          this.next();
          const until = this.atKeyword("until");
          if (until) this.next();
          const expr = this.parseExpr();
          return { kind: "wait", until, expr, span: this.spanFrom(start) };
        }
        case "break":
          this.next();
          return { kind: "break", span: this.spanFrom(start) };
        case "continue":
          this.next();
          return { kind: "continue", span: this.spanFrom(start) };
        case "fail": {
          this.next();
          if (this.canStartExpr()) {
            const reason = this.parseExpr();
            return { kind: "fail", reason, span: this.spanFrom(start) };
          }
          return { kind: "fail", span: this.spanFrom(start) };
        }
        default:
          throw this.err(`Expected an action but found ${describe(t)}`);
      }
    }
    if ((t.kind === "ident" || t.kind === "caps") && this.at("(", 1)) {
      const call = this.parseCall();
      return { kind: "invoke", call, span: this.spanFrom(start) };
    }
    if (t.kind === "ident" && this.at("=", 1)) {
      this.next();
      this.next();
      const value = this.parseExpr();
      return { kind: "assign", name: t.text, value, span: this.spanFrom(start) };
    }
    throw this.err(`Expected an action but found ${describe(t)}`);
  }

  // ---- http messages ----

  private parseHttp(): HttpRequest | HttpResponse {
    const start = this.startPos();
    const t = this.peek();

    if (t.kind === "method") {
      this.next();
      const target = this.parseRequestTarget();
      const parts = this.parseParts();
      let replies: Reply[] | undefined;
      if (this.at("{") && this.at("<-", 1)) replies = this.parseReplies();
      const request: HttpRequest = { kind: "request", method: t.text, target, parts, span: this.spanFrom(start) };
      if (replies) request.replies = replies;
      return request;
    }

    if (t.kind === "number") {
      const status = this.parseStatusCode();
      let target: RequestTarget | undefined;
      if (this.at("path") || this.at("ident")) target = this.parseRequestTarget();
      const parts = this.parseParts();
      const response: HttpResponse = { kind: "response", status, parts, span: this.spanFrom(start) };
      if (target) response.target = target;
      return response;
    }

    throw this.err(`Expected an HTTP method or a status code but found ${describe(t)}`);
  }

  private parseStatusCode(): number {
    const t = this.peek();
    if (t.kind !== "number" || t.text.length !== 3 || t.value < 100 || t.value > 599) {
      throw this.err(`Expected a status code (100 to 599) but found ${describe(t)}`);
    }
    this.next();
    return t.value;
  }

  private parseRequestTarget(): RequestTarget {
    const start = this.startPos();
    const t = this.peek();
    if (t.kind === "path") {
      this.next();
      return { kind: "path", path: t.text, span: this.spanFrom(start) };
    }
    if (t.kind === "ident") {
      this.next();
      return { kind: "varTarget", name: t.text, span: this.spanFrom(start) };
    }
    throw this.err(`Expected a path or a variable but found ${describe(t)}`);
  }

  private parseReplies(): Reply[] {
    this.expect("{");
    const replies: Reply[] = [];
    while (this.at("<-")) replies.push(this.parseReply());
    if (replies.length === 0) throw this.err(`Expected "<-" but found ${describe(this.peek())}`);
    this.expect("}");
    return replies;
  }

  private parseReply(): Reply {
    const start = this.startPos();
    this.expect("<-");
    const t = this.peek();
    let status: StatusMatch;
    if (t.kind === "number") {
      status = { kind: "code", code: this.parseStatusCode() };
    } else if (t.kind === "statusClass") {
      this.next();
      status = { kind: "class", digit: Number(t.text[0]) as 1 | 2 | 3 | 4 | 5 };
    } else if (t.kind === "keyword" && t.text === "else") {
      this.next();
      status = { kind: "else" };
    } else {
      throw this.err(`Expected a status code, a class like 4xx, or "else" but found ${describe(t)}`);
    }
    const parts = this.parseParts();
    let actions: Action[] | undefined;
    if (this.atKeyword("do")) {
      this.next();
      actions = this.parseActions();
    }
    const reply: Reply = { kind: "reply", status, parts, span: this.spanFrom(start) };
    if (actions) reply.actions = actions;
    return reply;
  }

  private parseParts(): Part[] {
    const parts: Part[] = [];
    for (;;) {
      const start = this.startPos();
      const t = this.peek();
      if ((t.kind === "?" || t.kind === "#" || t.kind === "$" || t.kind === "@") && this.at("{", 1)) {
        this.next();
        const map = this.parseMap();
        parts.push({ kind: SIGIL_KIND[t.kind] as MapPartKind, map, span: this.spanFrom(start) });
      } else if (this.atKeyword("body")) {
        this.next();
        const expr = this.parseExpr();
        parts.push({ kind: "rawBody", expr, span: this.spanFrom(start) });
      } else if (t.kind === "{" && !this.at("<-", 1)) {
        const map = this.parseMap();
        parts.push({ kind: "json", map, span: this.spanFrom(start) });
      } else {
        return parts;
      }
    }
  }

  private parseMap(): MapNode {
    const start = this.startPos();
    this.expect("{");
    const entries: Field[] = [];
    while (!this.at("}") && !this.at("eof")) {
      entries.push(this.parseField());
      if (!this.eat(",")) break;
    }
    this.expect("}");
    return { kind: "map", entries, span: this.spanFrom(start) };
  }

  private parseField(): Field {
    const start = this.startPos();
    const t = this.peek();
    if (t.kind !== "ident" && t.kind !== "caps") throw this.err(`Expected a key but found ${describe(t)}`);
    this.next();
    const optional = this.eat("?") !== undefined;
    let value: Expr | undefined;
    if (this.eat("=")) value = this.parseExpr();
    const field: Field = { kind: "field", key: t.text, optional, span: this.spanFrom(start) };
    if (value) field.value = value;
    return field;
  }

  // ---- expressions ----

  /** Can the next token start an expression? Used for the optional reason after `fail`. */
  private canStartExpr(): boolean {
    const t = this.peek();
    switch (t.kind) {
      case "string":
      case "number":
      case "duration":
      case "ident":
      case "path":
      case "(":
        return true;
      case "caps":
        // A declared actor starts a statement, unless a path follows (A/authorize).
        return !this.actors.has(t.text) || this.at("path", 1);
      default:
        return false;
    }
  }

  private parseExpr(): Expr {
    const start = this.startPos();
    const first = this.parseEqual();
    if (!this.at("|")) return first;
    const options = [first];
    while (this.eat("|")) options.push(this.parseEqual());
    return { kind: "choice", options, span: this.spanFrom(start) };
  }

  private parseEqual(): Expr {
    const start = this.startPos();
    const left = this.parseSum();
    const t = this.peek();
    if (t.kind === "==" || t.kind === "!=") {
      this.next();
      const right = this.parseSum();
      return { kind: "binary", op: t.kind, left, right, span: this.spanFrom(start) };
    }
    return left;
  }

  private parseSum(): Expr {
    const start = this.startPos();
    let left = this.parseAtom();
    while (this.at("+")) {
      this.next();
      const right = this.parseAtom();
      left = { kind: "binary", op: "+", left, right, span: this.spanFrom(start) };
    }
    return left;
  }

  private parseAtom(): Expr {
    const start = this.startPos();
    const t = this.peek();
    switch (t.kind) {
      case "string":
        this.next();
        return { kind: "str", value: t.value, span: this.spanFrom(start) };
      case "number":
        this.next();
        return { kind: "num", value: t.value, span: this.spanFrom(start) };
      case "duration":
        this.next();
        return { kind: "dur", amount: t.amount, unit: t.unit, span: this.spanFrom(start) };
      case "(": {
        this.next();
        const inner = this.parseExpr();
        this.expect(")");
        return inner;
      }
      case "path": {
        this.next();
        return this.parseUrlTail({ kind: "path", path: t.text, span: this.spanFrom(start) }, start);
      }
      case "ident": {
        if (this.at("(", 1)) return this.parseCall();
        this.next();
        return this.parseUrlTail({ kind: "varTarget", name: t.text, span: this.spanFrom(start) }, start);
      }
      case "caps": {
        if (this.at("(", 1)) return this.parseCall();
        if (this.actors.has(t.text)) {
          this.next();
          const p = this.peek();
          if (p.kind !== "path") {
            throw this.err(`An actor cannot be used as a value. Expected a path after ${t.text}`, p);
          }
          this.next();
          const target: Target = { kind: "actorPath", actor: t.text, path: p.text, span: this.spanFrom(start) };
          return this.parseUrlTail(target, start);
        }
        this.next();
        return { kind: "const", name: t.text, span: this.spanFrom(start) };
      }
      default:
        throw this.err(`Expected an expression but found ${describe(t)}`);
    }
  }

  /** Read `?{ }` and `#{ }` suffixes after a target. A bare variable stays a variable. */
  private parseUrlTail(target: Target, start: Pos): Expr {
    const suffixes: UrlSuffix[] = [];
    while ((this.at("?") || this.at("#")) && this.at("{", 1)) {
      const s = this.startPos();
      const sigil = this.next().kind === "?" ? "?" : "#";
      const map = this.parseMap();
      suffixes.push({ sigil, map, span: this.spanFrom(s) });
    }
    if (target.kind === "varTarget" && suffixes.length === 0) {
      return { kind: "var", name: target.name, span: this.spanFrom(start) };
    }
    return { kind: "url", target, suffixes, span: this.spanFrom(start) };
  }

  private parseCall(): Call {
    const start = this.startPos();
    const name = this.next().text;
    this.expect("(");
    const args: Arg[] = [];
    while (!this.at(")") && !this.at("eof")) {
      args.push(this.parseArg());
      if (!this.eat(",")) break;
    }
    this.expect(")");
    return { kind: "call", name, args, span: this.spanFrom(start) };
  }

  private parseArg(): Arg {
    const start = this.startPos();
    let name: string | undefined;
    if (this.at("ident") && this.at("=", 1)) {
      name = this.next().text;
      this.next();
    }
    const value = this.parseExpr();
    const arg: Arg = { value, span: this.spanFrom(start) };
    if (name !== undefined) arg.name = name;
    return arg;
  }
}
