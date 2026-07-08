// Static analysis: duplicates, overlaps, shadowed rules, gaps. Spec §16.
// Pure functions over the intermediate model (no dmn-moddle).

/** Parse a numeric unary test into an interval [lo, hi] (inclusive flags). null = unanalyzable. */
function numericInterval(text) {
  const t = text.trim();
  if (t === '' || t === '-') return { lo: -Infinity, hi: Infinity, loInc: true, hiInc: true };
  let mm;
  if ((mm = t.match(/^(-?\d+(?:\.\d+)?)$/)))
    return { lo: +mm[1], hi: +mm[1], loInc: true, hiInc: true };
  if ((mm = t.match(/^<\s*(-?\d+(?:\.\d+)?)$/)))
    return { lo: -Infinity, hi: +mm[1], loInc: true, hiInc: false };
  if ((mm = t.match(/^<=\s*(-?\d+(?:\.\d+)?)$/)))
    return { lo: -Infinity, hi: +mm[1], loInc: true, hiInc: true };
  if ((mm = t.match(/^>\s*(-?\d+(?:\.\d+)?)$/)))
    return { lo: +mm[1], hi: Infinity, loInc: false, hiInc: true };
  if ((mm = t.match(/^>=\s*(-?\d+(?:\.\d+)?)$/)))
    return { lo: +mm[1], hi: Infinity, loInc: true, hiInc: true };
  if ((mm = t.match(/^([[(])\s*(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)\s*([\])])$/)))
    return { lo: +mm[2], hi: +mm[3], loInc: mm[1] === '[', hiInc: mm[4] === ']' };
  return null; // list / expression: unanalyzable
}

function intervalsIntersect(a, b) {
  if (a === null || b === null) return true; // unanalyzable ⇒ assume possible overlap
  const lo = Math.max(a.lo, b.lo);
  const hi = Math.min(a.hi, b.hi);
  if (lo > hi) return false;
  if (lo === hi) {
    const aInc = a.lo === lo ? a.loInc : a.hi === lo ? a.hiInc : true;
    const bInc = b.lo === lo ? b.loInc : b.hi === lo ? b.hiInc : true;
    return aInc && bInc;
  }
  return true;
}

/** Set of listed string/enum values a cell matches, or null if unanalyzable. */
function stringSet(text, domain) {
  const t = text.trim();
  if (t === '' || t === '-') return domain ? new Set(domain) : null;
  const m = t.match(/^"([^"]*)"$/);
  if (m) return new Set([m[1]]);
  const list = t.match(/^("[^"]*"\s*,\s*)*"[^"]*"$/);
  if (list) return new Set(t.split(',').map((s) => s.trim().replace(/^"|"$/g, '')));
  // bare token that is a member of the domain (e.g. boolean true/false, unquoted enum)
  if (domain && domain.includes(t)) return new Set([t]);
  // comma list of bare domain members
  if (domain && t.split(',').every((x) => domain.includes(x.trim())))
    return new Set(t.split(',').map((x) => x.trim()));
  return null; // negation/expression: unanalyzable
}

function parseDomain(allowedValues, typeRef) {
  if (!allowedValues) return typeRef === 'boolean' ? ['true', 'false'] : null;
  if (NUMERIC.has(typeRef)) return null; // numeric domains handled as intervals
  return allowedValues.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
}

const NUMERIC = new Set(['number', 'integer', 'long', 'double']);

function cellsIntersect(aText, bText, typeRef, domain) {
  if (NUMERIC.has(typeRef))
    return intervalsIntersect(numericInterval(aText), numericInterval(bText));
  const A = stringSet(aText, domain);
  const B = stringSet(bText, domain);
  if (A === null || B === null) return true; // unanalyzable
  for (const v of A) if (B.has(v)) return true;
  return false;
}

/** Two rules overlap iff every input column's matching sets intersect. */
function rulesOverlap(r1, r2, inputs) {
  return inputs.every((inp, i) =>
    cellsIntersect(
      r1.inputEntries[i],
      r2.inputEntries[i],
      inp.typeRef,
      parseDomain(inp.allowedValues, inp.typeRef),
    ),
  );
}

export function analyzeModel(model, cfg) {
  const d = model.decisions[0];
  const checks = new Set(cfg.analysis.checks);
  const findings = [];
  const { inputs, rules, hitPolicy } = d;

  // duplicates
  if (checks.has('duplicate')) {
    const seen = new Map();
    for (const r of rules) {
      const key = JSON.stringify(r.inputEntries);
      if (seen.has(key))
        findings.push({
          check: 'duplicate',
          severity: 'warning',
          message: `rules ${seen.get(key)} and ${r.id} have identical inputs`,
        });
      else seen.set(key, r.id);
    }
  }

  // overlaps (UNIQUE conflict / ANY differing outputs)
  if (checks.has('overlap') && ['UNIQUE', 'ANY'].includes(hitPolicy)) {
    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        if (rulesOverlap(rules[i], rules[j], inputs)) {
          const sameOut =
            JSON.stringify(rules[i].outputEntries) === JSON.stringify(rules[j].outputEntries);
          if (hitPolicy === 'UNIQUE' || !sameOut)
            findings.push({
              check: 'overlap',
              severity: hitPolicy === 'UNIQUE' ? 'error' : 'warning',
              message: `rules ${rules[i].id} and ${rules[j].id} (sheet rows ${rules[i].row} and ${rules[j].row}) can both match (${hitPolicy} conflict)`,
            });
        }
      }
    }
  }

  // shadowed (FIRST): a rule fully covered by earlier ones
  if (checks.has('shadowed') && hitPolicy === 'FIRST') {
    for (let j = 1; j < rules.length; j++) {
      const covered = rules
        .slice(0, j)
        .some((prev) => rulesOverlap(prev, rules[j], inputs) && dominates(prev, rules[j], inputs));
      if (covered)
        findings.push({
          check: 'shadowed',
          severity: 'warning',
          message: `rule ${rules[j].id} may be shadowed by an earlier rule (FIRST)`,
        });
    }
  }

  // gaps: only when every input has a finite domain
  if (checks.has('gaps')) {
    const domains = inputs.map((inp) =>
      NUMERIC.has(inp.typeRef) ? null : parseDomain(inp.allowedValues, inp.typeRef),
    );
    if (domains.every((d2) => Array.isArray(d2))) {
      const total = domains.reduce((n, dom) => n * dom.length, 1);
      if (total <= cfg.analysis.gapsMaxCombos) {
        const uncovered = enumerateGaps(domains, rules, inputs);
        for (const combo of uncovered.slice(0, 20))
          findings.push({
            check: 'gaps',
            severity: 'warning',
            message: `no rule covers inputs [${combo.join(', ')}]`,
          });
        if (uncovered.length)
          findings.push({
            check: 'gaps',
            severity: 'info',
            message: `coverage ${(((total - uncovered.length) / total) * 100).toFixed(1)}% (${uncovered.length} of ${total} combinations uncovered)`,
          });
      }
    }
  }

  return { decisionId: d.id, findings };
}

function dominates(prev, rule, inputs) {
  // prev dominates rule if prev's matching set ⊇ rule's on every column (conservative)
  return inputs.every((inp, i) => {
    const p = prev.inputEntries[i].trim();
    return p === '' || p === '-' || p === rule.inputEntries[i].trim();
  });
}

function enumerateGaps(domains, rules, inputs) {
  const uncovered = [];
  const rec = (idx, combo) => {
    if (idx === domains.length) {
      const matched = rules.some((r) =>
        inputs.every((inp, i) => {
          const set = stringSet(r.inputEntries[i], domains[i]);
          return set === null || set.has(combo[i]);
        }),
      );
      if (!matched) uncovered.push([...combo]);
      return;
    }
    for (const v of domains[idx]) rec(idx + 1, [...combo, v]);
  };
  rec(0, []);
  return uncovered;
}

export function formatAnalysis(analyses, format) {
  const flat = analyses.flatMap((a) => a.findings.map((f) => ({ ...f, decisionId: a.decisionId })));
  if (format === 'json') return JSON.stringify(analyses, null, 2);
  if (format === 'junit') {
    const cases = flat
      .map(
        (f) =>
          `  <testcase name="${f.decisionId}:${f.check}"><failure message="${escapeXml(f.message)}"/></testcase>`,
      )
      .join('\n');
    return `<?xml version="1.0"?>\n<testsuite name="excel2dmn analysis" tests="${flat.length}">\n${cases}\n</testsuite>`;
  }
  if (!flat.length) return 'Analysis: no issues found.';
  return flat.map((f) => `[${f.severity}] ${f.decisionId} (${f.check}): ${f.message}`).join('\n');
}

function escapeXml(s) {
  return s.replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
  );
}
