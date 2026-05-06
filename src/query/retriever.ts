import type Database from 'better-sqlite3';
import type { FunctionRow, TypeRow, RouteRow, ConstantRow, FileSummaryRow } from '../db/queries';
import {
  getFunctionByName, getFunctionsByName, getFunctionById, getCallees, getCallers, getCallersByName,
  searchFunctions, getTransitiveCallersRobust,
  getAllRoutes, searchRoutes, getRoutesByFileId,
  getTypesByName, searchTypes, getAllTypes,
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
  const fns = getFunctionsByName(db, name);
  if (fns.length === 0) {
    return emptyContext('direct');
  }
  const cache = buildEnrichCache(db, fns);
  return {
    ...emptyContext('direct'),
    functions: fns.map(fn => enrichFunction(db, fn, cache)),
  };
}

export function relationshipQuery(
  db: Database.Database,
  name: string,
  direction: 'callers' | 'callees'
): RetrievedContext {
  const matches = getFunctionsByName(db, name);
  if (matches.length === 0) {
    return emptyContext('relationship');
  }

  const collected: FunctionRow[] = [];
  const unresolved: RetrievedFunction[] = [];

  if (direction === 'callees') {
    const callees = matches.flatMap(fn => getCallees(db, fn.id));
    const calleeIds = [...new Set(callees.filter(r => r.callee_function_id).map(r => r.callee_function_id!))] as number[];
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
    const seenUnresolved = new Set<string>();
    for (const rel of callees) {
      if (!rel.callee_function_id) {
        if (seenUnresolved.has(rel.callee_name)) continue;
        seenUnresolved.add(rel.callee_name);
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
    const callers = matches.flatMap(fn => getCallers(db, fn.id));
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
  const matches = getFunctionsByName(db, name);
  if (matches.length === 0) {
    return emptyContext('impact');
  }

  // Direct callers
  const directCallers = matches.flatMap(fn => getCallers(db, fn.id));
  const directCallersByName = getCallersByName(db, name);
  const allDirectCallerIds = new Set([
    ...directCallers.map(r => r.caller_function_id),
    ...directCallersByName.map(r => r.caller_function_id),
  ]);

  // Transitive callers (using both ID and name for robustness)
  const transitiveCallers = matches.flatMap(fn => getTransitiveCallersRobust(db, fn.id, name));

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
  } else {
    routes = getAllRoutes(db);
  }

  if (method) {
    routes = routes.filter(r => r.method === method.toUpperCase());
  }

  const cache = buildEnrichCache(db, [], [], routes);
  return {
    ...emptyContext('route'),
    routes: routes.map(r => enrichRoute(db, r, cache)),
  };
}

export function typeQuery(db: Database.Database, typeName: string): RetrievedContext {
  const exactTypes = getTypesByName(db, typeName);
  if (exactTypes.length === 0) {
    // Try FTS search — sanitize so unusual characters in the type name don't crash MATCH.
    const query = sanitizeFtsQuery(typeName);
    const results = query ? searchTypes(db, query, 5) : [];
    const fallback = results.length > 0 ? results : fuzzyTypeSearch(db, typeName, 5);
    const cache = buildEnrichCache(db, [], fallback);
    return {
      ...emptyContext('type'),
      types: fallback.map(r => enrichType(db, r, cache)),
    };
  }
  const cache = buildEnrichCache(db, [], exactTypes);
  return {
    ...emptyContext('type'),
    types: exactTypes.map(t => enrichType(db, t, cache)),
  };
}

function fuzzyTypeSearch(db: Database.Database, query: string, limit: number): TypeRow[] {
  const terms = expandSearchTerms(query);
  if (terms.length === 0) return [];

  const scored = getAllTypes(db)
    .map(type => {
      const haystack = [
        type.name,
        splitIdentifier(type.name).join(' '),
        type.kind,
        type.full_text,
        type.purpose ?? '',
      ].join(' ').toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { type, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.type.name.localeCompare(b.type.name));

  return scored.slice(0, limit).map(item => item.type);
}

function expandSearchTerms(query: string): string[] {
  const synonyms: Record<string, string[]> = {
    parameter: ['option', 'options', 'config', 'configuration'],
    parameters: ['option', 'options', 'config', 'configuration'],
    option: ['parameter', 'parameters', 'config', 'configuration'],
    options: ['parameter', 'parameters', 'config', 'configuration'],
  };
  const terms = new Set<string>();
  for (const raw of query.split(/\s+/)) {
    const term = raw.replace(/[^A-Za-z0-9_$]/g, '').toLowerCase();
    if (term.length < 2) continue;
    terms.add(term);
    for (const synonym of synonyms[term] ?? []) terms.add(synonym);
  }
  return [...terms];
}

function splitIdentifier(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_$-]+/g, ' ')
    .split(/\s+/)
    .map(part => part.toLowerCase())
    .filter(Boolean);
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

export function listQuery(db: Database.Database, entity: string | null, maxRows: number = 50): RetrievedContext {
  const ctx = emptyContext('list');

  switch (entity) {
    case 'routes': {
      const routes = getAllRoutes(db).slice(0, maxRows);
      const cache = buildEnrichCache(db, [], [], routes);
      ctx.routes = routes.map(r => enrichRoute(db, r, cache));
      break;
    }
    case 'types': {
      const types = getAllTypes(db).slice(0, maxRows);
      const cache = buildEnrichCache(db, [], types);
      ctx.types = types.map(t => enrichType(db, t, cache));
      break;
    }
    case 'files': {
      const summaries = getAllFileSummaries(db).slice(0, maxRows);
      const fileRows = getAllFiles(db);
      const fileMap = new Map(fileRows.map(f => [f.id, f.path]));
      ctx.files = summaries.map(s => enrichFileSummary(fileMap.get(s.file_id) || 'unknown', s));
      break;
    }
    case 'functions': {
      const fns = getAllFunctions(db).slice(0, maxRows);
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
      const limitedConsts = allConsts.slice(0, maxRows);
      const cache = buildEnrichCache(db, [], [], [], limitedConsts);
      ctx.constants = limitedConsts.map(c => enrichConstant(db, c, cache));
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
  const fileSummaries = mergeFileSummaryResults(
    searchFiles(db, query, 5),
    searchFileSummariesByPath(db, keywords, 10),
    10,
  );

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

function searchFileSummariesByPath(
  db: Database.Database,
  keywords: string[],
  limit: number,
): FileSummaryRow[] {
  const terms = keywords
    .flatMap(k => String(k).split(/\s+/))
    .map(k => k.replace(/["*:()\-^]/g, '').trim().toLowerCase())
    .filter(k => k.length > 1 && k !== 'and' && k !== 'or' && k !== 'not' && k !== 'near');
  if (terms.length === 0) return [];

  const files = getAllFiles(db);
  const matches = files
    .filter(f => terms.some(term => f.path.toLowerCase().includes(term)))
    .slice(0, limit);

  const summaries: FileSummaryRow[] = [];
  for (const file of matches) {
    const summary = getFileSummary(db, file.id);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

function mergeFileSummaryResults(
  primary: FileSummaryRow[],
  fallback: FileSummaryRow[],
  limit: number,
): FileSummaryRow[] {
  const seen = new Set<number>();
  const merged: FileSummaryRow[] = [];
  for (const row of [...primary, ...fallback]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
    if (merged.length >= limit) break;
  }
  return merged;
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
