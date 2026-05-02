import * as path from 'path';
import * as fs from 'fs';
import type Database from 'better-sqlite3';
import type { Project } from 'ts-morph';
import {
  upsertFile, getFileByPath, insertFunction, getFunctionsByFileId,
  deleteFunctionsByFileId, deleteRelationshipsByCallerFunctionId,
  insertRelationship, resolveUniqueCalleeFunctionId, enqueueForAnalysis,
  resolveNullCallees, rebuildAllFtsIndexes,
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

// Ingest one file. Caller is responsible for running resolveNullCallees and
// rebuildAllFtsIndexes after a batch of changes (debounced in watch mode).
export function ingestSingleFile(
  db: Database.Database,
  project: Project,
  repoPath: string,
  filePath: string,
  diffThreshold: number,
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
        }
      }
    }

    for (const t of parsed.types) {
      insertType(db, {
        file_id: fileId, name: t.name, kind: t.kind, full_text: t.fullText,
        is_exported: t.isExported, start_line: t.startLine, end_line: t.endLine,
      });
      counts.types++;
    }

    for (const r of parsed.routes) {
      insertRoute(db, {
        file_id: fileId, method: r.method, path: r.path, handler_name: r.handlerName,
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
      const calls = extractCallsFromFile(project, filePath);
      for (const call of calls) {
        if (call.callerName === '__file__') continue;
        const callerId = functionIdMap.get(call.callerName);
        if (!callerId) continue;
        const inFileId = functionIdMap.get(call.calleeName);
        const calleeId = inFileId ?? resolveUniqueCalleeFunctionId(db, call.calleeName);
        insertRelationship(db, callerId, call.calleeName, call.relationType, calleeId ?? undefined);
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

export function ingestDirectory(
  db: Database.Database,
  repoPath: string,
  diffThreshold: number
): IngestResult {
  const project = createProject(repoPath);
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

  for (const filePath of files) {
    const fileResult = ingestSingleFile(db, project, repoPath, filePath, diffThreshold);
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

  // Second-pass: resolve NULL callee_function_ids and rebuild all FTS indexes
  const resolvedCount = resolveNullCallees(db);
  if (resolvedCount > 0) {
    logger.info(`Resolved ${resolvedCount} NULL callee_function_id(s)`);
  }
  rebuildAllFtsIndexes(db);

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
