import { SourceFile } from 'ts-morph';

export interface ExtractedType {
  name: string;
  kind: 'interface' | 'type_alias' | 'enum';
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

  return types;
}
