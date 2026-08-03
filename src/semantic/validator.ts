const VALID_DOMAINS = new Set([
  'authentication', 'database', 'validation', 'routing', 'middleware',
  'utility', 'logging', 'session', 'crypto', 'ui', 'api', 'config',
  'testing', 'other',
]);

const VALID_COMPLEXITY = new Set(['low', 'medium', 'high']);

// Side effects are a filterable index, not prose. Left as free text, a model
// emits "DB writes", "network calls", "Network call to logout function" and
// "Sends JSON response" for what are really three concepts — so
// `structx query --side-effect write` matched one function and silently
// missed the rest. A closed vocabulary makes the filter mean something.
const VALID_SIDE_EFFECTS = new Set([
  'db_read', 'db_write', 'network', 'filesystem',
  'console', 'response', 'cache', 'state', 'process',
]);

// Map the free-text phrasings models actually produce onto the tags above, so
// a slightly off-script response is salvaged rather than discarded. Checked as
// substrings against the lowercased value, most specific first.
const SIDE_EFFECT_ALIASES: Array<[RegExp, string]> = [
  [/\b(db|database|sql|persist)\w*\s*(write|insert|update|delete|save)|write.*\b(db|database)\b/, 'db_write'],
  [/\b(db|database|sql)\w*\s*(read|query|select|fetch|lookup)|read.*\b(db|database)\b/, 'db_read'],
  [/\b(network|http|https|api call|rpc|fetch|request to|outbound)\b/, 'network'],
  [/\b(file\s?system|file write|file read|disk|fs\.)\b/, 'filesystem'],
  [/\b(console|stdout|stderr|log output|logging output)\b/, 'console'],
  [/\b(response|res\.|sends json|http response)\b/, 'response'],
  [/\bcache\b/, 'cache'],
  [/\b(mutat|global state|shared state|module state)\w*\b/, 'state'],
  [/\b(spawn|child process|process\.exit|environment variable)\b/, 'process'],
];

// Coerce one reported side effect to a known tag, or null to drop it.
function normalizeSideEffect(raw: string): string | null {
  const value = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (VALID_SIDE_EFFECTS.has(value)) return value;
  const spaced = value.replace(/_/g, ' ');
  if (spaced === 'none' || spaced === 'no side effects' || !spaced) return null;
  for (const [pattern, tag] of SIDE_EFFECT_ALIASES) {
    if (pattern.test(spaced)) return tag;
  }
  return null;
}

export function normalizeSideEffects(values: unknown[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const tag = normalizeSideEffect(String(value));
    if (tag) out.add(tag);
  }
  return [...out];
}

export interface SemanticResult {
  function_name: string;
  purpose: string;
  side_effects: string[];
  behavior: string;
  domain: string;
  complexity: string;
}

export interface ValidationResult {
  valid: boolean;
  results: SemanticResult[];
  errors: string[];
}

export function validateSemanticResponse(responseText: string): ValidationResult {
  const errors: string[] = [];

  // Try to extract JSON from the response
  let parsed: any;
  try {
    // Handle cases where LLM wraps in markdown code blocks
    const cleaned = responseText
      .replace(/^```json?\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (e: any) {
    return { valid: false, results: [], errors: [`JSON parse error: ${e.message}`] };
  }

  if (!Array.isArray(parsed)) {
    return { valid: false, results: [], errors: ['Response is not a JSON array'] };
  }

  const results: SemanticResult[] = [];
  const required = ['function_name', 'purpose', 'side_effects', 'behavior', 'domain', 'complexity'];

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];

    // Check required fields
    const missing = required.filter(f => !(f in item));
    if (missing.length > 0) {
      errors.push(`Item ${i}: missing fields: ${missing.join(', ')}`);
      continue;
    }

    // Validate types
    if (typeof item.function_name !== 'string' || !item.function_name.trim()) {
      errors.push(`Item ${i}: function_name must be a non-empty string`);
      continue;
    }
    if (typeof item.purpose !== 'string') {
      errors.push(`Item ${i}: purpose must be a string`);
      continue;
    }
    if (!Array.isArray(item.side_effects)) {
      // Auto-fix: wrap in array if it's a string
      if (typeof item.side_effects === 'string') {
        item.side_effects = item.side_effects ? [item.side_effects] : [];
      } else {
        errors.push(`Item ${i}: side_effects must be an array`);
        continue;
      }
    }
    if (typeof item.behavior !== 'string') {
      errors.push(`Item ${i}: behavior must be a string`);
      continue;
    }

    // Normalize domain
    const domain = item.domain?.toLowerCase().trim() || 'other';
    if (!VALID_DOMAINS.has(domain)) {
      item.domain = 'other';
    } else {
      item.domain = domain;
    }

    // Normalize complexity
    const complexity = item.complexity?.toLowerCase().trim() || 'medium';
    if (!VALID_COMPLEXITY.has(complexity)) {
      item.complexity = 'medium';
    } else {
      item.complexity = complexity;
    }

    results.push({
      function_name: item.function_name.trim(),
      purpose: sanitizeText(item.purpose),
      side_effects: normalizeSideEffects(item.side_effects),
      behavior: sanitizeText(item.behavior),
      domain: item.domain,
      complexity: item.complexity,
    });
  }

  return {
    valid: errors.length === 0 && results.length > 0,
    results,
    errors,
  };
}

function sanitizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
