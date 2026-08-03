# StructX

**Graph-powered code intelligence for TypeScript.** Drop into any project and your AI agent (Claude Code, Cursor, Copilot, Continue, Cline) gets a function-level knowledge graph instead of grepping raw files. Queries that took several file reads collapse into a single millisecond-latency call.

[![npm](https://img.shields.io/npm/v/structx.svg)](https://www.npmjs.com/package/structx) [![license](https://img.shields.io/npm/l/structx.svg)](#license) [![tests](https://img.shields.io/badge/tests-103%20passing-brightgreen)](#contributing)

> **v3.4.0 just shipped — `structx path` traces a request from endpoint to database, `structx query` filters functions by what they *do*, and the call graph is now resolved through the TypeScript compiler instead of by name.** See [CHANGELOG.md](./CHANGELOG.md) for the full diff from 3.3.x.

```
agent: "what breaks if I change validateEmail?"
              ↓
StructX:  3 ms graph query → 4 callers, transitive impact, source bodies
              ↓
agent answers definitively, no file reads
```

---

## Quick Start

Two commands to set up any TypeScript project:

```bash
# 1. Drop AI-agent instruction files into your project
npx structx install .

# 2. Bootstrap the function graph (init + ingest + analyze)
npx structx setup .
```

That's it. Your agent will now use StructX automatically when it reads the instruction files.

For MCP-aware editors (Claude Desktop, Cursor, Continue, Cline), add the [MCP integration block](#mcp-integration) to your client config and restart.

---

## Table of contents

- [Why StructX](#why-structx)
- [Quick start](#quick-start)
- [Setup with AI agents — full walkthrough](#setup-with-ai-agents--full-walkthrough)
  - [Step 1 — Install StructX globally](#step-1--install-structx-globally)
  - [Step 2 — Index your repo](#step-2--index-your-repo)
  - [Step 3 — Wire it into your AI client](#step-3--wire-it-into-your-ai-client)
  - [Step 4 — Verify it loaded](#step-4--verify-it-loaded)
  - [Step 5 — Use it](#step-5--use-it)
- [Requirements](#requirements)
- [LLM providers](#llm-providers)
- [What it builds](#what-it-builds)
- [How agents use it](#how-agents-use-it)
- [MCP integration reference](#mcp-integration-reference)
  - [Tool reference](#tool-reference)
  - [Editor configs](#editor-configs)
  - [Readonly mode](#readonly-mode)
  - [Streaming `structx_ask`](#streaming-structx_ask)
- [Route coverage](#route-coverage)
- [CLI reference](#cli-reference)
- [Watch mode](#watch-mode)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Cost guide](#cost-guide)
- [Performance](#performance)
- [Troubleshooting](#troubleshooting)
- [Status](#status)
- [Contributing](#contributing)

---

## Setup with AI agents — full walkthrough

Zero to working in five minutes. Each step is a single command or one paste.

### Step 1 — Install StructX globally

```bash
npm install -g structx
```

Verify:

```bash
structx --version    # → 3.4.0
```

If `structx` isn't found, your npm global bin isn't on PATH. Run `npm config get prefix` to see where global packages live and add `<prefix>/bin` (Unix) or `<prefix>` (Windows) to PATH.

### Step 2 — Index your repo

Set one LLM API key in your shell environment or in a `.env` file at your repo root:

```bash
# Pick ONE:
export ANTHROPIC_API_KEY="sk-ant-..."        # Claude
export GEMINI_API_KEY="AI..."                # Google Gemini
export OPENROUTER_API_KEY="sk-or-..."        # OpenRouter (any model)
```

Then in your TypeScript project's directory:

```bash
cd /abs/path/to/your/repo
structx setup .
```

This does three things:

1. Creates `.structx/` with a SQLite knowledge graph.
2. Parses every `.ts`/`.tsx` file (functions, types, routes, constants, call relationships).
3. Runs the LLM over each entity to attach `purpose`, `behavior_summary`, `side_effects`, etc.

For a 100-function repo this takes ~30 seconds and costs roughly $0.05. Re-runs are diff-gated and near-free.

> **Tip:** add `structx watch .` in a separate terminal to keep the graph live while you code.

### Step 3 — Wire it into your AI client

Pick the client you use. Each one needs the StructX MCP server registered exactly once.

#### Claude Desktop

Edit (or create) `claude_desktop_config.json`:

| OS | Path |
|----|------|
| **Windows** | `%APPDATA%\Claude\claude_desktop_config.json` |
| **macOS** | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Linux** | `~/.config/Claude/claude_desktop_config.json` |

Add (or merge) this block:

```json
{
  "mcpServers": {
    "structx": {
      "command": "structx",
      "args": ["mcp", "--repo", "/abs/path/to/your/repo"]
    }
  }
}
```

> Windows paths must use **escaped backslashes** (`"C:\\Users\\you\\repo"`) or **forward slashes** (`"C:/Users/you/repo"`). A single `\` is a JSON parse error.

**Fully quit and re-launch Claude Desktop** (just closing the window doesn't reload the config).

#### Claude Code (CLI)

```bash
claude mcp add structx -- structx mcp --repo "$(pwd)"
claude mcp list                                          # confirm it shows up
```

To remove later: `claude mcp remove structx`.

#### Cursor

Edit `~/.cursor/mcp.json` (or use Settings → MCP):

```json
{
  "mcpServers": {
    "structx": {
      "command": "structx",
      "args": ["mcp", "--repo", "/abs/path/to/your/repo"]
    }
  }
}
```

Restart Cursor.

#### Continue

Add to `~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: structx
    command: structx
    args:
      - mcp
      - --repo
      - /abs/path/to/your/repo
```

#### Cline / Roo

Same JSON shape as Claude Desktop, in the extension's MCP settings panel.

#### Multiple repos

Two patterns:

1. **One server, switch per call.** Keep the default `--repo`, then in the chat you can ask for any repo:
   *"Use structx_search with `repo_path: '/abs/path/to/other-repo'` for keywords ['auth']."*
2. **One server per repo.** Register them as `structx-projectA`, `structx-projectB`, etc., each with its own `--repo`. The agent sees them as distinct toolsets.

#### Shared / read-only deployments

Add `--readonly` to the args. The MCP server opens the DB read-only and disables `structx_ask` (which writes cache + run logs). The other 15 tools work normally — perfect for shared dev environments where you only want consumers, not writers:

```json
"args": ["mcp", "--repo", "/path/to/repo", "--readonly"]
```

### Step 4 — Verify it loaded

**Claude Desktop:** open a new chat, click the **🔌 plug icon** at the bottom of the message box. You should see `structx` listed with **16 tools**:

```
structx_search          structx_function       structx_relationships
structx_impact          structx_path           structx_query
structx_route           structx_type           structx_file
structx_list            structx_overview       structx_costs
structx_dead_code       structx_type_graph     structx_pr_impact
structx_ask
```

If StructX isn't there, open **Developer → Open MCP Logs** and look for spawn errors. The most common causes are:

- `structx` not on PATH (run `where structx` / `which structx` to confirm).
- Wrong repo path or unescaped backslashes on Windows.
- `.structx/` directory doesn't exist in the target repo (run `structx setup .` there).

**Claude Code:** running `claude mcp list` should show `structx`. If a tool call returns `Tool not found`, restart your terminal so the registry reloads.

### Step 5 — Use it

You don't have to teach the agent anything special — it'll pick the right tool from your normal questions. A few examples:

| You ask | Tool the agent picks | What it saves |
|---------|---------------------|---------------|
| *"What does verifyPassword do?"* | `structx_function` (with `include_body: true`) | 1 file read |
| *"What breaks if I change the User type?"* | `structx_impact` + `structx_type` | 5+ file reads |
| *"How does authentication work in this codebase?"* | `structx_search` (broad mode) | 4–6 file reads |
| *"List every route I have."* | `structx_list` (`entity: "routes"`) | 1–2 file reads |
| *"Find dead exports I can delete."* | `structx_dead_code` | a manual audit |
| *"How does a request get from the API to chargeCard?"* | `structx_path` | 4–8 file reads |
| *"Which exported functions write to the database?"* | `structx_query` | a full-repo grep + read |

You can also be explicit when you want to:

- *"Use structx_overview to summarize this codebase before we start."*
- *"Use structx to trace what happens when a user calls /api/auth/login end to end."*
- *"Find every function that touches the database, then suggest a single chokepoint to add audit logging."*

When you're done with a session, `structx_costs` gives you a roll-up of how much it cost.

---

## Why StructX

When an AI agent works on a codebase, the default behavior is to read files until it has enough context. That's slow, expensive, and the picture is always partial.

StructX builds a **persistent SQLite knowledge graph** of every function, type, route, and constant in your TypeScript codebase, plus the call relationships between them. Then it exposes that graph as an MCP server with 12 query tools, plus a CLI for ad-hoc questions.

The result: instead of "let me read 4 files to understand authentication," the agent calls `structx_search { keywords: ["authentication"] }` and gets a ranked, body-rich answer in **~10 ms**.

**What's in the graph:**
- Function signatures, bodies, side effects, complexity tags, purpose summaries
- Direct + transitive call relationships (recursive CTE for impact analysis)
- Type definitions (interface / type alias / enum) with full source text
- HTTP routes (method + path + handler body) auto-detected from Express-style code
- File-level summaries (LOC, exports, imports, semantic purpose)
- Constants with values and type annotations

**What you get out:**
- 12 MCP tools with strict JSON Schema (`additionalProperties: false`)
- Cross-cutting impact analysis ("what breaks if I change X")
- Semantic search ("how is auth handled?")
- Dead-code detection ("what exports have zero callers?")
- Cost telemetry, ask-response cache, graph-fingerprint cache invalidation
- Watch mode for incremental graph updates as you code

---

## Requirements

- **Node.js ≥ 18**
- **One LLM API key**: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `OPENROUTER_API_KEY`
- **TypeScript / TSX source files** (StructX scans `.ts` / `.tsx`, ignores `.d.ts`)
- StructX honors your project's `.gitignore` plus a hard `node_modules`/`.git`/`.structx` skip list

---

## LLM providers

Set **any one** API key and StructX picks it up automatically:

| Environment variable | Provider | Default models |
|----------------------|----------|----------------|
| `ANTHROPIC_API_KEY` | Anthropic | `claude-haiku-4-5` (analyze/classify), `claude-sonnet-4-5` (answer) |
| `GEMINI_API_KEY` | Google Generative AI | `gemini-2.0-flash` (analyze/classify), `gemini-2.5-pro` (answer) |
| `OPENROUTER_API_KEY` | OpenRouter | `anthropic/claude-haiku-4.5` / `anthropic/claude-sonnet-4.5` |

**Detection priority** when multiple are set: `ANTHROPIC` > `GEMINI` > `OPENROUTER`.

To pin a provider explicitly, edit `.structx/config.json`:

```json
{ "provider": "openrouter", "answerModel": "anthropic/claude-sonnet-4.5" }
```

You can also drop the key in a `.env` file at your project root.

---

## What it builds

`npx structx install .` writes these instruction files (idempotent — appends if they exist):

| File | Tells |
|------|-------|
| `CLAUDE.md` | Claude Code |
| `AGENTS.md` | Multi-agent setups (Codex, autonomous loops) |
| `.cursorrules` | Cursor |
| `.github/copilot-instructions.md` | GitHub Copilot |

`npx structx setup .` runs three steps in one shot:

1. **Init** — creates `.structx/db.sqlite` and `.structx/config.json`, adds `.structx/` to your `.gitignore`
2. **Ingest** — scans every `.ts`/`.tsx` file, extracts functions / types / routes / constants / call relationships into the graph
3. **Analyze** — runs the LLM over each function/type/route to attach `purpose`, `behavior_summary`, `side_effects`, `domain`, `complexity`, plus per-file purpose summaries

Re-running `setup` is safe: only changed files are re-ingested (content-hash gated), and only changed-or-new functions are re-analyzed (semantic-cache gated). A typical re-run on an unchanged repo is sub-second.

---

## How agents use it

After `npx structx install .`, the instruction files tell your AI agent to:

1. Run `structx status` at session start to confirm the graph is fresh
2. Run `structx ask "..."` (or call MCP tools) before answering code questions
3. Run `structx ingest .` after making code changes
4. Run `structx analyze . --yes` after ingestion queues new functions

For MCP-aware editors, the server runs persistently and tools respond in milliseconds — no shell-out per question.

---

## MCP integration reference

> If you just want to get started, jump to [Setup with AI agents — full walkthrough](#setup-with-ai-agents--full-walkthrough). The section below is the detailed reference.

StructX runs as a Model Context Protocol server over stdio. Most modern AI editors support MCP — wire it up once and your assistant gets the graph as native tools.

```bash
structx mcp --repo /abs/path/to/your/repo
```

The server logs to **stderr** (stdout is reserved for MCP frames) and stays alive until the parent client disconnects.

### Tool reference

16 tools, all accept an optional `repo_path` to override the server default:

| Tool | What it returns | LLM cost |
|------|-----------------|----------|
| `structx_search` | Functions/types/routes/files/constants matching keywords (FTS5). Optional `scope` to limit kinds, `mode: "broad"` for cross-cutting concerns. | Free |
| `structx_function` | Full details for one function: signature, location, callers, callees, side effects. `include_body: true` for source text. | Free |
| `structx_relationships` | Direct callers (`direction: "callers"`) or callees (`"callees"`) of a function. | Free |
| `structx_impact` | Direct + transitive callers via recursive CTE, plus the HTTP endpoints whose handlers sit in the blast radius. Bodies included for results ≤ 8. | Free |
| `structx_path` | Trace the call chain between two functions (`from` + `to`), or from every HTTP endpoint that reaches a function (`to` only). Depth-capped, cycle-safe. | Free |
| `structx_query` | Filter functions by semantic properties — `domain`, `side_effect`, `complexity`, `exported`, `is_async`, `name_pattern`, `file_pattern`. Call with no filters to list available domains. | Free |
| `structx_route` | HTTP routes by path/method. `path_match: "exact"` to avoid substring hits. | Free |
| `structx_type` | Type/interface/enum by name. Falls back to FTS + identifier-tokenized fuzzy match. | Free |
| `structx_file` | File overview (functions/types/routes/constants). Empty path = all files. | Free |
| `structx_list` | Enumerate one entity kind (`routes` \| `types` \| `files` \| `functions` \| `constants`). | Free |
| `structx_overview` | Repo-wide stats + truncated cross-section. | Free |
| `structx_costs` | Cost telemetry: total spend, p50/p95 latency by mode, cache hit ratio, recent runs. | Free |
| `structx_dead_code` | Functions with zero inbound references. Splits exported (callers may be elsewhere) vs internal. | Free |
| `structx_ask` | Full LLM-backed Q&A — classifier → retriever → context-builder → answerer. Honors graph-fingerprinted cache. | $$ |

**Common args** (most graph tools): `limit`, `detail` (`"summary"` | `"full"`), `response_mode` (`"both"` | `"text"` | `"structured"`).

- `detail: "summary"` (default) returns compact `structuredContent`; `"full"` returns every field.
- `response_mode: "structured"` returns a short text stub plus full structured data; `"text"` keeps markdown but swaps structured data for counts; `"both"` is the default.
- `structx_search` additionally takes `scope: ["functions", "types", "routes", "files", "constants"]` to drop entity kinds the agent doesn't care about.
- `structx_function` accepts `include_body: true` when the assistant needs exact source.
- `structx_ask` accepts `max_tokens` per call (overrides `answerMaxTokens` from `.structx/config.json`).

### Editor configs

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "structx": {
      "command": "structx",
      "args": ["mcp", "--repo", "/abs/path/to/your/repo"]
    }
  }
}
```

**Cursor** — `~/.cursor/mcp.json` (or Settings → MCP):

```json
{
  "mcpServers": {
    "structx": {
      "command": "structx",
      "args": ["mcp", "--repo", "/abs/path/to/your/repo"]
    }
  }
}
```

**Continue** — `~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: structx
    command: structx
    args:
      - mcp
      - --repo
      - /abs/path/to/your/repo
```

**Cline / Roo** — same shape as Claude Desktop, in the extension's MCP settings panel.

### Readonly mode

For shared or protected repos where the MCP server should never mutate the graph, add `--readonly`:

```json
"args": ["mcp", "--repo", "/path", "--readonly"]
```

This opens the SQLite DB read-only and disables `structx_ask` (which writes to `ask_cache` and `qa_runs`). Every other tool works normally — perfect for read-only deployments where humans run `structx ingest` separately.

### Streaming `structx_ask`

When an MCP client passes an `onprogress` callback to `callTool` (the SDK attaches `_meta.progressToken` automatically), the server streams the answer via `notifications/progress` — one notification per text delta carrying the cumulative answer length as `progress` and the chunk text as `message`. Clients that don't request progress get the one-shot response with no overhead. Works on Anthropic, Gemini, and OpenRouter.

---

## Route coverage

StructX finds HTTP endpoints across the three conventions in common use, and
links each one to the function that handles it — which is what lets
`structx path` trace an endpoint down to the data layer:

| Style | Example | Framework |
|---|---|---|
| Call registration | `router.get('/users', handler)` | Express, Koa, Fastify |
| Inline handler | `router.post('/login', async (req, res) => {...})` | Express (most common) |
| Decorators | `@Controller('users')` + `@Get(':id')` | NestJS, Tsoa, routing-controllers |
| File-based | `app/api/users/[id]/route.ts` exporting `GET` | Next.js App Router, SvelteKit, Medusa v2 |
| Pages API | `pages/api/users/[id].ts` default export | Next.js Pages Router |
| Components | `@Component({ tag })`, `@customElement()` | Stencil, Lit, Angular |

Verified against real repositories: 281/281 routes linked on immich, 174/174
on NestJS, 20/21 on a stock Express app (the one miss mounts a sub-router
rather than a handler).

---

## CLI reference

| Command | Description |
|---------|-------------|
| `structx install [repo]` | Drop instruction files into the project |
| `structx setup [repo]` | One-step bootstrap (init + ingest + analyze) |
| `structx init [repo]` | Create `.structx/` and config without ingest |
| `structx ingest [repo]` | Parse codebase into the graph |
| `structx watch [repo]` | Watch mode — incremental graph updates as files change |
| `structx analyze [repo] --yes` | Run semantic analysis on new/changed functions |
| `structx status` | Show graph stats (files, functions, relationships, etc.) |
| `structx overview --repo .` | Full codebase summary, no API key needed |
| `structx path <to> [--from <fn>]` | Trace the call chain to a function — from another function, or from every HTTP endpoint that reaches it |
| `structx query [filters]` | Filter functions by domain, side effect, complexity, name or file. No filters = list available domains |
| `structx ask "..." --repo .` | Natural-language query against the graph |
| `structx mcp --repo . [--readonly]` | Run the MCP server over stdio |
| `structx doctor` | Validate environment, config, and DB |
| `structx benchmark run --repo .` | StructX vs file-reading benchmark |

```bash
# How does a request reach the payment code?
structx path chargeCard

# POST /orders/checkout
#   OrdersController.checkout   [src/orders.controller.ts:7]
#     └─ processPayment         [src/service.ts:4]
#       └─ chargeCard           [src/repository.ts:2]

# Every exported database function that writes
structx query --domain database --side-effect write --exported
```

`structx path` accepts `--max-depth` (default 8) and `--limit` (default 5).

`structx query` filters on `--domain`, `--complexity`, `--side-effect`, `--exported`, `--async`, `--name`, `--file`. The structural filters work without semantic analysis; the semantic ones need `structx analyze` to have run.

`structx ask` accepts `--max-tokens 64..8192` to bound the answer cost.

`structx mcp` accepts `--repo <path>` (default cwd) and `--readonly`.

---

## Watch mode

```bash
structx watch .
```

Monitors the repo via `fs.watch` (recursive, no extra deps) and keeps the graph in sync as you edit. Saves are coalesced into a single SQLite transaction with batched post-processing — drains 50-file bursts in one flush. Honors `.gitignore` plus the always-skip directories.

| Event | Output |
|-------|--------|
| File added | `+ src/foo.ts — 3 fns, 1 types, 0 routes, 1 consts (1 queued)` |
| File modified | `~ src/foo.ts — 3 fns, 1 types, 0 routes, 1 consts (2 queued)` |
| File deleted | `− src/foo.ts` |
| Burst (>1 file) | `↻ 50 files (50 added) in 480ms` |

Run `structx watch` in one terminal and `structx mcp` in another (Claude Desktop, etc.) — the MCP server picks up watcher commits via SQLite WAL automatically.

`--no-initial-ingest` skips the warm-up scan when the graph is already current.

---

## Architecture

```
┌─────────────────┐
│  TypeScript     │
│  source files   │
└────────┬────────┘
         │ ts-morph parser
         ▼
┌─────────────────────────────────────────────────────────┐
│  SQLite knowledge graph (.structx/db.sqlite, WAL mode)  │
│                                                         │
│  files ──┬─ functions ──── relationships (call graph)   │
│          ├─ types                                       │
│          ├─ routes                                      │
│          ├─ constants                                   │
│          └─ file_summaries                              │
│                                                         │
│  + FTS5 indexes (functions_fts, types_fts, routes_fts)  │
│  + ask_cache (SHA256(question + model + graph))         │
│  + qa_runs (telemetry)                                  │
│  + analysis_queue (LLM enrichment pipeline)             │
└─────────────────────────────────────────────────────────┘
         ▲                                ▲
         │ ingest pipeline                │ retrieval pipeline
         │                                │
┌────────┴───────────┐         ┌──────────┴──────────────┐
│  ingester          │         │  classifier             │
│  semantic analyzer │         │  retriever (10 strats)  │
│  watcher           │         │  context-builder        │
│                    │         │  answerer (3 providers) │
└────────────────────┘         └──────────┬──────────────┘
                                          │
                               ┌──────────┴──────────┐
                               │  CLI    │   MCP     │
                               │  ask    │   16 tools│
                               └─────────┴───────────┘
```

**Ingest pipeline** (`src/ingest/`): scanner → parser (ts-morph) → file/function/type/route/constant extractors → relationships → SQLite write.

**Retrieval pipeline** (`src/query/`):
1. **Classifier** — fast-path regex first (zero-cost), LLM fallback. Picks one of 10 strategies.
2. **Retriever** — strategy-specific SQL: direct lookup, relationships, semantic FTS, domain filter, impact CTE, route lookup, type lookup, file overview, list, pattern (broad FTS).
3. **Context builder** — formats results to fit a 3000-token budget; includes function bodies for narrow result sets and top-N FTS matches.
4. **Answerer** — single shot or streamed.

**Cache invalidation**: ask cache keys are `SHA256(question.lowercase.trim() | model | maxTokens | graphFingerprint)`. The graph fingerprint covers every code-shaping row and is stable across QA-run history changes — so identical questions return instantly while real code changes invalidate cleanly.

---

## Configuration

`.structx/config.json` is created by `structx init` / `structx setup`. Defaults are filled in by `loadConfig`:

```jsonc
{
  "repoPath": "/abs/path/to/repo",
  "provider": "anthropic",            // anthropic | gemini | openrouter
  "anthropicApiKey": "",              // optional, falls back to env
  "baseURL": "",                      // optional, override provider endpoint
  "analysisModel": "claude-haiku-4-5-20251001",
  "classifierModel": "claude-haiku-4-5-20251001",
  "answerModel": "claude-sonnet-4-5-20250929",
  "answerMaxTokens": 1024,            // 64..8192
  "batchSize": 8,                     // semantic analysis batch
  "diffThreshold": 0.3                // re-analyze when ≥30% of body changed
}
```

`structxDir` is filled in at runtime; you don't set it.

---

## Cost guide

Rough numbers from running on a 10-file demo project (~38 functions, ~12 routes):

| Operation | Tokens | Cost (Anthropic) |
|-----------|--------|------------------|
| Initial `setup` (ingest + analyze 38 functions, 12 types, 10 routes, 9 file summaries) | ~6 K in / ~2 K out | **~$0.02** |
| Re-`setup` after editing 5 functions (only those re-analyzed) | ~1 K in / ~300 out | **~$0.003** |
| One `ask` (cache miss, pattern strategy, ~30 entities) | ~3 K in / ~400 out | **~$0.005** |
| One `ask` (cache hit) | 0 | **$0.0000** |

OpenRouter with `anthropic/claude-haiku-4.5` is roughly equivalent. Gemini Flash is ~4× cheaper for analysis; Pro for answers is similar to Sonnet.

For a 1000-function codebase, expect first-time setup around **$0.30–$0.80** depending on provider and how detailed the functions are. Subsequent ingests are sub-dollar because of the diff-gated re-analysis. Run `structx_costs` (or check `qa_runs`) at any time for actual numbers.

---

## Performance

Latency on a warm MCP connection (10 graph tools, real demo repo):

| Tool | p50 | p95 |
|------|-----|-----|
| `structx_function` | 3 ms | 7 ms |
| `structx_type` | 3 ms | 3 ms |
| `structx_relationships` | 4 ms | 5 ms |
| `structx_impact` | 4 ms | 4 ms |
| `structx_search` | 8 ms | 8 ms |
| `structx_overview` | 33 ms | 272 ms (proportional to repo size) |
| **Median across all tools** | **4 ms** | **33 ms** |

Cold-start (per-call subprocess) is ~1–2 s — that's why production usage keeps the MCP server warm.

Watch mode end-to-end latency (file save → DB visible to readers): **~160 ms median**.

---

## Troubleshooting

**"Config not found at .../.structx/config.json"** — Run `structx init .` or `structx setup .` first.

**"Provider returned 402 insufficient credits"** — Out of API credit on the configured provider. Either add credits, switch providers via `.structx/config.json`, or rely on the graph-only tools (every MCP tool except `structx_ask` works without an LLM).

**"WARNING: No functions have been semantically analyzed"** — Ingest succeeded but analyze didn't. Run `structx analyze . --yes`. If you want the basic graph without paying for analysis, just keep using `structx ask` — it'll still work but answers will be less rich.

**MCP tools return empty results after I added a new file** — Either run `structx ingest .` or use `structx watch` for automatic updates.

**FTS search misses camelCase identifiers** — FTS5's default tokenizer doesn't split on case. Workaround: query `structx_function { name: "yourCamelCase" }` for exact lookups, or use kebab-case / snake_case in keywords.

**`tsc` heap out of memory in this repo's own build** — bump Node memory: `NODE_OPTIONS=--max-old-space-size=4096 npm run build`.

**Watch mode reports `ENOENT` for files that exist** — Some editors do atomic-rename writes (write-tmp + rename). Wait ~100 ms; the watcher's debounce should pick up the final state.

**Recent question hits the cache when I expected fresh analysis** — The cache key includes the graph fingerprint. If your code didn't change, the cache hits. To force a fresh answer, change one character of the question or run `structx ingest .` after a real edit.

---

## Status

**v3.4.0 — published on npm.**

Strong:
- 16 MCP tools, strict schemas, three providers, streaming, multi-repo, readonly
- Graph-fingerprint cache invalidation, watch mode with batched flush, dead-code finder
- 103 tests including end-to-end MCP via `InMemoryTransport`
- p50 4 ms tool latency on warm connection

Honest gaps:
- **Language coverage**: TypeScript only. JavaScript and Python are obvious next targets but not built.
- **Method-call resolution**: `obj.foo()` and chained calls degrade to NULL callees in some cases. Function-to-function call graph is solid; OO call graph has edges that don't resolve.
- **Type-relationship graph**: function call graph is full; type-extends-type and field-of-type relationships aren't tracked.
- **Scale**: tested up to ~50-file projects. 1000+ file performance is unverified.
- **Git integration**: no `structx diff <ref>` or PR-impact tool yet. Combine with `git diff` manually for now.

See [GitHub issues](https://github.com/DarkMatrix07/StructX/issues) for the live list.

---

## Contributing

```bash
git clone https://github.com/DarkMatrix07/StructX
cd StructX
npm install
npm run build
npm test                              # 55 tests
node dist/cli.js setup ./scratch-repo  # try it on your own repo
```

The codebase is itself indexed by StructX — once built, you can run `node dist/cli.js mcp --repo .` and use any MCP client to explore the implementation.

`src/` layout:

| Path | What |
|------|------|
| `src/cli.ts` | Commander entry point |
| `src/db/` | Schema, queries, migrations |
| `src/ingest/` | Parser, scanner, extractors, relationships, watcher hooks |
| `src/query/` | Classifier, retriever, context-builder, answerer, ask-cache |
| `src/mcp/` | Server, tool registry, db-pool, format helpers |
| `src/semantic/` | LLM-backed function/type/route analyzers |
| `src/watch/` | Watcher with batched flush + per-file debounce |
| `src/utils/` | Unified LLM client (Anthropic + Gemini + OpenRouter), token costs, paths, FTS sanitizer |
| `tests/` | Vitest specs, including real MCP client/server via InMemoryTransport |

Add a test for any new behavior. The existing pattern (per-tool integration tests in `tests/mcp-tools.test.ts`) is a good template.

---

## License

ISC.
