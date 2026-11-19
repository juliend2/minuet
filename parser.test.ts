import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "./parser.js";
import type { Span } from "./source.js";
import type {
  Alt, Binary, Call, Choice, Const, Deliver, Dur, Flow, Given, HttpRequest, HttpResponse,
  Local, Loop, Message, Opt, Par, Program, Str, Talk, Url, Var, Wait,
} from "./ast.js";

const HEAD = "actors C=client, A=authz, R=resource, U=user, B=browser\n";

/** Parse `body` as the body of one flow named `t`. */
function flowOf(body: string) {
  const r = parse(`${HEAD}flow t {\n${body}\n}`);
  const flow = r.program.decls[1] as Flow;
  return { stmts: flow.body, diagnostics: r.diagnostics, flow };
}
const codes = (src: string): string[] => parse(src).diagnostics.map((d) => d.code);

// ---------------------------------------------------------- fixture tests

const fixtureDir = new URL("../fixtures/", import.meta.url);
const fixtures = readdirSync(fixtureDir).filter((f) => f.endsWith(".minuet")).sort();

const flowNames: Record<string, string> = {
  "code.minuet": "code",
  "code-pkce.minuet": "code+pkce",
  "implicit.minuet": "implicit",
  "refresh.minuet": "refresh",
  "device.minuet": "device",
  "ciba-poll.minuet": "ciba+poll",
  "ciba-ping.minuet": "ciba+ping",
  "ciba-push.minuet": "ciba+push",
};

function checkSpans(node: unknown, parent: Span | undefined, size: number, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => checkSpans(n, parent, size, `${path}[${i}]`));
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  let current = parent;
  const span = obj["span"] as Span | undefined;
  if (span) {
    assert.ok(span.start.offset <= span.end.offset, `${path}: span start after end`);
    assert.ok(span.end.offset <= size, `${path}: span past end of file`);
    if (parent) {
      assert.ok(
        parent.start.offset <= span.start.offset && span.end.offset <= parent.end.offset,
        `${path}: span is not inside its parent`,
      );
    }
    current = span;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k !== "span" && k !== "origin") checkSpans(v, current, size, `${path}.${k}`);
  }
}

for (const name of fixtures) {
  test(`fixture ${name}: parses with no diagnostics`, () => {
    const source = readFileSync(new URL(name, fixtureDir), "utf8");
    const r = parse(source);
    assert.deepEqual(r.diagnostics, []);
    assert.equal(r.program.decls.length, 2);
    assert.equal(r.program.decls[0]?.kind, "actors");
    const flow = r.program.decls[1] as Flow;
    assert.equal(flow.kind, "flow");
    assert.equal(flow.name, flowNames[name]);
    assert.ok(flow.body.length > 0);
    checkSpans(r.program, undefined, source.length, "program");
  });
}

test("every fixture has an expected flow name", () => {
  assert.deepEqual(fixtures, Object.keys(flowNames).sort());
});

test("code+pkce: shape of the statement list", () => {
  const source = readFileSync(new URL("code-pkce.minuet", fixtureDir), "utf8");
  const flow = parse(source).program.decls[1] as Flow;
  assert.deepEqual(flow.body.map((s) => s.kind), [
    "given", "local", "message", "talk", "message", "local", "message", "local", "message",
  ]);
  const first = flow.body[2] as Message;
  assert.equal(first.arrow, "~>");
  const text = source.slice(first.span.start.offset, first.span.end.offset);
  assert.ok(text.startsWith("C ~> A GET /authorize"), text);
  assert.ok(text.endsWith("}"), text);
});

test("device: par has two branches and the second starts with a bounded loop", () => {
  const source = readFileSync(new URL("device.minuet", fixtureDir), "utf8");
  const flow = parse(source).program.decls[1] as Flow;
  const par = flow.body.find((s) => s.kind === "par") as Par;
  assert.equal(par.branches.length, 2);
  const loop = par.branches[1]?.[0] as Loop;
  assert.equal(loop.kind, "loop");
  assert.equal(loop.limit?.kind, "within");
  // slow_down reply: `do interval = interval + 5s; continue` has two actions
  const post = loop.body[1] as Message;
  const req = post.http as HttpRequest;
  const slow = req.replies?.[2];
  assert.deepEqual(slow?.actions?.map((a) => a.kind), ["assign", "continue"]);
});

test("ciba+ping: two given statements, one for each actor", () => {
  const source = readFileSync(new URL("ciba-ping.minuet", fixtureDir), "utf8");
  const flow = parse(source).program.decls[1] as Flow;
  const givens = flow.body.filter((s) => s.kind === "given") as Given[];
  assert.deepEqual(givens.map((g) => g.actor), ["C", "A"]);
});

test("ciba+poll: binding_message? is an optional input", () => {
  const source = readFileSync(new URL("ciba-poll.minuet", fixtureDir), "utf8");
  const flow = parse(source).program.decls[1] as Flow;
  const given = flow.body[0] as Given;
  const bm = given.binds.find((b) => b.name === "binding_message");
  assert.equal(bm?.optional, true);
});

// ------------------------------------------------------------ structure

test("response with a variable target and a query part", () => {
  const { stmts, diagnostics } = flowOf("A ~> C 302 redirect_uri ?{ code, state }");
  assert.deepEqual(diagnostics, []);
  const m = stmts[0] as Message;
  assert.equal(m.from, "A");
  assert.equal(m.to, "C");
  assert.equal(m.arrow, "~>");
  const http = m.http as HttpResponse;
  assert.equal(http.kind, "response");
  assert.equal(http.status, 302);
  assert.deepEqual(http.target && { kind: http.target.kind }, { kind: "varTarget" });
  assert.equal(http.parts[0]?.kind, "query");
  const part = http.parts[0];
  assert.deepEqual(part && "map" in part ? part.map.entries.map((e) => e.key) : [], ["code", "state"]);
});

test("request with replies: code, class, else, and do clauses", () => {
  const { stmts, diagnostics } = flowOf(`
    C => A POST /token \${ grant_type="authorization_code", code } {
      <- 200 { access_token, refresh_token? }
      <- 4xx do fail
      <- else do break
    }`);
  assert.deepEqual(diagnostics, []);
  const req = (stmts[0] as Message).http as HttpRequest;
  assert.equal(req.method, "POST");
  assert.deepEqual(req.target.kind === "path" && req.target.path, "/token");
  const form = req.parts[0];
  assert.equal(form?.kind, "form");
  const first = form && "map" in form ? form.map.entries[0] : undefined;
  assert.equal(first?.key, "grant_type");
  assert.equal((first?.value as Str).value, "authorization_code");
  assert.deepEqual(req.replies?.map((r) => r.status), [
    { kind: "code", code: 200 },
    { kind: "class", digit: 4 },
    { kind: "else" },
  ]);
  assert.deepEqual(req.replies?.[1]?.actions?.map((a) => a.kind), ["fail"]);
  assert.deepEqual(req.replies?.[2]?.actions?.map((a) => a.kind), ["break"]);
  const json = req.replies?.[0]?.parts[0];
  assert.equal(json?.kind, "json");
  const optional = json && "map" in json ? json.map.entries[1] : undefined;
  assert.equal(optional?.optional, true);
});

test("a bare { after a request is a JSON body, { <- starts replies", () => {
  const { stmts, diagnostics } = flowOf(`
    A => C POST client_notification_endpoint { auth_req_id } {
      <- 204
    }`);
  assert.deepEqual(diagnostics, []);
  const req = (stmts[0] as Message).http as HttpRequest;
  assert.equal(req.target.kind, "varTarget");
  assert.equal(req.parts[0]?.kind, "json");
  assert.deepEqual(req.replies?.map((r) => r.status), [{ kind: "code", code: 204 }]);
});

test("given: optional, default, and plain binds", () => {
  const { stmts, diagnostics } = flowOf("given C: a?, b=1, c");
  assert.deepEqual(diagnostics, []);
  const g = stmts[0] as Given;
  assert.deepEqual(g.binds.map((b) => [b.name, b.optional, b.defaultValue?.kind]), [
    ["a", true, undefined],
    ["b", false, "num"],
    ["c", false, undefined],
  ]);
});

test("given: an optional input cannot have a default", () => {
  const { diagnostics, stmts } = flowOf("given C: a?=1, b");
  assert.deepEqual(diagnostics.map((d) => d.code), ["E_SYNTAX"]);
  assert.equal((stmts[0] as Given).binds.length, 2); // parsing went on
});

test("expressions: + is left-associative, == compares, | makes a choice", () => {
  const { stmts, diagnostics } = flowOf(`
    C: x = "a" + b + 5s
    C: assert state == st
    A ~> C 400 ?{ error=invalid_grant | invalid_client }`);
  assert.deepEqual(diagnostics, []);
  const x = ((stmts[0] as Local).actions[0] as { value: Binary }).value;
  assert.equal(x.kind, "binary");
  assert.equal(x.op, "+");
  assert.equal((x.left as Binary).kind, "binary");
  assert.equal((x.left as Binary).op, "+");
  assert.equal((x.right as Dur).kind, "dur");
  assert.equal((x.right as Dur).amount, 5);
  assert.equal((x.right as Dur).unit, "s");

  const eq = ((stmts[1] as Local).actions[0] as { expr: Binary }).expr;
  assert.equal(eq.op, "==");

  const resp = (stmts[2] as Message).http as HttpResponse;
  const part = resp.parts[0];
  const field = part && "map" in part ? part.map.entries[0] : undefined;
  const choice = field?.value as Choice;
  assert.equal(choice.kind, "choice");
  assert.deepEqual(choice.options.map((o) => o.kind), ["var", "var"]);
});

test("url expression: actor and path with a query suffix", () => {
  const { stmts, diagnostics } = flowOf(
    "C => B 302 @{ Location=A/authorize ?{ client_id } }",
  );
  assert.deepEqual(diagnostics, []);
  const resp = (stmts[0] as Message).http as HttpResponse;
  const headers = resp.parts[0];
  const field = headers && "map" in headers ? headers.map.entries[0] : undefined;
  const url = field?.value as Url;
  assert.equal(url.kind, "url");
  assert.equal(url.target.kind, "actorPath");
  assert.equal(url.suffixes[0]?.sigil, "?");
  assert.equal(url.suffixes[0]?.map.entries[0]?.key, "client_id");
});

test("a bare variable is a Var, not a Url; ALLCAPS non-actor is a Const", () => {
  const { stmts, diagnostics } = flowOf(`
    C: a = redirect_uri
    C: ch = S256(v)
    C => A GET /authorize ?{ m=S256 }`);
  assert.deepEqual(diagnostics, []);
  assert.equal(((stmts[0] as Local).actions[0] as { value: Var }).value.kind, "var");
  const call = ((stmts[1] as Local).actions[0] as { value: Call }).value;
  assert.equal(call.kind, "call");
  assert.equal(call.name, "S256");
  const req = (stmts[2] as Message).http as HttpRequest;
  const q = req.parts[0];
  const f = q && "map" in q ? q.map.entries[0] : undefined;
  assert.equal((f?.value as Const).kind, "const");
});

test("named arguments in calls", () => {
  const { stmts, diagnostics } = flowOf("C: verify(id_token, nonce=n)");
  assert.deepEqual(diagnostics, []);
  const call = ((stmts[0] as Local).actions[0] as { call: Call }).call;
  assert.deepEqual(call.args.map((a) => a.name), [undefined, "nonce"]);
});

test("body part with a call", () => {
  const { stmts, diagnostics } = flowOf(`
    B => A GET verification_uri {
      <- 200 body html(code_entry)
    }`);
  assert.deepEqual(diagnostics, []);
  const req = (stmts[0] as Message).http as HttpRequest;
  const body = req.replies?.[0]?.parts[0];
  assert.equal(body?.kind, "rawBody");
  assert.equal(body && "expr" in body ? body.expr.kind : "", "call");
});

test("talk: human steps with labels and calls", () => {
  const { stmts, diagnostics } = flowOf(`
    A <~> U : authn, consent
    C <..> U : show(user_code)
    U => B : credentials`);
  assert.deepEqual(diagnostics, []);
  const [t1, t2, t3] = stmts as Talk[];
  assert.deepEqual(t1?.labels.map((l) => l.kind), ["var", "var"]);
  assert.equal(t2?.arrow, "<..>");
  assert.equal(t2?.labels[0]?.kind, "call");
  assert.equal(t3?.arrow, "=>");
});

test("deliver: a fragment handed to a script", () => {
  const { stmts, diagnostics } = flowOf("B ..> C #{ id_token, state }");
  assert.deepEqual(diagnostics, []);
  const d = stmts[0] as Deliver;
  assert.equal(d.kind, "deliver");
  assert.equal(d.parts[0]?.kind, "fragment");
});

test("control statements: alt/or, opt, par/and, loop", () => {
  const { stmts, diagnostics } = flowOf(`
    alt { C: a = 1 } or { C: b = 2 }
    opt { C: c = 3 }
    par { C: d = 4 } and { C: e = 5 }
    loop within expires_in { C: wait interval }
    loop until done { C: break }
    loop { C: wait until expired(access_token) }`);
  assert.deepEqual(diagnostics, []);
  assert.equal((stmts[0] as Alt).branches.length, 2);
  assert.equal((stmts[1] as Opt).body.length, 1);
  assert.equal((stmts[2] as Par).branches.length, 2);
  const l1 = stmts[3] as Loop;
  assert.equal(l1.limit?.kind, "within");
  assert.equal(l1.limit?.expr.kind, "var");
  assert.equal((stmts[4] as Loop).limit?.kind, "until");
  const l3 = stmts[5] as Loop;
  assert.equal(l3.limit, undefined);
  const wait = (l3.body[0] as Local).actions[0] as Wait;
  assert.equal(wait.until, true);
});

test("fail: with a reason, without one, and before the next statement", () => {
  const { stmts, diagnostics } = flowOf(`
    C: fail "boom"
    C: fail
    A <~> U : authn`);
  assert.deepEqual(diagnostics, []);
  assert.equal(stmts.length, 3);
  const f1 = (stmts[0] as Local).actions[0] as { kind: string; reason?: Str };
  assert.equal(f1.reason?.value, "boom");
  const f2 = (stmts[1] as Local).actions[0] as { kind: string; reason?: Str };
  assert.equal(f2.reason, undefined);
});

test("actors may be declared after a flow, in several declarations", () => {
  const r = parse("flow f { C: a = 1 }\nactors C=client\nactors A=authz");
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual((r.program as Program).decls.map((d) => d.kind), ["flow", "actors", "actors"]);
});

// ---------------------------------------------------------------- errors

test("E_UNDECLARED_ACTOR: reported once, parsing goes on", () => {
  const { diagnostics, stmts } = flowOf("X: a = 1");
  assert.deepEqual(diagnostics.map((d) => d.code), ["E_UNDECLARED_ACTOR"]);
  assert.equal(stmts.length, 1);
});

test("E_SYNTAX: a bad statement is skipped and the next one is parsed", () => {
  const { diagnostics, stmts } = flowOf("C: = 1\nC: x = 2");
  assert.deepEqual(diagnostics.map((d) => d.code), ["E_SYNTAX"]);
  assert.equal(stmts.length, 1);
  assert.equal(((stmts[0] as Local).actions[0] as { name: string }).name, "x");
});

test("E_SYNTAX: recovery skips a whole broken message with nested braces", () => {
  const { diagnostics, stmts } = flowOf(`
    C => A POST /token \${ a= } {
      <- 200 { x }
    }
    C: y = 1`);
  assert.deepEqual(diagnostics.map((d) => d.code), ["E_SYNTAX"]);
  assert.equal(stmts.length, 1);
  assert.equal(stmts[0]?.kind, "local");
});

test("E_SYNTAX: missing closing brace is reported once", () => {
  assert.deepEqual(codes(`${HEAD}flow t { C: a = 1`), ["E_SYNTAX"]);
});

test("E_SYNTAX: garbage at top level is skipped up to the next flow", () => {
  const r = parse("actors C=client\noops 123\nflow f { C: a = 1 }");
  assert.deepEqual(r.diagnostics.map((d) => d.code), ["E_SYNTAX"]);
  assert.deepEqual(r.program.decls.map((d) => d.kind), ["actors", "flow"]);
});

test("E_SYNTAX: status code must have three digits", () => {
  assert.deepEqual(codes(`${HEAD}flow t { A ~> C 99 }`), ["E_SYNTAX"]);
});

test("E_SYNTAX: a method name cannot be an actor name", () => {
  assert.deepEqual(codes("actors GET=x"), ["E_SYNTAX"]);
});

test("E_SYNTAX: a request needs a path or a variable", () => {
  assert.deepEqual(codes(`${HEAD}flow t { C => A GET }`), ["E_SYNTAX"]);
});

test("E_SYNTAX: an actor is not a value unless a path follows", () => {
  assert.deepEqual(codes(`${HEAD}flow t { C: x = A }`), ["E_SYNTAX"]);
});

test("lexer errors come through parse() too", () => {
  assert.ok(codes(`${HEAD}flow t { C: x = "oops }`).includes("E_UNTERMINATED_STRING"));
  assert.ok(codes(`${HEAD}flow t { C: x = 1 } // caf\u00e9`).includes("E_NON_ASCII"));
});

test("empty file: no declarations, no diagnostics", () => {
  const r = parse("");
  assert.deepEqual(r.program.decls, []);
  assert.deepEqual(r.diagnostics, []);
});
