import { Project, SyntaxKind, Node, CallExpression, SourceFile } from 'ts-morph';
import { findInlineRouteHandlers } from './route-extractor';

// Declaration site of a call target, resolved by the TypeScript type checker.
// `filePath` is absolute (ts-morph's form); the ingester converts it to a
// repo-relative path before persisting. `name` follows StructX's function
// naming convention so it can be matched against `functions.name` directly
// (`Class.method` for methods, bare identifier for everything else).
export interface ResolvedTarget {
  filePath: string;
  name: string;
}

export interface ExtractedCall {
  callerName: string;
  calleeName: string;
  relationType: 'calls' | 'imports';
  // Present only when the type checker resolved the call to a declaration in
  // repo source. Absent for external calls (node_modules, lib.d.ts) and for
  // anything the checker couldn't statically resolve.
  resolved?: ResolvedTarget;
}

export interface ExtractCallsOptions {
  // When false, skip type resolution entirely and fall back to pure syntactic
  // extraction. The checker is the expensive part of ingest, so callers
  // working against very large repos can trade edge precision for speed.
  typeResolution?: boolean;
}

// Path-based entry point. Retained for callers that only need relationships;
// the ingester uses `extractCallsFromSourceFile` to reuse the AST the entity
// parser already built.
export function extractCallsFromFile(
  project: Project,
  filePath: string,
  opts: ExtractCallsOptions = {},
): ExtractedCall[] {
  const sourceFile = project.addSourceFileAtPath(filePath);
  try {
    return extractCallsFromSourceFile(sourceFile, opts);
  } finally {
    project.removeSourceFile(sourceFile);
  }
}

export function extractCallsFromSourceFile(
  sourceFile: SourceFile,
  opts: ExtractCallsOptions = {},
): ExtractedCall[] {
  const useTypes = opts.typeResolution !== false;
  const calls: ExtractedCall[] = [];
  // Names that could possibly resolve to a declaration in repo source. The
  // type checker is by far the most expensive part of ingest, and most call
  // expressions in real code are external (`JSON.parse`, `.map`, `db.prepare`)
  // — invoking the checker on those is pure waste. Anything declared in repo
  // source has to reach this file through an import or a local declaration,
  // so gating on that set is sound rather than heuristic: it cannot discard a
  // call the checker would have resolved to repo code.
  const candidates = useTypes ? collectResolutionCandidates(sourceFile) : new Set<string>();

  // Inline route handlers own their calls. Collect them first and exclude
  // their subtrees from every other container, so a route registered inside
  // `registerRoutes(app)` attributes `getArticles` to the handler rather than
  // to `registerRoutes` — or worse, to both.
  const inlineHandlers = findInlineRouteHandlers(sourceFile);
  const handlerNodes = new Set<Node>(inlineHandlers.map(h => h.node as Node));
  for (const handler of inlineHandlers) {
    collectCalls(calls, handler.name, handler.node as Node, candidates);
  }

  // Extract calls from top-level functions
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    collectCalls(calls, name, fn, candidates, handlerNodes);
  }

  // Extract calls from arrow functions assigned to variables
  for (const varStmt of sourceFile.getVariableStatements()) {
    for (const decl of varStmt.getDeclarations()) {
      const name = decl.getName();
      const initializer = decl.getInitializer();
      if (!initializer || (!Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer))) continue;
      collectCalls(calls, name, initializer, candidates, handlerNodes);
    }
  }

  // Extract calls from class methods
  for (const cls of sourceFile.getClasses()) {
    const className = cls.getName() || 'AnonymousClass';
    for (const method of cls.getMethods()) {
      collectCalls(calls, `${className}.${method.getName()}`, method, candidates, handlerNodes);
    }
  }

  // Extract import relationships
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const namedImports = importDecl.getNamedImports();
    for (const named of namedImports) {
      calls.push({
        callerName: '__file__',
        calleeName: named.getName(),
        relationType: 'imports',
      });
    }
    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport) {
      calls.push({
        callerName: '__file__',
        calleeName: defaultImport.getText(),
        relationType: 'imports',
      });
    }
  }

  // Deduplicate. When the same (caller, callee) pair appears more than once —
  // e.g. `save()` called on three lines — keep the occurrence that carries a
  // resolved declaration, since that is the one that can bind precisely.
  const byKey = new Map<string, ExtractedCall>();
  for (const c of calls) {
    const key = `${c.callerName}|${c.calleeName}|${c.relationType}`;
    const existing = byKey.get(key);
    if (!existing || (!existing.resolved && c.resolved)) byKey.set(key, c);
  }
  return [...byKey.values()];
}

// Walk every call expression inside `container` and record an edge for each.
// `container` is the function/method/arrow node that owns the calls, so
// nested arrow callbacks are attributed to their enclosing named function —
// matching how the parser assigns bodies.
function collectCalls(
  calls: ExtractedCall[],
  callerName: string,
  container: Node,
  candidates: Set<string>,
  excluded?: Set<Node>,
): void {
  for (const call of container.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (isDecoratorInvocation(call)) continue;
    if (excluded && isInsideExcluded(call, container, excluded)) continue;
    const calleeName = extractCalleeName(call);
    if (!calleeName || calleeName === callerName) continue;
    const resolved = worthResolving(call, candidates) ? resolveCallTarget(call) : null;
    calls.push({
      callerName,
      calleeName,
      relationType: 'calls',
      ...(resolved ? { resolved } : {}),
    });
  }
}

// True when the call sits inside a nested container that owns its own edges
// (currently: inline route handlers). Walks up only as far as the enclosing
// container, so the cost is bounded by nesting depth.
function isInsideExcluded(call: Node, container: Node, excluded: Set<Node>): boolean {
  let current: Node | undefined = call.getParent();
  while (current && current !== container) {
    if (excluded.has(current)) return true;
    current = current.getParent();
  }
  return false;
}

// Decorator applications (`@Get(':id')`, `@Body() dto: CreateDto`) are call
// expressions syntactically, but recording them as call edges is misleading:
// they describe how a framework wires the function up, not what the function
// invokes. On NestJS this dominated the graph — `Body` looked like the most
// depended-on function in the repo, and "what breaks if I change Body" listed
// 58 endpoints. Routes are captured separately by the route extractor, so
// nothing is lost by skipping them here.
function isDecoratorInvocation(callExpr: CallExpression): boolean {
  const parent = callExpr.getParent();
  return parent?.getKind() === SyntaxKind.Decorator;
}

// Every name in this file that could lead to a declaration in repo source:
// anything imported (including aliases and namespaces) plus anything declared
// locally. A call target outside this set cannot resolve to repo code, so the
// checker has nothing to find and we skip it.
function collectResolutionCandidates(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();

  for (const importDecl of sourceFile.getImportDeclarations()) {
    for (const named of importDecl.getNamedImports()) {
      names.add(named.getName());
      const alias = named.getAliasNode()?.getText();
      if (alias) names.add(alias);
    }
    const defaultImport = importDecl.getDefaultImport()?.getText();
    if (defaultImport) names.add(defaultImport);
    const namespaceImport = importDecl.getNamespaceImport()?.getText();
    if (namespaceImport) names.add(namespaceImport);
  }

  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (name) names.add(name);
  }
  for (const varStmt of sourceFile.getVariableStatements()) {
    for (const decl of varStmt.getDeclarations()) names.add(decl.getName());
  }
  for (const cls of sourceFile.getClasses()) {
    const className = cls.getName();
    if (className) names.add(className);
    // Method names matter for `this.foo()` and `instance.foo()` dispatch.
    for (const method of cls.getMethods()) names.add(method.getName());
  }

  return names;
}

// Cheap pre-filter deciding whether the checker is worth invoking for a call.
function worthResolving(callExpr: CallExpression, candidates: Set<string>): boolean {
  if (candidates.size === 0) return false; // type resolution disabled
  const expression = callExpr.getExpression();

  if (Node.isIdentifier(expression)) return candidates.has(expression.getText());

  if (Node.isPropertyAccessExpression(expression)) {
    // `this.handle()` always deserves resolution — the declaration is in this
    // file or a base class, both of which are repo source.
    const receiver = expression.getExpression();
    if (receiver.getKind() === SyntaxKind.ThisKeyword) return true;
    if (candidates.has(expression.getName())) return true;
    const root = rootIdentifierName(receiver);
    return root ? candidates.has(root) : false;
  }

  return false;
}

// Left-most identifier of an expression chain: `a.b.c()` → "a".
function rootIdentifierName(node: Node): string | null {
  let current: Node | undefined = node;
  while (current) {
    if (Node.isIdentifier(current)) return current.getText();
    current = (current as any).getExpression?.() as Node | undefined;
  }
  return null;
}

// Ask the TypeScript type checker which declaration a call actually targets.
//
// This is what separates StructX from syntax-only graphs: `save()` in a repo
// with three different `save` functions is ambiguous by name, but the checker
// knows exactly which one is in scope — through imports, aliases, re-exports,
// and interface implementations. Callers that resolve to node_modules or
// lib.d.ts (`console.log`, `JSON.parse`) return null and stay unbound, which
// is correct: they are not repo functions.
//
// Never throws. The checker can fail on malformed or partially-typed code and
// a broken edge must never take down the whole ingest.
function resolveCallTarget(callExpr: CallExpression): ResolvedTarget | null {
  try {
    const identifier = callTargetIdentifier(callExpr);
    if (!identifier) return null;

    for (const decl of identifier.getDefinitionNodes()) {
      const target = declarationToTarget(decl);
      if (target) return target;
    }
    return null;
  } catch {
    return null;
  }
}

// The identifier whose definition we want: `foo` in `foo()`, and the property
// name `bar` in `obj.bar()`. Anything else (computed access, immediately
// invoked expressions) has no single identifier to resolve.
function callTargetIdentifier(callExpr: CallExpression): Node & { getDefinitionNodes(): Node[] } | null {
  const expression = callExpr.getExpression();
  if (Node.isIdentifier(expression)) return expression as any;
  if (Node.isPropertyAccessExpression(expression)) return expression.getNameNode() as any;
  return null;
}

// Convert a declaration node into the name StructX stores it under, or null
// when the declaration is not something the graph holds as a function row
// (classes, types, external declarations).
function declarationToTarget(decl: Node): ResolvedTarget | null {
  const sourceFile = decl.getSourceFile();
  // `.d.ts` and node_modules declarations are external by definition — there
  // is no functions row to bind to.
  if (sourceFile.isDeclarationFile()) return null;
  const filePath = sourceFile.getFilePath();
  if (filePath.includes('/node_modules/')) return null;

  if (Node.isFunctionDeclaration(decl)) {
    const name = decl.getName();
    return name ? { filePath, name } : null;
  }

  if (Node.isMethodDeclaration(decl)) {
    const parent = decl.getParent();
    const className = Node.isClassDeclaration(parent) ? parent.getName() : undefined;
    const methodName = decl.getName();
    if (!methodName) return null;
    // Mirrors the parser's `Class.method` convention; anonymous classes are
    // stored as `AnonymousClass.method`.
    return { filePath, name: `${className ?? 'AnonymousClass'}.${methodName}` };
  }

  if (Node.isVariableDeclaration(decl)) {
    const initializer = decl.getInitializer();
    // Only arrow/function-expression consts become function rows; a plain
    // `const x = 5` is a constant, not a call target.
    if (!initializer || (!Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer))) {
      return null;
    }
    const name = decl.getName();
    return name ? { filePath, name } : null;
  }

  return null;
}

function extractCalleeName(callExpression: Node): string | null {
  // ts-morph: a CallExpression's first child is its target expression.
  const expression = callExpression.getChildAtIndex(0);
  if (!expression) return null;

  return resolveCalleeName(expression);
}

// Walk the call target to extract the most useful callee name. Handles:
//   foo()                  -> "foo"
//   obj.method()           -> "obj.method"
//   a.b.c()                -> "a.b.c"
//   db.prepare(...).get()  -> "get"           (chained — outer call uses inner result)
//   obj['method']()        -> "obj.method"    (literal element access)
//   arr[0]()               -> null            (computed, not statically resolvable)
//   foo()()                -> null            (call returning a callable)
//   (await foo)()          -> null
//   new Foo().bar()        -> "Foo.bar"
function resolveCalleeName(node: Node): string | null {
  switch (node.getKind()) {
    case SyntaxKind.Identifier:
      return node.getText();

    case SyntaxKind.PropertyAccessExpression: {
      // obj.method — recurse on the object side, append .name
      const expr = (node as any).getExpression?.() as Node | undefined;
      const name = (node as any).getName?.() as string | undefined;
      if (!name) return null;
      const left = expr ? resolveCalleeName(expr) : null;
      return left ? `${left}.${name}` : name;
    }

    case SyntaxKind.ElementAccessExpression: {
      // obj['method'] — only resolve when the index is a string literal
      const expr = (node as any).getExpression?.() as Node | undefined;
      const arg = (node as any).getArgumentExpression?.() as Node | undefined;
      if (!expr || !arg) return null;
      if (arg.getKind() !== SyntaxKind.StringLiteral && arg.getKind() !== SyntaxKind.NoSubstitutionTemplateLiteral) {
        return null;
      }
      const literal = arg.getText().slice(1, -1);
      if (!/^[A-Za-z_$][\w$]*$/.test(literal)) return null;
      const left = resolveCalleeName(expr);
      return left ? `${left}.${literal}` : literal;
    }

    case SyntaxKind.NewExpression: {
      const expr = (node as any).getExpression?.() as Node | undefined;
      return expr ? resolveCalleeName(expr) : null;
    }

    case SyntaxKind.CallExpression: {
      // Chained: foo().bar() — resolveCalleeName is called on `foo()` here, which means
      // the outer node is `foo().bar` (handled in PropertyAccessExpression above) and we
      // landed on the inner CallExpression `foo()`. The useful signal is the next .name,
      // so return null to let the parent property-access produce just the right-hand name.
      return null;
    }

    case SyntaxKind.NonNullExpression:
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.AsExpression:
    case SyntaxKind.TypeAssertionExpression:
    case SyntaxKind.SatisfiesExpression: {
      const inner = (node as any).getExpression?.() as Node | undefined;
      return inner ? resolveCalleeName(inner) : null;
    }

    default:
      return null;
  }
}
