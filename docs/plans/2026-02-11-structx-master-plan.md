# StructX — Master Build Plan

## Vision

StructX is a graph-powered code intelligence CLI. Instead of dumping entire repos into LLMs (50k-150k tokens), it parses TypeScript codebases at the function level, enriches each function with LLM-generated semantic metadata, and answers developer questions using tiny, precise context windows (1k-3k tokens).

**Core thesis:** Structured graph context can match or beat raw code dumps — at a fraction of the cost and latency.

---

## V1 Scope

**In scope:**
- TypeScript/TSX repositories only
- Function-level extraction (declarations, arrow functions, class methods)
- Call graph relationships (calls / called-by)
- Semantic fields: `purpose`, `behavior`, `side_effects`, `domain`, `complexity`
- LLM response caching (avoid redundant API calls)
- Incremental re-analysis on code changes
- 5 retrieval strategies: direct lookup, relationship, semantic search, domain filter, impact analysis
- LLM-powered question classifier (Haiku)
- Benchmark framework: StructX Agent vs Traditional Agent

**Out of scope:**
- Multi-language support
- IDE plugins / GUI
- Automated code edits
- Vector embeddings (FTS5 is sufficient for V1)
- File watcher / auto-ingestion (manual CLI + agent instructions instead)

---

## Tech Stack

| Component | Choice | Rationale |
|---|---|---|
| Runtime | Node.js + TypeScript | Target language = implementation language |
| AST Parser | `ts-morph` | High-level TS compiler API, mature |
| Database | SQLite via `better-sqlite3` | Zero config, FTS5 built-in |
| CLI Framework | `commander` | Lightweight, well-documented |
| LLM (analysis) | Claude Haiku | Cheapest model for structured extraction |
| LLM (classification) | Claude Haiku | Question type classification |
| LLM (answers) | Claude Sonnet | High quality for final answers |
| LLM SDK | `@anthropic-ai/sdk` | Official SDK |

---

## Database Schema

```sql
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE functions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  signature TEXT NOT NULL,
  body TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  is_exported BOOLEAN DEFAULT 0,
  is_async BOOLEAN DEFAULT 0,
  purpose TEXT,
  behavior_summary TEXT,
  side_effects_json TEXT,
  domain TEXT,
  complexity TEXT,
  semantic_analyzed_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_function_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  callee_function_id INTEGER REFERENCES functions(id) ON DELETE SET NULL,
  callee_name TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  UNIQUE(caller_function_id, callee_name, relation_type)
);

CREATE TABLE analysis_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  function_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  priority INTEGER DEFAULT 0,
  reason TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME
);

CREATE TABLE semantic_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  function_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  prompt_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  response_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(function_id, prompt_hash)
);

CREATE TABLE qa_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  question TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd REAL,
  response_time_ms INTEGER,
  files_accessed INTEGER,
  functions_retrieved INTEGER,
  graph_query_time_ms INTEGER,
  answer_text TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_functions_name ON functions(name);
CREATE INDEX idx_functions_domain ON functions(domain);
CREATE INDEX idx_functions_file_id ON functions(file_id);
CREATE INDEX idx_relationships_caller ON relationships(caller_function_id);
CREATE INDEX idx_relationships_callee ON relationships(callee_function_id);
CREATE INDEX idx_analysis_queue_status ON analysis_queue(status, priority DESC);
CREATE INDEX idx_semantic_cache_lookup ON semantic_cache(function_id, prompt_hash);

CREATE VIRTUAL TABLE functions_fts USING fts5(
  name, purpose, behavior_summary,
  content='functions', content_rowid='id'
);
```

---

## Project Structure

```
structx/
├── src/
│   ├── cli.ts                  # CLI entry point (commander setup)
│   ├── config.ts               # Configuration loading & defaults
│   ├── db/
│   │   ├── connection.ts       # SQLite connection + migrations
│   │   ├── schema.sql          # Schema definition
│   │   └── queries.ts          # Typed query helpers
│   ├── ingest/
│   │   ├── scanner.ts          # File discovery (.ts/.tsx)
│   │   ├── parser.ts           # AST extraction via ts-morph
│   │   ├── relationships.ts    # Call graph extraction
│   │   └── differ.ts           # Change detection (hash comparison, diff ratio)
│   ├── semantic/
│   │   ├── analyzer.ts         # LLM batch analysis orchestrator
│   │   ├── prompt.ts           # Prompt template builder
│   │   ├── validator.ts        # JSON response validation & sanitization
│   │   └── cost.ts             # Token estimation & cost calculation
│   ├── query/
│   │   ├── classifier.ts       # LLM-powered question type classification (Haiku)
│   │   ├── retriever.ts        # Graph-based context retrieval (5 strategies)
│   │   ├── context-builder.ts  # Assembles compact context payload
│   │   └── answerer.ts         # Final LLM answer generation
│   ├── benchmark/
│   │   ├── runner.ts           # Runs both agents on question set
│   │   ├── baseline.ts         # Traditional full-context agent
│   │   ├── questions.ts        # Fixed test question set
│   │   └── reporter.ts         # Markdown/CSV report generation
│   └── utils/
│       ├── logger.ts           # Structured logging
│       └── tokens.ts           # Token counting utility
├── tests/
│   ├── fixtures/               # Sample TS files for testing
│   ├── ingest.test.ts
│   ├── semantic.test.ts
│   ├── query.test.ts
│   └── benchmark.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

---

## Build Phases

### Phase 1: Scaffold + Database (Day 1-2)

**Goal:** Project boots, database initializes, CLI skeleton works.

**Tasks:**
1. Initialize TypeScript project + dependencies (`ts-morph`, `better-sqlite3`, `commander`, `@anthropic-ai/sdk`)
2. Implement `src/db/connection.ts` — creates SQLite DB, runs schema migration
3. Implement `src/db/schema.sql` — full schema from above
4. Implement `src/db/queries.ts` — typed insert/select/update helpers for all tables
5. Implement `src/config.ts` — loads config (repo path, API key, batch size, thresholds)
6. Implement `src/cli.ts` — register commands: `init`, `ingest`, `analyze`, `ask`, `benchmark`, `status`, `doctor`
7. Wire up `structx init` to create DB + config file
8. Wire up `structx doctor` to validate environment (Node version, API key, DB exists)

**Exit criteria:**
- `structx init` creates `.structx/db.sqlite` and `.structx/config.json`
- `structx status` shows empty stats (0 files, 0 functions)
- `structx doctor` validates environment

---

### Phase 2: Code Ingestion + Call Graph (Day 3-6)

**Goal:** Parse any TypeScript repo into a complete function graph stored in SQLite.

**Tasks:**
1. Implement `src/ingest/scanner.ts` — recursively find all `.ts/.tsx` files, skip `node_modules`/`dist`/`.d.ts`
2. Implement `src/ingest/parser.ts` using `ts-morph`:
   - Extract function declarations, arrow function variables, class methods
   - Capture: name, signature, body, start/end lines, is_exported, is_async
   - Hash function body (SHA-256) for change detection
3. Implement `src/ingest/relationships.ts`:
   - Walk each function's AST to find call expressions
   - Resolve callee names to function IDs where possible
   - Store unresolved callees by name
4. Implement `src/ingest/differ.ts`:
   - Compare file content_hash to detect changed files
   - Compare function code_hash to detect changed functions
   - Calculate diff ratio for body changes
   - `should_reanalyze()` logic: signature changed, body >30% changed, deps changed
5. Wire up `structx ingest <path>`:
   - First run: scan all, extract all, build full graph
   - Subsequent runs: only process changed files, queue changed functions
6. Update `structx status` to show: files scanned, functions extracted, relationships mapped, pending analysis

**Exit criteria:**
- `structx ingest ./project` populates files + functions + relationships
- Re-running on unchanged code is a no-op
- Re-running after edits only re-processes changed files
- `structx status` shows accurate counts

---

### Phase 3: Semantic Analysis Pipeline (Day 7-10)

**Goal:** Enrich every function with LLM-generated semantic metadata.

**Tasks:**
1. Implement `src/semantic/prompt.ts` — batch prompt template with function code, signature, location, call context
2. Implement `src/semantic/validator.ts` — JSON schema validation for required fields, text sanitization
3. Implement `src/semantic/cost.ts` — token estimation (~400 input/function + 200 overhead, ~100 output/function), cost calculation, pre-run cost display
4. Implement `src/semantic/analyzer.ts`:
   - Check `semantic_cache` before calling API
   - Batch functions into groups of 5-10
   - Call Claude Haiku with batch prompt
   - Validate JSON response; on failure: retry once with error context, then mark failed
   - Store results in `functions` table + cache in `semantic_cache`
   - Update `analysis_queue` status
   - Track tokens used and cost
5. Wire up `structx analyze` — show cost estimate, confirm, run pipeline, show summary
6. Sync FTS index after semantic fields are written

**Exit criteria:**
- `structx analyze` enriches all queued functions
- JSON validation pass rate >= 95% with retries
- Cost estimate shown before proceeding
- Cached responses reused on re-runs

---

### Phase 4: Query Engine (Day 11-15)

**Goal:** Answer developer questions using graph-powered context retrieval.

**Tasks:**
1. Implement `src/query/classifier.ts` — Haiku-powered question classification into 5 strategies:
   - Direct lookup, Relationship, Semantic search, Domain filter, Impact analysis
2. Implement `src/query/retriever.ts` — one method per strategy:
   - `directLookup(name)`: function + relationships
   - `relationshipQuery(name, direction)`: callers or callees with purposes
   - `semanticSearch(keywords)`: FTS5 query, top 10
   - `domainQuery(domain)`: filter by domain field
   - `impactAnalysis(name)`: recursive CTE for transitive callers
3. Implement `src/query/context-builder.ts` — format results into compact text (target 1k-3k tokens)
4. Implement `src/query/answerer.ts` — build final prompt, call Claude Sonnet, return answer + metrics
5. Wire up `structx ask "question"` — classify → retrieve → build context → answer → display + metrics
6. Store all runs in `qa_runs` table

**Exit criteria:**
- All 5 retrieval strategies work correctly
- Context payloads within 1k-3k tokens for typical queries
- Metrics tracked in `qa_runs`

---

### Phase 5: Benchmark Framework (Day 16-19)

**Goal:** Quantitatively prove StructX beats the traditional approach.

**Tasks:**
1. Implement `src/benchmark/questions.ts` — 8 fixed test questions
2. Implement `src/benchmark/baseline.ts` — Traditional Agent (read all TS files, concatenate, send to Sonnet)
3. Implement `src/benchmark/runner.ts` — run both agents on each question, collect metrics
4. Implement `src/benchmark/reporter.ts` — markdown comparison table + summary statistics + CSV export
5. Wire up `structx benchmark run` and `structx benchmark report`

**Exit criteria:**
- `structx benchmark run` executes all 8 questions in both modes
- `structx benchmark report` produces clean comparison table
- Token reduction measurable (target >= 60%)

---

### Phase 6: Polish + Hardening (Day 20-22)

**Goal:** Reliable, tested, usable.

**Tasks:**
1. Integration tests for ingest, semantic, query, benchmark
2. Error handling: API rate limiting (exponential backoff), malformed LLM responses, missing config
3. Structured JSON logging for debugging
4. Help text and usage examples for all CLI commands
5. Usage instructions document (for AI agents to auto-run ingest after changes)

**Exit criteria:**
- All tests pass
- `structx doctor` validates environment
- Works end-to-end on a real TypeScript repository

---

## CLI Commands

```
structx init                    # Create DB + config
structx doctor                  # Validate environment
structx ingest <repo-path>      # Parse codebase into graph
structx analyze                 # Run LLM semantic analysis
structx ask "question"          # Ask a question
structx benchmark run           # Run comparison benchmark
structx benchmark report        # Generate comparison report
structx status                  # Show current stats
```

---

## Success Metrics

- Function extraction coverage >= 95% on TS repos
- Semantic JSON parse success >= 99% (with retries)
- StructX token usage reduction >= 60% vs baseline
- StructX API cost reduction >= 50% vs baseline
- StructX median latency <= baseline median latency
- Answer quality: no significant degradation (manual review)

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| AST parser misses complex patterns | Log unresolved calls explicitly; add coverage metrics to `status` |
| LLM returns malformed JSON | Schema validation + 1 retry with error context; fallback to individual calls |
| Traditional baseline hits context limit | Cap at model max context; log when truncation occurs |
| FTS search quality too low | Normalize domain/complexity to fixed taxonomies; vector search in V2 |
| Cost surprises during analysis | Always show cost estimate + require confirmation before API calls |
| Poor semantic labeling consistency | Fixed taxonomy for `domain` and `complexity`, normalization rules |
