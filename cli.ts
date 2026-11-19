#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parse } from "./parser.js";
import type { Flow } from "./ast.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: minuet [file] [--ast] [--spans]\n  Reads standard input when no file is given.\n  --ast    print the AST as JSON\n  --spans  keep source spans in the JSON");
  process.exit(0);
}
const showAst = args.includes("--ast");
const withSpans = args.includes("--spans");
const file = args.find((a) => !a.startsWith("--"));

const source = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
const name = file ?? "<stdin>";
const { program, diagnostics } = parse(source);

for (const d of diagnostics) {
  console.error(`${name}:${d.span.start.line}:${d.span.start.col}: ${d.severity} ${d.code}: ${d.message}`);
}

if (showAst) {
  const drop = (k: string, v: unknown) => (k === "span" || k === "origin" ? undefined : v);
  console.log(JSON.stringify(program, withSpans ? undefined : drop, 2));
} else {
  for (const d of program.decls) {
    if (d.kind === "flow") console.log(`flow ${(d as Flow).name}: ${(d as Flow).body.length} statements`);
  }
}

process.exit(diagnostics.some((d) => d.severity === "error") ? 1 : 0);
