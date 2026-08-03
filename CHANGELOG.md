# Changelog

All notable changes to StructX. The project follows [Semantic Versioning](https://semver.org/).

## [3.4.0] — 2026-08-01

### Added

#### Call-path tracing — `structx path` / `structx_path`

Trace how execution reaches a function, rather than listing one hop of
callers at a time:

```
$ structx path ClientProxy.emit

POST /
  AdvancedGrpcController.call            [integration/.../advanced.grpc.controller.ts:37]
    └─ ClientGrpcProxy.getService        [packages/microservices/client/client-grpc.ts:68]
      └─ ClientGrpcProxy.createServiceMethod
        └─ ClientGrpcProxy.createStreamServiceMethod
          └─ ClientProxy.emit            [packages/microservices/client/client-proxy.ts:111]
```

With `--from` it finds the chains between two functions; without it, it
starts from every HTTP endpoint that reaches the target — which is only
possible because of the route→handler links added in this release. Depth is
capped (default 8) and cycles terminate, so a recursive graph cannot hang
the search.

Pure graph query: no LLM cost, no API key.

#### File-based routes (Next.js, SvelteKit, Medusa v2)

Modern frameworks stopped registering routes with `app.get(...)`. They export
verb-named functions from a file whose *path* is the URL, and StructX saw
none of it — cal.com has 39 App Router `route.ts` and 46 `pages/api` files
that produced zero routes, and Medusa v2 yielded 8 routes for an entire
commerce platform.

Route modules are now recognised by convention and their URL derived from
the file path:

| file | route |
|---|---|
| `app/api/users/[id]/route.ts` | `/api/users/:id` |
| `app/(marketing)/api/leads/route.ts` | `/api/leads` |
| `app/api/docs/[...slug]/route.ts` | `/api/docs/*` |
| `pages/api/users/[id].ts` | `/api/users/:id` |
| `src/routes/users/+server.ts` | `/users` |
| `src/api/admin/orders/route.ts` | `/admin/orders` |

Each exported `GET` / `POST` / … becomes a route whose handler is that
function, so endpoint tracing works the same as it does for Express and
NestJS. Next.js route groups `(marketing)` and private `_folders` are
dropped since they do not appear in the URL, and `[...slug]` becomes `*`.
A function named `GET` outside a route module stays an ordinary function.

Note `api` is read differently per convention: under `app/` it is a real URL
segment (Next.js), while `src/api/` is itself the routing root (Medusa).

#### Inline Express route handlers are now part of the graph

`router.get('/articles', async (req, res) => { ... })` — the dominant Express
idiom — produced no function row in any prior version. The parser only
extracted arrow functions assigned to a variable, so an Express app's entire
controller layer was missing: no call edges, no impact analysis, nothing for
a route to link to. On a real Express app (gothinkster/realworld), 0 of 21
routes could be linked to a handler.

Inline handlers are now extracted as functions named after the route they
serve (`GET /articles`), which makes them ordinary graph nodes — they carry
call edges, appear in search and impact analysis, and give `structx path`
somewhere to start:

```
$ structx path login

POST /users/login  [src/app/routes/auth/auth.controller.ts:30]
  login            [src/app/routes/auth/auth.service.ts:84]
```

Same app, after: **20 of 21 routes linked** (the remaining one mounts a
sub-router rather than a handler), functions 31 → 51, traversable nodes
6 → 18. NestJS and hono graphs are byte-identical — decorator routes and
libraries are unaffected.

Two consequences worth knowing:

- **Route handlers are excluded from dead-code analysis.** A handler has no
  caller by construction — the inbound edge is an HTTP request the graph
  cannot see. Reporting them as "internal, almost certainly safe to remove"
  would have advised deleting the API.
- **Calls inside a handler belong to the handler**, not to an enclosing
  `registerRoutes()` that merely registers it.

#### Semantic filtering — `structx query` / `structx_query`

Filter functions by what they *do* instead of what they are called:

```
$ structx query --domain database --side-effect write --exported
```

Domain, side effects and complexity have been generated and stored for every
analyzed function since 1.0, but the only way to reach them was a
natural-language `ask` — the most expensive data in the graph was
effectively write-only. This turns it into an index. Structural filters
(`--name`, `--file`, `--exported`, `--async`) work without any analysis
having run; calling with no filters reports which domains exist rather than
dumping the graph.

#### Type-resolved call graph

Call edges are now resolved through the TypeScript type checker instead of by
name alone. When a call site is reached, ts-morph is asked which declaration
it actually targets — following imports, aliases, re-exports and method
dispatch — and the declaration site is stored on the edge
(`relationships.callee_decl_file` / `callee_decl_name`).

This closes a correctness gap rather than adding a new query. Previously, a
repo with two functions named `save` produced one of three outcomes: an
unbound edge, or a bound edge chosen by whichever file was ingested first.
The second case is the dangerous one — a confidently wrong edge that impact
analysis then reports as fact. With resolution on, `import { save } from
'./z-store'` binds to z-store's `save`, regardless of ingest order. There is
a regression test asserting exactly that, including the wrong-binding
behavior it replaces.

Resolution is *sound about what it skips*: a declaration in repo source can
only reach a call site through an import or a local declaration, so calls
whose target is neither are never handed to the checker. That keeps
`JSON.parse`, `.map`, and `db.prepare` out of the expensive path, and they
stay unbound — which is correct, since they are not repo functions.

The post-ingest resolver now runs the checker-resolved pass *first*, and it
overwrites existing bindings. An exact target beats a name guess.

Measured by ingesting four real repositories twice each — once with
resolution, once without — and diffing the resulting graphs edge by edge:

| repo | files | bound edges (name → checker) | edges corrected | regressions | ingest time |
|---|---|---|---|---|---|
| nest    | 972 | 1420 → 2478 (+1058) | 5 (0.4%) | 0 | 194s → 178s (−8%) |
| zod     | 212 | 393 → 1035 (+642)   | 24 (6.1%) | 0 | 34.7s → 55.8s (+61%) |
| hono    | 186 | 582 → 619 (+37)     | 8 (1.4%) | 0 | 11.5s → 33.5s (+191%) |
| structx | 37  | 379 → 393 (+14)     | 0 | 0 | 15.2s → 23.2s (+53%) |

"Edges corrected" are call edges where name matching bound to a *different*
function than the checker — silently wrong edges in every prior version. zod
is the clearest case: it vendors v3 and v4 side by side, so calls inside v3
were binding into v4's identically-named files. No repo lost a single edge
that name matching had bound (`regressions: 0`).

Ingest cost varies with import-graph density rather than file count, from
−8% to +191%; there is no single multiplier to quote. Set
`"typeResolution": false` in `.structx/config.json` to fall back to the
pre-3.4 name-based resolver.

Be aware what that switch actually buys, though: on cal.com (3,763 files)
ingest takes 3,012s with resolution and 2,416s without — the checker is only
~20% of the cost, and the remaining 80% is the base parse. Disabling
resolution is not a fix for slow ingest on a large monorepo; it costs 1,359
bound edges (−19%) to save a fifth of the time.

#### Routes linked to their handler functions

`routes.handler_function_id` now points at the `functions` row implementing
each endpoint, bound in-file during ingest and cross-file by the post-ingest
`resolveRouteHandlers` pass (same-file first, then unique-name-only —
ambiguous handlers stay NULL rather than guessing).

The payoff is in impact analysis: `structx_impact` and `impactAnalysis()`
now return the HTTP endpoints whose handlers sit in the blast radius, not
just the calling functions. "What breaks if I change `validateSession`" now
answers with `GET /users/:id`, which is usually the part that matters.
Routes with inline arrow handlers have no function row and are unaffected.

Verified against the NestJS repository: all 174 detected decorator routes
linked to a handler, 174 distinct functions, zero name mismatches between
the declared handler and the linked row.

#### CommonJS export extraction

`exports.foo = function () {}` and `module.exports.foo = () => {}` are now
extracted as functions. `.js` has been in `TS_EXTENSIONS` since 3.0, but the
extractors only recognised ES-module and class syntax — Express yielded 11
functions from 141 files. Support is better, not complete: `require()` is
still not an import declaration and prototype assignments
(`app.get = function`) are still missed, so CommonJS call edges largely stay
unbound.

### Fixed

- **Decorator applications were recorded as call edges.** On NestJS this made
  `Body` look like the most depended-upon function in the repo, and
  "what breaks if I change `Body`" answered with 58 endpoints. Decorators
  describe how a framework wires a function up, not what it invokes; routes
  are captured separately by the route extractor. Removing them dropped
  nest's call-edge count from 5791 to 5261 and left the top handler
  dependencies as real services.
- **Any `.get('/…')` call was treated as an HTTP route.** A route
  registration always passes a handler after the path, so single-argument
  calls and calls whose last argument is a string are no longer routes. The
  TypeScript compiler repo reported 29 phantom endpoints from
  `map.get('/foo/bar')` in its test suite; it now reports 0, while nest's
  174 genuine routes are unaffected.
- **A locked graph crashed with a raw stack trace.** Running `structx ingest`
  while `structx watch` holds the write lock produced an unhandled
  `SqliteError: database is locked` dump that named neither the cause nor the
  fix. Connections now wait up to 10s for a contended lock (WAL contention is
  usually momentary), and a genuine conflict reports which process to stop.
- **NestJS's `@Controller({ path: '...' })` options form was not read.** Only
  the string and enum-member forms were handled, so controllers using the
  officially supported options object lost their base path entirely: on
  cal.com's v2 API, 21% of routes collapsed to `/` and the rest surfaced as
  bare fragments like `/:webhookId`. Now 0% collapse, and paths resolve in
  full (`GET /v2/atoms/auth/oauth2/clients/:clientId`). Array paths
  (`path: ['a', 'b']`) take the first entry.
- **`--provider gemini` was silently ignored.** CLI validation accepted only
  anthropic and openrouter in all six branches, so the flag fell through to
  whatever config or env specified, despite Gemini being fully supported.
- **Cost telemetry now uses the provider's own figure when it reports one.**
  OpenRouter returns an exact `usage.cost` on every response — streaming
  included — and StructX ignored it in favour of a local price table that
  cannot know the hundreds of models OpenRouter routes to. An unknown model
  fell through to a $1/$5-per-M placeholder: a real `mistral-small` analyze
  run reported **$0.0054 against an actual charge of ~$0.00015, a 37x
  overstatement**. Verified end-to-end against the live API; the same run now
  reports $0.0001. `estimateCost` remains the fallback for providers that do
  not report cost (Anthropic, Gemini).
- **OpenRouter runs were mispriced.** `anthropic/claude-haiku-4.5` and
  `anthropic/claude-sonnet-4.5` — the models `OPENROUTER_DEFAULTS` actually
  selects — were absent from the pricing table, so every default OpenRouter
  run fell through to a generic $1/$5 estimate and `structx_costs` reported
  fiction.
- **`structx analyze` ignored fatal provider errors.** `setup` has always
  stopped on a 402/401; `analyze` dropped the abort flag and kept issuing
  doomed requests, then reported a large "Failed: N" with no reason.
- **`include_body` silently did nothing for fuzzy matches.** `structx_function`
  zipped bodies to results by array index against a lookup that returns
  nothing when the name resolved via the unqualified fallback (`add` →
  `RegExpRouter.add`). Bodies are now matched by location.
- `vitest run` collected the full repo copies under `.claude/worktrees/`,
  running four stale versions of the suite alongside the real one (41 files
  / 214 tests instead of 13 / 74). Those copies passed against old code and
  would have masked regressions in `src/`.

### Not changed, and why

**Ingest still parses every file twice** — once for entities, once for call
relationships. Sharing a single AST between the two extractors is the obvious
optimization and it was implemented, measured, and reverted: on nest it made
ingest 23% slower (205s → 253s) and doubled peak heap (410MB → 819MB).

The redundant parse turns out to be load-bearing. Each `removeSourceFile`
invalidates ts-morph's `Program`, which evicts the transitive dependency
graph the type checker pulls in while resolving call targets. Holding one
AST across both extractors removes that eviction, so the `Program` grows for
the whole run and every later checker query pays for it. Re-parsing a file
is cheaper than the memory that eviction reclaims.

Large-monorepo ingest is therefore still slow (cal.com: ~50 minutes) and no
fix ships in this release. `parseSourceFile` and `extractCallsFromSourceFile`
are exported for callers that already hold a `SourceFile`.

### Added (defensive)

Ingest now samples heap usage every 25 files and, on approaching V8's limit,
degrades to name matching for the remainder of the run with an actionable
message rather than letting the process die silently. This has not fired in
testing — nest peaks at 468 MB and the TypeScript compiler repo at 1.4 GB,
both well inside a default heap — so it is insurance, not a fix for an
observed failure.

### Migration

Both features add nullable columns to existing tables. Databases created
before 3.4.0 migrate in place on first open — verified against a real 3.3.1
graph (512 functions, 2309 relationships, all bindings preserved). The new
columns populate on the next `structx ingest`; until then the graph behaves
exactly as it did on 3.3.1.

## [3.3.1] — 2026-05-09

### Added

#### Inheritance-aware impact analysis

`structx_impact` and `impactAnalysis()` now follow type-graph edges to
include method overrides + their callers. Closes a real correctness gap
in any OO codebase: changing `BaseService.run()` previously flagged
only direct callers of `BaseService.run`, missing every override
(`UserService.run`, `TaskService.run`) and every caller of those
overrides via polymorphic dispatch (`const svc = new UserService();
svc.run()`).

The change combines three things:

  1. **Walk subtypes transitively** via `type_relationships` (introduced
     in v3.3.0) — Animal → Dog → Poodle finds Poodle.run when the user
     asks about Animal.run.
  2. **Pull each override into the impact set** — they are functions
     that share the contract being changed.
  3. **Over-include ambiguous callers** — `svc.run()` is recorded with
     the variable's text (`svc.run`), which the conservative resolver
     leaves NULL when multiple `*.run` methods exist. For impact
     analysis we deliberately accept the false-positive risk: missing
     a real caller is far worse than including a maybe-not-this-one.

Free functions (no dot in name) skip this entirely — there's no
heritage to walk.

### Battle-test verification (round 7 — Stencil/Ionic)

Cloned ionic-team/ionic-framework (~9000 files, ~1800 TS in core/) and
ingested. **281 Stencil components extracted** — every `@Component({ tag: 'ion-X' })` correctly captured with its tag and class name. Web-component
support from v3.3.0 verified end-to-end on real production code. **0 new
bugs found in this round.**

### Tests

78 passing across 17 files (was 77).
- `impact analysis includes method overrides AND their callers
  (polymorphic dispatch)` — base + 2 overrides + 2 bootstrap callers
  all flagged.

## [3.3.0] — 2026-05-08

Closes the three remaining "deferred / known limitation" items from
v3.2.0. All three were noted in the v3.2.0 release notes as follow-ups;
this release ships them.

### Added

#### Tsconfig path resolution

When the repo has a `tsconfig.json` with `paths` and `baseUrl`, StructX
now reads it and configures ts-morph's TypeChecker accordingly.
Concretely, `import { RouteKey } from 'src/enum'` (path-aliased) now
resolves correctly during `@Controller(RouteKey.Asset)` argument
extraction — producing `/assets/:id` (the real enum value) instead of
falling back to the `/asset/:id` heuristic. The discovery walks:

  1. `<repo>/tsconfig.json`
  2. otherwise the most-populated direct subdir's tsconfig
     (`server/tsconfig.json`, `app/tsconfig.json`, etc.)
  3. monorepo `packages/<X>/tsconfig.json` files, picking the one
     covering the most TS files

JSONC comments and `extends` chains (depth ≤ 5) are tolerated.
Verified end-to-end on a synthetic immich-style fixture: enum literal
values resolve through path-aliased imports.

#### Type-graph relationships

New `type_relationships` table tracks `class extends Y`, `class
implements Z`, and `interface extends Y` edges. Stored by name so
edges record before all types are ingested; a second-pass resolver
binds `supertype_id` when the parent type is in the graph (mirroring
the function-call resolver pattern).

New `structx_type_graph` MCP tool answers refactor-shaped questions
that the call graph couldn't:

  - `direction: "subtypes"` — "what classes extend Foo? what
    implements Repository?"
  - `direction: "supertypes"` — "what does UserService extend / implement?"

Schema migrated automatically on `openDatabase` for existing DBs.
**14 MCP tools now** (was 13).

#### Web Component custom elements

Stencil `@Component({ tag: 'my-counter' })` (and `selector`-style
Angular variants) plus Lit `@customElement('my-element')` decorators
are extracted as routes with method `COMPONENT` and path equal to
the registered tag (`/my-counter`). Lets the agent answer "what
custom elements does this codebase register?" via the existing
`structx_list { entity: 'routes' }` and `structx_route` tools.

### Tests

77 passing across 17 files (was 74 in `96c2c8f`).
- `captures class extends + interface extends + class implements as type heritage`
- `extracts Web Component custom-element registrations as COMPONENT routes`
- `resolves path-aliased imports via tsconfig for decorator enum args`
- updated tools/list test for the new `structx_type_graph` tool

## [3.2.0] — 2026-05-08

Major capability release. Closes the four largest functional gaps from
v3.1's "honest gaps" section — bundling them so users get one significant
upgrade rather than a stream of patch releases. Bundles all v3.1.1
battle-test fixes too (it was never published).

### Added — feature-shaped

#### Decorator-based routes (NestJS, Tsoa, routing-controllers)

The route extractor previously knew only Express-style `app.get('/path',
handler)`. Class-decorator routes — the dominant pattern in NestJS,
Stencil, Next.js App Router, etc. — were completely invisible. Now
`@Controller(basePath)` on a class plus `@Get/@Post/@Put/@Delete/@Patch/
@All/@Head/@Options(methodPath)` on its methods are extracted as full
routes with method, joined path (`/users/:id`), class-qualified handler
name (`UsersController.findOne`), and method body for context.

Verified on a synthetic NestJS fixture: 7 controller methods → 7 routes
(`GET /users`, `POST /users`, `PATCH /users/:id`, `DELETE /users/:id`,
`GET /users/:id`, `GET /orders`, `POST /orders/:id/cancel`).

#### JavaScript and JSX support

`.js`, `.jsx`, `.mjs`, `.cjs` files now ingest alongside `.ts`/`.tsx`.
ts-morph already had `allowJs: true, jsx: 2` in the parser project — the
only blocker was the scanner extension whitelist. Test/spec/bench
exclude patterns extended to cover JS variants too. Real-world impact:
Express servers written in plain JS, Vite configs, build scripts, and
mixed JS/TS migrations all index correctly now.

#### Method-call resolution

The single biggest correctness gap before this release. Method calls
like `svc.doWork()` were recorded as `callee_name = "svc.doWork"` —
but the qualified storage in the functions table is `Service.doWork`,
because the variable `svc` isn't tracked through type inference.
Result: every `obj.method()` edge in the call graph stayed NULL, and
`structx_impact Service.doWork` missed callers that referenced the
method through a variable.

Fix: a second pass in `resolveNullCallees` runs after the exact-name
pass. For relationships with a dot in `callee_name` (e.g. `svc.doWork`)
where exact match failed, it tries to bind to a function whose name
ends in `.<methodName>`. Conservative — only links when exactly one
candidate exists, same rule as the existing exact-match pass — so
ambiguous methods don't produce false positives.

Verified on a fixture with `class Service { doWork() {} }` and a
free function calling `new Service().doWork()`: `structx_relationships
{ name: "doWork", direction: "callers" }` now finds the consumer.

#### Git integration — `structx diff` + `structx_pr_impact`

New `structx diff <ref>` CLI command and matching `structx_pr_impact`
MCP tool. Both run `git diff --name-status <ref>` to find changed
files, then map those paths to indexed graph entities (functions,
types, routes). Combined with `structx_impact`, an agent can answer
"what does this PR actually touch and what's the blast radius?"
without reading any source.

CLI:
  structx diff HEAD~1
  structx diff main --json

MCP:
  structx_pr_impact { ref: "HEAD~1" }
  structx_pr_impact { ref: "main", repo_path: "/abs/path" }

Verified end-to-end against a synthetic 2-commit repo: HEAD~1 picks up
both modifications and additions, classifies status correctly
(`added` / `modified` / `deleted` / `renamed`), and surfaces files
that changed but aren't in the graph (excluded paths or deletions).

### Added — bundled from v3.1.1 battle-test patches

Five real-world correctness fixes from clone-and-test runs on hono,
tRPC, and NestJS before public promotion:

- **Unqualified function name fallback** — `structx_function 'add'`
  now finds qualified methods (`RegExpRouter.add`, `LinearRouter.add`,
  etc.) when no exact bare-name match exists.
- **Class declarations indexed as types** — `class Hono` is no longer
  invisible to `structx_type`. 48 classes captured in hono alone.
  Schema migrated; existing DBs auto-upgrade at open time.
- **Source-quality default excludes** — `*.test.ts`, `*.spec.ts`,
  `__tests__/`, `__mocks__/`, `__fixtures__/`, `tests/`, `test/`,
  `*.bench.ts`, `benchmarks/`, `runtime-tests/`, `*.config.ts`,
  `*.config.{js,mjs,cjs}`, `.vitest.config/`, `.storybook/`,
  `*.stories.{ts,tsx}` (TS+JS variants).
- **Monorepo non-library default excludes** — `examples/`, `example/`,
  `demo/`, `demos/`, `sample/`, `samples/`, `playground/`,
  `playgrounds/`, `www/`, `website/`, `docs-site/`, `scripts/`,
  `e2e/`. All recursive (`**/foo/**`) so nested occurrences are
  caught at any depth.
- **`.structxignore` file support** — same syntax as `.gitignore`,
  applied AFTER built-in defaults and `.gitignore`. Negate with
  `!**/*.test.ts` to opt back in.
- **Analyzer aborts cleanly on 402 / 401** — instead of hammering a
  dead provider for hundreds of doomed calls, surface the actionable
  reason ("out of credits — top up at provider dashboard") and tell
  the user that failed items remain queued for retry.

### Tests

71 tests passing across 17 files (was 55 across 15 in 3.1.0). New tests:

- `tests/git-diff.test.ts` (new file) — real `git init` + two commits +
  `diffEntities` against `HEAD~1`, verifies file/function/type detection
  and clean error on missing refs.
- decorator-style route extractor (NestJS @Controller + @Get/@Post)
- JS/JSX/MJS file ingestion alongside TS
- Method-call `svc.doWork() → Service.doWork` resolution
- `structx_pr_impact` in the tools/list MCP smoke test

## [3.1.1] — 2026-05-08

Battle-testing patch. Cloned and ingested two real OSS TypeScript repos
(honojs/hono and tRPC) before promoting v3.1.0 publicly. Five real
correctness bugs surfaced — all five fixed and verified end-to-end.

### Fixed

- **Unqualified function name lookup misses class methods.** Asking
  `structx_function 'add'` on hono returned "not found" even though the
  graph had `RegExpRouter.add`, `LinearRouter.add`, etc. The MCP tool
  and the LLM `direct` strategy used `name = ?` exact match against the
  qualified storage. Now an unqualified name (no dot) falls back to a
  `LIKE '%.add'` query that finds every method with that bare name.
  Hooked into directLookup, directLookupExpanded, relationshipQuery,
  and impactAnalysis.

- **Class declarations weren't indexed as types.** `class Hono` was
  invisible to `structx_type` because the type extractor only walked
  interfaces, type aliases, and enums. Now `getClasses()` runs alongside
  with `kind: 'class'` and a compact signature ("class Hono extends
  HonoBase<E, S, BasePath>"). Schema migrated to allow the new kind;
  existing DBs auto-migrate at open time. Verified on hono: 48 classes
  picked up, including `Hono`, `HonoBase`, `RegExpRouter`, `TrieRouter`.

- **Test/benchmark/config files polluted the production graph.**
  hono first-ingest reported 1338 routes — every one was from
  `benchmarks/`, `runtime-tests/`, or `*.test.ts` test fixtures. Added
  `DEFAULT_SOURCE_EXCLUDES` for `*.test.ts`, `*.spec.ts`, `__tests__/`,
  `__mocks__/`, `__fixtures__/`, `*.bench.ts`, `benchmarks/`,
  `runtime-tests/`, `*.config.ts`, `*.config.{js,mjs,cjs}`,
  `.vitest.config/`, `.storybook/`, `*.stories.{ts,tsx}`. New
  `.structxignore` file (same syntax as `.gitignore`) lets users opt
  back in with `!**/*.test.ts` etc.

- **Monorepo non-library paths flooded the graph.** tRPC first-ingest
  picked up 264 files from `examples/`, 52 from `www/` (the docs
  site), and ~280 from `packages/tests/` — 47% of the index was demo
  apps, docs, and test packages, not library source. Extended defaults
  with `examples/`, `example/`, `demo/`, `demos/`, `playground/`,
  `playgrounds/`, `www/`, `website/`, `docs-site/`, `scripts/`,
  `e2e/`, plus bare `tests/` and `test/` for the workspace-package
  case. After fix on tRPC: files 676 → 358 → 149 (78% reduction),
  ingest 41s → 12s.

- **Analyzer hammered a dead provider on 402 / 401.** When an
  OpenRouter key ran out of credit mid-batch, StructX kept calling
  the endpoint 1100 more times before reporting "Failed: 1100" with
  no actionable explanation. Now `isFatalProviderError(err)` detects
  402 (credits) / 401 (auth) and trips an `aborted` flag on the
  result; the four batch loops in analyzer.ts (functions, types,
  routes, file summaries) and the CLI's outer loop all respect it.
  The CLI prints a clear actionable reason and tells the user that
  failed items remain queued for retry.

### Added

- `.structxignore` file support — same syntax as `.gitignore`, applied
  AFTER both built-in defaults and `.gitignore`, so projects that DO
  want to index tests / examples / etc. can negate with `!**/*.test.ts`.

### Tests

65 tests passing across 16 files (up from 55 across 15). New tests
cover all five fixes plus the `isFatalProviderError` detector
(402 status, OpenRouter message text, 401 auth, transient 5xx not
fatal, null errors not fatal).

## [3.1.0] — 2026-05-08

The first release with the full Model Context Protocol server. AI agents (Claude Desktop, Cursor, Continue, Cline) can now call StructX as a native tool — no shell-out, persistent connection, ~4 ms p50 latency.

### Added

#### MCP server — 12 tools

- **`structx_search`** — keyword search across functions/types/routes/files/constants. Optional `scope` to restrict entity kinds, `mode: "broad"` for cross-cutting queries.
- **`structx_function`** — single-function detail with `include_body` opt-in.
- **`structx_relationships`** — direct callers or callees of a function.
- **`structx_impact`** — direct + transitive callers via recursive CTE. Includes bodies for results ≤ 8.
- **`structx_route`** — HTTP route lookup. `path_match: "exact"` to avoid substring hits.
- **`structx_type`** — type/interface/enum lookup with FTS + identifier-tokenized fuzzy fallback.
- **`structx_file`** — file overview (functions/types/routes/constants) or all files summary.
- **`structx_list`** — enumerate one entity kind.
- **`structx_overview`** — repo-wide stats with truncated cross-section.
- **`structx_costs`** — cost telemetry (total spend, p50/p95 latency by mode, cache hit ratio, recent runs).
- **`structx_dead_code`** — functions with zero inbound references, split into exported and internal.
- **`structx_ask`** — full LLM-backed Q&A. Streaming via MCP `progressToken`. Honors graph-fingerprint cache.

#### Other features
- **Watch mode** (`structx watch`) — incremental graph updates via `fs.watch` recursive. Bulk-coalesces burst events into a single transaction (drains 50-file bursts in one flush). Honors `.gitignore`.
- **`--readonly` flag** for the MCP server — opens DB read-only and disables `structx_ask`. Useful for shared/protected repos.
- **Streaming `structx_ask`** — when an MCP client passes `onprogress` to `callTool`, the server streams the answer via `notifications/progress` (one notification per text delta). Works on Anthropic, Gemini, and OpenRouter.
- **Gemini provider** wired through the unified LLM client (`@google/generative-ai`). Detection priority: `ANTHROPIC > GEMINI > OPENROUTER`. (Was dead code in 3.0.x.)
- **Graph-fingerprint cache** — ask responses cached by `SHA256(question | model | maxTokens | graphFingerprint)`. The fingerprint covers every code-shaping row but is stable across QA-run history changes, so identical questions return instantly while real code changes invalidate cleanly.
- **`--max-tokens` flag** on `structx ask` (CLI) and `max_tokens` arg on `structx_ask` (MCP). Bounds answer cost per call. Default `answerMaxTokens: 1024` in `.structx/config.json`, overridable per call.
- **Multi-repo support** — single `structx mcp` server can serve multiple repos. Every tool accepts an optional `repo_path` to override the server default.
- **Concurrent watch + MCP** — verified end-to-end. The watcher can update the graph while the MCP server reads it, via SQLite WAL.

### Fixed

Seven real bugs surfaced through hard testing on a real demo repo:

- **Classifier mis-routed cross-cutting flow questions to `route` strategy** when they contained the word "routes" (e.g. *"walk through the soft-delete flow, which routes start it?"*). Added a `flowQuestion` regex (walk through, trace, step-by-step, end-to-end, "how does X work") that runs before route detection and routes those to `pattern`.
- **Pattern strategy returned only function names + signatures**, leading the LLM to say *"I don't see the implementation"* even though the data was indexed. Now includes function bodies for narrow result sets (≤ 8 functions) and for the top-3 FTS matches when the result set is large.
- **Direct strategy returned only the target function**, missing chokepoint logic in callees (e.g. *"does searchTasks filter deleted?"* — the filter is in `listTasksByOwner`, not `searchTasks`). Split into `directLookup` (focused, MCP `structx_function` semantic preserved) and `directLookupExpanded` (target + immediate callees with bodies, used by the LLM ask flow).
- **Empty-context message for `direct`/`type` misses suggested ingestion**, leading the LLM to speculate. Now strategy-specific: `direct` and `type` misses tell the LLM the graph is up-to-date and the name is definitively absent.
- **FTS5 reserved-word crashes** on questions containing AND/OR/NOT/NEAR — sanitized at the retriever boundary.
- **`structx_function` schema strictness** — `additionalProperties: false` enforced via Zod's `.strict()`.
- **Build OOM during `tsc`** — bumped Node memory in test workflow.

### Changed

- **`removeTask` → `softDeleteTask`** is now the documented refactor pattern in the demo. The graph correctly drops the old name and picks up the new one on re-ingest.
- **Watch mode UX** — single-file flushes preserve detailed per-file output; multi-file flushes collapse to one summary line (`↻ 50 files (50 added) in 480ms`).
- **Stopword list** strengthened with generic flow words (`how`, `work`, `flow`, `trace`, `walk`, `end`, `step`, `through`) so they don't dilute FTS queries.

### Removed

- Dead `src/providers/{anthropic,factory,gemini,interface,openrouter}.ts` — the unused factory layer that was never imported. Replaced by the unified `LlmClient` in `src/utils/llm.ts`.

## [3.0.2] — 2026-05-05

- Classifier priority fix (callers/callees/impact before listEntity), callees fast-path patterns
- Constants in semantic & pattern search
- Narrowed list-null default dump (20 → 10)
- Ask response cache (SHA256-keyed)
- FTS5 reserved-word sanitization
- `structx watch` for incremental graph updates
- Build fixes (`ignore` + `@google/generative-ai` deps)

## [3.0.1] — earlier 2026-05

- Regex fast-path classifier
- Path normalization
- Type matching by name + file_id
- Token budget cap
- Vitest test suite
