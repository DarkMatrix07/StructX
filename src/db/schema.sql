-- StructX Database Schema

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS functions (
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

CREATE TABLE IF NOT EXISTS relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_function_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  callee_function_id INTEGER REFERENCES functions(id) ON DELETE SET NULL,
  callee_name TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  UNIQUE(caller_function_id, callee_name, relation_type)
);

CREATE TABLE IF NOT EXISTS analysis_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  function_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  priority INTEGER DEFAULT 0,
  reason TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME
);

CREATE TABLE IF NOT EXISTS semantic_cache (
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

CREATE TABLE IF NOT EXISTS qa_runs (
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

CREATE TABLE IF NOT EXISTS types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('interface', 'type_alias', 'enum')),
  full_text TEXT NOT NULL,
  is_exported BOOLEAN DEFAULT 0,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  purpose TEXT,
  semantic_analyzed_at DATETIME
);

CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  handler_name TEXT,
  handler_body TEXT NOT NULL,
  middleware TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  purpose TEXT,
  semantic_analyzed_at DATETIME
);

CREATE TABLE IF NOT EXISTS constants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value_text TEXT,
  type_annotation TEXT,
  is_exported BOOLEAN DEFAULT 0,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS file_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL UNIQUE REFERENCES files(id) ON DELETE CASCADE,
  import_count INTEGER DEFAULT 0,
  export_count INTEGER DEFAULT 0,
  function_count INTEGER DEFAULT 0,
  type_count INTEGER DEFAULT 0,
  route_count INTEGER DEFAULT 0,
  loc INTEGER DEFAULT 0,
  imports_json TEXT,
  exports_json TEXT,
  purpose TEXT,
  semantic_analyzed_at DATETIME
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_functions_name ON functions(name);
CREATE INDEX IF NOT EXISTS idx_functions_domain ON functions(domain);
CREATE INDEX IF NOT EXISTS idx_functions_file_id ON functions(file_id);
CREATE INDEX IF NOT EXISTS idx_relationships_caller ON relationships(caller_function_id);
CREATE INDEX IF NOT EXISTS idx_relationships_callee ON relationships(callee_function_id);
CREATE INDEX IF NOT EXISTS idx_analysis_queue_status ON analysis_queue(status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_semantic_cache_lookup ON semantic_cache(function_id, prompt_hash);
CREATE INDEX IF NOT EXISTS idx_types_file_id ON types(file_id);
CREATE INDEX IF NOT EXISTS idx_types_name ON types(name);
CREATE INDEX IF NOT EXISTS idx_routes_file_id ON routes(file_id);
CREATE INDEX IF NOT EXISTS idx_routes_path ON routes(path);
CREATE INDEX IF NOT EXISTS idx_constants_file_id ON constants(file_id);
CREATE INDEX IF NOT EXISTS idx_file_summaries_file_id ON file_summaries(file_id);
