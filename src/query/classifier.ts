import type { LLMProvider } from '../providers/interface';
import { normalizeRepoPath } from '../utils/paths';

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

const classifierCache = new Map<string, ClassificationResult>();

export function classifyQuestionFastPath(question: string): ClassificationResult | null {
  const q = question.trim();
  const lower = q.toLowerCase();

  const listEntity = matchListEntity(lower);
  if (listEntity) {
    return baseResult({ strategy: 'list', listEntity });
  }

  const filePath = extractFilePath(q);
  if (filePath && /\b(what'?s|what is|show|list|inside|in|contents?)\b/i.test(q)) {
    return baseResult({ strategy: 'file', filePath });
  }

  const routePath = q.match(/\b(GET|POST|PUT|DELETE|PATCH|ALL|USE)\s+(\/[^\s"'`?]+)/i);
  if (routePath) {
    return baseResult({ strategy: 'route', routeMethod: routePath[1].toUpperCase(), routePath: routePath[2] });
  }
  const bareRoute = q.match(/(?:route|endpoint)\s+(\/[^\s"'`?]+)/i) || q.match(/(\/api\/[^\s"'`?]+)/i);
  if (bareRoute) {
    return baseResult({ strategy: 'route', routePath: bareRoute[1] });
  }

  const impact = q.match(/\b(?:if i change|what breaks if i change|change impact for)\s+[`'"]?([A-Za-z_$][\w.$]*)[`'"]?/i) ||
    q.match(/\b(?:what is affected by|impact of|affected by)\s+[`'"]?([A-Za-z_$][\w.$]*)[`'"]?/i);
  if (impact) {
    return baseResult({ strategy: 'impact', functionName: cleanIdentifier(impact[1]) });
  }

  const direct = q.match(/\bwhat\s+does\s+[`'"]?([A-Za-z_$][\w.$]*)[`'"]?\s+do\b/i) ||
    q.match(/\bexplain\s+[`'"]?([A-Za-z_$][\w.$]*)[`'"]?\b/i);
  if (direct) {
    return baseResult({ strategy: 'direct', functionName: cleanIdentifier(direct[1]) });
  }

  const callers = q.match(/\b(?:what|who|which functions?)\s+calls?\s+[`'"]?([A-Za-z_$][\w.$]*)[`'"]?/i) ||
    q.match(/\bcallers?\s+(?:of|for)\s+[`'"]?([A-Za-z_$][\w.$]*)[`'"]?/i);
  if (callers) {
    return baseResult({ strategy: 'relationship', functionName: cleanIdentifier(callers[1]), direction: 'callers' });
  }

  const callees = q.match(/\bwhat\s+does\s+[`'"]?([A-Za-z_$][\w.$]*)[`'"]?\s+call\b/i) ||
    q.match(/\bwhat\s+is\s+called\s+by\s+[`'"]?([A-Za-z_$][\w.$]*)[`'"]?/i);
  if (callees) {
    return baseResult({ strategy: 'direct', functionName: cleanIdentifier(callees[1]) });
  }

  const typeName = q.match(/\b(?:type|interface|enum)\s+[`'"]?([A-Za-z_$][\w$]*)[`'"]?/i) ||
    q.match(/\bwhat\s+is\s+the\s+[`'"]?([A-Z][\w$]*)[`'"]?\s+(?:type|interface|enum)\b/i);
  if (typeName) {
    return baseResult({ strategy: 'type', typeName: cleanIdentifier(typeName[1]) });
  }

  return null;
}

export async function classifyQuestion(
  question: string,
  model: string,
  provider: LLMProvider
): Promise<ClassificationResult> {
  const fastPath = classifyQuestionFastPath(question);
  if (fastPath) return fastPath;

  const cacheKey = question.trim().toLowerCase();
  const cached = classifierCache.get(cacheKey);
  if (cached) return cached;

  const response = await provider.chat({
    model,
    maxTokens: 200,
    messages: [
      { role: 'user', content: `${CLASSIFICATION_PROMPT}\n\nQuestion: "${question}"` },
    ],
  });

  try {
    const cleaned = response.text.replace(/^```json?\s*/m, '').replace(/```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned);
    const result: ClassificationResult = {
      strategy: normalizeStrategy(parsed.strategy),
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
    classifierCache.set(cacheKey, result);
    return result;
  } catch {
    // Fallback to semantic search
    const result: ClassificationResult = {
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
    classifierCache.set(cacheKey, result);
    return result;
  }
}

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

function matchListEntity(lower: string): string | null {
  if (!/\b(list|show|what|which|all)\b/.test(lower)) return null;
  if (/\b(routes?|endpoints?)\b/.test(lower)) return 'routes';
  if (/\b(types?|interfaces?|enums?)\b/.test(lower)) return 'types';
  if (/\bfiles?\b/.test(lower)) return 'files';
  if (/\bfunctions?\b/.test(lower)) return 'functions';
  if (/\bconstants?\b/.test(lower)) return 'constants';
  return null;
}

function extractFilePath(question: string): string | null {
  const match = question.match(/([A-Za-z0-9_.\-\\/]+\.tsx?)/);
  return match ? normalizeRepoPath(match[1]) : null;
}

function cleanIdentifier(value: string): string {
  return value.replace(/^[`'"]|[`'".,?!:;]+$/g, '');
}

function normalizeStrategy(value: unknown): QueryStrategy {
  const strategies: QueryStrategy[] = ['direct', 'relationship', 'semantic', 'domain', 'impact', 'route', 'type', 'file', 'list', 'pattern'];
  return strategies.includes(value as QueryStrategy) ? value as QueryStrategy : 'semantic';
}
