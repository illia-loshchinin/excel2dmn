// Readable, deterministic identifiers (see spec §6.4). No random-id library.

const FOLD = { ł: 'l', Ł: 'L', ø: 'o', Ø: 'O', đ: 'd', Đ: 'D', ß: 'ss' };

/**
 * Normalize an arbitrary string into an NCName-safe UPPER_SNAKE_CASE id.
 * No-op when the value is already an identifier (e.g. `SHIPPING_RATES`).
 */
export function toNcNameId(value, { foldMap = FOLD, upper = true } = {}) {
  let out = String(value)
    .replace(/[łŁøØđĐß]/g, (c) => foldMap[c] || c)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks (ó→o, ą→a, ś→s…)
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (upper) out = out.toUpperCase();
  return out.replace(/^([0-9])/, '_$1'); // NCName must not start with a digit
}

/** 1-based column index → spreadsheet letter (1→A, 19→S, 27→AA). */
export function colLetter(index) {
  let n = index;
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

/** Human-readable cell reference, e.g. `Sheet1!S3`. */
export function cellRef(sheet, row, col) {
  return `${sheet}!${colLetter(col)}${row}`;
}

/** Ensure ids are unique across a decision by suffixing _2, _3, … */
export function dedupe(id, seen, suffix = '_') {
  if (!seen.has(id)) {
    seen.add(id);
    return id;
  }
  let n = 2;
  let candidate = `${id}${suffix}${n}`;
  while (seen.has(candidate)) {
    n += 1;
    candidate = `${id}${suffix}${n}`;
  }
  seen.add(candidate);
  return candidate;
}
