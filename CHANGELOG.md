# Changelog

All notable changes to StructX. The project follows [Semantic Versioning](https://semver.org/).

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
