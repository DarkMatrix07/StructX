import { SourceFile, Node } from 'ts-morph';

export interface ExtractedConstant {
  name: string;
  valueText: string | null;
  typeAnnotation: string | null;
  isExported: boolean;
  startLine: number;
  endLine: number;
}

export function extractConstants(sourceFile: SourceFile): ExtractedConstant[] {
  const constants: ExtractedConstant[] = [];

  for (const varStmt of sourceFile.getVariableStatements()) {
    for (const decl of varStmt.getDeclarations()) {
      const name = decl.getName();
      if (!name) continue;

      const initializer = decl.getInitializer();

      // Skip arrow functions and function expressions — those are captured as functions
      if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
        continue;
      }

      // Get value text, truncated
      let valueText: string | null = null;
      if (initializer) {
        const text = initializer.getText();
        valueText = text.length > 500 ? text.substring(0, 500) + '...' : text;
      }

      // Get type annotation
      const typeNode = decl.getTypeNode();
      const typeAnnotation = typeNode ? typeNode.getText() : null;

      constants.push({
        name,
        valueText,
        typeAnnotation,
        isExported: varStmt.isExported(),
        startLine: decl.getStartLineNumber(),
        endLine: decl.getEndLineNumber(),
      });
    }
  }

  return constants;
}
