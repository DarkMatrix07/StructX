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
  const expression = callExpression.getChildAtIndex(0);
  if (!expression) return null;

  const text = expression.getText();

  // Handle property access: obj.method() -> "obj.method"
  // Handle simple calls: foo() -> "foo"
  // Skip complex expressions like foo()() or arr[0]()
  if (text.includes('(') || text.includes('[')) return null;

  return text;
}
