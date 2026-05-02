import { createLlmClient, type LlmClientConfig } from '../utils/llm';

export type QueryStrategy = 'direct' | 'relationship' | 'semantic' | 'domain' | 'impact' | 'route' | 'type' | 'file' | 'list' | 'pattern';

export interface ClassificationResult {
  strategy: QueryStrategy;
  functionName: string | null;
  keywords: string[];
  domain: string | null;
  direction: 'callers' | 'callees' | null;
  typeName: string | null;
  filePath: string | null;
  routePath: string | null;
  routeMethod: string | null;
  listEntity: string | null;
}

const CLASSIFICATION_PROMPT = `You are a question classifier for a code intelligence system. Given a developer's question about a TypeScript codebase, classify it into exactly one category and extract key parameters.

Categories:
1. "direct" - Question asks about a specific function by name (e.g., "What does login do?")
2. "relationship" - Question asks about what calls or is called by a function (e.g., "What calls login?")
3. "semantic" - Question asks about a concept, topic, or behavior (e.g., "How is authentication handled?")
4. "domain" - Question asks about a category of functions (e.g., "Show all database operations")
5. "impact" - Question asks about what would be affected by changes (e.g., "What breaks if I change validateEmail?")
6. "route" - Question asks about HTTP routes/endpoints (e.g., "What does the /api/users endpoint do?", "What routes exist?")
7. "type" - Question asks about a type, interface, or enum (e.g., "What is the User type?", "Show me the Request interface")
8. "file" - Question asks about a specific file or its contents (e.g., "What does auth.ts do?", "What's in the config file?")
9. "list" - Question asks to enumerate/list entities (e.g., "List all routes", "What functions exist?", "Show all types")
10. "pattern" - Question asks about patterns or cross-cutting concerns spanning multiple entities (e.g., "How does the login flow work?", "How are errors handled?")

Respond ONLY with JSON, no markdown:
{
  "strategy": "direct|relationship|semantic|domain|impact|route|type|file|list|pattern",
  "function_name": "extracted function name or null",
  "keywords": ["relevant", "search", "terms"],
  "domain": "authentication|database|validation|routing|middleware|utility|logging|session|crypto|ui|api|config|testing|other or null",
  "direction": "callers|callees|null",
  "type_name": "extracted type/interface/enum name or null",
  "file_path": "extracted file path or null",
  "route_path": "extracted route path like /api/users or null",
  "route_method": "GET|POST|PUT|DELETE|PATCH or null",
  "list_entity": "functions|routes|types|files|constants or null"
}`;

function baseResult(overrides: Partial<ClassificationResult>): ClassificationResult {
  return {
    strategy: 'semantic',
    functionName: null,
    keywords: [],
    domain: null,
    direction: null,
    typeName: null,
    filePath: null,
    routePath: null,
    routeMethod: null,
    listEntity: null,
    ...overrides,
  };
}

function cleanIdentifier(s: string): string {
  return s.replace(/[`'"]/g, '').trim();
}

function extractFilePath(q: string): string | null {
  const m = q.match(/\b([\w./\\-]+\.(?:ts|tsx|js|jsx))\b/i);
  return m ? m[1] : null;
}

function matchListEntity(lower: string): string | null {
  if (/\b(all\s+)?routes?\b/.test(lower) && !/\bwhat\s+calls?\b/.test(lower)) return 'routes';
  if (/\b(all\s+)?types?\b/.test(lower) && !/\bwhat\s+(?:is|are)\s+the\b/.test(lower) && !/\bcalls?\b/.test(lower)) return 'types';
  if (/\b(all\s+)?(?:interfaces?|enums?)\b/.test(lower) && !/\bcalls?\b/.test(lower)) return 'types';
  if (/\b(all\s+)?(?:files?|modules?)\b/.test(lower) && !/\bwhat(?:'s|\s+is)\b/.test(lower) && !/\bcalls?\b/.test(lower)) return 'files';
  if (/\b(all\s+)?constants?\b/.test(lower) && !/\bcalls?\b/.test(lower)) return 'constants';
  return null;
}

// Priority order (high → low):
//   1. Relationship (callers / callees / "depends on") — must beat list so
//      "what functions call X" routes to relationship, not list.
//   2. Impact — "what breaks if I change X"
//   3. Direct — "what does X do"
//   4. File — "what's in foo.ts"
//   5. Route — explicit HTTP method or /api/... pattern
//   6. Type — "what is the Foo type/interface"
//   7. List — "list all routes / show all types"  (last, so it doesn't shadow above)
export function classifyQuestionFastPath(question: string): ClassificationResult | null {
  const q = question.trim();
  const lower = q.toLowerCase();

  // 1a. Callers — "what calls X", "which functions call X", "who calls X"
  const callers =
    q.match(/\b(?:what|who|which\s+functions?)\s+calls?\s+[`'"]?([A-Za-z_$][\w.$]*)[`'"]?/i) ||
    q.match(/\bcallers?\s+(?:of|for)\s+[`'"]?([A-Za-z_$][\w.$]*)[`'"]?/i);
  if (callers) {
    return baseResult({ strategy: 'relationship', functionName: cleanIdentifier(callers[1]), direction: 'callers' });
  }

  // 1b. Callees — "what does X call", "what does X depend on", "what functions does X use"
  const callees =
    q.match(/\bwhat\s+does\s+[`'"]?([A-Za-z_$][\w.$]*)[`'"]?\s+(?:call|depend\s+on|use)\b/i) ||
    q.match(/\bwhat\s+(?:functions?|methods?)\s+does\s+[`'"]?([A-Za-z_$][\w.$]*)[`'"]?\s+(?:call|use|depend\s+on)\b/i) ||
    q.match(/\bdependencies\s+(?:of|for)\s+[`'"]?([A-Za-z_$][\w.$]*)[`'"]?/i);
  if (callees) {
    return baseResult({ strategy: 'relationship', functionName: cleanIdentifier(callees[1]), direction: 'callees' });
  }

  // 2. Impact
  const impact =
    q.match(/\b(?:if\s+i\s+change|what\s+breaks\s+if\s+i\s+change|change\s+impact\s+for)\s+[`'"]?([A-Za-z_$][\w.$]*)[`'"]?/i) ||
    q.match(/\b(?:what\s+is\s+affected\s+by|impact\s+of|affected\s+by)\s+[`'"]?([A-Za-z_$][\w.$]*)[`'"]?/i);
  if (impact) {
    return baseResult({ strategy: 'impact', functionName: cleanIdentifier(impact[1]) });
  }

  // 3. Direct — "what does X do", "explain X"
  const direct =
    q.match(/\bwhat\s+does\s+[`'"]?([A-Za-z_$][\w.$]*)[`'"]?\s+do\b/i) ||
    q.match(/\bexplain\s+[`'"]?([A-Za-z_$][\w.$]*)[`'"]?\b/i);
  if (direct) {
    return baseResult({ strategy: 'direct', functionName: cleanIdentifier(direct[1]) });
  }

  // 4. File
  const filePath = extractFilePath(q);
  if (filePath && /\b(what'?s|what\s+is|show|list|inside|in|contents?)\b/i.test(q)) {
    return baseResult({ strategy: 'file', filePath });
  }

  // 5. Route — explicit HTTP verb + path, or bare /api/... reference
  const routeWithMethod = q.match(/\b(GET|POST|PUT|DELETE|PATCH|ALL|USE)\s+(\/[^\s"'`?]+)/i);
  if (routeWithMethod) {
    return baseResult({ strategy: 'route', routeMethod: routeWithMethod[1].toUpperCase(), routePath: routeWithMethod[2] });
  }
  const bareRoute =
    q.match(/(?:route|endpoint)\s+(\/[^\s"'`?]+)/i) ||
    q.match(/(\/api\/[^\s"'`?]+)/i);
  if (bareRoute) {
    return baseResult({ strategy: 'route', routePath: bareRoute[1] });
  }

  // 6. Type
  const typeName =
    q.match(/\b(?:type|interface|enum)\s+[`'"]?([A-Za-z_$][\w$]*)[`'"]?/i) ||
    q.match(/\bwhat\s+is\s+the\s+[`'"]?([A-Z][\w$]*)[`'"]?\s+(?:type|interface|enum)\b/i);
  if (typeName) {
    return baseResult({ strategy: 'type', typeName: cleanIdentifier(typeName[1]) });
  }

  // 7. List — checked last so it can't shadow relationship/callers patterns
  const listEntity = matchListEntity(lower);
  if (listEntity) {
    return baseResult({ strategy: 'list', listEntity });
  }

  return null;
}

export async function classifyQuestion(
  question: string,
  model: string,
  llmConfig: LlmClientConfig,
): Promise<ClassificationResult> {
  const fastPath = classifyQuestionFastPath(question);
  if (fastPath) return fastPath;

  const client = createLlmClient(llmConfig);

  const { text } = await client.complete({
    model,
    prompt: `${CLASSIFICATION_PROMPT}\n\nQuestion: "${question}"`,
    maxTokens: 200,
  });

  try {
    const cleaned = text.replace(/^```json?\s*/m, '').replace(/```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      strategy: parsed.strategy || 'semantic',
      functionName: parsed.function_name || null,
      keywords: parsed.keywords || [],
      domain: parsed.domain || null,
      direction: parsed.direction || null,
      typeName: parsed.type_name || null,
      filePath: parsed.file_path || null,
      routePath: parsed.route_path || null,
      routeMethod: parsed.route_method || null,
      listEntity: parsed.list_entity || null,
    };
  } catch {
    // Fallback to semantic search
    return {
      strategy: 'semantic',
      functionName: null,
      keywords: question.split(/\s+/).filter(w => w.length > 3),
      domain: null,
      direction: null,
      typeName: null,
      filePath: null,
      routePath: null,
      routeMethod: null,
      listEntity: null,
    };
  }
}
