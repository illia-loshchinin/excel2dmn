import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import {
  PROMPTS,
  ALLOWED_VALUES_PATHS,
  buildConfig,
  diffConfig,
  serializeConfig,
  parseAnswer,
  promptDefault,
  promptChoices,
  getPath,
} from '../src/init-config.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Enumerate every leaf dot-path of a config object (arrays/null are leaves). */
function flattenLeaves(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flattenLeaves(v, path));
    else out.push(path);
  }
  return out;
}

// Leaves deliberately NOT exposed in the wizard (edited by hand if ever needed).
// Every entry has a rationale so the completeness test stays a conscious gate.
const INTENTIONALLY_UNPROMPTED = {
  'header.nameOffset': 'raw offset — advanced layout, edit by hand',
  'header.typeOffset': 'raw offset — advanced layout, edit by hand',
  'rules.detectBy': 'single supported strategy',
  'rules.anyInputTokens': 'rarely changed; list of literals',
  'rules.emitAnyInputAs': 'coupled to anyInputTokens internals',
  'identity.collisionSuffix': 'cosmetic id-collision detail',
  'hitPolicy.allowed': 'the fixed DMN hit-policy vocabulary',
  'hitPolicy.aggregatorOffset': 'raw offset',
  'types.anyKeyword': 'FEEL keyword, not user-facing',
  'types.anyAliases': 'untyped-column alias vocabulary; deep type tuning',
  'types.anyDmnPlaceholder': 'untyped typeRef emission detail; deep type tuning',
  'types.allowed': 'the fixed DMN/FEEL type vocabulary',
  'types.numeric': 'derived type grouping',
  'types.camundaTypes': 'fixed Camunda capability set',
  'types.syntaxOnly': 'fixed type grouping',
  'types.number.allowExpressions': 'deep FEEL tuning',
  'types.string.allowExpressions': 'deep FEEL tuning',
  'types.boolean.allowExpressions': 'deep FEEL tuning',
  'outputEntries.requireQuotes': 'paired with autoQuote, which is prompted',
  'output.expressionLanguage': 'fixed FEEL URI',
  'output.typeLanguage': 'fixed FEEL URI',
  'output.shape.x': 'DI shape geometry',
  'output.shape.y': 'DI shape geometry',
  'output.shape.width': 'DI shape geometry',
  'output.shape.height': 'DI shape geometry',
  'analysis.checks': 'fixed set of analysis checks',
  'analysis.gapsMaxCombos': 'performance guard rail',
};

describe('config example file', () => {
  it('matches the serialized DEFAULT_CONFIG (drift guard)', () => {
    const onDisk = readFileSync(join(repoRoot, 'excel2dmn.config.example.json'), 'utf8');
    expect(onDisk).toBe(serializeConfig(DEFAULT_CONFIG));
  });
});

describe('buildConfig defaults path', () => {
  it('returns the full default config with { defaults: true }', async () => {
    const cfg = await buildConfig({ defaults: true, full: true });
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });
});

describe('wizard coverage (no silent drift)', () => {
  const promptedPaths = new Set(
    PROMPTS.filter((s) => s.path)
      .map((s) => s.path)
      .concat(ALLOWED_VALUES_PATHS),
  );

  it('covers every leaf of DEFAULT_CONFIG via a prompt or the allowlist', () => {
    const uncovered = flattenLeaves(DEFAULT_CONFIG).filter(
      (p) => !promptedPaths.has(p) && !(p in INTENTIONALLY_UNPROMPTED),
    );
    expect(uncovered).toEqual([]);
  });

  it('has no stale entries in the unprompted allowlist', () => {
    const allLeaves = new Set(flattenLeaves(DEFAULT_CONFIG));
    const stale = Object.keys(INTENTIONALLY_UNPROMPTED).filter((p) => !allLeaves.has(p));
    expect(stale).toEqual([]);
  });

  it('enum prompts default to one of their offered choices', () => {
    for (const spec of PROMPTS.filter((s) => s.type === 'enum')) {
      expect(promptChoices(spec)).toContain(promptDefault(spec));
    }
  });

  it('config-sourced enum choices match the config list', () => {
    for (const spec of PROMPTS.filter((s) => s.choicesFrom)) {
      expect(promptChoices(spec)).toEqual(getPath(DEFAULT_CONFIG, spec.choicesFrom));
    }
  });
});

describe('parseAnswer', () => {
  const def = 'DFLT';
  it('accepts default on empty input', () => {
    expect(parseAnswer({ type: 'string' }, '', def)).toEqual({ value: def });
  });
  it('parses booleans and rejects junk', () => {
    expect(parseAnswer({ type: 'boolean' }, 'y', false)).toEqual({ value: true });
    expect(parseAnswer({ type: 'boolean' }, 'no', true)).toEqual({ value: false });
    expect(parseAnswer({ type: 'boolean' }, 'maybe', false).error).toBeTruthy();
  });
  it('parses nullable-string', () => {
    expect(parseAnswer({ type: 'nullable-string' }, 'null', 'x')).toEqual({ value: null });
    expect(parseAnswer({ type: 'nullable-string' }, 'out', null)).toEqual({ value: 'out' });
  });
  it('parses enum by index and by value', () => {
    const spec = { type: 'enum', choices: ['a', 'b', 'c'] };
    expect(parseAnswer(spec, '2', 'a')).toEqual({ value: 'b' });
    expect(parseAnswer(spec, 'C', 'a')).toEqual({ value: 'c' });
    expect(parseAnswer(spec, '9', 'a').error).toBeTruthy();
  });
  it('parses numbers and lists', () => {
    expect(parseAnswer({ type: 'number' }, '7', 5)).toEqual({ value: 7 });
    expect(parseAnswer({ type: 'number' }, 'nope', 5).error).toBeTruthy();
    expect(parseAnswer({ type: 'list' }, 'a, b ,c', [])).toEqual({ value: ['a', 'b', 'c'] });
  });
});

describe('diffConfig', () => {
  it('keeps only leaves that differ from the base', () => {
    const merged = deepMerge(DEFAULT_CONFIG, { hitPolicy: { default: 'FIRST' } });
    expect(diffConfig(DEFAULT_CONFIG, merged)).toEqual({ hitPolicy: { default: 'FIRST' } });
  });
  it('is empty when nothing changed', () => {
    expect(diffConfig(DEFAULT_CONFIG, deepMerge(DEFAULT_CONFIG, {}))).toEqual({});
  });
});

/** Drive the interactive wizard with scripted answer lines. */
async function runWizard(lines, { full = false } = {}) {
  const queue = [...lines];
  const prompt = async () => {
    if (!queue.length) throw new Error('wizard asked more prompts than scripted');
    return queue.shift();
  };
  const output = { write() {} };
  return buildConfig({ prompt, output, full });
}

describe('interactive wizard', () => {
  // Essentials order: sheet.value, sheet.match, sheet.caseInsensitive,
  // markers.id, markers.name, markers.input, markers.output, markers.policy,
  // markers.annotations, allowed-values, hitPolicy.default,
  // output.outDir, output.writeModelJson, then the advanced gate.
  const acceptAllEssentials = ['', '', '', '', '', '', '', '', ''];

  it('applies overrides and leaves the rest at defaults (minimal diff)', async () => {
    const cfg = await runWizard([
      'RULES', // sheet.value
      '', // sheet.match
      '', // sheet.caseInsensitive
      'KEY', // markers.id
      '', // markers.name
      '', // markers.input
      '', // markers.output
      '', // markers.policy
      '', // markers.annotations
      'y', // enable allowed-values
      'FIRST', // hit policy
      'out', // output.outDir
      'y', // writeModelJson
      'n', // advanced gate → no
    ]);
    expect(cfg).toEqual({
      sheet: { value: 'RULES' },
      markers: { id: 'KEY' },
      header: { allowedValuesOffset: 3, labelOffset: 4 },
      rules: { startOffset: 5 },
      hitPolicy: { default: 'FIRST' },
      output: { outDir: 'out', writeModelJson: true },
    });
  });

  it('accepting every default yields an empty diff', async () => {
    const cfg = await runWizard([...acceptAllEssentials, '', '', '', '', 'n']);
    expect(cfg).toEqual({});
  });

  it('full mode returns a config that merges cleanly over defaults', async () => {
    const cfg = await runWizard([...acceptAllEssentials, '', 'FIRST', '', '', 'n'], { full: true });
    expect(cfg.hitPolicy.default).toBe('FIRST');
    expect(cfg.markers.id).toBe('id'); // untouched default present in full mode
    expect(deepMerge(DEFAULT_CONFIG, cfg)).toEqual(cfg); // already a full config
  });
});
