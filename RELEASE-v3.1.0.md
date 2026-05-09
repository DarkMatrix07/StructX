# Release title

```
v3.1.0 — StructX is now an MCP server
```

# Release notes

First release with the full Model Context Protocol server. AI agents (Claude Desktop, Cursor, Continue, Cline, Claude Code) can now call StructX as a native tool — persistent connection, **~4 ms p50 latency** on warm queries, no shell-out per question.

## Install

```bash
npm install -g structx
```

## What's new

### 🧠 MCP server — 12 tools

| Tool | What it does | LLM cost |
|------|--------------|----------|
| `structx_search` | Keyword search across functions/types/routes/files/constants. Optional `scope` filter. | Free |
| `structx_function` | Single-function detail with `include_body` opt-in. | Free |
| `structx_relationships` | Direct callers or callees of a function. | Free |
| `structx_impact` | Direct + transitive callers via recursive CTE. Includes bodies for ≤ 8 results. | Free |
| `structx_route` | HTTP route lookup. `path_match: "exact"` to avoid substring hits. | Free |
| `structx_type` | Type/interface/enum lookup with FTS + identifier-tokenized fuzzy fallback. | Free |
| `structx_file` | File overview or all-files summary. | Free |
| `structx_list` | Enumerate one entity kind. | Free |
| `structx_overview` | Repo-wide stats with truncated cross-section. | Free |
| `structx_costs` | Cost telemetry: spend, p50/p95 latency by mode, cache hit ratio, recent runs. | Free |
| `structx_dead_code` | Functions with zero inbound references — pre-refactor cleanup. | Free |
| `structx_ask` | Full LLM-backed Q&A. Streaming via MCP `progressToken`. Graph-fingerprint cache. | $$ |

### 🔍 New capabilities

- **Watch mode** (`structx watch`) — incremental graph updates via `fs.watch` recursive. Bulk-coalesces burst events into a single transaction (drains 50-file bursts in one flush). Honors `.gitignore`.
- **`--readonly` flag** for the MCP server — opens DB read-only and disables `structx_ask`. Useful for shared/protected repos.
- **Streaming `structx_ask`** — when an MCP client passes `onprogress` to `callTool`, the server streams the answer via `notifications/progress`. Works on Anthropic, Gemini, and OpenRouter.
- **Gemini provider** wired through the unified LLM client. Detection priority: `ANTHROPIC > GEMINI > OPENROUTER`.
- **Graph-fingerprint cache** — ask responses cached by `SHA256(question | model | maxTokens | graphFingerprint)`. Identical questions return instantly while real code changes invalidate cleanly.
- **Multi-repo support** — single `structx mcp` server can serve multiple repos via per-call `repo_path`.
- **`--max-tokens` flag** on `structx ask` (CLI) and `max_tokens` arg on `structx_ask` (MCP). Bounds answer cost per call.

### 🐛 Bug fixes (from hard testing)

- Classifier no longer misroutes cross-cutting flow questions (containing "routes", "endpoints") to the route strategy. Added a `flowQuestion` regex (walk through, trace, step-by-step, end-to-end) that runs before route detection and routes those to `pattern`.
- Pattern strategy now includes function bodies for narrow result sets (≤ 8 functions) and the **top-3 FTS matches** when the result set is large — fixes hallucinated signatures on broad searches.
- Direct strategy now expands to include **callee bodies** for the LLM ask flow, so questions like "does X correctly skip deleted items?" can be answered when the chokepoint logic lives in a callee. The MCP `structx_function` tool keeps its focused single-function semantic.
- Empty-context messages for `direct`/`type` misses now tell the LLM the graph is up to date and the name is definitively absent — instead of suggesting ingestion and inviting speculation.
- FTS5 reserved-word crashes on questions containing `AND`/`OR`/`NOT`/`NEAR` — sanitized at the retriever boundary.
- `structx_function` schema strictness — `additionalProperties: false` enforced via Zod's `.strict()`.

### 🧹 Removed

- Dead `src/providers/{anthropic,factory,gemini,interface,openrouter}.ts` — the unused factory layer that was never imported. Replaced by the unified `LlmClient` in `src/utils/llm.ts`.

## Setup with AI agents

```bash
# 1. Install globally
npm install -g structx

# 2. Index a TypeScript project
cd /path/to/your/repo
structx setup .

# 3. Wire into Claude Desktop, Cursor, Continue, or Claude Code
#    (see the README for client-specific config blocks)
```

Full walkthrough: [Setup with AI agents](https://github.com/DarkMatrix07/StructX#setup-with-ai-agents--full-walkthrough)

## Stats

- **55 tests** passing (15 files, includes end-to-end MCP via `InMemoryTransport`)
- **p50 4 ms / p95 33 ms** tool latency on a warm MCP connection
- **132 KB** package size, **168 files** in the tarball

## Links

- 📦 npm: https://www.npmjs.com/package/structx
- 📖 Docs: https://github.com/DarkMatrix07/StructX#readme
- 📜 Full diff: [CHANGELOG.md](https://github.com/DarkMatrix07/StructX/blob/main/CHANGELOG.md)
