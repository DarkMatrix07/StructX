# StructX

Graph-powered code intelligence for TypeScript. Drop into any project and let AI agents (Claude Code, Cursor, Copilot) use a function-level knowledge graph instead of reading raw files.

## Quick Start

Two commands to set up any TypeScript project:

```bash
# 1. Install AI agent instruction files into your project
npx structx install .

# 2. Bootstrap the function graph (init + ingest + analyze)
npx structx setup .
```

That's it. Your AI agent will now automatically use StructX when it reads the instruction files.

## LLM Providers

StructX supports three LLM providers. Set **any one** API key and it just works:

| Environment Variable | Provider | Default Models |
|---------------------|----------|----------------|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) | `claude-haiku-4-5` / `claude-sonnet-4-5` |
| `GEMINI_API_KEY` | Google Generative AI (Gemini) | `gemini-2.0-flash` / `gemini-2.5-pro` |
| `OPENROUTER_API_KEY` | OpenRouter (any model) | `google/gemini-2.5-flash` |

Provider selection can be pinned in `.structx/config.json` with `"provider": "anthropic"`, `"provider": "gemini"`, or `"provider": "openrouter"`. If no provider is pinned, detection priority is Anthropic > Gemini > OpenRouter.

Set the key in your environment or in a `.env` file in your project root:

```bash
# Pick one:
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=AI...
OPENROUTER_API_KEY=sk-or-...
```

## What Happens

**Step 1 — `npx structx install .`** creates these files in your project:

| File | For |
|------|-----|
| `CLAUDE.md` | Claude Code |
| `AGENTS.md` | Multi-agent setups |
| `.cursorrules` | Cursor |
| `.github/copilot-instructions.md` | GitHub Copilot |

If any of these files already exist, StructX appends its section instead of overwriting.

**Step 2 — `npx structx setup .`** does three things in one shot:

1. **Init** — creates `.structx/` directory with a SQLite database
2. **Ingest** — parses all TypeScript files into a function graph (signatures, call relationships, exports, types, routes, constants)
3. **Analyze** — enriches each function with semantic metadata via LLM (purpose, behavior, tags)

## Requirements

- Node.js >= 18
- One LLM API key: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `OPENROUTER_API_KEY`

## How AI Agents Use It

Once installed, the instruction files tell your AI agent to:

1. Run `npx structx status` on session start to check the graph
2. Run `npx structx ask "question" --repo .` before answering code questions
3. Run `npx structx ingest .` after making code changes
4. Run `npx structx analyze . --yes` after ingestion queues new functions
5. Run `npx structx ask "what breaks if I change X" --repo .` for impact analysis

## MCP Integration

StructX can run as a Model Context Protocol server over stdio, so MCP-aware editors can call the knowledge graph directly instead of shelling out to `structx ask`.

```bash
structx mcp --repo /abs/path/to/your/repo
```

Example **Claude Desktop** configuration (`claude_desktop_config.json`):

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

**Cursor** — add to `~/.cursor/mcp.json` (or via Settings → MCP):

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

**Continue** — add to `~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: structx
    command: structx
    args:
      - mcp
      - --repo
      - /abs/path/to/your/repo
```

**Cline / Roo** — same shape as Claude Desktop, in the extension's MCP settings.

For shared/protected repos where the MCP server should never write to the graph, add `--readonly`:

```json
"args": ["mcp", "--repo", "/path", "--readonly"]
```

This opens the SQLite DB read-only and disables `structx_ask` (which writes to `ask_cache` and `qa_runs`); all other tools work normally.

The server exposes these tools: `structx_search`, `structx_function`, `structx_relationships`, `structx_impact`, `structx_route`, `structx_type`, `structx_file`, `structx_list`, `structx_overview`, `structx_costs`, `structx_dead_code`, and `structx_ask`. Each tool accepts an optional `repo_path` argument to override the server default for that call. `structx_ask` is the only LLM-backed tool; the others query the local SQLite graph directly. `structx_costs` rolls up spend, latency percentiles, and cache-hit ratio from past runs. `structx_dead_code` finds functions with zero inbound references — useful for pre-refactor cleanup.

Most graph tools also accept `limit`, `detail`, and `response_mode` controls. `structx_search` additionally accepts `scope: ["functions"]` (or any combination of `functions`, `types`, `routes`, `files`, `constants`) so the agent can request only the entity kinds it cares about. `detail: "summary"` is the default and returns compact `structuredContent`; `detail: "full"` returns all retrieved fields. `response_mode: "both"` is the default, `response_mode: "structured"` returns a short text stub plus full structured data, and `response_mode: "text"` keeps markdown while replacing structured data with counts. `structx_function` omits the function body by default; pass `include_body: true` when the assistant needs exact source for a target function.

`structx_route` also accepts `path_match: "exact"` when an assistant needs `/api/tasks` without substring matches like `/api/tasks/:id/archive`.

`structx_ask` accepts `max_tokens` per MCP call. The CLI equivalent is `structx ask "question" --max-tokens 512`; the project-wide default is `answerMaxTokens` in `.structx/config.json` and defaults to `1024`.

**Streaming:** when an MCP client invokes `structx_ask` with a progress callback (the SDK adds `_meta.progressToken` automatically when you pass `onprogress` to `callTool`), the server streams the answer via `notifications/progress` — one notification per text delta with the cumulative answer length as `progress` and the chunk text as `message`. Clients that don't request progress get the existing one-shot response with no protocol overhead. Works for all three providers (Anthropic, Gemini, OpenRouter).

## All Commands

| Command | Description |
|---------|-------------|
| `npx structx install .` | Drop instruction files into your project |
| `npx structx setup .` | One-step bootstrap (init + ingest + analyze) |
| `npx structx status` | Show graph stats |
| `npx structx overview --repo .` | Full codebase summary (no API key needed) |
| `npx structx ingest .` | Re-parse codebase after changes |
| `npx structx analyze . --yes` | Run semantic analysis on new/changed functions |
| `npx structx ask "question" --repo .` | Query the function graph |
| `npx structx mcp --repo .` | Run the MCP server over stdio |
| `npx structx doctor` | Validate environment and configuration |
| `npx structx benchmark run --repo .` | Run comparison benchmark (StructX vs traditional) |

## Query Examples

```bash
# List all routes/endpoints
npx structx ask "what routes exist?" --repo .

# Understand a specific function
npx structx ask "what does verifyPassword do?" --repo .

# Trace authentication flow
npx structx ask "how does authentication work?" --repo .

# List types and interfaces
npx structx ask "what types and interfaces exist?" --repo .

# Impact analysis
npx structx ask "what breaks if I change the User type?" --repo .
```

## .gitignore

Add this to your `.gitignore`:

```
.structx/
```

The `.structx/` directory contains the SQLite database and is local to each developer.
