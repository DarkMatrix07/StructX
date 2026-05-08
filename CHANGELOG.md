# Changelog

All notable changes to StructX. The project follows [Semantic Versioning](https://semver.org/).

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
