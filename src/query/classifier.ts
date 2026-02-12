import Anthropic from '@anthropic-ai/sdk';

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

export async function classifyQuestion(
  question: string,
  model: string,
  apiKey: string
): Promise<ClassificationResult> {
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: 200,
    messages: [
      { role: 'user', content: `${CLASSIFICATION_PROMPT}\n\nQuestion: "${question}"` },
    ],
  });

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => (block as any).text)
    .join('');

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
