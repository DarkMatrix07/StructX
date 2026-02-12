# StructX

Graph-powered code intelligence for TypeScript. Drop into any project and let AI agents (Claude Code, Cursor, Copilot) use a function-level knowledge graph instead of reading raw files.

## Quick Start

Two commands to set up any TypeScript project:

```bash
# 1. Install AI agent instruction files into your project
npx structx install .

# 2. Bootstrap the function graph (init + ingest + analyze)
ANTHROPIC_API_KEY=your-key npx structx setup .
```

That's it. Your AI agent will now automatically use StructX when it reads the instruction files.

## What Happens

**Step 1 — `npx structx install .`** creates these files in your project:

| File | For |
|------|-----|
| `CLAUDE.md` | Claude Code |
| `.cursorrules` | Cursor |
| `.github/copilot-instructions.md` | GitHub Copilot |

If any of these files already exist, StructX appends its section instead of overwriting.

**Step 2 — `npx structx setup .`** does three things in one shot:

1. **Init** — creates `.structx/` directory with a SQLite database
2. **Ingest** — parses all TypeScript files into a function graph (signatures, call relationships, exports)
3. **Analyze** — enriches each function with semantic metadata via LLM (purpose, behavior, tags)

## Requirements

- Node.js >= 18
- An Anthropic API key (set as `ANTHROPIC_API_KEY` environment variable)

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
| `npx structx ingest .` | Re-parse codebase after changes |
| `npx structx analyze . --yes` | Run semantic analysis on new/changed functions |
| `npx structx ask "question" --repo .` | Query the function graph |
| `npx structx doctor` | Validate environment and configuration |

## .gitignore

Add this to your `.gitignore`:

```
.structx/
```

The `.structx/` directory contains the SQLite database and is local to each developer.
