import type Database from 'better-sqlite3';
import type { FunctionRow, TypeRow, RouteRow, ConstantRow, FileSummaryRow } from '../db/queries';
import {
  getFunctionByName, getFunctionById, getCallees, getCallers, getCallersByName,
  searchFunctions, getTransitiveCallersRobust,
  getAllRoutes, searchRoutes, getRoutesByFileId,
  getTypeByName, searchTypes, getAllTypes,
  getAllFunctions, getAllFiles, getAllFileSummaries,
  getConstantsByFileId, getFileOverview,
  searchFiles, getFileSummary, getFileByPath,
} from '../db/queries';
import { sanitizeFtsTerms, sanitizeFtsQuery } from '../utils/fts';

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

  const results: RetrievedFunction[] = [];

  if (direction === 'callees') {
    const callees = getCallees(db, fn.id);
    for (const rel of callees) {
      if (rel.callee_function_id) {
        const calleeFn = getFunctionById(db, rel.callee_function_id);
        if (calleeFn) results.push(enrichFunction(db, calleeFn));
      } else {
        results.push({
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

    for (const rel of [...callers, ...callersByName]) {
      if (seenIds.has(rel.caller_function_id)) continue;
      seenIds.add(rel.caller_function_id);
      const callerFn = getFunctionById(db, rel.caller_function_id);
      if (callerFn) results.push(enrichFunction(db, callerFn));
    }
  }

  return { ...emptyContext('relationship'), functions: results };
}

export function semanticSearch(db: Database.Database, keywords: string[]): RetrievedContext {
  const query = sanitizeFtsTerms(keywords);
  if (!query) return emptyContext('semantic');
  const functions = searchFunctions(db, query, 10);
  const types = searchTypes(db, query, 5);
  const routes = searchRoutes(db, query, 5);
  return {
    ...emptyContext('semantic'),
    functions: functions.map(fn => enrichFunction(db, fn)),
    types: types.map(t => enrichType(db, t)),
    routes: routes.map(r => enrichRoute(db, r)),
  };
}

export function domainQuery(db: Database.Database, domain: string): RetrievedContext {
  const results = db.prepare(
    'SELECT * FROM functions WHERE domain = ?'
  ).all(domain) as FunctionRow[];

  return {
    ...emptyContext('domain'),
    functions: results.map(fn => enrichFunction(db, fn)),
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

  const results: RetrievedFunction[] = [];
  const seenIds = new Set<number>();

  // Add direct callers first (marked)
  for (const callerId of allDirectCallerIds) {
    if (seenIds.has(callerId)) continue;
    seenIds.add(callerId);
    const callerFn = getFunctionById(db, callerId);
    if (callerFn) results.push(enrichFunction(db, callerFn));
  }

  // Add transitive callers
  for (const callerFn of transitiveCallers) {
    if (seenIds.has(callerFn.id)) continue;
    seenIds.add(callerFn.id);
    results.push(enrichFunction(db, callerFn));
  }

  return { ...emptyContext('impact'), functions: results };
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

  return {
    ...emptyContext('route'),
    routes: routes.map(r => enrichRoute(db, r)),
  };
}

export function typeQuery(db: Database.Database, typeName: string): RetrievedContext {
  const t = getTypeByName(db, typeName);
  if (!t) {
    // Try FTS search — sanitize so unusual characters in the type name don't crash MATCH.
    const query = sanitizeFtsQuery(typeName);
    if (!query) return emptyContext('type');
    const results = searchTypes(db, query, 5);
    return {
      ...emptyContext('type'),
      types: results.map(r => enrichType(db, r)),
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

    return {
      ...emptyContext('file'),
      functions: overview.functions.map(fn => enrichFunction(db, fn)),
      types: overview.types.map(t => enrichType(db, t)),
      routes: overview.routes.map(r => enrichRoute(db, r)),
      constants: overview.constants.map(c => enrichConstant(db, c)),
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
    case 'routes':
      ctx.routes = getAllRoutes(db).map(r => enrichRoute(db, r));
      break;
    case 'types':
      ctx.types = getAllTypes(db).map(t => enrichType(db, t));
      break;
    case 'files': {
      const summaries = getAllFileSummaries(db);
      const fileRows = getAllFiles(db);
      const fileMap = new Map(fileRows.map(f => [f.id, f.path]));
      ctx.files = summaries.map(s => enrichFileSummary(fileMap.get(s.file_id) || 'unknown', s));
      break;
    }
    case 'functions':
      ctx.functions = getAllFunctions(db).slice(0, 50).map(fn => enrichFunction(db, fn));
      break;
    case 'constants': {
      const allFileRows = getAllFiles(db);
      for (const file of allFileRows) {
        const consts = getConstantsByFileId(db, file.id);
        ctx.constants.push(...consts.map(c => enrichConstant(db, c)));
      }
      break;
    }
    default:
      // Return a mix of everything
      ctx.functions = getAllFunctions(db).slice(0, 20).map(fn => enrichFunction(db, fn));
      ctx.routes = getAllRoutes(db).map(r => enrichRoute(db, r));
      ctx.types = getAllTypes(db).slice(0, 20).map(t => enrichType(db, t));
      break;
  }

  return ctx;
}

export function patternQuery(db: Database.Database, keywords: string[]): RetrievedContext {
  const query = sanitizeFtsTerms(keywords);
  if (!query) return emptyContext('pattern');
  const functions = searchFunctions(db, query, 15);
  const types = searchTypes(db, query, 10);
  const routes = searchRoutes(db, query, 10);
  const fileSummaries = searchFiles(db, query, 5);

  const allFileRows = getAllFiles(db);
  const fileMap = new Map(allFileRows.map(f => [f.id, f.path]));

  return {
    ...emptyContext('pattern'),
    functions: functions.map(fn => enrichFunction(db, fn)),
    types: types.map(t => enrichType(db, t)),
    routes: routes.map(r => enrichRoute(db, r)),
    files: fileSummaries.map(s => enrichFileSummary(fileMap.get(s.file_id) || 'unknown', s)),
  };
}

function enrichFunction(db: Database.Database, fn: FunctionRow): RetrievedFunction {
  const file = db.prepare('SELECT path FROM files WHERE id = ?').get(fn.file_id) as any;
  const location = file ? `${file.path}:${fn.start_line}` : `unknown:${fn.start_line}`;

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
    calledBy: allCallers.map(c => {
      const callerFn = getFunctionById(db, c.caller_function_id);
      return callerFn?.name || 'unknown';
    }),
  };
}

function enrichType(db: Database.Database, t: TypeRow): RetrievedType {
  const file = db.prepare('SELECT path FROM files WHERE id = ?').get(t.file_id) as any;
  const location = file ? `${file.path}:${t.start_line}` : `unknown:${t.start_line}`;
  return {
    name: t.name,
    kind: t.kind,
    location,
    fullText: t.full_text,
    isExported: !!t.is_exported,
    purpose: t.purpose,
  };
}

function enrichRoute(db: Database.Database, r: RouteRow): RetrievedRoute {
  const file = db.prepare('SELECT path FROM files WHERE id = ?').get(r.file_id) as any;
  const location = file ? `${file.path}:${r.start_line}` : `unknown:${r.start_line}`;
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

function enrichConstant(db: Database.Database, c: ConstantRow): RetrievedConstant {
  const file = db.prepare('SELECT path FROM files WHERE id = ?').get(c.file_id) as any;
  const location = file ? `${file.path}:${c.start_line}` : `unknown:${c.start_line}`;
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
