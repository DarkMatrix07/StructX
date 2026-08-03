#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { getStructXDir, loadConfig, saveConfig, ensureStructxGitignored, getLlmConfig } from './config';
import { initializeDatabase, openDatabase, getDbPath } from './db/connection';
import { getStats, getFullOverview } from './db/queries';
import { logger, setLogLevel } from './utils/logger';
import { analyzeBatch, rebuildSearchIndex, analyzeTypes, analyzeRoutes, analyzeFileSummaries } from './semantic/analyzer';
import { estimateAnalysisCost, formatCostEstimate } from './semantic/cost';
import { getPendingAnalysis, getPendingAnalysisCount, enqueueUnanalyzedFunctions, insertQaRun, getCachedAskResponse, insertCachedAskResponse } from './db/queries';
import { findCallPaths, findRoutePathsTo, semanticQuery, semanticFacets } from './db/queries';
import { classifyQuestionWithUsage } from './query/classifier';
import { directLookup, directLookupExpanded, relationshipQuery, semanticSearch, domainQuery, impactAnalysis, routeQuery, routeKeywordQuery, typeQuery, fileQuery, listQuery, patternQuery } from './query/retriever';
import { buildContext } from './query/context-builder';
import { generateAnswer } from './query/answerer';
import { getGraphFingerprint, makeAskCacheKey } from './query/ask-cache';
import { runBenchmark } from './benchmark/runner';
import { generateMarkdownReport, generateCsvReport, saveReport } from './benchmark/reporter';
import { ingestDirectory, printIngestResult } from './ingest/ingester';
import { watchDirectory } from './watch/watcher';
import { runMcpServer } from './mcp/server';
import { diffEntities } from './git/diff';
import type { LlmProvider } from './utils/llm';

const program = new Command();

// Type guard for `--provider`. Gemini has been a fully supported provider
// since the multi-provider refactor, but the CLI validation listed only
// anthropic and openrouter — so `--provider gemini` was silently ignored and
// the run fell back to whatever the config/env said.
function isKnownProvider(value: string | undefined): value is LlmProvider {
  return value === 'anthropic' || value === 'gemini' || value === 'openrouter';
}

function parseMaxTokens(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 64 || parsed > 8192) {
    throw new Error('--max-tokens must be an integer between 64 and 8192');
  }
  return parsed;
}

function formatProviderError(err: any): string {
  const message = err?.message || String(err);
  if (err?.status === 402 || /insufficient credits/i.test(message)) {
    return 'provider returned 402 insufficient credits. Add credits or use a different provider/key.';
  }
  if (/api key/i.test(message) || err?.status === 401) {
    return 'provider authentication failed. Check the configured API key and provider.';
  }
  return message;
}

// A locked graph is a normal operational conflict (a `structx watch` running
// in another terminal), not a crash. Surface it as a one-line message rather
// than an unhandled better-sqlite3 stack trace.
process.on('uncaughtException', (err: any) => {
  if (err?.name === 'GraphLockedError') {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
  throw err;
});

program
  .name('structx')
  .description('Graph-powered code intelligence CLI for TypeScript')
  .version('3.4.0')
  .option('--verbose', 'Enable verbose logging')
  .hook('preAction', (thisCommand) => {
    if (thisCommand.opts().verbose) {
      setLogLevel('debug');
    }
  });

// ── setup (one-step bootstrap) ──
program
  .command('setup')
  .description('One-step bootstrap: init + ingest + analyze')
  .argument('[repo-path]', 'Path to TypeScript repository', '.')
  .option('--api-key <key>', 'API key for the chosen provider (overrides env vars)')
  .option('--provider <name>', 'LLM provider: anthropic | gemini | openrouter', undefined)
  .action(async (repoPath: string, opts: { apiKey?: string; provider?: string }) => {
    const resolved = path.resolve(repoPath);
    const structxDir = getStructXDir(resolved);

    // Step 1: Init — persist provider choice up front so loadConfig picks the
    // right defaults (model names) on the very first run.
    const dbPath = getDbPath(structxDir);
    if (fs.existsSync(dbPath)) {
      console.log(`StructX already initialized at ${structxDir}`);
    } else {
      const db = initializeDatabase(dbPath);
      db.close();
      const initial: any = { repoPath: resolved };
      if (isKnownProvider(opts.provider)) {
        initial.provider = opts.provider;
      }
      saveConfig(structxDir, initial);
      console.log(`Initialized StructX at ${structxDir}`);
    }
    if (ensureStructxGitignored(resolved)) {
      console.log('Added .structx/ to .gitignore');
    }

    // Step 2: Ingest
    const config = loadConfig(structxDir);
    if (isKnownProvider(opts.provider)) {
      config.provider = opts.provider;
    }
    if (opts.apiKey) config.anthropicApiKey = opts.apiKey;
    const db = openDatabase(dbPath);

    console.log(`\nScanning ${resolved} for TypeScript files...`);
    const ingestResult = ingestDirectory(db, resolved, config.diffThreshold, { typeResolution: config.typeResolution });
    printIngestResult(ingestResult);

    // Step 3: Analyze (auto-confirm)
    if (ingestResult.queued > 0 && config.anthropicApiKey) {
      const pendingCount = getPendingAnalysisCount(db);
      const estimate = estimateAnalysisCost(pendingCount, config.batchSize, config.analysisModel);
      console.log('\n' + formatCostEstimate(estimate));
      console.log('\nAnalyzing...');

      let totalAnalyzed = 0;
      let totalCached = 0;
      let totalFailed = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCost = 0;
      let batchNum = 0;
      let abortReason: string | undefined;

      while (true) {
        const pending = getPendingAnalysis(db, config.batchSize);
        if (pending.length === 0) break;

        batchNum++;
        const items = pending.map(p => ({ id: p.id, function_id: p.function_id }));
        console.log(`  Batch ${batchNum}: ${items.length} functions...`);
        const batchResult = await analyzeBatch(db, items, config.analysisModel, getLlmConfig(config));

        totalAnalyzed += batchResult.analyzed;
        totalCached += batchResult.cached;
        totalFailed += batchResult.failed;
        totalInputTokens += batchResult.totalInputTokens;
        totalOutputTokens += batchResult.totalOutputTokens;
        totalCost += batchResult.totalCost;

        // Stop the function-batch loop the first time the provider says
        // we're out of credits / authentication failed. Without this, the
        // CLI would burn time hammering an endpoint that will keep
        // rejecting every call and report a confusing "Failed: N" total
        // with no reason. Items are already marked `failed` in the DB
        // and will re-enqueue on the next analyze run.
        if (batchResult.aborted) {
          abortReason = batchResult.abortReason;
          break;
        }
      }

      // Analyze types, routes, and file summaries — but only if we didn't
      // already hit a fatal provider error in the function loop above.
      const typeResult = abortReason
        ? { analyzed: 0, cached: 0, failed: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 }
        : await analyzeTypes(db, config.analysisModel, getLlmConfig(config));
      const routeResult = abortReason || (typeResult as any).aborted
        ? { analyzed: 0, cached: 0, failed: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 }
        : await analyzeRoutes(db, config.analysisModel, getLlmConfig(config));
      const fileResult = abortReason || (typeResult as any).aborted || (routeResult as any).aborted
        ? { analyzed: 0, cached: 0, failed: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 }
        : await analyzeFileSummaries(db, config.analysisModel, getLlmConfig(config));
      if (!abortReason) {
        abortReason = (typeResult as any).abortReason ?? (routeResult as any).abortReason ?? (fileResult as any).abortReason;
      }
      if (!abortReason) {
        console.log('\n  Analyzing types, routes, and file summaries...');
      }

      totalAnalyzed += typeResult.analyzed + routeResult.analyzed + fileResult.analyzed;
      totalFailed += typeResult.failed + routeResult.failed + fileResult.failed;
      totalInputTokens += typeResult.totalInputTokens + routeResult.totalInputTokens + fileResult.totalInputTokens;
      totalOutputTokens += typeResult.totalOutputTokens + routeResult.totalOutputTokens + fileResult.totalOutputTokens;
      totalCost += typeResult.totalCost + routeResult.totalCost + fileResult.totalCost;

      rebuildSearchIndex(db);

      console.log(`\nAnalysis complete:`);
      console.log(`  Functions:      ${totalAnalyzed - typeResult.analyzed - routeResult.analyzed - fileResult.analyzed}`);
      console.log(`  Types:          ${typeResult.analyzed}`);
      console.log(`  Routes:         ${routeResult.analyzed}`);
      console.log(`  Files:          ${fileResult.analyzed}`);
      console.log(`  From cache:     ${totalCached}`);
      console.log(`  Failed:         ${totalFailed}`);
      console.log(`  Input tokens:   ${totalInputTokens.toLocaleString()}`);
      console.log(`  Output tokens:  ${totalOutputTokens.toLocaleString()}`);
      console.log(`  Total cost:     $${totalCost.toFixed(4)}`);
      if (abortReason) {
        console.log(`\nAborted: ${abortReason}`);
        console.log(`Failed items remain queued — re-run \`structx analyze .\` after fixing the issue.`);
      }
    } else if (ingestResult.queued > 0) {
      console.log('\nSkipping analysis: ANTHROPIC_API_KEY not set.');
      console.log('Set the key and run "structx analyze . --yes" to enrich functions.');
    } else if (config.anthropicApiKey) {
      // Still analyze types/routes/files even if no new functions
      console.log('\nAnalyzing types, routes, and file summaries...');
      const typeResult = await analyzeTypes(db, config.analysisModel, getLlmConfig(config));
      const routeResult = await analyzeRoutes(db, config.analysisModel, getLlmConfig(config));
      const fileResult = await analyzeFileSummaries(db, config.analysisModel, getLlmConfig(config));
      const entityCount = typeResult.analyzed + routeResult.analyzed + fileResult.analyzed;
      if (entityCount > 0) {
        rebuildSearchIndex(db);
        console.log(`  Analyzed ${entityCount} entities (${typeResult.analyzed} types, ${routeResult.analyzed} routes, ${fileResult.analyzed} files)`);
      } else {
        console.log('No entities to analyze.');
      }
    } else {
      console.log('\nNo functions to analyze.');
    }

    db.close();
    console.log('\nSetup complete.');
  });

// ── install (drop instruction files into project) ──
program
  .command('install')
  .description('Install AI agent instruction files into a project')
  .argument('[repo-path]', 'Path to target project', '.')
  .option('--force', 'Overwrite existing instruction files')
  .action((repoPath: string, opts: { force?: boolean }) => {
    const resolved = path.resolve(repoPath);
    const instructionsDir = path.join(__dirname, 'instructions');
    const agentMdPath = path.join(instructionsDir, 'agent.md');

    if (!fs.existsSync(agentMdPath)) {
      console.log('Instruction template not found. Package may be incorrectly installed.');
      return;
    }

    const content = fs.readFileSync(agentMdPath, 'utf-8');
    let installed = 0;

    // All target files use the same agent.md content
    const targets: { name: string; path: string; dir?: string }[] = [
      { name: 'CLAUDE.md', path: path.join(resolved, 'CLAUDE.md') },
      { name: 'AGENTS.md', path: path.join(resolved, 'AGENTS.md') },
      { name: '.cursorrules', path: path.join(resolved, '.cursorrules') },
      { name: '.github/copilot-instructions.md', path: path.join(resolved, '.github', 'copilot-instructions.md'), dir: path.join(resolved, '.github') },
    ];

    for (const target of targets) {
      if (target.dir && !fs.existsSync(target.dir)) {
        fs.mkdirSync(target.dir, { recursive: true });
      }

      if (fs.existsSync(target.path) && !opts.force) {
        const existing = fs.readFileSync(target.path, 'utf-8');
        if (existing.includes('StructX')) {
          console.log(`  ${target.name} — already contains StructX section, skipping. Use --force to overwrite.`);
        } else {
          fs.appendFileSync(target.path, '\n\n' + content, 'utf-8');
          console.log(`  ${target.name} — appended StructX section.`);
          installed++;
        }
      } else {
        fs.writeFileSync(target.path, content, 'utf-8');
        console.log(`  ${target.name} — ${opts.force ? 'replaced' : 'created'}.`);
        installed++;
      }
    }

    if (ensureStructxGitignored(resolved)) {
      console.log('Added .structx/ to .gitignore');
    }

    console.log(`\nInstalled ${installed} instruction file(s) into ${resolved}`);
  });

// ── init ──
program
  .command('init')
  .description('Initialize StructX for the current repository')
  .argument('[repo-path]', 'Path to TypeScript repository', '.')
  .action((repoPath: string) => {
    const resolved = path.resolve(repoPath);
    const structxDir = getStructXDir(resolved);

    if (fs.existsSync(getDbPath(structxDir))) {
      console.log(`StructX already initialized at ${structxDir}`);
      return;
    }

    // Create DB
    const dbPath = getDbPath(structxDir);
    const db = initializeDatabase(dbPath);
    db.close();

    // Create config
    saveConfig(structxDir, {
      repoPath: resolved,
    });

    if (ensureStructxGitignored(resolved)) {
      console.log('Added .structx/ to .gitignore');
    }

    console.log(`Initialized StructX at ${structxDir}`);
    console.log(`  Database: ${dbPath}`);
    console.log(`  Config:   ${path.join(structxDir, 'config.json')}`);
    console.log(`\nNext: run 'structx ingest ${repoPath}' to parse your codebase.`);
  });

// ── status ──
program
  .command('status')
  .description('Show current StructX statistics')
  .argument('[repo-path]', 'Path to TypeScript repository', '.')
  .action((repoPath: string) => {
    const resolved = path.resolve(repoPath);
    const structxDir = getStructXDir(resolved);
    const dbPath = getDbPath(structxDir);

    if (!fs.existsSync(dbPath)) {
      console.log('StructX not initialized. Run "structx init" first.');
      return;
    }

    const db = openDatabase(dbPath);
    const stats = getStats(db);
    db.close();

    console.log('StructX Status');
    console.log('──────────────────────────');
    console.log(`  Files:           ${stats.totalFiles}`);
    console.log(`  Functions:       ${stats.totalFunctions}`);
    console.log(`  Types:           ${stats.totalTypes}`);
    console.log(`  Routes:          ${stats.totalRoutes}`);
    console.log(`  Constants:       ${stats.totalConstants}`);
    console.log(`  Relationships:   ${stats.totalRelationships}`);
    console.log(`  Analyzed:        ${stats.analyzedFunctions} / ${stats.totalFunctions}`);
    console.log(`  Pending:         ${stats.pendingAnalysis}`);
    console.log(`  QA Runs:         ${stats.totalQaRuns}`);
  });

// ── overview ──
program
  .command('overview')
  .description('Full codebase summary in one shot — shows all files, functions, types, routes, and constants')
  .option('--repo <path>', 'Path to TypeScript repository', '.')
  .action((opts: { repo: string }) => {
    const resolved = path.resolve(opts.repo);
    const structxDir = getStructXDir(resolved);
    const dbPath = getDbPath(structxDir);

    if (!fs.existsSync(dbPath)) {
      console.log('StructX not initialized. Run "structx setup ." first.');
      return;
    }

    const db = openDatabase(dbPath);
    const overview = getFullOverview(db);
    db.close();

    const { stats, files, functions, types, routes, constants } = overview;

    // Header
    console.log('StructX Codebase Overview');
    console.log('═'.repeat(60));
    console.log(`  Files: ${stats.totalFiles} | Functions: ${stats.totalFunctions} | Types: ${stats.totalTypes} | Routes: ${stats.totalRoutes} | Constants: ${stats.totalConstants}`);
    console.log(`  Relationships: ${stats.totalRelationships} | Analyzed: ${stats.analyzedFunctions}/${stats.totalFunctions}`);
    console.log('');

    // Files section
    if (files.length > 0) {
      console.log('── Files ──');
      for (const f of files) {
        const purpose = f.summary?.purpose ? ` — ${f.summary.purpose}` : '';
        const counts: string[] = [];
        if (f.summary) {
          if (f.summary.function_count > 0) counts.push(`${f.summary.function_count} fns`);
          if (f.summary.type_count > 0) counts.push(`${f.summary.type_count} types`);
          if (f.summary.route_count > 0) counts.push(`${f.summary.route_count} routes`);
          counts.push(`${f.summary.loc} LOC`);
        }
        const countsStr = counts.length > 0 ? ` (${counts.join(', ')})` : '';
        console.log(`  ${f.path}${countsStr}${purpose}`);
      }
      console.log('');
    }

    // Routes section
    if (routes.length > 0) {
      console.log('── Routes / Endpoints ──');
      for (const r of routes) {
        const purpose = r.purpose ? ` — ${r.purpose}` : '';
        const file = r.filePath.split(/[/\\]/).slice(-1)[0];
        console.log(`  ${r.method.toUpperCase().padEnd(7)} ${r.path}  [${file}:${r.start_line}]${purpose}`);
      }
      console.log('');
    }

    // Types section
    if (types.length > 0) {
      console.log('── Types & Interfaces ──');
      for (const t of types) {
        const purpose = t.purpose ? ` — ${t.purpose}` : '';
        const exported = t.is_exported ? '(exported) ' : '';
        const file = t.filePath.split(/[/\\]/).slice(-1)[0];
        console.log(`  ${t.kind.padEnd(12)} ${t.name} ${exported}[${file}:${t.start_line}]${purpose}`);
      }
      console.log('');
    }

    // Functions section
    if (functions.length > 0) {
      console.log('── Functions ──');
      for (const fn of functions) {
        const purpose = fn.purpose ? ` — ${fn.purpose}` : '';
        const exported = fn.is_exported ? '(exported) ' : '';
        const asyncStr = fn.is_async ? 'async ' : '';
        const file = fn.filePath.split(/[/\\]/).slice(-1)[0];
        console.log(`  ${asyncStr}${fn.name} ${exported}[${file}:${fn.start_line}]${purpose}`);
      }
      console.log('');
    }

    // Exported constants section
    if (constants.length > 0) {
      console.log('── Exported Constants ──');
      for (const c of constants) {
        const typeStr = c.type_annotation ? `: ${c.type_annotation}` : '';
        const valStr = c.value_text ? ` = ${c.value_text.substring(0, 60)}${c.value_text.length > 60 ? '...' : ''}` : '';
        const file = c.filePath.split(/[/\\]/).slice(-1)[0];
        console.log(`  ${c.name}${typeStr}${valStr}  [${file}:${c.start_line}]`);
      }
      console.log('');
    }

    if (stats.totalFunctions === 0 && stats.totalTypes === 0 && stats.totalRoutes === 0) {
      console.log('Knowledge graph is empty. Run "structx setup ." to populate it.');
    }
  });

// ── doctor ──
program
  .command('doctor')
  .description('Validate StructX environment and configuration')
  .argument('[repo-path]', 'Path to TypeScript repository', '.')
  .action((repoPath: string) => {
    const resolved = path.resolve(repoPath);
    const structxDir = getStructXDir(resolved);
    let allGood = true;

    // Check Node version
    const nodeVersion = process.version;
    const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);
    if (major >= 18) {
      console.log(`  [OK] Node.js ${nodeVersion}`);
    } else {
      console.log(`  [FAIL] Node.js ${nodeVersion} (requires >= 18)`);
      allGood = false;
    }

    // Check DB
    const dbPath = getDbPath(structxDir);
    if (fs.existsSync(dbPath)) {
      console.log(`  [OK] Database exists at ${dbPath}`);
    } else {
      console.log(`  [FAIL] Database not found. Run 'structx init' first.`);
      allGood = false;
    }

    // Check config
    try {
      const config = loadConfig(structxDir);

      // Check API key
      if (config.anthropicApiKey) {
        console.log(`  [OK] API key is set for ${config.provider}`);
      } else {
        const envVar = config.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
        console.log(`  [WARN] API key not set for ${config.provider} (set ${envVar} env var or add to config)`);
        allGood = false;
      }

      // Check repo path
      if (fs.existsSync(config.repoPath)) {
        console.log(`  [OK] Repository path: ${config.repoPath}`);
      } else {
        console.log(`  [FAIL] Repository path not found: ${config.repoPath}`);
        allGood = false;
      }
    } catch {
      console.log('  [FAIL] Config not found. Run "structx init" first.');
      allGood = false;
    }

    console.log();
    if (allGood) {
      console.log('All checks passed.');
    } else {
      console.log('Some checks failed. Fix the issues above and try again.');
    }
  });

// ── ingest ──
program
  .command('ingest')
  .description('Parse codebase into function graph')
  .argument('[repo-path]', 'Path to TypeScript repository', '.')
  .action((repoPath: string) => {
    const resolved = path.resolve(repoPath);
    const structxDir = getStructXDir(resolved);
    const dbPath = getDbPath(structxDir);

    if (!fs.existsSync(dbPath)) {
      console.log('StructX not initialized. Run "structx init" first.');
      return;
    }

    const config = loadConfig(structxDir);
    const db = openDatabase(dbPath);

    console.log(`Scanning ${resolved} for TypeScript files...`);
    const ingestResult = ingestDirectory(db, resolved, config.diffThreshold, { typeResolution: config.typeResolution });
    printIngestResult(ingestResult);

    db.close();

    if (ingestResult.queued > 0) {
      console.log(`\nNext: run 'structx analyze' to enrich functions with semantic metadata.`);
    }
  });

// ── watch ──
program
  .command('watch')
  .description('Watch the repo for changes and incrementally update the graph')
  .argument('[repo-path]', 'Path to TypeScript repository', '.')
  .option('--no-initial-ingest', 'Skip the initial full scan before watching')
  .action(async (repoPath: string, opts: { initialIngest?: boolean }) => {
    const resolved = path.resolve(repoPath);
    const structxDir = getStructXDir(resolved);
    const dbPath = getDbPath(structxDir);

    if (!fs.existsSync(dbPath)) {
      console.log('StructX not initialized. Run "structx init" first.');
      return;
    }

    const config = loadConfig(structxDir);
    const db = openDatabase(dbPath);

    if (opts.initialIngest !== false) {
      console.log(`Initial scan of ${resolved}...`);
      const result = ingestDirectory(db, resolved, config.diffThreshold, { typeResolution: config.typeResolution });
      printIngestResult(result);
    }

    const stop = await watchDirectory(db, resolved, {
      diffThreshold: config.diffThreshold,
      typeResolution: config.typeResolution,
    });

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\nReceived ${signal}, shutting down...`);
      await stop();
      try { db.close(); } catch {}
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });

// ── diff ──
program
  .command('diff')
  .description('Show indexed entities changed since a git ref (commit / branch / tag)')
  .argument('<ref>', 'git ref to diff against, e.g. HEAD~1, main, abc1234')
  .option('--repo <path>', 'Repository path', '.')
  .option('--json', 'Emit machine-readable JSON instead of the human summary')
  .action(async (ref: string, opts: { repo: string; json?: boolean }) => {
    const resolved = path.resolve(opts.repo);
    const structxDir = getStructXDir(resolved);
    const dbPath = getDbPath(structxDir);
    if (!fs.existsSync(dbPath)) {
      console.log('StructX not initialized. Run "structx init" first.');
      return;
    }
    const db = openDatabase(dbPath);

    let result;
    try {
      result = diffEntities(db, resolved, ref);
    } catch (err: any) {
      console.error(err.message);
      db.close();
      process.exit(1);
    }
    db.close();

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Changed since ${ref}: ${result.changedFiles.length} files`);
    if (result.functions.length > 0) {
      console.log(`\nFunctions (${result.functions.length}):`);
      for (const fn of result.functions) console.log(`  [${fn.status}] ${fn.name}  ${fn.file}`);
    }
    if (result.types.length > 0) {
      console.log(`\nTypes (${result.types.length}):`);
      for (const t of result.types) console.log(`  [${t.status}] ${t.kind} ${t.name}  ${t.file}`);
    }
    if (result.routes.length > 0) {
      console.log(`\nRoutes (${result.routes.length}):`);
      for (const r of result.routes) console.log(`  [${r.status}] ${r.method} ${r.path}  ${r.file}`);
    }
    if (result.unindexedFiles.length > 0) {
      console.log(`\nChanged but not in graph (${result.unindexedFiles.length}):`);
      for (const f of result.unindexedFiles) console.log(`  ${f}`);
    }
  });

// ── path ──
program
  .command('path')
  .description('Trace the call chain to a function — from another function, or from every HTTP endpoint that reaches it')
  .argument('<to>', 'Destination function name')
  .option('--from <name>', 'Starting function. Omit to search from all HTTP endpoints instead.')
  .option('--repo <path>', 'Path to TypeScript repository', '.')
  .option('--max-depth <n>', 'Maximum hops to traverse (default 8)', (v) => parseInt(v, 10))
  .option('--limit <n>', 'Maximum paths to return (default 5)', (v) => parseInt(v, 10))
  .action((to: string, opts: { from?: string; repo: string; maxDepth?: number; limit?: number }) => {
    const resolved = path.resolve(opts.repo);
    const dbPath = getDbPath(getStructXDir(resolved));
    if (!fs.existsSync(dbPath)) {
      console.log('StructX not initialized. Run "structx setup ." first.');
      return;
    }
    const db = openDatabase(dbPath);
    const maxDepth = opts.maxDepth ?? 8;
    const limit = opts.limit ?? 5;

    const renderChain = (steps: Array<{ name: string; filePath: string; start_line: number; purpose: string | null }>) => {
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const indent = '  '.repeat(i);
        const arrow = i > 0 ? '└─ ' : '';
        const purpose = s.purpose ? `  — ${s.purpose}` : '';
        console.log(`  ${indent}${arrow}${s.name}  [${s.filePath}:${s.start_line}]${purpose}`);
      }
    };

    if (!opts.from) {
      const routePaths = findRoutePathsTo(db, to, maxDepth, limit);
      console.log(`Endpoints reaching ${to}: ${routePaths.length}`);
      for (const rp of routePaths) {
        // An inline handler is named after its own route, so printing both the
        // header and the first step would say the same thing twice. Fold the
        // handler's location into the header instead.
        const [first, ...rest] = rp.callPath;
        if (first && first.name === `${rp.method} ${rp.path}`) {
          console.log(`\n${rp.method} ${rp.path}  [${first.filePath}:${first.start_line}]`);
          renderChain(rest);
        } else {
          console.log(`\n${rp.method} ${rp.path}`);
          renderChain(rp.callPath);
        }
      }
      if (routePaths.length === 0) {
        console.log('\nNo indexed endpoint reaches it. The handler may be an inline arrow function, or the chain may exceed --max-depth.');
      }
      db.close();
      return;
    }

    const paths = findCallPaths(db, opts.from, to, maxDepth, limit);
    console.log(`Call paths ${opts.from} → ${to}: ${paths.length}`);
    for (const p of paths) {
      console.log(`\n${p.depth} hop${p.depth === 1 ? '' : 's'}:`);
      renderChain(p.steps);
    }
    if (paths.length === 0) {
      console.log(`\nNo path found within ${maxDepth} hops. Unresolved edges (external or dynamic calls) are not traversable.`);
    }
    db.close();
  });

// ── query ──
program
  .command('query')
  .description('Filter functions by semantic properties (domain, side effects, complexity) instead of keywords')
  .option('--repo <path>', 'Path to TypeScript repository', '.')
  .option('--domain <name>', 'Domain label, e.g. database, authentication, validation')
  .option('--complexity <level>', 'low | medium | high')
  .option('--side-effect <text>', 'Substring match against recorded side effects, e.g. "write"')
  .option('--exported', 'Only exported functions')
  .option('--async', 'Only async functions')
  .option('--name <pattern>', 'SQL LIKE pattern on the function name, e.g. "handle%"')
  .option('--file <pattern>', 'SQL LIKE pattern on the file path, e.g. "src/auth/%"')
  .option('--limit <n>', 'Maximum results (default 50)', (v) => parseInt(v, 10))
  .action((opts: any) => {
    const resolved = path.resolve(opts.repo);
    const dbPath = getDbPath(getStructXDir(resolved));
    if (!fs.existsSync(dbPath)) {
      console.log('StructX not initialized. Run "structx setup ." first.');
      return;
    }
    const db = openDatabase(dbPath);

    const hasFilter = ['domain', 'complexity', 'sideEffect', 'exported', 'async', 'name', 'file']
      .some(k => opts[k] !== undefined);

    if (!hasFilter) {
      const facets = semanticFacets(db);
      console.log(`Semantic index: ${facets.analyzed} of ${facets.total} functions analyzed\n`);
      if (facets.analyzed === 0) {
        console.log('Run "structx analyze . --yes" to populate domain, side-effect and complexity labels.');
      }
      if (facets.domains.length > 0) {
        console.log('Domains:');
        for (const d of facets.domains) console.log(`  ${d.value.padEnd(16)} ${d.count}`);
      }
      if (facets.complexities.length > 0) {
        console.log('\nComplexity:');
        for (const d of facets.complexities) console.log(`  ${d.value.padEnd(16)} ${d.count}`);
      }
      db.close();
      return;
    }

    const rows = semanticQuery(db, {
      domain: opts.domain,
      complexity: opts.complexity,
      sideEffect: opts.sideEffect,
      isExported: opts.exported ? true : undefined,
      isAsync: opts.async ? true : undefined,
      namePattern: opts.name,
      filePattern: opts.file,
      limit: opts.limit ?? 50,
    });

    console.log(`Matching functions: ${rows.length}\n`);
    for (const fn of rows) {
      let sideEffects: string[] = [];
      try { if (fn.side_effects_json) sideEffects = JSON.parse(fn.side_effects_json); } catch {}
      const tags = [fn.domain, fn.complexity, fn.is_exported ? 'exported' : null, fn.is_async ? 'async' : null]
        .filter(Boolean).join(' · ');
      console.log(`  ${fn.name}  [${fn.filePath}:${fn.start_line}]${tags ? `  (${tags})` : ''}`);
      if (fn.purpose) console.log(`      ${fn.purpose}`);
      if (sideEffects.length > 0) console.log(`      side effects: ${sideEffects.join(', ')}`);
    }
    if (rows.length === 0) console.log('  (none)');
    db.close();
  });

// ── mcp ──
program
  .command('mcp')
  .description('Run as a Model Context Protocol server (stdio) for use by AI editors')
  .argument('[repo-path]', 'Default repo for tool calls', '.')
  .option('--repo <path>', 'Default repo for tool calls (overrides positional arg)')
  .option('--readonly', 'Open the graph DB readonly and disable structx_ask. Useful for shared repos where MCP should never mutate state.')
  .action(async (repoPath: string, opts: { repo?: string; readonly?: boolean }) => {
    const resolved = path.resolve(opts.repo ?? repoPath);
    // The MCP server speaks JSON-RPC over stdout, so any console.log() would
    // corrupt the protocol. runMcpServer logs everything via the stderr-only
    // logger and blocks until the parent disconnects.
    await runMcpServer(resolved, { readonly: !!opts.readonly });
  });

// ── analyze ──
program
  .command('analyze')
  .description('Run LLM semantic analysis on extracted functions')
  .argument('[repo-path]', 'Path to TypeScript repository', '.')
  .option('--yes', 'Skip cost confirmation prompt')
  .option('--api-key <key>', 'API key for the chosen provider (overrides env vars)')
  .option('--provider <name>', 'LLM provider: anthropic | gemini | openrouter')
  .action(async (repoPath: string, opts: { yes?: boolean; apiKey?: string; provider?: string }) => {
    const resolved = path.resolve(repoPath);
    const structxDir = getStructXDir(resolved);
    const dbPath = getDbPath(structxDir);

    if (!fs.existsSync(dbPath)) {
      console.log('StructX not initialized. Run "structx init" first.');
      return;
    }

    const config = loadConfig(structxDir);
    if (isKnownProvider(opts.provider)) {
      config.provider = opts.provider;
    }
    if (opts.apiKey) config.anthropicApiKey = opts.apiKey;
    if (!config.anthropicApiKey) {
      console.log(`ERROR: API key not set for provider '${config.provider}'.`);
      console.log('Fix: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY, pass --api-key <key>, or add to .structx/config.json');
      return;
    }

    const db = openDatabase(dbPath);
    let pendingCount = getPendingAnalysisCount(db);
    if (pendingCount === 0) {
      const enqueued = enqueueUnanalyzedFunctions(db);
      if (enqueued > 0) {
        console.log(`Queued ${enqueued} unanalyzed function(s).`);
        pendingCount = getPendingAnalysisCount(db);
      }
    }

    if (pendingCount === 0) {
      console.log('No functions pending analysis. Run "structx ingest" first if files were recently added.');
      db.close();
      return;
    }

    // Show cost estimate
    const estimate = estimateAnalysisCost(pendingCount, config.batchSize, config.analysisModel);
    console.log('\n' + formatCostEstimate(estimate));

    if (!opts.yes) {
      const readline = await import('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>(resolve => {
        rl.question('\nProceed? [y/N] ', resolve);
      });
      rl.close();
      if (answer.toLowerCase() !== 'y') {
        console.log('Aborted.');
        db.close();
        return;
      }
    }

    console.log('\nAnalyzing...');

    let totalAnalyzed = 0;
    let totalCached = 0;
    let totalFailed = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    let batchNum = 0;
    let abortReason: string | undefined;

    while (true) {
      const pending = getPendingAnalysis(db, config.batchSize);
      if (pending.length === 0) break;

      batchNum++;
      const items = pending.map(p => ({ id: p.id, function_id: p.function_id }));

      console.log(`  Batch ${batchNum}: ${items.length} functions...`);
      const batchResult = await analyzeBatch(db, items, config.analysisModel, getLlmConfig(config));

      totalAnalyzed += batchResult.analyzed;
      totalCached += batchResult.cached;
      totalFailed += batchResult.failed;
      totalInputTokens += batchResult.totalInputTokens;
      totalOutputTokens += batchResult.totalOutputTokens;
      totalCost += batchResult.totalCost;

      // Stop on a fatal provider error (402 out of credits, 401 bad key).
      // `setup` has always done this; `analyze` dropped the flag and kept
      // hammering a failing endpoint, reporting a large "Failed: N" with no
      // reason. Items stay queued and re-run once the issue is fixed.
      if (batchResult.aborted) {
        abortReason = batchResult.abortReason;
        break;
      }
    }

    // Analyze types, routes, and file summaries — skipped entirely when the
    // function loop already hit a fatal provider error.
    const empty = { analyzed: 0, cached: 0, failed: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 };
    if (!abortReason) console.log('\n  Analyzing types, routes, and file summaries...');
    const typeResult = abortReason ? empty : await analyzeTypes(db, config.analysisModel, getLlmConfig(config));
    const routeResult = abortReason || (typeResult as any).aborted
      ? empty : await analyzeRoutes(db, config.analysisModel, getLlmConfig(config));
    const fileResult = abortReason || (typeResult as any).aborted || (routeResult as any).aborted
      ? empty : await analyzeFileSummaries(db, config.analysisModel, getLlmConfig(config));
    abortReason ??= (typeResult as any).abortReason ?? (routeResult as any).abortReason ?? (fileResult as any).abortReason;

    totalAnalyzed += typeResult.analyzed + routeResult.analyzed + fileResult.analyzed;
    totalFailed += typeResult.failed + routeResult.failed + fileResult.failed;
    totalInputTokens += typeResult.totalInputTokens + routeResult.totalInputTokens + fileResult.totalInputTokens;
    totalOutputTokens += typeResult.totalOutputTokens + routeResult.totalOutputTokens + fileResult.totalOutputTokens;
    totalCost += typeResult.totalCost + routeResult.totalCost + fileResult.totalCost;

    // Rebuild FTS index
    rebuildSearchIndex(db);
    db.close();

    console.log(`\nAnalysis complete:`);
    console.log(`  Analyzed:       ${totalAnalyzed} (incl. ${typeResult.analyzed} types, ${routeResult.analyzed} routes, ${fileResult.analyzed} files)`);
    console.log(`  From cache:     ${totalCached}`);
    console.log(`  Failed:         ${totalFailed}`);
    console.log(`  Input tokens:   ${totalInputTokens.toLocaleString()}`);
    console.log(`  Output tokens:  ${totalOutputTokens.toLocaleString()}`);
    console.log(`  Total cost:     $${totalCost.toFixed(4)}`);
    if (abortReason) {
      console.log(`\nAborted: ${abortReason}`);
      console.log(`Failed items remain queued — re-run \`structx analyze .\` after fixing the issue.`);
    }
  });

// ── ask ──
program
  .command('ask')
  .description('Ask a question about the codebase')
  .argument('<question>', 'The question to ask')
  .option('--repo <path>', 'Path to TypeScript repository', '.')
  .option('--api-key <key>', 'API key for the chosen provider (overrides env vars)')
  .option('--provider <name>', 'LLM provider: anthropic | gemini | openrouter')
  .option('--max-tokens <n>', 'Maximum answer output tokens for this ask (64-8192)', parseMaxTokens)
  .action(async (question: string, opts: { repo: string; apiKey?: string; provider?: string; maxTokens?: number }) => {
    const resolved = path.resolve(opts.repo);
    const structxDir = getStructXDir(resolved);
    const dbPath = getDbPath(structxDir);

    // Auto-setup: if DB doesn't exist, run full setup automatically
    if (!fs.existsSync(dbPath)) {
      console.log('StructX not initialized. Running automatic setup...\n');
      const db = initializeDatabase(dbPath);
      const initial: any = { repoPath: resolved };
      if (isKnownProvider(opts.provider)) {
        initial.provider = opts.provider;
      }
      saveConfig(structxDir, initial);
      ensureStructxGitignored(resolved);
      const config = loadConfig(structxDir);
      if (isKnownProvider(opts.provider)) {
        config.provider = opts.provider;
      }
      if (opts.apiKey) config.anthropicApiKey = opts.apiKey;
      const result = ingestDirectory(db, resolved, config.diffThreshold, { typeResolution: config.typeResolution });
      printIngestResult(result);

      // Run semantic analysis if API key available
      if (config.anthropicApiKey) {
        console.log('\nRunning semantic analysis...');
        const pending = getPendingAnalysis(db, config.batchSize);
        if (pending.length > 0) {
          let batchNum = 0;
          while (true) {
            const items = getPendingAnalysis(db, config.batchSize);
            if (items.length === 0) break;
            batchNum++;
            console.log(`  Batch ${batchNum}: ${items.length} functions...`);
            await analyzeBatch(db, items.map(p => ({ id: p.id, function_id: p.function_id })), config.analysisModel, getLlmConfig(config));
          }
          await analyzeTypes(db, config.analysisModel, getLlmConfig(config));
          await analyzeRoutes(db, config.analysisModel, getLlmConfig(config));
          await analyzeFileSummaries(db, config.analysisModel, getLlmConfig(config));
          rebuildSearchIndex(db);
        }
        console.log('Setup complete. Now answering your question...\n');
      } else {
        console.log('\nWARNING: ANTHROPIC_API_KEY not set. Semantic analysis skipped.');
        console.log('Results will be limited. Set the key and run "structx analyze . --yes" for better answers.\n');
      }
      db.close();
    }

    const config = loadConfig(structxDir);
    if (isKnownProvider(opts.provider)) {
      config.provider = opts.provider;
    }
    if (opts.apiKey) config.anthropicApiKey = opts.apiKey;
    const answerMaxTokens = opts.maxTokens ?? config.answerMaxTokens;
    if (!config.anthropicApiKey) {
      console.log(`ERROR: API key not set for provider '${config.provider}'.`);
      console.log('Fix one of:');
      console.log('  1. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY environment variable');
      console.log('  2. Pass --api-key <key> to this command');
      console.log('  3. Add "anthropicApiKey" to .structx/config.json');
      console.log('\nNote: "structx overview --repo ." works without an API key to see the codebase structure.');
      return;
    }

    const db = openDatabase(dbPath);

    // Check if DB is empty — suggest re-ingesting
    const stats = getStats(db);
    if (stats.totalFunctions === 0 && stats.totalTypes === 0 && stats.totalRoutes === 0) {
      console.log('WARNING: The knowledge graph is empty (0 functions, 0 types, 0 routes).');
      console.log('Running automatic re-ingestion...\n');
      const result = ingestDirectory(db, resolved, config.diffThreshold, { typeResolution: config.typeResolution });
      printIngestResult(result);
      if (result.queued > 0) {
        console.log('\nRunning semantic analysis...');
        while (true) {
          const items = getPendingAnalysis(db, config.batchSize);
          if (items.length === 0) break;
          await analyzeBatch(db, items.map(p => ({ id: p.id, function_id: p.function_id })), config.analysisModel, getLlmConfig(config));
        }
        await analyzeTypes(db, config.analysisModel, getLlmConfig(config));
        await analyzeRoutes(db, config.analysisModel, getLlmConfig(config));
        await analyzeFileSummaries(db, config.analysisModel, getLlmConfig(config));
        rebuildSearchIndex(db);
      }
      console.log('');
    }

    // Warn if semantic analysis hasn't been done
    if (stats.totalFunctions > 0 && stats.analyzedFunctions === 0) {
      console.log('WARNING: No functions have been semantically analyzed. Results may be limited.');
      console.log('Run "structx analyze . --yes" to enrich the knowledge graph.\n');
    }

    const startTime = Date.now();

    // Cache check: include the graph fingerprint so changed code or updated
    // semantic metadata cannot return a stale answer for the same question.
    const graphHash = getGraphFingerprint(db);
    const questionHash = makeAskCacheKey(question, config.answerModel, graphHash, answerMaxTokens);
    const cached = getCachedAskResponse(db, questionHash);
    if (cached) {
      const entityCount = 0;
      console.log('─'.repeat(60));
      console.log(cached.answer_text);
      console.log('─'.repeat(60));
      console.log(`\nStrategy: ${cached.strategy} | Entities: ${entityCount} | Graph query: 0ms (cached)`);
      console.log(`Tokens: ${cached.input_tokens ?? 0} in / ${cached.output_tokens ?? 0} out | Cost: $0.0000 (cached) | Time: ${Date.now() - startTime}ms`);
      db.close();
      return;
    }

    // Step 1: Classify the question
    console.log('Classifying question...');
    let classificationResult: Awaited<ReturnType<typeof classifyQuestionWithUsage>>;
    try {
      classificationResult = await classifyQuestionWithUsage(question, config.classifierModel, getLlmConfig(config));
    } catch (err: any) {
      console.log(`ERROR: Question classification failed: ${formatProviderError(err)}`);
      db.close();
      return;
    }
    const classification = classificationResult.classification;
    logger.debug('Classification', classification as any);

    // Step 2: Retrieve context
    console.log(`Retrieving context (strategy: ${classification.strategy})...`);
    const graphQueryStart = Date.now();
    let retrieved;

    switch (classification.strategy) {
      case 'direct':
        retrieved = directLookupExpanded(db, classification.functionName || '');
        break;
      case 'relationship':
        retrieved = relationshipQuery(
          db,
          classification.functionName || '',
          classification.direction || 'callers'
        );
        break;
      case 'semantic':
        retrieved = semanticSearch(db, classification.keywords);
        break;
      case 'domain':
        retrieved = domainQuery(db, classification.domain || 'other');
        break;
      case 'impact':
        retrieved = impactAnalysis(db, classification.functionName || '');
        break;
      case 'route':
        retrieved = classification.routePath || classification.keywords.length === 0
          ? routeQuery(db, classification.routePath, classification.routeMethod)
          : routeKeywordQuery(db, classification.keywords, classification.routeMethod);
        break;
      case 'type':
        retrieved = typeQuery(db, classification.typeName || classification.keywords.join(' '));
        break;
      case 'file':
        retrieved = fileQuery(db, classification.filePath);
        break;
      case 'list':
        retrieved = listQuery(db, classification.listEntity);
        break;
      case 'pattern':
        retrieved = patternQuery(db, classification.keywords);
        break;
      default:
        retrieved = semanticSearch(db, classification.keywords);
    }

    const graphQueryTimeMs = Date.now() - graphQueryStart;

    // Step 3: Build context
    const context = buildContext(retrieved, question);

    // Step 4: Generate answer
    console.log('Generating answer...\n');
    let answerResult: Awaited<ReturnType<typeof generateAnswer>>;
    try {
      answerResult = await generateAnswer(question, context, config.answerModel, getLlmConfig(config), answerMaxTokens);
    } catch (err: any) {
      console.log(`ERROR: Answer generation failed: ${formatProviderError(err)}`);
      console.log('Graph retrieval completed; graph-only commands and MCP graph tools still work without LLM credits.');
      db.close();
      return;
    }
    const totalInputTokens = classificationResult.inputTokens + answerResult.inputTokens;
    const totalOutputTokens = classificationResult.outputTokens + answerResult.outputTokens;
    const totalCost = classificationResult.cost + answerResult.cost;

    // Display answer
    const entityCount = retrieved.functions.length + retrieved.types.length +
      retrieved.routes.length + retrieved.files.length + retrieved.constants.length;
    console.log('─'.repeat(60));
    console.log(answerResult.answer);
    console.log('─'.repeat(60));
    console.log(`\nStrategy: ${classification.strategy} | Entities: ${entityCount} | Graph query: ${graphQueryTimeMs}ms`);
    console.log(`Tokens: ${totalInputTokens} in / ${totalOutputTokens} out | Cost: $${totalCost.toFixed(4)} | Time: ${answerResult.responseTimeMs}ms`);
    if (classificationResult.usedLlm) {
      console.log(`  Classifier: ${classificationResult.inputTokens} in / ${classificationResult.outputTokens} out | Answer: ${answerResult.inputTokens} in / ${answerResult.outputTokens} out`);
    }

    // Store in ask cache so identical questions return instantly next time
    insertCachedAskResponse(
      db, questionHash, classification.strategy, answerResult.answer,
      config.answerModel, totalInputTokens, totalOutputTokens, totalCost,
    );

    // Save run to DB
    insertQaRun(db, {
      mode: 'structx',
      question,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      total_tokens: totalInputTokens + totalOutputTokens,
      cost_usd: totalCost,
      response_time_ms: answerResult.responseTimeMs,
      files_accessed: null,
      functions_retrieved: retrieved.functions.length,
      graph_query_time_ms: graphQueryTimeMs,
      answer_text: answerResult.answer,
    });

    db.close();
  });

// ── benchmark (placeholder) ──
const benchmarkCmd = program
  .command('benchmark')
  .description('Run and view benchmark comparisons');

benchmarkCmd
  .command('run')
  .description('Run comparison benchmark')
  .option('--repo <path>', 'Path to TypeScript repository', '.')
  .action(async (opts: { repo: string }) => {
    const resolved = path.resolve(opts.repo);
    const structxDir = getStructXDir(resolved);
    const dbPath = getDbPath(structxDir);

    if (!fs.existsSync(dbPath)) {
      console.log('StructX not initialized. Run "structx init" first.');
      return;
    }

    const config = loadConfig(structxDir);
    if (!config.anthropicApiKey) {
      console.log('Anthropic API key not set.');
      return;
    }

    const db = openDatabase(dbPath);

    console.log('Starting benchmark...');
    console.log('Running 8 questions in both StructX and Traditional modes.\n');

    const results = await runBenchmark(db, config);

    // Generate and save reports
    const markdown = generateMarkdownReport(results);
    const csv = generateCsvReport(results);
    const { markdownPath, csvPath } = saveReport(structxDir, markdown, csv);

    console.log(`\nReports saved:`);
    console.log(`  Markdown: ${markdownPath}`);
    console.log(`  CSV:      ${csvPath}`);

    db.close();
  });

benchmarkCmd
  .command('report')
  .description('Show latest benchmark report')
  .option('--repo <path>', 'Path to TypeScript repository', '.')
  .action((opts: { repo: string }) => {
    const resolved = path.resolve(opts.repo);
    const structxDir = getStructXDir(resolved);
    const reportsDir = path.join(structxDir, 'reports');

    if (!fs.existsSync(reportsDir)) {
      console.log('No benchmark reports found. Run "structx benchmark run" first.');
      return;
    }

    // Find latest markdown report
    const files = fs.readdirSync(reportsDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();

    if (files.length === 0) {
      console.log('No benchmark reports found. Run "structx benchmark run" first.');
      return;
    }

    const latestReport = fs.readFileSync(path.join(reportsDir, files[0]), 'utf-8');
    console.log(latestReport);
  });

program.parse();
