// `excel2dmn config` — interactive, step-by-step config generator.
// Zero external deps: prompts via Node's built-in readline/promises.
// Everything derives from DEFAULT_CONFIG so the wizard can never drift.
import { createInterface } from 'node:readline/promises';
import { DEFAULT_CONFIG, deepMerge } from './config.js';

/** Read a value from a nested object by dot-path (e.g. 'markers.id'). */
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Build a nested override object from a dot-path and a value. */
function setPath(path, value) {
  const keys = path.split('.');
  const root = {};
  let node = root;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) node[k] = value;
    else node = node[k] = {};
  });
  return root;
}

// The allowed-values layout is a 3-field combo, so it gets ONE friendly prompt
// instead of three raw offsets. These paths are considered "covered" by it.
export const ALLOWED_VALUES_PATHS = [
  'header.allowedValuesOffset',
  'header.labelOffset',
  'rules.startOffset',
];

/**
 * Declarative prompt specs. `default` is read live from DEFAULT_CONFIG via
 * `path`, so there are no duplicated default literals. Enum `choices` are
 * sourced from a config list (`choicesFrom`) where one exists, so they can't
 * drift from what the tool actually accepts.
 */
export const PROMPTS = [
  // --- essentials ---
  {
    section: 'Sheet selection',
    path: 'sheet.value',
    type: 'string',
    label: 'Sheet name match value',
  },
  {
    section: 'Sheet selection',
    path: 'sheet.match',
    type: 'enum',
    choices: ['contains', 'exact', 'regex'],
    label: 'How to match the sheet name',
  },
  {
    section: 'Sheet selection',
    path: 'sheet.caseInsensitive',
    type: 'boolean',
    label: 'Case-insensitive sheet match?',
  },

  {
    section: 'Marker keywords',
    path: 'markers.id',
    type: 'string',
    label: 'Marker for the decision ID column',
  },
  {
    section: 'Marker keywords',
    path: 'markers.name',
    type: 'string',
    label: 'Marker for the decision name column',
  },
  {
    section: 'Marker keywords',
    path: 'markers.input',
    type: 'string',
    label: 'Marker for input columns',
  },
  {
    section: 'Marker keywords',
    path: 'markers.output',
    type: 'string',
    label: 'Marker for output columns',
  },
  {
    section: 'Marker keywords',
    path: 'markers.policy',
    type: 'string',
    label: 'Marker for the hit-policy column',
  },
  {
    section: 'Marker keywords',
    path: 'markers.annotations',
    type: 'string',
    label: 'Marker for annotation columns',
  },

  {
    section: 'Header layout',
    special: 'allowedValues',
    type: 'boolean',
    default: false,
    label: 'Enable an allowed-values row (dropdowns; required for PRIORITY/OUTPUT ORDER)?',
  },

  {
    section: 'Hit policy',
    path: 'hitPolicy.default',
    type: 'enum',
    choicesFrom: 'hitPolicy.allowed',
    label: 'Fallback hit policy (used when a sheet has no policy column)',
  },

  {
    section: 'Output',
    path: 'output.outDir',
    type: 'nullable-string',
    label: 'Output directory (null = beside the input file)',
  },
  {
    section: 'Output',
    path: 'output.writeModelJson',
    type: 'boolean',
    label: 'Also write <decisionId>.model.json per sheet?',
  },

  // --- advanced ---
  {
    section: 'Header layout',
    path: 'header.scanRows',
    type: 'number',
    label: 'Rows to scan for the marker row',
    advanced: true,
  },
  {
    section: 'Marker keywords',
    path: 'markers.annotationSeparator',
    type: 'string',
    label: 'Separator when joining multiple annotation columns',
    advanced: true,
  },
  {
    section: 'Marker keywords',
    path: 'markers.caseInsensitive',
    type: 'boolean',
    label: 'Case-insensitive marker matching?',
    advanced: true,
  },

  {
    section: 'Rules',
    path: 'rules.idTemplate',
    type: 'string',
    label: 'Rule id template (<n> = 1-based index, <row> = Excel row)',
    advanced: true,
  },
  {
    section: 'Rules',
    path: 'rules.stopOnEmptyRow',
    type: 'boolean',
    label: 'Stop reading rules at the first fully-empty row?',
    advanced: true,
  },

  {
    section: 'Identity',
    path: 'identity.sanitizeId',
    type: 'boolean',
    label: 'Sanitize decision ids to NCName?',
    advanced: true,
  },
  {
    section: 'Identity',
    path: 'identity.idCase',
    type: 'enum',
    choices: ['upper', 'preserve'],
    label: 'Decision id casing',
    advanced: true,
  },

  {
    section: 'Types & validation',
    path: 'types.nonCamundaTypeAction',
    type: 'enum',
    choices: ['error', 'warn', 'off'],
    label: 'Action for valid-DMN-but-non-Camunda typeRefs',
    advanced: true,
  },
  {
    section: 'Types & validation',
    path: 'validation.feel.mode',
    type: 'enum',
    choices: ['all-inputs', 'any-inputs', 'off'],
    label: 'FEEL validation mode',
    advanced: true,
  },
  {
    section: 'Types & validation',
    path: 'validation.feel.failFast',
    type: 'boolean',
    label: 'Fail fast on the first FEEL error?',
    advanced: true,
  },
  {
    section: 'Types & validation',
    path: 'validation.enforceAllowedValues',
    type: 'boolean',
    label: 'Enforce rule entries fall within allowed-values domains?',
    advanced: true,
  },
  {
    section: 'Types & validation',
    path: 'outputEntries.autoQuote',
    type: 'boolean',
    label: 'Auto-quote unquoted string outputs instead of erroring?',
    advanced: true,
  },

  {
    section: 'Camunda 7',
    path: 'camunda.historyTimeToLive',
    type: 'nullable-string',
    label: 'historyTimeToLive (ISO-8601 duration or day count; null = omit)',
    advanced: true,
  },
  {
    section: 'Camunda 7',
    path: 'camunda.versionTag',
    type: 'nullable-string',
    label: 'versionTag (null = omit)',
    advanced: true,
  },

  {
    section: 'Output',
    path: 'output.namespace',
    type: 'string',
    label: 'Definitions target namespace',
    advanced: true,
  },
  {
    section: 'Output',
    path: 'output.namespaceStyle',
    type: 'enum',
    choices: ['default', 'prefixed'],
    label: 'Namespace style',
    advanced: true,
  },
  {
    section: 'Output',
    path: 'output.format',
    type: 'boolean',
    label: 'Pretty-print the DMN XML?',
    advanced: true,
  },
  {
    section: 'Output',
    path: 'output.fileNameTemplate',
    type: 'string',
    label: 'Output file name template (<decisionId> / <sheetName>)',
    advanced: true,
  },

  {
    section: 'Analysis',
    path: 'analysis.enabled',
    type: 'boolean',
    label: 'Run static analysis (overlap/gaps/duplicates) by default?',
    advanced: true,
  },
  {
    section: 'Analysis',
    path: 'analysis.failOn',
    type: 'enum',
    choices: ['none', 'any', 'error'],
    label: 'Fail the run on which analysis findings',
    advanced: true,
  },
  {
    section: 'Analysis',
    path: 'analysis.format',
    type: 'enum',
    choices: ['text', 'json'],
    label: 'Analysis output format',
    advanced: true,
  },
];

/** Resolve a prompt's default value (explicit, or read from DEFAULT_CONFIG). */
export function promptDefault(spec) {
  if ('default' in spec) return spec.default;
  return getPath(DEFAULT_CONFIG, spec.path);
}

/** Resolve a prompt's choices, sourcing from a config list when requested. */
export function promptChoices(spec) {
  if (spec.choicesFrom) return getPath(DEFAULT_CONFIG, spec.choicesFrom);
  return spec.choices;
}

function fmtDefault(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.join(',');
  return String(v);
}

/** Parse one raw answer line for a spec; returns { value } or { error }. */
export function parseAnswer(spec, raw, def) {
  const line = raw.trim();
  switch (spec.type) {
    case 'boolean': {
      if (line === '') return { value: def };
      if (/^(y|yes|true)$/i.test(line)) return { value: true };
      if (/^(n|no|false)$/i.test(line)) return { value: false };
      return { error: 'please answer y or n' };
    }
    case 'number': {
      if (line === '') return { value: def };
      const n = Number(line);
      if (!Number.isFinite(n)) return { error: 'please enter a number' };
      return { value: n };
    }
    case 'list':
      if (line === '') return { value: def };
      return { value: line.split(',').map((s) => s.trim()) };
    case 'nullable-string':
      if (line === '') return { value: def };
      if (line.toLowerCase() === 'null') return { value: null };
      return { value: line };
    case 'enum': {
      if (line === '') return { value: def };
      const choices = promptChoices(spec);
      const idx = Number(line);
      if (Number.isInteger(idx) && idx >= 1 && idx <= choices.length)
        return { value: choices[idx - 1] };
      const hit = choices.find((c) => c.toLowerCase() === line.toLowerCase());
      if (hit) return { value: hit };
      return { error: `choose 1-${choices.length} or a listed value` };
    }
    default: // string
      return { value: line === '' ? def : line };
  }
}

/**
 * Ask one prompt, re-asking until the answer parses.
 * @param {(query:string)=>Promise<string>} prompt returns one raw answer line
 * @param {(s:string)=>void} write emits helper/error lines
 */
async function ask(prompt, write, spec) {
  const def = promptDefault(spec);
  let hint = `[${fmtDefault(def)}]`;
  if (spec.type === 'boolean') hint = def ? '[Y/n]' : '[y/N]';
  if (spec.type === 'enum') {
    const choices = promptChoices(spec);
    write(`  options: ${choices.map((c, i) => `${i + 1}) ${c}`).join('  ')}\n`);
  }
  for (;;) {
    const raw = await prompt(`${spec.label} ${hint}\n> `);
    const res = parseAnswer(spec, raw, def);
    if ('value' in res) return res.value;
    write(`  ! ${res.error}\n`);
  }
}

/** The override object produced by enabling the allowed-values layout. */
export const ALLOWED_VALUES_OVERRIDE = {
  header: { allowedValuesOffset: 3, labelOffset: 4 },
  rules: { startOffset: 5 },
};

/**
 * Recursively collect leaf values that differ from `base` into a minimal object.
 * Arrays and null are treated as leaves.
 */
export function diffConfig(base, merged) {
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const out = {};
  for (const [k, v] of Object.entries(merged)) {
    if (isObj(v) && isObj(base?.[k])) {
      const sub = diffConfig(base[k], v);
      if (Object.keys(sub).length) out[k] = sub;
    } else if (JSON.stringify(v) !== JSON.stringify(base?.[k])) {
      out[k] = v;
    }
  }
  return out;
}

/** JSON-serialize a config with a trailing newline. */
export function serializeConfig(cfg) {
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

/**
 * Build a config, interactively or from defaults.
 * @param {object} opts
 * @param {NodeJS.ReadableStream} [opts.input]  prompt input  (default process.stdin)
 * @param {NodeJS.WritableStream} [opts.output] prompt output (default process.stdout)
 * @param {boolean} [opts.defaults]  skip prompts, return the default config
 * @param {boolean} [opts.full]      return the full merged config (else minimal diff)
 * @param {(query:string)=>Promise<string>} [opts.prompt] override the prompt
 *   source (used in tests); when given, `input` is not read.
 */
export async function buildConfig({
  input = process.stdin,
  output = process.stdout,
  defaults = false,
  full = false,
  prompt,
} = {}) {
  // Non-interactive: --defaults, or no prompt source (no TTY) → can't run the
  // wizard, so emit the complete default config (which IS the full example).
  if (defaults || (!prompt && !input.isTTY)) {
    return deepMerge(DEFAULT_CONFIG, {});
  }

  const rl = prompt ? null : createInterface({ input, output });
  const promptFn = prompt || ((q) => rl.question(q));
  const write = (s) => output.write(s);
  let overrides = {};
  const apply = (o) => (overrides = deepMerge(overrides, o));

  try {
    write('\nGenerate excel2dmn.config.json — press Enter to accept each [default].\n');

    let section = null;
    const runPrompt = async (spec) => {
      if (spec.section && spec.section !== section) {
        section = spec.section;
        write(`\n— ${section} —\n`);
      }
      const value = await ask(promptFn, write, spec);
      if (spec.special === 'allowedValues') {
        if (value) apply(ALLOWED_VALUES_OVERRIDE);
      } else {
        apply(setPath(spec.path, value));
      }
    };

    for (const spec of PROMPTS.filter((s) => !s.advanced)) await runPrompt(spec);

    const advanced = await ask(promptFn, write, {
      type: 'boolean',
      default: false,
      label: '\nConfigure advanced options (types, validation, camunda, output, analysis)?',
    });
    if (advanced) for (const spec of PROMPTS.filter((s) => s.advanced)) await runPrompt(spec);
  } finally {
    if (rl) rl.close();
  }

  const merged = deepMerge(DEFAULT_CONFIG, overrides);
  return full ? merged : diffConfig(DEFAULT_CONFIG, merged);
}
