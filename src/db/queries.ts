import type Database from 'better-sqlite3';

// ── File queries ──

export interface FileRow {
  id: number;
  path: string;
  content_hash: string;
  updated_at: string;
}

export function upsertFile(db: Database.Database, filePath: string, contentHash: string): number {
  const existing = db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number } | undefined;
  if (existing) {
    db.prepare(`
      UPDATE files SET content_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(contentHash, existing.id);
    return existing.id;
  }
  const stmt = db.prepare(`
    INSERT INTO files (path, content_hash, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `);
  const result = stmt.run(filePath, contentHash);
  return Number(result.lastInsertRowid);
}

export function getFileByPath(db: Database.Database, filePath: string): FileRow | undefined {
  return db.prepare('SELECT * FROM files WHERE path = ?').get(filePath) as FileRow | undefined;
}

export function getAllFiles(db: Database.Database): FileRow[] {
  return db.prepare('SELECT * FROM files').all() as FileRow[];
}

export function deleteFile(db: Database.Database, fileId: number): void {
  db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
}

// ── Function queries ──

export interface FunctionRow {
  id: number;
  file_id: number;
  name: string;
  signature: string;
  body: string;
  code_hash: string;
  start_line: number;
  end_line: number;
  is_exported: number;
  is_async: number;
  purpose: string | null;
  behavior_summary: string | null;
  side_effects_json: string | null;
  domain: string | null;
  complexity: string | null;
  semantic_analyzed_at: string | null;
  updated_at: string;
}

export interface InsertFunction {
  file_id: number;
  name: string;
  signature: string;
  body: string;
  code_hash: string;
  start_line: number;
  end_line: number;
  is_exported: boolean;
  is_async: boolean;
}

export function insertFunction(db: Database.Database, fn: InsertFunction): number {
  const stmt = db.prepare(`
    INSERT INTO functions (file_id, name, signature, body, code_hash, start_line, end_line, is_exported, is_async)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    fn.file_id, fn.name, fn.signature, fn.body, fn.code_hash,
    fn.start_line, fn.end_line, fn.is_exported ? 1 : 0, fn.is_async ? 1 : 0
  );
  return Number(result.lastInsertRowid);
}

export function getFunctionByName(db: Database.Database, name: string): FunctionRow | undefined {
  return db.prepare('SELECT * FROM functions WHERE name = ?').get(name) as FunctionRow | undefined;
}

export function getFunctionById(db: Database.Database, id: number): FunctionRow | undefined {
  return db.prepare('SELECT * FROM functions WHERE id = ?').get(id) as FunctionRow | undefined;
}

export function getFunctionsByFileId(db: Database.Database, fileId: number): FunctionRow[] {
  return db.prepare('SELECT * FROM functions WHERE file_id = ?').all(fileId) as FunctionRow[];
}

export function getAllFunctions(db: Database.Database): FunctionRow[] {
  return db.prepare('SELECT * FROM functions').all() as FunctionRow[];
}

export function deleteFunctionsByFileId(db: Database.Database, fileId: number): void {
  db.prepare('DELETE FROM functions WHERE file_id = ?').run(fileId);
}

export function updateSemanticFields(
  db: Database.Database,
  functionId: number,
  fields: {
    purpose: string;
    behavior_summary: string;
    side_effects_json: string;
    domain: string;
    complexity: string;
  }
): void {
  db.prepare(`
    UPDATE functions
    SET purpose = ?,
        behavior_summary = ?,
        side_effects_json = ?,
        domain = ?,
        complexity = ?,
        semantic_analyzed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    fields.purpose, fields.behavior_summary, fields.side_effects_json,
    fields.domain, fields.complexity, functionId
  );
}

// ── Relationship queries ──

export interface RelationshipRow {
  id: number;
  caller_function_id: number;
  callee_function_id: number | null;
  callee_name: string;
  relation_type: string;
}

export function insertRelationship(
  db: Database.Database,
  callerFunctionId: number,
  calleeName: string,
  relationType: string,
  calleeFunctionId?: number
): void {
  db.prepare(`
    INSERT OR IGNORE INTO relationships (caller_function_id, callee_function_id, callee_name, relation_type)
    VALUES (?, ?, ?, ?)
  `).run(callerFunctionId, calleeFunctionId ?? null, calleeName, relationType);
}

export function getCallees(db: Database.Database, callerFunctionId: number): RelationshipRow[] {
  return db.prepare(
    'SELECT * FROM relationships WHERE caller_function_id = ? AND relation_type = ?'
  ).all(callerFunctionId, 'calls') as RelationshipRow[];
}

export function getCallers(db: Database.Database, calleeFunctionId: number): RelationshipRow[] {
  return db.prepare(
    'SELECT * FROM relationships WHERE callee_function_id = ? AND relation_type = ?'
  ).all(calleeFunctionId, 'calls') as RelationshipRow[];
}

export function getCallersByName(db: Database.Database, calleeName: string): RelationshipRow[] {
  return db.prepare(
    'SELECT * FROM relationships WHERE callee_name = ? AND relation_type = ?'
  ).all(calleeName, 'calls') as RelationshipRow[];
}

export function deleteRelationshipsByCallerFunctionId(db: Database.Database, callerFunctionId: number): void {
  db.prepare('DELETE FROM relationships WHERE caller_function_id = ?').run(callerFunctionId);
}

// ── Analysis Queue queries ──

export interface AnalysisQueueRow {
  id: number;
  function_id: number;
  priority: number;
  reason: string;
  status: string;
  created_at: string;
  processed_at: string | null;
}

export function enqueueForAnalysis(
  db: Database.Database,
  functionId: number,
  reason: string,
  priority: number = 0
): void {
  db.prepare(`
    INSERT INTO analysis_queue (function_id, priority, reason, status)
    VALUES (?, ?, ?, 'pending')
  `).run(functionId, priority, reason);
}

export function getPendingAnalysis(db: Database.Database, limit: number = 10): AnalysisQueueRow[] {
  return db.prepare(
    'SELECT * FROM analysis_queue WHERE status = ? ORDER BY priority DESC, created_at ASC LIMIT ?'
  ).all('pending', limit) as AnalysisQueueRow[];
}

export function updateAnalysisStatus(
  db: Database.Database,
  queueId: number,
  status: string
): void {
  db.prepare(`
    UPDATE analysis_queue SET status = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(status, queueId);
}

export function getPendingAnalysisCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM analysis_queue WHERE status = ?').get('pending') as any;
  return row.count;
}

// ── Semantic Cache queries ──

export interface SemanticCacheRow {
  id: number;
  function_id: number;
  prompt_hash: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  response_json: string;
  created_at: string;
}

export function getCachedResponse(
  db: Database.Database,
  functionId: number,
  promptHash: string
): SemanticCacheRow | undefined {
  return db.prepare(
    'SELECT * FROM semantic_cache WHERE function_id = ? AND prompt_hash = ?'
  ).get(functionId, promptHash) as SemanticCacheRow | undefined;
}

export function insertCachedResponse(
  db: Database.Database,
  functionId: number,
  promptHash: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  responseJson: string
): void {
  db.prepare(`
    INSERT OR REPLACE INTO semantic_cache (function_id, prompt_hash, model, input_tokens, output_tokens, cost_usd, response_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(functionId, promptHash, model, inputTokens, outputTokens, costUsd, responseJson);
}

// ── QA Runs queries ──

export interface QaRunRow {
  id: number;
  mode: string;
  question: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  response_time_ms: number | null;
  files_accessed: number | null;
  functions_retrieved: number | null;
  graph_query_time_ms: number | null;
  answer_text: string | null;
  created_at: string;
}

export function insertQaRun(
  db: Database.Database,
  run: Omit<QaRunRow, 'id' | 'created_at'>
): number {
  const stmt = db.prepare(`
    INSERT INTO qa_runs (mode, question, input_tokens, output_tokens, total_tokens, cost_usd, response_time_ms, files_accessed, functions_retrieved, graph_query_time_ms, answer_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    run.mode, run.question, run.input_tokens, run.output_tokens, run.total_tokens,
    run.cost_usd, run.response_time_ms, run.files_accessed, run.functions_retrieved,
    run.graph_query_time_ms, run.answer_text
  );
  return Number(result.lastInsertRowid);
}

export function getQaRuns(db: Database.Database, mode?: string): QaRunRow[] {
  if (mode) {
    return db.prepare('SELECT * FROM qa_runs WHERE mode = ? ORDER BY created_at DESC').all(mode) as QaRunRow[];
  }
  return db.prepare('SELECT * FROM qa_runs ORDER BY created_at DESC').all() as QaRunRow[];
}

// ── FTS queries ──

export function searchFunctions(db: Database.Database, query: string, limit: number = 10): FunctionRow[] {
  if (!query.trim()) return [];
  return db.prepare(`
    SELECT f.* FROM functions f
    JOIN functions_fts fts ON f.id = fts.rowid
    WHERE functions_fts MATCH ?
    LIMIT ?
  `).all(query, limit) as FunctionRow[];
}

export function rebuildFtsIndex(db: Database.Database): void {
  db.exec("INSERT INTO functions_fts(functions_fts) VALUES('rebuild')");
}

// ── Stats queries ──

export interface Stats {
  totalFiles: number;
  totalFunctions: number;
  totalRelationships: number;
  analyzedFunctions: number;
  pendingAnalysis: number;
  totalQaRuns: number;
  totalTypes: number;
  totalRoutes: number;
  totalConstants: number;
  totalFileSummaries: number;
}

export function getStats(db: Database.Database): Stats {
  const files = db.prepare('SELECT COUNT(*) as count FROM files').get() as any;
  const functions = db.prepare('SELECT COUNT(*) as count FROM functions').get() as any;
  const relationships = db.prepare('SELECT COUNT(*) as count FROM relationships').get() as any;
  const analyzed = db.prepare('SELECT COUNT(*) as count FROM functions WHERE semantic_analyzed_at IS NOT NULL').get() as any;
  const pending = db.prepare("SELECT COUNT(*) as count FROM analysis_queue WHERE status = 'pending'").get() as any;
  const qaRuns = db.prepare('SELECT COUNT(*) as count FROM qa_runs').get() as any;

  // New entity counts — use try/catch for backward compat with old DBs
  let typesCount = 0, routesCount = 0, constantsCount = 0, fileSummariesCount = 0;
  try { typesCount = (db.prepare('SELECT COUNT(*) as count FROM types').get() as any).count; } catch {}
  try { routesCount = (db.prepare('SELECT COUNT(*) as count FROM routes').get() as any).count; } catch {}
  try { constantsCount = (db.prepare('SELECT COUNT(*) as count FROM constants').get() as any).count; } catch {}
  try { fileSummariesCount = (db.prepare('SELECT COUNT(*) as count FROM file_summaries').get() as any).count; } catch {}

  return {
    totalFiles: files.count,
    totalFunctions: functions.count,
    totalRelationships: relationships.count,
    analyzedFunctions: analyzed.count,
    pendingAnalysis: pending.count,
    totalQaRuns: qaRuns.count,
    totalTypes: typesCount,
    totalRoutes: routesCount,
    totalConstants: constantsCount,
    totalFileSummaries: fileSummariesCount,
  };
}

// ── Callee resolution ──

export function resolveNullCallees(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE relationships SET callee_function_id = (
      SELECT f.id FROM functions f WHERE f.name = relationships.callee_name LIMIT 1
    ) WHERE callee_function_id IS NULL
      AND EXISTS (SELECT 1 FROM functions f WHERE f.name = relationships.callee_name)
  `).run();
  return result.changes;
}

// ── Impact analysis (recursive CTE) ──

export function getTransitiveCallers(db: Database.Database, functionId: number): FunctionRow[] {
  return db.prepare(`
    WITH RECURSIVE callers AS (
      SELECT caller_function_id AS id FROM relationships
      WHERE callee_function_id = ? AND relation_type = 'calls'
      UNION
      SELECT r.caller_function_id FROM relationships r
      JOIN callers c ON r.callee_function_id = c.id
      WHERE r.relation_type = 'calls'
    )
    SELECT DISTINCT f.* FROM functions f
    JOIN callers c ON f.id = c.id
  `).all(functionId) as FunctionRow[];
}

export function getTransitiveCallersRobust(db: Database.Database, functionId: number, functionName: string): FunctionRow[] {
  return db.prepare(`
    WITH RECURSIVE callers AS (
      SELECT caller_function_id AS id FROM relationships
      WHERE (callee_function_id = ? OR callee_name = ?) AND relation_type = 'calls'
      UNION
      SELECT r.caller_function_id FROM relationships r
      JOIN callers c ON r.callee_function_id = c.id
      WHERE r.relation_type = 'calls'
    )
    SELECT DISTINCT f.* FROM functions f
    JOIN callers c ON f.id = c.id
  `).all(functionId, functionName) as FunctionRow[];
}

// ── Type queries ──

export interface TypeRow {
  id: number;
  file_id: number;
  name: string;
  kind: 'interface' | 'type_alias' | 'enum';
  full_text: string;
  is_exported: number;
  start_line: number;
  end_line: number;
  purpose: string | null;
  semantic_analyzed_at: string | null;
}

export interface InsertType {
  file_id: number;
  name: string;
  kind: 'interface' | 'type_alias' | 'enum';
  full_text: string;
  is_exported: boolean;
  start_line: number;
  end_line: number;
}

export function insertType(db: Database.Database, t: InsertType): number {
  const result = db.prepare(`
    INSERT INTO types (file_id, name, kind, full_text, is_exported, start_line, end_line)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(t.file_id, t.name, t.kind, t.full_text, t.is_exported ? 1 : 0, t.start_line, t.end_line);
  return Number(result.lastInsertRowid);
}

export function getTypeByName(db: Database.Database, name: string): TypeRow | undefined {
  return db.prepare('SELECT * FROM types WHERE name = ?').get(name) as TypeRow | undefined;
}

export function getTypesByFileId(db: Database.Database, fileId: number): TypeRow[] {
  return db.prepare('SELECT * FROM types WHERE file_id = ?').all(fileId) as TypeRow[];
}

export function deleteTypesByFileId(db: Database.Database, fileId: number): void {
  db.prepare('DELETE FROM types WHERE file_id = ?').run(fileId);
}

export function searchTypes(db: Database.Database, query: string, limit: number = 10): TypeRow[] {
  if (!query.trim()) return [];
  return db.prepare(`
    SELECT t.* FROM types t
    JOIN types_fts fts ON t.id = fts.rowid
    WHERE types_fts MATCH ?
    LIMIT ?
  `).all(query, limit) as TypeRow[];
}

export function getAllTypes(db: Database.Database): TypeRow[] {
  return db.prepare('SELECT * FROM types').all() as TypeRow[];
}

export function updateTypePurpose(db: Database.Database, typeId: number, purpose: string): void {
  db.prepare(`
    UPDATE types SET purpose = ?, semantic_analyzed_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(purpose, typeId);
}

// ── Route queries ──

export interface RouteRow {
  id: number;
  file_id: number;
  method: string;
  path: string;
  handler_name: string | null;
  handler_body: string;
  middleware: string | null;
  start_line: number;
  end_line: number;
  purpose: string | null;
  semantic_analyzed_at: string | null;
}

export interface InsertRoute {
  file_id: number;
  method: string;
  path: string;
  handler_name: string | null;
  handler_body: string;
  middleware: string | null;
  start_line: number;
  end_line: number;
}

export function insertRoute(db: Database.Database, r: InsertRoute): number {
  const result = db.prepare(`
    INSERT INTO routes (file_id, method, path, handler_name, handler_body, middleware, start_line, end_line)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(r.file_id, r.method, r.path, r.handler_name, r.handler_body, r.middleware, r.start_line, r.end_line);
  return Number(result.lastInsertRowid);
}

export function getRoutesByFileId(db: Database.Database, fileId: number): RouteRow[] {
  return db.prepare('SELECT * FROM routes WHERE file_id = ?').all(fileId) as RouteRow[];
}

export function getAllRoutes(db: Database.Database): RouteRow[] {
  return db.prepare('SELECT * FROM routes').all() as RouteRow[];
}

export function deleteRoutesByFileId(db: Database.Database, fileId: number): void {
  db.prepare('DELETE FROM routes WHERE file_id = ?').run(fileId);
}

export function searchRoutes(db: Database.Database, query: string, limit: number = 10): RouteRow[] {
  if (!query.trim()) return [];
  return db.prepare(`
    SELECT r.* FROM routes r
    JOIN routes_fts fts ON r.id = fts.rowid
    WHERE routes_fts MATCH ?
    LIMIT ?
  `).all(query, limit) as RouteRow[];
}

export function updateRoutePurpose(db: Database.Database, routeId: number, purpose: string): void {
  db.prepare(`
    UPDATE routes SET purpose = ?, semantic_analyzed_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(purpose, routeId);
}

// ── Constant queries ──

export interface ConstantRow {
  id: number;
  file_id: number;
  name: string;
  value_text: string | null;
  type_annotation: string | null;
  is_exported: number;
  start_line: number;
  end_line: number;
}

export interface InsertConstant {
  file_id: number;
  name: string;
  value_text: string | null;
  type_annotation: string | null;
  is_exported: boolean;
  start_line: number;
  end_line: number;
}

export function insertConstant(db: Database.Database, c: InsertConstant): number {
  const result = db.prepare(`
    INSERT INTO constants (file_id, name, value_text, type_annotation, is_exported, start_line, end_line)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(c.file_id, c.name, c.value_text, c.type_annotation, c.is_exported ? 1 : 0, c.start_line, c.end_line);
  return Number(result.lastInsertRowid);
}

export function getConstantsByFileId(db: Database.Database, fileId: number): ConstantRow[] {
  return db.prepare('SELECT * FROM constants WHERE file_id = ?').all(fileId) as ConstantRow[];
}

export function deleteConstantsByFileId(db: Database.Database, fileId: number): void {
  db.prepare('DELETE FROM constants WHERE file_id = ?').run(fileId);
}

// ── File Summary queries ──

export interface FileSummaryRow {
  id: number;
  file_id: number;
  import_count: number;
  export_count: number;
  function_count: number;
  type_count: number;
  route_count: number;
  loc: number;
  imports_json: string | null;
  exports_json: string | null;
  purpose: string | null;
  semantic_analyzed_at: string | null;
}

export interface UpsertFileSummary {
  file_id: number;
  import_count: number;
  export_count: number;
  function_count: number;
  type_count: number;
  route_count: number;
  loc: number;
  imports_json: string | null;
  exports_json: string | null;
}

export function upsertFileSummary(db: Database.Database, s: UpsertFileSummary): number {
  const existing = db.prepare('SELECT id FROM file_summaries WHERE file_id = ?').get(s.file_id) as { id: number } | undefined;
  if (existing) {
    db.prepare(`
      UPDATE file_summaries SET import_count = ?, export_count = ?, function_count = ?,
        type_count = ?, route_count = ?, loc = ?, imports_json = ?, exports_json = ?
      WHERE id = ?
    `).run(s.import_count, s.export_count, s.function_count, s.type_count, s.route_count, s.loc, s.imports_json, s.exports_json, existing.id);
    return existing.id;
  }
  const result = db.prepare(`
    INSERT INTO file_summaries (file_id, import_count, export_count, function_count, type_count, route_count, loc, imports_json, exports_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(s.file_id, s.import_count, s.export_count, s.function_count, s.type_count, s.route_count, s.loc, s.imports_json, s.exports_json);
  return Number(result.lastInsertRowid);
}

export function getFileSummary(db: Database.Database, fileId: number): FileSummaryRow | undefined {
  return db.prepare('SELECT * FROM file_summaries WHERE file_id = ?').get(fileId) as FileSummaryRow | undefined;
}

export function getAllFileSummaries(db: Database.Database): FileSummaryRow[] {
  return db.prepare('SELECT * FROM file_summaries').all() as FileSummaryRow[];
}

export function updateFileSummaryPurpose(db: Database.Database, summaryId: number, purpose: string): void {
  db.prepare(`
    UPDATE file_summaries SET purpose = ?, semantic_analyzed_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(purpose, summaryId);
}

export function searchFiles(db: Database.Database, query: string, limit: number = 10): FileSummaryRow[] {
  if (!query.trim()) return [];
  return db.prepare(`
    SELECT fs.* FROM file_summaries fs
    JOIN files_fts fts ON fs.id = fts.rowid
    WHERE files_fts MATCH ?
    LIMIT ?
  `).all(query, limit) as FileSummaryRow[];
}

// ── Rebuild all FTS indexes ──

export function rebuildAllFtsIndexes(db: Database.Database): void {
  db.exec("INSERT INTO functions_fts(functions_fts) VALUES('rebuild')");
  try { db.exec("INSERT INTO types_fts(types_fts) VALUES('rebuild')"); } catch {}
  try { db.exec("INSERT INTO routes_fts(routes_fts) VALUES('rebuild')"); } catch {}
  try { db.exec("INSERT INTO files_fts(files_fts) VALUES('rebuild')"); } catch {}
}

// ── File overview ──

export interface FileOverview {
  file: FileRow;
  summary: FileSummaryRow | undefined;
  functions: FunctionRow[];
  types: TypeRow[];
  routes: RouteRow[];
  constants: ConstantRow[];
}

export interface FullOverview {
  stats: Stats;
  files: (FileRow & { summary?: FileSummaryRow })[];
  functions: (FunctionRow & { filePath: string })[];
  types: (TypeRow & { filePath: string })[];
  routes: (RouteRow & { filePath: string })[];
  constants: (ConstantRow & { filePath: string })[];
}

export function getFullOverview(db: Database.Database): FullOverview {
  const stats = getStats(db);
  const allFiles = getAllFiles(db);

  // Build file path lookup
  const filePathById = new Map<number, string>();
  for (const f of allFiles) filePathById.set(f.id, f.path);

  // Files with summaries
  const filesWithSummaries = allFiles.map(f => ({
    ...f,
    summary: getFileSummary(db, f.id),
  }));

  // All functions with file paths
  const allFns = getAllFunctions(db);
  const functionsWithPath = allFns.map(fn => ({
    ...fn,
    filePath: filePathById.get(fn.file_id) || 'unknown',
  }));

  // All types with file paths
  let allTypesArr: TypeRow[] = [];
  try { allTypesArr = getAllTypes(db); } catch {}
  const typesWithPath = allTypesArr.map(t => ({
    ...t,
    filePath: filePathById.get(t.file_id) || 'unknown',
  }));

  // All routes with file paths
  let allRoutesArr: RouteRow[] = [];
  try { allRoutesArr = getAllRoutes(db); } catch {}
  const routesWithPath = allRoutesArr.map(r => ({
    ...r,
    filePath: filePathById.get(r.file_id) || 'unknown',
  }));

  // All constants with file paths (limit to exported ones for overview)
  let allConstantsArr: ConstantRow[] = [];
  try {
    allConstantsArr = db.prepare('SELECT * FROM constants WHERE is_exported = 1').all() as ConstantRow[];
  } catch {}
  const constantsWithPath = allConstantsArr.map(c => ({
    ...c,
    filePath: filePathById.get(c.file_id) || 'unknown',
  }));

  return {
    stats,
    files: filesWithSummaries,
    functions: functionsWithPath,
    types: typesWithPath,
    routes: routesWithPath,
    constants: constantsWithPath,
  };
}

export function getFileOverview(db: Database.Database, fileId: number): FileOverview | null {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as FileRow | undefined;
  if (!file) return null;
  return {
    file,
    summary: getFileSummary(db, fileId),
    functions: getFunctionsByFileId(db, fileId),
    types: getTypesByFileId(db, fileId),
    routes: getRoutesByFileId(db, fileId),
    constants: getConstantsByFileId(db, fileId),
  };
}
