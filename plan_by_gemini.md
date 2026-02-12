# StructX Development Plan

This plan outlines the development roadmap for building **StructX**, a semantic code analysis tool that leverages LLMs to generate structured metadata about code functions and uses this knowledge graph to answer developer questions efficiently.

## Phase 1: Foundation (Parser & Storage)
**Goal:** Extract functions from the codebase and store their raw data.

1.  **Project Setup**
    - Initialize TypeScript project for StructX cli/service.
    - Set up dependencies: `sqlite3`, `better-sqlite3` (or PostgreSQL), `ts-morph` (for AST parsing), `dotenv`.

2.  **Code Parser (AST)**
    - Implement a scanner using `ts-morph` to walk through the target codebase.
    - Extract:
        - Function declarations (`function`, arrow functions, class methods).
        - Signatures (params, return types).
        - Function bodies.
        - Location (file path, line numbers).
        - Import/Export relationships.

3.  **Database Design**
    - specific schema for storing function metadata.
    - Tables:
        - `files` (path, last_modified, hash)
        - `functions` (id, name, signature, body, file_id, semantic_data_json)
        - `dependencies` (caller_id, callee_id, type)
        - `analysis_queue` (function_id, priority, status)

## Phase 2: Semantic Analysis Engine
**Goal:** Enrich function data with semantic understanding using LLMs.

1.  **LLM Integration**
    - specific integration with Anthropic API (Claude 3 Haiku).
    - Implement robust error handling and rate limiting.

2.  **Analysis Pipeline**
    - Create the "Semantic Analyzer" module.
    - **Prompt Engineering**: Refine the prompt from `idea.md` to ensure consistent JSON output.
    - **Batch Processing**: Group functions into batches (e.g., 5-10) to optimize token usage.
    - **Execution Loop**:
        - Fetch unanalyzed functions from DB.
        - Send to LLM.
        - Parse JSON response.
        - Update `functions` table with `purpose`, `behavior`, `side_effects`, `domain`, `complexity`.

3.  **Cost Management**
    - Implement token tracking per function.
    - Add a "dry run" mode to estimate costs before full analysis (as described in `idea.md`).

## Phase 3: Incremental Intelligence
**Goal:** Keep the knowledge graph up-to-date efficiently.

1.  **Change Detection**
    - Implement a file watcher (e.g., using `chokidar`).
    - **Smart Hashing**: Calculate content hashes (SHA-256) for function bodies.
    - Compare new hash vs. stored hash to detect changes.

2.  **Re-analysis Logic**
    - Implement the `should_reanalyze` heuristic:
        - Signature change -> **High Priority**.
        - Body change > 30% (diff ratio) -> **Medium Priority**.
        - Dependency change -> **Low Priority** (or re-link only).
    - Queue updated functions for re-analysis.

3.  **Dependency Graphing**
    - Enhance the parser to statically analyze calls within function bodies (e.g., identifying `validateEmail()` call inside `login()`).
    - Populate the `dependencies` table for fast "Called By" / "Calls" queries.

## Phase 4: Query Engine (The "StructX Agent")
**Goal:** Answer developer questions using the structured knowledge graph.

1.  **Query Parser**
    - Implement a light LLM step (or regex heuristics) to classify user questions:
        - *Direct Lookup* ("What does `login` do?")
        - *Relationship* ("Who calls `login`?")
        - *Semantic* ("Where is authentication handled?")
        - *Domain* ("Show all database ops")

2.  **Retrieval Strategies (RAG)**
    - **Direct**: SQL `SELECT * FROM functions WHERE name = ?`.
    - **Graph**: SQL recursive CTEs or joined queries for dependencies.
    - **Semantic**: Implement vector embeddings (optional enhancement) or keyword search on `purpose/behavior` columns.

3.  **Context Assembly & Answer Generation**
    - Build a compact context prompt (1k-3k tokens) containing only the relevant function metadata (not full code).
    - Send to LLM (Claude 3.5 Sonnet) for the final answer.

## Phase 5: Evaluation & Refinement
**Goal:** Measure performance against a traditional "read-everything" agent.

1.  **Benchmarking Suite**
    - specific set of test questions (Traceability, summarization, impact analysis).
    - **Metrics**:
        - Token usage (Input/Output).
        - Latency (Time to First Token, Total Time).
        - Accuracy (Manual review of answers).
        - Cost ($).

2.  **Comparison Framework**
    - Implement the "Traditional Agent" baseline (reads all files into context).
    - Run side-by-side comparisons.
    - Generate report: "StructX vs Traditional" showing cost/speed improvements.

## Technical Stack Recommendation
- **Language**: TypeScript (Node.js)
- **Database**: SQLite (local) or PostgreSQL (team)
- **LLM**: Anthropic Claude 3 Haiku (Analysis) & Sonnet (Querying)
- **ORM/Query Builder**: Kysely or Prisma (for type-safe SQL)
- **AST Parser**: ts-morph
