// Type-aware FEEL validation of cell entries (spec §3b). Static — no evaluation.
import { parseUnaryTests, parseExpression } from 'feelin';
import { isAnyType } from './config.js';

/** Parse a FEEL string, returning literal leaf kinds + whether it has a syntax error. */
export function analyzeFeel(text, unit /* 'unary' | 'expression' */) {
  const tree = unit === 'unary' ? parseUnaryTests(text) : parseExpression(text);
  const kinds = new Set();
  let hasError = false;
  const cursor = tree.cursor();
  do {
    if (cursor.type.isError) hasError = true;
    if (/Literal$|^Wildcard$|^VariableName$/.test(cursor.type.name)) kinds.add(cursor.type.name);
  } while (cursor.next());
  return { kinds, hasError };
}

/**
 * Validate one entry against a column's typeRef.
 * @returns {string|null} an error message, or null when valid.
 */
export function validateEntry(text, typeRef, unit, cfg) {
  if (text === '' || text === '-') return null; // wildcard / irrelevant
  const syntaxOnly = new Set(cfg.types.syntaxOnly);
  const isAny = isAnyType(typeRef, cfg);
  const { kinds, hasError } = analyzeFeel(text, unit);
  if (hasError) return 'invalid FEEL syntax';
  if (isAny || syntaxOnly.has(typeRef)) return null; // syntax-only types
  const has = (k) => kinds.has(k);
  const numeric = new Set(cfg.types.numeric || ['number']);
  if (numeric.has(typeRef)) {
    if (has('StringLiteral') || has('BooleanLiteral')) return `expected a valid ${typeRef}`;
    if (has('VariableName') && !cfg.types.number.allowExpressions)
      return `expected a valid ${typeRef} (bare identifier not allowed)`;
    return null;
  }
  switch (typeRef) {
    case 'string':
      if (has('VariableName')) return `expected a quoted string (add quotes: "${text}")`;
      if (has('NumericLiteral') || has('BooleanLiteral')) return 'expected a quoted string';
      return null;
    case 'boolean':
      if (has('StringLiteral') || has('NumericLiteral') || has('VariableName'))
        return 'expected true or false';
      return null;
    default:
      return null;
  }
}

/** Memoizing validator keyed by (typeRef, unit, text) — decision tables repeat values heavily. */
export function createEntryValidator(cfg) {
  const cache = new Map();
  return function check(text, typeRef, unit) {
    const key = `${typeRef} ${unit} ${text}`;
    if (cache.has(key)) return cache.get(key);
    const result = validateEntry(text, typeRef, unit, cfg);
    cache.set(key, result);
    return result;
  };
}

/** Whether an output entry parses as a single quoted string literal (for requireQuotes). */
export function isStringLiteral(text) {
  const { kinds, hasError } = analyzeFeel(text, 'expression');
  return !hasError && kinds.has('StringLiteral') && !kinds.has('VariableName');
}
