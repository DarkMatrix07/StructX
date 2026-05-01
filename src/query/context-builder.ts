import type { RetrievedContext, RetrievedFunction, RetrievedType, RetrievedRoute, RetrievedFile, RetrievedConstant } from './retriever';
import { estimateTokens } from '../utils/tokens';

const DEFAULT_CONTEXT_TOKEN_BUDGET = 3000;

export function buildContext(retrieved: RetrievedContext, question: string): string {
  const totalEntities = retrieved.functions.length + retrieved.types.length +
    retrieved.routes.length + retrieved.files.length + retrieved.constants.length;

  if (totalEntities === 0) {
    return `No results found matching the query. The knowledge graph may not contain relevant data for this question. Try:\n- "structx overview --repo ." to see what entities are indexed\n- Rephrase your question with different keywords\n- Run "structx ingest ." if files were recently added\n\nQuestion: ${question}`;
  }

  const sections: string[] = [];

  switch (retrieved.strategy) {
    case 'direct':
      if (retrieved.functions.length > 0) sections.push(formatDirectContext(retrieved.functions[0]));
      break;
    case 'relationship':
      sections.push(formatRelationshipContext(retrieved.functions));
      break;
    case 'semantic':
      if (retrieved.functions.length > 0) sections.push(formatSemanticContext(retrieved.functions));
      if (retrieved.types.length > 0) sections.push(formatTypesContext(retrieved.types));
      if (retrieved.routes.length > 0) sections.push(formatRoutesContext(retrieved.routes));
      break;
    case 'domain':
      sections.push(formatDomainContext(retrieved.functions));
      break;
    case 'impact':
      sections.push(formatImpactContext(retrieved.functions));
      break;
    case 'route':
      sections.push(formatRoutesContext(retrieved.routes));
      break;
    case 'type':
      sections.push(formatTypesContext(retrieved.types));
      break;
    case 'file':
      if (retrieved.files.length > 0) sections.push(formatFilesContext(retrieved.files));
      if (retrieved.functions.length > 0) sections.push('Functions:\n' + formatFunctionList(retrieved.functions));
      if (retrieved.types.length > 0) sections.push('Types:\n' + formatTypesContext(retrieved.types));
      if (retrieved.routes.length > 0) sections.push('Routes:\n' + formatRoutesContext(retrieved.routes));
      if (retrieved.constants.length > 0) sections.push('Constants:\n' + formatConstantsContext(retrieved.constants));
      break;
    case 'list':
      if (retrieved.functions.length > 0) sections.push('Functions:\n' + formatFunctionList(retrieved.functions));
      if (retrieved.routes.length > 0) sections.push('Routes:\n' + formatRoutesContext(retrieved.routes));
      if (retrieved.types.length > 0) sections.push('Types:\n' + formatTypesContext(retrieved.types));
      if (retrieved.files.length > 0) sections.push('Files:\n' + formatFilesContext(retrieved.files));
      if (retrieved.constants.length > 0) sections.push('Constants:\n' + formatConstantsContext(retrieved.constants));
      break;
    case 'pattern':
      if (retrieved.functions.length > 0) sections.push('Functions:\n' + formatFunctionList(retrieved.functions));
      if (retrieved.types.length > 0) sections.push('Types:\n' + formatTypesContext(retrieved.types));
      if (retrieved.routes.length > 0) sections.push('Routes:\n' + formatRoutesContext(retrieved.routes));
      if (retrieved.files.length > 0) sections.push('Files:\n' + formatFilesContext(retrieved.files));
      break;
    default:
      if (retrieved.functions.length > 0) sections.push(formatSemanticContext(retrieved.functions));
  }

  let context = sections.join('\n\n');
  context = fitContextToBudget(context, DEFAULT_CONTEXT_TOKEN_BUDGET);
  const tokens = estimateTokens(context);

  return `[Context retrieved via ${retrieved.strategy} strategy | ${totalEntities} entities | ~${tokens} tokens]\n\n${context}`;
}

export function fitContextToBudget(context: string, maxTokens: number): string {
  if (estimateTokens(context) <= maxTokens) return context;

  let compacted = context
    .replace(/\n\s+Handler body: .*(?=\n|$)/g, '')
    .replace(/\n\s+Definition:\n[\s\S]*?(?=\n\n\d+\.|\n\n[A-Z][A-Za-z]+:|$)/g, '');

  if (estimateTokens(compacted) <= maxTokens) {
    return `${compacted}\n\n[Context truncated to fit ~${maxTokens} tokens; large handler bodies and type definitions were omitted.]`;
  }

  const budgetChars = Math.max(500, maxTokens * 4);
  compacted = compacted.slice(0, budgetChars).replace(/\n[^\n]*$/, '');
  return `${compacted}\n\n[Context truncated to fit ~${maxTokens} tokens.]`;
}

function formatDirectContext(fn: RetrievedFunction): string {
  const lines = [
    `Function: ${fn.name}`,
    `Location: ${fn.location}`,
    `Signature: ${fn.signature}`,
  ];

  if (fn.purpose) lines.push(`Purpose: ${fn.purpose}`);
  if (fn.behavior) lines.push(`Behavior: ${fn.behavior}`);
  if (fn.sideEffects.length > 0) lines.push(`Side Effects: ${fn.sideEffects.join(', ')}`);
  if (fn.domain) lines.push(`Domain: ${fn.domain}`);
  if (fn.complexity) lines.push(`Complexity: ${fn.complexity}`);
  if (fn.calls.length > 0) lines.push(`Calls: ${fn.calls.join(', ')}`);
  if (fn.calledBy.length > 0) lines.push(`Called By: ${fn.calledBy.join(', ')}`);

  return lines.join('\n');
}

function formatRelationshipContext(functions: RetrievedFunction[]): string {
  return functions.map((fn, i) => {
    const lines = [
      `${i + 1}. ${fn.name}`,
      `   Location: ${fn.location}`,
      `   Signature: ${fn.signature}`,
    ];
    if (fn.purpose) lines.push(`   Purpose: ${fn.purpose}`);
    if (fn.behavior) lines.push(`   Behavior: ${fn.behavior}`);
    if (fn.calls.length > 0) lines.push(`   Calls: ${fn.calls.join(', ')}`);
    if (fn.calledBy.length > 0) lines.push(`   Called By: ${fn.calledBy.join(', ')}`);
    return lines.join('\n');
  }).join('\n\n');
}

function formatSemanticContext(functions: RetrievedFunction[]): string {
  return functions.map((fn, i) => {
    const lines = [
      `${i + 1}. ${fn.name}`,
      `   Location: ${fn.location}`,
      `   Signature: ${fn.signature}`,
    ];
    if (fn.purpose) lines.push(`   Purpose: ${fn.purpose}`);
    if (fn.behavior) lines.push(`   Behavior: ${fn.behavior}`);
    if (fn.domain) lines.push(`   Domain: ${fn.domain}`);
    if (fn.calls.length > 0) lines.push(`   Calls: ${fn.calls.join(', ')}`);
    return lines.join('\n');
  }).join('\n\n');
}

function formatDomainContext(functions: RetrievedFunction[]): string {
  return functions.map((fn, i) => {
    const lines = [
      `${i + 1}. ${fn.name}`,
      `   Location: ${fn.location}`,
      `   Signature: ${fn.signature}`,
    ];
    if (fn.purpose) lines.push(`   Purpose: ${fn.purpose}`);
    if (fn.sideEffects.length > 0) lines.push(`   Side Effects: ${fn.sideEffects.join(', ')}`);
    if (fn.calls.length > 0) lines.push(`   Calls: ${fn.calls.join(', ')}`);
    return lines.join('\n');
  }).join('\n\n');
}

function formatImpactContext(functions: RetrievedFunction[]): string {
  return `Functions affected (${functions.length} total):\n\n` +
    functions.map((fn, i) => {
      const lines = [
        `${i + 1}. ${fn.name}`,
        `   Location: ${fn.location}`,
        `   Signature: ${fn.signature}`,
      ];
      if (fn.purpose) lines.push(`   Purpose: ${fn.purpose}`);
      if (fn.calls.length > 0) lines.push(`   Calls: ${fn.calls.join(', ')}`);
      return lines.join('\n');
    }).join('\n\n');
}

function formatFunctionList(functions: RetrievedFunction[]): string {
  return functions.map((fn, i) => {
    const lines = [
      `${i + 1}. ${fn.name}`,
      `   Location: ${fn.location}`,
      `   Signature: ${fn.signature}`,
    ];
    if (fn.purpose) lines.push(`   Purpose: ${fn.purpose}`);
    return lines.join('\n');
  }).join('\n\n');
}

function formatRoutesContext(routes: RetrievedRoute[]): string {
  if (routes.length === 0) return 'No routes found.';
  return routes.map((r, i) => {
    const lines = [
      `${i + 1}. ${r.method} ${r.path}`,
      `   Location: ${r.location}`,
    ];
    if (r.handlerName) lines.push(`   Handler: ${r.handlerName}`);
    if (r.middleware.length > 0) lines.push(`   Middleware: ${r.middleware.join(', ')}`);
    if (r.purpose) lines.push(`   Purpose: ${r.purpose}`);
    // Include truncated handler body for context
    const bodyPreview = r.handlerBody.length > 300 ? r.handlerBody.substring(0, 300) + '...' : r.handlerBody;
    lines.push(`   Handler body: ${bodyPreview}`);
    return lines.join('\n');
  }).join('\n\n');
}

function formatTypesContext(types: RetrievedType[]): string {
  if (types.length === 0) return 'No types found.';
  return types.map((t, i) => {
    const lines = [
      `${i + 1}. ${t.kind} ${t.name}${t.isExported ? ' (exported)' : ''}`,
      `   Location: ${t.location}`,
    ];
    if (t.purpose) lines.push(`   Purpose: ${t.purpose}`);
    lines.push(`   Definition:\n${t.fullText}`);
    return lines.join('\n');
  }).join('\n\n');
}

function formatFilesContext(files: RetrievedFile[]): string {
  if (files.length === 0) return 'No files found.';
  return files.map((f, i) => {
    const lines = [
      `${i + 1}. ${f.path}`,
      `   LOC: ${f.loc} | Functions: ${f.functionCount} | Types: ${f.typeCount} | Routes: ${f.routeCount}`,
      `   Imports: ${f.importCount} | Exports: ${f.exportCount}`,
    ];
    if (f.purpose) lines.push(`   Purpose: ${f.purpose}`);
    if (f.exports.length > 0) lines.push(`   Exports: ${f.exports.join(', ')}`);
    return lines.join('\n');
  }).join('\n\n');
}

function formatConstantsContext(constants: RetrievedConstant[]): string {
  if (constants.length === 0) return 'No constants found.';
  return constants.map((c, i) => {
    const lines = [
      `${i + 1}. ${c.name}${c.isExported ? ' (exported)' : ''}`,
      `   Location: ${c.location}`,
    ];
    if (c.typeAnnotation) lines.push(`   Type: ${c.typeAnnotation}`);
    if (c.valueText) {
      const preview = c.valueText.length > 200 ? c.valueText.substring(0, 200) + '...' : c.valueText;
      lines.push(`   Value: ${preview}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}
