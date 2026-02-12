import type { FunctionRow } from '../db/queries';
import * as crypto from 'crypto';

export interface PromptFunction {
  function_name: string;
  location: string;
  signature: string;
  code: string;
  calls: string[];
  called_by: string[];
}

export function buildBatchPrompt(functions: PromptFunction[]): string {
  const functionsBlock = functions.map((fn, i) => `
Function ${i + 1}: ${fn.function_name}
Location: ${fn.location}
Signature: ${fn.signature}
Code:
\`\`\`typescript
${fn.code}
\`\`\`
Context:
- Calls: ${fn.calls.length > 0 ? fn.calls.join(', ') : 'none'}
- Called by: ${fn.called_by.length > 0 ? fn.called_by.join(', ') : 'none'}
`).join('\n---\n');

  return `Analyze the following TypeScript functions. For each function, extract structured metadata.

${functionsBlock}

Respond ONLY with a JSON array, no markdown, no explanation:
[
  {
    "function_name": "exact_name_from_above",
    "purpose": "One sentence describing what this function does",
    "side_effects": ["list of side effects like DB writes, network calls, console output"],
    "behavior": "2-3 sentence description of how the function works step by step",
    "domain": "one of: authentication, database, validation, routing, middleware, utility, logging, session, crypto, ui, api, config, testing, other",
    "complexity": "low | medium | high"
  }
]`;
}

export interface PromptType {
  name: string;
  kind: string;
  full_text: string;
}

export function buildTypeAnalysisPrompt(types: PromptType[]): string {
  const typesBlock = types.map((t, i) => `
Type ${i + 1}: ${t.name}
Kind: ${t.kind}
Definition:
\`\`\`typescript
${t.full_text}
\`\`\`
`).join('\n---\n');

  return `Analyze the following TypeScript types/interfaces/enums. For each, provide a one-sentence purpose description.

${typesBlock}

Respond ONLY with a JSON array, no markdown, no explanation:
[
  {
    "name": "exact_name_from_above",
    "purpose": "One sentence describing what this type represents and how it's used"
  }
]`;
}

export interface PromptRoute {
  method: string;
  path: string;
  handler_body: string;
}

export function buildRouteAnalysisPrompt(routes: PromptRoute[]): string {
  const routesBlock = routes.map((r, i) => `
Route ${i + 1}: ${r.method} ${r.path}
Handler:
\`\`\`typescript
${r.handler_body.substring(0, 1000)}
\`\`\`
`).join('\n---\n');

  return `Analyze the following HTTP route handlers. For each, provide a one-sentence purpose description.

${routesBlock}

Respond ONLY with a JSON array, no markdown, no explanation:
[
  {
    "method": "exact method",
    "path": "exact path",
    "purpose": "One sentence describing what this endpoint does"
  }
]`;
}

export interface PromptFileSummary {
  path: string;
  exports: string[];
  function_count: number;
  type_count: number;
  route_count: number;
  loc: number;
}

export function buildFileSummaryPrompt(files: PromptFileSummary[]): string {
  const filesBlock = files.map((f, i) => `
File ${i + 1}: ${f.path}
Exports: ${f.exports.length > 0 ? f.exports.join(', ') : 'none'}
Stats: ${f.function_count} functions, ${f.type_count} types, ${f.route_count} routes, ${f.loc} LOC
`).join('\n---\n');

  return `Analyze the following TypeScript files. For each, provide a one-sentence purpose description based on its path, exports, and stats.

${filesBlock}

Respond ONLY with a JSON array, no markdown, no explanation:
[
  {
    "path": "exact path",
    "purpose": "One sentence describing what this file is responsible for"
  }
]`;
}

export function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt).digest('hex');
}
