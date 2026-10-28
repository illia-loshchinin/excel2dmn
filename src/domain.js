// Static allowed-values (domain) checks for `validation.enforceAllowedValues` (spec §3.6, §3b).
// Only literal scalars and numeric intervals are judged; anything else (comparisons,
// expressions, function calls, `not(...)`) is left alone — the check is advisory by design.

const NUM = String.raw`-?\d+(?:\.\d+)?`;
const INTERVAL = new RegExp(String.raw`^([\[\]\(])\s*(${NUM})\s*\.\.\s*(${NUM})\s*([\[\]\)])$`);

/** Split a FEEL list on top-level commas (outside strings and parentheses/braces). */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '(' || ch === '{') depth++;
    else if (ch === ')' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/** Classify one list item as a literal scalar or numeric interval; null when it is neither. */
function classify(item) {
  const str = item.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (str) return { kind: 'string', value: str[1] };
  if (new RegExp(`^${NUM}$`).test(item)) return { kind: 'number', value: Number(item) };
  if (item === 'true' || item === 'false') return { kind: 'boolean', value: item === 'true' };
  const iv = item.match(INTERVAL);
  if (iv)
    return {
      kind: 'interval',
      lo: Number(iv[2]),
      hi: Number(iv[3]),
      loOpen: iv[1] !== '[',
      hiOpen: iv[4] !== ']',
    };
  return null;
}

/** Parse an allowed-values cell into domain items, or null when it is not enforceable. */
export function parseDomain(text) {
  const items = splitTopLevel(text).map(classify);
  return items.every(Boolean) ? items : null;
}

function intervalHolds(d, lo, hi, loOpen, hiOpen) {
  const loOk = lo > d.lo || (lo === d.lo && (!d.loOpen || loOpen));
  const hiOk = hi < d.hi || (hi === d.hi && (!d.hiOpen || hiOpen));
  return loOk && hiOk;
}

function inDomain(v, domain) {
  if (v.kind === 'interval') {
    const ranges = domain.filter((d) => d.kind === 'interval');
    if (!ranges.length) return true; // a discrete domain cannot judge a range
    return ranges.some((d) => intervalHolds(d, v.lo, v.hi, v.loOpen, v.hiOpen));
  }
  return domain.some(
    (d) =>
      (d.kind === v.kind && d.value === v.value) ||
      (v.kind === 'number' && d.kind === 'interval' && intervalHolds(d, v.value, v.value)),
  );
}

/**
 * Items of an entry that fall outside the domain.
 * @param {'unary'|'expression'} unit input entries are unary-test lists; outputs one expression
 * @returns {string[]} the offending items (empty when everything passes or is not judged)
 */
export function outOfDomain(text, domain, unit) {
  if (text === '' || text === '-') return [];
  if (unit === 'unary' && /^not\s*\(/.test(text)) return [];
  const items = unit === 'unary' ? splitTopLevel(text) : [text.trim()];
  return items.filter((item) => {
    const v = classify(item);
    return v && !inDomain(v, domain);
  });
}
