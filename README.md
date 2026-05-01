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
