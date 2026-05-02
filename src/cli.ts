#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { getStructXDir, loadConfig, saveConfig, ensureStructxGitignored, getLlmConfig } from './config';
import { initializeDatabase, openDatabase, getDbPath } from './db/connection';
import { getStats, getFullOverview } from './db/queries';
import { logger, setLogLevel } from './utils/logger';
import { analyzeBatch, rebuildSearchIndex, analyzeTypes, analyzeRoutes, analyzeFileSummaries } from './semantic/analyzer';
import { estimateAnalysisCost, formatCostEstimate } from './semantic/cost';
import { getPendingAnalysis, getPendingAnalysisCount, insertQaRun, getCachedAskResponse, insertCachedAskResponse } from './db/queries';
import { classifyQuestion } from './query/classifier';
import { directLookup, relationshipQuery, semanticSearch, domainQuery, impactAnalysis, routeQuery, typeQuery, fileQuery, listQuery, patternQuery } from './query/retriever';
import { buildContext } from './query/context-builder';
import { generateAnswer } from './query/answerer';
import { runBenchmark } from './benchmark/runner';
import { generateMarkdownReport, generateCsvReport, saveReport } from './benchmark/reporter';
import { ingestDirectory, printIngestResult } from './ingest/ingester';

const program = new Command();

program
  .name('structx')
  .description('Graph-powered code intelligence CLI for TypeScript')
  .version('2.2.1')
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
  .option('--provider <name>', 'LLM provider: anthropic | openrouter', undefined)
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
      if (opts.provider === 'anthropic' || opts.provider === 'openrouter') {
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
    if (opts.provider === 'anthropic' || opts.provider === 'openrouter') {
      config.provider = opts.provider;
    }
    if (opts.apiKey) config.anthropicApiKey = opts.apiKey;
    const db = openDatabase(dbPath);

    console.log(`\nScanning ${resolved} for TypeScript files...`);
    const ingestResult = ingestDirectory(db, resolved, config.diffThreshold);
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
      }

      // Analyze types, routes, and file summaries
      console.log('\n  Analyzing types, routes, and file summaries...');
      const typeResult = await analyzeTypes(db, config.analysisModel, getLlmConfig(config));
      const routeResult = await analyzeRoutes(db, config.analysisModel, getLlmConfig(config));
      const fileResult = await analyzeFileSummaries(db, config.analysisModel, getLlmConfig(config));

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
        console.log('  [OK] Anthropic API key is set');
      } else {
        console.log('  [WARN] Anthropic API key not set (set ANTHROPIC_API_KEY env var or add to config)');
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
    const ingestResult = ingestDirectory(db, resolved, config.diffThreshold);
    printIngestResult(ingestResult);

    db.close();

    if (ingestResult.queued > 0) {
      console.log(`\nNext: run 'structx analyze' to enrich functions with semantic metadata.`);
    }
  });

// ── analyze ──
program
  .command('analyze')
  .description('Run LLM semantic analysis on extracted functions')
  .argument('[repo-path]', 'Path to TypeScript repository', '.')
  .option('--yes', 'Skip cost confirmation prompt')
  .option('--api-key <key>', 'API key for the chosen provider (overrides env vars)')
  .option('--provider <name>', 'LLM provider: anthropic | openrouter')
  .action(async (repoPath: string, opts: { yes?: boolean; apiKey?: string; provider?: string }) => {
    const resolved = path.resolve(repoPath);
    const structxDir = getStructXDir(resolved);
    const dbPath = getDbPath(structxDir);

    if (!fs.existsSync(dbPath)) {
      console.log('StructX not initialized. Run "structx init" first.');
      return;
    }

    const config = loadConfig(structxDir);
    if (opts.provider === 'anthropic' || opts.provider === 'openrouter') {
      config.provider = opts.provider;
    }
    if (opts.apiKey) config.anthropicApiKey = opts.apiKey;
    if (!config.anthropicApiKey) {
      console.log(`ERROR: API key not set for provider '${config.provider}'.`);
      console.log('Fix: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY, pass --api-key <key>, or add to .structx/config.json');
      return;
    }

    const db = openDatabase(dbPath);
    const pendingCount = getPendingAnalysisCount(db);

    if (pendingCount === 0) {
      console.log('No functions pending analysis. Run "structx ingest" first.');
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
    }

    // Analyze types, routes, and file summaries
    console.log('\n  Analyzing types, routes, and file summaries...');
    const typeResult = await analyzeTypes(db, config.analysisModel, getLlmConfig(config));
    const routeResult = await analyzeRoutes(db, config.analysisModel, getLlmConfig(config));
    const fileResult = await analyzeFileSummaries(db, config.analysisModel, getLlmConfig(config));

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
  });

// ── ask ──
program
  .command('ask')
  .description('Ask a question about the codebase')
  .argument('<question>', 'The question to ask')
  .option('--repo <path>', 'Path to TypeScript repository', '.')
  .option('--api-key <key>', 'API key for the chosen provider (overrides env vars)')
  .option('--provider <name>', 'LLM provider: anthropic | openrouter')
  .action(async (question: string, opts: { repo: string; apiKey?: string; provider?: string }) => {
    const resolved = path.resolve(opts.repo);
    const structxDir = getStructXDir(resolved);
    const dbPath = getDbPath(structxDir);

    // Auto-setup: if DB doesn't exist, run full setup automatically
    if (!fs.existsSync(dbPath)) {
      console.log('StructX not initialized. Running automatic setup...\n');
      const db = initializeDatabase(dbPath);
      const initial: any = { repoPath: resolved };
      if (opts.provider === 'anthropic' || opts.provider === 'openrouter') {
        initial.provider = opts.provider;
      }
      saveConfig(structxDir, initial);
      ensureStructxGitignored(resolved);
      const config = loadConfig(structxDir);
      if (opts.provider === 'anthropic' || opts.provider === 'openrouter') {
        config.provider = opts.provider;
      }
      if (opts.apiKey) config.anthropicApiKey = opts.apiKey;
      const result = ingestDirectory(db, resolved, config.diffThreshold);
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
    if (opts.provider === 'anthropic' || opts.provider === 'openrouter') {
      config.provider = opts.provider;
    }
    if (opts.apiKey) config.anthropicApiKey = opts.apiKey;
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
      const result = ingestDirectory(db, resolved, config.diffThreshold);
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

    // Cache check — keyed by SHA256(question.normalized + answerModel) so
    // identical questions with the same model return instantly.
    const questionHash = crypto
      .createHash('sha256')
      .update(`${question.toLowerCase().trim()}|${config.answerModel}`)
      .digest('hex');
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
    const classification = await classifyQuestion(question, config.classifierModel, getLlmConfig(config));
    logger.debug('Classification', classification as any);

    // Step 2: Retrieve context
    console.log(`Retrieving context (strategy: ${classification.strategy})...`);
    const graphQueryStart = Date.now();
    let retrieved;

    switch (classification.strategy) {
      case 'direct':
        retrieved = directLookup(db, classification.functionName || '');
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
        retrieved = routeQuery(db, classification.routePath, classification.routeMethod);
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
    const answerResult = await generateAnswer(question, context, config.answerModel, getLlmConfig(config));

    // Display answer
    const entityCount = retrieved.functions.length + retrieved.types.length +
      retrieved.routes.length + retrieved.files.length + retrieved.constants.length;
    console.log('─'.repeat(60));
    console.log(answerResult.answer);
    console.log('─'.repeat(60));
    console.log(`\nStrategy: ${classification.strategy} | Entities: ${entityCount} | Graph query: ${graphQueryTimeMs}ms`);
    console.log(`Tokens: ${answerResult.inputTokens} in / ${answerResult.outputTokens} out | Cost: $${answerResult.cost.toFixed(4)} | Time: ${answerResult.responseTimeMs}ms`);

    // Store in ask cache so identical questions return instantly next time
    insertCachedAskResponse(
      db, questionHash, classification.strategy, answerResult.answer,
      config.answerModel, answerResult.inputTokens, answerResult.outputTokens, answerResult.cost,
    );

    // Save run to DB
    insertQaRun(db, {
      mode: 'structx',
      question,
      input_tokens: answerResult.inputTokens,
      output_tokens: answerResult.outputTokens,
      total_tokens: answerResult.inputTokens + answerResult.outputTokens,
      cost_usd: answerResult.cost,
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
