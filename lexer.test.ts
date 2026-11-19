import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { lex } from "./lexer.js";
import type { Token } from "./tokens.js";

const kinds = (src: string): string[] => lex(src).tokens.map((t) => t.kind);
const pairs = (src: string): string[] => lex(src).tokens.map((t) => `${t.kind}:${t.text}`);

// ---------------------------------------------------------------- unit tests

test("arrows: longest match wins", () => {
  assert.deepEqual(kinds("=> ~> <~> <..> ..> <- == != ="), [
    "=>", "~>", "<~>", "<..>", "..>", "<-", "==", "!=", "=", "eof",
  ]);
});

test("words: method, caps, ident, keyword", () => {
  assert.deepEqual(pairs("GET C S256 Location WWW-Authenticate flow redirect_uri"), [
    "method:GET", "caps:C", "caps:S256", "ident:Location", "ident:WWW-Authenticate",
    "keyword:flow", "ident:redirect_uri", "eof:",
  ]);
});

test("flow names: + splits, - stays inside one word", () => {
  assert.deepEqual(pairs("code+pkce"), ["ident:code", "+:+", "ident:pkce", "eof:"]);
  assert.deepEqual(pairs("code-pkce"), ["ident:code-pkce", "eof:"]);
});

test("numbers, durations, status classes", () => {
  const toks = lex("200 5s 250ms 4xx 2m 1h").tokens;
  assert.deepEqual(toks.map((t) => t.kind), [
    "number", "duration", "duration", "statusClass", "duration", "duration", "eof",
  ]);
  const d = toks[2] as Extract<Token, { kind: "duration" }>;
  assert.equal(d.amount, 250);
  assert.equal(d.unit, "ms");
  const n = toks[0] as Extract<Token, { kind: "number" }>;
  assert.equal(n.value, 200);
});

test("a digit run followed by letters is a number and an ident", () => {
  assert.deepEqual(kinds("5x"), ["number", "ident", "eof"]);
});

test("paths are one token and keep dots and hyphens", () => {
  assert.deepEqual(pairs("/token /.well-known/openid-configuration A/authorize"), [
    "path:/token", "path:/.well-known/openid-configuration", "caps:A", "path:/authorize", "eof:",
  ]);
});

test("comments are skipped and lines are counted", () => {
  const toks = lex("a // note\nb").tokens;
  assert.deepEqual(toks.map((t) => t.kind), ["ident", "ident", "eof"]);
  const b = toks[1] as Token;
  assert.deepEqual(b.span.start, { offset: 10, line: 2, col: 1 });
});

test("strings keep their value without quotes", () => {
  const t = lex('"openid profile"').tokens[0] as Extract<Token, { kind: "string" }>;
  assert.equal(t.kind, "string");
  assert.equal(t.value, "openid profile");
  assert.equal(t.text, '"openid profile"');
});

test("sigils are separate tokens", () => {
  assert.deepEqual(kinds("?{ a } #{ b } ${ c } @{ d }"), [
    "?", "{", "ident", "}", "#", "{", "ident", "}",
    "$", "{", "ident", "}", "@", "{", "ident", "}", "eof",
  ]);
});

test("optional key: ident then ?", () => {
  assert.deepEqual(kinds("refresh_token?"), ["ident", "?", "eof"]);
});

test("E_NON_ASCII: one error per character, lexing goes on", () => {
  const r = lex("a \u00e9 b");
  assert.deepEqual(r.tokens.map((t) => t.kind), ["ident", "ident", "eof"]);
  assert.deepEqual(r.diagnostics.map((d) => d.code), ["E_NON_ASCII"]);
});

test("E_NON_ASCII: inside a comment too", () => {
  const r = lex("// caf\u00e9\na");
  assert.deepEqual(r.diagnostics.map((d) => d.code), ["E_NON_ASCII"]);
  assert.deepEqual(r.tokens.map((t) => t.kind), ["ident", "eof"]);
});

test("E_UNTERMINATED_STRING", () => {
  const r = lex('a "oops\nb');
  assert.deepEqual(r.diagnostics.map((d) => d.code), ["E_UNTERMINATED_STRING"]);
  assert.deepEqual(r.tokens.map((t) => t.kind), ["ident", "ident", "eof"]);
});

test("E_UNEXPECTED_CHAR: a lone ~ or ! and the removed ... token", () => {
  assert.deepEqual(lex("~").diagnostics.map((d) => d.code), ["E_UNEXPECTED_CHAR"]);
  assert.deepEqual(lex("!").diagnostics.map((d) => d.code), ["E_UNEXPECTED_CHAR"]);
  assert.ok(lex("...").diagnostics.length > 0);
});

test("empty input gives only eof", () => {
  assert.deepEqual(kinds(""), ["eof"]);
  assert.deepEqual(lex("").diagnostics, []);
});

// ------------------------------------------------------------ fixture tests

const fixtureDir = new URL("../fixtures/", import.meta.url);
const fixtures = readdirSync(fixtureDir).filter((f) => f.endsWith(".minuet")).sort();

/** Token kinds that each fixture must contain. */
const expected: Record<string, string[]> = {
  "code.minuet": ["~>", "<~>", "=>", "<-", "keyword", "method", "caps", "string"],
  "code-pkce.minuet": ["~>", "<~>", "=>", "<-", "caps", "path"],
  "implicit.minuet": ["~>", "<~>", "#"],
  "refresh.minuet": ["=>", "<-", "keyword"],
  "device.minuet": ["=>", "<~>", "<..>", "<-", "duration"],
  "ciba-poll.minuet": ["=>", "<..>", "<-", "duration"],
  "ciba-ping.minuet": ["=>", "<..>", "<-", "number"],
  "ciba-push.minuet": ["=>", "<..>", "<-", "number"],
};

test("every fixture file has an expectation", () => {
  assert.deepEqual(fixtures, Object.keys(expected).sort());
});

for (const name of fixtures) {
  test(`fixture ${name}: lexes with no diagnostics`, () => {
    const source = readFileSync(new URL(name, fixtureDir), "utf8");
    const r = lex(source);
    assert.deepEqual(r.diagnostics, []);

    // ends with exactly one eof
    assert.equal(r.tokens.at(-1)?.kind, "eof");
    assert.equal(r.tokens.filter((t) => t.kind === "eof").length, 1);

    // spans: non-empty, inside the source, in order, no overlap
    let prevEnd = 0;
    for (const t of r.tokens.slice(0, -1)) {
      assert.ok(t.span.start.offset < t.span.end.offset, `empty span for ${t.kind}:${t.text}`);
      assert.ok(t.span.start.offset >= prevEnd, `overlap at ${t.kind}:${t.text}`);
      assert.equal(source.slice(t.span.start.offset, t.span.end.offset), t.text);
      prevEnd = t.span.end.offset;
    }

    // the first real token is "actors", and a flow follows
    assert.equal(r.tokens[0]?.text, "actors");
    assert.ok(r.tokens.some((t) => t.kind === "keyword" && t.text === "flow"));

    // expected kinds are present
    const present = new Set(r.tokens.map((t) => t.kind));
    for (const k of expected[name] ?? []) {
      assert.ok(present.has(k as Token["kind"]), `${name} should contain a "${k}" token`);
    }

    // braces and parentheses balance
    const depth = { "{": 0, "(": 0 };
    for (const t of r.tokens) {
      if (t.kind === "{") depth["{"]++;
      if (t.kind === "}") depth["{"]--;
      if (t.kind === "(") depth["("]++;
      if (t.kind === ")") depth["("]--;
      assert.ok(depth["{"] >= 0 && depth["("] >= 0, "closing before opening");
    }
    assert.deepEqual(depth, { "{": 0, "(": 0 });
  });
}

test("device flow: both 5s durations are lexed", () => {
  const source = readFileSync(new URL("device.minuet", fixtureDir), "utf8");
  const durations = lex(source).tokens.filter((t) => t.kind === "duration");
  assert.equal(durations.length, 2);
});

test("code+pkce: S256 is a caps token, not a keyword or method", () => {
  const source = readFileSync(new URL("code-pkce.minuet", fixtureDir), "utf8");
  const s256 = lex(source).tokens.filter((t) => t.text === "S256");
  assert.ok(s256.length >= 2);
  assert.ok(s256.every((t) => t.kind === "caps"));
});
