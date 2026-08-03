import { SourceFile, SyntaxKind, Node, ClassDeclaration, MethodDeclaration, CallExpression, ArrowFunction, FunctionExpression } from 'ts-morph';

export interface ExtractedRoute {
  method: string;
  path: string;
  handlerName: string | null;
  handlerBody: string;
  middleware: string | null;
  startLine: number;
  endLine: number;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'use']);
// HTTP verb decorators used by NestJS, plus a few extras seen in similar
// decorator-based frameworks. Compared lower-case so we don't have to keep
// a separate exact-case list per framework.
const DECORATOR_HTTP_METHODS = new Set([
  'get', 'post', 'put', 'delete', 'patch', 'all', 'head', 'options',
]);

// An inline handler passed directly to a route registration:
//   router.get('/articles', async (req, res) => { ... })
// This is the dominant Express idiom, and until 3.4.0 it produced no function
// row at all — so an Express app's entire controller layer was missing from
// the graph. These are surfaced as functions under a synthetic name so they
// behave like any other node: they carry call edges, appear in impact
// analysis, and give routes something to link to.
export interface InlineRouteHandler {
  name: string;
  node: ArrowFunction | FunctionExpression;
  startLine: number;
  endLine: number;
  params: string;
  isAsync: boolean;
}

// The single source of truth for naming inline handlers. The parser, the
// relationship extractor, and the route extractor all derive the name from
// here so a route's handler_name always matches the function row's name.
export function inlineHandlerName(method: string, routePath: string): string {
  return `${method.toUpperCase()} ${routePath}`;
}

// Shared route-call matcher. Both `extractRoutes` and `findInlineRouteHandlers`
// go through this so the two can never disagree about what counts as a route.
interface MatchedRouteCall {
  method: string;
  routePath: string;
  args: Node[];
}

function matchRouteCall(callExpr: CallExpression): MatchedRouteCall | null {
  const expression = callExpr.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) return null;

  const methodName = expression.getName().toLowerCase();
  if (!HTTP_METHODS.has(methodName)) return null;

  const args = callExpr.getArguments();
  if (args.length < 2) return null;

  const firstArg = args[0];
  let routePath: string | null = null;
  if (Node.isStringLiteral(firstArg)) {
    routePath = firstArg.getLiteralValue();
  } else {
    const text = firstArg.getText();
    if (text.startsWith("'") || text.startsWith('"') || text.startsWith('`')) {
      routePath = text.replace(/^['"`]|['"`]$/g, '');
    }
  }
  if (!routePath || (!routePath.startsWith('/') && methodName !== 'use')) return null;

  const lastArg = args[args.length - 1];
  if (Node.isStringLiteral(lastArg) || Node.isNoSubstitutionTemplateLiteral(lastArg)) return null;

  return { method: methodName.toUpperCase(), routePath, args };
}

// Walking every CallExpression in a file is not cheap, and three separate
// passes wanted the same list (route registrations, inline handlers, and the
// relationship extractor's own scan). Memoizing per SourceFile collapses the
// redundant walks; the WeakMap means entries disappear with the AST when
// ts-morph drops the file.
const callExpressionCache = new WeakMap<SourceFile, CallExpression[]>();

function getCallExpressions(sourceFile: SourceFile): CallExpression[] {
  const cached = callExpressionCache.get(sourceFile);
  if (cached) return cached;
  const found = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  callExpressionCache.set(sourceFile, found);
  return found;
}

const inlineHandlerCache = new WeakMap<SourceFile, InlineRouteHandler[]>();

// A route registration must contain a literal `.get(` / `.post(` / … in the
// source text. Testing that first lets files with no route calls skip the
// full CallExpression walk — the relationship extractor holds a different
// SourceFile instance than the parser, so it cannot share the memo above and
// would otherwise re-walk every file in the repo.
const ROUTE_CALL_HINT = /\.\s*(get|post|put|delete|patch|all|use)\s*\(/i;

export function findInlineRouteHandlers(sourceFile: SourceFile): InlineRouteHandler[] {
  const cached = inlineHandlerCache.get(sourceFile);
  if (cached) return cached;
  if (!ROUTE_CALL_HINT.test(sourceFile.getFullText())) {
    inlineHandlerCache.set(sourceFile, []);
    return [];
  }
  const handlers: InlineRouteHandler[] = [];
  for (const callExpr of getCallExpressions(sourceFile)) {
    const matched = matchRouteCall(callExpr);
    if (!matched) continue;
    const lastArg = matched.args[matched.args.length - 1];
    if (!Node.isArrowFunction(lastArg) && !Node.isFunctionExpression(lastArg)) continue;

    handlers.push({
      name: inlineHandlerName(matched.method, matched.routePath),
      node: lastArg,
      startLine: lastArg.getStartLineNumber(),
      endLine: lastArg.getEndLineNumber(),
      params: lastArg.getParameters().map(p => p.getText()).join(', '),
      isAsync: lastArg.isAsync(),
    });
  }
  inlineHandlerCache.set(sourceFile, handlers);
  return handlers;
}

// HTTP verbs that a file-based route module exports as named functions.
const FILE_ROUTE_EXPORTS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

// Derive the URL path a file-based route module serves, from its location on
// disk. Covers the conventions that replaced `app.get(...)` in most modern
// frameworks:
//
//   Next.js App Router  app/api/users/[id]/route.ts   -> /api/users/:id
//   Next.js Pages API   pages/api/users/[id].ts       -> /api/users/:id
//   SvelteKit           src/routes/users/+server.ts   -> /users
//   Medusa v2           src/api/admin/orders/route.ts -> /admin/orders
//
// Returns null when the file is not a route module. Dynamic segments become
// `:param`, catch-alls become `*`, and Next.js route groups `(marketing)` are
// dropped since they do not appear in the URL.
export function fileBasedRoutePath(absoluteFilePath: string): string | null {
  const normalized = absoluteFilePath.replace(/\\/g, '/');
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1);
  const isRouteModule = /^route\.(ts|tsx|js|mjs)$/.test(fileName);
  const isServerModule = /^\+server\.(ts|js)$/.test(fileName);
  const isPagesApi = /\/pages\/api\//.test(normalized);
  if (!isRouteModule && !isServerModule && !isPagesApi) return null;

  // Anchor on the framework's routing root, taking the LAST occurrence so a
  // monorepo path like apps/web/app/... resolves against the inner one.
  const anchors = isPagesApi ? ['/pages/'] : ['/app/', '/routes/', '/api/', '/src/'];
  let rest: string | null = null;
  for (const anchor of anchors) {
    const idx = normalized.lastIndexOf(anchor);
    if (idx === -1) continue;
    // Note `api` is treated differently depending on which anchor matched.
    // Under `app/` it is an ordinary URL segment (Next.js App Router serves
    // app/api/users at /api/users), and the `/app/` anchor above already
    // keeps it in `rest`. When `/api/` is itself the anchor the file is a
    // Medusa-style module rooted at src/api, where `api` is the convention
    // marker and not part of the URL.
    rest = normalized.slice(idx + anchor.length);
    break;
  }
  if (rest === null) return null;

  // Drop the filename; for pages/api the filename IS the last URL segment.
  const parts = rest.split('/');
  const last = parts.pop() ?? '';
  if (isPagesApi) {
    const base = last.replace(/\.(ts|tsx|js|mjs)$/, '');
    if (base !== 'index') parts.push(base);
  }

  const segments: string[] = [];
  for (const raw of parts) {
    if (!raw) continue;
    // Route groups and private folders never appear in the URL.
    if (/^\(.*\)$/.test(raw) || raw.startsWith('_')) continue;
    const catchAll = raw.match(/^\[\.\.\.(.+)\]$/);
    if (catchAll) { segments.push('*'); continue; }
    const dynamic = raw.match(/^\[(.+)\]$/);
    segments.push(dynamic ? `:${dynamic[1].replace(/^\.\.\./, '')}` : raw);
  }

  return '/' + segments.join('/');
}

// Routes declared by exporting an HTTP-verb-named function from a route
// module. The exported function is the handler, so it links to the graph the
// same way a named Express handler does.
function extractFileBasedRoutes(sourceFile: SourceFile): ExtractedRoute[] {
  const routePath = fileBasedRoutePath(sourceFile.getFilePath());
  if (routePath === null) return [];

  const routes: ExtractedRoute[] = [];
  const push = (method: string, name: string, node: Node) => {
    routes.push({
      method,
      path: routePath,
      handlerName: name,
      handlerBody: node.getText().substring(0, 2000),
      middleware: null,
      startLine: node.getStartLineNumber(),
      endLine: node.getEndLineNumber(),
    });
  };

  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (!name || !fn.isExported()) continue;
    if (FILE_ROUTE_EXPORTS.has(name)) push(name, name, fn);
    // `export default function handler(req, res)` — the Pages API shape.
    else if (fn.isDefaultExport()) push('ALL', name, fn);
  }

  for (const varStmt of sourceFile.getVariableStatements()) {
    if (!varStmt.isExported()) continue;
    for (const decl of varStmt.getDeclarations()) {
      const name = decl.getName();
      if (!FILE_ROUTE_EXPORTS.has(name)) continue;
      const initializer = decl.getInitializer();
      if (!initializer || (!Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer))) continue;
      push(name, name, decl);
    }
  }

  return routes;
}

export function extractRoutes(sourceFile: SourceFile): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];
  const callExpressions = getCallExpressions(sourceFile);

  for (const callExpr of callExpressions) {
    const expression = callExpr.getExpression();

    // Match patterns like router.get(...), app.post(...), *.method('/path', ...)
    if (!Node.isPropertyAccessExpression(expression)) continue;

    const methodName = expression.getName().toLowerCase();
    if (!HTTP_METHODS.has(methodName)) continue;

    const args = callExpr.getArguments();
    if (args.length < 1) continue;

    // First argument should be a string literal path starting with '/'
    const firstArg = args[0];
    let routePath: string | null = null;

    if (Node.isStringLiteral(firstArg)) {
      routePath = firstArg.getLiteralValue();
    } else {
      // Could be a template literal or variable — skip non-literal paths
      const text = firstArg.getText();
      if (text.startsWith("'") || text.startsWith('"') || text.startsWith('`')) {
        routePath = text.replace(/^['"`]|['"`]$/g, '');
      }
    }

    if (!routePath || (!routePath.startsWith('/') && methodName !== 'use')) continue;

    // A route registration always supplies a handler after the path. Without
    // this check, any `.get()` / `.set()` on a Map or filesystem helper whose
    // key happens to look like a path becomes a phantom endpoint — the
    // TypeScript compiler repo produced 29 of them from `map.get('/foo/bar')`
    // calls in its test suite, none of which are HTTP routes.
    if (args.length < 2) continue;

    // Last argument is the handler
    const lastArg = args[args.length - 1];
    // ...and a handler is never a string. `map.set('/a', '/b')` is a lookup
    // table, not a route.
    if (Node.isStringLiteral(lastArg) || Node.isNoSubstitutionTemplateLiteral(lastArg)) continue;
    const handlerBody = lastArg.getText().substring(0, 2000); // Truncate very large handlers

    // Try to extract handler name. Inline handlers get the synthetic name the
    // parser also assigns them, so the ingester can link route → function.
    let handlerName: string | null = null;
    if (Node.isIdentifier(lastArg)) {
      handlerName = lastArg.getText();
    } else if (Node.isArrowFunction(lastArg) || Node.isFunctionExpression(lastArg)) {
      handlerName = inlineHandlerName(methodName, routePath);
    }

    // Middleware: arguments between path and handler
    let middleware: string | null = null;
    if (args.length > 2) {
      const middlewareArgs = args.slice(1, -1).map(a => a.getText());
      middleware = JSON.stringify(middlewareArgs);
    }

    routes.push({
      method: methodName.toUpperCase(),
      path: routePath,
      handlerName,
      handlerBody,
      middleware,
      startLine: callExpr.getStartLineNumber(),
      endLine: callExpr.getEndLineNumber(),
    });
  }

  // Decorator-based routes (NestJS @Controller / @Get / @Post / etc.)
  for (const classDecl of sourceFile.getClasses()) {
    routes.push(...extractDecoratorRoutes(classDecl));
    routes.push(...extractWebComponents(classDecl));
  }

  // File-based routes (Next.js App Router, Pages API, SvelteKit, Medusa v2).
  routes.push(...extractFileBasedRoutes(sourceFile));

  return routes;
}

// Web Component custom-element registrations. Stencil:
//   @Component({ tag: 'my-counter' })
//   class MyCounter {}
// Lit:
//   @customElement('my-element')
//   class MyElement extends LitElement {}
//
// We surface these as routes with method='COMPONENT' so they show up in
// structx_list / structx_route alongside HTTP routes — they're conceptually
// the entry points of a UI codebase, the same way HTTP routes are entry
// points for an API. Users who want UI-only tooling can filter by method.
function extractWebComponents(classDecl: ClassDeclaration): ExtractedRoute[] {
  const result: ExtractedRoute[] = [];
  for (const dec of classDecl.getDecorators()) {
    const name = dec.getName();
    let tag: string | undefined;

    if (name === 'Component') {
      // Stencil / Angular-style: @Component({ tag: 'foo' }) — read the
      // object literal's `tag` (or `selector`) property. Angular uses
      // `selector`, Stencil uses `tag`.
      const callExpr = dec.getCallExpression();
      if (!callExpr) continue;
      const args = callExpr.getArguments();
      const arg = args[0];
      if (!arg || !Node.isObjectLiteralExpression(arg)) continue;
      for (const prop of arg.getProperties()) {
        if (!Node.isPropertyAssignment(prop)) continue;
        const propName = prop.getName();
        if (propName !== 'tag' && propName !== 'selector') continue;
        const initializer = prop.getInitializer();
        if (initializer && Node.isStringLiteral(initializer)) {
          tag = initializer.getLiteralValue();
        } else if (initializer && Node.isNoSubstitutionTemplateLiteral(initializer)) {
          tag = initializer.getLiteralValue();
        }
        if (tag) break;
      }
    } else if (name === 'customElement') {
      // Lit-style: @customElement('foo')
      tag = readDecoratorStringArg(dec);
    }

    if (!tag) continue;
    result.push({
      method: 'COMPONENT',
      path: `/${tag}`,
      handlerName: classDecl.getName() ?? null,
      handlerBody: '',
      middleware: null,
      startLine: classDecl.getStartLineNumber(),
      endLine: classDecl.getEndLineNumber(),
    });
  }
  return result;
}

// Pull route definitions from a class with NestJS-style decorators:
//
//   @Controller('cats')
//   class CatsController {
//     @Get(':id')
//     findOne(@Param('id') id: string) { ... }
//   }
//
// Frameworks supported: NestJS (primary), Tsoa, routing-controllers,
// and any project that follows the same `@Controller(path) + @<Method>(path)`
// convention. The decorator NAME is what we match on; arguments and
// return types don't matter — we just need the path strings.
function extractDecoratorRoutes(classDecl: ClassDeclaration): ExtractedRoute[] {
  const result: ExtractedRoute[] = [];

  // Class-level @Controller(...) decorator gives us the base path. We accept
  // any class decorator named exactly `Controller` regardless of import
  // origin so we don't need to follow imports — false positives here are
  // acceptable since the per-method decorator check is the actual filter.
  const classDecorators = classDecl.getDecorators();
  let basePath: string | undefined;
  for (const dec of classDecorators) {
    if (dec.getName() !== 'Controller') continue;
    basePath = readDecoratorStringArg(dec) ?? '';
    break;
  }
  // No @Controller — but per-method @Get/@Post still produce valid routes
  // (controller-less style used by some routing-controllers configs).
  if (basePath === undefined) basePath = undefined;

  for (const method of classDecl.getMethods()) {
    const httpDecorators = method.getDecorators().filter(d =>
      DECORATOR_HTTP_METHODS.has(d.getName().toLowerCase()),
    );
    if (httpDecorators.length === 0) continue;

    for (const dec of httpDecorators) {
      // If neither the class is a Controller nor the method has explicit
      // HTTP decorators on a free-standing class, skip.
      if (basePath === undefined) continue;

      const methodPath = readDecoratorStringArg(dec) ?? '';
      const fullPath = joinRoutePath(basePath, methodPath);
      const httpMethod = dec.getName().toUpperCase();

      result.push({
        method: httpMethod,
        path: fullPath,
        handlerName: classDecl.getName()
          ? `${classDecl.getName()}.${method.getName()}`
          : method.getName(),
        handlerBody: extractMethodBodyText(method),
        middleware: null,
        startLine: method.getStartLineNumber(),
        endLine: method.getEndLineNumber(),
      });
    }
  }

  return result;
}

function readDecoratorStringArg(dec: import('ts-morph').Decorator): string | undefined {
  const callExpr = dec.getCallExpression();
  if (!callExpr) return undefined; // bare `@Get` — no path
  const args = callExpr.getArguments();
  if (args.length === 0) return ''; // `@Get()` — empty path
  const first = args[0];
  if (Node.isStringLiteral(first)) return first.getLiteralValue();
  // Template literals without interpolation are treated as static paths.
  if (Node.isNoSubstitutionTemplateLiteral(first)) return first.getLiteralValue();

  // NestJS's options form: `@Controller({ path: '/v2/users', version: '2' })`.
  // An officially supported signature that cal.com uses throughout its v2 API
  // — without this, 21% of its routes collapsed to '/' and the rest lost
  // their controller prefix, showing up as bare `/:webhookId`.
  if (Node.isObjectLiteralExpression(first)) {
    for (const prop of first.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue;
      if (prop.getName() !== 'path') continue;
      const initializer = prop.getInitializer();
      if (initializer && Node.isStringLiteral(initializer)) return initializer.getLiteralValue();
      if (initializer && Node.isNoSubstitutionTemplateLiteral(initializer)) return initializer.getLiteralValue();
      // `path: ['a', 'b']` — NestJS allows an array; take the first entry so
      // the route still has a recognizable prefix.
      if (initializer && Node.isArrayLiteralExpression(initializer)) {
        const firstEl = initializer.getElements()[0];
        if (firstEl && Node.isStringLiteral(firstEl)) return firstEl.getLiteralValue();
      }
    }
    return undefined;
  }

  // Enum member reference — `@Controller(RouteKey.Asset)`. Real-world case
  // from immich: all 40 controllers use `@Controller(RouteKey.X)` instead
  // of a string literal. ts-morph's TypeChecker resolves the enum member
  // to its literal value (`'assets'`) for string enums when the project
  // has full visibility into the enum's source file. When type resolution
  // fails (e.g. path-aliased imports the project couldn't follow because
  // it has no tsconfig), we fall back to the property identifier itself
  // so each controller still produces a distinct, recognizable route
  // path (`/Asset/...`) instead of all collapsing to `/`.
  try {
    const type = first.getType();
    const literal = type.getLiteralValue();
    if (typeof literal === 'string') return literal;
    if (typeof literal === 'number') return String(literal);
  } catch {
    // Fall through to the heuristic below — never crash the ingest just
    // because the type checker couldn't resolve a single decorator arg.
  }
  if (Node.isPropertyAccessExpression(first)) {
    const memberName = first.getName();
    if (memberName) {
      // Lowercase to match the common enum-to-route convention
      // (`RouteKey.Asset` → `'assets'` in production, `Asset` → `asset`
      // as our heuristic). Not always identical to the real value, but
      // produces distinct, agent-readable paths per controller — which
      // is much better than every route collapsing to `/`.
      return memberName.toLowerCase();
    }
  }
  // Variable / interpolated / non-resolvable path — skip the decorator-arg
  // case so the route inherits just the base path (or empty).
  return undefined;
}

// Concatenate base + method path, normalize slashes, and ensure leading '/'.
// Handles `'cats'` + `':id'` → `/cats/:id` and `'/cats/'` + `'/:id'` → same.
function joinRoutePath(base: string, methodPath: string): string {
  const cleanBase = base.replace(/^\/+|\/+$/g, '');
  const cleanMethod = methodPath.replace(/^\/+|\/+$/g, '');
  if (!cleanBase && !cleanMethod) return '/';
  if (!cleanBase) return '/' + cleanMethod;
  if (!cleanMethod) return '/' + cleanBase;
  return '/' + cleanBase + '/' + cleanMethod;
}

function extractMethodBodyText(method: MethodDeclaration): string {
  const body = method.getBody();
  if (!body) return '';
  return body.getText().substring(0, 2000);
}
