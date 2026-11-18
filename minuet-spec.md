# Minuet language spec

Minimal specification, draft 0.1. This document uses Simplified Technical English (ASD-STE100 style).

## 1 Scope

This document defines a text notation for OpenID Connect (OIDC) flows. The notation shows the data that moves between parties. It shows HTTP methods, status codes, and parameters.

A program can read the notation. This version does not define the program.

The syntax does not use the spec terms "client" or "resource owner". Each party has a short name. The meaning of a name comes from its position in the flow.

## 2 Terms

| Term | Meaning |
| --- | --- |
| Actor | A party in a flow. Example: the client application. |
| Flow | A named list of statements. It shows one way to get tokens. |
| Message | One HTTP request or one HTTP response between two actors. |
| Reply | A response that is written inside the request that causes it. |
| Part | One piece of a message: query, fragment, form, header, or body. |
| Map | A list of keys in braces. A map holds the parameters of a part. |
| Browser | The user agent. The browser is an actor with the name B. |

## 3 Lexical rules

- 3.1 A file must use ASCII characters only.
- 3.2 A comment starts with `//` and ends at the end of the line.
- 3.3 A line break has no meaning.
- 3.4 An actor name has capital letters and digits. Example: `C`, `A`, `RS`. Only an actors declaration creates an actor name.
- 3.5 A variable name starts with a lowercase letter. It has lowercase letters, digits, and underscores. Example: `code_verifier`.
- 3.6 A key in a map can have capital letters and hyphens. Example: `WWW-Authenticate`.
- 3.7 A capital word that is not an actor is a constant. Example: `S256`.
- 3.8 These words are reserved: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`. An actor cannot have these names.
- 3.9 These words are keywords. A variable cannot have these names: `actors`, `flow`, `given`, `assert`, `wait`, `until`, `within`, `break`, `continue`, `fail`, `alt`, `or`, `opt`, `par`, `and`, `loop`, `do`, `else`, `body`.
- 3.10 A string is in double quotes. A string cannot contain a double quote in this version.
- 3.11 A duration is a number and a unit. The units are `ms`, `s`, `m`, and `h`. Example: `5s`.

## 4 File structure

A file has actors declarations and flows.

An actors declaration gives each actor a name and a label. The label is for people and tools. It has no effect on the flow.

A flow has a name and a block of statements in braces. A flow name is lowercase words that are joined with `+` or `-`.

```
actors C=client, A=authz, R=resource, U=user, B=browser

flow code+pkce {
  ...
}
```

**Note:** A file that uses `~>` must declare B. Section 11 gives the reason.

## 5 Statements

A block contains these statements.

**5.1 given.** It declares a value that an actor has before the flow starts. A bind with `=` sets a default.

```
given C: client_id, redirect_uri, scope="openid"
```

**5.2 Local actions.** An actor does work that no other actor can see. Separate the actions with `;`.

```
C: v = rand(64); ch = S256(v)
C: assert state == st
```

These actions exist: assignment, `assert`, `wait`, `break`, `continue`, `fail`, and function call.

**5.3 Human interaction.** A person acts. No HTTP message moves. Write labels only.

```
A <~> U : authn, consent
```

**5.4 Messages.** Sections 6 to 8 describe messages.

**5.5 Control.** Section 9 describes control statements.

## 6 Arrows

| Arrow | Meaning |
| --- | --- |
| `=>` | Direct HTTP between two actors. |
| `~>` | HTTP through the browser. The browser is implicit. |
| `..>` | The browser gives data to a script on the page. This is not HTTP. |
| `<~>` | A person acts through the browser. This is not HTTP. |
| `<..>` | A person acts outside the browser. Example: the person reads a code on a screen. |

## 7 Messages

**7.1** A request has a method, a target, parts, and optional replies.

```
C => A POST /token ${ grant_type="authorization_code", code }
```

**7.2** A response has a status code, an optional target, and parts. In a 3xx response, the target is the Location header.

```
A ~> C 302 redirect_uri ?{ code, state }
```

**7.3** A target is a path, a variable, or an actor and a path. Example: `/token`, `redirect_uri`, `A/authorize`.

**7.4** A part starts with a sigil.

| Part | Meaning |
| --- | --- |
| `?{ }` | Query string |
| `#{ }` | Fragment |
| `${ }` | Form-encoded body |
| `@{ }` | Headers |
| `{ }` | JSON body |
| `body expr` | Other body. Example: `body html(login)` |

## 8 Maps and replies

**8.1** A map has entries. A sent map and a received map use the entries in different ways.

| Entry | In a sent map | In a received map |
| --- | --- | --- |
| `name` | Sends the variable `name`. | Binds the received value to `name`. |
| `name=expr` | Sends the value of `expr`. | Matches the value of `expr`. |
| `name?` | Sends the key if it has a value. | The key can be absent. |
| `...` | Not allowed. | Other keys are allowed. |

**8.2** The symbol `|` gives alternative values. This entry matches one of two values.

```
<- 400 { error=invalid_grant | invalid_client }
```

**8.3** A reply starts with `<-`. A reply has a status, parts, and an optional `do` clause.

```
C => A POST /token ${ grant_type="authorization_code", code } {
  <- 200 { access_token, id_token, refresh_token?, expires_in }
  <- 400 { error=invalid_grant } do fail
}
```

**8.4** The reader tries the replies from top to bottom. The first reply that matches is the one that happens.

**8.5** A status is a code (`400`), a class (`4xx`), or `else`. The word `else` matches all other replies.

**8.6** A reply with no `do` clause continues to the next statement. A reply with a `do` clause runs its actions instead.

## 9 Control

- 9.1 `alt` ... `or` ...: Only one branch happens.
- 9.2 `opt`: The block can happen.
- 9.3 `par` ... `and` ...: The branches happen at the same time.
- 9.4 `loop`: The block repeats. `loop within d` fails when the duration `d` ends. `loop until e` stops when `e` is true.
- 9.5 `break` and `continue` are only for use in a loop. `fail` ends the flow with an error.
- 9.6 `wait` pauses one actor. Example: `wait 5s` or `wait until expired(access_token)`.
- 9.7 A variable keeps its value in each repeat of a loop.

This example polls the token endpoint. The server tells the client what to do next.

```
loop within expires_in {
  C: wait interval
  C => A POST /token ${ grant_type="urn:ietf:params:oauth:grant-type:device_code", device_code, client_id } {
    <- 200 { access_token, id_token }                do break
    <- 400 { error=authorization_pending }           do continue
    <- 400 { error=slow_down }                       do interval = interval + 5s; continue
    <- 400 { error=access_denied | expired_token }   do fail
  }
}
```

## 10 Expressions

- 10.1 The operator `+` joins strings. It also adds numbers and durations.
- 10.2 The operators `==` and `!=` compare two values.
- 10.3 A function call has a name and arguments. An argument can have a name. Example: `verify(id_token, nonce=n)`.
- 10.4 A URL expression has a target and `?` or `#` maps. Example: `A/authorize ?{ client_id }`.
- 10.5 These function names are in common use: `rand`, `S256`, `basic`, `default`, `expired`, `verify`, `show`, `notify`, `html`. This version does not define what they do.

## 11 Browser rule

The arrow `~>` is a short form. A tool must expand it before the tool checks the flow.

**11.1** A request with `~>` is the same as two explicit messages.

```
C ~> A GET /authorize ?{ client_id, state }
```

This is the same as:

```
C => B 302 @{ Location=A/authorize ?{ client_id, state } }
B => A GET /authorize ?{ client_id, state }
```

**11.2** A response with `~>` is the same as two explicit messages.

```
A ~> C 302 redirect_uri ?{ code, state }
```

This is the same as:

```
A => B 302 @{ Location=redirect_uri ?{ code, state } }
B => C GET redirect_uri ?{ code, state }
```

**11.3** A browser never sends a fragment to a server. A `#{ }` part goes in a `..>` statement. It does not go in the GET.

```
A ~> C 302 redirect_uri #{ id_token, state }
```

This is the same as:

```
A => B 302 @{ Location=redirect_uri #{ id_token, state } }
B => C GET redirect_uri
B ..> C #{ id_token, state }
```

**11.4** A request with `~>` must use GET. For a form post, write the explicit form with B.

**11.5** The arrow `<~>` has no expansion.

## 12 Checks

A tool must report an error in these cases:

- `break` or `continue` is not in a loop.
- A `<-` reply is not in a request.
- A `=>` message goes to or comes from U.
- A `~>` request uses a method other than GET.
- A `#{ }` part is not in a 3xx response, a Location value, or a `..>` statement.

A tool can give a warning in these cases:

- A list of replies has no `else`, and it does not cover all cases.
- A loop has no `within`, no `until`, and no reachable `break`.

## 13 Complete example

This flow is the authorization code flow with PKCE.

```
actors C=client, A=authz, R=resource, U=user, B=browser

flow code+pkce {
  given C: client_id, redirect_uri, scope="openid profile"
  C: v = rand(64); ch = S256(v); st = rand(); n = rand()

  C ~> A GET /authorize ?{
    response_type="code", client_id, redirect_uri, scope,
    state=st, nonce=n, code_challenge=ch, code_challenge_method=S256
  }
  A <~> U : authn, consent
  A ~> C 302 redirect_uri ?{ code, state }
  C: assert state == st

  C => A POST /token ${
    grant_type="authorization_code", code, redirect_uri, code_verifier=v
  } {
    <- 200 { access_token, id_token, refresh_token?, expires_in }
    <- 400 { error=invalid_grant | invalid_client, error_description? } do fail
  }
  C: verify(id_token, nonce=n)

  C => R GET /userinfo @{ Authorization="Bearer " + access_token } {
    <- 200 { sub, ... }
    <- 401 @{ WWW-Authenticate }
  }
}
```

## 14 Not yet defined

- `one(...)` and `any(...)`: a way to say that exactly one key (or at least one key) of a group is present. CIBA needs this for `login_hint`.
- Flow reuse, for example `extends`. The three CIBA flows repeat much of their text.
- Types for parameters.
- The symbol `<..>` can change.
- The behavior of the common functions in 10.5.

## Appendix A Grammar

```
(* lexical *)
ACTOR    = UPPER { UPPER | DIGIT } ;             (* only if declared by actors *)
WORD     = UPPER { UPPER | DIGIT } ;             (* constant, if not an ACTOR *)
IDENT    = LOWER { LOWER | DIGIT | "_" } ;
NAME     = ( LOWER | UPPER ) { LOWER | UPPER | DIGIT | "_" | "-" } ;
SEG      = SEGCH { SEGCH } ;
SEGCH    = LOWER | UPPER | DIGIT | "_" | "-" | "." ;
METHOD   = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" ;
STATUS   = DIGIT DIGIT DIGIT ;
STRING   = DQUOTE { char - DQUOTE } DQUOTE ;
NUMBER   = DIGIT { DIGIT } ;
DURATION = NUMBER ( "ms" | "s" | "m" | "h" ) ;
comment  = "//" { char } EOL ;

(* structure *)
file     = { actors | flow } ;
actors   = "actors" ACTOR "=" IDENT { "," ACTOR "=" IDENT } ;
flow     = "flow" fname block ;
fname    = IDENT { ( "+" | "-" ) IDENT } ;
block    = "{" { stmt } "}" ;
stmt     = given | local | talk | message | deliver | control ;

given    = "given" ACTOR ":" bind { "," bind } ;
bind     = IDENT [ "=" expr ] ;
local    = ACTOR ":" act { ";" act } ;
act      = IDENT "=" expr | "assert" expr
         | "wait" ( "until" expr | expr )
         | "break" | "continue" | "fail" [ expr ] | call ;
talk     = ACTOR ( "=>" | "~>" | "<~>" | "<..>" ) ACTOR ":" label { "," label } ;
label    = call | IDENT ;
deliver  = ACTOR "..>" ACTOR { part } ;

(* messages *)
message  = ACTOR ( "=>" | "~>" ) ACTOR ( request | response ) ;
request  = METHOD target { part } [ replies ] ;
response = STATUS [ target ] { part } ;
replies  = "{" reply { reply } "}" ;
reply    = "<-" ( STATUS | DIGIT "xx" | "else" ) { part }
           [ "do" act { ";" act } ] ;
target   = path | IDENT | ACTOR path ;
path     = "/" [ SEG { "/" SEG } ] ;
part     = "?" map | "#" map | "$" map | "@" map | "body" expr | map ;
map      = "{" [ entry { "," entry } [ "," ] ] "}" ;
entry    = NAME [ "?" ] [ "=" expr ] | "..." ;

(* control *)
control  = alt | opt | par | loop ;
alt      = "alt" block { "or" block } ;
opt      = "opt" block ;
par      = "par" block { "and" block } ;
loop     = "loop" [ ( "within" | "until" ) expr ] block ;

(* expressions *)
expr     = choice ;
choice   = equal { "|" equal } ;
equal    = sum [ ( "==" | "!=" ) sum ] ;
sum      = atom { "+" atom } ;
atom     = STRING | NUMBER | DURATION | WORD | call
         | target { ( "?" | "#" ) map }
         | "(" expr ")" ;
call     = NAME "(" [ arg { "," arg } ] ")" ;
arg      = [ IDENT "=" ] expr ;
```

**Parsing notes:**

- After a request, `{` followed by `<-` starts the replies. Any other `{` starts a JSON body.
- In an entry, `?` after a name means optional. `?` before `{` is the query sigil.
- Uppercase and lowercase letters tell actors and variables apart. The actors declaration is the only source of actor names.
