import { SourceFile, SyntaxKind, Node } from 'ts-morph';

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

  return routes;
}
