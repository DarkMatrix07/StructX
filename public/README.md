# StructX

Graph-powered code intelligence for TypeScript. StructX builds a knowledge graph of your codebase — functions, types, routes, constants, and call relationships — so AI agents can understand your project without reading every file.

Works with **Claude Code**, **OpenAI Codex**, **Cursor**, and **GitHub Copilot**.

## What It Does

StructX parses your TypeScript project into a queryable knowledge graph stored in SQLite. AI agents use it to:

- **Discover architecture** — get a full codebase overview in seconds
- **Find routes, types, functions** — without hunting through files
- **Trace call relationships** — who calls what, and what depends on what
- **Impact analysis** — know what breaks before you change something
- **Ask natural language questions** — powered by LLM over graph context

### Example

```
$ npx structx ask "how does the login flow work?" --repo .

# Login Flow

The login flow works through the POST /auth/login endpoint at src/routes/auth.ts:108.

1. Rate Limiting — requests pass through loginRateLimiter middleware
2. Input Validation — validates email and password in request body
3. User Lookup — calls findUserByEmail() from src/services/auth.ts
4. Password Verification — verifies via verifyPassword()
5. Token Generation — generates JWT using generateToken()
6. Role-Based Response — returns token, permissions, and dashboard URL

Strategy: pattern | Entities: 13 | Graph query: 3ms | Cost: $0.01
```

```
$ npx structx overview --repo .

StructX Codebase Overview
════════════════════════════════════════════════════════════
  Files: 6 | Functions: 16 | Types: 6 | Routes: 18 | Constants: 18
  Relationships: 55 | Analyzed: 16/16

── Routes / Endpoints ──
  POST    /auth/register  [auth.ts:61]  — Creates a new user account
  POST    /auth/login     [auth.ts:108] — Authenticates user with credentials
  POST    /auth/logout    [auth.ts:256] — Blacklists the current token
  GET     /auth/me        [auth.ts:262] — Returns authenticated user profile
  GET     /auth/health    [auth.ts:51]  — Health check endpoint
  ...

── Types & Interfaces ──
  interface  User        (exported) [index.ts:5]  — User record with credentials and role
  interface  AuthRequest (exported) [index.ts:13] — Extended Express Request with auth info
  interface  JwtPayload  (exported) [index.ts:18] — JWT token claims structure
  ...

── Functions ──
  authenticate       (exported) [auth.ts:5]  — Validates Bearer tokens
  createRateLimiter  (exported) [rateLimit.ts:27] — Configurable rate limiting middleware
  generateToken      (exported) [auth.ts:121] — Generates JWT for authenticated user
  ...
```

## Quick Start

### 1. Install

```bash
npm install structx
```

### 2. Set up the knowledge graph

```bash
# Set your Anthropic API key (needed for semantic analysis and queries)
export ANTHROPIC_API_KEY=your-key

# Bootstrap: parses all TypeScript files, builds the graph, runs semantic analysis
npx structx setup .
```

### 3. Install agent instruction files

```bash
npx structx install .
```

This creates instruction files that AI agents auto-discover:

| File | AI Tool |
|------|---------|
| `CLAUDE.md` | Claude Code |
| `AGENTS.md` | OpenAI Codex |
| `.cursorrules` | Cursor |
| `.github/copilot-instructions.md` | GitHub Copilot |

All four files contain the same instructions from a single `agent.md` template.

### 4. Add to .gitignore

```
.structx/
```

The `.structx/` directory contains the local SQLite database.

## How It Works

**Setup** parses your TypeScript codebase using [ts-morph](https://ts-morph.com/) and stores everything in a local SQLite database:

- **Functions** — name, signature, body, file location, export status
- **Types** — interfaces, type aliases, enums with full definitions
- **Routes** — HTTP endpoints (Express-style) with method, path, handler
- **Constants** — exported constants with values and type annotations
- **File summaries** — imports, exports, LOC, purpose
- **Relationships** — function call graph with resolved references

**Semantic analysis** enriches each entity with LLM-generated metadata: purpose, behavior summary, domain tags, and complexity assessment.

**Queries** go through a pipeline: classify the question → retrieve relevant entities from the graph → build context → generate an answer via LLM.

## Commands

| Command | Description |
|---------|-------------|
| `npx structx setup .` | Full bootstrap (init + ingest + analyze) |
| `npx structx install .` | Drop agent instruction files into project |
| `npx structx overview --repo .` | Full codebase summary (no API key needed) |
| `npx structx status` | Show graph stats |
| `npx structx ask "<question>" --repo .` | Query the knowledge graph |
| `npx structx ingest .` | Re-parse codebase after code changes |
| `npx structx analyze . --yes` | Run semantic analysis on new entities |
| `npx structx doctor` | Validate environment and config |

### Flags

- `--api-key <key>` — pass Anthropic API key directly (on `ask`, `setup`, `analyze`)
- `--force` — overwrite existing instruction files (on `install`)
- `--verbose` — enable debug logging
- `--yes` — skip cost confirmation prompt (on `analyze`)

## Requirements

- Node.js >= 18
- Anthropic API key (`ANTHROPIC_API_KEY` env var or `--api-key` flag)

## Agent Workflow

The installed instruction files tell AI agents to follow this workflow:

1. **`structx status`** — check if the graph is initialized
2. **`structx setup .`** — bootstrap if needed
3. **`structx overview`** / **`structx ask`** — discover architecture, routes, types, relationships
4. **Read files** — for exact implementation details when editing or debugging
5. **`structx ingest .`** + **`structx analyze .`** — update the graph after changes
6. **`structx ask "what breaks if I change X?"`** — impact analysis before modifying existing code

StructX is best for fast discovery. Raw files are best for implementation precision. Use both.

## License

ISC
