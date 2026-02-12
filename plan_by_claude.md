# StructX — Build Plan by Claude

## What We're Building

StructX is a graph-powered code intelligence CLI that replaces brute-force "dump the whole repo into an LLM" approaches with surgical, graph-based context retrieval. It parses TypeScript codebases at the function level, enriches each function with LLM-generated semantic metadata, and answers developer questions using tiny, precise context windows instead of massive ones.

The core thesis: **1k-3k tokens of structured graph context can match or beat 50k-150k tokens of raw code** — at a fraction of the cost and latency.

---

## V1 Scope

**In scope:**
- TypeScript/TSX repositories only
- Function-level extraction (declarations, arrow functions, class methods)
- Semantic fields: `purpose`, `behavior`, `side_effects`, `domain`, `complexity`
- Call graph relationships (calls / called-by)
- Incremental re-analysis on code changes
- 5 retrieval strategies: direct lookup, relationship, semantic search, domain filter, impact analysis
- Benchmark framework: StructX Agent vs Traditional Agent on fixed question set

**Out of scope:**
- Multi-language support
- IDE plugins / GUI
- Automated code edits or refactoring
- Vector embeddings (plain FTS is sufficient for V1)

---

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Node.js + TypeScript | Target language = implementation language, dogfooding |
| AST Parser | `ts-morph` | High-level TS compiler API, mature, handles all TS syntax |
| Database | SQLite via `better-sqlite3` | Zero config, single file, FTS5 built-in, fast for local tool |
| CLI Framework | `commander` | Lightweight, well-documented |
| LLM (analysis) | Claude Haiku | Cheapest model sufficient for structured extraction |
| LLM (query answers) | Claude Sonnet 4 | High quality for final answers, same model for fair benchmark |
| LLM SDK | `@anthropic-ai/sdk` | Official SDK |

---

## Database Schema

```sql
-- Core tables
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
  -- Semantic fields (populated by LLM analysis)
  purpose TEXT,
  behavior_summary TEXT,
  side_effects_json TEXT,  -- JSON array of strings
  domain TEXT,
  complexity TEXT,         -- 'low' | 'medium' | 'high'
  semantic_analyzed_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_function_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  callee_function_id INTEGER REFERENCES functions(id) ON DELETE SET NULL,
  callee_name TEXT NOT NULL,        -- raw name, even if unresolved
  relation_type TEXT NOT NULL,      -- 'calls' | 'imports'
  UNIQUE(caller_function_id, callee_name, relation_type)
);

CREATE TABLE analysis_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  function_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  priority INTEGER DEFAULT 0,       -- higher = process first
  reason TEXT NOT NULL,              -- 'new' | 'signature_changed' | 'body_changed' | 'deps_changed'
  status TEXT DEFAULT 'pending',     -- 'pending' | 'processing' | 'done' | 'failed'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME
);

CREATE TABLE qa_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,                -- 'structx' | 'traditional'
  question TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd REAL,
  response_time_ms INTEGER,
  files_accessed INTEGER,            -- traditional only
  functions_retrieved INTEGER,       -- structx only
  graph_query_time_ms INTEGER,       -- structx only
  answer_text TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_functions_name ON functions(name);
CREATE INDEX idx_functions_domain ON functions(domain);
CREATE INDEX idx_functions_file_id ON functions(file_id);
CREATE INDEX idx_relationships_caller ON relationships(caller_function_id);
CREATE INDEX idx_relationships_callee ON relationships(callee_function_id);
CREATE INDEX idx_analysis_queue_status ON analysis_queue(status, priority DESC);

-- Full-text search for semantic queries
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
│   │   ├── schema.sql          # Schema definition (above)
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
│   │   ├── classifier.ts       # Question type classification
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
1. `npm init` + TypeScript config + dependencies (`ts-morph`, `better-sqlite3`, `commander`, `@anthropic-ai/sdk`)
2. Implement `src/db/connection.ts` — creates SQLite DB, runs schema migration
3. Implement `src/db/queries.ts` — typed insert/select/update helpers for all tables
4. Implement `src/config.ts` — loads config (repo path, API key, batch size, thresholds)
5. Implement `src/cli.ts` — register commands: `init`, `ingest`, `analyze`, `ask`, `benchmark`, `status`
6. Wire up `structx init` to create DB + config file

**Exit criteria:**
- `structx init` creates `.structx/db.sqlite` and `.structx/config.json`
- `structx status` shows empty stats (0 files, 0 functions)

---

### Phase 2: Code Ingestion + Call Graph (Day 3-6)

**Goal:** Parse any TypeScript repo into a complete function graph stored in SQLite.

**Tasks:**
1. Implement `src/ingest/scanner.ts` — recursively find all `.ts/.tsx` files, skip `node_modules`/`dist`/`.d.ts`
2. Implement `src/ingest/parser.ts` using `ts-morph`:
   - Extract function declarations, arrow function variables, class methods
   - Capture: name, full signature, body text, start/end lines, is_exported, is_async
   - Hash function body (SHA-256) for change detection
3. Implement `src/ingest/relationships.ts`:
   - Walk each function's AST to find call expressions
   - Resolve callee names to function IDs in the DB where possible
   - Store unresolved callees by name (for cross-file or external calls)
4. Implement `src/ingest/differ.ts`:
   - Compare file content_hash to detect changed files
   - Compare function code_hash to detect changed functions
   - Calculate diff ratio for body changes (Levenshtein or line-based)
   - Implement `should_reanalyze()` logic from the idea (signature changed, body >30%, deps changed)
5. Wire up `structx ingest <path>`:
   - First run: scan all files, extract all functions, build full graph
   - Subsequent runs: only process changed files, queue changed functions for re-analysis
6. Wire up `structx status` to show: files scanned, functions extracted, relationships mapped, pending analysis

**Exit criteria:**
- `structx ingest ./my-ts-project` populates files + functions + relationships tables
- Re-running on unchanged code is a no-op
- Re-running after editing a file only re-processes that file
- `structx status` shows accurate counts

---

### Phase 3: Semantic Analysis Pipeline (Day 7-10)

**Goal:** Enrich every function with LLM-generated semantic metadata.

**Tasks:**
1. Implement `src/semantic/prompt.ts`:
   - Build the batch prompt template from the idea doc
   - Include function code, signature, location, and call context
   - Instruction: respond with JSON array only
2. Implement `src/semantic/validator.ts`:
   - Validate JSON structure against required fields: `function_name`, `purpose`, `side_effects`, `behavior`, `domain`, `complexity`
   - Sanitize text fields (strip markdown, trim whitespace)
   - Return validation errors for logging
3. Implement `src/semantic/cost.ts`:
   - Token estimation: ~400 input tokens/function + 200 overhead/batch, ~100 output tokens/function
   - Cost calculation using Haiku pricing
   - Pre-analysis cost display with confirmation prompt
4. Implement `src/semantic/analyzer.ts`:
   - Fetch pending functions from `analysis_queue` (or all unanalyzed on first run)
   - Batch into groups of 5-10
   - Call Claude Haiku API with batch prompt
   - Parse + validate JSON response
   - On validation failure: retry once with error feedback, then mark as failed
   - Store semantic fields in `functions` table
   - Update `analysis_queue` status
   - Track and display: functions analyzed, tokens used, cost, failures
5. Wire up `structx analyze`:
   - Show cost estimate, ask for confirmation
   - Run analysis pipeline
   - Show summary: X functions analyzed, Y tokens, $Z cost
6. Sync FTS index: after semantic fields are written, rebuild `functions_fts`

**Exit criteria:**
- `structx analyze` enriches all queued functions with semantic metadata
- JSON validation pass rate >= 95% (with retries)
- Cost estimate is shown before proceeding
- `structx status` shows analyzed vs unanalyzed function counts

---

### Phase 4: Query Engine — 5 Retrieval Strategies (Day 11-15)

**Goal:** Answer developer questions using graph-powered context retrieval.

**Tasks:**
1. Implement `src/query/classifier.ts` — classify question into retrieval strategy:
   - **Direct lookup**: question references a specific function name → `"What does login do?"`
   - **Relationship**: asks about callers/callees → `"What calls login?"`
   - **Semantic search**: asks about a concept/topic → `"What handles authentication?"`
   - **Domain filter**: asks about a domain → `"Show all database operations"`
   - **Impact analysis**: asks about change impact → `"What breaks if I change validateEmail?"`
   - Implementation: light LLM call (Haiku) or regex/keyword heuristics
2. Implement `src/query/retriever.ts` — one method per strategy:
   - `directLookup(name)`: SELECT function + JOIN relationships for calls/called-by
   - `relationshipQuery(name, direction)`: SELECT callers or callees with their purposes
   - `semanticSearch(keywords)`: FTS5 query on `functions_fts`, return top 10
   - `domainQuery(domain)`: SELECT WHERE domain = ?, return all with purposes
   - `impactAnalysis(name)`: Recursive CTE to find all transitive callers + affected functions
3. Implement `src/query/context-builder.ts`:
   - Take retriever results and format into compact text block
   - Target: 1k-3k tokens (measure and warn if exceeding)
   - Include: function name, location, signature, purpose, side effects, relationships
4. Implement `src/query/answerer.ts`:
   - Build final prompt: system instructions + assembled context + user question
   - Call Claude Sonnet 4
   - Return answer + track metrics (tokens, cost, time)
5. Wire up `structx ask "question here"`:
   - Classify → Retrieve → Build context → Answer
   - Display answer + metrics (tokens used, cost, response time)

**Exit criteria:**
- All 5 retrieval strategies work correctly
- `structx ask "What does login do?"` returns accurate, graph-grounded answer
- Context payloads stay within 1k-3k token target for typical queries
- Metrics are tracked in `qa_runs` table

---

### Phase 5: Benchmark Framework (Day 16-19)

**Goal:** Quantitatively prove StructX beats the traditional approach.

**Tasks:**
1. Implement `src/benchmark/questions.ts` — the 8 fixed test questions from the idea:
   1. "What functions handle user authentication?"
   2. "What does the login function call?"
   3. "Show me all functions that use Redis"
   4. "What calls the validatePassword function?"
   5. "How is session management implemented?"
   6. "What database operations modify user data?"
   7. "Which functions have side effects?"
   8. "Find all async functions in the authentication domain"
2. Implement `src/benchmark/baseline.ts` — Traditional Agent:
   - Read all TS files from target repo
   - Concatenate into one massive prompt (50k-150k tokens)
   - Send to Claude Sonnet 4 with the question
   - Track: input/output tokens, cost, time, files accessed
3. Implement `src/benchmark/runner.ts`:
   - For each question: run Traditional Agent, then StructX Agent
   - Collect all metrics into `qa_runs` table
   - Handle errors gracefully (if context too large for traditional, log it)
4. Implement `src/benchmark/reporter.ts`:
   - Generate markdown comparison table:
     | Question | Mode | Input Tokens | Output Tokens | Cost | Time | Context Size |
   - Generate summary statistics: avg token reduction %, avg cost reduction %, avg latency comparison
   - Export as markdown file + optional CSV
5. Wire up `structx benchmark run` and `structx benchmark report`

**Exit criteria:**
- `structx benchmark run` executes all 8 questions in both modes
- `structx benchmark report` produces a clean comparison table
- Token reduction is measurable and significant (target: >= 60%)

---

### Phase 6: Polish + Hardening (Day 20-22)

**Goal:** Make it reliable, tested, and usable.

**Tasks:**
1. Add integration tests:
   - Ingest: parse a fixture TS project, verify function/relationship counts
   - Semantic: mock LLM responses, verify DB updates + validation
   - Query: verify each retrieval strategy returns correct results
   - Benchmark: verify metrics are captured correctly
2. Add error handling:
   - API rate limiting (exponential backoff)
   - Graceful handling of malformed LLM responses
   - Clear error messages for missing config/API keys
3. Add `structx doctor` command — validate environment:
   - Check Node.js version
   - Check API key is set
   - Check DB exists and schema is current
   - Check target repo path is valid
4. Logging: structured JSON logs for debugging analysis failures
5. Help text and usage examples for all CLI commands

**Exit criteria:**
- All tests pass
- `structx doctor` validates environment
- Tool works end-to-end on a real TypeScript repository

---

## CLI Commands Summary

```
structx init                          # Create DB + config
structx doctor                        # Validate environment
structx ingest <repo-path>            # Parse codebase into graph
structx analyze                       # Run LLM semantic analysis
structx ask "question"                # Ask a question
structx benchmark run                 # Run comparison benchmark
structx benchmark report              # Generate comparison report
structx status                        # Show current stats
```

---

## Key Design Decisions

1. **SQLite over Postgres** — This is a local dev tool. Zero-config single-file DB is the right call. FTS5 covers the semantic search needs without pulling in a vector DB.

2. **Batch size of 5-10 functions** — Balances token efficiency (amortize prompt overhead) against response reliability (smaller batches = easier JSON validation).

3. **Haiku for analysis, Sonnet for answers** — Analysis is structured extraction (Haiku handles it fine at 1/20th the cost). Answer generation needs reasoning quality, so Sonnet.

4. **FTS5 over vector embeddings** — For V1, keyword-based full-text search on `purpose` and `behavior_summary` is sufficient. Vector search is a V2 optimization if FTS proves inadequate.

5. **30% diff threshold for re-analysis** — From the idea doc. Avoids re-analyzing on trivial formatting changes while catching meaningful edits. Tunable via config.

6. **Question classification before retrieval** — Instead of always doing expensive graph traversals, classify first and use the cheapest retrieval strategy that fits. Direct lookup is a simple SQL SELECT; impact analysis is a recursive CTE. Match the query to the question.

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| AST parser misses arrow functions in complex patterns | Incomplete graph | Log unresolved calls explicitly; add coverage metrics to `structx status` |
| LLM returns malformed JSON | Analysis failures | Schema validation + 1 retry with error context; batch fallback to individual calls |
| Traditional baseline hits context limit | Unfair comparison | Cap traditional agent at model max context; log when truncation occurs |
| FTS search quality too low | Poor semantic retrieval | Normalize domain/complexity to fixed taxonomies; consider vector search in V2 |
| Cost surprises during analysis | User trust | Always show cost estimate + require confirmation before API calls |

---

## Success Metrics

- **Function extraction coverage**: >= 95% of functions in target TS repos
- **Semantic analysis success rate**: >= 99% after retries
- **Token reduction**: StructX uses >= 60% fewer tokens than traditional on benchmark questions
- **Cost reduction**: >= 50% cheaper per question
- **Latency**: StructX median response time <= traditional median
- **Answer quality**: No significant degradation (manual review of benchmark answers)
