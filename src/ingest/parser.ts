import { Project, SourceFile, SyntaxKind, Node, FunctionDeclaration, ArrowFunction, MethodDeclaration, VariableDeclaration } from 'ts-morph';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { extractTypes, type ExtractedType } from './type-extractor';
import { extractRoutes, findInlineRouteHandlers, type ExtractedRoute } from './route-extractor';
import { extractConstants, type ExtractedConstant } from './constant-extractor';
import { extractFileMetadata, type ExtractedFileMetadata } from './file-metadata';
import { logger } from '../utils/logger';

export interface ExtractedFunction {
  name: string;
  signature: string;
  body: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  isAsync: boolean;
  codeHash: string;
}

export function createProject(repoPath: string): Project {
  // Discover the most useful tsconfig in the repo. With its `paths` and
  // `baseUrl`, ts-morph's TypeChecker can resolve cross-package imports
  // like `import { RouteKey } from 'src/enum'` (immich-style) — which
  // means decorator-arg enum members resolve to their literal values
  // (`'assets'`) instead of falling back to the property-name heuristic
  // (`'asset'`). The discovery happens once at project creation; we
  // don't re-detect per-file.
  const discovered = discoverTsconfig(repoPath);
  const compilerOptions = {
    allowJs: true,
    jsx: 2, // React
    ...(discovered?.paths ? { paths: discovered.paths } : {}),
    ...(discovered?.baseUrl ? { baseUrl: discovered.baseUrl } : {}),
  };
  if (discovered) {
    logger.debug(`Using tsconfig from ${discovered.tsconfigPath} (baseUrl: ${discovered.baseUrl ?? 'unset'})`);
  }
  return new Project({
    tsConfigFilePath: undefined,
    skipAddingFilesFromTsConfig: true,
    compilerOptions,
  });
}

interface DiscoveredTsconfig {
  tsconfigPath: string;
  baseUrl?: string;          // resolved to absolute path
  paths?: Record<string, string[]>;
}

// Walk the repo for a useful tsconfig.json. Strategy:
//   1. If <repoRoot>/tsconfig.json exists, use it.
//   2. Otherwise look at common workspace-root subdirs (server/, app/,
//      packages/<single>/) — pick the one with the most TS files under it.
//   3. Skip if no tsconfig found anywhere reasonable.
//
// We resolve relative `baseUrl` to an absolute path so ts-morph's path
// matcher doesn't get confused by repoPath-vs-cwd differences.
function discoverTsconfig(repoPath: string): DiscoveredTsconfig | null {
  // Pass 1: root tsconfig
  const rootTs = path.join(repoPath, 'tsconfig.json');
  if (fs.existsSync(rootTs)) {
    return readTsconfig(rootTs);
  }

  // Pass 2: walk the immediate subdirs and look for tsconfig.json one
  // level deep. Common conventions: server/, app/, src/, packages/<X>/.
  const candidates: Array<{ tsconfigPath: string; tsFiles: number }> = [];
  const skipDirs = new Set(['node_modules', '.git', '.structx', '.claude']);

  let firstLevel: string[] = [];
  try {
    firstLevel = fs.readdirSync(repoPath);
  } catch {
    return null;
  }
  for (const entry of firstLevel) {
    if (skipDirs.has(entry)) continue;
    const full = path.join(repoPath, entry);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;

    // Direct tsconfig.json inside this subdir.
    const directTs = path.join(full, 'tsconfig.json');
    if (fs.existsSync(directTs)) {
      candidates.push({ tsconfigPath: directTs, tsFiles: countTsFiles(full) });
      continue;
    }
    // Workspace pattern: packages/<package>/tsconfig.json — peek one deeper.
    if (entry === 'packages' || entry === 'apps' || entry === 'libs') {
      let inner: string[] = [];
      try { inner = fs.readdirSync(full); } catch {}
      for (const sub of inner) {
        const subTs = path.join(full, sub, 'tsconfig.json');
        if (fs.existsSync(subTs)) {
          candidates.push({ tsconfigPath: subTs, tsFiles: countTsFiles(path.join(full, sub)) });
        }
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.tsFiles - a.tsFiles);
  return readTsconfig(candidates[0].tsconfigPath);
}

function countTsFiles(dir: string): number {
  let n = 0;
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);
  function walk(d: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skipDirs.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.isFile() && /\.(ts|tsx|js|jsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) n++;
    }
  }
  walk(dir);
  return n;
}

// Parse just enough of a tsconfig to extract paths + baseUrl. We don't
// pull in the whole TS compiler API — `JSON.parse` plus a few extends
// follows handles every real-world case we've seen. JSONC comments are
// tolerated via a simple stripping pass.
function readTsconfig(tsconfigPath: string, depth = 0): DiscoveredTsconfig | null {
  if (depth > 5) return null; // extends loops / very deep chains
  let text: string;
  try { text = fs.readFileSync(tsconfigPath, 'utf-8'); } catch { return null; }

  // Strip JSONC comments + trailing commas — common in tsconfig files.
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');
  text = text.replace(/(^|[^:])\/\/.*$/gm, '$1');
  text = text.replace(/,(\s*[}\]])/g, '$1');

  let parsed: any;
  try { parsed = JSON.parse(text); } catch (err) {
    logger.debug(`Failed to parse ${tsconfigPath}: ${(err as Error).message}`);
    return null;
  }

  const tsconfigDir = path.dirname(tsconfigPath);
  let baseUrl: string | undefined;
  let paths: Record<string, string[]> | undefined;
  let extendsConfig: DiscoveredTsconfig | null = null;

  if (typeof parsed.extends === 'string') {
    const extendedPath = path.isAbsolute(parsed.extends)
      ? parsed.extends
      : path.resolve(tsconfigDir, parsed.extends.endsWith('.json') ? parsed.extends : parsed.extends + '.json');
    if (fs.existsSync(extendedPath)) {
      extendsConfig = readTsconfig(extendedPath, depth + 1);
    }
  }

  const co = parsed.compilerOptions ?? {};
  if (typeof co.baseUrl === 'string') {
    baseUrl = path.resolve(tsconfigDir, co.baseUrl);
  } else if (extendsConfig?.baseUrl) {
    baseUrl = extendsConfig.baseUrl;
  }
  if (co.paths && typeof co.paths === 'object') {
    paths = co.paths as Record<string, string[]>;
  } else if (extendsConfig?.paths) {
    paths = extendsConfig.paths;
  }

  return { tsconfigPath, baseUrl, paths };
}

export function parseFile(project: Project, filePath: string): ExtractedFunction[] {
  const sourceFile = project.addSourceFileAtPath(filePath);
  const functions: ExtractedFunction[] = [];

  // Extract top-level function declarations
  for (const fn of sourceFile.getFunctions()) {
    const extracted = extractFunctionDeclaration(fn);
    if (extracted) functions.push(extracted);
  }

  // Extract arrow functions assigned to variables
  for (const varStmt of sourceFile.getVariableStatements()) {
    for (const decl of varStmt.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (initializer && Node.isArrowFunction(initializer)) {
        const extracted = extractArrowFunction(decl, initializer, varStmt.isExported());
        if (extracted) functions.push(extracted);
      }
      // Also handle function expressions: const foo = function() {}
      if (initializer && Node.isFunctionExpression(initializer)) {
        const extracted = extractArrowFunction(decl, initializer as any, varStmt.isExported());
        if (extracted) functions.push(extracted);
      }
    }
  }

  // Extract class methods
  for (const cls of sourceFile.getClasses()) {
    const className = cls.getName() || 'AnonymousClass';
    for (const method of cls.getMethods()) {
      const extracted = extractMethodDeclaration(method, className);
      if (extracted) functions.push(extracted);
    }
  }

  // Remove the source file from project to prevent memory bloat
  project.removeSourceFile(sourceFile);

  return functions;
}

// CommonJS exports: `exports.foo = function () {}`, `module.exports.foo = () => {}`,
// and `module.exports = function foo() {}`. These are the dominant way older
// JavaScript codebases declare their public functions — Express, for example,
// yielded 11 functions from 141 files before this, because none of its
// `exports.x = function` declarations matched any extractor. `.js` has always
// been in TS_EXTENSIONS, so the support was implied but not real.
function extractCommonJsExports(sourceFile: SourceFile): ExtractedFunction[] {
  const functions: ExtractedFunction[] = [];

  for (const statement of sourceFile.getStatements()) {
    if (!Node.isExpressionStatement(statement)) continue;
    const expression = statement.getExpression();
    if (!Node.isBinaryExpression(expression)) continue;
    if (expression.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;

    const left = expression.getLeft();
    if (!Node.isPropertyAccessExpression(left)) continue;

    // Accept `exports.foo` and `module.exports.foo`; skip deeper paths.
    const receiver = left.getExpression().getText();
    if (receiver !== 'exports' && receiver !== 'module.exports') continue;

    const right = expression.getRight();
    if (!Node.isArrowFunction(right) && !Node.isFunctionExpression(right)) continue;

    const name = left.getName();
    const params = right.getParameters().map(p => p.getText()).join(', ');
    const body = statement.getFullText();

    functions.push({
      name,
      signature: `${receiver}.${name} = (${params}) => unknown`,
      body,
      startLine: statement.getStartLineNumber(),
      endLine: statement.getEndLineNumber(),
      isExported: true,
      isAsync: right.isAsync(),
      codeHash: hashCode(body),
    });
  }

  return functions;
}

function extractFunctionDeclaration(fn: FunctionDeclaration): ExtractedFunction | null {
  const name = fn.getName();
  if (!name) return null; // Skip anonymous functions

  const body = fn.getFullText();
  const signature = buildSignature(fn);

  return {
    name,
    signature,
    body,
    startLine: fn.getStartLineNumber(),
    endLine: fn.getEndLineNumber(),
    isExported: fn.isExported(),
    isAsync: fn.isAsync(),
    codeHash: hashCode(body),
  };
}

function extractArrowFunction(
  decl: VariableDeclaration,
  arrow: ArrowFunction,
  isExported: boolean
): ExtractedFunction | null {
  const name = decl.getName();
  if (!name) return null;

  const body = decl.getFullText();
  const params = arrow.getParameters().map(p => p.getText()).join(', ');
  const returnType = arrow.getReturnType()?.getText() ?? 'unknown';

  return {
    name,
    signature: `const ${name} = (${params}) => ${returnType}`,
    body,
    startLine: decl.getStartLineNumber(),
    endLine: decl.getEndLineNumber(),
    isExported,
    isAsync: arrow.isAsync(),
    codeHash: hashCode(body),
  };
}

function extractMethodDeclaration(method: MethodDeclaration, className: string): ExtractedFunction | null {
  const name = method.getName();
  const body = method.getFullText();
  const params = method.getParameters().map(p => p.getText()).join(', ');
  const returnType = method.getReturnType()?.getText() ?? 'unknown';

  return {
    name: `${className}.${name}`,
    signature: `${className}.${name}(${params}): ${returnType}`,
    body,
    startLine: method.getStartLineNumber(),
    endLine: method.getEndLineNumber(),
    isExported: true, // Class methods accessible if class is exported
    isAsync: method.isAsync(),
    codeHash: hashCode(body),
  };
}

function buildSignature(fn: FunctionDeclaration): string {
  const name = fn.getName() || 'anonymous';
  const params = fn.getParameters().map(p => p.getText()).join(', ');
  const returnType = fn.getReturnType()?.getText() ?? 'unknown';
  const asyncPrefix = fn.isAsync() ? 'async ' : '';
  return `${asyncPrefix}function ${name}(${params}): ${returnType}`;
}

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export interface ParseFileCompleteResult {
  functions: ExtractedFunction[];
  types: ExtractedType[];
  routes: ExtractedRoute[];
  constants: ExtractedConstant[];
  fileMetadata: ExtractedFileMetadata;
}

// Parse a file that is already loaded into the project. Splitting this from
// `parseFileComplete` lets the ingester add a source file once and hand the
// same AST to both the entity extractor and the relationship extractor —
// previously every file was read and parsed from disk twice per ingest, which
// measured as roughly 80% of the wall time on a 3,763-file monorepo.
export function parseSourceFile(sourceFile: SourceFile): ParseFileCompleteResult {
  const functions: ExtractedFunction[] = [];

  // Extract top-level function declarations
  for (const fn of sourceFile.getFunctions()) {
    const extracted = extractFunctionDeclaration(fn);
    if (extracted) functions.push(extracted);
  }

  // Extract arrow functions assigned to variables
  for (const varStmt of sourceFile.getVariableStatements()) {
    for (const decl of varStmt.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (initializer && Node.isArrowFunction(initializer)) {
        const extracted = extractArrowFunction(decl, initializer, varStmt.isExported());
        if (extracted) functions.push(extracted);
      }
      if (initializer && Node.isFunctionExpression(initializer)) {
        const extracted = extractArrowFunction(decl, initializer as any, varStmt.isExported());
        if (extracted) functions.push(extracted);
      }
    }
  }

  // Extract class methods
  for (const cls of sourceFile.getClasses()) {
    const className = cls.getName() || 'AnonymousClass';
    for (const method of cls.getMethods()) {
      const extracted = extractMethodDeclaration(method, className);
      if (extracted) functions.push(extracted);
    }
  }

  // CommonJS `exports.foo = function` declarations (JavaScript codebases).
  functions.push(...extractCommonJsExports(sourceFile));

  // Inline route handlers — `router.get('/x', async (req, res) => {...})`.
  // Surfaced as functions named `GET /x` so the route can link to them and
  // their calls become real edges. `isExported` is true because they are
  // reachable entry points, even though no `export` keyword appears.
  for (const handler of findInlineRouteHandlers(sourceFile)) {
    const body = handler.node.getFullText();
    functions.push({
      name: handler.name,
      signature: `${handler.name} (${handler.params})`,
      body,
      startLine: handler.startLine,
      endLine: handler.endLine,
      isExported: true,
      isAsync: handler.isAsync,
      codeHash: hashCode(body),
    });
  }

  // Extract new entity types
  const types = extractTypes(sourceFile);
  const routes = extractRoutes(sourceFile);
  const constants = extractConstants(sourceFile);
  const fileMetadata = extractFileMetadata(sourceFile, functions.length, types.length, routes.length);

  return { functions, types, routes, constants, fileMetadata };
}

// Path-based entry point: adds the file, parses it, and drops it again.
// Retained for callers that only need entities (tests, one-off tooling); the
// ingester uses `parseSourceFile` so it can share one AST across extractors.
export function parseFileComplete(project: Project, filePath: string): ParseFileCompleteResult {
  const sourceFile = project.addSourceFileAtPath(filePath);
  try {
    return parseSourceFile(sourceFile);
  } finally {
    project.removeSourceFile(sourceFile);
  }
}

export function hashFileContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
