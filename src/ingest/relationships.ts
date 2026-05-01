import { Project, SyntaxKind, Node } from 'ts-morph';

export interface ExtractedCall {
  callerName: string;
  calleeName: string;
  relationType: 'calls' | 'imports';
}

export function extractCallsFromFile(project: Project, filePath: string): ExtractedCall[] {
  const sourceFile = project.addSourceFileAtPath(filePath);
  const calls: ExtractedCall[] = [];

  // Extract calls from top-level functions
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    const callExpressions = fn.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of callExpressions) {
      const calleeName = extractCalleeName(call);
      if (calleeName && calleeName !== name) {
        calls.push({ callerName: name, calleeName, relationType: 'calls' });
      }
    }
  }

  // Extract calls from arrow functions assigned to variables
  for (const varStmt of sourceFile.getVariableStatements()) {
    for (const decl of varStmt.getDeclarations()) {
      const name = decl.getName();
      const initializer = decl.getInitializer();
      if (!initializer || (!Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer))) continue;

      const callExpressions = initializer.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of callExpressions) {
        const calleeName = extractCalleeName(call);
        if (calleeName && calleeName !== name) {
          calls.push({ callerName: name, calleeName, relationType: 'calls' });
        }
      }
    }
  }

  // Extract calls from class methods
  for (const cls of sourceFile.getClasses()) {
    const className = cls.getName() || 'AnonymousClass';
    for (const method of cls.getMethods()) {
      const methodName = `${className}.${method.getName()}`;
      const callExpressions = method.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of callExpressions) {
        const calleeName = extractCalleeName(call);
        if (calleeName && calleeName !== methodName) {
          calls.push({ callerName: methodName, calleeName, relationType: 'calls' });
        }
      }
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

  project.removeSourceFile(sourceFile);

  // Deduplicate
  const seen = new Set<string>();
  return calls.filter(c => {
    const key = `${c.callerName}|${c.calleeName}|${c.relationType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
