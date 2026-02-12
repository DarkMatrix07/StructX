import { Project, SourceFile, SyntaxKind, Node, FunctionDeclaration, ArrowFunction, MethodDeclaration, VariableDeclaration } from 'ts-morph';
import * as crypto from 'crypto';
import { extractTypes, type ExtractedType } from './type-extractor';
import { extractRoutes, type ExtractedRoute } from './route-extractor';
import { extractConstants, type ExtractedConstant } from './constant-extractor';
import { extractFileMetadata, type ExtractedFileMetadata } from './file-metadata';

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
  return new Project({
    tsConfigFilePath: undefined,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: true,
      jsx: 2, // React
    },
  });
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

export function parseFileComplete(project: Project, filePath: string): ParseFileCompleteResult {
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

  // Extract new entity types
  const types = extractTypes(sourceFile);
  const routes = extractRoutes(sourceFile);
  const constants = extractConstants(sourceFile);
  const fileMetadata = extractFileMetadata(sourceFile, functions.length, types.length, routes.length);

  // Remove the source file from project to prevent memory bloat
  project.removeSourceFile(sourceFile);

  return { functions, types, routes, constants, fileMetadata };
}

export function hashFileContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
