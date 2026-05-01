// SQLite FTS5 query sanitizer.
//
// FTS5 MATCH treats characters like " * : ( ) - and bare words AND/OR/NOT/NEAR
// as syntax. Any unescaped occurrence in a user-supplied query throws
// "fts5: syntax error near ...". The classifier and retrievers feed
// LLM-extracted keywords straight into MATCH, so we sanitize here.
//
// Strategy: split on whitespace, strip FTS5-special chars from each token,
// drop tokens that are empty or are FTS5 keywords, then quote each surviving
// token as a phrase and join with OR.

const FTS5_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

export function sanitizeFtsTerms(terms: string[]): string {
  const cleaned: string[] = [];

  for (const raw of terms) {
    if (!raw) continue;
    // Split a multi-word term so each word is sanitized independently
    for (const part of String(raw).split(/\s+/)) {
      const stripped = part.replace(/["*:()\-^]/g, '').trim();
      if (!stripped) continue;
      if (FTS5_KEYWORDS.has(stripped.toUpperCase())) continue;
      // Wrap as a phrase so the inner content is treated as literal text.
      cleaned.push(`"${stripped}"`);
    }
  }

  return cleaned.join(' OR ');
}

// For free-form single-string queries (e.g. a user-typed name).
export function sanitizeFtsQuery(query: string): string {
  return sanitizeFtsTerms([query]);
}
