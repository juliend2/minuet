import type { Span } from "./source";
import type { DurationUnit, Method } from "./tokens";

/**
 * Every node has a span. A node that the `~>` expansion creates also has `origin`:
 * the span of the source statement that caused it. Diagnostics use `origin ?? span`.
 */
export interface AstNode {
  span: Span;
  origin?: Span;
}

export type ActorName = string;

// ---------------------------------------------------------------- program

export interface Program extends AstNode {
  kind: "program";
  decls: Decl[];
}

export type Decl = ActorsDecl | Flow;

export interface ActorsDecl extends AstNode {
  kind: "actors";
  actors: ActorDef[];
}

export interface ActorDef extends AstNode {
  name: ActorName; // C
  label: string; // client
}

export interface Flow extends AstNode {
  kind: "flow";
  name: string; // "code+pkce"
  body: Stmt[];
}

// ------------------------------------------------------------- statements

export type Stmt = Given | Local | Talk | Message | Deliver | Alt | Opt | Par | Loop;

export interface Given extends AstNode {
  kind: "given";
  actor: ActorName;
  binds: Bind[];
}

export interface Bind extends AstNode {
  name: string;
  defaultValue?: Expr;
}

export interface Local extends AstNode {
  kind: "local";
  actor: ActorName;
  actions: Action[];
}

/** Human interaction. No HTTP. Section 5.3. */
export interface Talk extends AstNode {
  kind: "talk";
  from: ActorName;
  arrow: "=>" | "~>" | "<~>" | "<..>";
  to: ActorName;
  labels: Label[];
}
export type Label = Var | Call;

export interface Message extends AstNode {
  kind: "message";
  from: ActorName;
  arrow: "=>" | "~>";
  to: ActorName;
  http: HttpRequest | HttpResponse;
}

/** What the `~>` expansion produces: only direct messages remain. */
export type ExplicitMessage = Message & { arrow: "=>" };

/** `B ..> C #{ ... }`. The browser gives data to a script. Section 11.3. */
export interface Deliver extends AstNode {
  kind: "deliver";
  from: ActorName;
  to: ActorName;
  parts: Part[];
}

export interface Alt extends AstNode {
  kind: "alt";
  branches: Stmt[][];
}
export interface Opt extends AstNode {
  kind: "opt";
  body: Stmt[];
}
export interface Par extends AstNode {
  kind: "par";
  branches: Stmt[][];
}
export interface Loop extends AstNode {
  kind: "loop";
  limit?: { kind: "within" | "until"; expr: Expr };
  body: Stmt[];
}

// ------------------------------------------------------------ http messages

export interface HttpRequest extends AstNode {
  kind: "request";
  method: Method;
  target: Target;
  parts: Part[];
  replies?: Reply[];
}

export interface HttpResponse extends AstNode {
  kind: "response";
  status: number;
  target?: Target; // in a 3xx response, the Location
  parts: Part[];
}

export interface Reply extends AstNode {
  kind: "reply";
  status: StatusMatch;
  parts: Part[];
  actions?: Action[]; // the `do` clause; absent means "continue to the next statement"
}

export type StatusMatch =
  | { kind: "code"; code: number } // 400
  | { kind: "class"; digit: 1 | 2 | 3 | 4 | 5 } // 4xx
  | { kind: "else" };

export type Target = PathTarget | VarTarget | ActorPathTarget;
export interface PathTarget extends AstNode {
  kind: "path";
  path: string; // "/token"
}
export interface VarTarget extends AstNode {
  kind: "varTarget";
  name: string; // redirect_uri
}
export interface ActorPathTarget extends AstNode {
  kind: "actorPath";
  actor: ActorName;
  path: string; // A/authorize
}

export type MapPartKind = "query" | "fragment" | "form" | "headers" | "json";
export interface MapPart extends AstNode {
  kind: MapPartKind; // ?  #  $  @  (bare)
  map: MapNode;
}
export interface RawBodyPart extends AstNode {
  kind: "rawBody"; // body html(login)
  expr: Expr;
}
export type Part = MapPart | RawBodyPart;

export interface MapNode extends AstNode {
  kind: "map";
  entries: MapEntry[];
}
export type MapEntry = Field | Rest;
export interface Field extends AstNode {
  kind: "field";
  key: string; // NAME: may have capitals and hyphens
  optional: boolean; // `scope?`
  value?: Expr; // `state=st`. Absent: bare key (send the variable, or bind it)
}
export interface Rest extends AstNode {
  kind: "rest"; // `...`
}

// ------------------------------------------------------------------ actions

export type Action = Assign | Assert | Wait | Break | Continue | Fail | Invoke;

export interface Assign extends AstNode {
  kind: "assign";
  name: string;
  value: Expr;
}
export interface Assert extends AstNode {
  kind: "assert";
  expr: Expr;
}
export interface Wait extends AstNode {
  kind: "wait";
  until: boolean; // `wait until e` vs `wait e`
  expr: Expr;
}
export interface Break extends AstNode {
  kind: "break";
}
export interface Continue extends AstNode {
  kind: "continue";
}
export interface Fail extends AstNode {
  kind: "fail";
  reason?: Expr;
}
/** A function call used as a statement. */
export interface Invoke extends AstNode {
  kind: "invoke";
  call: Call;
}

// -------------------------------------------------------------- expressions

export type Expr = Str | Num | Dur | Const | Var | Call | Url | Binary | Choice;

export interface Str extends AstNode {
  kind: "str";
  value: string;
}
export interface Num extends AstNode {
  kind: "num";
  value: number;
}
export interface Dur extends AstNode {
  kind: "dur";
  amount: number;
  unit: DurationUnit;
}
/** An all-caps word that is not an actor. Example: S256. */
export interface Const extends AstNode {
  kind: "const";
  name: string;
}
/** A bare lowercase name. The parser never makes a Url from a name with no suffix. */
export interface Var extends AstNode {
  kind: "var";
  name: string;
}
export interface Call extends AstNode {
  kind: "call";
  name: string;
  args: Arg[];
}
export interface Arg extends AstNode {
  name?: string; // verify(id_token, nonce=n)
  value: Expr;
}
/** A target with at least one `?{ }` or `#{ }` suffix. Example: A/authorize ?{ client_id }. */
export interface Url extends AstNode {
  kind: "url";
  target: Target;
  suffixes: UrlSuffix[];
}
export interface UrlSuffix extends AstNode {
  sigil: "?" | "#";
  map: MapNode;
}
/** `+` is left-associative: a + b + c is Binary(Binary(a, b), c). */
export interface Binary extends AstNode {
  kind: "binary";
  op: "+" | "==" | "!=";
  left: Expr;
  right: Expr;
}
/** Alternatives: invalid_grant | invalid_client. */
export interface Choice extends AstNode {
  kind: "choice";
  options: Expr[]; // at least 2
}
