import * as path from 'path';
import * as fs from 'fs';
import * as v8 from 'v8';
import type Database from 'better-sqlite3';
import type { Project } from 'ts-morph';
import {
  upsertFile, getFileByPath, insertFunction, getFunctionsByFileId,
  deleteFunctionsByFileId, deleteRelationshipsByCallerFunctionId,
  insertRelationship, resolveUniqueCalleeFunctionId, enqueueForAnalysis,
  resolveNullCallees, resolveTypeRelationships, resolveRouteHandlers, rebuildAllFtsIndexes,
  type CalleeDeclaration,
  copySemanticFields,
  insertType, deleteTypesByFileId,
  insertRoute, deleteRoutesByFileId,
  insertConstant, deleteConstantsByFileId,
  upsertFileSummary, deleteFile,
} from '../db/queries';
import { createProject, parseFileComplete, hashFileContent } from './parser';
import { extractCallsFromFile } from './relationships';
import { shouldReanalyze, getPriority } from './differ';
import { scanDirectory } from './scanner';
import { logger } from '../utils/logger';

export interface SingleFileIngestResult {
  status: 'new' | 'changed' | 'unchanged' | 'parse-failed';
  functions: number;
  types: number;
  routes: number;
  constants: number;
  relationships: number;
  queued: number;
}

export interface IngestOptions {
  // Resolve call targets through the TypeScript type checker instead of by
  // name alone. On by default — it is the difference between an exact call
  // graph and a heuristic one. Disable for very large repos where the
  // checker's cost outweighs the precision gain.
  typeResolution?: boolean;
}

// Convert a checker-resolved declaration site into the repo-relative form the
// database stores. Returns null for declarations outside the repo (a linked
// package, a monorepo sibling that isn't indexed) — those have no functions
// row to bind to.
function toRepoRelativeDeclaration(
  repoPath: string,
  resolved: { filePath: string; name: string } | undefined,
): CalleeDeclaration | null {
  if (!resolved) return null;
  const rel = path.relative(repoPath, resolved.filePath).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) return null;
  return { file: rel, name: resolved.name };
}

// Ingest one file. Caller is responsible for running resolveNullCallees,
// resolveRouteHandlers and rebuildAllFtsIndexes after a batch of changes
// (debounced in watch mode).
export function ingestSingleFile(
  db: Database.Database,
  project: Project,
  repoPath: string,
  filePath: string,
  diffThreshold: number,
  opts: IngestOptions = {},
): SingleFileIngestResult {
  const relativePath = path.relative(repoPath, filePath).split(path.sep).join('/');
  const content = fs.readFileSync(filePath, 'utf-8');
  const contentHash = hashFileContent(content);

  const existingFile = getFileByPath(db, relativePath);
  if (existingFile && existingFile.content_hash === contentHash) {
    return { status: 'unchanged', functions: 0, types: 0, routes: 0, constants: 0, relationships: 0, queued: 0 };
  }

  const isNew = !existingFile;
  const counts = { functions: 0, types: 0, routes: 0, constants: 0, relationships: 0, queued: 0 };
  let parseFailed = false;

  db.transaction(() => {
    const fileId = upsertFile(db, relativePath, contentHash);
    const oldFunctions = isNew ? [] : getFunctionsByFileId(db, fileId);
    const oldFunctionMap = new Map(oldFunctions.map(f => [f.name, f]));

    if (!isNew) {
      for (const oldFn of oldFunctions) {
        deleteRelationshipsByCallerFunctionId(db, oldFn.id);
      }
      deleteFunctionsByFileId(db, fileId);
      deleteTypesByFileId(db, fileId);
      deleteRoutesByFileId(db, fileId);
      deleteConstantsByFileId(db, fileId);
    }

    // Each extractor loads the file independently and drops it again. That
    // looks like wasted work — the file is parsed twice — but measurement says
    // otherwise: sharing one AST across both extractors made nest 23% slower
    // (205s -> 253s) and doubled peak heap (410MB -> 819MB). Each
    // `removeSourceFile` invalidates ts-morph's Program, which evicts the
    // transitive dependency graph the type checker pulls in; without that
    // eviction the Program grows for the whole run and every subsequent
    // checker query pays for it. The redundant parse is cheaper than the
    // memory it reclaims. `parseSourceFile` / `extractCallsFromSourceFile`
    // remain exported for callers that already hold a SourceFile.
    let parsed;
    try {
      // Refresh ts-morph's view of the file before re-parsing — otherwise watch
      // mode keeps serving stale ASTs from the project's source-file cache.
      const sf = project.getSourceFile(filePath);
      if (sf) sf.refreshFromFileSystemSync();
      parsed = parseFileComplete(project, filePath);
    } catch (err: any) {
      logger.warn(`Failed to parse ${relativePath}: ${err.message}`);
      parseFailed = true;
      return;
    }

    const functionIdMap = new Map<string, number>();
    for (const fn of parsed.functions) {
      const fnId = insertFunction(db, {
        file_id: fileId, name: fn.name, signature: fn.signature, body: fn.body,
        code_hash: fn.codeHash, start_line: fn.startLine, end_line: fn.endLine,
        is_exported: fn.isExported, is_async: fn.isAsync,
      });
      functionIdMap.set(fn.name, fnId);
      counts.functions++;

      const oldFn = oldFunctionMap.get(fn.name);
      if (!oldFn) {
        enqueueForAnalysis(db, fnId, 'new', getPriority('new', fn.isExported));
        counts.queued++;
      } else {
        const { reanalyze, reason } = shouldReanalyze(oldFn, fn.signature, fn.codeHash, fn.body, diffThreshold);
        if (reanalyze) {
          enqueueForAnalysis(db, fnId, reason, getPriority(reason, fn.isExported));
          counts.queued++;
        } else {
          copySemanticFields(db, fnId, oldFn);
        }
      }
    }

    for (const t of parsed.types) {
      insertType(db, {
        file_id: fileId, name: t.name, kind: t.kind, full_text: t.fullText,
        is_exported: t.isExported, start_line: t.startLine, end_line: t.endLine,
        ...(t.heritage ? { heritage: t.heritage } : {}),
      });
      counts.types++;
    }

    for (const r of parsed.routes) {
      insertRoute(db, {
        file_id: fileId, method: r.method, path: r.path, handler_name: r.handlerName,
        // Same-file handlers bind immediately — decorator routes name their
        // handler `Controller.method`, which is exactly the key the parser
        // used. Cross-file handlers are bound by resolveRouteHandlers once
        // every file has been ingested.
        handler_function_id: r.handlerName ? functionIdMap.get(r.handlerName) ?? null : null,
        handler_body: r.handlerBody, middleware: r.middleware,
        start_line: r.startLine, end_line: r.endLine,
      });
      counts.routes++;
    }

    for (const c of parsed.constants) {
      insertConstant(db, {
        file_id: fileId, name: c.name, value_text: c.valueText,
        type_annotation: c.typeAnnotation, is_exported: c.isExported,
        start_line: c.startLine, end_line: c.endLine,
      });
      counts.constants++;
    }

    upsertFileSummary(db, {
      file_id: fileId,
      import_count: parsed.fileMetadata.importCount,
      export_count: parsed.fileMetadata.exportCount,
      function_count: parsed.fileMetadata.functionCount,
      type_count: parsed.fileMetadata.typeCount,
      route_count: parsed.fileMetadata.routeCount,
      loc: parsed.fileMetadata.loc,
      imports_json: JSON.stringify(parsed.fileMetadata.imports),
      exports_json: JSON.stringify(parsed.fileMetadata.exports),
    });

    try {
      const calls = extractCallsFromFile(project, filePath, { typeResolution: opts.typeResolution });
      for (const call of calls) {
        if (call.callerName === '__file__') continue;
        const callerId = functionIdMap.get(call.callerName);
        if (!callerId) continue;

        // Precise path: the type checker told us exactly which declaration
        // this call targets. Bind straight to it when that file is already
        // ingested; otherwise persist the declaration site so the post-ingest
        // resolver can bind it regardless of file order.
        const decl = toRepoRelativeDeclaration(repoPath, call.resolved);
        const declId = decl && decl.file === relativePath
          ? functionIdMap.get(decl.name)
          : undefined;

        const inFileId = functionIdMap.get(call.calleeName);
        const calleeId = declId ?? inFileId ?? resolveUniqueCalleeFunctionId(db, call.calleeName);
        insertRelationship(db, callerId, call.calleeName, call.relationType, calleeId ?? undefined, decl ?? undefined);
        counts.relationships++;
      }
    } catch (err: any) {
      logger.warn(`Failed to extract calls from ${relativePath}: ${err.message}`);
    }
  })();

  if (parseFailed) {
    return { status: 'parse-failed', ...counts };
  }
  return { status: isNew ? 'new' : 'changed', ...counts };
}

// Remove all rows associated with a file. Used by watch mode on unlink events.
export function removeFileFromGraph(
  db: Database.Database,
  repoPath: string,
  filePath: string,
): boolean {
  const relativePath = path.relative(repoPath, filePath).split(path.sep).join('/');
  const existingFile = getFileByPath(db, relativePath);
  if (!existingFile) return false;

  db.transaction(() => {
    const oldFunctions = getFunctionsByFileId(db, existingFile.id);
    for (const oldFn of oldFunctions) {
      deleteRelationshipsByCallerFunctionId(db, oldFn.id);
    }
    deleteFunctionsByFileId(db, existingFile.id);
    deleteTypesByFileId(db, existingFile.id);
    deleteRoutesByFileId(db, existingFile.id);
    deleteConstantsByFileId(db, existingFile.id);
    deleteFile(db, existingFile.id);
  })();
  return true;
}

export interface IngestResult {
  newFiles: number;
  changedFiles: number;
  unchangedFiles: number;
  totalFunctions: number;
  totalRelationships: number;
  totalTypes: number;
  totalRoutes: number;
  totalConstants: number;
  queued: number;
}

// Heap thresholds for the type-resolution guard below, as a fraction of V8's
// hard limit. Crossing the first warns; crossing the second degrades.
const HEAP_WARN_RATIO = 0.75;
const HEAP_DEGRADE_RATIO = 0.88;

function heapUsedRatio(): number {
  const limit = v8.getHeapStatistics().heap_size_limit;
  if (!limit) return 0;
  return process.memoryUsage().heapUsed / limit;
}

// SQLite reports a contended write lock as SQLITE_BUSY. Before 3.4.0 this
// escaped as an unhandled better-sqlite3 stack trace — the most likely cause
// (a `structx watch` running against the same graph) was nowhere in the
// message.
export class GraphLockedError extends Error {
  constructor(repoPath: string) {
    super(
      `The graph for ${repoPath} is locked by another process.\n` +
      `A "structx watch" or a second ingest is probably writing to it. ` +
      `Stop that process and re-run, or point --repo at a different checkout.`,
    );
    this.name = 'GraphLockedError';
  }
}

export function isDatabaseLockedError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

export function ingestDirectory(
  db: Database.Database,
  repoPath: string,
  diffThreshold: number,
  opts: IngestOptions = {},
): IngestResult {
  let project = createProject(repoPath);
  const files = scanDirectory(repoPath);

  console.log(`Found ${files.length} TypeScript files.`);

  const result: IngestResult = {
    newFiles: 0,
    changedFiles: 0,
    unchangedFiles: 0,
    totalFunctions: 0,
    totalRelationships: 0,
    totalTypes: 0,
    totalRoutes: 0,
    totalConstants: 0,
    queued: 0,
  };

  // Type resolution makes ts-morph retain the transitive import graph, which
  // on large repos can exhaust the default heap. Previously that surfaced as
  // a silent process death with no output at all. Watch the heap and degrade
  // to name matching before V8 kills us: a slightly less precise graph beats
  // no graph and no error message.
  let typeResolution = opts.typeResolution !== false;
  let warnedHighHeap = false;
  let degradedAt: number | null = null;
  let processed = 0;

  for (const filePath of files) {
    if (typeResolution && ++processed % 25 === 0) {
      const ratio = heapUsedRatio();
      if (ratio >= HEAP_DEGRADE_RATIO) {
        typeResolution = false;
        degradedAt = processed;
        logger.warn(
          `Heap at ${(ratio * 100).toFixed(0)}% of limit after ${processed}/${files.length} files — ` +
          `disabling type resolution for the rest of this run to avoid running out of memory. ` +
          `Re-run with a larger heap (NODE_OPTIONS=--max-old-space-size=8192) for a fully resolved graph, ` +
          `or set "typeResolution": false in .structx/config.json to make this the default.`,
        );
        // Drop every AST ts-morph is holding; the remaining files are parsed
        // syntactically and do not need the resolved import graph.
        project = createProject(repoPath);
      } else if (ratio >= HEAP_WARN_RATIO && !warnedHighHeap) {
        warnedHighHeap = true;
        logger.warn(
          `Heap at ${(ratio * 100).toFixed(0)}% of limit after ${processed}/${files.length} files. ` +
          `If ingest dies without output, re-run with NODE_OPTIONS=--max-old-space-size=8192.`,
        );
      }
    }

    let fileResult;
    try {
      fileResult = ingestSingleFile(db, project, repoPath, filePath, diffThreshold, { typeResolution });
    } catch (err) {
      // A locked graph will not resolve by trying the next file — stop and
      // tell the user what is holding it.
      if (isDatabaseLockedError(err)) throw new GraphLockedError(repoPath);
      throw err;
    }
    if (fileResult.status === 'unchanged') { result.unchangedFiles++; continue; }
    if (fileResult.status === 'parse-failed') { result.changedFiles++; continue; }
    if (fileResult.status === 'new') result.newFiles++;
    else result.changedFiles++;
    result.totalFunctions += fileResult.functions;
    result.totalTypes += fileResult.types;
    result.totalRoutes += fileResult.routes;
    result.totalConstants += fileResult.constants;
    result.totalRelationships += fileResult.relationships;
    result.queued += fileResult.queued;
  }

  // Second-pass: resolve NULL callee_function_ids, type heritage, then
  // rebuild all FTS indexes. Type heritage runs after types are inserted
  // so cross-file `class X extends Y` edges bind correctly.
  const resolvedCount = resolveNullCallees(db);
  if (resolvedCount > 0) {
    logger.info(`Resolved ${resolvedCount} NULL callee_function_id(s)`);
  }
  const typeRelCount = resolveTypeRelationships(db);
  if (typeRelCount > 0) {
    logger.info(`Resolved ${typeRelCount} type heritage edge(s)`);
  }
  const routeHandlerCount = resolveRouteHandlers(db);
  if (routeHandlerCount > 0) {
    logger.info(`Linked ${routeHandlerCount} route(s) to handler functions`);
  }
  rebuildAllFtsIndexes(db);

  if (degradedAt !== null) {
    console.log(
      `\nNote: type resolution was disabled after ${degradedAt} files due to memory pressure. ` +
      `Call edges from the remaining files were matched by name only.`,
    );
  }

  return result;
}

export function printIngestResult(result: IngestResult): void {
  console.log(`\nIngestion complete:`);
  console.log(`  New files:       ${result.newFiles}`);
  console.log(`  Changed files:   ${result.changedFiles}`);
  console.log(`  Unchanged:       ${result.unchangedFiles}`);
  console.log(`  Functions:       ${result.totalFunctions}`);
  console.log(`  Types:           ${result.totalTypes}`);
  console.log(`  Routes:          ${result.totalRoutes}`);
  console.log(`  Constants:       ${result.totalConstants}`);
  console.log(`  Relationships:   ${result.totalRelationships}`);
  console.log(`  Queued:          ${result.queued} functions for semantic analysis`);
}
