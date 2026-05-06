import type { RetrievedContext, RetrievedFunction, RetrievedType, RetrievedRoute, RetrievedFile, RetrievedConstant } from '../query/retriever';

// Pretty-print helpers — turn graph query results into compact markdown that
// reads well in MCP clients (Claude Desktop, Cursor inline). Each helper is
// designed for a flat single-tool response, not a stitched-together answer.

export function formatContext(ctx: RetrievedContext, header?: string): string {
  const sections: string[] = [];
  if (header) sections.push(`# ${header}`);

  if (ctx.functions.length > 0) {
    sections.push('## Functions');
    sections.push(ctx.functions.map(formatFunction).join('\n\n'));
  }
  if (ctx.types.length > 0) {
    sections.push('## Types');
    sections.push(ctx.types.map(formatType).join('\n\n'));
  }
  if (ctx.routes.length > 0) {
    sections.push('## Routes');
    sections.push(ctx.routes.map(formatRoute).join('\n\n'));
  }
  if (ctx.constants.length > 0) {
    sections.push('## Constants');
    sections.push(ctx.constants.map(formatConstant).join('\n'));
  }
  if (ctx.files.length > 0) {
    sections.push('## Files');
    sections.push(ctx.files.map(formatFile).join('\n\n'));
  }

  if (sections.length === (header ? 1 : 0)) {
    sections.push('_No results._');
  }
  return sections.join('\n\n');
}

export function formatFunction(fn: RetrievedFunction): string {
  const parts = [`**${fn.name}** \`${fn.location}\``];
  parts.push('```ts\n' + fn.signature + '\n```');
  if (fn.purpose) parts.push(`Purpose: ${fn.purpose}`);
  if (fn.behavior) parts.push(`Behavior: ${fn.behavior}`);
  if (fn.sideEffects.length > 0) parts.push(`Side effects: ${fn.sideEffects.join(', ')}`);
  if (fn.domain) parts.push(`Domain: ${fn.domain}`);
  if (fn.complexity) parts.push(`Complexity: ${fn.complexity}`);
  if (fn.calls.length > 0) parts.push(`Calls: ${fn.calls.slice(0, 10).join(', ')}${fn.calls.length > 10 ? '…' : ''}`);
  if (fn.calledBy.length > 0) parts.push(`Called by: ${fn.calledBy.slice(0, 10).join(', ')}${fn.calledBy.length > 10 ? '…' : ''}`);
  return parts.join('\n');
}

export function formatType(t: RetrievedType): string {
  const exp = t.isExported ? ' (exported)' : '';
  const parts = [`**${t.name}** \`${t.kind}\` \`${t.location}\`${exp}`];
  if (t.purpose) parts.push(`Purpose: ${t.purpose}`);
  parts.push('```ts\n' + t.fullText + '\n```');
  return parts.join('\n');
}

export function formatRoute(r: RetrievedRoute): string {
  const parts = [`**${r.method} ${r.path}** \`${r.location}\``];
  if (r.handlerName) parts.push(`Handler: ${r.handlerName}`);
  if (r.middleware.length > 0) parts.push(`Middleware: ${r.middleware.join(' → ')}`);
  if (r.purpose) parts.push(`Purpose: ${r.purpose}`);
  if (r.handlerBody) parts.push('```ts\n' + r.handlerBody + '\n```');
  return parts.join('\n');
}

export function formatConstant(c: RetrievedConstant): string {
  const exp = c.isExported ? ' (exported)' : '';
  const value = c.valueText ? ` = \`${c.valueText}\`` : '';
  const type = c.typeAnnotation ? `: \`${c.typeAnnotation}\`` : '';
  return `- **${c.name}**${type}${value} \`${c.location}\`${exp}`;
}

export function formatFile(f: RetrievedFile): string {
  const parts = [`**${f.path}** — ${f.functionCount} fns, ${f.typeCount} types, ${f.routeCount} routes, ${f.loc} LOC`];
  if (f.purpose) parts.push(`Purpose: ${f.purpose}`);
  if (f.exports.length > 0) parts.push(`Exports: ${f.exports.slice(0, 8).join(', ')}${f.exports.length > 8 ? '…' : ''}`);
  return parts.join('\n');
}
