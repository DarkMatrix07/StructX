import { SourceFile, SyntaxKind } from 'ts-morph';

export interface ExtractedType {
  name: string;
  kind: 'interface' | 'type_alias' | 'enum' | 'class';
  fullText: string;
  isExported: boolean;
  startLine: number;
  endLine: number;
  // Heritage edges captured from `extends X, Y` and `implements A, B`.
  // Names are stored bare (without generic args); the second-pass resolver
  // in resolveNullCallees binds them to types.id when possible.
  heritage?: Array<{ name: string; kind: 'extends' | 'implements' }>;
}

export function extractTypes(sourceFile: SourceFile): ExtractedType[] {
  const types: ExtractedType[] = [];

  for (const iface of sourceFile.getInterfaces()) {
    const name = iface.getName();
    if (!name) continue;
    // Interfaces only have `extends` (multiple supertypes possible).
    const heritage: Array<{ name: string; kind: 'extends' | 'implements' }> = [];
    for (const ext of iface.getExtends()) {
      const supertypeName = baseHeritageName(ext.getText());
      if (supertypeName) heritage.push({ name: supertypeName, kind: 'extends' });
    }
    types.push({
      name,
      kind: 'interface',
      fullText: iface.getFullText().trim(),
      isExported: iface.isExported(),
      startLine: iface.getStartLineNumber(),
      endLine: iface.getEndLineNumber(),
      ...(heritage.length > 0 ? { heritage } : {}),
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
    const heritageClauses = classDecl.getHeritageClauses();
    const heritageText = heritageClauses.map(h => h.getText()).join(' ');
    const sig = `class ${name}${heritageText ? ' ' + heritageText : ''}`;

    // Capture each parent type as a separate edge so type-graph queries
    // (e.g. "what classes extend Foo?") work on individual supertypes.
    const heritage: Array<{ name: string; kind: 'extends' | 'implements' }> = [];
    for (const clause of heritageClauses) {
      const isExtends = clause.getToken() === SyntaxKind.ExtendsKeyword;
      const kind: 'extends' | 'implements' = isExtends ? 'extends' : 'implements';
      for (const typeNode of clause.getTypeNodes()) {
        const supertypeName = baseHeritageName(typeNode.getText());
        if (supertypeName) heritage.push({ name: supertypeName, kind });
      }
    }

    types.push({
      name,
      kind: 'class',
      fullText: sig,
      isExported: classDecl.isExported(),
      startLine: classDecl.getStartLineNumber(),
      endLine: classDecl.getEndLineNumber(),
      ...(heritage.length > 0 ? { heritage } : {}),
    });
  }

  return types;
}

// Strip generic arguments and dotted access from a heritage expression so
// `extends Foo<T>` and `extends ns.Foo<T, U>` both reduce to `Foo`. Allows
// the type-graph resolver to bind to the actual type by simple name.
function baseHeritageName(text: string): string | null {
  // Remove anything after `<` (generics) and trim whitespace.
  let stripped = text.replace(/<[\s\S]*$/, '').trim();
  // For `ns.Foo`, take the last segment.
  const dotIdx = stripped.lastIndexOf('.');
  if (dotIdx >= 0) stripped = stripped.slice(dotIdx + 1);
  // Bare identifier check.
  if (!/^[A-Za-z_$][\w$]*$/.test(stripped)) return null;
  return stripped;
}
