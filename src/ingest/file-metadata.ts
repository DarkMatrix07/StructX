import { SourceFile } from 'ts-morph';

export interface ExtractedFileMetadata {
  importCount: number;
  exportCount: number;
  functionCount: number;
  typeCount: number;
  routeCount: number;
  loc: number;
  imports: string[];
  exports: string[];
}

export function extractFileMetadata(
  sourceFile: SourceFile,
  functionCount: number,
  typeCount: number,
  routeCount: number
): ExtractedFileMetadata {
  const imports: string[] = [];
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const moduleSpecifier = importDecl.getModuleSpecifierValue();
    const namedImports = importDecl.getNamedImports().map(n => n.getName());
    const defaultImport = importDecl.getDefaultImport()?.getText();
    const items = defaultImport ? [defaultImport, ...namedImports] : namedImports;
    if (items.length > 0) {
      imports.push(`${items.join(', ')} from ${moduleSpecifier}`);
    } else {
      imports.push(moduleSpecifier);
    }
  }

  const exports: string[] = [];
  for (const exportDecl of sourceFile.getExportDeclarations()) {
    const namedExports = exportDecl.getNamedExports().map(n => n.getName());
    exports.push(...namedExports);
  }
  // Also count exported declarations
  for (const fn of sourceFile.getFunctions()) {
    if (fn.isExported() && fn.getName()) exports.push(fn.getName()!);
  }
  for (const iface of sourceFile.getInterfaces()) {
    if (iface.isExported()) exports.push(iface.getName());
  }
  for (const typeAlias of sourceFile.getTypeAliases()) {
    if (typeAlias.isExported()) exports.push(typeAlias.getName());
  }
  for (const varStmt of sourceFile.getVariableStatements()) {
    if (varStmt.isExported()) {
      for (const decl of varStmt.getDeclarations()) {
        exports.push(decl.getName());
      }
    }
  }

  const loc = sourceFile.getEndLineNumber();

  return {
    importCount: imports.length,
    exportCount: exports.length,
    functionCount,
    typeCount,
    routeCount,
    loc,
    imports,
    exports,
  };
}
