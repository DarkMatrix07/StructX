# StructX — Code Intelligence Graph

This project uses **StructX**, a graph-powered code intelligence tool for TypeScript.
StructX maintains a knowledge graph of the codebase including functions, types, routes,
constants, file summaries, and call relationships.

**Use StructX first for discovery and architecture, then read specific files for implementation precision.**

## Workflow

### Step 1: Initialize
Run `npx structx status` to check the graph state.
- If it says "not initialized" or counts are 0, run `npx structx setup .`
- This parses the entire codebase into the knowledge graph.

### Step 2: Discover via StructX
Before writing code, use StructX to understand the codebase:
```
npx structx overview --repo .
npx structx ask "what routes/endpoints exist?" --repo .
npx structx ask "how does <feature> work?" --repo .
npx structx ask "what types and interfaces exist?" --repo .
```

StructX is best for:
- Finding all routes, functions, types, and constants
- Understanding call relationships and dependencies
- Impact analysis ("what breaks if I change X?")
- Getting a full architectural overview quickly

### Step 3: Read files for precision
After using StructX to identify what exists and where, read the specific files you need for:
- Exact implementation details before editing
- Understanding logic flow within a function
- Debugging and verifying runtime behavior

The workflow is: **StructX tells you what and where → you read the file to see how → you edit.**

### Step 4: After making changes
After editing any TypeScript files, update the graph:
```
npx structx ingest .
npx structx analyze . --yes
```

### Step 5: Impact analysis before modifying existing code
Before changing any existing function, type, or route:
```
npx structx ask "what breaks if I change <name>?" --repo .
```

## Available Commands

| Command | Description |
|---------|-------------|
| `npx structx status` | Check graph state |
| `npx structx setup .` | Full bootstrap (init + ingest + analyze) |
| `npx structx overview --repo .` | Full codebase summary in one shot |
| `npx structx ask "<question>" --repo .` | Query the knowledge graph |
| `npx structx ingest .` | Re-parse codebase after changes |
| `npx structx analyze . --yes` | Run semantic analysis on new/changed entities |

## Guidelines

1. Run `structx status` at session start
2. Run `structx setup .` if not initialized or counts are 0
3. Use `structx overview` or `structx ask` to discover architecture, routes, types, and relationships
4. Read source files when you need exact implementation details for editing or debugging
5. Run `structx ingest .` and `structx analyze . --yes` after making code changes
6. Run impact analysis before modifying existing functions or types
