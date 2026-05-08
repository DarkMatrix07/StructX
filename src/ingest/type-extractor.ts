import { SourceFile } from 'ts-morph';

export interface ExtractedType {
  name: string;
  kind: 'interface' | 'type_alias' | 'enum' | 'class';
  fullText: string;
  isExported: boolean;
  startLine: number;
  endLine: number;
}

export function extractTypes(sourceFile: SourceFile): ExtractedType[] {
  const types: ExtractedType[] = [];

  for (const iface of sourceFile.getInterfaces()) {
    const name = iface.getName();
    if (!name) continue;
    types.push({
      name,
      kind: 'interface',
      fullText: iface.getFullText().trim(),
      isExported: iface.isExported(),
      startLine: iface.getStartLineNumber(),
      endLine: iface.getEndLineNumber(),
    });
  }

  for (const alias of sourceFile.getTypeAliases()) {
    const name = alias.getName();
    if (!name) continue;
    types.push({
      name,
      kind: 'type_alias',
      fullText: alias.getFullText().trim(),
      isExported: alias.isExported(),
      startLine: alias.getStartLineNumber(),
      endLine: alias.getEndLineNumber(),
    });
  }

  for (const enumDecl of sourceFile.getEnums()) {
    const name = enumDecl.getName();
    if (!name) continue;
    types.push({
      name,
      kind: 'enum',
      fullText: enumDecl.getFullText().trim(),
      isExported: enumDecl.isExported(),
      startLine: enumDecl.getStartLineNumber(),
      endLine: enumDecl.getEndLineNumber(),
    });
  }

  // Classes are first-class type-shaped citizens in TypeScript codebases —
  // `class Hono`, `class RegExpRouter`, etc. are what users refer to when
  // asking type-shaped questions, even though they're declared with `class`.
  // We index them as `kind: 'class'` so structx_type can find them. The
  // `fullText` is just the class signature (declaration + heritage); the
  // method bodies are already in the functions table as `ClassName.method`.
  for (const classDecl of sourceFile.getClasses()) {
    const name = classDecl.getName();
    if (!name) continue;
    const heritage = classDecl.getHeritageClauses().map(h => h.getText()).join(' ');
    const sig = `class ${name}${heritage ? ' ' + heritage : ''}`;
    types.push({
      name,
      kind: 'class',
      fullText: sig,
      isExported: classDecl.isExported(),
      startLine: classDecl.getStartLineNumber(),
      endLine: classDecl.getEndLineNumber(),
    });
  }

  return types;
}
