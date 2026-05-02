import type Database from 'better-sqlite3';
import type { FunctionRow, TypeRow, RouteRow, ConstantRow, FileSummaryRow } from '../db/queries';
import {
  getFunctionByName, getFunctionById, getCallees, getCallers, getCallersByName,
  searchFunctions, getTransitiveCallersRobust,
  getAllRoutes, searchRoutes, getRoutesByFileId,
  getTypeByName, searchTypes, getAllTypes,
  getAllFunctions, getAllFiles, getAllFileSummaries,
  getConstantsByFileId, getFileOverview,
  searchFiles, searchConstants, getFileSummary, getFileByPath,
  getFunctionNamesByIds, getFilePathsByIds,
} from '../db/queries';
import { sanitizeFtsTerms, sanitizeFtsQuery } from '../utils/fts';

// Batch lookup cache — built once per retriever call and threaded through the enrich
// helpers so they don't issue N+1 queries for file paths and caller names.
interface EnrichCache {
  filePaths: Map<number, string>;
  functionNames: Map<number, string>;
}

function buildEnrichCache(
  db: Database.Database,
  fns: FunctionRow[],
  types: TypeRow[] = [],
  routes: RouteRow[] = [],
  constants: ConstantRow[] = [],
): EnrichCache {
  const fileIds = new Set<number>();
  for (const fn of fns) fileIds.add(fn.file_id);
  for (const t of types) fileIds.add(t.file_id);
  for (const r of routes) fileIds.add(r.file_id);
  for (const c of constants) fileIds.add(c.file_id);

  // Collect all caller function ids referenced by these functions so a single
  // IN(...) query resolves every caller name we'll need.
  const callerIds = new Set<number>();
  for (const fn of fns) {
    for (const rel of getCallers(db, fn.id)) callerIds.add(rel.caller_function_id);
    for (const rel of getCallersByName(db, fn.name)) callerIds.add(rel.caller_function_id);
  }

  return {
    filePaths: getFilePathsByIds(db, [...fileIds]),
    functionNames: getFunctionNamesByIds(db, [...callerIds]),
  };
}

export interface RetrievedContext {
  functions: RetrievedFunction[];
  types: RetrievedType[];
  routes: RetrievedRoute[];
  files: RetrievedFile[];
  constants: RetrievedConstant[];
  strategy: string;
}

export interface RetrievedFunction {
  name: string;
  location: string;
  signature: string;
  purpose: string | null;
  behavior: string | null;
  sideEffects: string[];
  domain: string | null;
  complexity: string | null;
  calls: string[];
  calledBy: string[];
}

export interface RetrievedType {
  name: string;
  kind: string;
  location: string;
  fullText: string;
  isExported: boolean;
  purpose: string | null;
}

export interface RetrievedRoute {
  method: string;
  path: string;
  location: string;
  handlerName: string | null;
  handlerBody: string;
  middleware: string[];
  purpose: string | null;
}

export interface RetrievedFile {
  path: string;
  importCount: number;
  exportCount: number;
  functionCount: number;
  typeCount: number;
  routeCount: number;
  loc: number;
  purpose: string | null;
  exports: string[];
}

export interface RetrievedConstant {
  name: string;
  location: string;
  valueText: string | null;
  typeAnnotation: string | null;
  isExported: boolean;
}

function emptyContext(strategy: string): RetrievedContext {
  return { functions: [], types: [], routes: [], files: [], constants: [], strategy };
}

export function directLookup(db: Database.Database, name: string): RetrievedContext {
  const fn = getFunctionByName(db, name);
  if (!fn) {
    return emptyContext('direct');
  }
  return {
    ...emptyContext('direct'),
    functions: [enrichFunction(db, fn)],
  };
}

export function relationshipQuery(
  db: Database.Database,
  name: string,
  direction: 'callers' | 'callees'
): RetrievedContext {
  const fn = getFunctionByName(db, name);
  if (!fn) {
    return emptyContext('relationship');
  }

  const collected: FunctionRow[] = [];
  const unresolved: RetrievedFunction[] = [];

  if (direction === 'callees') {
    const callees = getCallees(db, fn.id);
    const calleeIds = callees.filter(r => r.callee_function_id).map(r => r.callee_function_id!) as number[];
    const calleeNames = getFunctionNamesByIds(db, calleeIds);
    // Fetch full rows in one go for ids we can resolve
    if (calleeIds.length > 0) {
      const placeholders = calleeIds.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT * FROM functions WHERE id IN (${placeholders})`
      ).all(...calleeIds) as FunctionRow[];
      collected.push(...rows);
    }
    void calleeNames;
    for (const rel of callees) {
      if (!rel.callee_function_id) {
        unresolved.push({
          name: rel.callee_name,
          location: 'unresolved',
          signature: rel.callee_name,
          purpose: null,
          behavior: null,
          sideEffects: [],
          domain: null,
          complexity: null,
          calls: [],
          calledBy: [],
        });
      }
    }
  } else {
    const callers = getCallers(db, fn.id);
    const callersByName = getCallersByName(db, name);
    const seenIds = new Set<number>();
    const callerIds: number[] = [];
    for (const rel of [...callers, ...callersByName]) {
      if (seenIds.has(rel.caller_function_id)) continue;
      seenIds.add(rel.caller_function_id);
      callerIds.push(rel.caller_function_id);
    }
    if (callerIds.length > 0) {
      const placeholders = callerIds.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT * FROM functions WHERE id IN (${placeholders})`
      ).all(...callerIds) as FunctionRow[];
      collected.push(...rows);
    }
  }

  const cache = buildEnrichCache(db, collected);
  const results = collected.map(f => enrichFunction(db, f, cache));
  return { ...emptyContext('relationship'), functions: [...results, ...unresolved] };
}

export function semanticSearch(db: Database.Database, keywords: string[]): RetrievedContext {
  const query = sanitizeFtsTerms(keywords);
  if (!query) return emptyContext('semantic');
  const functions = searchFunctions(db, query, 10);
  const types = searchTypes(db, query, 5);
  const routes = searchRoutes(db, query, 5);
  const constants = searchConstants(db, keywords, 5);
  const cache = buildEnrichCache(db, functions, types, routes, constants);
  return {
    ...emptyContext('semantic'),
    functions: functions.map(fn => enrichFunction(db, fn, cache)),
    types: types.map(t => enrichType(db, t, cache)),
    routes: routes.map(r => enrichRoute(db, r, cache)),
    constants: constants.map(c => enrichConstant(db, c, cache)),
  };
}

export function domainQuery(db: Database.Database, domain: string): RetrievedContext {
  const results = db.prepare(
    'SELECT * FROM functions WHERE domain = ?'
  ).all(domain) as FunctionRow[];

  const cache = buildEnrichCache(db, results);
  return {
    ...emptyContext('domain'),
    functions: results.map(fn => enrichFunction(db, fn, cache)),
  };
}

export function impactAnalysis(db: Database.Database, name: string): RetrievedContext {
  const fn = getFunctionByName(db, name);
  if (!fn) {
    return emptyContext('impact');
  }

  // Direct callers
  const directCallers = getCallers(db, fn.id);
  const directCallersByName = getCallersByName(db, name);
  const allDirectCallerIds = new Set([
    ...directCallers.map(r => r.caller_function_id),
    ...directCallersByName.map(r => r.caller_function_id),
  ]);

  // Transitive callers (using both ID and name for robustness)
  const transitiveCallers = getTransitiveCallersRobust(db, fn.id, name);

  const seenIds = new Set<number>();
  const ordered: FunctionRow[] = [];

  // Direct callers — fetch the rows we need in one IN(...) query.
  const directIdList = [...allDirectCallerIds].filter(id => {
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
  if (directIdList.length > 0) {
    const placeholders = directIdList.map(() => '?').join(',');
    const directRows = db.prepare(
      `SELECT * FROM functions WHERE id IN (${placeholders})`
    ).all(...directIdList) as FunctionRow[];
    // Preserve the input order so direct callers appear first.
    const byId = new Map(directRows.map(r => [r.id, r]));
    for (const id of directIdList) {
      const row = byId.get(id);
      if (row) ordered.push(row);
    }
  }

  for (const callerFn of transitiveCallers) {
    if (seenIds.has(callerFn.id)) continue;
    seenIds.add(callerFn.id);
    ordered.push(callerFn);
  }

  const cache = buildEnrichCache(db, ordered);
  return { ...emptyContext('impact'), functions: ordered.map(f => enrichFunction(db, f, cache)) };
}

// ── New retriever strategies ──

export function routeQuery(db: Database.Database, routePath?: string | null, method?: string | null): RetrievedContext {
  let routes: RouteRow[];
  if (routePath) {
    routes = db.prepare(
      'SELECT * FROM routes WHERE path LIKE ?'
    ).all(`%${routePath}%`) as RouteRow[];
    if (method) {
      routes = routes.filter(r => r.method === method.toUpperCase());
    }
  } else {
    routes = getAllRoutes(db);
  }

  const cache = buildEnrichCache(db, [], [], routes);
  return {
    ...emptyContext('route'),
    routes: routes.map(r => enrichRoute(db, r, cache)),
  };
}

export function typeQuery(db: Database.Database, typeName: string): RetrievedContext {
  const t = getTypeByName(db, typeName);
  if (!t) {
    // Try FTS search — sanitize so unusual characters in the type name don't crash MATCH.
    const query = sanitizeFtsQuery(typeName);
    if (!query) return emptyContext('type');
    const results = searchTypes(db, query, 5);
    const cache = buildEnrichCache(db, [], results);
    return {
      ...emptyContext('type'),
      types: results.map(r => enrichType(db, r, cache)),
    };
  }
  return {
    ...emptyContext('type'),
    types: [enrichType(db, t)],
  };
}

export function fileQuery(db: Database.Database, filePath?: string | null): RetrievedContext {
  if (filePath) {
    // Try exact match first, then partial
    let fileRow = getFileByPath(db, filePath);
    if (!fileRow) {
      const allFiles = getAllFiles(db);
      fileRow = allFiles.find(f => f.path.includes(filePath)) || undefined;
    }
    if (!fileRow) {
      return emptyContext('file');
    }
    const overview = getFileOverview(db, fileRow.id);
    if (!overview) return emptyContext('file');

    const cache = buildEnrichCache(db, overview.functions, overview.types, overview.routes, overview.constants);
    return {
      ...emptyContext('file'),
      functions: overview.functions.map(fn => enrichFunction(db, fn, cache)),
      types: overview.types.map(t => enrichType(db, t, cache)),
      routes: overview.routes.map(r => enrichRoute(db, r, cache)),
      constants: overview.constants.map(c => enrichConstant(db, c, cache)),
      files: overview.summary ? [enrichFileSummary(overview.file.path, overview.summary)] : [],
    };
  }

  // Return all file summaries
  const allSummaries = getAllFileSummaries(db);
  const allFileRows = getAllFiles(db);
  const fileMap = new Map(allFileRows.map(f => [f.id, f.path]));

  return {
    ...emptyContext('file'),
    files: allSummaries.map(s => enrichFileSummary(fileMap.get(s.file_id) || 'unknown', s)),
  };
}

export function listQuery(db: Database.Database, entity: string | null): RetrievedContext {
  const ctx = emptyContext('list');

  switch (entity) {
    case 'routes': {
      const routes = getAllRoutes(db);
      const cache = buildEnrichCache(db, [], [], routes);
      ctx.routes = routes.map(r => enrichRoute(db, r, cache));
      break;
    }
    case 'types': {
      const types = getAllTypes(db);
      const cache = buildEnrichCache(db, [], types);
      ctx.types = types.map(t => enrichType(db, t, cache));
      break;
    }
    case 'files': {
      const summaries = getAllFileSummaries(db);
      const fileRows = getAllFiles(db);
      const fileMap = new Map(fileRows.map(f => [f.id, f.path]));
      ctx.files = summaries.map(s => enrichFileSummary(fileMap.get(s.file_id) || 'unknown', s));
      break;
    }
    case 'functions': {
      const fns = getAllFunctions(db).slice(0, 50);
      const cache = buildEnrichCache(db, fns);
      ctx.functions = fns.map(fn => enrichFunction(db, fn, cache));
      break;
    }
    case 'constants': {
      const allFileRows = getAllFiles(db);
      const allConsts: ConstantRow[] = [];
      for (const file of allFileRows) {
        allConsts.push(...getConstantsByFileId(db, file.id));
      }
      const cache = buildEnrichCache(db, [], [], [], allConsts);
      ctx.constants = allConsts.map(c => enrichConstant(db, c, cache));
      break;
    }
    default: {
      // Unknown entity: return a compact cross-section so the LLM doesn't
      // have to scan a bloated context. 10 fns + all routes + 10 types is
      // enough for "what exists" questions without hitting the token budget.
      const fns = getAllFunctions(db).slice(0, 10);
      const routes = getAllRoutes(db);
      const types = getAllTypes(db).slice(0, 10);
      const cache = buildEnrichCache(db, fns, types, routes);
      ctx.functions = fns.map(fn => enrichFunction(db, fn, cache));
      ctx.routes = routes.map(r => enrichRoute(db, r, cache));
      ctx.types = types.map(t => enrichType(db, t, cache));
      break;
    }
  }

  return ctx;
}

export function patternQuery(db: Database.Database, keywords: string[]): RetrievedContext {
  const query = sanitizeFtsTerms(keywords);
  if (!query) return emptyContext('pattern');
  const functions = searchFunctions(db, query, 15);
  const types = searchTypes(db, query, 10);
  const routes = searchRoutes(db, query, 10);
  const constants = searchConstants(db, keywords, 5);
  const fileSummaries = searchFiles(db, query, 5);

  const allFileRows = getAllFiles(db);
  const fileMap = new Map(allFileRows.map(f => [f.id, f.path]));
  const cache = buildEnrichCache(db, functions, types, routes, constants);

  return {
    ...emptyContext('pattern'),
    functions: functions.map(fn => enrichFunction(db, fn, cache)),
    types: types.map(t => enrichType(db, t, cache)),
    routes: routes.map(r => enrichRoute(db, r, cache)),
    constants: constants.map(c => enrichConstant(db, c, cache)),
    files: fileSummaries.map(s => enrichFileSummary(fileMap.get(s.file_id) || 'unknown', s)),
  };
}

function resolveFilePath(db: Database.Database, fileId: number, cache?: EnrichCache): string | null {
  if (cache) return cache.filePaths.get(fileId) ?? null;
  const row = db.prepare('SELECT path FROM files WHERE id = ?').get(fileId) as { path?: string } | undefined;
  return row?.path ?? null;
}

function enrichFunction(db: Database.Database, fn: FunctionRow, cache?: EnrichCache): RetrievedFunction {
  const path = resolveFilePath(db, fn.file_id, cache);
  const location = path ? `${path}:${fn.start_line}` : `unknown:${fn.start_line}`;

  const callees = getCallees(db, fn.id);
  const callers = getCallers(db, fn.id);
  const callersByName = getCallersByName(db, fn.name);

  // Deduplicate callers by caller_function_id
  const seenCallerIds = new Set<number>();
  const allCallers = [...callers, ...callersByName].filter(rel => {
    if (seenCallerIds.has(rel.caller_function_id)) return false;
    seenCallerIds.add(rel.caller_function_id);
    return true;
  });

  let sideEffects: string[] = [];
  try {
    if (fn.side_effects_json) {
      sideEffects = JSON.parse(fn.side_effects_json);
    }
  } catch {}

  // Resolve caller names from the batch cache when available; fall back to a per-row
  // lookup only when no cache was prebuilt (single-function paths like directLookup).
  const calledBy = allCallers.map(c => {
    if (cache) return cache.functionNames.get(c.caller_function_id) ?? 'unknown';
    const callerFn = getFunctionById(db, c.caller_function_id);
    return callerFn?.name || 'unknown';
  });

  return {
    name: fn.name,
    location,
    signature: fn.signature,
    purpose: fn.purpose,
    behavior: fn.behavior_summary,
    sideEffects,
    domain: fn.domain,
    complexity: fn.complexity,
    calls: callees.map(c => c.callee_name),
    calledBy,
  };
}

function enrichType(db: Database.Database, t: TypeRow, cache?: EnrichCache): RetrievedType {
  const path = resolveFilePath(db, t.file_id, cache);
  const location = path ? `${path}:${t.start_line}` : `unknown:${t.start_line}`;
  return {
    name: t.name,
    kind: t.kind,
    location,
    fullText: t.full_text,
    isExported: !!t.is_exported,
    purpose: t.purpose,
  };
}

function enrichRoute(db: Database.Database, r: RouteRow, cache?: EnrichCache): RetrievedRoute {
  const path = resolveFilePath(db, r.file_id, cache);
  const location = path ? `${path}:${r.start_line}` : `unknown:${r.start_line}`;
  let middleware: string[] = [];
  try {
    if (r.middleware) middleware = JSON.parse(r.middleware);
  } catch {}
  return {
    method: r.method,
    path: r.path,
    location,
    handlerName: r.handler_name,
    handlerBody: r.handler_body,
    middleware,
    purpose: r.purpose,
  };
}

function enrichConstant(db: Database.Database, c: ConstantRow, cache?: EnrichCache): RetrievedConstant {
  const path = resolveFilePath(db, c.file_id, cache);
  const location = path ? `${path}:${c.start_line}` : `unknown:${c.start_line}`;
  return {
    name: c.name,
    location,
    valueText: c.value_text,
    typeAnnotation: c.type_annotation,
    isExported: !!c.is_exported,
  };
}

function enrichFileSummary(filePath: string, s: FileSummaryRow): RetrievedFile {
  let exports: string[] = [];
  try {
    if (s.exports_json) exports = JSON.parse(s.exports_json);
  } catch {}
  return {
    path: filePath,
    importCount: s.import_count,
    exportCount: s.export_count,
    functionCount: s.function_count,
    typeCount: s.type_count,
    routeCount: s.route_count,
    loc: s.loc,
    purpose: s.purpose,
    exports,
  };
}
