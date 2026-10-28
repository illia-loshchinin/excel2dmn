// End-to-end: Camunda 8 Excel -> DMN conversion. One it() per scenario in
// test/e2e/scenarios/convert-camunda8.md; assertions follow the expected behavior there.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  tempDir,
  runCli,
  writeWorkbook,
  decisionSheet,
  ALLOWED_VALUES_LAYOUT,
  parseDmn,
  firstTable,
  readText,
  listFiles,
} from './helpers.js';
import {
  convert,
  buildDmn,
  loadConfig,
  parseWorkbook,
  dmnToModels,
  ConversionError,
} from '../../src/index.js';

const C8_ATTRS =
  ' modeler:executionPlatform="Camunda Cloud" modeler:executionPlatformVersion="8.6.0"';
const MODELER_NS = ' xmlns:modeler="http://camunda.org/schema/modeler/1.0"';
const CAMUNDA_NS = ' xmlns:camunda="http://camunda.org/schema/1.0/dmn"';

// --- workbook builders ------------------------------------------------------

/** W-BASE columns (A..H); `allowed` is only used by the 5-row (W-AV) layout. */
function baseColumns({ policy = 'UNIQUE', aggregator } = {}) {
  return [
    { marker: 'policy', name: policy, type: aggregator },
    { marker: 'ID', name: 'FEES' },
    { marker: 'name', name: 'Fee Decision' },
    { marker: 'input', name: 'amount', type: 'integer', label: 'Amount' },
    { marker: 'input', name: 'region', type: 'string', label: 'Region', allowed: '"EU","US"' },
    { marker: 'output', name: 'fee', type: 'double', label: 'Fee' },
    { marker: 'output', name: 'tier', type: 'string', label: 'Tier', allowed: '"LOW","HIGH"' },
    { marker: 'annotations' },
  ];
}

const BASE_RULES = [
  [null, null, null, '< 100', '"EU"', '1.5', '"LOW"', 'small EU'],
  [null, null, null, '>= 100', '-', '0', '"HIGH"', null],
];

/** Set cells by A1 reference on a row-major 2D array (in place). */
function patch(rows, cells) {
  for (const [ref, v] of Object.entries(cells)) {
    const [, letters, num] = ref.match(/^([A-Z]+)(\d+)$/);
    const c = [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const r = Number(num) - 1;
    while (rows.length <= r) rows.push([]);
    rows[r][c] = v;
  }
  return rows;
}

/** Remove whole columns (by letter, as in the original layout). */
function dropCols(rows, letters) {
  const idx = new Set(letters.map((l) => l.charCodeAt(0) - 65));
  return rows.map((row) => row.filter((_, i) => !idx.has(i)));
}

/**
 * W-BASE (or W-AV with `av: true`). `cells` patches by A1 ref before `drop`.
 * `columns` can tweak the column list (e.g. extra allowed values).
 */
function baseRows({ av = false, cells = {}, drop = [], policy, aggregator, columns } = {}) {
  const cols = columns ?? baseColumns({ policy, aggregator });
  const rows = decisionSheet(cols, structuredClone(BASE_RULES), { allowedValues: av });
  patch(rows, cells);
  return drop.length ? dropCols(rows, drop) : rows;
}

/** W-TYPES: inputs A..I, output J, ID K (policy column absent). */
const TYPE_INPUTS = [
  ['n', 'number', '>= 1.5'],
  ['t', 'time', '< time("10:00:00")'],
  ['dt', 'dateTime', '< date and time("2026-01-01T00:00:00")'],
  ['dtd', 'dayTimeDuration', '> duration("P1D")'],
  ['ymd', 'yearMonthDuration', '<= duration("P1Y2M")'],
  ['d', 'date', '< date("2026-01-01")'],
  ['s', 'string', '"A"'],
  ['b', 'boolean', 'true'],
  ['x', 'Any', '-'],
];

function typesRows({ cells = {}, extra = [] } = {}) {
  const cols = [
    ...TYPE_INPUTS.map(([name, type]) => ({ marker: 'input', name, type, label: name })),
    { marker: 'output', name: 'result', type: 'string', label: 'Result' },
    { marker: 'ID', name: 'TYPES' },
    ...extra.map((e) => e.column),
  ];
  const rule = [...TYPE_INPUTS.map(([, , v]) => v), '"OK"', null, ...extra.map((e) => e.value)];
  return patch(decisionSheet(cols, [rule]), cells);
}

/** Small sheet: ID column A, then the given columns; one rule row. */
function smallRows(id, columns, rule, opts) {
  return decisionSheet([{ marker: 'ID', name: id }, ...columns], [[null, ...rule]], opts);
}

// --- per-test plumbing --------------------------------------------------------

let tmp;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp?.cleanup());

const p = (...parts) => join(tmp.dir, ...parts);
const xlsxPath = (file = 'fees_DMN.xlsx') => p(file);

async function book(sheets, file = 'fees_DMN.xlsx') {
  await writeWorkbook(xlsxPath(file), sheets);
  return file;
}
const baseBook = (opts, file) => book({ 'Fees DMN': baseRows(opts) }, file);

function writeJson(name, obj) {
  const path = p(name);
  writeFileSync(path, JSON.stringify(obj), 'utf8');
  return name;
}

const cli = (args, opts = {}) => runCli(args, { cwd: tmp.dir, ...opts });

/** Convert `file` and return { r, xml }. xml is null when the expected file is missing. */
function run(args, { out = 'out', name = 'FEES.dmn', cwd } = {}) {
  const r = cli(args, cwd ? { cwd } : {});
  const path = p(out, name);
  return { r, xml: existsSync(path) ? readText(path) : null };
}

/** Convert W-style workbook for C8 into `out`, asserting success and clean re-parse. */
async function c8ok(file, extra = [], { out = 'out', name = 'FEES.dmn' } = {}) {
  const { r, xml } = run([file, '--platform', 'camunda8', '--out-dir', out, ...extra], {
    out,
    name,
  });
  expect(r.code, r.stderr).toBe(0);
  expect(xml, `${out}/${name} missing; stdout: ${r.stdout}`).not.toBeNull();
  const defs = await parseDmn(xml);
  return { r, xml, defs, ...firstTable(defs) };
}

function expectNoDmn(dir = 'out') {
  const d = p(dir);
  const files = existsSync(d) ? listFiles(d).filter((f) => f.endsWith('.dmn')) : [];
  expect(files).toEqual([]);
}

/** The opening <definitions ...> (or <dmn:definitions ...>) tag. */
const definitionsTag = (xml) => xml.match(/<(?:dmn:)?definitions\b[^>]*>/)[0];

/** Attributes of the first tag matching `re`, as a plain object (order-insensitive). */
function attrsOf(xml, re) {
  const tag = xml.match(re)?.[0] ?? '';
  return Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

const inputTypes = (table) => table.input.map((i) => i.inputExpression.typeRef);

// =============================================================================

// Each test spawns the real CLI (some several times), so allow more than vitest's 5s default
// when the whole suite runs in parallel.
describe('Camunda 8 Excel -> DMN (e2e)', { timeout: 120_000 }, () => {
  describe('A. selecting the Camunda 8 platform', () => {
    it('CAMUNDA8-001 --platform camunda8 emits the modeler execution-platform metadata', async () => {
      const f = await baseBook();
      const { r, xml } = await c8ok(f);
      expect(r.stdout).toContain('✓ Fees DMN →');
      expect(r.stdout).toContain(join('out', 'FEES.dmn'));
      expect(r.stderr).toBe('');
      expect(listFiles(p('out'))).toEqual(['FEES.dmn']);
      const tag = definitionsTag(xml);
      expect(tag).toMatch(
        /^<definitions xmlns="https:\/\/www\.omg\.org\/spec\/DMN\/20191111\/MODEL\/"/,
      );
      expect(tag).toContain('xmlns:modeler="http://camunda.org/schema/modeler/1.0"');
      expect(tag).toContain('modeler:executionPlatform="Camunda Cloud"');
      expect(tag).toContain('modeler:executionPlatformVersion="8.6.0"');
    });

    it('CAMUNDA8-002 platform: "camunda8" in a --config file selects Camunda 8', async () => {
      const f = await baseBook();
      const ref = await c8ok(f, [], { out: 'ref' });
      writeJson('c8.json', { platform: 'camunda8' });
      const { r, xml } = run([f, '--config', 'c8.json', '--out-dir', 'out']);
      expect(r.code, r.stderr).toBe(0);
      expect(xml).toBe(ref.xml);
    });

    it('CAMUNDA8-003 excel2dmn.config.json in cwd selects Camunda 8', async () => {
      const f = await baseBook();
      writeJson('excel2dmn.config.json', { platform: 'camunda8' });
      const { r, xml } = run([f, '--out-dir', 'out']);
      expect(r.code, r.stderr).toBe(0);
      expect(xml).toContain('modeler:executionPlatform="Camunda Cloud"');
      expect(xml).not.toContain('camunda:');
      await parseDmn(xml);
    });

    it('CAMUNDA8-004 CLI flag beats config: --platform camunda7 overrides config camunda8', async () => {
      const f = await baseBook();
      writeJson('c8.json', { platform: 'camunda8' });
      const { r, xml } = run([
        f,
        '--config',
        'c8.json',
        '--platform',
        'camunda7',
        '--out-dir',
        'out',
      ]);
      expect(r.code, r.stderr).toBe(0);
      expect(xml).toContain('xmlns:camunda=');
      expect(xml).toContain('camunda:historyTimeToLive="P180D"');
      expect(xml).not.toContain('modeler:');
      expect(xml).not.toContain('xmlns:modeler');
      await parseDmn(xml);
    });

    it('CAMUNDA8-005 CLI flag beats config: --platform camunda8 overrides config camunda7', async () => {
      const f = await baseBook();
      const ref = await c8ok(f, [], { out: 'ref' });
      writeJson('c7.json', { platform: 'camunda7' });
      const { r, xml } = run([
        f,
        '--config',
        'c7.json',
        '--platform',
        'camunda8',
        '--out-dir',
        'out',
      ]);
      expect(r.code, r.stderr).toBe(0);
      expect(xml).toBe(ref.xml);
    });

    it('CAMUNDA8-006 --config beats ./excel2dmn.config.json', async () => {
      const f = await baseBook();
      writeJson('excel2dmn.config.json', { platform: 'camunda7' });
      writeJson('c8.json', { platform: 'camunda8' });
      const { r, xml } = run([f, '--config', 'c8.json', '--out-dir', 'out']);
      expect(r.code, r.stderr).toBe(0);
      expect(xml).toContain('modeler:executionPlatform');
      expect(xml).not.toContain('camunda:');
    });

    it('CAMUNDA8-007 default platform is still Camunda 7', async () => {
      const f = await baseBook();
      const { r, xml } = run([f, '--out-dir', 'out']);
      expect(r.code, r.stderr).toBe(0);
      expect(xml).toMatch(/<decision [^>]*camunda:historyTimeToLive="P180D"/);
      expect(xml).toContain('xmlns:camunda="http://camunda.org/schema/1.0/dmn"');
      expect(xml).not.toContain('modeler');
      await parseDmn(xml);
    });

    it('CAMUNDA8-008 unknown --platform value is rejected', async () => {
      const f = await baseBook();
      const { r } = run([f, '--platform', 'camunda9', '--out-dir', 'out']);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('camunda9');
      expect(r.stderr).toContain('camunda7');
      expect(r.stderr).toContain('camunda8');
      expectNoDmn();
    });

    it('CAMUNDA8-009 unknown platform in a config file is rejected', async () => {
      const f = await baseBook();
      writeJson('bad.json', { platform: 'zeebe' });
      const { r } = run([f, '--config', 'bad.json', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('platform');
      expect(r.stderr).toContain('zeebe');
      expectNoDmn();
    });

    it('CAMUNDA8-010 platform is case-sensitive ("Camunda8" rejected)', async () => {
      const f = await baseBook();
      writeJson('cfg.json', { platform: 'Camunda8' });
      const { r } = run([f, '--config', 'cfg.json', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/invalid platform/i);
      expect(r.stderr).toContain('Camunda8');
      expectNoDmn();
    });
  });

  describe('B. <definitions> metadata and execution-platform version', () => {
    it('CAMUNDA8-011 configured camunda8.executionPlatformVersion is emitted verbatim', async () => {
      const f = await baseBook();
      writeJson('cfg.json', {
        platform: 'camunda8',
        camunda8: { executionPlatformVersion: '8.7.0' },
      });
      const { r, xml } = run([f, '--config', 'cfg.json', '--out-dir', 'out']);
      expect(r.code, r.stderr).toBe(0);
      const tag = definitionsTag(xml);
      expect(tag).toContain('modeler:executionPlatformVersion="8.7.0"');
      expect(xml).not.toContain('8.6.0');
      expect(tag).toContain('modeler:executionPlatform="Camunda Cloud"');
      await parseDmn(xml);
    });

    it('CAMUNDA8-012 version given via --platform + config file version only', async () => {
      const f = await baseBook();
      writeJson('cfg.json', { camunda8: { executionPlatformVersion: '8.5.1' } });
      const { r, xml } = run([
        f,
        '--config',
        'cfg.json',
        '--platform',
        'camunda8',
        '--out-dir',
        'out',
      ]);
      expect(r.code, r.stderr).toBe(0);
      expect(xml).toContain('modeler:executionPlatformVersion="8.5.1"');
      await parseDmn(xml);
    });

    it('CAMUNDA8-013 pre-release / non-numeric version strings pass through unchanged', async () => {
      const f = await baseBook();
      writeJson('cfg.json', {
        platform: 'camunda8',
        camunda8: { executionPlatformVersion: '8.8.0-alpha3' },
      });
      const { r, xml } = run([f, '--config', 'cfg.json', '--out-dir', 'out']);
      expect(r.code, r.stderr).toBe(0);
      expect(xml).toContain('modeler:executionPlatformVersion="8.8.0-alpha3"');
      await parseDmn(xml);
    });

    it('CAMUNDA8-014 camunda8.executionPlatform from config is honored', async () => {
      const f = await baseBook();
      writeJson('a.json', {
        platform: 'camunda8',
        camunda8: { executionPlatform: 'Camunda Cloud' },
      });
      writeJson('b.json', { platform: 'camunda8' });
      const a = run([f, '--config', 'a.json', '--out-dir', 'a'], { out: 'a' });
      const b = run([f, '--config', 'b.json', '--out-dir', 'b'], { out: 'b' });
      expect(a.r.code, a.r.stderr).toBe(0);
      expect(b.r.code, b.r.stderr).toBe(0);
      expect(a.xml).toBe(b.xml);
      expect(a.xml).toContain('modeler:executionPlatform="Camunda Cloud"');
    });

    it('CAMUNDA8-015 Camunda 8 metadata sits on <definitions> only', async () => {
      const f = await baseBook();
      const { xml } = await c8ok(f);
      const tag = definitionsTag(xml);
      const rest = xml.replace(tag, '');
      // Every "modeler" mention (prefix, attributes, namespace URI) lives in the root tag.
      expect(rest).not.toContain('modeler');
      expect(tag.match(/xmlns:modeler=/g)).toHaveLength(1);
      expect(tag.match(/ modeler:executionPlatform=/g)).toHaveLength(1);
      expect(tag.match(/ modeler:executionPlatformVersion=/g)).toHaveLength(1);
      expect(tag.match(/modeler:/g)).toHaveLength(2);
      expect(xml).toMatch(/<decision id="FEES" name="Fee Decision">/);
    });

    it('CAMUNDA8-016 standard <definitions> attributes are unchanged on C8', async () => {
      const f = await baseBook();
      const { xml } = await c8ok(f);
      const tag = definitionsTag(xml);
      expect(tag.startsWith('<definitions ')).toBe(true);
      expect(tag).toContain('xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/"');
      expect(tag).toContain('id="definitions_FEES"');
      expect(tag).toContain('name="Fee Decision"');
      expect(tag).toContain('namespace="http://camunda.org/schema/1.0/dmn"');
      expect(tag).toContain('expressionLanguage="https://www.omg.org/spec/DMN/20191111/FEEL/"');
      expect(tag).toContain('typeLanguage="https://www.omg.org/spec/DMN/20191111/FEEL/"');
      expect(tag).toContain('xmlns:dmndi=');
      expect(tag).toContain('xmlns:dc=');
      expect(xml).not.toContain('<dmn:');
    });

    it('CAMUNDA8-017 --namespace still applies on C8', async () => {
      const f = await baseBook();
      const { xml } = await c8ok(f, ['--namespace', 'https://example.com/dmn']);
      const tag = definitionsTag(xml);
      expect(tag).toContain('namespace="https://example.com/dmn"');
      expect(tag).toContain('modeler:executionPlatform="Camunda Cloud"');
      expect(tag).toContain('modeler:executionPlatformVersion="8.6.0"');
    });

    it('CAMUNDA8-018 output.namespaceStyle: "prefixed" keeps dmn: tags and modeler attrs', async () => {
      const f = await baseBook();
      writeJson('cfg.json', { platform: 'camunda8', output: { namespaceStyle: 'prefixed' } });
      const { r, xml } = run([f, '--config', 'cfg.json', '--out-dir', 'out']);
      expect(r.code, r.stderr).toBe(0);
      const tag = definitionsTag(xml);
      expect(tag.startsWith('<dmn:definitions ')).toBe(true);
      expect(tag).toContain('xmlns:dmn="https://www.omg.org/spec/DMN/20191111/MODEL/"');
      expect(tag).toContain('xmlns:modeler="http://camunda.org/schema/modeler/1.0"');
      expect(tag).toContain('modeler:executionPlatform="Camunda Cloud"');
      expect(tag).toContain('modeler:executionPlatformVersion="8.6.0"');
      await parseDmn(xml);
    });
  });

  describe('C. no Camunda 7 extensions on C8', () => {
    it('CAMUNDA8-019 no camunda:historyTimeToLive, no camunda:versionTag, no xmlns:camunda', async () => {
      const f = await baseBook();
      const { xml } = await c8ok(f);
      for (const s of ['historyTimeToLive', 'versionTag', 'xmlns:camunda', 'camunda:'])
        expect(xml).not.toContain(s);
    });

    it('CAMUNDA8-020 explicitly configured C7 extensions are still omitted on C8', async () => {
      const f = await baseBook();
      writeJson('cfg.json', {
        platform: 'camunda8',
        camunda: { historyTimeToLive: 'P30D', versionTag: '2.1' },
      });
      const { r, xml } = run([f, '--config', 'cfg.json', '--out-dir', 'out']);
      expect(r.code, r.stderr).toBe(0);
      for (const s of ['historyTimeToLive', 'versionTag', 'xmlns:camunda', 'P30D', '"2.1"'])
        expect(xml).not.toContain(s);
      await parseDmn(xml);
    });

    it('CAMUNDA8-021 xmlns:camunda and xmlns:modeler never co-occur', async () => {
      const f = await baseBook();
      const c7 = run([f, '--platform', 'camunda7', '--out-dir', 'c7'], { out: 'c7' });
      const c8 = run([f, '--platform', 'camunda8', '--out-dir', 'c8'], { out: 'c8' });
      expect(c7.r.code, c7.r.stderr).toBe(0);
      expect(c8.r.code, c8.r.stderr).toBe(0);
      expect(c7.xml).toContain('xmlns:camunda');
      expect(c7.xml).not.toContain('xmlns:modeler');
      expect(c8.xml).toContain('xmlns:modeler');
      expect(c8.xml).not.toContain('xmlns:camunda');
    });

    it('CAMUNDA8-022 C7 output is unaffected by the existence of C8 settings', async () => {
      const f = await baseBook();
      writeJson('a.json', {});
      writeJson('b.json', {
        camunda8: { executionPlatformVersion: '9.9.9' },
        types: { camunda8NumericAlias: null },
      });
      const a = run([f, '--config', 'a.json', '--out-dir', 'a'], { out: 'a' });
      const b = run([f, '--config', 'b.json', '--out-dir', 'b'], { out: 'b' });
      expect(a.r.code, a.r.stderr).toBe(0);
      expect(b.r.code, b.r.stderr).toBe(0);
      expect(b.xml).toBe(a.xml);
      expect(a.xml).toContain('camunda:historyTimeToLive');
    });
  });

  describe('D. types on Camunda 8', () => {
    it('CAMUNDA8-023 the full DMN/FEEL type set is accepted with no error or warning', async () => {
      const f = await book({ 'Types DMN': typesRows() }, 'types_DMN.xlsx');
      const { r, table } = await c8ok(f, [], { name: 'TYPES.dmn' });
      expect(r.stderr).toBe('');
      expect(r.stderr).not.toMatch(/not a Camunda type/);
      expect(inputTypes(table)).toEqual([
        'number',
        'time',
        'dateTime',
        'dayTimeDuration',
        'yearMonthDuration',
        'date',
        'string',
        'boolean',
        undefined,
      ]);
      expect(table.output[0].typeRef).toBe('string');
    });

    it('CAMUNDA8-024 the same W-TYPES workbook is rejected under Camunda 7', async () => {
      const f = await book({ 'Types DMN': typesRows() }, 'types_DMN.xlsx');
      const { r } = run([f, '--out-dir', 'out'], { name: 'TYPES.dmn' });
      expect(r.code).toBe(1);
      const reported = ['A', 'B', 'C', 'D', 'E'];
      reported.forEach((col, i) => {
        const type = TYPE_INPUTS[i][1];
        expect(r.stderr).toMatch(
          new RegExp(`Types DMN!${col}3[^\\n]*'${type}'[^\\n]*not a Camunda type`),
        );
      });
      for (const col of ['F', 'G', 'H', 'I']) expect(r.stderr).not.toContain(`Types DMN!${col}3`);
      expectNoDmn();
    });

    it('CAMUNDA8-025 C8 relaxation applies even when nonCamundaTypeAction is "error"', async () => {
      const f = await book({
        'N DMN': smallRows(
          'N',
          [
            { marker: 'input', name: 'n', type: 'number', label: 'N' },
            { marker: 'output', name: 'o', type: 'string', label: 'O' },
          ],
          ['> 1', '"A"'],
        ),
      });
      writeJson('cfg.json', { platform: 'camunda8', types: { nonCamundaTypeAction: 'error' } });
      const { r, xml } = run([f, '--config', 'cfg.json', '--out-dir', 'out'], { name: 'N.dmn' });
      expect(r.code, r.stderr).toBe(0);
      expect(xml).toContain('typeRef="number"');
      await parseDmn(xml);
    });

    it('CAMUNDA8-026 each FEEL type individually, input side', async () => {
      for (const [, type, entry] of TYPE_INPUTS) {
        const id = `IN_${type.toUpperCase()}`;
        const f = await book(
          {
            'In DMN': smallRows(
              id,
              [
                { marker: 'input', name: 'v', type, label: 'V' },
                { marker: 'output', name: 'o', type: 'string', label: 'O' },
              ],
              [entry, '"A"'],
            ),
          },
          `${type}_DMN.xlsx`,
        );
        const { table } = await c8ok(f, [], { out: type, name: `${id}.dmn` });
        const ie = table.input[0].inputExpression;
        expect(ie.id, type).toBe('v_expression');
        expect(ie.typeRef, type).toBe(type === 'Any' ? undefined : type);
        const cell = table.rule[0].inputEntry[0];
        expect(cell.id, type).toBe('v_1');
        // `-` is the "any" token and is emitted as an empty entry (§3.3).
        expect(cell.text, type).toBe(entry === '-' ? '' : entry);
      }
    });

    it('CAMUNDA8-027 each FEEL type individually, output side', async () => {
      const cases = [
        ['number', '42'],
        ['time', 'time("10:00:00")'],
        ['dateTime', 'date and time("2026-01-01T00:00:00")'],
        ['dayTimeDuration', 'duration("PT2H")'],
        ['yearMonthDuration', 'duration("P1Y")'],
        ['date', 'date("2026-01-01")'],
        ['string', '"X"'],
        ['boolean', 'false'],
        ['Any', '[1,2]'],
      ];
      for (const [type, value] of cases) {
        const id = `OUT_${type.toUpperCase()}`;
        const f = await book(
          {
            'Out DMN': smallRows(
              id,
              [
                { marker: 'input', name: 'i', type: 'string', label: 'I' },
                { marker: 'output', name: 'o', type },
              ],
              ['"A"', value],
            ),
          },
          `${type}_DMN.xlsx`,
        );
        const { xml, table } = await c8ok(f, [], { out: type, name: `${id}.dmn` });
        if (type === 'Any') expect(xml, type).toMatch(/<output id="o" name="o"\s*\/?>/);
        else expect(xml, type).toContain(`<output id="o" name="o" typeRef="${type}"`);
        const cell = table.rule[0].outputEntry[0];
        expect(cell.id, type).toBe('o_1');
        expect(cell.text, type).toBe(value);
      }
    });

    it('CAMUNDA8-028 untyped aliases any / none / object / Object on C8', async () => {
      const aliases = ['any', 'none', 'object', 'Object'];
      const f = await book({
        'Alias DMN': smallRows(
          'ALIAS',
          [
            ...aliases.map((type, i) => ({ marker: 'input', name: `a${i}`, type })),
            { marker: 'output', name: 'o', type: 'string' },
          ],
          ['-', '-', '-', '-', '"A"'],
        ),
      });
      const { xml, table } = await c8ok(f, [], { name: 'ALIAS.dmn' });
      expect(inputTypes(table)).toEqual([undefined, undefined, undefined, undefined]);
      for (let i = 0; i < 4; i++)
        expect(xml).toMatch(new RegExp(`<inputExpression id="a${i}_expression"\\s*>`));
    });

    it('CAMUNDA8-029 types.anyDmnPlaceholder on C8', async () => {
      const f = await book({
        'Any DMN': smallRows(
          'ANYP',
          [
            { marker: 'input', name: 'x', type: 'Any' },
            { marker: 'output', name: 'o', type: 'string' },
          ],
          ['-', '"A"'],
        ),
      });
      writeJson('cfg.json', { platform: 'camunda8', types: { anyDmnPlaceholder: 'Any' } });
      const { r, xml } = run([f, '--config', 'cfg.json', '--out-dir', 'out'], { name: 'ANYP.dmn' });
      expect(r.code, r.stderr).toBe(0);
      const { table } = firstTable(await parseDmn(xml));
      expect(table.input[0].inputExpression.typeRef).toBe('Any');
    });

    it('CAMUNDA8-030 unknown typeRef is still rejected on C8', async () => {
      const f = await baseBook({ cells: { F3: 'float' } });
      const { r } = run([f, '--platform', 'camunda8', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/unknown typeRef 'float'/i);
      expect(r.stderr).toContain('Fees DMN!F3');
      expectNoDmn();
    });

    it('CAMUNDA8-031 type names are case-sensitive except the Any aliases', async () => {
      const f = await baseBook({ cells: { D3: 'Number' } });
      const { r } = run([f, '--platform', 'camunda8', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/unknown typeRef 'Number'/i);
      expect(r.stderr).toContain('Fees DMN!D3');
      expectNoDmn();
    });

    it('CAMUNDA8-032 missing typeRef still fails on C8 with a cell coordinate', async () => {
      const f = await baseBook({ cells: { E3: null } });
      const { r } = run([f, '--platform', 'camunda8', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Fees DMN!E3');
      expect(r.stderr).toContain('typeRef');
      expect(r.stderr).toContain('region');
      expectNoDmn();
    });
  });

  describe('E. C7 numeric types normalized to number', () => {
    it('CAMUNDA8-033 integer input becomes number', async () => {
      const f = await baseBook();
      const { xml } = await c8ok(f);
      expect(xml).toContain('<inputExpression id="amount_expression" typeRef="number">');
      expect(xml).not.toContain('typeRef="integer"');
    });

    it('CAMUNDA8-034 double output becomes number', async () => {
      const f = await baseBook();
      const { xml } = await c8ok(f);
      // Attribute order inside the tag is serializer-defined; compare as a set.
      expect(attrsOf(xml, /<output id="fee"[^>]*>/)).toEqual({
        id: 'fee',
        name: 'fee',
        label: 'Fee',
        typeRef: 'number',
      });
      expect(xml).not.toContain('typeRef="double"');
    });

    it('CAMUNDA8-035 long (input and output) becomes number', async () => {
      const f = await book({
        'Long DMN': smallRows(
          'LONGS',
          [
            { marker: 'input', name: 'count', type: 'long' },
            { marker: 'output', name: 'total', type: 'long' },
          ],
          ['> 1', '5'],
        ),
      });
      const { xml, table } = await c8ok(f, [], { name: 'LONGS.dmn' });
      expect(table.input[0].inputExpression.typeRef).toBe('number');
      expect(table.output[0].typeRef).toBe('number');
      expect(xml).not.toContain('typeRef="long"');
    });

    it('CAMUNDA8-036 native number stays number', async () => {
      const f = await book({
        'Num DMN': smallRows(
          'NUMS',
          [
            { marker: 'input', name: 'n', type: 'number' },
            { marker: 'output', name: 'o', type: 'string' },
          ],
          ['> 1', '"A"'],
        ),
      });
      const { table } = await c8ok(f, [], { name: 'NUMS.dmn' });
      expect(table.input[0].inputExpression.typeRef).toBe('number');
    });

    it('CAMUNDA8-037 non-numeric types are never aliased', async () => {
      const f = await book(
        {
          'Types DMN': typesRows({
            extra: [{ column: { marker: 'input', name: 'i', type: 'integer' }, value: '> 1' }],
          }),
        },
        'types_DMN.xlsx',
      );
      const { table } = await c8ok(f, [], { name: 'TYPES.dmn' });
      expect(inputTypes(table)).toEqual([
        'number',
        'time',
        'dateTime',
        'dayTimeDuration',
        'yearMonthDuration',
        'date',
        'string',
        'boolean',
        undefined,
        'number',
      ]);
    });

    it('CAMUNDA8-038 camunda8NumericAlias: null opts out', async () => {
      const f = await baseBook();
      writeJson('cfg.json', { platform: 'camunda8', types: { camunda8NumericAlias: null } });
      const { r, xml } = run([f, '--config', 'cfg.json', '--out-dir', 'out']);
      expect(r.code, r.stderr).toBe(0);
      const { table } = firstTable(await parseDmn(xml));
      expect(table.input[0].inputExpression.typeRef).toBe('integer');
      expect(table.output[0].typeRef).toBe('double');
      expect(xml).toContain('modeler:executionPlatform="Camunda Cloud"');
    });

    it('CAMUNDA8-039 custom alias value', async () => {
      const f = await baseBook();
      writeJson('cfg.json', { platform: 'camunda8', types: { camunda8NumericAlias: 'double' } });
      const { r, xml } = run([f, '--config', 'cfg.json', '--out-dir', 'out']);
      expect(r.code, r.stderr).toBe(0);
      const { table } = firstTable(await parseDmn(xml));
      expect(table.input[0].inputExpression.typeRef).toBe('double');
      expect(table.output[0].typeRef).toBe('double');
    });

    it('CAMUNDA8-040 numeric validation still uses the authored type on C8', async () => {
      const f = await baseBook({ cells: { D5: '"100"' } });
      const { r } = run([f, '--platform', 'camunda8', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Fees DMN!D5');
      expect(r.stderr).toContain('amount');
      expectNoDmn();
    });

    it('CAMUNDA8-041 decimals accepted in an integer column (validated as numeric)', async () => {
      const f = await baseBook({ cells: { D5: '< 99.5' } });
      const { xml, table } = await c8ok(f);
      expect(xml).toMatch(/<inputEntry id="amount_1">\s*<text>&lt; 99\.5<\/text>/);
      expect(table.input[0].inputExpression.typeRef).toBe('number');
    });

    it('CAMUNDA8-042 --json model keeps the authored typeRef', async () => {
      const f = await baseBook();
      const { xml } = await c8ok(f, ['--json']);
      expect(listFiles(p('out'))).toEqual(['FEES.dmn', 'FEES.model.json']);
      const raw = readText(p('out', 'FEES.model.json'));
      const model = JSON.parse(raw);
      expect(model.decisions[0].inputs[0].typeRef).toBe('integer');
      expect(model.decisions[0].outputs[0].typeRef).toBe('double');
      for (const k of ['__platform', '__sheet', '__warnings']) expect(raw).not.toContain(k);
      expect(xml).toContain('typeRef="number"');
    });

    it('CAMUNDA8-043 --json model is identical for C7 and C8', async () => {
      const f = await baseBook();
      const c7 = cli([f, '--json', '--out-dir', 'c7']);
      const c8 = cli([f, '--json', '--platform', 'camunda8', '--out-dir', 'c8']);
      expect(c7.code, c7.stderr).toBe(0);
      expect(c8.code, c8.stderr).toBe(0);
      expect(readText(p('c8', 'FEES.model.json'))).toBe(readText(p('c7', 'FEES.model.json')));
    });
  });

  describe('F. hit policies', () => {
    /** W-AV with PRIORITY-ready output allowed values on BOTH outputs (§5: every output). */
    const prioColumns = (policy) =>
      baseColumns({ policy }).map((c) => (c.name === 'fee' ? { ...c, allowed: '1.5,0' } : c));
    const prioBook = (policy, file) =>
      book({ 'Fees DMN': baseRows({ av: true, columns: prioColumns(policy) }) }, file);

    it('CAMUNDA8-044 UNIQUE (sheet) -> no hitPolicy attribute', async () => {
      const f = await baseBook();
      const { xml, table } = await c8ok(f);
      expect(xml).toContain(
        '<decisionTable id="FEES_decisionTable" preferredOrientation="Rule-as-Row">',
      );
      expect(xml).not.toContain('hitPolicy=');
      // dmn-moddle reports the DMN default for an omitted attribute.
      expect(table.hitPolicy).toBe('UNIQUE');
    });

    it('CAMUNDA8-045 FIRST, ANY, RULE ORDER from the sheet', async () => {
      for (const policy of ['FIRST', 'ANY', 'RULE ORDER']) {
        const f = await baseBook({ policy }, `${policy.replace(' ', '_')}_DMN.xlsx`);
        const out = policy.replace(' ', '_');
        const { xml } = await c8ok(f, [], { out });
        expect(xml, policy).toMatch(
          new RegExp(`<decisionTable id="FEES_decisionTable"[^>]* hitPolicy="${policy}"`),
        );
        expect(xml, policy).not.toContain('aggregation=');
      }
    });

    it('CAMUNDA8-046 COLLECT without aggregator', async () => {
      const f = await baseBook({ policy: 'COLLECT' });
      const { xml } = await c8ok(f);
      expect(xml).toContain('hitPolicy="COLLECT"');
      expect(xml).not.toContain('aggregation=');
    });

    it('CAMUNDA8-047 COLLECT with each aggregator SUM / MIN / MAX / COUNT', async () => {
      for (const agg of ['SUM', 'MIN', 'MAX', 'COUNT']) {
        const f = await baseBook(
          { policy: 'COLLECT', aggregator: agg, drop: ['G'] },
          `${agg}_DMN.xlsx`,
        );
        const { xml, table } = await c8ok(f, [], { out: agg });
        expect(xml, agg).toMatch(/<decisionTable [^>]*hitPolicy="COLLECT"/);
        expect(xml, agg).toMatch(new RegExp(`<decisionTable [^>]*aggregation="${agg}"`));
        expect(table.output.map((o) => o.name)).toEqual(['fee']);
      }
    });

    it('CAMUNDA8-048 lower-case policy value in the sheet is normalized', async () => {
      const f = await baseBook({ policy: 'rule order' });
      const { xml } = await c8ok(f);
      expect(xml).toContain('hitPolicy="RULE ORDER"');
    });

    it('CAMUNDA8-049 PRIORITY in the sheet is rejected on C8', async () => {
      const f = await prioBook('PRIORITY');
      writeJson('av.json', ALLOWED_VALUES_LAYOUT);
      const { r } = run([f, '--platform', 'camunda8', '--config', 'av.json', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('PRIORITY');
      expect(r.stderr).toContain('not supported by Camunda 8');
      expectNoDmn();
    });

    it('CAMUNDA8-050 OUTPUT ORDER in the sheet is rejected on C8', async () => {
      const f = await prioBook('OUTPUT ORDER');
      writeJson('av.json', ALLOWED_VALUES_LAYOUT);
      const { r } = run([f, '--platform', 'camunda8', '--config', 'av.json', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('OUTPUT ORDER');
      expect(r.stderr).toContain('not supported by Camunda 8');
      expectNoDmn();
    });

    it('CAMUNDA8-051 the same PRIORITY workbook converts on C7', async () => {
      const f = await prioBook('PRIORITY');
      writeJson('av.json', ALLOWED_VALUES_LAYOUT);
      const { r, xml } = run([
        f,
        '--platform',
        'camunda7',
        '--config',
        'av.json',
        '--out-dir',
        'out',
      ]);
      expect(r.code, r.stderr).toBe(0);
      expect(xml).toContain('hitPolicy="PRIORITY"');
      expect(xml).toMatch(/<outputValues>\s*<text>"LOW","HIGH"<\/text>/);
      await parseDmn(xml);
    });

    it('CAMUNDA8-052 lower-case priority / output order in the sheet are also rejected on C8', async () => {
      writeJson('av.json', ALLOWED_VALUES_LAYOUT);
      for (const policy of ['priority', 'output order']) {
        const f = await prioBook(policy, `${policy.replace(' ', '_')}_DMN.xlsx`);
        const out = policy.replace(' ', '_');
        const { r } = run([f, '--platform', 'camunda8', '--config', 'av.json', '--out-dir', out], {
          out,
        });
        expect(r.code, policy).toBe(1);
        expect(r.stderr, policy).toContain('not supported by Camunda 8');
        expectNoDmn(out);
      }
    });

    it('CAMUNDA8-053 PRIORITY without allowed values on C8 reports the C8 error', async () => {
      const f = await baseBook({ policy: 'PRIORITY' });
      const { r } = run([f, '--platform', 'camunda8', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('not supported by Camunda 8');
      expectNoDmn();
    });

    it('CAMUNDA8-054 --hit-policy fallback with a supported policy', async () => {
      const f = await baseBook({ drop: ['A'] });
      const { xml } = await c8ok(f, ['--hit-policy', 'FIRST']);
      expect(xml).toContain('hitPolicy="FIRST"');
    });

    it('CAMUNDA8-055 sheet policy beats --hit-policy', async () => {
      const f = await baseBook();
      const { xml } = await c8ok(f, ['--hit-policy', 'COLLECT']);
      expect(xml).not.toContain('hitPolicy=');
    });

    it('CAMUNDA8-056 --hit-policy PRIORITY with --platform camunda8 is rejected at startup', async () => {
      const f = await baseBook({ drop: ['A'] });
      const { r } = run([
        f,
        '--platform',
        'camunda8',
        '--hit-policy',
        'PRIORITY',
        '--out-dir',
        'out',
      ]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('hitPolicy.default');
      expect(r.stderr).toContain('PRIORITY');
      expect(r.stderr).toContain('not supported by Camunda 8');
      expect(r.stdout).not.toContain('✓');
      expectNoDmn();
    });

    it('CAMUNDA8-057 config hitPolicy.default: "OUTPUT ORDER" + platform: "camunda8" is rejected', async () => {
      const f = await baseBook();
      writeJson('cfg.json', { platform: 'camunda8', hitPolicy: { default: 'OUTPUT ORDER' } });
      const { r } = run([f, '--config', 'cfg.json', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('OUTPUT ORDER');
      expect(r.stderr).toContain('not supported by Camunda 8');
      expectNoDmn();
    });

    it('CAMUNDA8-058 the startup rejection happens even if every sheet has its own policy', async () => {
      const f = await baseBook();
      writeJson('cfg.json', { hitPolicy: { default: 'priority' } });
      const { r } = run([f, '--config', 'cfg.json', '--platform', 'camunda8', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('not supported by Camunda 8');
      expectNoDmn();
    });

    it('CAMUNDA8-059 the same hitPolicy.default: "PRIORITY" config is fine on C7', async () => {
      const f = await baseBook();
      writeJson('cfg.json', { hitPolicy: { default: 'PRIORITY' } });
      const { r, xml } = run([f, '--config', 'cfg.json', '--out-dir', 'out']);
      expect(r.code, r.stderr).toBe(0);
      expect(xml).not.toContain('hitPolicy=');
      await parseDmn(xml);
    });

    it('CAMUNDA8-060 unknown hit policy still reported on C8', async () => {
      const f = await baseBook({ policy: 'HIGHEST' });
      const { r } = run([f, '--platform', 'camunda8', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('HIGHEST');
      expect(r.stderr).toMatch(/hit policy/i);
      expectNoDmn();
    });
  });

  describe('G. programmatic API', () => {
    const c8cfg = (extra = {}) =>
      loadConfig({ cwd: tmp.dir, overrides: { platform: 'camunda8', ...extra } });

    it('CAMUNDA8-061 convert() with a C8 config writes C8 DMN', async () => {
      const f = await baseBook();
      const ref = await c8ok(f, [], { out: 'ref' });
      const cfg = c8cfg({ output: { outDir: p('api') } });
      const { results, problems } = await convert(xlsxPath(f), { config: cfg });
      expect(problems).toEqual([]);
      expect(results).toHaveLength(1);
      expect(results[0].decisionId).toBe('FEES');
      expect(results[0].path).toBe(p('api', 'FEES.dmn'));
      expect(readText(results[0].path)).toBe(results[0].xml);
      expect(results[0].xml).toBe(ref.xml);
    });

    it('CAMUNDA8-062 buildDmn rejects PRIORITY on C8 for a hand-built model', async () => {
      const f = await baseBook();
      const cfg = c8cfg();
      const [model] = await parseWorkbook(xlsxPath(f), cfg);
      model.decisions[0].hitPolicy = 'PRIORITY';
      const err = await buildDmn(model, cfg).catch((e) => e);
      expect(err).toBeInstanceOf(ConversionError);
      expect(err.message).toContain('PRIORITY');
      expect(err.message).toContain('not supported by Camunda 8');
    });

    it('CAMUNDA8-063 buildDmn rejects OUTPUT ORDER on C8', async () => {
      const f = await baseBook();
      const cfg = c8cfg();
      for (const policy of ['OUTPUT ORDER', 'output order']) {
        const [model] = await parseWorkbook(xlsxPath(f), cfg);
        model.decisions[0].hitPolicy = policy;
        const err = await buildDmn(model, cfg).catch((e) => e);
        expect(err, policy).toBeInstanceOf(ConversionError);
        expect(err.message, policy).toContain('not supported by Camunda 8');
      }
    });

    it('CAMUNDA8-064 the same PRIORITY model builds on C7', async () => {
      const f = await baseBook();
      const c7 = loadConfig({ cwd: tmp.dir });
      const [model] = await parseWorkbook(xlsxPath(f), c7);
      const d = model.decisions[0];
      d.hitPolicy = 'PRIORITY';
      d.outputs[0].allowedValues = '1.5,0';
      d.outputs[1].allowedValues = '"LOW","HIGH"';
      const xml = await buildDmn(model, c7);
      expect(xml).toContain('hitPolicy="PRIORITY"');
      expect(xml).toContain('camunda:historyTimeToLive');
      await parseDmn(xml);
    });

    it('CAMUNDA8-065 loadConfig throws for C8 + PRIORITY/OUTPUT ORDER default', () => {
      for (const P of ['PRIORITY', 'OUTPUT ORDER', 'priority']) {
        expect(
          () =>
            loadConfig({
              cwd: tmp.dir,
              overrides: { platform: 'camunda8', hitPolicy: { default: P } },
            }),
          P,
        ).toThrow(/not supported by Camunda 8/);
        const cfg = loadConfig({
          cwd: tmp.dir,
          overrides: { platform: 'camunda7', hitPolicy: { default: P } },
        });
        expect(cfg.hitPolicy.default, P).toBe(P);
      }
    });

    it('CAMUNDA8-066 loadConfig throws for an unknown platform', () => {
      expect(() => loadConfig({ cwd: tmp.dir, overrides: { platform: 'camunda6' } })).toThrow(
        /camunda6/,
      );
    });

    it('CAMUNDA8-067 buildDmn follows the config, not the model origin', async () => {
      const f = await baseBook();
      const ref = await c8ok(f, [], { out: 'ref' });
      const c7run = run([f, '--out-dir', 'c7'], { out: 'c7' });
      expect(c7run.r.code, c7run.r.stderr).toBe(0);
      const [model] = await dmnToModels(c7run.xml, loadConfig({ cwd: tmp.dir }));
      const xml = await buildDmn(model, c8cfg());
      expect(xml).toBe(ref.xml);
    });

    it('CAMUNDA8-068 parseWorkbook under C8 does not flag C8 types; under C7 it throws', async () => {
      const f = await book({ 'Types DMN': typesRows() }, 'types_DMN.xlsx');
      const [model] = await parseWorkbook(xlsxPath(f), c8cfg());
      expect(model.__warnings.filter((w) => /Camunda type/.test(w.message))).toEqual([]);
      await expect(parseWorkbook(xlsxPath(f), loadConfig({ cwd: tmp.dir }))).rejects.toThrow(
        /not a Camunda type/,
      );
    });
  });

  describe('H. allowed values, annotations, multiple inputs/outputs', () => {
    const avConfig = (extra = {}) =>
      writeJson('av.json', { platform: 'camunda8', ...ALLOWED_VALUES_LAYOUT, ...extra });

    it('CAMUNDA8-069 allowed values become <inputValues> / <outputValues> on C8', async () => {
      const f = await baseBook({ av: true });
      avConfig();
      const { r, xml } = run([f, '--config', 'av.json', '--out-dir', 'out']);
      expect(r.code, r.stderr).toBe(0);
      expect(xml).toMatch(/<inputValues>\s*<text>"EU","US"<\/text>\s*<\/inputValues>/);
      expect(xml).toMatch(/<outputValues>\s*<text>"LOW","HIGH"<\/text>\s*<\/outputValues>/);
      const { table } = firstTable(await parseDmn(xml));
      expect(table.input[0].inputValues).toBeUndefined();
      expect(table.input[1].inputValues.text).toBe('"EU","US"');
      expect(table.input[1].inputValues.id).toBeUndefined();
      expect(table.output[0].outputValues).toBeUndefined();
      expect(table.output[1].outputValues.text).toBe('"LOW","HIGH"');
      // Rules start at Excel row 6 in the 5-row layout.
      expect(table.rule.map((ru) => ru.id)).toEqual(['rule_1', 'rule_2']);
      expect(table.rule[0].inputEntry[0].text).toBe('< 100');
      expect(table.rule[0].description).toBe('small EU');
    });

    it('CAMUNDA8-070 numeric allowed values on a C7 numeric column under C8', async () => {
      const cols = baseColumns().map((c) =>
        c.name === 'amount' ? { ...c, allowed: '[0..1000]' } : c,
      );
      const f = await baseBook({ av: true, columns: cols });
      avConfig();
      const { r, xml } = run([f, '--config', 'av.json', '--out-dir', 'out']);
      expect(r.code, r.stderr).toBe(0);
      const { table } = firstTable(await parseDmn(xml));
      expect(table.input[0].inputExpression.typeRef).toBe('number');
      expect(table.input[0].inputValues.text).toBe('[0..1000]');
    });

    it('CAMUNDA8-071 allowed values for C8-only types (time, date)', async () => {
      const allowed = 'time("08:00:00"),time("17:00:00")';
      const f = await book({
        'Time DMN': smallRows(
          'TIMES',
          [
            { marker: 'input', name: 't', type: 'time', label: 'T', allowed },
            { marker: 'output', name: 'o', type: 'string', label: 'O' },
          ],
          ['< time("12:00:00")', '"A"'],
          { allowedValues: true },
        ),
      });
      avConfig();
      const { r, xml } = run([f, '--config', 'av.json', '--out-dir', 'out'], { name: 'TIMES.dmn' });
      expect(r.code, r.stderr).toBe(0);
      const { table } = firstTable(await parseDmn(xml));
      expect(table.input[0].inputValues.text).toBe(allowed);
    });

    it('CAMUNDA8-072 invalid allowed values list reported with coordinate on C8', async () => {
      const f = await baseBook({ av: true, cells: { E4: 'EU,US' } });
      avConfig();
      const { r } = run([f, '--config', 'av.json', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Fees DMN!E4');
      expect(r.stderr).toMatch(/allowed values/i);
      expectNoDmn();
    });

    it('CAMUNDA8-073 enforceAllowedValues on C8', async () => {
      const f = await baseBook({ av: true, cells: { E6: '"APAC"' } });
      avConfig({ validation: { enforceAllowedValues: true } });
      const { r } = run([f, '--config', 'av.json', '--out-dir', 'out']);
      expect(r.code, r.stdout).toBe(1);
      expect(r.stderr).toContain('Fees DMN!E6');
      expect(r.stderr).toContain('"APAC"');
      expectNoDmn();
      // Default (no enforcement): same workbook converts.
      avConfig();
      const ok = run([f, '--config', 'av.json', '--out-dir', 'ok'], { out: 'ok' });
      expect(ok.r.code, ok.r.stderr).toBe(0);
    });

    it('CAMUNDA8-074 annotations become <description> first inside <rule>', async () => {
      const f = await baseBook();
      const { xml, table } = await c8ok(f);
      expect(xml).toMatch(/<rule id="rule_1">\s*<description>small EU<\/description>/);
      expect(xml).not.toMatch(/<rule id="rule_2">\s*<description>/);
      expect(table.rule[0].description).toBe('small EU');
      expect(table.rule[1].description).toBeUndefined();
    });

    it('CAMUNDA8-075 multiple annotation columns joined with the separator', async () => {
      const cols = [...baseColumns(), { marker: 'annotations' }];
      const f = await baseBook({ columns: cols, cells: { I5: 'reviewed' } });
      const { table } = await c8ok(f);
      expect(table.rule[0].description).toBe('small EU | reviewed');
    });

    it('CAMUNDA8-076 annotation text is not FEEL-validated or quoted on C8', async () => {
      const note = 'if x < 5 then "a" & b';
      const f = await baseBook({ cells: { H5: note } });
      const { xml, table } = await c8ok(f);
      expect(xml).toContain('&lt; 5');
      expect(xml).toContain('&amp; b');
      expect(table.rule[0].description).toBe(note);
    });

    it('CAMUNDA8-077 multiple inputs and outputs keep left-to-right order and readable ids', async () => {
      const f = await baseBook();
      const { defs, table } = await c8ok(f);
      expect(table.id).toBe('FEES_decisionTable');
      expect(table.input.map((i) => [i.id, i.inputExpression.id, i.inputExpression.text])).toEqual([
        ['amount', 'amount_expression', 'amount'],
        ['region', 'region_expression', 'region'],
      ]);
      expect(table.output.map((o) => [o.id, o.name])).toEqual([
        ['fee', 'fee'],
        ['tier', 'tier'],
      ]);
      expect(table.rule.map((ru) => ru.id)).toEqual(['rule_1', 'rule_2']);
      expect(table.rule.map((ru) => ru.inputEntry.map((e) => e.id))).toEqual([
        ['amount_1', 'region_1'],
        ['amount_2', 'region_2'],
      ]);
      expect(table.rule.map((ru) => ru.outputEntry.map((e) => e.id))).toEqual([
        ['fee_1', 'tier_1'],
        ['fee_2', 'tier_2'],
      ]);
      const diagram = defs.dmnDI.diagrams[0];
      expect(diagram.id).toBe('DMNDiagram_FEES');
      expect(diagram.diagramElements[0].id).toBe('DMNShape_FEES');
      expect(diagram.diagramElements[0].dmnElementRef.id).toBe('FEES');
    });

    it('CAMUNDA8-078 helper columns ignored on C8', async () => {
      const f = await baseBook();
      const ref = await c8ok(f, [], { out: 'ref' });
      const rows = baseRows().map((row, i) => [
        i === 0 ? null : i === 1 ? 'No.' : i >= 4 ? i - 3 : null,
        i === 0 ? 'NOT PART OF DMN' : `helper ${i}`,
        ...row,
      ]);
      const g = await book({ 'Fees DMN': rows }, 'helpers_DMN.xlsx');
      const { xml } = await c8ok(g);
      expect(xml).toBe(ref.xml);
    });

    it('CAMUNDA8-079 - and empty input cells become <text></text>', async () => {
      const dash = await baseBook({}, 'dash_DMN.xlsx');
      const empty = await baseBook({ cells: { E6: null } }, 'empty_DMN.xlsx');
      const a = await c8ok(dash, [], { out: 'dash' });
      const b = await c8ok(empty, [], { out: 'empty' });
      expect(a.xml).toMatch(/<inputEntry id="region_2">\s*<text><\/text>\s*<\/inputEntry>/);
      expect(b.xml).toBe(a.xml);
    });

    it('CAMUNDA8-080 zero-input table on C8', async () => {
      const f = await book({
        'Zero DMN': smallRows(
          'ZERO',
          [{ marker: 'output', name: 'result', type: 'string', label: 'Result' }],
          ['"X"'],
        ),
      });
      const { table } = await c8ok(f, [], { name: 'ZERO.dmn' });
      expect(table.input ?? []).toHaveLength(0);
      expect(table.output).toHaveLength(1);
      expect(table.rule).toHaveLength(1);
    });

    it('CAMUNDA8-081 DMNDI shape on C8', async () => {
      const f = await baseBook();
      const { xml, defs } = await c8ok(f);
      expect(xml.match(/<dmndi:DMNDiagram /g)).toHaveLength(1);
      expect(xml.match(/<dmndi:DMNShape /g)).toHaveLength(1);
      expect(xml).toMatch(/<dmndi:DMNDiagram id="DMNDiagram_FEES"/);
      expect(xml).toMatch(/<dmndi:DMNShape id="DMNShape_FEES" dmnElementRef="FEES"/);
      expect(attrsOf(xml, /<dc:Bounds [^>]*>/)).toEqual({
        x: '160',
        y: '100',
        width: '180',
        height: '80',
      });
      const b = defs.dmnDI.diagrams[0].diagramElements[0].bounds;
      expect([b.x, b.y, b.width, b.height]).toEqual([160, 100, 180, 80]);
    });
  });

  describe('I. determinism and C7 vs C8 differences', () => {
    it('CAMUNDA8-082 byte-stable output on repeat runs', async () => {
      const f = await baseBook();
      const a = await c8ok(f, [], { out: 'a' });
      const b = await c8ok(f, [], { out: 'b' });
      expect(b.xml).toBe(a.xml);
    });

    it('CAMUNDA8-083 byte-stable regardless of how C8 is selected', async () => {
      const f = await baseBook();
      const viaFlag = await c8ok(f, [], { out: 'flag' });
      writeJson('c8.json', { platform: 'camunda8' });
      const viaConfig = run([f, '--config', 'c8.json', '--out-dir', 'cfg'], { out: 'cfg' });
      mkdirSync(p('cwdcfg'));
      writeJson(join('cwdcfg', 'excel2dmn.config.json'), { platform: 'camunda8' });
      const viaCwd = run([join('..', f), '--out-dir', join('..', 'cwd')], {
        out: 'cwd',
        cwd: p('cwdcfg'),
      });
      const { results } = await convert(xlsxPath(f), {
        config: loadConfig({
          cwd: tmp.dir,
          overrides: { platform: 'camunda8', output: { outDir: p('api') } },
        }),
      });
      expect(viaConfig.r.code, viaConfig.r.stderr).toBe(0);
      expect(viaCwd.r.code, viaCwd.r.stderr).toBe(0);
      expect(viaConfig.xml).toBe(viaFlag.xml);
      expect(viaCwd.xml).toBe(viaFlag.xml);
      expect(readText(results[0].path)).toBe(viaFlag.xml);
    });

    /** Strip the C8-only metadata so a C8 document can be compared with a normalized C7 one. */
    const stripC8 = (xml) => xml.replace(MODELER_NS, '').replace(C8_ATTRS, '');

    it('CAMUNDA8-084 C7 vs C8 differ only in the expected places', async () => {
      const f = await baseBook();
      const c7 = run([f, '--out-dir', 'c7'], { out: 'c7' });
      const c8 = await c8ok(f, [], { out: 'c8' });
      expect(c7.r.code, c7.r.stderr).toBe(0);
      const norm = c7.xml
        .replace(CAMUNDA_NS, '')
        .replace(' camunda:historyTimeToLive="P180D"', '')
        .replace(/typeRef="(?:integer|long|double)"/g, 'typeRef="number"');
      expect(c8.xml).toContain(MODELER_NS);
      expect(c8.xml).toContain(C8_ATTRS);
      expect(stripC8(c8.xml)).toBe(norm);
      // Equivalent tree check.
      const t7 = firstTable(await parseDmn(c7.xml)).table;
      const strip = (t) => ({
        hitPolicy: t.hitPolicy,
        inputs: t.input.map((i) => [i.id, i.label, i.inputExpression.text]),
        outputs: t.output.map((o) => [o.id, o.name, o.label]),
        rules: t.rule.map((ru) => [
          ru.id,
          ru.description,
          ru.inputEntry.map((e) => [e.id, e.text]),
          ru.outputEntry.map((e) => [e.id, e.text]),
        ]),
      });
      expect(strip(c8.table)).toEqual(strip(t7));
    });

    it('CAMUNDA8-085 with camunda8NumericAlias: null the only differences are the metadata', async () => {
      const f = await baseBook();
      writeJson('cfg.json', { types: { camunda8NumericAlias: null } });
      const c7 = run([f, '--config', 'cfg.json', '--out-dir', 'c7'], { out: 'c7' });
      const c8 = run([f, '--config', 'cfg.json', '--platform', 'camunda8', '--out-dir', 'c8'], {
        out: 'c8',
      });
      expect(c7.r.code, c7.r.stderr).toBe(0);
      expect(c8.r.code, c8.r.stderr).toBe(0);
      const norm = c7.xml.replace(CAMUNDA_NS, '').replace(' camunda:historyTimeToLive="P180D"', '');
      expect(stripC8(c8.xml)).toBe(norm);
      expect(c8.xml).toContain('typeRef="integer"');
    });

    it('CAMUNDA8-086 with versionTag configured, it shows up only in C7', async () => {
      const f = await baseBook();
      writeJson('cfg.json', { camunda: { versionTag: '1.0' } });
      const c7 = run([f, '--config', 'cfg.json', '--out-dir', 'c7'], { out: 'c7' });
      const c8 = run([f, '--config', 'cfg.json', '--platform', 'camunda8', '--out-dir', 'c8'], {
        out: 'c8',
      });
      expect(c7.r.code, c7.r.stderr).toBe(0);
      expect(c8.r.code, c8.r.stderr).toBe(0);
      expect(c7.xml).toContain('camunda:versionTag="1.0"');
      expect(c8.xml).not.toContain('versionTag');
      await parseDmn(c8.xml);
    });

    it('CAMUNDA8-087 --no-pretty on C8', async () => {
      const f = await baseBook();
      const pretty = await c8ok(f, [], { out: 'pretty' });
      const flat = await c8ok(f, ['--no-pretty'], { out: 'flat' });
      const body = flat.xml.replace(/^<\?xml[^>]*\?>\s*/, '');
      expect(body).not.toContain('\n');
      expect(flat.xml).toContain('modeler:executionPlatform="Camunda Cloud"');
      const squash = (x) => x.replace(/>\s+</g, '><').trim();
      expect(squash(flat.xml)).toBe(squash(pretty.xml));
    });
  });

  describe('J. FEEL validation on C8', () => {
    it('CAMUNDA8-088 unquoted string input reported with its cell', async () => {
      const f = await baseBook({ cells: { E5: 'EU' } });
      const { r } = run([f, '--platform', 'camunda8', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('✗ Fees DMN:');
      expect(r.stderr).toContain('Fees DMN!E5');
      expect(r.stderr).toContain('region');
      expect(r.stderr).toContain('"EU"');
      expectNoDmn();
    });

    it('CAMUNDA8-089 FEEL syntax error in a dateTime input', async () => {
      const f = await book(
        { 'Types DMN': typesRows({ cells: { C5: '< date and time(' } }) },
        'types_DMN.xlsx',
      );
      const { r } = run([f, '--platform', 'camunda8', '--out-dir', 'out'], { name: 'TYPES.dmn' });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/Types DMN!C5[^\n]*dt[^\n]*invalid FEEL/i);
      expectNoDmn();
    });

    it('CAMUNDA8-090 syntax-only types accept any well-formed FEEL (no literal-kind check)', async () => {
      const f = await book(
        { 'Types DMN': typesRows({ cells: { B5: '"10:00"' } }) },
        'types_DMN.xlsx',
      );
      const { table } = await c8ok(f, [], { name: 'TYPES.dmn' });
      expect(table.rule[0].inputEntry[1].text).toBe('"10:00"');
    });

    it('CAMUNDA8-091 unquoted string output reported; autoQuote fixes it', async () => {
      const f = await baseBook({ cells: { G5: 'LOW' } });
      const bad = run([f, '--platform', 'camunda8', '--out-dir', 'out']);
      expect(bad.r.code).toBe(1);
      expect(bad.r.stderr).toMatch(/Fees DMN!G5[^\n]*tier[^\n]*quoted string/);
      expectNoDmn();
      writeJson('cfg.json', { outputEntries: { autoQuote: true } });
      const { xml } = await c8ok(f, ['--config', 'cfg.json'], { out: 'fixed' });
      expect(xml).toMatch(/<outputEntry id="tier_1">\s*<text>"LOW"<\/text>/);
    });

    it('CAMUNDA8-092 boolean column rejects non-boolean on C8', async () => {
      const f = await book({
        'Mem DMN': decisionSheet(
          [
            { marker: 'policy', name: 'UNIQUE' },
            { marker: 'ID', name: 'MEM' },
            { marker: 'name', name: 'Membership' },
            { marker: 'input', name: 'isMember', type: 'boolean', label: 'Member?' },
            { marker: 'output', name: 'r', type: 'string', label: 'R' },
          ],
          [[null, null, null, '"true"', '"A"']],
        ),
      });
      const { r } = run([f, '--platform', 'camunda8', '--out-dir', 'out'], { name: 'MEM.dmn' });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/Mem DMN!D5[^\n]*true or false/);
      expectNoDmn();
    });

    it('CAMUNDA8-093 numeric output with a string value rejected (C7 numeric type, C8 target)', async () => {
      const f = await baseBook({ cells: { F5: '"1.5"' } });
      const { r } = run([f, '--platform', 'camunda8', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/Fees DMN!F5[^\n]*fee/);
      expectNoDmn();
    });

    it('CAMUNDA8-094 all errors collected and reported together', async () => {
      const f = await baseBook({ cells: { E5: 'EU', G6: 'HIGH', D6: '"x"' } });
      const { r } = run([f, '--platform', 'camunda8', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      for (const c of ['E5', 'G6', 'D6']) expect(r.stderr).toContain(`Fees DMN!${c}`);
      expectNoDmn();
    });

    it('CAMUNDA8-095 validation.feel.mode: "off" on C8', async () => {
      const f = await baseBook({ cells: { E5: 'EU' } });
      writeJson('cfg.json', { validation: { feel: { mode: 'off' } } });
      const { xml } = await c8ok(f, ['--config', 'cfg.json']);
      expect(xml).toMatch(/<inputEntry id="region_1">\s*<text>EU<\/text>/);
    });

    it('CAMUNDA8-096 --validate-only on C8', async () => {
      const f = await book({ 'Types DMN': typesRows() }, 'types_DMN.xlsx');
      const ok = cli([f, '--platform', 'camunda8', '--validate-only', '--out-dir', 'out']);
      expect(ok.code, ok.stderr).toBe(0);
      expect(ok.stdout).toContain('✓ Types DMN → TYPES (valid)');
      expectNoDmn();
      const c7 = cli([f, '--validate-only', '--out-dir', 'out']);
      expect(c7.code).toBe(1);
      expect(c7.stderr).toContain('not a Camunda type');
    });

    it('CAMUNDA8-097 --validate-only catches PRIORITY on C8', async () => {
      const cols = baseColumns({ policy: 'PRIORITY' }).map((c) =>
        c.name === 'fee' ? { ...c, allowed: '1.5,0' } : c,
      );
      const f = await baseBook({ av: true, columns: cols });
      writeJson('av.json', ALLOWED_VALUES_LAYOUT);
      const r = cli([
        f,
        '--platform',
        'camunda8',
        '--config',
        'av.json',
        '--validate-only',
        '--out-dir',
        'out',
      ]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('not supported by Camunda 8');
      expectNoDmn();
    });
  });

  describe('K. multi-sheet, output paths and partial failures', () => {
    const multiBook = () =>
      book({
        'Fees DMN': baseRows(),
        'Types DMN': typesRows(),
        Notes: [['just some notes'], ['input', 'output']],
      });

    it('CAMUNDA8-098 multi-sheet workbook -> one C8 file per sheet', async () => {
      const f = await multiBook();
      const r = cli([f, '--platform', 'camunda8', '--out-dir', 'out']);
      expect(r.code, r.stderr).toBe(0);
      expect(listFiles(p('out'))).toEqual(['FEES.dmn', 'TYPES.dmn']);
      for (const name of ['FEES.dmn', 'TYPES.dmn']) {
        const xml = readText(p('out', name));
        expect(xml).toContain('modeler:executionPlatform="Camunda Cloud"');
        await parseDmn(xml);
      }
      expect(r.stdout).not.toContain('Notes');
    });

    it('CAMUNDA8-099 one C8-invalid sheet does not block the valid one', async () => {
      const prio = baseRows({ policy: 'PRIORITY' });
      prio[1][1] = 'PRIO';
      const f = await book({ 'Fees DMN': baseRows(), 'Prio DMN': prio });
      const r = cli([f, '--platform', 'camunda8', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(existsSync(p('out', 'FEES.dmn')), r.stderr).toBe(true);
      const xml = readText(p('out', 'FEES.dmn'));
      expect(xml).toContain('modeler:executionPlatform="Camunda Cloud"');
      await parseDmn(xml);
      expect(existsSync(p('out', 'PRIO.dmn'))).toBe(false);
      expect(r.stdout).toContain('✓ Fees DMN');
      expect(r.stderr).toContain('✗ Prio DMN:');
      expect(r.stderr).toContain('not supported by Camunda 8');
    });

    it('CAMUNDA8-100 -o/--out single-file output on C8', async () => {
      const f = await baseBook();
      const r = cli([f, '--platform', 'camunda8', '-o', join('out', 'custom.dmn')]);
      expect(r.code, r.stderr).toBe(0);
      expect(existsSync(p('out', 'custom.dmn')), `files: ${listFiles(tmp.dir)}`).toBe(true);
      const xml = readText(p('out', 'custom.dmn'));
      expect(xml).toContain('modeler:executionPlatform="Camunda Cloud"');
      await parseDmn(xml);
    });

    it('CAMUNDA8-101 -o with multiple sheets errors on C8 too', async () => {
      const f = await multiBook();
      const r = cli([f, '--platform', 'camunda8', '-o', join('out', 'one.dmn')]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('--out');
      expect(r.stderr).toContain('--out-dir');
    });

    it('CAMUNDA8-102 --sheet restricts conversion on C8', async () => {
      const f = await multiBook();
      const r = cli([f, '--platform', 'camunda8', '--sheet', 'Types DMN', '--out-dir', 'out']);
      expect(r.code, r.stderr).toBe(0);
      expect(listFiles(p('out'))).toEqual(['TYPES.dmn']);
      await parseDmn(readText(p('out', 'TYPES.dmn')));
    });

    it('CAMUNDA8-103 default output location beside the workbook', async () => {
      mkdirSync(p('in'));
      await baseBook({}, join('in', 'fees_DMN.xlsx'));
      const r = cli([join('in', 'fees_DMN.xlsx'), '--platform', 'camunda8']);
      expect(r.code, r.stderr).toBe(0);
      expect(existsSync(p('in', 'FEES.dmn'))).toBe(true);
      const xml = readText(p('in', 'FEES.dmn'));
      expect(xml).toContain('modeler:executionPlatform="Camunda Cloud"');
      await parseDmn(xml);
    });

    it('CAMUNDA8-104 fileNameTemplate: "<sheetName>.dmn" on C8', async () => {
      const f = await baseBook();
      writeJson('cfg.json', {
        platform: 'camunda8',
        output: { fileNameTemplate: '<sheetName>.dmn' },
      });
      const { r, xml } = run([f, '--config', 'cfg.json', '--out-dir', 'out'], {
        name: 'Fees DMN.dmn',
      });
      expect(r.code, r.stderr).toBe(0);
      expect(listFiles(p('out'))).toEqual(['Fees DMN.dmn']);
      await parseDmn(xml);
    });
  });

  describe('L. identity and content preservation on C8', () => {
    it('CAMUNDA8-105 id sanitization and verbatim name on C8', async () => {
      const f = await baseBook({ cells: { B2: 'Zürich Süd', C2: 'Opłaty – Zürich' } });
      const { xml, decision } = await c8ok(f, [], { name: 'ZURICH_SUD.dmn' });
      expect(xml).toContain('<decision id="ZURICH_SUD" name="Opłaty – Zürich">');
      expect(definitionsTag(xml)).toContain('id="definitions_ZURICH_SUD"');
      expect(decision.name).toBe('Opłaty – Zürich');
    });

    it('CAMUNDA8-106 no name column: name falls back to the raw id value', async () => {
      const f = await baseBook({ drop: ['C'] });
      const { xml } = await c8ok(f);
      expect(xml).toContain('<decision id="FEES" name="FEES">');
      expect(definitionsTag(xml)).toContain('name="FEES"');
    });

    it('CAMUNDA8-107 native Excel number/boolean cells emit canonical FEEL on C8', async () => {
      const cols = [
        ...baseColumns(),
        { marker: 'input', name: 'vip', type: 'boolean', label: 'VIP' },
      ];
      const f = await baseBook({ columns: cols, cells: { F5: 1.5, I5: true, I6: false } });
      const { table } = await c8ok(f);
      expect(table.rule[0].outputEntry[0].text).toBe('1.5');
      expect(table.rule[0].inputEntry[2].text).toBe('true');
      expect(table.rule[1].inputEntry[2].text).toBe('false');
    });

    it('CAMUNDA8-108 header problems still reported with coordinates on C8', async () => {
      const noName = await baseBook({ cells: { D2: null } }, 'noname_DMN.xlsx');
      const a = cli([noName, '--platform', 'camunda8', '--out-dir', 'a']);
      expect(a.code).toBe(1);
      expect(a.stderr).toMatch(/Fees DMN!D2[^\n]*technical name/);
      expectNoDmn('a');
      const noOut = await baseBook({ drop: ['F', 'G'] }, 'noout_DMN.xlsx');
      const b = cli([noOut, '--platform', 'camunda8', '--out-dir', 'b']);
      expect(b.code).toBe(1);
      expect(b.stderr).toContain('no output column');
      expectNoDmn('b');
    });

    it('CAMUNDA8-109 C8 output imports back and is detected as Camunda 8 (cross-check)', async () => {
      const f = await baseBook();
      const first = await c8ok(f);
      const imp = cli(['import', join('out', 'FEES.dmn'), '-o', 'back.xlsx']);
      expect(imp.code, imp.stderr).toBe(0);
      expect(imp.stdout).toContain('detected Camunda 8');
      expect(imp.stdout).toContain('--platform camunda8');
      const again = await c8ok('back.xlsx', [], { out: 'again' });
      const t = again.table;
      expect(t.input[0].inputExpression.typeRef).toBe('number');
      expect(t.output[0].typeRef).toBe('number');
      expect(again.xml).toBe(first.xml);
    });

    it('CAMUNDA8-110 init template converts on C8 out of the box', async () => {
      const init = cli(['init', '-o', 't_DMN.xlsx']);
      expect(init.code, init.stderr).toBe(0);
      const r = cli(['t_DMN.xlsx', '--platform', 'camunda8', '--out-dir', 'out']);
      expect(r.code, r.stderr).toBe(0);
      const files = listFiles(p('out'));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/\.dmn$/);
      const xml = readText(p('out', files[0]));
      expect(xml).toContain('modeler:executionPlatform="Camunda Cloud"');
      await parseDmn(xml);
    });
  });
});
