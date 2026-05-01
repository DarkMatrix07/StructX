import * as path from 'path';
import * as fs from 'fs';
import type Database from 'better-sqlite3';
import {
  upsertFile, getFileByPath, insertFunction, getFunctionsByFileId,
  deleteFunctionsByFileId, deleteRelationshipsByCallerFunctionId,
  getAllFiles, deleteFile,
  insertRelationship, getFunctionByName, enqueueForAnalysis,
  copySemanticFields,
  resolveNullCallees, rebuildAllFtsIndexes,
  insertType, deleteTypesByFileId,
  insertRoute, deleteRoutesByFileId,
  insertConstant, deleteConstantsByFileId,
  upsertFileSummary,
} from '../db/queries';
import { createProject, parseFileComplete, hashFileContent } from './parser';
import { extractCallsFromFile } from './relationships';
import { shouldReanalyze, getPriority } from './differ';
import { scanDirectory } from './scanner';
import { logger } from '../utils/logger';
import { toRepoRelativePath } from '../utils/paths';

export interface IngestResult {
  newFiles: number;
  deletedFiles: number;
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
  const scannedRelativePaths = new Set(files.map(filePath => toRepoRelativePath(repoPath, filePath)));

  console.log(`Found ${files.length} TypeScript files.`);

  const result: IngestResult = {
    newFiles: 0,
    deletedFiles: 0,
    changedFiles: 0,
    unchangedFiles: 0,
    totalFunctions: 0,
    totalRelationships: 0,
    totalTypes: 0,
    totalRoutes: 0,
    totalConstants: 0,
    queued: 0,
  };

  db.transaction(() => {
    for (const existingFile of getAllFiles(db)) {
      if (!scannedRelativePaths.has(existingFile.path)) {
        deleteFile(db, existingFile.id);
        result.deletedFiles++;
      }
    }
  })();

  for (const filePath of files) {
    const relativePath = toRepoRelativePath(repoPath, filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const contentHash = hashFileContent(content);

    const existingFile = getFileByPath(db, relativePath);
    if (existingFile && existingFile.content_hash === contentHash) {
      result.unchangedFiles++;
      continue;
    }

    const isNew = !existingFile;
    if (isNew) result.newFiles++;
    else result.changedFiles++;

    // Wrap each file's ingest in a transaction for atomicity
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
        parsed = parseFileComplete(project, filePath);
      } catch (err: any) {
        logger.warn(`Failed to parse ${relativePath}: ${err.message}`);
        return;
      }

      // Insert functions
      const functionIdMap = new Map<string, number>();
      for (const fn of parsed.functions) {
        const fnId = insertFunction(db, {
          file_id: fileId,
          name: fn.name,
          signature: fn.signature,
          body: fn.body,
          code_hash: fn.codeHash,
          start_line: fn.startLine,
          end_line: fn.endLine,
          is_exported: fn.isExported,
          is_async: fn.isAsync,
        });
        functionIdMap.set(fn.name, fnId);
        result.totalFunctions++;

        const oldFn = oldFunctionMap.get(fn.name);
        if (!oldFn) {
          enqueueForAnalysis(db, fnId, 'new', getPriority('new', fn.isExported));
          result.queued++;
        } else {
          const { reanalyze, reason } = shouldReanalyze(
            oldFn, fn.signature, fn.codeHash, fn.body, diffThreshold
          );
          if (reanalyze) {
            enqueueForAnalysis(db, fnId, reason, getPriority(reason, fn.isExported));
            result.queued++;
          } else {
            copySemanticFields(db, fnId, oldFn);
          }
        }
      }

      // Insert types
      for (const t of parsed.types) {
        insertType(db, {
          file_id: fileId,
          name: t.name,
          kind: t.kind,
          full_text: t.fullText,
          is_exported: t.isExported,
          start_line: t.startLine,
          end_line: t.endLine,
        });
        result.totalTypes++;
      }

      // Insert routes
      for (const r of parsed.routes) {
        insertRoute(db, {
          file_id: fileId,
          method: r.method,
          path: r.path,
          handler_name: r.handlerName,
          handler_body: r.handlerBody,
          middleware: r.middleware,
          start_line: r.startLine,
          end_line: r.endLine,
        });
        result.totalRoutes++;
      }

      // Insert constants
      for (const c of parsed.constants) {
        insertConstant(db, {
          file_id: fileId,
          name: c.name,
          value_text: c.valueText,
          type_annotation: c.typeAnnotation,
          is_exported: c.isExported,
          start_line: c.startLine,
          end_line: c.endLine,
        });
        result.totalConstants++;
      }

      // Insert file summary
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

      // Extract and insert relationships
      try {
        const calls = extractCallsFromFile(project, filePath);
        for (const call of calls) {
          if (call.callerName === '__file__') continue;
          const callerId = functionIdMap.get(call.callerName);
          if (!callerId) continue;
          const callee = getFunctionByName(db, call.calleeName);
          insertRelationship(db, callerId, call.calleeName, call.relationType, callee?.id);
          result.totalRelationships++;
        }
      } catch (err: any) {
        logger.warn(`Failed to extract calls from ${relativePath}: ${err.message}`);
      }
    })();
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
  console.log(`  Deleted files:   ${result.deletedFiles}`);
  console.log(`  Changed files:   ${result.changedFiles}`);
  console.log(`  Unchanged:       ${result.unchangedFiles}`);
  console.log(`  Functions:       ${result.totalFunctions}`);
  console.log(`  Types:           ${result.totalTypes}`);
  console.log(`  Routes:          ${result.totalRoutes}`);
  console.log(`  Constants:       ${result.totalConstants}`);
  console.log(`  Relationships:   ${result.totalRelationships}`);
  console.log(`  Queued:          ${result.queued} functions for semantic analysis`);
}
