// E2E: CLI commands, config, init and analysis.
// One it() per scenario in test/e2e/scenarios/cli-config.md. Every test builds its
// workbook in code, drives the real CLI (or the public API where the scenario says
// **API**), and re-parses each emitted .dmn with dmn-moddle.
import { describe, it, expect, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import ExcelJS from 'exceljs';
import Ajv2020 from 'ajv/dist/2020.js';
import { convert, loadConfig, DEFAULT_CONFIG, deepMerge } from '../../src/index.js';
import { buildConfig, PROMPTS, serializeConfig } from '../../src/init-config.js';
import {
  CLI,
  tempDir,
  runCli,
  writeWorkbook,
  readWorkbook,
  decisionSheet,
  ALLOWED_VALUES_LAYOUT,
  parseDmn,
  firstTable,
  readText,
  listFiles,
} from './helpers.js';

const REPO = new URL('../../', import.meta.url);
const PKG = JSON.parse(readFileSync(new URL('package.json', REPO), 'utf8'));
const EXAMPLE_CONFIG = JSON.parse(readFileSync(new URL('excel2dmn.config.example.json', REPO)));
const MODEL_SCHEMA = JSON.parse(readFileSync(new URL('schema/model.schema.json', REPO)));
const CFG = 'cfg.json';
const CWD_CFG = 'excel2dmn.config.json';
const DEFAULT_NS = 'http://camunda.org/schema/1.0/dmn';
const STACK_LINE = /^\s+at .+:\d+:\d+\)?$/m;
const OPTS = { timeout: 120_000 };

// --- per-test temp dir -------------------------------------------------------------

let tmp;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

/** Fresh temp dir `T` for the current test (cleaned up in afterEach). */
function T() {
  tmp?.cleanup();
  tmp = tempDir();
  return tmp.dir;
}

// --- workbook builders ---------------------------------------------------------------

// W1: A id=RATES, B input amount:integer, C output result:string; rules on rows 5-6.
const W1_COLS = [
  { marker: 'id', name: 'RATES' },
  { marker: 'input', name: 'amount', type: 'integer', label: 'Amount' },
  { marker: 'output', name: 'result', type: 'string', label: 'Result' },
];
const W1_RULES = [
  [null, '< 10', '"LOW"'],
  [null, '>= 10', '"HIGH"'],
];
const w1 = () => decisionSheet(W1_COLS, W1_RULES);

/** W1 with the output `result` retyped `integer` (values 1, 2). */
const w1Int = () =>
  decisionSheet(
    [W1_COLS[0], W1_COLS[1], { ...W1_COLS[2], type: 'integer' }],
    [
      [null, '< 10', 1],
      [null, '>= 10', 2],
    ],
  );

/** W1 with a column prepended (marker/name/type) and empty rule cells under it. */
function w1With(cols, ruleVals = [], base = W1_COLS, rules = W1_RULES) {
  return decisionSheet(
    [...cols, ...base],
    rules.map((r, i) => [...(ruleVals[i] ?? cols.map(() => null)), ...r]),
  );
}

/** Copy of `rows` with A1-style cells replaced (`null` clears a cell). */
function setCells(rows, cells) {
  const out = rows.map((r) => [...(r ?? [])]);
  for (const [ref, v] of Object.entries(cells)) {
    const [, letters, num] = ref.match(/^([A-Z]+)(\d+)$/);
    const c = [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const r = Number(num) - 1;
    while (out.length <= r) out.push([]);
    out[r][c] = v;
  }
  return out;
}

const shippingSheet = (id = 'SHIPPING') =>
  decisionSheet(
    [
      { marker: 'id', name: id },
      { marker: 'input', name: 'weight', type: 'integer', label: 'Weight' },
      { marker: 'output', name: 'method', type: 'string', label: 'Method' },
    ],
    [
      [null, '< 5', '"STANDARD"'],
      [null, '>= 5', '"FREIGHT"'],
    ],
  );
const returnsSheet = (id = 'RETURNS') =>
  decisionSheet(
    [
      { marker: 'id', name: id },
      { marker: 'input', name: 'days', type: 'integer', label: 'Days' },
      { marker: 'output', name: 'allowed', type: 'boolean', label: 'Allowed' },
    ],
    [
      [null, '<= 30', 'true'],
      [null, '> 30', 'false'],
    ],
  );
const NOTES = [['input', 'output', 'id'], ['X'], ['free text, not a decision table']];

/** W2 sheets, in workbook order; `patch` maps sheet name -> cell overrides. */
function w2({ shippingId, returnsId, patch = {}, extra = {} } = {}) {
  const sheets = {
    'Shipping DMN': shippingSheet(shippingId),
    Notes: NOTES,
    'Returns_ DMN': returnsSheet(returnsId),
    ...extra,
  };
  for (const [name, cells] of Object.entries(patch)) sheets[name] = setCells(sheets[name], cells);
  return sheets;
}

// W-OVL: id OVL, region:string, amount:integer, fee:integer (rows 5-7).
const OVL_COLS = [
  { marker: 'id', name: 'OVL' },
  { marker: 'input', name: 'region', type: 'string', label: 'Region' },
  { marker: 'input', name: 'amount', type: 'integer', label: 'Amount' },
  { marker: 'output', name: 'fee', type: 'integer', label: 'Fee' },
];
const OVL_RULES = [
  [null, '"EU"', '< 100', 1],
  [null, '"EU"', '< 50', 2],
  [null, '"US"', '>= 100', 3],
];
const wOvl = (rules = OVL_RULES, policy) =>
  policy
    ? decisionSheet(
        [{ marker: 'policy', name: policy }, ...OVL_COLS],
        rules.map((r) => [null, ...r]),
      )
    : decisionSheet(OVL_COLS, rules);

// --- CLI drivers and assertions --------------------------------------------------------

async function book(dir, file, sheets) {
  const path = join(dir, file);
  mkdirSync(dirname(path), { recursive: true });
  await writeWorkbook(path, sheets);
  return path;
}
const writeW1 = (dir, file = 'one_DMN.xlsx', rows = w1()) => book(dir, file, { 'Rates DMN': rows });

/** Write a config file (object -> JSON, string -> raw text). */
function writeCfg(dir, cfg, file = CFG) {
  const path = join(dir, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  return path;
}

const cli = (dir, args, opts = {}) => runCli(args, { cwd: dir, ...opts });
const dump = (r) => `exit ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
const lines = (s) => s.split(/\r?\n/);

/** Every file under `dir`, recursively, as paths relative to `dir`. */
function walk(dir, rel = '') {
  if (!existsSync(join(dir, rel))) return [];
  return readdirSync(join(dir, rel)).flatMap((f) => {
    const p = rel ? join(rel, f) : f;
    return statSync(join(dir, p)).isDirectory() ? walk(dir, p) : [p];
  });
}
const dmnFiles = (dir) => walk(dir).filter((f) => f.endsWith('.dmn'));
const jsonModels = (dir) => walk(dir).filter((f) => f.endsWith('.model.json'));

/** Re-parse every .dmn under `dir` (no dmn-moddle warnings). */
async function reparseAll(dir) {
  for (const f of dmnFiles(dir)) await parseDmn(readText(join(dir, f)));
}

/** "succeeds": exit 0, stderr empty, every emitted .dmn re-parses cleanly. */
async function expectOk(r, dir) {
  expect(r.code, dump(r)).toBe(0);
  expect(r.stderr, dump(r)).toBe('');
  if (dir) await reparseAll(dir);
}

/** "fails with": exit 1, needles in stderr (case-insensitive), no JS stack trace. */
function expectFail(r, ...needles) {
  expect(r.code, dump(r)).toBe(1);
  for (const n of needles) {
    if (n instanceof RegExp) expect(r.stderr, dump(r)).toMatch(n);
    else expect(r.stderr.toLowerCase(), dump(r)).toContain(n.toLowerCase());
  }
  expect(r.stderr, dump(r)).not.toMatch(STACK_LINE);
}

/** Single-item failure: as expectFail, plus no .dmn anywhere in `dir` and no success line. */
function expectFailNothingWritten(r, dir, ...needles) {
  expectFail(r, ...needles);
  expect(dmnFiles(dir)).toEqual([]);
  expect(r.stdout, dump(r)).not.toMatch(/\.dmn\b/);
}

async function loadDmn(path) {
  const xml = readText(path);
  const definitions = await parseDmn(xml);
  return { xml, definitions, ...firstTable(definitions) };
}
const readJson = (path) => JSON.parse(readText(path));

/** Attribute maps of every start tag `<name …>` in the raw XML. */
function tags(xml, name) {
  const re = new RegExp(`<${name}(\\s[^>]*?)?\\s*/?>`, 'g');
  return [...xml.matchAll(re)].map((m) =>
    Object.fromEntries(
      [...(m[1] ?? '').matchAll(/([\w:.-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]),
    ),
  );
}
const tag = (xml, name) => tags(xml, name)[0] ?? {};
const hitPolicyOf = (xml) => tag(xml, 'decisionTable').hitPolicy;

/** Analysis lines on stdout naming a check (overlap/duplicate/shadowed/gaps). */
const findings = (stdout, check) => lines(stdout).filter((l) => l.includes(check));

/** Summary of a parsed decision used for "same content" comparisons. */
function summary({ decision, table }) {
  return {
    id: decision.id,
    inputs: (table.input ?? []).map((i) => i.inputExpression.text),
    outputs: table.output.map((o) => o.name),
    rules: table.rule.map((r) => [
      ...(r.inputEntry ?? []).map((e) => e.text ?? ''),
      ...r.outputEntry.map((e) => e.text ?? ''),
    ]),
  };
}

const validateModel = (() => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile(MODEL_SCHEMA);
})();
function expectSchemaValid(model) {
  const ok = validateModel(model);
  expect(validateModel.errors ?? [], JSON.stringify(validateModel.errors)).toEqual([]);
  expect(ok).toBe(true);
}

/** Marker row (row 1) of the only sheet of a workbook, as trimmed strings. */
async function markerRow(path) {
  const sheets = await readWorkbook(path);
  const rows = Object.values(sheets)[0];
  return (rows[0] ?? []).map((v) => (v == null ? '' : String(v).trim()));
}

/** Stdin text for the config wizard: essentials (path -> answer), advanced flag, advanced answers. */
function wizardInput({ essentials = {}, advanced = false, adv = {}, before = {} } = {}) {
  const out = [];
  for (const spec of PROMPTS.filter((p) => !p.advanced)) {
    const key = spec.path ?? spec.special;
    if (before[key]) out.push(...before[key]);
    out.push(essentials[key] ?? '');
  }
  out.push(advanced ? 'y' : '');
  if (advanced)
    for (const spec of PROMPTS.filter((p) => p.advanced)) out.push(adv[spec.path] ?? '');
  return `${[...out, ...Array(10).fill('')].join('\n')}\n`;
}

/**
 * Run the real wizard (`buildConfig`) answering from `input` (as built by wizardInput).
 * Piped stdin is not a TTY, where the CLI writes the defaults instead (decided; see
 * CLI-250), so the wizard is driven through its `prompt` hook like CLI-258.
 * `stdout` is everything the wizard printed, prompts included.
 */
async function runWizard(input, { full = false } = {}) {
  const answers = input.split('\n');
  let stdout = '';
  const prompt = async (q) => {
    stdout += q;
    return answers.shift() ?? '';
  };
  const cfg = await buildConfig({ prompt, output: { write: (t) => (stdout += t) }, full });
  return { cfg, stdout };
}

/** Write a wizard result as the CLI would (`serializeConfig`) to `dir/file`. */
const saveWizard = (dir, cfg, file = CWD_CFG) =>
  writeFileSync(join(dir, file), serializeConfig(cfg), 'utf8');

const HAS_PTY = spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0;

// =====================================================================================

describe('A. Global flags: version, help, usage errors', OPTS, () => {
  it('CLI-001 --version prints the package.json version', () => {
    const dir = T();
    const r = cli(dir, ['--version']);
    expect(r.code, dump(r)).toBe(0);
    expect(r.stdout.trim()).toBe(PKG.version);
    expect(r.stderr).toBe('');
  });

  it('CLI-002 -V is an alias of --version', () => {
    const dir = T();
    const r = cli(dir, ['-V']);
    expect(r.code, dump(r)).toBe(0);
    expect(r.stdout.trim()).toBe(PKG.version);
    expect(r.stderr).toBe('');
  });

  const CONVERT_OPTS = [
    '--out-dir',
    '--out',
    '--json',
    '--config',
    '--sheet',
    '--hit-policy',
    '--namespace',
    '--analyze',
    '--validate-only',
    '--platform',
  ];

  it('CLI-003 --help lists every command and the convert options', () => {
    const dir = T();
    const r = cli(dir, ['--help']);
    expect(r.code, dump(r)).toBe(0);
    expect(r.stdout).toContain('Usage: excel2dmn');
    for (const c of ['convert', 'init', 'config', 'import']) expect(r.stdout).toContain(c);
    for (const o of CONVERT_OPTS) expect(r.stdout, o).toContain(o);
    expect(listFiles(dir)).toEqual([]);
  });

  it('CLI-004 -h is an alias of --help', () => {
    const dir = T();
    const a = cli(dir, ['--help']);
    const b = cli(dir, ['-h']);
    expect(b.code).toBe(a.code);
    expect(b.stdout).toBe(a.stdout);
    for (const o of CONVERT_OPTS) expect(b.stdout, o).toContain(o);
  });

  it('CLI-005 per-command help for init, config, import, convert', () => {
    const dir = T();
    const expected = {
      init: ['--out', '--name', '--sheet', '--minimal', '--config'],
      config: ['--out', '--full', '--defaults', '--force'],
      import: ['--out', '--config'],
      convert: CONVERT_OPTS,
    };
    for (const [cmd, opts] of Object.entries(expected)) {
      const r = cli(dir, [cmd, '--help']);
      expect(r.code, dump(r)).toBe(0);
      for (const o of opts) expect(r.stdout, `${cmd} ${o}`).toContain(o);
    }
    expect(listFiles(dir)).toEqual([]);
  });

  it('CLI-006 no arguments at all is a usage error', () => {
    const dir = T();
    const r = cli(dir, []);
    expect(r.code, dump(r)).toBe(1);
    expect(r.stderr).toMatch(/input\.xlsx|usage/i);
    expect(listFiles(dir)).toEqual([]);
  });

  it('CLI-007 unknown option is rejected', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '--bogus']);
    expectFailNothingWritten(r, dir, 'unknown option', '--bogus');
  });

  it('CLI-008 explicit convert sub-command equals the default command', async () => {
    const dir = T();
    await writeW1(dir);
    const a = cli(dir, ['convert', 'one_DMN.xlsx', '--out-dir', 'a']);
    const b = cli(dir, ['one_DMN.xlsx', '--out-dir', 'b']);
    await expectOk(a, dir);
    await expectOk(b, dir);
    expect(readText(join(dir, 'a/RATES.dmn'))).toBe(readText(join(dir, 'b/RATES.dmn')));
  });
});

describe('B. Convert: input errors and exit codes', OPTS, () => {
  it('CLI-010 missing input file', () => {
    const dir = T();
    const r = cli(dir, ['nope.xlsx']);
    expectFail(r, 'nope.xlsx');
    expect(listFiles(dir)).toEqual([]);
  });

  it('CLI-011 input is not an xlsx (plain text with .xlsx extension)', () => {
    const dir = T();
    writeFileSync(join(dir, 'fake.xlsx'), 'hello');
    const r = cli(dir, ['fake.xlsx']);
    expectFailNothingWritten(r, dir, /fake\.xlsx|(not|invalid).*(xlsx|workbook|zip)/i);
  });

  it('CLI-012 input is a CSV file', () => {
    const dir = T();
    writeFileSync(join(dir, 'rules.csv'), 'id,input,output\n');
    const r = cli(dir, ['rules.csv']);
    expectFailNothingWritten(r, dir, /\S/);
  });

  it('CLI-013 input path is a directory', () => {
    const dir = T();
    mkdirSync(join(dir, 'folder_DMN.xlsx'));
    const r = cli(dir, ['folder_DMN.xlsx']);
    expectFail(r, 'folder_DMN.xlsx');
    expect(listFiles(dir)).toEqual(['folder_DMN.xlsx']);
    expect(listFiles(join(dir, 'folder_DMN.xlsx'))).toEqual([]);
  });

  it('CLI-014 workbook with zero matching sheets', async () => {
    const dir = T();
    await book(dir, 'plain.xlsx', { Sheet1: w1() });
    const r = cli(dir, ['plain.xlsx']);
    expectFailNothingWritten(r, dir, 'no sheet', 'DMN');
  });

  it('CLI-015 sheet name matching is case-insensitive substring by default', async () => {
    const dir = T();
    const cases = [
      ['rates dmn', 'A'],
      ['Rates_Dmn_v2', 'B'],
      ['xDMNx', 'C'],
    ];
    for (const [sheet, id] of cases) {
      const rows = setCells(w1(), { A2: id });
      await book(dir, `${id}.xlsx`, { [sheet]: rows });
      const r = cli(dir, [`${id}.xlsx`]);
      await expectOk(r, dir);
      expect(existsSync(join(dir, `${id}.dmn`))).toBe(true);
    }
  });

  it('CLI-016 input path containing spaces and non-ASCII characters', async () => {
    const dir = T();
    await writeW1(dir, 'my rules (ü)/one_DMN.xlsx');
    const r = cli(dir, ['my rules (ü)/one_DMN.xlsx']);
    await expectOk(r, dir);
    expect(existsSync(join(dir, 'my rules (ü)/RATES.dmn'))).toBe(true);
  });

  it('CLI-017 relative input path is resolved against cwd', async () => {
    const dir = T();
    await writeW1(dir, 'in/one_DMN.xlsx');
    const r = cli(dir, ['in/one_DMN.xlsx']);
    await expectOk(r, dir);
    expect(existsSync(join(dir, 'in/RATES.dmn'))).toBe(true);
    expect(listFiles(dir)).toEqual(['in']);
  });

  it('CLI-018 sheet-level conversion error exits 1 with a coordinate', async () => {
    const dir = T();
    await writeW1(dir, 'one_DMN.xlsx', setCells(w1(), { B5: '"ten"' }));
    const r = cli(dir, ['one_DMN.xlsx']);
    expectFailNothingWritten(r, dir, 'Rates DMN', 'Rates DMN!B5', 'amount');
  });

  it('CLI-019 all problems of a sheet are reported together', async () => {
    const dir = T();
    await writeW1(dir, 'one_DMN.xlsx', setCells(w1(), { B5: '"ten"', C6: 'HIGH' }));
    const r = cli(dir, ['one_DMN.xlsx']);
    expectFailNothingWritten(r, dir, 'Rates DMN!B5', 'Rates DMN!C6');
  });

  it('CLI-020 validation.feel.failFast: true stops at the first problem', async () => {
    const dir = T();
    await writeW1(dir, 'one_DMN.xlsx', setCells(w1(), { B5: '"ten"', C6: 'HIGH' }));
    writeCfg(dir, { validation: { feel: { failFast: true } } });
    const r = cli(dir, ['one_DMN.xlsx', '--config', CFG]);
    expectFailNothingWritten(r, dir, 'Rates DMN!B5');
    expect(r.stderr).not.toContain('Rates DMN!C6');
  });

  it('CLI-021 re-running overwrites the existing .dmn with byte-identical content', async () => {
    const dir = T();
    await writeW1(dir);
    await expectOk(cli(dir, ['one_DMN.xlsx']), dir);
    const first = readText(join(dir, 'RATES.dmn'));
    await expectOk(cli(dir, ['one_DMN.xlsx']), dir);
    expect(readText(join(dir, 'RATES.dmn'))).toBe(first);
  });

  it('CLI-022 success line on stdout names the sheet and output path', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx']);
    await expectOk(r, dir);
    const hits = lines(r.stdout).filter((l) => l.includes('Rates DMN') && l.includes('RATES.dmn'));
    expect(hits, r.stdout).toHaveLength(1);
  });
});

describe('C. Output location: --out-dir, --out, fileNameTemplate', OPTS, () => {
  it('CLI-030 default output goes beside the input, not into cwd', async () => {
    const dir = T();
    await writeW1(dir, 'in/one_DMN.xlsx');
    mkdirSync(join(dir, 'elsewhere'));
    const r = cli(join(dir, 'elsewhere'), ['../in/one_DMN.xlsx']);
    await expectOk(r, dir);
    expect(existsSync(join(dir, 'in/RATES.dmn'))).toBe(true);
    expect(listFiles(join(dir, 'elsewhere'))).toEqual([]);
  });

  it('CLI-031 --out-dir writes there', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '--out-dir', 'out']);
    await expectOk(r, dir);
    expect(listFiles(join(dir, 'out'))).toEqual(['RATES.dmn']);
    expect(listFiles(dir).filter((f) => f.endsWith('.dmn'))).toEqual([]);
  });

  it('CLI-032 -O is the short form of --out-dir', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '-O', 'out']);
    await expectOk(r, dir);
    expect(listFiles(join(dir, 'out'))).toEqual(['RATES.dmn']);
    expect(listFiles(dir).filter((f) => f.endsWith('.dmn'))).toEqual([]);
  });

  it('CLI-033 --out-dir creates missing nested directories', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '--out-dir', 'a/b/c']);
    await expectOk(r, dir);
    expect(existsSync(join(dir, 'a/b/c/RATES.dmn'))).toBe(true);
  });

  it('CLI-034 --out writes a single sheet to the named file', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '--out', 'out/custom-name.dmn']);
    await expectOk(r, dir);
    const { decision } = await loadDmn(join(dir, 'out/custom-name.dmn'));
    expect(decision.id).toBe('RATES');
    expect(dmnFiles(dir)).toEqual([join('out', 'custom-name.dmn')]);
  });

  it('CLI-035 -o is the short form of --out', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '-o', 'x.dmn']);
    await expectOk(r, dir);
    expect(existsSync(join(dir, 'x.dmn'))).toBe(true);
    expect(existsSync(join(dir, 'RATES.dmn'))).toBe(false);
  });

  it('CLI-036 --out with a multi-sheet workbook is an error and writes nothing', async () => {
    const dir = T();
    await book(dir, 'book.xlsx', w2());
    const r = cli(dir, ['book.xlsx', '--out', 'x.dmn']);
    expectFail(r, '--out', 'single', '--out-dir', '2');
    expect(dmnFiles(dir)).toEqual([]);
  });

  it('CLI-037 --out with a multi-sheet workbook filtered to one sheet by --sheet is valid', async () => {
    const dir = T();
    await book(dir, 'book.xlsx', w2());
    const r = cli(dir, ['book.xlsx', '--sheet', 'Returns_ DMN', '--out', 'r.dmn']);
    await expectOk(r, dir);
    expect((await loadDmn(join(dir, 'r.dmn'))).decision.id).toBe('RETURNS');
    expect(dmnFiles(dir)).toEqual(['r.dmn']);
  });

  it('CLI-038 --out combined with --json writes the model beside the named file', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '--out', 'out/r.dmn', '--json']);
    await expectOk(r, dir);
    expect(existsSync(join(dir, 'out/r.dmn'))).toBe(true);
    expect(existsSync(join(dir, 'out/r.model.json'))).toBe(true);
  });

  it('CLI-039 --out into a missing directory creates it', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '--out', 'deep/er/r.dmn']);
    await expectOk(r, dir);
    expect(existsSync(join(dir, 'deep/er/r.dmn'))).toBe(true);
  });

  it('CLI-040 --out and --out-dir together', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '--out-dir', 'od', '--out', 'o.dmn']);
    await expectOk(r, dir);
    expect(existsSync(join(dir, 'o.dmn'))).toBe(true);
    expect(dmnFiles(join(dir, 'od'))).toEqual([]);
  });

  it('CLI-041 output.outDir in config is used when no flag is given', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { output: { outDir: 'cfgout' } });
    const r = cli(dir, ['one_DMN.xlsx', '--config', CFG]);
    await expectOk(r, dir);
    expect(existsSync(join(dir, 'cfgout/RATES.dmn'))).toBe(true);
  });

  it('CLI-042 --out-dir beats output.outDir', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { output: { outDir: 'cfgout' } });
    const r = cli(dir, ['one_DMN.xlsx', '--config', CFG, '--out-dir', 'flagout']);
    await expectOk(r, dir);
    expect(existsSync(join(dir, 'flagout/RATES.dmn'))).toBe(true);
    expect(existsSync(join(dir, 'cfgout'))).toBe(false);
  });

  it('CLI-043 fileNameTemplate: "<sheetName>.dmn"', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { output: { fileNameTemplate: '<sheetName>.dmn' } });
    const r = cli(dir, ['one_DMN.xlsx', '--config', CFG]);
    await expectOk(r, dir);
    expect(existsSync(join(dir, 'Rates DMN.dmn'))).toBe(true);
    expect(existsSync(join(dir, 'RATES.dmn'))).toBe(false);
  });

  it('CLI-044 fileNameTemplate with a prefix and both placeholders', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { output: { fileNameTemplate: 'v1-<decisionId>.dmn' } });
    const r = cli(dir, ['one_DMN.xlsx', '--config', CFG]);
    await expectOk(r, dir);
    expect(existsSync(join(dir, 'v1-RATES.dmn'))).toBe(true);
  });

  it('CLI-045 fileNameTemplate with --json names the model after the DMN file', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { output: { fileNameTemplate: 'v1-<decisionId>.dmn' } });
    const r = cli(dir, ['one_DMN.xlsx', '--config', CFG, '--json']);
    await expectOk(r, dir);
    expect(existsSync(join(dir, 'v1-RATES.dmn'))).toBe(true);
    expect(existsSync(join(dir, 'v1-RATES.model.json'))).toBe(true);
  });
});

describe('D. --json and the intermediate model', OPTS, () => {
  it('CLI-050 --json writes one model per sheet beside the DMN', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '--json', '--out-dir', 'out']);
    await expectOk(r, dir);
    expect(listFiles(join(dir, 'out'))).toEqual(['RATES.dmn', 'RATES.model.json']);
  });

  it('CLI-051 -j is the short form of --json', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '-j']);
    await expectOk(r, dir);
    expect(existsSync(join(dir, 'RATES.model.json'))).toBe(true);
  });

  it('CLI-052 the model JSON validates against schema/model.schema.json', async () => {
    const dir = T();
    await writeW1(dir);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--json']), dir);
    expectSchemaValid(readJson(join(dir, 'RATES.model.json')));
  });

  it('CLI-053 the model JSON content matches the spec shape', async () => {
    const dir = T();
    await writeW1(dir);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--json']), dir);
    const m = readJson(join(dir, 'RATES.model.json'));
    expect(m.definitions).toEqual({
      id: 'definitions_RATES',
      name: 'RATES',
      namespace: DEFAULT_NS,
    });
    expect(m.decisions).toHaveLength(1);
    const d = m.decisions[0];
    expect(d).toMatchObject({ id: 'RATES', name: 'RATES', hitPolicy: 'UNIQUE', aggregation: null });
    expect(d.inputs[0]).toEqual({
      label: 'Amount',
      expression: 'amount',
      typeRef: 'integer',
      allowedValues: null,
    });
    expect(d.outputs[0]).toEqual({
      name: 'result',
      label: 'Result',
      typeRef: 'string',
      allowedValues: null,
    });
    expect(d.rules[0]).toMatchObject({
      id: 'rule_1',
      row: 5,
      inputEntries: ['< 10'],
      outputEntries: ['"LOW"'],
    });
    expect('description' in d.rules[0]).toBe(false);
    expect(d.rules[1]).toMatchObject({ id: 'rule_2', row: 6 });
  });

  it('CLI-054 the model JSON carries no internal bookkeeping keys', async () => {
    const dir = T();
    await writeW1(dir);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--json']), dir);
    const text = readText(join(dir, 'RATES.model.json'));
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['decisions', 'definitions']);
    expect(text).not.toMatch(/"__[^"]*"\s*:/);
  });

  it('CLI-055 the model JSON is pretty-printed and stable across runs', async () => {
    const dir = T();
    await writeW1(dir);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--json', '--out-dir', 'a']), dir);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--json', '--out-dir', 'b']), dir);
    const a = readText(join(dir, 'a/RATES.model.json'));
    expect(readText(join(dir, 'b/RATES.model.json'))).toBe(a);
    expect(a).toMatch(/^\{\n {2}"definitions": \{\n {4}"id"/);
  });

  it('CLI-056 output.writeModelJson: true writes the model without --json', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { output: { writeModelJson: true } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG]), dir);
    expect(existsSync(join(dir, 'RATES.model.json'))).toBe(true);
  });

  it('CLI-057 without --json no model JSON is written', async () => {
    const dir = T();
    await writeW1(dir);
    await expectOk(cli(dir, ['one_DMN.xlsx']), dir);
    expect(jsonModels(dir)).toEqual([]);
  });

  it('CLI-058 --json on a multi-sheet workbook writes one model per sheet', async () => {
    const dir = T();
    await book(dir, 'book.xlsx', w2());
    await expectOk(cli(dir, ['book.xlsx', '--json', '--out-dir', 'out']), dir);
    expect(listFiles(join(dir, 'out'))).toEqual([
      'RETURNS.dmn',
      'RETURNS.model.json',
      'SHIPPING.dmn',
      'SHIPPING.model.json',
    ]);
    for (const [f, id] of [
      ['RETURNS.model.json', 'RETURNS'],
      ['SHIPPING.model.json', 'SHIPPING'],
    ]) {
      const m = readJson(join(dir, 'out', f));
      expect(m.decisions).toHaveLength(1);
      expect(m.decisions[0].id).toBe(id);
      expectSchemaValid(m);
    }
  });

  it('CLI-059 model JSON for a sheet with annotations, a name column and a COLLECT policy', async () => {
    const dir = T();
    const rows = decisionSheet(
      [
        { marker: 'policy', name: 'COLLECT', type: 'SUM' },
        { marker: 'id', name: 'RATES' },
        { marker: 'name', name: 'Rate Decision' },
        { marker: 'input', name: 'amount', type: 'integer', label: 'Amount' },
        { marker: 'output', name: 'result', type: 'integer', label: 'Result' },
        { marker: 'annotations', label: 'Comment' },
      ],
      [
        [null, null, null, '< 10', 1, 'small'],
        [null, null, null, '>= 10', 2, null],
      ],
    );
    await writeW1(dir, 'one_DMN.xlsx', rows);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--json']), dir);
    const m = readJson(join(dir, 'RATES.model.json'));
    expect(m.definitions.name).toBe('Rate Decision');
    const d = m.decisions[0];
    expect(d).toMatchObject({ name: 'Rate Decision', hitPolicy: 'COLLECT', aggregation: 'SUM' });
    expect(d.rules[0].description).toBe('small');
    expect('description' in d.rules[1]).toBe(false);
    expectSchemaValid(m);
  });
});

describe('E. --validate-only', OPTS, () => {
  it('CLI-060 valid workbook: exit 0, nothing written', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '--validate-only']);
    await expectOk(r, dir);
    expect(listFiles(dir)).toEqual(['one_DMN.xlsx']);
    expect(r.stdout).toContain('Rates DMN');
    expect(r.stdout).toContain('RATES');
    expect(r.stdout).toMatch(/valid/i);
  });

  it('CLI-061 invalid workbook: exit 1, nothing written, coordinate reported', async () => {
    const dir = T();
    await writeW1(dir, 'one_DMN.xlsx', setCells(w1(), { B5: '"ten"' }));
    const r = cli(dir, ['one_DMN.xlsx', '--validate-only']);
    expectFail(r, 'Rates DMN!B5');
    expect(listFiles(dir)).toEqual(['one_DMN.xlsx']);
  });

  it('CLI-062 --validate-only with --json writes no model either', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '--validate-only', '--json']);
    await expectOk(r, dir);
    expect(listFiles(dir)).toEqual(['one_DMN.xlsx']);
  });

  it('CLI-063 --validate-only with --out-dir does not create the directory', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '--validate-only', '--out-dir', 'out']);
    await expectOk(r, dir);
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });

  it('CLI-064 --validate-only with output.writeModelJson: true writes nothing', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { output: { writeModelJson: true } });
    const r = cli(dir, ['one_DMN.xlsx', '--config', CFG, '--validate-only']);
    await expectOk(r, dir);
    expect(dmnFiles(dir)).toEqual([]);
    expect(jsonModels(dir)).toEqual([]);
  });

  it('CLI-065 --validate-only checks every sheet of a multi-sheet workbook', async () => {
    const dir = T();
    await book(dir, 'book.xlsx', w2({ patch: { 'Returns_ DMN': { B5: '"x"' } } }));
    const r = cli(dir, ['book.xlsx', '--validate-only']);
    expectFail(r, 'Returns_ DMN!B5');
    const shipping = lines(r.stdout).filter((l) => l.includes('Shipping DMN'));
    expect(
      shipping.some((l) => /valid/i.test(l)),
      r.stdout,
    ).toBe(true);
    expect(listFiles(dir)).toEqual(['book.xlsx']);
  });

  it('CLI-066 --validate-only detects Camunda 8 hit-policy errors with --platform camunda8', async () => {
    const dir = T();
    const rows = decisionSheet(
      [
        { marker: 'policy', name: 'PRIORITY' },
        { marker: 'id', name: 'RATES' },
        { marker: 'input', name: 'amount', type: 'integer', label: 'Amount' },
        {
          marker: 'output',
          name: 'result',
          type: 'string',
          label: 'Result',
          allowed: '"LOW","HIGH"',
        },
      ],
      [
        [null, null, '< 10', '"LOW"'],
        [null, null, '>= 10', '"HIGH"'],
      ],
      { allowedValues: true },
    );
    await writeW1(dir, 'one_DMN.xlsx', rows);
    writeCfg(dir, ALLOWED_VALUES_LAYOUT);
    const c8 = cli(dir, [
      'one_DMN.xlsx',
      '--config',
      CFG,
      '--platform',
      'camunda8',
      '--validate-only',
    ]);
    expectFail(c8, 'PRIORITY', 'Camunda 8');
    expect(listFiles(dir).sort()).toEqual([CFG, 'one_DMN.xlsx'].sort());
    const c7 = cli(dir, ['one_DMN.xlsx', '--config', CFG, '--validate-only']);
    expect(c7.code, dump(c7)).toBe(0);
  });
});

describe('F. --sheet filtering', OPTS, () => {
  it('CLI-070 --sheet restricts conversion to one sheet', async () => {
    const dir = T();
    await book(dir, 'book.xlsx', w2());
    const r = cli(dir, ['book.xlsx', '--sheet', 'Shipping DMN']);
    await expectOk(r, dir);
    expect(dmnFiles(dir)).toEqual(['SHIPPING.dmn']);
  });

  it('CLI-071 --sheet accepts several names', async () => {
    const dir = T();
    const pricing = decisionSheet(
      [
        { marker: 'id', name: 'PRICING' },
        { marker: 'input', name: 'qty', type: 'integer', label: 'Qty' },
        { marker: 'output', name: 'price', type: 'string', label: 'Price' },
      ],
      [[null, '> 0', '"P"']],
    );
    await book(dir, 'book.xlsx', w2({ extra: { 'Pricing DMN': pricing } }));
    const r = cli(dir, ['book.xlsx', '--sheet', 'Shipping DMN', 'Pricing DMN']);
    await expectOk(r, dir);
    expect(dmnFiles(dir).sort()).toEqual(['PRICING.dmn', 'SHIPPING.dmn']);
  });

  it('CLI-072 --sheet with a name that does not exist', async () => {
    const dir = T();
    await book(dir, 'book.xlsx', w2());
    const r = cli(dir, ['book.xlsx', '--sheet', 'Missing DMN']);
    expectFailNothingWritten(r, dir, 'no sheet', 'Missing DMN');
  });

  // Decided: --sheet narrows the sheets that sheet.match/sheet.value already select.
  it('CLI-073 --sheet naming a sheet without DMN in its name', async () => {
    const dir = T();
    await book(dir, 'w.xlsx', { Rates: w1() });
    const r = cli(dir, ['w.xlsx', '--sheet', 'Rates']);
    expectFailNothingWritten(r, dir, '"Rates"', '"DMN"', '--sheet only narrows');
  });

  it('CLI-074 --sheet uses exact (not substring) matching', async () => {
    const dir = T();
    await book(dir, 'book.xlsx', w2());
    const r = cli(dir, ['book.xlsx', '--sheet', 'Shipping']);
    expectFailNothingWritten(r, dir, 'no sheet');
  });

  it('CLI-075 --sheet filters away the broken sheet', async () => {
    const dir = T();
    await book(dir, 'book.xlsx', w2({ patch: { 'Returns_ DMN': { B5: '"x"' } } }));
    const r = cli(dir, ['book.xlsx', '--sheet', 'Shipping DMN']);
    await expectOk(r, dir);
    expect(dmnFiles(dir)).toEqual(['SHIPPING.dmn']);
  });
});

describe('G. Multi-sheet workbooks', OPTS, () => {
  it('CLI-080 one .dmn per DMN sheet; non-DMN sheets ignored', async () => {
    const dir = T();
    await book(dir, 'book.xlsx', w2());
    const r = cli(dir, ['book.xlsx', '--out-dir', 'out']);
    await expectOk(r, dir);
    expect(listFiles(join(dir, 'out'))).toEqual(['RETURNS.dmn', 'SHIPPING.dmn']);
    const ok = lines(r.stdout).filter((l) => l.includes('.dmn'));
    expect(ok, r.stdout).toHaveLength(2);
    expect(ok[0]).toContain('Shipping DMN');
    expect(ok[1]).toContain('Returns_ DMN');
    expect(r.stdout + r.stderr).not.toContain('Notes');
  });

  it('CLI-081 each output is self-contained', async () => {
    const dir = T();
    await book(dir, 'book.xlsx', w2());
    await expectOk(cli(dir, ['book.xlsx']), dir);
    for (const [id, other] of [
      ['SHIPPING', 'RETURNS'],
      ['RETURNS', 'SHIPPING'],
    ]) {
      const { xml, definitions } = await loadDmn(join(dir, `${id}.dmn`));
      expect(definitions.id).toBe(`definitions_${id}`);
      const decisions = definitions.drgElement.filter((e) => e.$type === 'dmn:Decision');
      expect(decisions.map((d) => d.id)).toEqual([id]);
      expect(xml).not.toContain(other);
    }
  });

  it('CLI-082 one failing sheet does not block the others', async () => {
    const dir = T();
    await book(dir, 'book.xlsx', w2({ patch: { 'Returns_ DMN': { B5: '"x"' } } }));
    const r = cli(dir, ['book.xlsx', '--out-dir', 'out']);
    expectFail(r, 'Returns_ DMN', 'Returns_ DMN!B5');
    await reparseAll(dir);
    expect(existsSync(join(dir, 'out/SHIPPING.dmn'))).toBe(true);
    expect(existsSync(join(dir, 'out/RETURNS.dmn'))).toBe(false);
    expect(
      lines(r.stdout).some((l) => l.includes('Shipping DMN')),
      r.stdout,
    ).toBe(true);
  });

  it('CLI-083 failing sheet listed first does not block a later valid sheet', async () => {
    const dir = T();
    await book(dir, 'book.xlsx', w2({ patch: { 'Shipping DMN': { B5: '"x"' } } }));
    const r = cli(dir, ['book.xlsx', '--out-dir', 'out']);
    expectFail(r, 'Shipping DMN!B5');
    await reparseAll(dir);
    expect(existsSync(join(dir, 'out/RETURNS.dmn'))).toBe(true);
    expect(existsSync(join(dir, 'out/SHIPPING.dmn'))).toBe(false);
  });

  it('CLI-084 every failing sheet is reported', async () => {
    const dir = T();
    await book(
      dir,
      'book.xlsx',
      w2({ patch: { 'Shipping DMN': { B5: '"x"' }, 'Returns_ DMN': { B5: '"x"' } } }),
    );
    const r = cli(dir, ['book.xlsx']);
    expectFailNothingWritten(r, dir, 'Shipping DMN!B5', 'Returns_ DMN!B5');
  });

  it('CLI-085 duplicate decision ids across sheets are a hard error', async () => {
    const dir = T();
    await book(
      dir,
      'book.xlsx',
      w2({ returnsId: 'SHIPPING', extra: { 'Other DMN': returnsSheet('OTHER') } }),
    );
    const r = cli(dir, ['book.xlsx', '--out-dir', 'out']);
    expectFail(r, 'SHIPPING', 'Shipping DMN', 'Returns_ DMN');
    expect(dmnFiles(dir)).toEqual(['out/OTHER.dmn']);
  });

  it('CLI-086 duplicate ids that only collide after sanitization', async () => {
    const dir = T();
    await book(dir, 'book.xlsx', w2({ shippingId: 'Zürich Süd', returnsId: 'ZURICH_SUD' }));
    const r = cli(dir, ['book.xlsx', '--out-dir', 'out']);
    expectFail(r, 'ZURICH_SUD', 'Shipping DMN', 'Returns_ DMN');
    expect(dmnFiles(dir)).toEqual([]);
  });

  it('CLI-087 duplicate ids are case-folded before comparison', async () => {
    const dir = T();
    await book(dir, 'book.xlsx', w2({ shippingId: 'shipping', returnsId: 'SHIPPING' }));
    const r = cli(dir, ['book.xlsx', '--out-dir', 'out']);
    expectFail(r, 'SHIPPING', 'Shipping DMN', 'Returns_ DMN');
    expect(dmnFiles(dir)).toEqual([]);
  });

  it('CLI-088 duplicate ids in a sheet excluded by --sheet are not an error', async () => {
    const dir = T();
    await book(dir, 'book.xlsx', w2({ returnsId: 'SHIPPING' }));
    const r = cli(dir, ['book.xlsx', '--sheet', 'Shipping DMN']);
    await expectOk(r, dir);
    expect(dmnFiles(dir)).toEqual(['SHIPPING.dmn']);
  });

  it('CLI-089 sheets with the same name prefix are independent', async () => {
    const dir = T();
    await book(dir, 'w.xlsx', {
      'A DMN': setCells(w1(), { A2: 'A' }),
      'A DMN copy': setCells(w1(), { A2: 'B' }),
    });
    const r = cli(dir, ['w.xlsx']);
    await expectOk(r, dir);
    expect(dmnFiles(dir).sort()).toEqual(['A.dmn', 'B.dmn']);
  });

  it('CLI-088a a fixed output.fileNameTemplate shared by two sheets is an error', async () => {
    const dir = T();
    await book(dir, 'book.xlsx', w2());
    writeCfg(dir, { output: { fileNameTemplate: 'fixed.dmn' } });
    const r = cli(dir, ['book.xlsx', '--config', CFG]);
    expectFail(r, 'fixed.dmn', 'Shipping DMN', 'Returns_ DMN', 'output.fileNameTemplate');
    expect(dmnFiles(dir)).toEqual([]);
  });

  it('CLI-088b an output path outside the output directory is a per-sheet error', async () => {
    const dir = T();
    await book(dir, 'sub/book.xlsx', {
      'Evil DMN': setCells(w1(), { A2: '../evil' }),
      'Good DMN': setCells(w1(), { A2: 'GOOD' }),
    });
    writeCfg(dir, { identity: { sanitizeId: false } });
    const r = cli(dir, ['sub/book.xlsx', '--config', CFG]);
    expectFail(r, 'Evil DMN', 'outside the output directory');
    expect(dmnFiles(dir)).toEqual(['sub/GOOD.dmn']);
  });

  it('CLI-090 a DMN sheet with no marker row fails, others still convert', async () => {
    const dir = T();
    await book(dir, 'book.xlsx', w2({ extra: { 'Empty DMN': [['hello']] } }));
    const r = cli(dir, ['book.xlsx']);
    expectFail(r, 'Empty DMN', /marker|input|output/i, /5/);
    await reparseAll(dir);
    expect(dmnFiles(dir).sort()).toEqual(['RETURNS.dmn', 'SHIPPING.dmn']);
  });
});

describe('H. --hit-policy, --namespace, --platform, --no-pretty', OPTS, () => {
  it('CLI-100 --hit-policy applies when the sheet has no policy column', async () => {
    const dir = T();
    await writeW1(dir);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--hit-policy', 'FIRST', '--json']), dir);
    expect(hitPolicyOf(readText(join(dir, 'RATES.dmn')))).toBe('FIRST');
    expect(readJson(join(dir, 'RATES.model.json')).decisions[0].hitPolicy).toBe('FIRST');
  });

  it('CLI-101 sheet policy column beats --hit-policy', async () => {
    const dir = T();
    await writeW1(dir, 'one_DMN.xlsx', w1With([{ marker: 'policy', name: 'RULE ORDER' }]));
    await expectOk(cli(dir, ['one_DMN.xlsx', '--hit-policy', 'FIRST']), dir);
    expect(hitPolicyOf(readText(join(dir, 'RATES.dmn')))).toBe('RULE ORDER');
  });

  it('CLI-102 --hit-policy beats config hitPolicy.default', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { hitPolicy: { default: 'ANY' } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG, '--hit-policy', 'FIRST']), dir);
    expect(hitPolicyOf(readText(join(dir, 'RATES.dmn')))).toBe('FIRST');
  });

  it('CLI-103 config hitPolicy.default applies without the flag', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { hitPolicy: { default: 'ANY' } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG]), dir);
    expect(hitPolicyOf(readText(join(dir, 'RATES.dmn')))).toBe('ANY');
  });

  it('CLI-104 --hit-policy UNIQUE emits no hitPolicy attribute', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { hitPolicy: { default: 'FIRST' } });
    const r = cli(dir, ['one_DMN.xlsx', '--config', CFG, '--hit-policy', 'UNIQUE', '--json']);
    await expectOk(r, dir);
    expect(hitPolicyOf(readText(join(dir, 'RATES.dmn')))).toBeUndefined();
    expect(readJson(join(dir, 'RATES.model.json')).decisions[0].hitPolicy).toBe('UNIQUE');
  });

  it('CLI-105 --hit-policy value is case-insensitive', async () => {
    const dir = T();
    await writeW1(dir);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--hit-policy', 'rule order']), dir);
    expect(hitPolicyOf(readText(join(dir, 'RATES.dmn')))).toBe('RULE ORDER');
  });

  it('CLI-106 unknown --hit-policy value is rejected', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '--hit-policy', 'SOMETIMES']);
    expectFailNothingWritten(r, dir, 'SOMETIMES', /UNIQUE|allowed|expected|one of/i);
  });

  it('CLI-107 --hit-policy COLLECT without a policy column has no aggregation', async () => {
    const dir = T();
    await writeW1(dir, 'one_DMN.xlsx', w1Int());
    await expectOk(cli(dir, ['one_DMN.xlsx', '--hit-policy', 'COLLECT', '--json']), dir);
    const dt = tag(readText(join(dir, 'RATES.dmn')), 'decisionTable');
    expect(dt.hitPolicy).toBe('COLLECT');
    expect(dt.aggregation).toBeUndefined();
    expect(readJson(join(dir, 'RATES.model.json')).decisions[0].aggregation).toBeNull();
  });

  it('CLI-108 --hit-policy PRIORITY without allowed values fails', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '--hit-policy', 'PRIORITY']);
    expectFailNothingWritten(r, dir, 'PRIORITY', 'result');
  });

  it('CLI-109 --namespace sets the definitions namespace', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '--namespace', 'https://example.com/dmn', '--json']);
    await expectOk(r, dir);
    expect(tag(readText(join(dir, 'RATES.dmn')), 'definitions').namespace).toBe(
      'https://example.com/dmn',
    );
    expect(readJson(join(dir, 'RATES.model.json')).definitions.namespace).toBe(
      'https://example.com/dmn',
    );
  });

  it('CLI-110 --namespace beats config output.namespace', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { output: { namespace: 'urn:cfg' } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG, '--namespace', 'urn:flag']), dir);
    expect(tag(readText(join(dir, 'RATES.dmn')), 'definitions').namespace).toBe('urn:flag');
  });

  it('CLI-111 config output.namespace applies without the flag', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { output: { namespace: 'urn:cfg' } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG]), dir);
    expect(tag(readText(join(dir, 'RATES.dmn')), 'definitions').namespace).toBe('urn:cfg');
  });

  it('CLI-112 --platform camunda8 is plumbed through', async () => {
    const dir = T();
    await writeW1(dir);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--platform', 'camunda8']), dir);
    const xml = readText(join(dir, 'RATES.dmn'));
    expect(tag(xml, 'definitions')['modeler:executionPlatform']).toBe('Camunda Cloud');
    expect(tag(xml, 'decision')['camunda:historyTimeToLive']).toBeUndefined();
  });

  it('CLI-113 --platform with an invalid value', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '--platform', 'camunda9']);
    expectFailNothingWritten(r, dir, 'camunda9', 'camunda7', 'camunda8');
  });

  it('CLI-114 --no-pretty writes unformatted XML', async () => {
    const dir = T();
    await writeW1(dir);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--out-dir', 'a']), dir);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--out-dir', 'b', '--no-pretty']), dir);
    const a = readText(join(dir, 'a/RATES.dmn'));
    const b = readText(join(dir, 'b/RATES.dmn'));
    const body = b.replace(/^<\?xml[^>]*\?>\s*/, '').trimEnd();
    expect(body).not.toContain('\n');
    expect(b.length).toBeLessThan(a.length);
    expect(summary(await loadDmn(join(dir, 'b/RATES.dmn')))).toEqual(
      summary(await loadDmn(join(dir, 'a/RATES.dmn'))),
    );
  });

  it('CLI-115 config output.format: false equals --no-pretty', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { output: { format: false } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--out-dir', 'b', '--no-pretty']), dir);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--out-dir', 'c', '--config', CFG]), dir);
    expect(readText(join(dir, 'c/RATES.dmn'))).toBe(readText(join(dir, 'b/RATES.dmn')));
  });

  it('CLI-116 output.namespaceStyle: "prefixed" keeps dmn: tags', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { output: { namespaceStyle: 'prefixed' } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG]), dir);
    const xml = readText(join(dir, 'RATES.dmn'));
    expect(xml).toContain('<dmn:definitions');
    expect(xml).toContain('xmlns:dmn="https://www.omg.org/spec/DMN/20191111/MODEL/"');
    expect(xml).not.toMatch(/<definitions\b/);
  });
});

describe('I. --analyze', OPTS, () => {
  async function analyze(
    dir,
    rows,
    { args = [], cfg, file = 'ovl_DMN.xlsx', sheet = 'Ovl DMN' } = {},
  ) {
    await book(dir, file, { [sheet]: rows });
    if (cfg) writeCfg(dir, cfg);
    return cli(dir, [file, '--analyze', ...(cfg ? ['--config', CFG] : []), ...args]);
  }

  it('CLI-120 overlapping rules under UNIQUE are reported', async () => {
    const dir = T();
    const r = await analyze(dir, wOvl());
    await expectOk(r, dir);
    expect(existsSync(join(dir, 'OVL.dmn'))).toBe(true);
    const ovl = findings(r.stdout, 'overlap');
    const hit = ovl.find((l) => l.includes('rule_1') && l.includes('rule_2'));
    expect(hit, r.stdout).toBeDefined();
    expect(hit).toContain('OVL');
    expect(hit).toMatch(/\b5\b/);
    expect(hit).toMatch(/\b6\b/);
    expect(hit).toMatch(/error/i);
    expect(ovl.filter((l) => l.includes('rule_3'))).toEqual([]);
  });

  it('CLI-121 no overlap reported when inputs are disjoint', async () => {
    const dir = T();
    const r = await analyze(dir, setCells(wOvl(), { B6: '"US"', C6: '< 50', D6: 2 }));
    await expectOk(r, dir);
    expect(findings(r.stdout, 'overlap')).toEqual([]);
  });

  it('CLI-122 numeric boundaries: < 50 and >= 50 do not overlap', async () => {
    const dir = T();
    const rows = wOvl([
      [null, '"EU"', '< 50', 1],
      [null, '"EU"', '>= 50', 2],
    ]);
    const r = await analyze(dir, rows);
    await expectOk(r, dir);
    expect(findings(r.stdout, 'overlap')).toEqual([]);
  });

  it('CLI-123 numeric boundaries: <= 50 and >= 50 do overlap', async () => {
    const dir = T();
    const rows = wOvl([
      [null, '"EU"', '<= 50', 1],
      [null, '"EU"', '>= 50', 2],
    ]);
    const r = await analyze(dir, rows);
    await expectOk(r, dir);
    const ovl = findings(r.stdout, 'overlap');
    expect(ovl, r.stdout).toHaveLength(1);
    expect(ovl[0]).toContain('rule_1');
    expect(ovl[0]).toContain('rule_2');
  });

  it('CLI-124 ranges [1..10] and [10..20] overlap; [1..10) and [10..20] do not', async () => {
    const cols = [
      { marker: 'id', name: 'OVL' },
      { marker: 'input', name: 'amount', type: 'integer', label: 'Amount' },
      { marker: 'output', name: 'fee', type: 'integer', label: 'Fee' },
    ];
    const dir = T();
    const a = await analyze(
      dir,
      decisionSheet(cols, [
        [null, '[1..10]', 1],
        [null, '[10..20]', 2],
      ]),
      { file: 'a_DMN.xlsx' },
    );
    await expectOk(a, dir);
    expect(findings(a.stdout, 'overlap'), a.stdout).toHaveLength(1);
    const b = await analyze(
      dir,
      decisionSheet(cols, [
        [null, '[1..10)', 1],
        [null, '[10..20]', 2],
      ]),
      { file: 'b_DMN.xlsx' },
    );
    await expectOk(b, dir);
    expect(findings(b.stdout, 'overlap')).toEqual([]);
  });

  it('CLI-125 duplicate rules are reported', async () => {
    const dir = T();
    const r = await analyze(dir, setCells(wOvl(), { B6: '"EU"', C6: '< 100', D6: 9 }));
    await expectOk(r, dir);
    const dup = findings(r.stdout, 'duplicate');
    expect(
      dup.some((l) => l.includes('rule_1') && l.includes('rule_2')),
      r.stdout,
    ).toBe(true);
  });

  it('CLI-126 duplicate detection is independent of the hit policy', async () => {
    const dir = T();
    const rows = wOvl(
      [
        [null, '"EU"', '< 100', 1],
        [null, '"EU"', '< 100', 9],
        [null, '"US"', '>= 100', 3],
      ],
      'FIRST',
    );
    const r = await analyze(dir, rows);
    await expectOk(r, dir);
    const dup = findings(r.stdout, 'duplicate');
    expect(
      dup.some((l) => l.includes('rule_1') && l.includes('rule_2')),
      r.stdout,
    ).toBe(true);
  });

  it('CLI-127 overlaps are not reported under FIRST, RULE ORDER or COLLECT', async () => {
    const dir = T();
    for (const [i, policy] of ['FIRST', 'RULE ORDER', 'COLLECT'].entries()) {
      const r = await analyze(dir, wOvl(OVL_RULES, policy), { file: `p${i}_DMN.xlsx` });
      await expectOk(r, dir);
      expect(findings(r.stdout, 'overlap'), `${policy}\n${r.stdout}`).toEqual([]);
    }
  });

  it('CLI-128 ANY with overlapping rules and different outputs is reported; same outputs are not', async () => {
    const dir = T();
    const a = await analyze(dir, wOvl(OVL_RULES, 'ANY'), { file: 'a_DMN.xlsx' });
    await expectOk(a, dir);
    const ovl = findings(a.stdout, 'overlap');
    const hit = ovl.find((l) => l.includes('rule_1') && l.includes('rule_2'));
    expect(hit, a.stdout).toBeDefined();
    expect(hit).toMatch(/warn/i);
    const same = [OVL_RULES[0], [null, '"EU"', '< 50', 1], OVL_RULES[2]];
    const b = await analyze(dir, wOvl(same, 'ANY'), { file: 'b_DMN.xlsx' });
    await expectOk(b, dir);
    expect(findings(b.stdout, 'overlap')).toEqual([]);
  });

  const SH_COLS = [
    { marker: 'policy', name: 'FIRST' },
    { marker: 'id', name: 'SH' },
    { marker: 'input', name: 'region', type: 'string', label: 'Region' },
    { marker: 'output', name: 'fee', type: 'integer', label: 'Fee' },
  ];
  const shSheet = (reversed = false) =>
    decisionSheet(
      SH_COLS,
      reversed
        ? [
            [null, null, '"EU"', 2],
            [null, null, '-', 1],
          ]
        : [
            [null, null, '-', 1],
            [null, null, '"EU"', 2],
          ],
    );

  it('CLI-129 shadowed rule under FIRST', async () => {
    const dir = T();
    const r = await analyze(dir, shSheet(), { file: 'sh_DMN.xlsx', sheet: 'Sh DMN' });
    await expectOk(r, dir);
    expect(
      findings(r.stdout, 'shadowed').some((l) => l.includes('rule_2')),
      r.stdout,
    ).toBe(true);
  });

  it('CLI-130 no shadowed finding when the later rule is not covered', async () => {
    const dir = T();
    const r = await analyze(dir, shSheet(true), { file: 'sh_DMN.xlsx', sheet: 'Sh DMN' });
    await expectOk(r, dir);
    expect(findings(r.stdout, 'shadowed')).toEqual([]);
  });

  const gapSheet = (extraRule = false) =>
    decisionSheet(
      [
        ...(extraRule ? [{ marker: 'policy', name: 'FIRST' }] : []),
        { marker: 'id', name: 'GAP' },
        {
          marker: 'input',
          name: 'region',
          type: 'string',
          label: 'Region',
          allowed: '"EU","US","APAC"',
        },
        { marker: 'input', name: 'member', type: 'boolean', label: 'Member' },
        { marker: 'output', name: 'fee', type: 'integer', label: 'Fee' },
      ],
      [
        [null, '"EU"', 'true', 1],
        [null, '"US"', '-', 2],
        ...(extraRule ? [[null, '-', '-', 9]] : []),
      ].map((r) => (extraRule ? [null, ...r] : r)),
      { allowedValues: true },
    );

  it('CLI-131 gaps are reported for finite domains', async () => {
    const dir = T();
    const r = await analyze(dir, gapSheet(), {
      file: 'gap.xlsx',
      sheet: 'Gap DMN',
      cfg: ALLOWED_VALUES_LAYOUT,
    });
    await expectOk(r, dir);
    const gaps = findings(r.stdout, 'gaps');
    const combos = gaps.filter((l) => /\[\w+, \w+\]/.test(l));
    expect(combos, r.stdout).toHaveLength(3);
    for (const c of ['[EU, false]', '[APAC, true]', '[APAC, false]'])
      expect(
        combos.some((l) => l.includes(c)),
        c,
      ).toBe(true);
    const cov = gaps.find((l) => l.includes('50.0%'));
    expect(cov, r.stdout).toBeDefined();
    expect(cov).toMatch(/3 of 6/);
  });

  it('CLI-132 no gap analysis when a domain is not finite', async () => {
    const dir = T();
    const r = await analyze(dir, wOvl());
    await expectOk(r, dir);
    expect(findings(r.stdout, 'gaps')).toEqual([]);
  });

  it('CLI-133 full coverage reports no gaps', async () => {
    const dir = T();
    const r = await analyze(dir, gapSheet(true), {
      file: 'gap.xlsx',
      sheet: 'Gap DMN',
      cfg: ALLOWED_VALUES_LAYOUT,
    });
    await expectOk(r, dir);
    expect(findings(r.stdout, 'gaps')).toEqual([]);
  });

  it('CLI-134 clean table prints no analysis noise', async () => {
    const dir = T();
    const r = await analyze(dir, w1(), { file: 'one_DMN.xlsx', sheet: 'Rates DMN' });
    await expectOk(r, dir);
    for (const c of ['overlap', 'duplicate', 'shadowed', 'gaps'])
      expect(findings(r.stdout, c), c).toEqual([]);
  });

  it('CLI-135 --analyze still writes the DMN', async () => {
    const dir = T();
    const r = await analyze(dir, wOvl(), { args: ['--out-dir', 'out'] });
    await expectOk(r, dir);
    await loadDmn(join(dir, 'out/OVL.dmn'));
  });

  it('CLI-136 --analyze --validate-only analyzes without writing', async () => {
    const dir = T();
    const r = await analyze(dir, wOvl(), { args: ['--validate-only'] });
    expect(r.code, dump(r)).toBe(0);
    const ovl = findings(r.stdout, 'overlap');
    expect(
      ovl.some((l) => l.includes('rule_1') && l.includes('rule_2')),
      r.stdout,
    ).toBe(true);
    expect(dmnFiles(dir)).toEqual([]);
  });

  it('CLI-137 config analysis.enabled: true runs analysis without the flag', async () => {
    const dir = T();
    await book(dir, 'ovl_DMN.xlsx', { 'Ovl DMN': wOvl() });
    writeCfg(dir, { analysis: { enabled: true } });
    const r = cli(dir, ['ovl_DMN.xlsx', '--config', CFG]);
    await expectOk(r, dir);
    expect(findings(r.stdout, 'overlap').length, r.stdout).toBeGreaterThan(0);
  });

  it('CLI-138 config analysis.checks limits the checks', async () => {
    const dir = T();
    const r = await analyze(dir, setCells(wOvl(), { B6: '"EU"', C6: '< 100', D6: 9 }), {
      cfg: { analysis: { checks: ['duplicate'] } },
    });
    await expectOk(r, dir);
    expect(findings(r.stdout, 'duplicate').length, r.stdout).toBeGreaterThan(0);
    expect(findings(r.stdout, 'overlap')).toEqual([]);
  });

  it('CLI-139 analysis.failOn: "error" turns an error finding into exit 1', async () => {
    const dir = T();
    const r = await analyze(dir, wOvl(), { cfg: { analysis: { failOn: 'error' } } });
    expect(r.code, dump(r)).toBe(1);
    expect(findings(r.stdout + r.stderr, 'overlap').length, dump(r)).toBeGreaterThan(0);
    await loadDmn(join(dir, 'OVL.dmn'));
  });

  it('CLI-140 analysis.failOn: "error" ignores warnings', async () => {
    const dir = T();
    const r = await analyze(dir, shSheet(), {
      file: 'sh_DMN.xlsx',
      sheet: 'Sh DMN',
      cfg: { analysis: { failOn: 'error' } },
    });
    expect(r.code, dump(r)).toBe(0);
    await reparseAll(dir);
  });

  it('CLI-141 analysis.failOn: "any" fails on warnings too', async () => {
    const dir = T();
    const r = await analyze(dir, shSheet(), {
      file: 'sh_DMN.xlsx',
      sheet: 'Sh DMN',
      cfg: { analysis: { failOn: 'any' } },
    });
    expect(r.code, dump(r)).toBe(1);
    await reparseAll(dir);
  });

  it('CLI-142 analysis.failOn: "none" (default) never fails', async () => {
    const dir = T();
    const r = await analyze(dir, wOvl());
    expect(r.code, dump(r)).toBe(0);
    await reparseAll(dir);
  });

  it('CLI-143 analysis.format: "json" prints machine-readable findings', async () => {
    const dir = T();
    const r = await analyze(dir, wOvl(), { cfg: { analysis: { format: 'json' } } });
    await expectOk(r, dir);
    const json = lines(r.stdout)
      .filter((l) => !l.includes('OVL.dmn'))
      .join('\n');
    const parsed = JSON.parse(json);
    const docs = Array.isArray(parsed) ? parsed : [parsed];
    const doc = docs.find((d) => d.decisionId === 'OVL');
    expect(doc, json).toBeDefined();
    const f = doc.findings.find((x) => x.check === 'overlap');
    expect(f).toMatchObject({ check: 'overlap', severity: 'error' });
    expect(f.message).toContain('rule_1');
    expect(f.message).toContain('rule_2');
  });

  it('CLI-144 analysis runs per sheet on a multi-sheet workbook', async () => {
    const dir = T();
    await book(dir, 'm.xlsx', { 'Ovl DMN': wOvl(), 'Rates DMN': w1() });
    const r = cli(dir, ['m.xlsx', '--analyze']);
    await expectOk(r, dir);
    expect(dmnFiles(dir).sort()).toEqual(['OVL.dmn', 'RATES.dmn']);
    const ovl = findings(r.stdout, 'overlap');
    expect(
      ovl.some((l) => l.includes('OVL')),
      r.stdout,
    ).toBe(true);
    const all = lines(r.stdout).filter((l) => /overlap|duplicate|shadowed|gaps/.test(l));
    expect(all.filter((l) => l.includes('RATES'))).toEqual([]);
  });
});

describe('J. Config file discovery, precedence and validation', OPTS, () => {
  const htl = (dir, file = 'RATES.dmn') =>
    tag(readText(join(dir, file)), 'decision')['camunda:historyTimeToLive'];

  it('CLI-150 ./excel2dmn.config.json in cwd is picked up automatically', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { camunda: { historyTimeToLive: 'P30D' } }, CWD_CFG);
    await expectOk(cli(dir, ['one_DMN.xlsx']), dir);
    expect(htl(dir)).toBe('P30D');
  });

  it('CLI-151 the cwd config is looked up in cwd, not beside the input', async () => {
    const dir = T();
    await writeW1(dir, 'in/one_DMN.xlsx');
    writeCfg(dir, { camunda: { historyTimeToLive: 'P30D' } }, `in/${CWD_CFG}`);
    await expectOk(cli(dir, ['in/one_DMN.xlsx']), dir);
    expect(htl(dir, 'in/RATES.dmn')).toBe('P180D');
  });

  it('CLI-152 --config beats the cwd config', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { camunda: { historyTimeToLive: 'P30D' } }, CWD_CFG);
    writeCfg(dir, { camunda: { historyTimeToLive: 'P60D' } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG]), dir);
    expect(htl(dir)).toBe('P60D');
  });

  it('CLI-153 with --config, keys only in the cwd config are not applied', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { camunda: { versionTag: '9.9' } }, CWD_CFG);
    writeCfg(dir, { camunda: { historyTimeToLive: 'P60D' } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG]), dir);
    const d = tag(readText(join(dir, 'RATES.dmn')), 'decision');
    expect(d['camunda:historyTimeToLive']).toBe('P60D');
    expect(d['camunda:versionTag']).toBeUndefined();
  });

  it('CLI-154 CLI flag beats --config beats cwd config beats defaults (full chain)', async () => {
    const dir = T();
    await writeW1(dir, 'one_DMN.xlsx', w1Int());
    writeCfg(dir, { hitPolicy: { default: 'ANY' }, output: { namespace: 'urn:cwd' } }, CWD_CFG);
    writeCfg(dir, { hitPolicy: { default: 'COLLECT' } });
    const read = (o) => {
      const xml = readText(join(dir, o, 'RATES.dmn'));
      return [hitPolicyOf(xml), tag(xml, 'definitions').namespace];
    };
    await expectOk(cli(dir, ['one_DMN.xlsx', '--out-dir', 'o1']), dir);
    expect(read('o1')).toEqual(['ANY', 'urn:cwd']);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG, '--out-dir', 'o2']), dir);
    expect(read('o2')).toEqual(['COLLECT', DEFAULT_NS]);
    const r3 = cli(dir, [
      'one_DMN.xlsx',
      '--config',
      CFG,
      '--hit-policy',
      'FIRST',
      '--out-dir',
      'o3',
    ]);
    await expectOk(r3, dir);
    expect(read('o3')[0]).toBe('FIRST');
    rmSync(join(dir, CWD_CFG));
    await expectOk(cli(dir, ['one_DMN.xlsx', '--out-dir', 'o4']), dir);
    expect(read('o4')).toEqual([undefined, DEFAULT_NS]);
  });

  it('CLI-155 config is deep-merged over the defaults', async () => {
    const dir = T();
    await writeW1(dir, 'one_DMN.xlsx', setCells(w1(), { A1: 'KEY' }));
    writeCfg(dir, { markers: { id: 'KEY' } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG]), dir);
    const s = summary(await loadDmn(join(dir, 'RATES.dmn')));
    expect(s.inputs).toEqual(['amount']);
    expect(s.outputs).toEqual(['result']);
  });

  it('CLI-156 arrays in config replace, not merge', async () => {
    const dir = T();
    writeCfg(dir, { rules: { anyInputTokens: ['*'] } });
    await writeW1(dir, 'a_DMN.xlsx', setCells(w1(), { B6: '*' }));
    await expectOk(cli(dir, ['a_DMN.xlsx', '--config', CFG, '--json', '--out-dir', 'a']), dir);
    expect(readJson(join(dir, 'a/RATES.model.json')).decisions[0].rules[1].inputEntries).toEqual([
      '',
    ]);
    await writeW1(dir, 'b_DMN.xlsx', setCells(w1(), { B6: '-' }));
    await expectOk(cli(dir, ['b_DMN.xlsx', '--config', CFG, '--json', '--out-dir', 'b']), dir);
    expect(readJson(join(dir, 'b/RATES.model.json')).decisions[0].rules[1].inputEntries).toEqual([
      '-',
    ]);
  });

  it('CLI-157 an empty config object {} works out of the box', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, {});
    await expectOk(cli(dir, ['one_DMN.xlsx', '--out-dir', 'a']), dir);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG, '--out-dir', 'b']), dir);
    expect(readText(join(dir, 'b/RATES.dmn'))).toBe(readText(join(dir, 'a/RATES.dmn')));
  });

  it('CLI-158 a zero-byte config file works out of the box', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, '');
    await expectOk(cli(dir, ['one_DMN.xlsx', '--out-dir', 'a']), dir);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG, '--out-dir', 'b']), dir);
    expect(readText(join(dir, 'b/RATES.dmn'))).toBe(readText(join(dir, 'a/RATES.dmn')));
  });

  it('CLI-159 a zero-byte cwd config works out of the box', async () => {
    const dir = T();
    await writeW1(dir);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--out-dir', 'a']), dir);
    writeCfg(dir, '', CWD_CFG);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--out-dir', 'b']), dir);
    expect(readText(join(dir, 'b/RATES.dmn'))).toBe(readText(join(dir, 'a/RATES.dmn')));
  });

  it('CLI-160 --config pointing at a missing file', async () => {
    const dir = T();
    await writeW1(dir);
    const r = cli(dir, ['one_DMN.xlsx', '--config', 'missing.json']);
    expectFailNothingWritten(r, dir, 'missing.json');
  });

  it('CLI-161 invalid JSON in --config', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, '{ "platform": "camunda8", }');
    const r = cli(dir, ['one_DMN.xlsx', '--config', CFG]);
    expectFailNothingWritten(r, dir, 'cfg.json', /read|pars|JSON/i);
  });

  it('CLI-162 invalid JSON in the cwd config', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, 'not json', CWD_CFG);
    const r = cli(dir, ['one_DMN.xlsx']);
    expectFailNothingWritten(r, dir, CWD_CFG, /read|pars|JSON/i);
  });

  it('CLI-163 config that is valid JSON but not an object', async () => {
    const dir = T();
    await writeW1(dir);
    for (const text of ['[1, 2]', '"text"', 'null']) {
      writeCfg(dir, text);
      const r = cli(dir, ['one_DMN.xlsx', '--config', CFG]);
      expectFailNothingWritten(r, dir, /object/i);
    }
  });

  /** Convert W1 with cfg.json = `cfg` and expect a config error naming every needle. */
  async function badConfig(cfg, needles, args = []) {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, cfg);
    const r = cli(dir, ['one_DMN.xlsx', '--config', CFG, ...args]);
    expectFailNothingWritten(r, dir, ...needles);
  }

  it('CLI-164 unknown platform value in config', async () => {
    await badConfig({ platform: 'zeebe' }, ['zeebe', 'camunda7', 'camunda8']);
  });

  it('CLI-165 unknown sheet.match value', async () => {
    await badConfig({ sheet: { match: 'fuzzy' } }, [/sheet[./]match/, 'fuzzy']);
  });

  it('CLI-166 unknown hitPolicy.default in config', async () => {
    await badConfig({ hitPolicy: { default: 'SOMETIMES' } }, ['SOMETIMES']);
  });

  it('CLI-167 unknown output.namespaceStyle', async () => {
    await badConfig({ output: { namespaceStyle: 'weird' } }, [/output[./]namespaceStyle/, 'weird']);
  });

  it('CLI-168 unknown identity.idCase', async () => {
    await badConfig({ identity: { idCase: 'lower' } }, [/identity[./]idCase/]);
  });

  it('CLI-169 unknown types.nonCamundaTypeAction', async () => {
    await badConfig({ types: { nonCamundaTypeAction: 'ignore' } }, [
      /types[./]nonCamundaTypeAction/,
    ]);
  });

  it('CLI-170 unknown validation.feel.mode', async () => {
    await badConfig({ validation: { feel: { mode: 'some' } } }, [/validation[./]feel[./]mode/]);
  });

  it('CLI-171 unknown analysis.failOn / analysis.format', async () => {
    await badConfig({ analysis: { failOn: 'sometimes' } }, ['failOn', 'sometimes'], ['--analyze']);
    await badConfig({ analysis: { format: 'yaml' } }, ['format', 'yaml'], ['--analyze']);
  });

  it('CLI-172 wrong value type for a known key', async () => {
    await badConfig({ header: { scanRows: 'five' } }, [/header[./]scanRows/, /integer|number/i]);
    await badConfig({ markers: { caseInsensitive: 'yes' } }, [
      /markers[./]caseInsensitive/,
      /boolean/i,
    ]);
  });

  // Decided: an unknown key is a stderr warning naming the key path, not an error.
  it('CLI-173 unknown keys are reported as warnings', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, {
      $schema: './schema/config.schema.json',
      platfrom: 'camunda8',
      header: { scanrows: 3 },
      types: { number: { allowExpression: false } },
    });
    const r = cli(dir, ['one_DMN.xlsx', '--config', CFG]);
    expect(r.code, dump(r)).toBe(0);
    await reparseAll(dir);
    const warnings = lines(r.stderr).filter((l) => /unknown config key/.test(l));
    expect(warnings, r.stderr).toHaveLength(3);
    expect(r.stderr).toContain('"platfrom"');
    expect(r.stderr).toContain('"header.scanrows"');
    expect(r.stderr).toContain('"types.number.allowExpression"');
    expect(r.stderr).not.toContain('$schema');
    expect(r.stdout).not.toMatch(/unknown config key/);
    // The typo falls back to the default: still a Camunda 7 file.
    expect(readText(join(dir, 'RATES.dmn'))).toContain('camunda:historyTimeToLive');
  });

  it('CLI-174 config validation errors are reported all at once', async () => {
    await badConfig({ platform: 'zeebe', sheet: { match: 'fuzzy' } }, [
      'platform',
      /sheet[./]match/,
    ]);
  });

  it('CLI-174a an invalid regex in sheet.value is a config error', async () => {
    await badConfig({ sheet: { match: 'regex', value: '([' } }, [
      /sheet\.value is not a valid regular expression/,
    ]);
  });

  const RENAMED = { markers: { id: 'KEY', input: 'in', output: 'out' } };

  it('CLI-175 --config applies to init', async () => {
    const dir = T();
    writeCfg(dir, RENAMED);
    const r = cli(dir, ['init', '--config', CFG, '-o', 't_DMN.xlsx']);
    await expectOk(r, dir);
    const row = await markerRow(join(dir, 't_DMN.xlsx'));
    for (const m of ['KEY', 'in', 'out']) expect(row).toContain(m);
    for (const m of ['id', 'input', 'output']) expect(row).not.toContain(m);
  });

  it('CLI-176 cwd config applies to init too', async () => {
    const dir = T();
    writeCfg(dir, RENAMED, CWD_CFG);
    const r = cli(dir, ['init']);
    await expectOk(r, dir);
    const row = await markerRow(join(dir, 'decision_DMN.xlsx'));
    for (const m of ['KEY', 'in', 'out']) expect(row).toContain(m);
    for (const m of ['id', 'input', 'output']) expect(row).not.toContain(m);
  });

  it('CLI-177 types.nonCamundaTypeAction: "warn" prints the warning and succeeds', async () => {
    const dir = T();
    await writeW1(dir, 'one_DMN.xlsx', setCells(w1(), { B3: 'number' }));
    writeCfg(dir, { types: { nonCamundaTypeAction: 'warn' } });
    const r = cli(dir, ['one_DMN.xlsx', '--config', CFG]);
    expect(r.code, dump(r)).toBe(0);
    await reparseAll(dir);
    expect(tag(readText(join(dir, 'RATES.dmn')), 'inputExpression').typeRef).toBe('number');
    const warn = lines(r.stderr + '\n' + r.stdout).filter((l) => l.includes('Rates DMN!B3'));
    expect(
      warn.some((l) => l.includes('number')),
      dump(r),
    ).toBe(true);
  });

  it('CLI-178 types.nonCamundaTypeAction: "off" is silent', async () => {
    const dir = T();
    await writeW1(dir, 'one_DMN.xlsx', setCells(w1(), { B3: 'number' }));
    writeCfg(dir, { types: { nonCamundaTypeAction: 'off' } });
    const r = cli(dir, ['one_DMN.xlsx', '--config', CFG]);
    await expectOk(r, dir);
    expect(r.stdout).not.toMatch(/warn/i);
  });

  it('CLI-179 zero input columns: warn but continue', async () => {
    const dir = T();
    const rows = decisionSheet(
      [
        { marker: 'id', name: 'NOIN' },
        { marker: 'output', name: 'result', type: 'string', label: 'Result' },
      ],
      [[null, '"A"']],
    );
    await book(dir, 'noin.xlsx', { 'NoIn DMN': rows });
    const r = cli(dir, ['noin.xlsx']);
    expect(r.code, dump(r)).toBe(0);
    const { xml, table } = await loadDmn(join(dir, 'NOIN.dmn'));
    expect(xml).not.toMatch(/<input\b/);
    expect(table.rule).toHaveLength(1);
    const all = `${r.stderr}\n${r.stdout}`;
    const warn = lines(all).filter((l) => /\b(no|zero|0)\s+input/i.test(l));
    expect(warn.length, dump(r)).toBeGreaterThan(0);
    expect(warn.join('\n') + r.stderr).toContain('NoIn DMN');
  });

  it('CLI-179a enforceAllowedValues rejects an out-of-domain input whatever validation.feel.mode is', async () => {
    const dir = T();
    const rows = decisionSheet(
      [
        { marker: 'id', name: 'DOM' },
        { marker: 'input', name: 'region', type: 'string', label: 'Region', allowed: '"EU","US"' },
        { marker: 'output', name: 'result', type: 'string', label: 'Result' },
      ],
      [[null, '"APAC"', '"X"']],
      { allowedValues: true },
    );
    await book(dir, 'dom.xlsx', { 'Dom DMN': rows });
    for (const mode of ['all-inputs', 'any-inputs', 'off']) {
      writeCfg(dir, {
        ...ALLOWED_VALUES_LAYOUT,
        validation: { enforceAllowedValues: true, feel: { mode } },
      });
      const r = cli(dir, ['dom.xlsx', '--config', CFG]);
      expectFailNothingWritten(r, dir, 'Dom DMN!B6', 'outside the allowed values');
    }
  });
});

describe('K. Marker and sheet customization via config', OPTS, () => {
  it('CLI-190 renamed markers are recognized', async () => {
    const dir = T();
    await writeW1(dir, 'one_DMN.xlsx', setCells(w1(), { A1: 'KEY', B1: 'in', C1: 'out' }));
    writeCfg(dir, { markers: { id: 'KEY', input: 'in', output: 'out' } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG]), dir);
    const s = summary(await loadDmn(join(dir, 'RATES.dmn')));
    expect(s).toEqual({
      id: 'RATES',
      inputs: ['amount'],
      outputs: ['result'],
      rules: [
        ['< 10', '"LOW"'],
        ['>= 10', '"HIGH"'],
      ],
    });
  });

  it('CLI-191 with renamed markers, the default keywords become helper columns', async () => {
    const dir = T();
    const rows = setCells(w1(), {
      A1: 'KEY',
      B1: 'in',
      C1: 'out',
      D1: 'input',
      D2: 'extra',
      D3: 'string',
      D4: 'Extra',
      D5: '"x"',
      D6: '"y"',
    });
    await writeW1(dir, 'one_DMN.xlsx', rows);
    writeCfg(dir, { markers: { id: 'KEY', input: 'in', output: 'out' } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG, '--json']), dir);
    const m = readJson(join(dir, 'RATES.model.json'));
    expect(m.decisions[0].inputs.map((i) => i.expression)).toEqual(['amount']);
    expect(readText(join(dir, 'RATES.dmn'))).not.toContain('extra');
  });

  it('CLI-192 marker matching is case-insensitive and trimmed by default', async () => {
    const dir = T();
    await writeW1(dir, 'a_DMN.xlsx');
    await writeW1(dir, 'b_DMN.xlsx', setCells(w1(), { A1: ' ID  ', B1: 'INPUT', C1: 'Output' }));
    await expectOk(cli(dir, ['a_DMN.xlsx', '--out-dir', 'a']), dir);
    await expectOk(cli(dir, ['b_DMN.xlsx', '--out-dir', 'b']), dir);
    expect(readText(join(dir, 'b/RATES.dmn'))).toBe(readText(join(dir, 'a/RATES.dmn')));
  });

  it('CLI-193 markers.caseInsensitive: false makes markers exact', async () => {
    const dir = T();
    await writeW1(dir, 'one_DMN.xlsx', setCells(w1(), { A1: 'ID' }));
    writeCfg(dir, { markers: { caseInsensitive: false } });
    const r = cli(dir, ['one_DMN.xlsx', '--config', CFG]);
    expectFailNothingWritten(r, dir, /missing.*\bid\b.*marker/i, 'Rates DMN');
  });

  it('CLI-194 renamed annotations marker and custom separator', async () => {
    const dir = T();
    const rows = setCells(w1(), { D1: 'note', E1: 'note', D5: 'a', E5: 'b' });
    await writeW1(dir, 'one_DMN.xlsx', rows);
    writeCfg(dir, { markers: { annotations: 'note', annotationSeparator: ' // ' } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG, '--json']), dir);
    expect(readJson(join(dir, 'RATES.model.json')).decisions[0].rules[0].description).toBe(
      'a // b',
    );
    expect(readText(join(dir, 'RATES.dmn'))).toMatch(
      /<rule id="rule_1">\s*<description>a \/\/ b<\/description>/,
    );
  });

  it('CLI-195 renamed policy and name markers', async () => {
    const dir = T();
    const rows = w1With([
      { marker: 'hp', name: 'FIRST' },
      { marker: 'title', name: 'Rates Title' },
    ]);
    await writeW1(dir, 'one_DMN.xlsx', rows);
    writeCfg(dir, { markers: { policy: 'hp', name: 'title' } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG]), dir);
    const xml = readText(join(dir, 'RATES.dmn'));
    expect(hitPolicyOf(xml)).toBe('FIRST');
    expect(tag(xml, 'decision')).toMatchObject({ id: 'RATES', name: 'Rates Title' });
  });

  it('CLI-196 sheet.value changes the sheet filter', async () => {
    const dir = T();
    await book(dir, 'w.xlsx', {
      'Rates TABLE': w1(),
      'Other DMN': setCells(w1(), { A2: 'OTHER' }),
    });
    writeCfg(dir, { sheet: { value: 'TABLE' } });
    await expectOk(cli(dir, ['w.xlsx', '--config', CFG]), dir);
    expect(dmnFiles(dir)).toEqual(['RATES.dmn']);
  });

  it('CLI-197 sheet.match: "exact"', async () => {
    const dir = T();
    await book(dir, 'w.xlsx', {
      DMN: setCells(w1(), { A2: 'A' }),
      'My DMN': setCells(w1(), { A2: 'B' }),
    });
    writeCfg(dir, { sheet: { match: 'exact', value: 'DMN' } });
    await expectOk(cli(dir, ['w.xlsx', '--config', CFG]), dir);
    expect(dmnFiles(dir)).toEqual(['A.dmn']);
  });

  it('CLI-198 sheet.match: "regex"', async () => {
    const dir = T();
    await book(dir, 'w.xlsx', {
      'Rates_ DMN': setCells(w1(), { A2: 'A' }),
      'DMN old': setCells(w1(), { A2: 'B' }),
    });
    writeCfg(dir, { sheet: { match: 'regex', value: '_?\\s?DMN$' } });
    await expectOk(cli(dir, ['w.xlsx', '--config', CFG]), dir);
    expect(dmnFiles(dir)).toEqual(['A.dmn']);
  });

  it('CLI-199 invalid regex in sheet.value', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { sheet: { match: 'regex', value: '([' } });
    const r = cli(dir, ['one_DMN.xlsx', '--config', CFG]);
    expectFailNothingWritten(r, dir, /sheet[./]value|\(\[/);
  });

  it('CLI-200 sheet.caseInsensitive: false', async () => {
    const dir = T();
    await book(dir, 'w.xlsx', {
      'rates dmn': setCells(w1(), { A2: 'A' }),
      'Other DMN': setCells(w1(), { A2: 'B' }),
    });
    writeCfg(dir, { sheet: { caseInsensitive: false } });
    await expectOk(cli(dir, ['w.xlsx', '--config', CFG]), dir);
    expect(dmnFiles(dir)).toEqual(['B.dmn']);
  });

  it('CLI-201 header.scanRows limits marker-row discovery', async () => {
    const dir = T();
    await writeW1(dir, 'one_DMN.xlsx', [['Rates'], [], [], [], [], [], ...w1()]);
    const r = cli(dir, ['one_DMN.xlsx']);
    expectFailNothingWritten(r, dir, 'Rates DMN', /marker|input|output/i, /\b5\b/);
    writeCfg(dir, { header: { scanRows: 7 } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG, '--json']), dir);
    expect(readJson(join(dir, 'RATES.model.json')).decisions[0].rules[0].row).toBe(11);
  });

  it('CLI-202 custom header offsets', async () => {
    const dir = T();
    const rows = [
      ['id', 'input', 'output'],
      [null, 'Amount', 'Result'],
      [null, 'integer', 'string'],
      ['RATES', 'amount', 'result'],
      ...W1_RULES,
    ];
    await writeW1(dir, 'one_DMN.xlsx', rows);
    writeCfg(dir, { header: { nameOffset: 3, typeOffset: 2, labelOffset: 1 } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG, '--json']), dir);
    const d = readJson(join(dir, 'RATES.model.json')).decisions[0];
    expect(d.inputs[0]).toMatchObject({
      expression: 'amount',
      typeRef: 'integer',
      label: 'Amount',
    });
    expect(d.outputs[0]).toMatchObject({ name: 'result', typeRef: 'string', label: 'Result' });
  });

  it('CLI-203 rules.idTemplate with <row>', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { rules: { idTemplate: 'r<row>' } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG, '--json']), dir);
    const m = readJson(join(dir, 'RATES.model.json'));
    expect(m.decisions[0].rules.map((r) => r.id)).toEqual(['r5', 'r6']);
    const { table } = await loadDmn(join(dir, 'RATES.dmn'));
    expect(table.rule.map((r) => r.id)).toEqual(['r5', 'r6']);
  });

  it('CLI-203a identity.collisionSuffix de-duplicates rule ids from a fixed idTemplate', async () => {
    const dir = T();
    await writeW1(dir);
    writeCfg(dir, { rules: { idTemplate: 'rule' }, identity: { collisionSuffix: '-' } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG]), dir);
    const { table } = await loadDmn(join(dir, 'RATES.dmn'));
    expect(table.rule.map((r) => r.id)).toEqual(['rule', 'rule-2']);
  });

  it('CLI-204 identity.idCase: "preserve"', async () => {
    const dir = T();
    await writeW1(dir, 'one_DMN.xlsx', setCells(w1(), { A2: 'Rates Table' }));
    writeCfg(dir, { identity: { idCase: 'preserve' } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG]), dir);
    expect(dmnFiles(dir)).toEqual(['Rates_Table.dmn']);
    expect((await loadDmn(join(dir, 'Rates_Table.dmn'))).decision.id).toBe('Rates_Table');
  });

  it('CLI-205 identity.sanitizeId: false', async () => {
    const dir = T();
    await writeW1(dir, 'one_DMN.xlsx', setCells(w1(), { A2: 'RatesTable' }));
    writeCfg(dir, { identity: { sanitizeId: false } });
    await expectOk(cli(dir, ['one_DMN.xlsx', '--config', CFG]), dir);
    expect(dmnFiles(dir)).toEqual(['RatesTable.dmn']);
    expect((await loadDmn(join(dir, 'RatesTable.dmn'))).decision.id).toBe('RatesTable');
  });
});

describe('L. init', OPTS, () => {
  const MARKERS = ['id', 'name', 'input', 'output', 'policy', 'annotations'];
  const CAMUNDA_TYPES = ['string', 'boolean', 'integer', 'long', 'double', 'date', 'any'];

  async function initDefault(dir) {
    const r = cli(dir, ['init']);
    await expectOk(r, dir);
    return r;
  }
  const onlySheet = async (path) => Object.entries(await readWorkbook(path));

  it('CLI-210 default init writes decision_DMN.xlsx in cwd', async () => {
    const dir = T();
    const r = await initDefault(dir);
    expect(existsSync(join(dir, 'decision_DMN.xlsx'))).toBe(true);
    expect(r.stdout).toContain('decision_DMN.xlsx');
    const sheets = await onlySheet(join(dir, 'decision_DMN.xlsx'));
    expect(sheets).toHaveLength(1);
    expect(sheets[0][0]).toMatch(/DMN/);
  });

  it('CLI-211 the default template converts cleanly', async () => {
    const dir = T();
    await initDefault(dir);
    await expectOk(cli(dir, ['decision_DMN.xlsx', '--out-dir', 'out']), dir);
    const files = dmnFiles(join(dir, 'out'));
    expect(files).toHaveLength(1);
    const { table } = await loadDmn(join(dir, 'out', files[0]));
    expect(table.input.length).toBeGreaterThanOrEqual(1);
    expect(table.output.length).toBeGreaterThanOrEqual(1);
    expect(table.rule.length).toBeGreaterThanOrEqual(2);
    expect(table.rule.length).toBeLessThanOrEqual(3);
    expect(table.rule.some((r) => r.description)).toBe(true);
  });

  it('CLI-212 template layout: marker row content', async () => {
    const dir = T();
    await initDefault(dir);
    const [[, rows]] = await onlySheet(join(dir, 'decision_DMN.xlsx'));
    const row1 = (rows[0] ?? []).map((v) => String(v ?? '').toLowerCase());
    const count = (m) => row1.filter((v) => v === m).length;
    expect(count('policy')).toBe(1);
    expect(count('id')).toBe(1);
    expect(count('name')).toBe(1);
    expect(count('input')).toBeGreaterThanOrEqual(2);
    expect(count('output')).toBeGreaterThanOrEqual(1);
    expect(count('annotations')).toBe(1);
    row1.forEach((m, c) => {
      if (m !== 'input' && m !== 'output') return;
      for (const r of [1, 2, 3])
        expect(String(rows[r]?.[c] ?? '').trim(), `row ${r + 1}`).not.toBe('');
      expect(CAMUNDA_TYPES).toContain(String(rows[2][c]).toLowerCase());
    });
  });

  it('CLI-213 template has an instructions helper the converter ignores', async () => {
    const dir = T();
    await initDefault(dir);
    const [[, rows]] = await onlySheet(join(dir, 'decision_DMN.xlsx'));
    const row1 = (rows[0] ?? []).map((v) =>
      String(v ?? '')
        .trim()
        .toLowerCase(),
    );
    const helps = [];
    rows.forEach((row, r) =>
      (row ?? []).forEach((v, c) => {
        const text = typeof v === 'string' ? v : (v?.richText?.map((t) => t.text).join('') ?? '');
        if (
          text.length > 20 &&
          /marker|input|output/i.test(text) &&
          !MARKERS.includes(row1[c] ?? '')
        )
          helps.push({ r, c, text });
      }),
    );
    expect(helps.length, 'no instructions helper cell found').toBeGreaterThan(0);
    await expectOk(cli(dir, ['decision_DMN.xlsx', '--out-dir', 'out']), dir);
    const xml = readText(join(dir, 'out', dmnFiles(join(dir, 'out'))[0]));
    for (const h of helps) expect(xml).not.toContain(h.text.slice(0, 20));
  });

  /** init with --name, convert, and return the decision. */
  async function initNamed(dir, name, file) {
    await expectOk(cli(dir, ['init', '--name', name, '-o', file]), dir);
    const r = cli(dir, [file, '--out-dir', 'out']);
    await expectOk(r, dir);
    const files = dmnFiles(join(dir, 'out'));
    expect(files).toHaveLength(1);
    return { file: files[0], ...(await loadDmn(join(dir, 'out', files[0]))) };
  }

  it('CLI-214 --name sets decision name and derived id', async () => {
    const dir = T();
    const d = await initNamed(dir, 'Shipping Rate Decision', 's_DMN.xlsx');
    expect(d.file).toBe('SHIPPING_RATE_DECISION.dmn');
    expect(d.decision.id).toBe('SHIPPING_RATE_DECISION');
    expect(d.decision.name).toBe('Shipping Rate Decision');
  });

  it('CLI-215 --name with diacritics folds the id', async () => {
    const dir = T();
    const d = await initNamed(dir, 'Zürich Süd', 'z_DMN.xlsx');
    expect(d.decision.id).toBe('ZURICH_SUD');
    expect(d.decision.name).toBe('Zürich Süd');
  });

  it('CLI-216 --name with letters NFD cannot decompose uses the fold map', async () => {
    const dir = T();
    const d = await initNamed(dir, 'Straße Łódź', 's_DMN.xlsx');
    expect(d.decision.id).toBe('STRASSE_LODZ');
    expect(d.decision.name).toBe('Straße Łódź');
  });

  it('CLI-217 --name starting with a digit', async () => {
    const dir = T();
    const d = await initNamed(dir, '2026 Rates', 'r_DMN.xlsx');
    expect(d.decision.id).toBe('_2026_RATES');
  });

  it('CLI-218 -o / --out writes to the given path', async () => {
    const dir = T();
    mkdirSync(join(dir, 'templates'));
    await expectOk(cli(dir, ['init', '-o', 'templates/x_DMN.xlsx']), dir);
    await expectOk(cli(dir, ['init', '--out', 'y_DMN.xlsx']), dir);
    expect(existsSync(join(dir, 'templates/x_DMN.xlsx'))).toBe(true);
    expect(existsSync(join(dir, 'y_DMN.xlsx'))).toBe(true);
    expect(existsSync(join(dir, 'decision_DMN.xlsx'))).toBe(false);
  });

  it('CLI-219 init -o into a missing directory', async () => {
    const dir = T();
    const r = cli(dir, ['init', '-o', 'new/dir/x_DMN.xlsx']);
    if (r.code === 0) {
      expect(existsSync(join(dir, 'new/dir/x_DMN.xlsx'))).toBe(true);
    } else {
      // Acceptable alternative: a one-line error naming the path, no stack trace.
      expectFail(r, 'x_DMN.xlsx');
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
    }
  });

  it('CLI-220 --sheet sets the sheet name', async () => {
    const dir = T();
    await expectOk(cli(dir, ['init', '--sheet', 'Pricing DMN', '-o', 'p.xlsx']), dir);
    const sheets = await onlySheet(join(dir, 'p.xlsx'));
    expect(sheets.map(([n]) => n)).toEqual(['Pricing DMN']);
    await expectOk(cli(dir, ['p.xlsx']), dir);
    expect(dmnFiles(dir)).toHaveLength(1);
  });

  // Decided: init writes the file but warns that the converter will not select the sheet.
  it('CLI-221 --sheet without DMN in the name warns', async () => {
    const dir = T();
    const r = cli(dir, ['init', '--sheet', 'Pricing', '-o', 'p.xlsx']);
    expect(r.code, dump(r)).toBe(0);
    expect(existsSync(join(dir, 'p.xlsx'))).toBe(true);
    expect(r.stderr, dump(r)).toMatch(/DMN/);
    expect(r.stderr, dump(r)).toMatch(/sheet/i);
    const c = cli(dir, ['p.xlsx']);
    expectFailNothingWritten(c, dir, 'no sheet', 'DMN');
  });

  it('CLI-221a --sheet violating Excel sheet-name rules is rejected', () => {
    const dir = T();
    for (const [name, needle] of [
      ['A'.repeat(32) + ' DMN', '31'],
      ['Pricing/DMN', 'Pricing/DMN'],
      ['Pricing [DMN]', 'Pricing [DMN]'],
    ]) {
      const r = cli(dir, ['init', '--sheet', name, '-o', 'p.xlsx']);
      expectFail(r, needle);
      expect(existsSync(join(dir, 'p.xlsx'))).toBe(false);
    }
  });

  it('CLI-222 --minimal drops the annotation column and example rules', async () => {
    const dir = T();
    await expectOk(cli(dir, ['init', '--minimal', '-o', 'm_DMN.xlsx']), dir);
    const [[, rows]] = await onlySheet(join(dir, 'm_DMN.xlsx'));
    const row1 = (rows[0] ?? []).map((v) => String(v ?? '').toLowerCase());
    expect(row1).not.toContain('annotations');
    const below = rows.slice(4).filter((r) => (r ?? []).some((v) => v != null && v !== ''));
    expect(below).toEqual([]);
  });

  it('CLI-223 a minimal template fails conversion until rules are added', async () => {
    const dir = T();
    await expectOk(cli(dir, ['init', '--minimal', '-o', 'm_DMN.xlsx']), dir);
    const path = join(dir, 'm_DMN.xlsx');
    const sheetName = (await onlySheet(path))[0][0];
    const r = cli(dir, ['m_DMN.xlsx']);
    expectFailNothingWritten(r, dir, 'no rules', sheetName);
    // Append one rule row under the input/output columns.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    const ws = wb.worksheets[0];
    ws.getRow(1).eachCell((cell, c) => {
      const marker = String(cell.value ?? '').toLowerCase();
      const type = String(ws.getCell(3, c).value ?? '').toLowerCase();
      if (marker === 'input') ws.getCell(5, c).value = type === 'string' ? '"A"' : '1';
      if (marker === 'output') ws.getCell(5, c).value = type === 'string' ? '"X"' : '1';
    });
    await wb.xlsx.writeFile(path);
    await expectOk(cli(dir, ['m_DMN.xlsx']), dir);
    expect(dmnFiles(dir)).toHaveLength(1);
  });

  it('CLI-224 init with the allowed-values layout writes a 5-row header', async () => {
    const dir = T();
    writeCfg(dir, ALLOWED_VALUES_LAYOUT);
    await expectOk(cli(dir, ['init', '--config', CFG, '-o', 'av_DMN.xlsx']), dir);
    await expectOk(cli(dir, ['av_DMN.xlsx', '--config', CFG]), dir);
    const [[, rows]] = await onlySheet(join(dir, 'av_DMN.xlsx'));
    const row1 = (rows[0] ?? []).map((v) => String(v ?? '').toLowerCase());
    const io = row1.map((m, c) => (m === 'input' || m === 'output' ? c : -1)).filter((c) => c >= 0);
    expect(io.some((c) => /^".*"(\s*,\s*".*")+$/.test(String(rows[3]?.[c] ?? '')))).toBe(true);
    for (const c of io) expect(String(rows[4]?.[c] ?? '').trim()).not.toBe('');
    const xml = readText(join(dir, dmnFiles(dir)[0]));
    expect(xml).toMatch(/<(inputValues|outputValues)\b/);
  });

  it('CLI-225 the 4-row template does not convert under the 5-row config (layout mismatch is detected)', async () => {
    const dir = T();
    await initDefault(dir);
    writeCfg(dir, ALLOWED_VALUES_LAYOUT);
    const r = cli(dir, ['decision_DMN.xlsx', '--config', CFG]);
    expectFailNothingWritten(r, dir, /!\$?[A-Z]+\$?\d+/);
  });

  it('CLI-226 init honours hitPolicy.default from config', async () => {
    const dir = T();
    writeCfg(dir, { hitPolicy: { default: 'FIRST' } });
    await expectOk(cli(dir, ['init', '--config', CFG, '-o', 'f_DMN.xlsx']), dir);
    const [[, rows]] = await onlySheet(join(dir, 'f_DMN.xlsx'));
    const pc = (rows[0] ?? []).findIndex((v) => String(v ?? '').toLowerCase() === 'policy');
    expect(rows[1][pc]).toBe('FIRST');
    await expectOk(cli(dir, ['f_DMN.xlsx']), dir);
    expect(hitPolicyOf(readText(join(dir, dmnFiles(dir)[0])))).toBe('FIRST');
  });

  it('CLI-227 init for Camunda 8 converts with --platform camunda8', async () => {
    const dir = T();
    writeCfg(dir, { platform: 'camunda8' });
    await expectOk(cli(dir, ['init', '--config', CFG, '-o', 'c8_DMN.xlsx']), dir);
    await expectOk(cli(dir, ['c8_DMN.xlsx', '--config', CFG, '--out-dir', 'c8']), dir);
    const xml = readText(join(dir, 'c8', dmnFiles(join(dir, 'c8'))[0]));
    expect(tag(xml, 'definitions')['modeler:executionPlatform']).toBe('Camunda Cloud');
    await expectOk(cli(dir, ['c8_DMN.xlsx', '--out-dir', 'c7']), dir);
    expect(dmnFiles(join(dir, 'c7'))).toHaveLength(1);
  });

  it('CLI-228 init with renamed markers round-trips with the same config', async () => {
    const dir = T();
    writeCfg(dir, {
      markers: {
        id: 'KEY',
        input: 'in',
        output: 'out',
        policy: 'hp',
        name: 'title',
        annotations: 'note',
      },
    });
    const name = ['--name', 'Round Trip'];
    await expectOk(cli(dir, ['init', ...name, '--config', CFG, '-o', 'k_DMN.xlsx']), dir);
    await expectOk(cli(dir, ['k_DMN.xlsx', '--config', CFG, '--out-dir', 'k']), dir);
    await expectOk(cli(dir, ['init', ...name, '-o', 'd_DMN.xlsx']), dir);
    await expectOk(cli(dir, ['d_DMN.xlsx', '--out-dir', 'd']), dir);
    const k = dmnFiles(join(dir, 'k'));
    expect(k).toEqual(dmnFiles(join(dir, 'd')));
    expect(k).toHaveLength(1);
    expect(readText(join(dir, 'k', k[0]))).toBe(readText(join(dir, 'd', k[0])));
  });

  // Decided: init refuses to overwrite an existing file unless --force is given.
  it('CLI-229 init over an existing file', async () => {
    const dir = T();
    writeFileSync(join(dir, 'decision_DMN.xlsx'), 'filled-in template');
    const r = cli(dir, ['init']);
    expectFail(r, 'decision_DMN.xlsx', '--force');
    expect(readText(join(dir, 'decision_DMN.xlsx'))).toBe('filled-in template');
    await expectOk(cli(dir, ['init', '--force']), dir);
    await expectOk(cli(dir, ['decision_DMN.xlsx']), dir);
    expect(dmnFiles(dir)).toHaveLength(1);
  });

  it('CLI-230 init output re-imports the example rules exactly', async () => {
    const dir = T();
    await initDefault(dir);
    await expectOk(cli(dir, ['decision_DMN.xlsx', '--json', '--out-dir', 'out']), dir);
    const json = walk(join(dir, 'out')).find((f) => f.endsWith('.model.json'));
    const d = readJson(join(dir, 'out', json)).decisions[0];
    const [[, rows]] = await onlySheet(join(dir, 'decision_DMN.xlsx'));
    const row1 = (rows[0] ?? []).map((v) => String(v ?? '').toLowerCase());
    const cols = (m) => row1.map((v, c) => (v === m ? c : -1)).filter((c) => c >= 0);
    const str = (v) => (v == null ? '' : String(v));
    const examples = rows
      .slice(4)
      .filter((r) => [...cols('input'), ...cols('output')].some((c) => str(r?.[c]) !== ''));
    expect(d.rules).toHaveLength(examples.length);
    examples.forEach((r, i) => {
      expect(d.rules[i].inputEntries).toEqual(cols('input').map((c) => str(r[c])));
      expect(d.rules[i].outputEntries).toEqual(cols('output').map((c) => str(r[c])));
      const notes = cols('annotations')
        .map((c) => str(r[c]))
        .filter(Boolean);
      if (notes.length) expect(d.rules[i].description).toBe(notes.join(' | '));
      else expect('description' in d.rules[i]).toBe(false);
    });
  });
});

describe('M. config', OPTS, () => {
  const fullDefaults = () => JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  it('CLI-240 config --defaults writes the full default config', async () => {
    const dir = T();
    const r = cli(dir, ['config', '--defaults']);
    await expectOk(r, dir);
    expect(r.stdout).toContain(CWD_CFG);
    const text = readText(join(dir, CWD_CFG));
    expect(JSON.parse(text)).toEqual(fullDefaults());
    expect(text.endsWith('\n')).toBe(true);
  });

  it('CLI-241 -y is the short form of --defaults', async () => {
    const dir = T();
    const r = cli(dir, ['config', '-y']);
    await expectOk(r, dir);
    expect(r.stdout).toContain(CWD_CFG);
    const text = readText(join(dir, CWD_CFG));
    expect(JSON.parse(text)).toEqual(fullDefaults());
    expect(text.endsWith('\n')).toBe(true);
  });

  it('CLI-242 the defaults equal the checked-in example config', async () => {
    const dir = T();
    await expectOk(cli(dir, ['config', '--defaults']), dir);
    expect(readJson(join(dir, CWD_CFG))).toEqual(EXAMPLE_CONFIG);
  });

  it('CLI-243 a defaults config changes nothing', async () => {
    const dir = T();
    await writeW1(dir);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--out-dir', 'a']), dir);
    await expectOk(cli(dir, ['config', '--defaults']), dir);
    await expectOk(cli(dir, ['one_DMN.xlsx', '--out-dir', 'b']), dir);
    expect(readText(join(dir, 'b/RATES.dmn'))).toBe(readText(join(dir, 'a/RATES.dmn')));
  });

  it('CLI-244 config -o chooses the output path', async () => {
    const dir = T();
    await expectOk(cli(dir, ['config', '--defaults', '-o', 'my.config.json']), dir);
    expect(existsSync(join(dir, 'my.config.json'))).toBe(true);
    expect(existsSync(join(dir, CWD_CFG))).toBe(false);
  });

  it('CLI-245 existing file is protected without --force (non-interactive)', () => {
    const dir = T();
    writeFileSync(join(dir, CWD_CFG), '{"keep":true}');
    const r = cli(dir, ['config', '--defaults'], { input: '' });
    expectFail(r, CWD_CFG, '--force');
    expect(readText(join(dir, CWD_CFG))).toBe('{"keep":true}');
  });

  it('CLI-246 --force overwrites', async () => {
    const dir = T();
    writeFileSync(join(dir, CWD_CFG), '{"keep":true}');
    const r = cli(dir, ['config', '--defaults', '--force']);
    await expectOk(r, dir);
    expect(readJson(join(dir, CWD_CFG))).toEqual(fullDefaults());
  });

  it('CLI-247 -o target protection works for custom paths too', async () => {
    const dir = T();
    writeFileSync(join(dir, 'my.json'), '{"keep":1}');
    const r = cli(dir, ['config', '--defaults', '-o', 'my.json'], { input: '' });
    expectFail(r, 'my.json');
    expect(readText(join(dir, 'my.json'))).toBe('{"keep":1}');
    await expectOk(cli(dir, ['config', '--defaults', '-o', 'my.json', '--force']), dir);
    expect(readJson(join(dir, 'my.json'))).toEqual(fullDefaults());
  });

  it('CLI-248 config --defaults --full still writes the full config', async () => {
    const dir = T();
    await expectOk(cli(dir, ['config', '--defaults', '--full']), dir);
    expect(readJson(join(dir, CWD_CFG))).toEqual(fullDefaults());
  });

  it('CLI-249 config -o into a missing directory', () => {
    const dir = T();
    const r = cli(dir, ['config', '--defaults', '-o', 'sub/c.json']);
    if (r.code === 0) {
      expect(readJson(join(dir, 'sub/c.json'))).toEqual(fullDefaults());
    } else {
      // Acceptable alternative: a one-line error naming the path.
      expectFail(r, 'c.json');
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
    }
  });

  it('CLI-250 interactive wizard via stdin: all defaults gives a minimal empty config', () => {
    const dir = T();
    const r = cli(dir, ['config'], { input: '\n'.repeat(30) });
    expect(r.code, dump(r)).toBe(0);
    const cfg = readJson(join(dir, CWD_CFG));
    if (JSON.stringify(cfg) === JSON.stringify(fullDefaults())) {
      // Non-TTY stdin treated as --defaults: allowed only when said on stderr.
      expect(r.stderr, dump(r)).toMatch(/tty|interactive|defaults/i);
    } else {
      expect(cfg).toEqual({});
      expect(r.stdout).toMatch(/config/i);
      expect(r.stdout).toMatch(/\[[^\]\n]+\]/);
    }
  });

  // Decided: piped (non-TTY) stdin keeps writing the defaults plus a stderr note (CLI-250);
  // CLI-251..259 drive the wizard itself through its prompt hook (runWizard).
  it('CLI-251 wizard: choose Camunda 8', async () => {
    const { cfg } = await runWizard(wizardInput({ essentials: { platform: 'camunda8' } }));
    expect(cfg).toEqual({ platform: 'camunda8' });
  });

  it('CLI-252 wizard: enabling allowed values writes the three-key layout', async () => {
    const { cfg } = await runWizard(wizardInput({ essentials: { allowedValues: 'y' } }));
    expect(cfg).toEqual({
      header: { allowedValuesOffset: 3, labelOffset: 4 },
      rules: { startOffset: 5 },
    });
  });

  it('CLI-253 wizard with --full', async () => {
    const input = wizardInput({ essentials: { platform: 'camunda8' } });
    const { cfg } = await runWizard(input, { full: true });
    expect(cfg).toEqual({ ...fullDefaults(), platform: 'camunda8' });
  });

  it('CLI-254 wizard re-asks on an invalid answer', async () => {
    const input = wizardInput({
      essentials: { 'sheet.caseInsensitive': 'n' },
      before: { 'sheet.caseInsensitive': ['maybe'] },
    });
    const { cfg, stdout } = await runWizard(input);
    expect(stdout.match(/please answer y or n/gi) ?? [], stdout).toHaveLength(1);
    expect(cfg).toEqual({ sheet: { caseInsensitive: false } });
  });

  it('CLI-255 wizard: Camunda 8 hides PRIORITY / OUTPUT ORDER from the hit-policy choices', async () => {
    const { stdout } = await runWizard(wizardInput({ essentials: { platform: 'camunda8' } }));
    const out = lines(stdout);
    const at = out.findIndex((l) => l.includes('Fallback hit policy'));
    expect(at, stdout).toBeGreaterThanOrEqual(0);
    const options = out
      .slice(0, at)
      .reverse()
      .find((l) => /options/i.test(l));
    expect(options, stdout).toBeDefined();
    expect(options).toContain('COLLECT');
    expect(options).not.toContain('PRIORITY');
    expect(options).not.toContain('OUTPUT ORDER');
  });

  it('CLI-256 wizard: advanced section is asked only on request', async () => {
    const a = await runWizard(wizardInput());
    expect(a.stdout).not.toContain('historyTimeToLive');
    expect(a.cfg).toEqual({});
    const b = await runWizard(
      wizardInput({ advanced: true, adv: { 'camunda.historyTimeToLive': 'P30D' } }),
    );
    expect(b.stdout).toContain('historyTimeToLive');
    expect(b.cfg).toEqual({ camunda: { historyTimeToLive: 'P30D' } });
  });

  it('CLI-257 wizard: null answer for a nullable key', async () => {
    const dir = T();
    const { cfg } = await runWizard(
      wizardInput({ advanced: true, adv: { 'camunda.historyTimeToLive': 'null' } }),
    );
    expect(cfg).toEqual({ camunda: { historyTimeToLive: null } });
    saveWizard(dir, cfg);
    await writeW1(dir);
    await expectOk(cli(dir, ['one_DMN.xlsx']), dir);
    expect(readText(join(dir, 'RATES.dmn'))).not.toContain('historyTimeToLive');
  });

  it('CLI-258 API: wizard driven by a scripted prompt', async () => {
    const sink = { write: () => true };
    const script = () => {
      const answers = [];
      for (const spec of PROMPTS.filter((p) => !p.advanced))
        answers.push(spec.path === 'markers.id' ? 'KEY' : '');
      answers.push('n');
      return async () => answers.shift() ?? '';
    };
    expect(await buildConfig({ prompt: script(), output: sink })).toEqual({
      markers: { id: 'KEY' },
    });
    const full = await buildConfig({ prompt: script(), output: sink, full: true });
    expect(full).toEqual(deepMerge(fullDefaults(), { markers: { id: 'KEY' } }));
  });

  it('CLI-259 wizard output is a loadable config', async () => {
    const dir = T();
    const { cfg } = await runWizard(wizardInput({ essentials: { platform: 'camunda8' } }));
    saveWizard(dir, cfg);
    await writeW1(dir);
    await expectOk(cli(dir, ['one_DMN.xlsx']), dir);
    expect(tag(readText(join(dir, 'RATES.dmn')), 'definitions')['modeler:executionPlatform']).toBe(
      'Camunda Cloud',
    );
  });

  it.skipIf(!HAS_PTY)('CLI-260 overwrite prompt accepts y on a TTY', () => {
    const dir = T();
    // Run the CLI under a pseudo-terminal (util-linux `script`), feeding the answer on stdin.
    const tty = (answer) =>
      spawnSync(
        'script',
        ['-qec', `'${process.execPath}' '${CLI}' config --defaults`, '/dev/null'],
        { cwd: dir, input: answer, encoding: 'utf8', timeout: 30_000 },
      );
    for (const answer of ['\n', 'n\n']) {
      writeFileSync(join(dir, CWD_CFG), '{"keep":true}');
      const r = tty(answer);
      expect(r.status, r.stdout).toBe(1);
      expect(readText(join(dir, CWD_CFG))).toBe('{"keep":true}');
    }
    const r = tty('y\n');
    expect(r.stdout).toMatch(/overwrite\? \[y\/N\]/);
    expect(r.status, r.stdout).toBe(0);
    expect(readJson(join(dir, CWD_CFG))).toEqual(fullDefaults());
  });

  it.skipIf(!HAS_PTY)('CLI-261 the wizard reads answers that arrive together on a TTY', () => {
    const dir = T();
    const r = spawnSync(
      'script',
      ['-qec', `'${process.execPath}' '${CLI}' config -o w.json`, '/dev/null'],
      {
        cwd: dir,
        input: wizardInput({ essentials: { platform: 'camunda8' } }),
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(r.status, r.stdout).toBe(0);
    expect(readJson(join(dir, 'w.json'))).toEqual({ platform: 'camunda8' });
  });
});

describe('N. import basics', OPTS, () => {
  /** Convert W1 into `T/<sub>/RATES.dmn` (sub '' = T itself). */
  async function ratesDmn(dir, sub = '', args = []) {
    await writeW1(dir, join('src', 'one_DMN.xlsx'));
    const out = sub ? join(dir, sub) : dir;
    await expectOk(cli(dir, ['src/one_DMN.xlsx', '--out-dir', out, ...args]), dir);
    return join(out, 'RATES.dmn');
  }

  it('CLI-270 import writes <input>.xlsx by default', async () => {
    const dir = T();
    await ratesDmn(dir);
    const r = cli(dir, ['import', 'RATES.dmn']);
    await expectOk(r, dir);
    expect(existsSync(join(dir, 'RATES.xlsx'))).toBe(true);
    expect(r.stdout).toContain('imported 1 decision(s)');
    expect(r.stdout).toContain('RATES.xlsx');
  });

  it('CLI-271 import -o chooses the path', async () => {
    const dir = T();
    await ratesDmn(dir);
    await expectOk(cli(dir, ['import', 'RATES.dmn', '-o', 'back_DMN.xlsx']), dir);
    expect(existsSync(join(dir, 'back_DMN.xlsx'))).toBe(true);
    expect(existsSync(join(dir, 'RATES.xlsx'))).toBe(false);
  });

  it('CLI-272 import -> convert round-trips byte-identically', async () => {
    const dir = T();
    const a = await ratesDmn(dir, 'a');
    await expectOk(cli(dir, ['import', 'a/RATES.dmn', '-o', 'back_DMN.xlsx']), dir);
    await expectOk(cli(dir, ['back_DMN.xlsx', '--out-dir', 'b']), dir);
    expect(readText(join(dir, 'b/RATES.dmn'))).toBe(readText(a));
  });

  it('CLI-273 imported workbook has a sheet the converter selects', async () => {
    const dir = T();
    await ratesDmn(dir);
    await expectOk(cli(dir, ['import', 'RATES.dmn', '-o', 'back_DMN.xlsx']), dir);
    const names = Object.keys(await readWorkbook(join(dir, 'back_DMN.xlsx')));
    expect(names.filter((n) => /DMN/i.test(n))).toHaveLength(1);
  });

  it('CLI-274 importing a Camunda 8 DMN prints the re-convert hint', async () => {
    const dir = T();
    await ratesDmn(dir, 'c8', ['--platform', 'camunda8']);
    const r = cli(dir, ['import', 'c8/RATES.dmn', '-o', 'back_DMN.xlsx']);
    await expectOk(r, dir);
    expect(r.stdout).toContain('Camunda 8');
    const m = r.stdout.match(/excel2dmn (\S*back_DMN\.xlsx) --platform camunda8/);
    expect(m, r.stdout).not.toBeNull();
    const again = cli(dir, [m[1], '--platform', 'camunda8', '--out-dir', 'again']);
    await expectOk(again, dir);
    const { xml, decision } = await loadDmn(join(dir, 'again/RATES.dmn'));
    expect(decision.id).toBe('RATES');
    expect(tag(xml, 'definitions')['modeler:executionPlatform']).toBe('Camunda Cloud');
  });

  it('CLI-275 C8 hint quotes paths with spaces', async () => {
    const dir = T();
    await ratesDmn(dir, 'c8', ['--platform', 'camunda8']);
    const r = cli(dir, ['import', 'c8/RATES.dmn', '-o', 'my back_DMN.xlsx']);
    await expectOk(r, dir);
    expect(r.stdout).toMatch(/excel2dmn '[^']*my back_DMN\.xlsx' --platform camunda8/);
  });

  it('CLI-276 Camunda 7 import prints no Camunda 8 hint', async () => {
    const dir = T();
    await ratesDmn(dir);
    const r = cli(dir, ['import', 'RATES.dmn']);
    await expectOk(r, dir);
    expect(r.stdout).not.toContain('--platform camunda8');
  });

  it('CLI-277 C8 import with a non-default version prints the version hint', async () => {
    const dir = T();
    writeCfg(dir, { platform: 'camunda8', camunda8: { executionPlatformVersion: '8.7.0' } });
    await ratesDmn(dir, 'c8', ['--config', CFG]);
    const r = cli(dir, ['import', 'c8/RATES.dmn', '-o', 'back_DMN.xlsx']);
    await expectOk(r, dir);
    expect(r.stdout).toContain('8.7.0');
    expect(r.stdout).toContain('executionPlatformVersion');
  });

  it('CLI-278 import of a missing file', () => {
    const dir = T();
    const r = cli(dir, ['import', 'nope.dmn']);
    expectFail(r, 'nope.dmn');
    expect(listFiles(dir)).toEqual([]);
  });

  it('CLI-279 import of malformed XML', () => {
    const dir = T();
    writeFileSync(join(dir, 'bad.dmn'), '<definitions');
    const r = cli(dir, ['import', 'bad.dmn']);
    expectFail(r, 'bad.dmn');
    expect(existsSync(join(dir, 'bad.xlsx'))).toBe(false);
  });

  it('CLI-280 import with renamed markers in config writes the renamed markers', async () => {
    const dir = T();
    const a = await ratesDmn(dir);
    writeCfg(dir, { markers: { id: 'KEY', input: 'in', output: 'out' } });
    await expectOk(cli(dir, ['import', 'RATES.dmn', '--config', CFG, '-o', 'k_DMN.xlsx']), dir);
    const row = await markerRow(join(dir, 'k_DMN.xlsx'));
    for (const m of ['KEY', 'in', 'out']) expect(row).toContain(m);
    await expectOk(cli(dir, ['k_DMN.xlsx', '--config', CFG, '--out-dir', 'b']), dir);
    expect(readText(join(dir, 'b/RATES.dmn'))).toBe(readText(a));
  });

  it('CLI-281 import of a DMN with allowed values produces a convertible template', async () => {
    const dir = T();
    const rows = decisionSheet(
      [
        { marker: 'id', name: 'RATES' },
        { marker: 'input', name: 'amount', type: 'integer', label: 'Amount' },
        {
          marker: 'output',
          name: 'result',
          type: 'string',
          label: 'Result',
          allowed: '"LOW","HIGH"',
        },
      ],
      W1_RULES,
      { allowedValues: true },
    );
    await writeW1(dir, 'src/av_src.xlsx', rows);
    writeCfg(dir, ALLOWED_VALUES_LAYOUT);
    await expectOk(cli(dir, ['src/av_src.xlsx', '--config', CFG, '--out-dir', 'a']), dir);
    await expectOk(cli(dir, ['import', 'a/RATES.dmn', '-o', 'av_DMN.xlsx']), dir);
    await expectOk(cli(dir, ['av_DMN.xlsx', '--config', CFG, '--out-dir', 'b']), dir);
    const first = readText(join(dir, 'a/RATES.dmn'));
    expect(first).toContain('<outputValues>');
    expect(readText(join(dir, 'b/RATES.dmn'))).toBe(first);
  });
});

describe('O. Programmatic API (config and convert)', OPTS, () => {
  it('CLI-290 API loadConfig precedence', () => {
    const dir = T();
    writeCfg(dir, { hitPolicy: { default: 'ANY' } }, CWD_CFG);
    const cfgPath = writeCfg(dir, { hitPolicy: { default: 'FIRST' } });
    expect(loadConfig({ cwd: dir }).hitPolicy.default).toBe('ANY');
    expect(loadConfig({ cwd: dir, configPath: cfgPath }).hitPolicy.default).toBe('FIRST');
    expect(
      loadConfig({
        cwd: dir,
        configPath: cfgPath,
        overrides: { hitPolicy: { default: 'COLLECT' } },
      }).hitPolicy.default,
    ).toBe('COLLECT');
    mkdirSync(join(dir, 'empty'));
    expect(loadConfig({ cwd: join(dir, 'empty') }).hitPolicy.default).toBe('UNIQUE');
  });

  it('CLI-291 API loadConfig rejects bad JSON with a message naming the file', () => {
    const dir = T();
    const bad = writeCfg(dir, '{,}', 'bad.json');
    expect(() => loadConfig({ configPath: bad })).toThrow(/bad\.json/);
  });

  it('CLI-292 API loadConfig does not mutate DEFAULT_CONFIG', () => {
    const dir = T();
    expect(loadConfig({ cwd: dir, overrides: { markers: { id: 'KEY' } } }).markers.id).toBe('KEY');
    expect(DEFAULT_CONFIG.markers.id).toBe('id');
    expect(loadConfig({ cwd: dir }).markers.id).toBe('id');
  });

  it('CLI-293 API convert returns results and problems per sheet', async () => {
    const dir = T();
    const path = await book(dir, 'book.xlsx', w2({ patch: { 'Returns_ DMN': { B5: '"x"' } } }));
    const config = loadConfig({ cwd: dir, overrides: { output: { outDir: join(dir, 'out') } } });
    const { results, problems } = await convert(path, { config });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ sheet: 'Shipping DMN', decisionId: 'SHIPPING' });
    expect(results[0].path).toMatch(/SHIPPING\.dmn$/);
    expect(problems).toHaveLength(1);
    expect(problems[0].sheet).toBe('Returns_ DMN');
    expect(problems[0].error.message).toContain('Returns_ DMN!B5');
    await reparseAll(dir);
  });

  it('CLI-294 API convert with validateOnly writes nothing', async () => {
    const dir = T();
    const path = await writeW1(dir);
    const { results } = await convert(path, {
      config: loadConfig({ cwd: dir }),
      validateOnly: true,
    });
    expect(results[0].decisionId).toBe('RATES');
    expect(results[0].xml).toBeUndefined();
    expect(results[0].path).toBeUndefined();
    expect(dmnFiles(dir)).toEqual([]);
  });

  it('CLI-295 API convert with no matching sheet rejects', async () => {
    const dir = T();
    const path = await book(dir, 'plain.xlsx', { Sheet1: w1() });
    await expect(convert(path, { config: loadConfig({ cwd: dir }) })).rejects.toThrow(/DMN/);
    expect(dmnFiles(dir)).toEqual([]);
  });
});
