Minuet for VS Code
==================

Minimal syntax highlighting for the [Minuet](../minuet-spec.md) OIDC flow notation.

Highlighting rules
------------------

Derived from `minuet-spec.md`:

| Spec section | Highlighted as |
| --- | --- |
| §3.2 `//` comments | comment |
| §3.10 strings | string |
| §3.11 durations (`5s`, `5m`) | numeric (duration) |
| §8.5 status class (`4xx`) | numeric |
| numbers / status codes | numeric |
| §6 arrows (`=>`, `~>`, `..>`, `<~>`, `<..>`, `<-`) | operator |
| §7.4 sigils (`?{`, `#{`, `${`, `@{`) | operator |
| §3.8 HTTP methods | function/support |
| §3.9 keywords (`actors`, `flow`, `given`, `alt`, `or`, `opt`, `par`, `loop`, `do`, `fail`, ...) | keyword |
| paths (`/authorize`) | string-like |
| §3.4/3.7 ALLCAPS words (actors or constants) | type/entity |
| `==`, `!=`, `+`, `\|` | operator |
| braces, parens, `,` `;` `:` `=` | punctuation |
| §3.5 lowercase identifiers | variable |

This is intentionally minimal: a single-pass tokenizer grammar with no nested
scoping for flow names, `given` blocks, etc. It is good enough for readable
highlighting, but is not a full language server.

Installing
----------

No VS Code Marketplace publishing is required.

### Option A: copy into your extensions folder

```bash
cp -r vscode-minuet ~/.vscode/extensions/minuet-vscode-0.0.1
```

Then restart VS Code (or run "Developer: Reload Window").

### Option B: package as a `.vsix` and install that

```bash
npm install -g @vscode/vsce
cd vscode-minuet
vsce package
code --install-extension minuet-vscode-0.0.1.vsix
```

Once installed, opening any `.minuet` file (e.g. `../fixtures/code.minuet`)
shows syntax highlighting automatically, since VS Code matches by file
extension.
