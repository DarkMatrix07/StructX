import { SourceFile, SyntaxKind, Node, ClassDeclaration, MethodDeclaration } from 'ts-morph';

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

export function extractRoutes(sourceFile: SourceFile): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];
  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

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

    // Last argument is the handler
    const lastArg = args[args.length - 1];
    const handlerBody = lastArg.getText().substring(0, 2000); // Truncate very large handlers

    // Try to extract handler name
    let handlerName: string | null = null;
    if (Node.isIdentifier(lastArg)) {
      handlerName = lastArg.getText();
    } else if (Node.isArrowFunction(lastArg) || Node.isFunctionExpression(lastArg)) {
      handlerName = null; // Inline handler
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
  }

  return routes;
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
