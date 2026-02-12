const VALID_DOMAINS = new Set([
  'authentication', 'database', 'validation', 'routing', 'middleware',
  'utility', 'logging', 'session', 'crypto', 'ui', 'api', 'config',
  'testing', 'other',
]);

const VALID_COMPLEXITY = new Set(['low', 'medium', 'high']);

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
      side_effects: item.side_effects.map((s: any) => sanitizeText(String(s))),
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
