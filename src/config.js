// Config loading: built-in defaults <- excel2dmn.config.json <- --config <- CLI flags.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  sheet: { match: 'contains', value: 'DMN', caseInsensitive: true },
  // Default: 4-row header (marker/name/type/label), rules start at M+4.
  // To use allowed values, set allowedValuesOffset: 3 and labelOffset: 4 and
  // rules.startOffset: 5 — i.e. the allowed-values row sits ABOVE the label row.
  header: { scanRows: 5, nameOffset: 1, typeOffset: 2, labelOffset: 3, allowedValuesOffset: null },
  markers: {
    id: 'id',
    name: 'name',
    input: 'input',
    output: 'output',
    policy: 'policy',
    annotations: 'annotations',
    annotationSeparator: ' | ',
    caseInsensitive: true,
  },
  rules: {
    startOffset: 4,
    detectBy: 'input-output',
    stopOnEmptyRow: true,
    idTemplate: 'rule_<n>', // <n> = 1-based rule index; <row> = Excel row
    // Input cells equal to any of these mean "any" (irrelevant). '' = an empty cell.
    anyInputTokens: ['-', ''],
    // What an "any" input entry is emitted as. '' -> <text></text> (renders as "-" in Camunda).
    emitAnyInputAs: '',
  },
  identity: { sanitizeId: true, idCase: 'upper', collisionSuffix: '_' },
  hitPolicy: {
    default: 'UNIQUE',
    allowed: ['UNIQUE', 'FIRST', 'PRIORITY', 'ANY', 'COLLECT', 'RULE ORDER', 'OUTPUT ORDER'],
    aggregatorOffset: 2,
  },
  types: {
    // Canonical wildcard type keyword (matches Camunda 8's documented "Any"). Used as
    // the normalized spelling on reverse import; the legacy spellings below are still
    // accepted case-insensitively on input.
    anyKeyword: 'Any',
    // Aliases (matched case-insensitively) all meaning the untyped/"Any" type.
    // Camunda/DMN tools variously emit 'Any', 'none' or 'object' for untyped columns.
    anyAliases: ['any', 'none', 'object'],
    // What typeRef to write for an "any"/untyped column in the emitted DMN.
    // null/'' -> omit the typeRef attribute entirely (Camunda renders it as "Any").
    // A string (e.g. 'Any') -> emit typeRef="<value>". Use one of anyAliases so the
    // result still round-trips back to "any" on import.
    anyDmnPlaceholder: null,
    allowed: [
      'string',
      'boolean',
      'number',
      'integer', // Camunda numeric types
      'long',
      'double',
      'Any',
      'date',
      'time',
      'dateTime',
      'dayTimeDuration',
      'yearMonthDuration',
    ],
    // typeRefs validated with the numeric rules (NumericLiteral)
    numeric: ['number', 'integer', 'long', 'double'],
    // Camunda 8's type set has no integer/long/double — only 'number'. On C8 output the
    // other numeric typeRefs are normalized to this. null → emit them unchanged.
    camunda8NumericAlias: 'number',
    // Types Camunda's decision-table editor/engine supports (plus 'any' = untyped).
    camundaTypes: ['string', 'boolean', 'integer', 'long', 'double', 'date'],
    // What to do when a typeRef is valid DMN/FEEL but NOT a Camunda type (e.g. 'number',
    // 'time', 'dateTime', durations): 'warn' (default), 'error', or 'off'.
    nonCamundaTypeAction: 'error',
    syntaxOnly: ['date', 'time', 'dateTime', 'dayTimeDuration', 'yearMonthDuration'],
    number: { allowExpressions: true },
    string: { allowExpressions: true },
    boolean: { allowExpressions: false },
  },
  validation: { feel: { mode: 'all-inputs', failFast: false }, enforceAllowedValues: false },
  outputEntries: { requireQuotes: true, autoQuote: false },
  // Target platform: 'camunda7' (DMN 1.3 + camunda: extension attrs, the default)
  // or 'camunda8' (Zeebe/SaaS: modeler execution-platform metadata, no camunda: attrs).
  platform: 'camunda7',
  // Camunda 7 extension attributes emitted on <decision>.
  camunda: { historyTimeToLive: 'P180D', versionTag: null },
  // Camunda 8 modeler metadata emitted on <definitions> when platform === 'camunda8'.
  camunda8: { executionPlatform: 'Camunda Cloud', executionPlatformVersion: '8.6.0' },
  output: {
    namespace: 'http://camunda.org/schema/1.0/dmn',
    expressionLanguage: 'https://www.omg.org/spec/DMN/20191111/FEEL/',
    typeLanguage: 'https://www.omg.org/spec/DMN/20191111/FEEL/',
    namespaceStyle: 'default',
    shape: { x: 160, y: 100, width: 180, height: 80 },
    format: true,
    outDir: null,
    fileNameTemplate: '<decisionId>.dmn',
    writeModelJson: false,
  },
  analysis: {
    enabled: false,
    checks: ['overlap', 'duplicate', 'shadowed', 'gaps'],
    failOn: 'none',
    format: 'text',
    gapsMaxCombos: 100000,
  },
});

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Whether a typeRef denotes the untyped ("Any") type. Matches any of
 * `cfg.types.anyAliases` case-insensitively (plus the canonical `anyKeyword`).
 * Returns false for empty/missing values so "missing typeRef" stays an error.
 */
export function isAnyType(typeRef, cfg) {
  if (!typeRef) return false;
  const aliases = cfg.types.anyAliases || [cfg.types.anyKeyword];
  const set = new Set([cfg.types.anyKeyword, ...aliases].map((t) => String(t).toLowerCase()));
  return set.has(String(typeRef).toLowerCase());
}

/** Deep-merge plain objects (arrays and scalars are replaced, not merged). */
export function deepMerge(base, override) {
  if (!isObject(override)) return override === undefined ? base : override;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    // guard against prototype pollution from untrusted config JSON
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/**
 * Resolve the effective config.
 * @param {object} opts
 * @param {string} [opts.configPath] explicit --config file
 * @param {string} [opts.cwd] working directory (for the default config file)
 * @param {object} [opts.overrides] CLI-derived overrides (highest precedence)
 */
export function loadConfig({ configPath, cwd = process.cwd(), overrides = {} } = {}) {
  let fileConfig = {};
  const path = configPath || resolve(cwd, 'excel2dmn.config.json');
  if (configPath || existsSync(path)) {
    try {
      fileConfig = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to read config ${path}: ${err.message}`);
    }
  }
  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, fileConfig), overrides);
  if (!['camunda7', 'camunda8'].includes(merged.platform))
    throw new Error(`Invalid platform '${merged.platform}' (expected 'camunda7' or 'camunda8')`);
  return merged;
}
