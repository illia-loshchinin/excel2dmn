// E2E: Camunda 7 (default platform) Excel -> DMN conversion.
// One it() per scenario in test/e2e/scenarios/convert-camunda7.md. Every test
// builds its workbook in code, drives the real CLI (or the public API where the
// scenario is about the API), and re-parses each emitted .dmn with dmn-moddle.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { convert, parseWorkbook, buildDmn, loadConfig } from '../../src/index.js';
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

const MODEL_NS = 'https://www.omg.org/spec/DMN/20191111/MODEL/';
const FEEL_NS = 'https://www.omg.org/spec/DMN/20191111/FEEL/';
const CAMUNDA_NS = 'http://camunda.org/schema/1.0/dmn';
const CFG = 'cfg.json';

// --- workbook builders ---------------------------------------------------------

// Baseline W0: A id=BASE, B input amount:integer, C output result:string; rules on rows 5-6.
const W0_COLS = [
  { marker: 'id', name: 'BASE' },
  { marker: 'input', name: 'amount', type: 'integer', label: 'Amount' },
  { marker: 'output', name: 'result', type: 'string', label: 'Result' },
];
const W0_RULES = [
  [null, '< 10', '"LOW"'],
  [null, '>= 10', '"HIGH"'],
];

/** W0's rows, plus optional extra columns (D, E, …) with their values on rows 5 and 6. */
function w0(extraCols = [], extraValues = []) {
  return decisionSheet(
    [...W0_COLS, ...extraCols],
    W0_RULES.map((r, i) => [...r, ...(extraValues[i] ?? [])]),
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

/** Sheet with a `policy` column in A (hit policy on row 2, aggregator on row 3). */
function withPolicy(policy, aggregator = null, cols = W0_COLS, rules = W0_RULES) {
  return decisionSheet(
    [{ marker: 'policy', name: policy, type: aggregator }, ...cols],
    rules.map((r) => [null, ...r]),
  );
}

/** 5-row allowed-values layout sheet (allowed on row 4, label on row 5, rules from row 6). */
const avSheet = (cols, rules) => decisionSheet(cols, rules, { allowedValues: true });
const AV = (extra = {}) => ({ ...ALLOWED_VALUES_LAYOUT, ...extra });

// --- CLI drivers ---------------------------------------------------------------

async function writeBook(dir, sheets, file = 'base_DMN.xlsx') {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  await writeWorkbook(join(dir, file), sheets);
  return join(dir, file);
}

/** Run the CLI in `dir` on `file`, optionally with a cfg.json (object or raw text). */
function runConvert(dir, { file = 'base_DMN.xlsx', config, args = [], outDir = 'out' } = {}) {
  mkdirSync(dir, { recursive: true });
  if (config !== undefined)
    writeFileSync(join(dir, CFG), typeof config === 'string' ? config : JSON.stringify(config));
  const cli = [
    file,
    ...(outDir ? ['--out-dir', outDir] : []),
    ...(config !== undefined ? ['--config', CFG] : []),
    ...args,
  ];
  return { ...runCli(cli, { cwd: dir }), out: join(dir, outDir ?? '.') };
}

async function convertBook(dir, sheets, opts = {}) {
  await writeBook(dir, sheets, opts.file);
  return runConvert(dir, opts);
}

/** Convert a single `Base DMN` sheet. */
const convertSheet = (dir, rows, opts) => convertBook(dir, { 'Base DMN': rows }, opts);

async function loadDmn(path) {
  const xml = readText(path);
  const definitions = await parseDmn(xml);
  return { xml, definitions, ...firstTable(definitions) };
}

/** Assert success and load `<out>/<id>.dmn`. */
async function expectDmn(r, id = 'BASE') {
  expect(r.code, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
  return loadDmn(join(r.out, `${id}.dmn`));
}

const dmnFiles = (dir) => (existsSync(dir) ? listFiles(dir).filter((f) => f.endsWith('.dmn')) : []);

/** Assert a conversion error: exit 1, every needle in stderr, no .dmn written. */
function expectFailure(r, ...needles) {
  expect(r.code, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(1);
  for (const n of needles) {
    if (n instanceof RegExp) expect(r.stderr).toMatch(n);
    else expect(r.stderr).toContain(n);
  }
  expect(dmnFiles(r.out)).toEqual([]);
}

// --- XML helpers ---------------------------------------------------------------

/** Attribute maps of every start tag `<name …>` in the raw XML. */
function tags(xml, name) {
  const re = new RegExp(`<${name}(\\s[^>]*?)?\\s*/?>`, 'g');
  return [...xml.matchAll(re)].map((m) =>
    Object.fromEntries(
      [...(m[1] ?? '').matchAll(/([\w:.-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]),
    ),
  );
}
const tag = (xml, name, id) => tags(xml, name).find((t) => id == null || t.id === id);

const inputTexts = (table, i = 0) => table.rule.map((r) => r.inputEntry[i].text ?? '');
const outputTexts = (table, i = 0) => table.rule.map((r) => r.outputEntry[i].text ?? '');
const emptyEntry = (kind, id) => new RegExp(`<${kind} id="${id}">\\s*<text></text>\\s*</${kind}>`);

/** Structural summary of a parsed table, for comparing two outputs. */
function summarize({ decision, table }) {
  return {
    id: decision.id,
    name: decision.name,
    hitPolicy: table.hitPolicy,
    inputs: (table.input ?? []).map((i) => [
      i.id,
      i.label,
      i.inputExpression.typeRef,
      i.inputExpression.text,
    ]),
    outputs: (table.output ?? []).map((o) => [o.id, o.name, o.label, o.typeRef]),
    rules: (table.rule ?? []).map((r) => [
      r.id,
      r.description,
      ...(r.inputEntry ?? []).map((e) => [e.id, e.text]),
      ...(r.outputEntry ?? []).map((e) => [e.id, e.text]),
    ]),
  };
}

/** Plain W0 output bytes, converted in its own sub-directory. */
async function w0Bytes(dir) {
  const r = await convertSheet(join(dir, 'w0-ref'), w0());
  expect(r.code, r.stderr).toBe(0);
  return readText(join(r.out, 'BASE.dmn'));
}

/** One it() per scenario; each gets a fresh temp dir that is always removed. */
function scenario(id, title, fn, test = it) {
  test(`${id} ${title}`, async () => {
    const tmp = tempDir();
    try {
      await fn(tmp.dir);
    } finally {
      tmp.cleanup();
    }
  });
}

describe.concurrent('Camunda 7 Excel -> DMN conversion (e2e)', { timeout: 120_000 }, () => {
  describe('1. Baseline document shape', () => {
    scenario(
      'CAMUNDA7-001',
      'Baseline workbook converts to one DMN file named after the decision id',
      async (dir) => {
        const r = await convertSheet(dir, w0());
        expect(r.code, r.stderr).toBe(0);
        expect(listFiles(join(dir, 'out'))).toEqual(['BASE.dmn']);
        const lines = r.stdout.trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('Base DMN');
        expect(lines[0]).toContain(join(dir, 'out', 'BASE.dmn'));
        expect(r.stderr).toBe('');
        await loadDmn(join(dir, 'out', 'BASE.dmn'));
      },
    );

    scenario('CAMUNDA7-002', 'Generated DMN re-parses cleanly with dmn-moddle', async (dir) => {
      const { definitions } = await expectDmn(await convertSheet(dir, w0()));
      expect(definitions.$type).toBe('dmn:Definitions');
      const decisions = definitions.drgElement.filter((e) => e.$type === 'dmn:Decision');
      expect(decisions).toHaveLength(1);
      expect(decisions[0].decisionLogic.$type).toBe('dmn:DecisionTable');
    });

    scenario(
      'CAMUNDA7-003',
      'Root uses the default, unprefixed DMN 1.3 MODEL namespace',
      async (dir) => {
        const { xml } = await expectDmn(await convertSheet(dir, w0()));
        expect(xml.startsWith('<?xml')).toBe(true);
        expect(xml).toMatch(/^<\?xml[^>]*\?>\s*<definitions\s/);
        const root = tag(xml, 'definitions');
        expect(root.xmlns).toBe(MODEL_NS);
        expect(xml).not.toContain('<dmn:');
        expect(xml).not.toContain('</dmn:');
        expect(root['xmlns:dmndi']).toBe('https://www.omg.org/spec/DMN/20191111/DMNDI/');
        expect(root['xmlns:dc']).toBe('http://www.omg.org/spec/DMN/20180521/DC/');
      },
    );

    scenario(
      'CAMUNDA7-004',
      'Definitions carry id, name, namespace, expressionLanguage and typeLanguage',
      async (dir) => {
        const { xml, definitions } = await expectDmn(await convertSheet(dir, w0()));
        expect(tag(xml, 'definitions')).toMatchObject({
          id: 'definitions_BASE',
          name: 'BASE',
          namespace: CAMUNDA_NS,
          expressionLanguage: FEEL_NS,
          typeLanguage: FEEL_NS,
        });
        expect(definitions.id).toBe('definitions_BASE');
      },
    );

    scenario(
      'CAMUNDA7-005',
      'Decision table has the Rule-as-Row orientation and readable ids',
      async (dir) => {
        const { xml, decision, table } = await expectDmn(await convertSheet(dir, w0()));
        expect(tag(xml, 'decision')).toMatchObject({ id: 'BASE', name: 'BASE' });
        expect(tag(xml, 'decisionTable')).toMatchObject({
          id: 'BASE_decisionTable',
          preferredOrientation: 'Rule-as-Row',
        });
        expect(decision.id).toBe('BASE');
        expect(table.id).toBe('BASE_decisionTable');
      },
    );

    scenario('CAMUNDA7-006', 'Input clause maps name, type and label', async (dir) => {
      const { xml, table } = await expectDmn(await convertSheet(dir, w0()));
      expect(tags(xml, 'input')).toEqual([{ id: 'amount', label: 'Amount' }]);
      expect(tag(xml, 'inputExpression')).toEqual({ id: 'amount_expression', typeRef: 'integer' });
      expect(table.input[0].inputExpression.text).toBe('amount');
    });

    scenario('CAMUNDA7-007', 'Output clause maps name, type and label', async (dir) => {
      const { xml } = await expectDmn(await convertSheet(dir, w0()));
      expect(tags(xml, 'output')).toEqual([
        { id: 'result', name: 'result', label: 'Result', typeRef: 'string' },
      ]);
    });

    scenario('CAMUNDA7-008', 'Rule and entry ids follow the deterministic scheme', async (dir) => {
      const { xml, table } = await expectDmn(await convertSheet(dir, w0()));
      expect(table.rule.map((r) => r.id)).toEqual(['rule_1', 'rule_2']);
      const [r1, r2] = table.rule;
      expect([r1.inputEntry[0].id, r1.inputEntry[0].text]).toEqual(['amount_1', '< 10']);
      expect([r1.outputEntry[0].id, r1.outputEntry[0].text]).toEqual(['result_1', '"LOW"']);
      expect([r2.inputEntry[0].id, r2.inputEntry[0].text]).toEqual(['amount_2', '>= 10']);
      expect([r2.outputEntry[0].id, r2.outputEntry[0].text]).toEqual(['result_2', '"HIGH"']);
      expect(xml).toMatch(/<inputEntry id="amount_1">\s*<text>&lt; 10<\/text>/);
    });

    scenario(
      'CAMUNDA7-009',
      '`rules.idTemplate: "rule_<row>"` produces Excel-row rule ids',
      async (dir) => {
        const r = await convertSheet(dir, w0(), {
          config: { rules: { idTemplate: 'rule_<row>' } },
        });
        const { table } = await expectDmn(r);
        expect(table.rule.map((x) => x.id)).toEqual(['rule_5', 'rule_6']);
        expect(table.rule.map((x) => x.inputEntry[0].id)).toEqual(['amount_1', 'amount_2']);
        expect(table.rule.map((x) => x.outputEntry[0].id)).toEqual(['result_1', 'result_2']);
      },
    );

    scenario(
      'CAMUNDA7-010',
      'Hit policy UNIQUE (the default) is not written as an attribute',
      async (dir) => {
        const { xml, table } = await expectDmn(await convertSheet(dir, w0()));
        const dt = tag(xml, 'decisionTable');
        expect(dt).not.toHaveProperty('hitPolicy');
        expect(dt).not.toHaveProperty('aggregation');
        expect(table.hitPolicy).toBe('UNIQUE');
      },
    );

    scenario('CAMUNDA7-011', 'DRD / DMNDI layout is generated', async (dir) => {
      const { xml, definitions, decision } = await expectDmn(await convertSheet(dir, w0()));
      expect(tags(xml, 'dmndi:DMNDI')).toHaveLength(1);
      expect(tags(xml, 'dmndi:DMNDiagram')).toEqual([{ id: 'DMNDiagram_BASE' }]);
      const shapes = tags(xml, 'dmndi:DMNShape');
      expect(shapes).toHaveLength(1);
      expect(shapes[0]).toMatchObject({ id: 'DMNShape_BASE', dmnElementRef: 'BASE' });
      expect(tag(xml, 'dc:Bounds')).toEqual({ x: '160', y: '100', width: '180', height: '80' });
      const shape = definitions.dmnDI.diagrams[0].diagramElements[0];
      expect(shape.dmnElementRef).toBe(decision);
    });

    scenario('CAMUNDA7-012', 'Custom shape bounds from config', async (dir) => {
      const config = { output: { shape: { x: -230, y: 0, width: 200, height: 90 } } };
      const { xml } = await expectDmn(await convertSheet(dir, w0(), { config }));
      expect(tag(xml, 'dc:Bounds')).toEqual({ x: '-230', y: '0', width: '200', height: '90' });
    });

    scenario(
      'CAMUNDA7-013',
      'FEEL operators are XML-escaped and survive a re-parse',
      async (dir) => {
        const rows = setCells(w0(), { B5: '<= 5', B6: '> 5' });
        const { xml, table } = await expectDmn(await convertSheet(dir, rows));
        expect(xml).toContain('&lt;= 5');
        expect(xml).not.toMatch(/<text><=/);
        expect(inputTexts(table)).toEqual(['<= 5', '> 5']);
      },
    );
  });

  describe('2. Camunda 7 extension attributes and namespaces', () => {
    scenario('CAMUNDA7-014', 'historyTimeToLive defaults to P180D', async (dir) => {
      const { xml, decision } = await expectDmn(await convertSheet(dir, w0()));
      expect(tag(xml, 'decision')['camunda:historyTimeToLive']).toBe('P180D');
      expect(tag(xml, 'definitions')['xmlns:camunda']).toBe(CAMUNDA_NS);
      expect(decision.historyTimeToLive).toBe('P180D');
    });

    scenario('CAMUNDA7-015', 'versionTag is omitted by default', async (dir) => {
      const { xml } = await expectDmn(await convertSheet(dir, w0()));
      expect(xml).not.toContain('camunda:versionTag');
    });

    scenario('CAMUNDA7-016', 'versionTag is emitted when configured', async (dir) => {
      const r = await convertSheet(dir, w0(), { config: { camunda: { versionTag: '1.2' } } });
      const { xml, decision } = await expectDmn(r);
      expect(tag(xml, 'decision')).toMatchObject({
        'camunda:historyTimeToLive': 'P180D',
        'camunda:versionTag': '1.2',
      });
      expect(decision.versionTag).toBe('1.2');
    });

    scenario('CAMUNDA7-017', 'Custom ISO-8601 historyTimeToLive', async (dir) => {
      const r = await convertSheet(dir, w0(), {
        config: { camunda: { historyTimeToLive: 'P30D' } },
      });
      const { xml } = await expectDmn(r);
      expect(tag(xml, 'decision')['camunda:historyTimeToLive']).toBe('P30D');
    });

    scenario('CAMUNDA7-018', 'Integer day-count historyTimeToLive', async (dir) => {
      const r = await convertSheet(dir, w0(), { config: { camunda: { historyTimeToLive: 30 } } });
      const { xml } = await expectDmn(r);
      expect(tag(xml, 'decision')['camunda:historyTimeToLive']).toBe('30');
    });

    scenario('CAMUNDA7-019', 'historyTimeToLive null omits the attribute', async (dir) => {
      const r = await convertSheet(dir, w0(), { config: { camunda: { historyTimeToLive: null } } });
      const { xml } = await expectDmn(r);
      expect(xml).not.toContain('historyTimeToLive');
      expect(xml).not.toContain('camunda:');
      expect(xml).not.toContain('xmlns:camunda');
    });

    scenario(
      'CAMUNDA7-020',
      'Camunda 7 output never carries Camunda 8 modeler metadata',
      async (dir) => {
        const { xml } = await expectDmn(await convertSheet(dir, w0()));
        expect(xml).not.toContain('modeler:executionPlatform');
        expect(xml).not.toContain('modeler:executionPlatformVersion');
        expect(xml).not.toContain('xmlns:modeler');
      },
    );

    scenario(
      'CAMUNDA7-021',
      'Explicit `--platform camunda7` gives the same bytes as the default',
      async (dir) => {
        await writeBook(dir, { 'Base DMN': w0() });
        const r1 = runConvert(dir, { outDir: 'out1' });
        const r2 = runConvert(dir, { outDir: 'out2', args: ['--platform', 'camunda7'] });
        const a = await expectDmn(r1);
        const b = await expectDmn(r2);
        expect(b.xml).toBe(a.xml);
      },
    );

    scenario('CAMUNDA7-022', '`--namespace` sets the definitions namespace', async (dir) => {
      const r = await convertSheet(dir, w0(), { args: ['--namespace', 'https://example.com/dmn'] });
      const { xml } = await expectDmn(r);
      const root = tag(xml, 'definitions');
      expect(root.namespace).toBe('https://example.com/dmn');
      expect(root.xmlns).toBe(MODEL_NS);
      expect(root['xmlns:camunda']).toBe(CAMUNDA_NS);
    });

    scenario('CAMUNDA7-023', 'Namespace from the config file', async (dir) => {
      const r = await convertSheet(dir, w0(), {
        config: { output: { namespace: 'urn:acme:rules' } },
      });
      const { xml } = await expectDmn(r);
      expect(tag(xml, 'definitions').namespace).toBe('urn:acme:rules');
    });

    scenario('CAMUNDA7-024', '`--namespace` beats the config file', async (dir) => {
      const r = await convertSheet(dir, w0(), {
        config: { output: { namespace: 'urn:from-config' } },
        args: ['--namespace', 'urn:from-flag'],
      });
      const { xml } = await expectDmn(r);
      expect(tag(xml, 'definitions').namespace).toBe('urn:from-flag');
    });

    scenario(
      'CAMUNDA7-025',
      '`namespaceStyle: "prefixed"` keeps the `dmn:` prefix',
      async (dir) => {
        const r = await convertSheet(dir, w0(), {
          config: { output: { namespaceStyle: 'prefixed' } },
        });
        const { xml, decision, table } = await expectDmn(r);
        expect(xml).toMatch(/^<\?xml[^>]*\?>\s*<dmn:definitions\s/);
        const root = tag(xml, 'dmn:definitions');
        expect(root['xmlns:dmn']).toBe(MODEL_NS);
        expect(root).not.toHaveProperty('xmlns');
        expect(decision.id).toBe('BASE');
        expect(table.id).toBe('BASE_decisionTable');
        expect(table.input[0].id).toBe('amount');
        expect(table.output[0].id).toBe('result');
        expect(table.rule.map((x) => x.id)).toEqual(['rule_1', 'rule_2']);
        expect(table.rule.map((x) => x.inputEntry[0].id)).toEqual(['amount_1', 'amount_2']);
        expect(table.rule.map((x) => x.outputEntry[0].id)).toEqual(['result_1', 'result_2']);
      },
    );

    scenario('CAMUNDA7-026', 'Custom expressionLanguage / typeLanguage', async (dir) => {
      const config = {
        output: {
          expressionLanguage: 'https://www.omg.org/spec/DMN/20191111/FEEL/',
          typeLanguage: 'http://www.omg.org/spec/FEEL/20140401',
        },
      };
      const { xml } = await expectDmn(await convertSheet(dir, w0(), { config }));
      expect(tag(xml, 'definitions')).toMatchObject(config.output);
    });
  });

  describe('3. Determinism', () => {
    scenario('CAMUNDA7-027', 'Two runs on unchanged input give byte-identical XML', async (dir) => {
      await writeBook(dir, { 'Base DMN': w0() });
      const a = await expectDmn(runConvert(dir, { outDir: 'out1' }));
      const b = await expectDmn(runConvert(dir, { outDir: 'out2' }));
      expect(b.xml).toBe(a.xml);
      const ids = [...a.xml.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]).sort();
      expect(ids).toEqual(
        [
          'definitions_BASE',
          'BASE',
          'BASE_decisionTable',
          'amount',
          'amount_expression',
          'result',
          'rule_1',
          'rule_2',
          'amount_1',
          'amount_2',
          'result_1',
          'result_2',
          'DMNDiagram_BASE',
          'DMNShape_BASE',
        ].sort(),
      );
    });

    scenario(
      'CAMUNDA7-028',
      'Re-running into the same directory overwrites with the same bytes',
      async (dir) => {
        await writeBook(dir, { 'Base DMN': w0() });
        const first = await expectDmn(runConvert(dir));
        const second = await expectDmn(runConvert(dir));
        expect(listFiles(join(dir, 'out'))).toEqual(['BASE.dmn']);
        expect(second.xml).toBe(first.xml);
      },
    );

    scenario('CAMUNDA7-029', 'Workbook from a different path gives the same bytes', async (dir) => {
      const a = await expectDmn(
        await convertSheet(dir, w0(), { file: 'a/base_DMN.xlsx', outDir: 'outA' }),
      );
      const b = await expectDmn(
        await convertSheet(dir, w0(), { file: 'b/other_DMN.xlsx', outDir: 'outB' }),
      );
      expect(b.xml).toBe(a.xml);
      for (const leak of ['base_DMN', 'other_DMN', '.xlsx', dir]) expect(a.xml).not.toContain(leak);
    });
  });

  describe('4. Types (typeRef) on Camunda 7', () => {
    scenario('CAMUNDA7-030', '`string` column', async (dir) => {
      const rows = w0(
        [{ marker: 'input', name: 'region', type: 'string', label: 'Region' }],
        [['"EU"'], ['"US"']],
      );
      const { xml, table } = await expectDmn(await convertSheet(dir, rows));
      expect(tag(xml, 'inputExpression', 'region_expression').typeRef).toBe('string');
      expect(table.rule.map((r) => [r.inputEntry[1].id, r.inputEntry[1].text])).toEqual([
        ['region_1', '"EU"'],
        ['region_2', '"US"'],
      ]);
    });

    scenario('CAMUNDA7-031', '`boolean` column', async (dir) => {
      const rows = w0(
        [{ marker: 'input', name: 'isMember', type: 'boolean' }],
        [['true'], ['false']],
      );
      const { xml, table } = await expectDmn(await convertSheet(dir, rows));
      expect(tag(xml, 'inputExpression', 'isMember_expression').typeRef).toBe('boolean');
      expect(inputTexts(table, 1)).toEqual(['true', 'false']);
    });

    scenario('CAMUNDA7-032', '`integer` column passes through unchanged on C7', async (dir) => {
      const { xml } = await expectDmn(await convertSheet(dir, w0()));
      expect(tag(xml, 'inputExpression', 'amount_expression').typeRef).toBe('integer');
      expect(xml).not.toContain('typeRef="number"');
    });

    scenario('CAMUNDA7-033', '`long` column', async (dir) => {
      const { xml } = await expectDmn(await convertSheet(dir, setCells(w0(), { B3: 'long' })));
      expect(tag(xml, 'inputExpression', 'amount_expression').typeRef).toBe('long');
    });

    scenario('CAMUNDA7-034', '`double` column with decimal entries', async (dir) => {
      const rows = setCells(
        w0([{ marker: 'output', name: 'fee', type: 'double' }], [['1.5'], ['0']]),
        {
          B3: 'double',
          B5: '< 10.5',
          B6: '>= 10.5',
        },
      );
      const { xml, table } = await expectDmn(await convertSheet(dir, rows));
      expect(tag(xml, 'inputExpression', 'amount_expression').typeRef).toBe('double');
      expect(tag(xml, 'output', 'fee').typeRef).toBe('double');
      expect(inputTexts(table)).toEqual(['< 10.5', '>= 10.5']);
      expect(outputTexts(table, 1)).toEqual(['1.5', '0']);
    });

    scenario('CAMUNDA7-035', '`date` column with FEEL date literals', async (dir) => {
      const rows = w0(
        [
          { marker: 'input', name: 'since', type: 'date' },
          { marker: 'output', name: 'validFrom', type: 'date' },
        ],
        [['< date("2026-01-01")', 'date("2026-01-01")'], ['>= date("2026-01-01")']],
      );
      const { xml, table } = await expectDmn(await convertSheet(dir, rows));
      expect(tag(xml, 'inputExpression', 'since_expression').typeRef).toBe('date');
      expect(tag(xml, 'output', 'validFrom').typeRef).toBe('date');
      expect(inputTexts(table, 1)).toEqual(['< date("2026-01-01")', '>= date("2026-01-01")']);
      expect(outputTexts(table, 1)).toEqual(['date("2026-01-01")', '']);
      expect(xml).toContain('&lt; date("2026-01-01")');
    });

    scenario('CAMUNDA7-036', '`date` column with a FEEL syntax error is rejected', async (dir) => {
      const rows = w0(
        [
          { marker: 'input', name: 'since', type: 'date' },
          { marker: 'output', name: 'validFrom', type: 'date' },
        ],
        [['date("2026-01-01"', 'date("2026-01-01")'], ['>= date("2026-01-01")']],
      );
      expectFailure(await convertSheet(dir, rows), 'Base DMN!D5', 'since', /invalid FEEL/i);
    });

    const tagsSheet = (
      type = 'Any',
      d5 = 'not(some t in ["fragile","hazmat"] satisfies t = tag)',
    ) => w0([{ marker: 'input', name: 'tags', type }], [[d5], ['-']]);

    scenario('CAMUNDA7-037', '`Any` column omits typeRef', async (dir) => {
      const expr = 'not(some t in ["fragile","hazmat"] satisfies t = tag)';
      const { xml, table } = await expectDmn(await convertSheet(dir, tagsSheet('Any', expr)));
      expect(tag(xml, 'inputExpression', 'tags_expression')).toEqual({ id: 'tags_expression' });
      expect(inputTexts(table, 1)).toEqual([expr, '']);
    });

    scenario(
      'CAMUNDA7-038',
      'Any aliases in every casing are treated as untyped (one scenario per value)',
      async (dir) => {
        const values = [
          'Any',
          'any',
          'ANY',
          'none',
          'None',
          'NONE',
          'object',
          'Object',
          'OBJECT',
          'aNy',
        ];
        for (const [i, type] of values.entries()) {
          const rows = w0([{ marker: 'input', name: 'tags', type }], [['"x"'], ['5']]);
          const { xml } = await expectDmn(await convertSheet(join(dir, String(i)), rows));
          expect(tag(xml, 'inputExpression', 'tags_expression'), type).toEqual({
            id: 'tags_expression',
          });
        }
      },
    );

    scenario('CAMUNDA7-039', 'Any output column omits typeRef', async (dir) => {
      const rows = w0(
        [{ marker: 'output', name: 'payload', type: 'object' }],
        [['{a: 1}'], ['"x"']],
      );
      const { xml } = await expectDmn(await convertSheet(dir, rows));
      const out = tag(xml, 'output', 'payload');
      expect(out.name).toBe('payload');
      expect(out).not.toHaveProperty('typeRef');
    });

    scenario(
      'CAMUNDA7-040',
      '`types.anyDmnPlaceholder` emits an explicit typeRef for Any columns',
      async (dir) => {
        const r = await convertSheet(dir, tagsSheet('none'), {
          config: { types: { anyDmnPlaceholder: 'Any' } },
        });
        const { xml } = await expectDmn(r);
        expect(tag(xml, 'inputExpression', 'tags_expression').typeRef).toBe('Any');
      },
    );

    scenario('CAMUNDA7-041', 'Any column with a FEEL syntax error is rejected', async (dir) => {
      const r = await convertSheet(dir, tagsSheet('Any', '[1..'));
      expectFailure(r, 'Base DMN!D5', 'tags', /invalid FEEL/i);
    });

    scenario('CAMUNDA7-042', 'DMN-only `number` is rejected by default (input)', async (dir) => {
      const r = await convertSheet(dir, setCells(w0(), { B3: 'number' }));
      expectFailure(r, 'Base DMN!B3', 'number', /not a Camunda type/i, 'integer', 'long', 'double');
    });

    scenario('CAMUNDA7-043', 'DMN-only `number` is rejected by default (output)', async (dir) => {
      const rows = w0([{ marker: 'output', name: 'fee', type: 'number' }], [['1'], ['2']]);
      expectFailure(await convertSheet(dir, rows), 'Base DMN!D3', /not a Camunda type/i);
    });

    const nonCamunda = (type, d5) => w0([{ marker: 'input', name: 'at', type }], [[d5], ['-']]);

    scenario('CAMUNDA7-044', '`time` is rejected by default', async (dir) => {
      const r = await convertSheet(dir, nonCamunda('time', '< time("12:00:00")'));
      expectFailure(r, 'Base DMN!D3', /not a Camunda type/i);
    });

    scenario('CAMUNDA7-045', '`dateTime` is rejected by default', async (dir) => {
      const r = await convertSheet(
        dir,
        nonCamunda('dateTime', '< date and time("2026-01-01T00:00:00")'),
      );
      expectFailure(r, 'Base DMN!D3', /not a Camunda type/i);
    });

    scenario('CAMUNDA7-046', '`dayTimeDuration` is rejected by default', async (dir) => {
      const r = await convertSheet(dir, nonCamunda('dayTimeDuration', '> duration("P1D")'));
      expectFailure(r, 'Base DMN!D3', /not a Camunda type/i);
    });

    scenario('CAMUNDA7-047', '`yearMonthDuration` is rejected by default', async (dir) => {
      const r = await convertSheet(dir, nonCamunda('yearMonthDuration', '> duration("P1Y")'));
      expectFailure(r, 'Base DMN!D3', /not a Camunda type/i);
    });

    scenario('CAMUNDA7-048', 'All non-Camunda type errors are reported in one run', async (dir) => {
      const rows = setCells(
        w0(
          [
            { marker: 'input', name: 'at', type: 'time' },
            { marker: 'output', name: 'd', type: 'dateTime' },
          ],
          [['-'], ['-']],
        ),
        { B3: 'number' },
      );
      expectFailure(await convertSheet(dir, rows), 'Base DMN!B3', 'Base DMN!D3', 'Base DMN!E3');
    });

    scenario('CAMUNDA7-049', '`nonCamundaTypeAction: "warn"` converts and warns', async (dir) => {
      const config = { types: { nonCamundaTypeAction: 'warn' } };
      const r = await convertSheet(dir, setCells(w0(), { B3: 'number' }), { config });
      const { xml } = await expectDmn(r);
      expect(tag(xml, 'inputExpression', 'amount_expression').typeRef).toBe('number');
      // Programmatic API: the warning is returned per sheet.
      const api = await convert(join(dir, 'base_DMN.xlsx'), {
        config: loadConfig({
          configPath: join(dir, CFG),
          cwd: dir,
          overrides: { output: { outDir: join(dir, 'api') } },
        }),
      });
      expect(api.problems).toEqual([]);
      const warnings = api.results[0].warnings;
      expect(warnings).toHaveLength(1);
      expect(warnings[0].location).toBe('Base DMN!B3');
      expect(warnings[0].message).toMatch(/not a Camunda type/i);
      // CLI: a warning is shown to the user on stderr.
      expect(r.stderr).toContain('Base DMN!B3');
      expect(r.stderr).toMatch(/not a Camunda type/i);
    });

    scenario(
      'CAMUNDA7-050',
      '`nonCamundaTypeAction: "warn"` for every DMN-only type',
      async (dir) => {
        const types = ['number', 'time', 'dateTime', 'dayTimeDuration', 'yearMonthDuration'];
        const rows = decisionSheet(
          [
            { marker: 'id', name: 'BASE' },
            ...types.map((type, i) => ({ marker: 'input', name: `in${i}`, type })),
            { marker: 'output', name: 'r', type: 'integer' },
          ],
          [[null, '-', '-', '-', '-', '-', '1']],
        );
        const config = { types: { nonCamundaTypeAction: 'warn' } };
        const { xml } = await expectDmn(await convertSheet(dir, rows, { config }));
        types.forEach((type, i) =>
          expect(tag(xml, 'inputExpression', `in${i}_expression`).typeRef).toBe(type),
        );
        expect(tag(xml, 'output', 'r').typeRef).toBe('integer');
        const api = await convert(join(dir, 'base_DMN.xlsx'), {
          config: loadConfig({ configPath: join(dir, CFG), cwd: dir }),
          write: false,
        });
        expect(api.results[0].warnings.map((w) => w.location)).toEqual(
          ['B3', 'C3', 'D3', 'E3', 'F3'].map((c) => `Base DMN!${c}`),
        );
      },
    );

    scenario('CAMUNDA7-051', '`nonCamundaTypeAction: "off"` converts silently', async (dir) => {
      const config = { types: { nonCamundaTypeAction: 'off' } };
      const r = await convertSheet(dir, setCells(w0(), { B3: 'number' }), { config });
      const { xml } = await expectDmn(r);
      expect(tag(xml, 'inputExpression', 'amount_expression').typeRef).toBe('number');
      expect(r.stderr).toBe('');
      const api = await convert(join(dir, 'base_DMN.xlsx'), {
        config: loadConfig({ configPath: join(dir, CFG), cwd: dir }),
        write: false,
      });
      expect(api.results[0].warnings).toEqual([]);
    });

    scenario('CAMUNDA7-052', 'Unknown typeRef is rejected with its coordinate', async (dir) => {
      const r = await convertSheet(dir, setCells(w0(), { B3: 'text' }));
      expectFailure(r, 'Base DMN!B3', /unknown typeRef 'text'/i);
    });

    scenario(
      'CAMUNDA7-053',
      'Wrong-case Camunda type (`String`, `Integer`, `BOOLEAN`)',
      async (dir) => {
        const r1 = await convertSheet(join(dir, '1'), setCells(w0(), { B3: 'Integer' }));
        expectFailure(r1, 'Base DMN!B3', /unknown typeRef/i);
        const r2 = await convertSheet(join(dir, '2'), setCells(w0(), { C3: 'String' }));
        expectFailure(r2, 'Base DMN!C3', /unknown typeRef/i);
        const bool = w0(
          [{ marker: 'input', name: 'flag', type: 'BOOLEAN' }],
          [['true'], ['false']],
        );
        const r3 = await convertSheet(join(dir, '3'), bool);
        expectFailure(r3, 'Base DMN!D3', /unknown typeRef/i);
      },
    );

    scenario('CAMUNDA7-054', 'Type cell with surrounding whitespace is trimmed', async (dir) => {
      const r = await convertSheet(dir, setCells(w0(), { B3: '  integer  ' }));
      const { xml } = await expectDmn(r);
      expect(tag(xml, 'inputExpression', 'amount_expression').typeRef).toBe('integer');
    });
  });

  describe('5. FEEL validation of entries per type', () => {
    scenario('CAMUNDA7-055', 'Valid numeric unary tests are accepted', async (dir) => {
      const values = ['1', '[1..10]', '>= 3', '1, 2, 3', 'not(1, 2)', '3.5', ']0..100['];
      const rows = decisionSheet(
        W0_COLS,
        values.map((v) => [null, v, '"X"']),
      );
      const { table } = await expectDmn(await convertSheet(dir, rows));
      expect(table.rule.map((r) => r.id)).toEqual(values.map((_, i) => `rule_${i + 1}`));
      expect(inputTexts(table)).toEqual(values);
    });

    scenario('CAMUNDA7-056', 'String literal in an integer input is a type error', async (dir) => {
      const r = await convertSheet(dir, setCells(w0(), { B5: '"5"' }));
      expectFailure(r, 'Base DMN!B5', 'amount', 'integer');
    });

    scenario('CAMUNDA7-057', 'Boolean literal in an integer input is a type error', async (dir) => {
      const r = await convertSheet(dir, setCells(w0(), { B5: 'true' }));
      expectFailure(r, 'Base DMN!B5', 'amount');
    });

    scenario(
      'CAMUNDA7-058',
      'Bare identifier in a numeric input is allowed by default',
      async (dir) => {
        const r = await convertSheet(dir, setCells(w0(), { B5: '> threshold' }));
        const { table } = await expectDmn(r);
        expect(inputTexts(table)[0]).toBe('> threshold');
      },
    );

    scenario(
      'CAMUNDA7-059',
      'Bare identifier in a numeric input is rejected when `allowExpressions` is false',
      async (dir) => {
        const r = await convertSheet(dir, setCells(w0(), { B5: '> threshold' }), {
          config: { types: { number: { allowExpressions: false } } },
        });
        expectFailure(r, 'Base DMN!B5', 'amount');
      },
    );

    const regionSheet = (d5, d6 = '"EU"') =>
      w0([{ marker: 'input', name: 'region', type: 'string', label: 'Region' }], [[d5], [d6]]);

    scenario(
      'CAMUNDA7-060',
      'Unquoted word in a string input is rejected, with an add-quotes hint',
      async (dir) => {
        expectFailure(await convertSheet(dir, regionSheet('US')), 'Base DMN!D5', 'region', '"US"');
      },
    );

    scenario('CAMUNDA7-061', 'Number or boolean in a string input is rejected', async (dir) => {
      expectFailure(await convertSheet(join(dir, '1'), regionSheet('5')), 'Base DMN!D5', 'region');
      expectFailure(
        await convertSheet(join(dir, '2'), regionSheet('true')),
        'Base DMN!D5',
        'region',
      );
    });

    scenario('CAMUNDA7-062', 'Valid string unary tests are accepted', async (dir) => {
      const values = ['"EU"', '"EU","US"', 'not("EU")', '""'];
      const rows = decisionSheet(
        [...W0_COLS, { marker: 'input', name: 'region', type: 'string' }],
        values.map((v) => [null, '-', '"X"', v]),
      );
      const { table } = await expectDmn(await convertSheet(dir, rows));
      expect(inputTexts(table, 1)).toEqual(values);
    });

    const boolSheet = (values) =>
      decisionSheet(
        [...W0_COLS, { marker: 'input', name: 'isMember', type: 'boolean' }],
        values.map((v) => [null, '< 10', '"X"', v]),
      );

    scenario('CAMUNDA7-063', 'Boolean input accepts only true / false / wildcard', async (dir) => {
      const { xml, table } = await expectDmn(
        await convertSheet(dir, boolSheet(['true', 'false', '-'])),
      );
      expect(inputTexts(table, 1)).toEqual(['true', 'false', '']);
      expect(xml).toMatch(emptyEntry('inputEntry', 'isMember_3'));
    });

    scenario(
      'CAMUNDA7-064',
      'Boolean input rejects `"true"`, `1` and `yes` (one run each)',
      async (dir) => {
        for (const [i, v] of ['"true"', '1', 'yes'].entries()) {
          const r = await convertSheet(join(dir, String(i)), boolSheet([v, 'false']));
          expectFailure(r, 'Base DMN!D5', 'isMember');
        }
      },
    );

    scenario(
      'CAMUNDA7-065',
      'Boolean input rejects a bare identifier even though expressions are allowed for other types',
      async (dir) => {
        expectFailure(
          await convertSheet(dir, boolSheet(['flag', 'false'])),
          'Base DMN!D5',
          'isMember',
        );
      },
    );

    scenario(
      'CAMUNDA7-066',
      'Syntax error in an input entry is reported with its coordinate',
      async (dir) => {
        const r = await convertSheet(dir, setCells(w0(), { B5: '[1..10' }));
        expectFailure(r, 'Base DMN!B5', 'amount', /invalid FEEL/i);
      },
    );

    scenario('CAMUNDA7-067', 'String output must be quoted', async (dir) => {
      const r = await convertSheet(dir, setCells(w0(), { C5: 'LOW' }));
      expectFailure(r, 'Base DMN!C5', 'result', /quoted string/i);
    });

    scenario('CAMUNDA7-068', 'Numeric text in a string output is rejected', async (dir) => {
      const r = await convertSheet(dir, setCells(w0(), { C5: '5' }));
      expectFailure(r, 'Base DMN!C5', 'result');
    });

    scenario('CAMUNDA7-069', 'Empty string literal `""` is a valid string output', async (dir) => {
      const { table } = await expectDmn(await convertSheet(dir, setCells(w0(), { C5: '""' })));
      expect(outputTexts(table)[0]).toBe('""');
    });

    scenario(
      'CAMUNDA7-070',
      '`outputEntries.autoQuote` wraps unquoted string outputs',
      async (dir) => {
        const r = await convertSheet(dir, setCells(w0(), { C5: 'LOW' }), {
          config: { outputEntries: { autoQuote: true } },
        });
        const { table } = await expectDmn(r);
        expect(outputTexts(table)).toEqual(['"LOW"', '"HIGH"']);
      },
    );

    scenario(
      'CAMUNDA7-071',
      '`outputEntries.requireQuotes: false` emits unquoted string outputs verbatim',
      async (dir) => {
        const r = await convertSheet(dir, setCells(w0(), { C5: 'LOW' }), {
          config: { outputEntries: { requireQuotes: false } },
        });
        const { table } = await expectDmn(r);
        expect(outputTexts(table)).toEqual(['LOW', '"HIGH"']);
      },
    );

    const daysSheet = (d5, d6 = '10', extra = [], extraValues = [[], []]) =>
      w0(
        [{ marker: 'output', name: 'days', type: 'integer' }, ...extra],
        [
          [d5, ...extraValues[0]],
          [d6, ...extraValues[1]],
        ],
      );

    scenario('CAMUNDA7-072', 'Integer output rejects a string literal', async (dir) => {
      expectFailure(await convertSheet(dir, daysSheet('"5"')), 'Base DMN!D5', 'days');
    });

    const expressCol = [{ marker: 'output', name: 'express', type: 'boolean' }];

    scenario('CAMUNDA7-073', 'Numeric and boolean outputs are emitted unquoted', async (dir) => {
      const rows = daysSheet('5', '10', expressCol, [['true'], ['false']]);
      const { table } = await expectDmn(await convertSheet(dir, rows));
      expect(outputTexts(table, 1)).toEqual(['5', '10']);
      expect(outputTexts(table, 2)).toEqual(['true', 'false']);
      expect(table.rule[0].outputEntry[2].id).toBe('express_1');
    });

    scenario('CAMUNDA7-074', 'Boolean output rejects `"true"`', async (dir) => {
      const rows = daysSheet('5', '10', expressCol, [['"true"'], ['false']]);
      expectFailure(await convertSheet(dir, rows), 'Base DMN!E5', 'express');
    });

    scenario(
      'CAMUNDA7-075',
      'Empty output cell is allowed and emitted as empty text',
      async (dir) => {
        const { xml } = await expectDmn(await convertSheet(dir, daysSheet(null)));
        expect(xml).toMatch(emptyEntry('outputEntry', 'days_1'));
      },
    );

    const multiErrorRows = () => setCells(w0(), { B5: '"5"', C6: 'HIGH', B7: '[1..', C7: '"X"' });

    scenario(
      'CAMUNDA7-076',
      'All entry errors across rows and columns are reported together',
      async (dir) => {
        const r = await convertSheet(dir, multiErrorRows());
        expectFailure(r, 'Base DMN!B5', 'Base DMN!C6', 'Base DMN!B7');
      },
    );

    scenario(
      'CAMUNDA7-077',
      '`validation.feel.failFast: true` stops at the first problem',
      async (dir) => {
        const r = await convertSheet(dir, multiErrorRows(), {
          config: { validation: { feel: { failFast: true } } },
        });
        expectFailure(r, 'Base DMN!B5');
        expect(r.stderr).not.toContain('Base DMN!C6');
        expect(r.stderr).not.toContain('Base DMN!B7');
      },
    );

    scenario(
      'CAMUNDA7-078',
      '`validation.feel.mode: "off"` skips input validation',
      async (dir) => {
        const r = await convertSheet(dir, setCells(w0(), { B5: '"5"' }), {
          config: { validation: { feel: { mode: 'off' } } },
        });
        const { table } = await expectDmn(r);
        expect(inputTexts(table)[0]).toBe('"5"');
      },
    );

    scenario(
      'CAMUNDA7-079',
      '`validation.feel.mode: "any-inputs"` validates only Any-typed inputs',
      async (dir) => {
        const rows = setCells(
          w0([{ marker: 'input', name: 'tags', type: 'Any' }], [['[1..'], ['-']]),
          { B5: '"5"' },
        );
        const r = await convertSheet(dir, rows, {
          config: { validation: { feel: { mode: 'any-inputs' } } },
        });
        expectFailure(r, 'Base DMN!D5');
        expect(r.stderr).not.toContain('Base DMN!B5');
      },
    );

    scenario(
      'CAMUNDA7-080',
      'Error coordinates use the real column letter beyond Z',
      async (dir) => {
        const helpers = Array.from({ length: 26 }, () => ({ marker: null }));
        const pad = Array(26).fill(null);
        const rows = decisionSheet(
          [...helpers, ...W0_COLS],
          [
            [...pad, null, '"5"', '"LOW"'],
            [...pad, null, '>= 10', '"HIGH"'],
          ],
        );
        expectFailure(await convertSheet(dir, rows), 'Base DMN!AB5', 'amount');
      },
    );

    scenario(
      'CAMUNDA7-081',
      'Sheet names with spaces and underscores appear verbatim in coordinates',
      async (dir) => {
        const r = await convertBook(dir, {
          'Shipping Rates_ DMN': setCells(w0(), { B5: '"5"' }),
        });
        expectFailure(r, 'Shipping Rates_ DMN!B5');
      },
    );
  });

  describe('6. Wildcards, empty cells, and the "any" token', () => {
    scenario(
      'CAMUNDA7-082',
      '`-` input is emitted as empty text, never a literal dash',
      async (dir) => {
        const { xml } = await expectDmn(await convertSheet(dir, setCells(w0(), { B5: '-' })));
        expect(xml).toMatch(emptyEntry('inputEntry', 'amount_1'));
        expect(xml).not.toContain('<text>-</text>');
      },
    );

    scenario('CAMUNDA7-083', 'Empty input cell is emitted as empty text', async (dir) => {
      const { xml, table } = await expectDmn(await convertSheet(dir, setCells(w0(), { B5: null })));
      expect(table.rule).toHaveLength(2);
      expect(xml).toMatch(emptyEntry('inputEntry', 'amount_1'));
    });

    scenario('CAMUNDA7-084', '`rules.emitAnyInputAs: "-"` emits a literal dash', async (dir) => {
      const r = await convertSheet(dir, setCells(w0(), { B5: '-' }), {
        config: { rules: { emitAnyInputAs: '-' } },
      });
      const { table } = await expectDmn(r);
      expect(inputTexts(table)[0]).toBe('-');
    });

    scenario('CAMUNDA7-085', 'Custom any-token in `rules.anyInputTokens`', async (dir) => {
      const rows = setCells(w0(), { B5: '*' });
      const r = await convertSheet(join(dir, 'with'), rows, {
        config: { rules: { anyInputTokens: ['-', '', '*'] } },
      });
      const { xml } = await expectDmn(r);
      expect(xml).toMatch(emptyEntry('inputEntry', 'amount_1'));
      // Without the config, `*` is not a valid FEEL unary test.
      expectFailure(await convertSheet(join(dir, 'without'), rows), 'Base DMN!B5');
    });

    scenario('CAMUNDA7-086', 'Wildcard is valid for every typeRef', async (dir) => {
      const types = ['string', 'boolean', 'integer', 'long', 'double', 'date', 'Any'];
      const rows = decisionSheet(
        [
          { marker: 'id', name: 'BASE' },
          ...types.map((type, i) => ({ marker: 'input', name: `in${i}`, type })),
          { marker: 'output', name: 'result', type: 'string' },
        ],
        [
          [null, ...types.map(() => '-'), '"A"'],
          [null, ...types.map(() => null), '"B"'],
        ],
      );
      const { xml, table } = await expectDmn(await convertSheet(dir, rows));
      const empties = [...xml.matchAll(/<inputEntry id="in\d_\d">\s*<text><\/text>/g)];
      expect(empties).toHaveLength(14);
      for (let i = 0; i < types.length; i++) expect(inputTexts(table, i)).toEqual(['', '']);
    });

    scenario('CAMUNDA7-087', "Text dash entered as `'-` behaves as the wildcard", async (dir) => {
      const { xml } = await expectDmn(await convertSheet(dir, setCells(w0(), { B5: '-' })));
      expect(xml).toMatch(emptyEntry('inputEntry', 'amount_1'));
      expect(xml).not.toContain('<text>-</text>');
    });
  });

  describe('7. Cell values: real Excel numbers, booleans, formulas, whitespace', () => {
    scenario('CAMUNDA7-088', 'Real Excel integer in an integer input', async (dir) => {
      const { table } = await expectDmn(await convertSheet(dir, setCells(w0(), { B5: 5 })));
      expect(inputTexts(table)[0]).toBe('5');
    });

    const feeSheet = (d5, d6) =>
      w0([{ marker: 'output', name: 'fee', type: 'double' }], [[d5], [d6]]);

    scenario('CAMUNDA7-089', 'Real Excel decimal in a double output', async (dir) => {
      const { table } = await expectDmn(await convertSheet(dir, feeSheet(1.5, 0)));
      expect(outputTexts(table, 1)).toEqual(['1.5', '0']);
    });

    scenario(
      'CAMUNDA7-090',
      'Formatted numeric cell emits canonical FEEL, not the display string',
      async (dir) => {
        const path = await writeBook(dir, { 'Base DMN': feeSheet(1221, 0) });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(path);
        wb.getWorksheet('Base DMN').getCell('D5').numFmt = '#,##0.00';
        await wb.xlsx.writeFile(path);
        const { table } = await expectDmn(runConvert(dir));
        expect(outputTexts(table, 1)[0]).toBe('1221');
      },
    );

    const memberSheet = (d5, d6) =>
      w0([{ marker: 'input', name: 'isMember', type: 'boolean' }], [[d5], [d6]]);

    scenario('CAMUNDA7-091', 'Real Excel boolean in a boolean input is lowercased', async (dir) => {
      const { table } = await expectDmn(await convertSheet(dir, memberSheet(true, false)));
      expect(inputTexts(table, 1)).toEqual(['true', 'false']);
    });

    scenario('CAMUNDA7-092', 'Real Excel boolean in a boolean output', async (dir) => {
      const rows = w0([{ marker: 'output', name: 'express', type: 'boolean' }], [[true], [false]]);
      const { table } = await expectDmn(await convertSheet(dir, rows));
      expect(table.rule.map((r) => [r.outputEntry[1].id, r.outputEntry[1].text])).toEqual([
        ['express_1', 'true'],
        ['express_2', 'false'],
      ]);
    });

    scenario(
      'CAMUNDA7-093',
      'Real Excel number in a string column is a type error',
      async (dir) => {
        const r = await convertSheet(dir, setCells(w0(), { C5: 5 }));
        expectFailure(r, 'Base DMN!C5', 'result');
      },
    );

    scenario(
      'CAMUNDA7-094',
      'Real Excel boolean in an integer column is a type error',
      async (dir) => {
        const r = await convertSheet(dir, setCells(w0(), { B5: true }));
        expectFailure(r, 'Base DMN!B5', 'amount');
      },
    );

    scenario('CAMUNDA7-095', 'Text `TRUE` (upper case) in a boolean column', async (dir) => {
      const r = await convertSheet(dir, memberSheet('TRUE', 'false'));
      expectFailure(r, 'Base DMN!D5', 'isMember');
    });

    scenario('CAMUNDA7-096', 'Formula cell uses its computed result', async (dir) => {
      const rows = w0(
        [{ marker: 'output', name: 'days', type: 'integer' }],
        [[{ formula: '2+3', result: 5 }], ['10']],
      );
      const { xml, table } = await expectDmn(await convertSheet(dir, rows));
      expect(outputTexts(table, 1)[0]).toBe('5');
      expect(xml).not.toContain('2+3');
    });

    scenario(
      'CAMUNDA7-097',
      'Leading and trailing whitespace is trimmed from entries',
      async (dir) => {
        const rows = setCells(w0(), { B5: '   < 10  ', C5: ' "LOW"' });
        const { table } = await expectDmn(await convertSheet(dir, rows));
        expect(inputTexts(table)[0]).toBe('< 10');
        expect(outputTexts(table)[0]).toBe('"LOW"');
      },
    );

    scenario(
      'CAMUNDA7-098',
      'Interior UTF-8 is preserved in entries, labels and names',
      async (dir) => {
        const rows = setCells(w0([{ marker: 'name', name: 'Opłata za wysyłkę' }]), {
          C4: 'Wynik – opis ≤',
          C5: '"Zürich – Süd ≤ łódź"',
        });
        const { definitions, decision, table } = await expectDmn(await convertSheet(dir, rows));
        expect(decision.name).toBe('Opłata za wysyłkę');
        expect(definitions.name).toBe('Opłata za wysyłkę');
        expect(table.output[0].label).toBe('Wynik – opis ≤');
        expect(outputTexts(table)[0]).toBe('"Zürich – Süd ≤ łódź"');
      },
    );

    scenario(
      'CAMUNDA7-099',
      'XML-special characters in a string output are escaped and round-trip',
      async (dir) => {
        const r = await convertSheet(dir, setCells(w0(), { C5: '"A & B <C>"' }));
        const { xml, table } = await expectDmn(r);
        expect(xml).toContain('&amp;');
        expect(xml).toMatch(/&lt;C(>|&gt;)/);
        expect(outputTexts(table)[0]).toBe('"A & B <C>"');
      },
    );
  });

  describe('8. Hit policies', () => {
    const hitPolicyOf = (xml) => tag(xml, 'decisionTable');

    scenario('CAMUNDA7-100', 'Policy marker column `FIRST`', async (dir) => {
      const { xml, table } = await expectDmn(await convertSheet(dir, withPolicy('FIRST')));
      expect(hitPolicyOf(xml).hitPolicy).toBe('FIRST');
      expect(hitPolicyOf(xml)).not.toHaveProperty('aggregation');
      expect(table.input).toHaveLength(1);
      expect(table.output).toHaveLength(1);
    });

    scenario('CAMUNDA7-101', 'Policy `ANY`', async (dir) => {
      const { xml } = await expectDmn(await convertSheet(dir, withPolicy('ANY')));
      expect(hitPolicyOf(xml).hitPolicy).toBe('ANY');
    });

    scenario('CAMUNDA7-102', 'Policy `RULE ORDER` (value with a space)', async (dir) => {
      const { xml, table } = await expectDmn(await convertSheet(dir, withPolicy('RULE ORDER')));
      expect(hitPolicyOf(xml).hitPolicy).toBe('RULE ORDER');
      expect(table.hitPolicy).toBe('RULE ORDER');
    });

    scenario('CAMUNDA7-103', 'Policy `COLLECT` without an aggregator', async (dir) => {
      const { xml } = await expectDmn(await convertSheet(dir, withPolicy('COLLECT')));
      expect(hitPolicyOf(xml).hitPolicy).toBe('COLLECT');
      expect(hitPolicyOf(xml)).not.toHaveProperty('aggregation');
    });

    const daysCols = [W0_COLS[0], W0_COLS[1], { marker: 'output', name: 'days', type: 'integer' }];
    const daysRules = [
      [null, '< 10', '1'],
      [null, '>= 10', '2'],
    ];

    scenario(
      'CAMUNDA7-104',
      'COLLECT with each aggregator (SUM, MIN, MAX, COUNT; one run each)',
      async (dir) => {
        for (const agg of ['SUM', 'MIN', 'MAX', 'COUNT']) {
          const rows = withPolicy('COLLECT', agg, daysCols, daysRules);
          const { xml, table } = await expectDmn(await convertSheet(join(dir, agg), rows));
          expect(hitPolicyOf(xml)).toMatchObject({ hitPolicy: 'COLLECT', aggregation: agg });
          expect(table.aggregation).toBe(agg);
        }
      },
    );

    scenario('CAMUNDA7-105', 'Unknown COLLECT aggregator is rejected', async (dir) => {
      const r = await convertSheet(dir, withPolicy('COLLECT', 'AVG', daysCols, daysRules));
      expectFailure(r, 'AVG', 'Base DMN!A3');
    });

    scenario('CAMUNDA7-106', 'Aggregator on a non-COLLECT policy is ignored', async (dir) => {
      const { xml } = await expectDmn(
        await convertSheet(dir, withPolicy('FIRST', 'SUM', daysCols, daysRules)),
      );
      expect(hitPolicyOf(xml).hitPolicy).toBe('FIRST');
      expect(hitPolicyOf(xml)).not.toHaveProperty('aggregation');
    });

    scenario(
      'CAMUNDA7-107',
      'Explicit `UNIQUE` in the policy column is not written',
      async (dir) => {
        const { xml } = await expectDmn(await convertSheet(dir, withPolicy('UNIQUE')));
        expect(hitPolicyOf(xml)).not.toHaveProperty('hitPolicy');
      },
    );

    scenario(
      'CAMUNDA7-108',
      'Lower-case policy and aggregator values are accepted',
      async (dir) => {
        const r1 = await convertSheet(
          join(dir, '1'),
          withPolicy('collect', 'sum', daysCols, daysRules),
        );
        const a = await expectDmn(r1);
        expect(hitPolicyOf(a.xml)).toMatchObject({ hitPolicy: 'COLLECT', aggregation: 'SUM' });
        const b = await expectDmn(await convertSheet(join(dir, '2'), withPolicy('rule order')));
        expect(hitPolicyOf(b.xml).hitPolicy).toBe('RULE ORDER');
      },
    );

    scenario('CAMUNDA7-109', 'Unknown hit policy is rejected', async (dir) => {
      expectFailure(await convertSheet(dir, withPolicy('RANDOM')), 'RANDOM', /hit policy/i);
    });

    scenario(
      'CAMUNDA7-110',
      '`--hit-policy` is the fallback when there is no policy column',
      async (dir) => {
        const r = await convertSheet(dir, w0(), { args: ['--hit-policy', 'FIRST'] });
        const { xml } = await expectDmn(r);
        expect(hitPolicyOf(xml).hitPolicy).toBe('FIRST');
      },
    );

    scenario('CAMUNDA7-111', 'Policy column beats `--hit-policy`', async (dir) => {
      const r = await convertSheet(dir, withPolicy('FIRST'), {
        args: ['--hit-policy', 'RULE ORDER'],
      });
      const { xml } = await expectDmn(r);
      expect(hitPolicyOf(xml).hitPolicy).toBe('FIRST');
    });

    scenario('CAMUNDA7-112', '`hitPolicy.default` from config is the fallback', async (dir) => {
      const r = await convertSheet(dir, w0(), { config: { hitPolicy: { default: 'ANY' } } });
      const { xml } = await expectDmn(r);
      expect(hitPolicyOf(xml).hitPolicy).toBe('ANY');
    });

    scenario('CAMUNDA7-113', '`--hit-policy` beats the config default', async (dir) => {
      const r = await convertSheet(dir, w0(), {
        config: { hitPolicy: { default: 'ANY' } },
        args: ['--hit-policy', 'FIRST'],
      });
      const { xml } = await expectDmn(r);
      expect(hitPolicyOf(xml).hitPolicy).toBe('FIRST');
    });

    scenario('CAMUNDA7-114', 'Policy column with an empty value falls back', async (dir) => {
      const rows = withPolicy(null);
      const a = await expectDmn(
        await convertSheet(join(dir, 'flag'), rows, { args: ['--hit-policy', 'FIRST'] }),
      );
      expect(hitPolicyOf(a.xml).hitPolicy).toBe('FIRST');
      const b = await expectDmn(await convertSheet(join(dir, 'noflag'), rows));
      expect(hitPolicyOf(b.xml)).not.toHaveProperty('hitPolicy');
    });

    scenario('CAMUNDA7-115', '`--hit-policy` with an invalid value is rejected', async (dir) => {
      const r = await convertSheet(dir, w0(), { args: ['--hit-policy', 'BOGUS'] });
      expectFailure(r, 'BOGUS');
    });

    scenario('CAMUNDA7-116', 'Two policy columns are a structural error', async (dir) => {
      const rows = decisionSheet(
        [{ marker: 'policy', name: 'FIRST' }, { marker: 'policy', name: 'ANY' }, ...W0_COLS],
        W0_RULES.map((r) => [null, null, ...r]),
      );
      expectFailure(await convertSheet(dir, rows), /more than one policy/i, 'Base DMN!B1');
    });

    const prioritySheet = (policy) =>
      avSheet(
        [
          { marker: 'policy', name: policy },
          W0_COLS[0],
          W0_COLS[1],
          { ...W0_COLS[2], allowed: '"HIGH","LOW"' },
        ],
        [
          [null, null, '< 10', '"LOW"'],
          [null, null, '>= 5', '"HIGH"'],
        ],
      );

    scenario(
      'CAMUNDA7-117',
      'PRIORITY with allowed values converts (C7 supports it)',
      async (dir) => {
        const r = await convertSheet(dir, prioritySheet('PRIORITY'), { config: AV() });
        const { xml, table } = await expectDmn(r);
        expect(hitPolicyOf(xml).hitPolicy).toBe('PRIORITY');
        expect(xml).toMatch(
          /<output [^>]*>\s*<outputValues>\s*<text>"HIGH","LOW"<\/text>\s*<\/outputValues>\s*<\/output>/,
        );
        expect(table.output[0].outputValues.text).toBe('"HIGH","LOW"');
      },
    );

    scenario('CAMUNDA7-118', 'OUTPUT ORDER with allowed values converts', async (dir) => {
      const r = await convertSheet(dir, prioritySheet('OUTPUT ORDER'), { config: AV() });
      const { xml, table } = await expectDmn(r);
      expect(hitPolicyOf(xml).hitPolicy).toBe('OUTPUT ORDER');
      expect(table.output[0].outputValues.text).toBe('"HIGH","LOW"');
    });

    scenario(
      'CAMUNDA7-119',
      'PRIORITY in the default 4-row layout (no allowed-values row) is rejected',
      async (dir) => {
        const r = await convertSheet(dir, withPolicy('PRIORITY'));
        expectFailure(r, 'PRIORITY', 'result', /allowed values|outputValues/i);
        expect(r.stderr).not.toContain('NaN');
      },
    );

    scenario(
      'CAMUNDA7-120',
      'OUTPUT ORDER with a blank output allowed-values cell is rejected with that cell',
      async (dir) => {
        const rows = avSheet(
          [...W0_COLS, { marker: 'policy', name: 'OUTPUT ORDER' }],
          W0_RULES.map((r) => [...r, null]),
        );
        expectFailure(await convertSheet(dir, rows, { config: AV() }), 'result', 'Base DMN!C4');
      },
    );

    scenario(
      'CAMUNDA7-121',
      'PRIORITY with two outputs, one missing allowed values',
      async (dir) => {
        const rows = avSheet(
          [
            W0_COLS[0],
            W0_COLS[1],
            { ...W0_COLS[2], allowed: '"HIGH","LOW"' },
            { marker: 'output', name: 'days', type: 'integer' },
            { marker: 'policy', name: 'PRIORITY' },
          ],
          [
            [null, '< 10', '"LOW"', '1', null],
            [null, '>= 10', '"HIGH"', '2', null],
          ],
        );
        const r = await convertSheet(dir, rows, { config: AV() });
        expectFailure(r, 'days', 'Base DMN!D4');
        expect(r.stderr).not.toContain('result');
      },
    );
  });

  describe('9. Allowed values (opt-in 5-row layout)', () => {
    const region = (allowed = '"EU","US"') => ({
      marker: 'input',
      name: 'region',
      type: 'string',
      label: 'Region',
      allowed,
    });
    const resultCol = (allowed) => ({ ...W0_COLS[2], allowed });
    const regionRules = (a = '"EU"', b = '"US"') => [
      [null, a, '"LOW"'],
      [null, b, '"HIGH"'],
    ];

    scenario('CAMUNDA7-122', 'Input allowed values map to `<inputValues>`', async (dir) => {
      const rows = avSheet([W0_COLS[0], region(), resultCol()], regionRules());
      const { xml, table } = await expectDmn(await convertSheet(dir, rows, { config: AV() }));
      expect(tags(xml, 'input')).toEqual([{ id: 'region', label: 'Region' }]);
      expect(xml).toMatch(
        /<input id="region" label="Region">[\s\S]*?<inputValues>\s*<text>"EU","US"<\/text>\s*<\/inputValues>\s*<\/input>/,
      );
      expect(tags(xml, 'inputValues')).toEqual([{}]);
      expect(table.input[0].inputValues.text).toBe('"EU","US"');
    });

    scenario('CAMUNDA7-123', 'Output allowed values map to `<outputValues>`', async (dir) => {
      const rows = avSheet([...W0_COLS.slice(0, 2), resultCol('"LOW","HIGH"')], W0_RULES);
      const { xml, table } = await expectDmn(await convertSheet(dir, rows, { config: AV() }));
      expect(xml).toMatch(/<outputValues>\s*<text>"LOW","HIGH"<\/text>\s*<\/outputValues>/);
      expect(tags(xml, 'outputValues')).toEqual([{}]);
      expect(table.output[0].outputValues.text).toBe('"LOW","HIGH"');
    });

    scenario(
      'CAMUNDA7-124',
      'Label is read from row M+4 and rules from M+5 in this layout',
      async (dir) => {
        const rows = avSheet([W0_COLS[0], region(), resultCol()], regionRules());
        const { xml, table } = await expectDmn(await convertSheet(dir, rows, { config: AV() }));
        expect(table.input[0].label).toBe('Region');
        expect(table.rule).toHaveLength(2);
        expect(table.rule[0].id).toBe('rule_1');
        expect(inputTexts(table)).toEqual(['"EU"', '"US"']);
        expect(xml).not.toMatch(/<text>Region<\/text>/);
      },
    );

    scenario('CAMUNDA7-125', 'A blank allowed-values cell means unconstrained', async (dir) => {
      const rows = avSheet(W0_COLS, W0_RULES);
      const { xml, table } = await expectDmn(await convertSheet(dir, rows, { config: AV() }));
      expect(xml).not.toContain('<inputValues');
      expect(table.input[0].inputValues).toBeUndefined();
    });

    scenario('CAMUNDA7-126', 'Numeric range and boolean domains', async (dir) => {
      const rows = avSheet(
        [
          W0_COLS[0],
          { ...W0_COLS[1], allowed: '[0..100]' },
          { marker: 'input', name: 'isMember', type: 'boolean', allowed: 'true,false' },
          { marker: 'output', name: 'days', type: 'integer', allowed: '1,2,3' },
        ],
        [
          [null, '< 10', 'true', '1'],
          [null, '>= 10', 'false', '2'],
        ],
      );
      const { table } = await expectDmn(await convertSheet(dir, rows, { config: AV() }));
      expect(table.input[0].inputValues.text).toBe('[0..100]');
      expect(table.input[1].inputValues.text).toBe('true,false');
      expect(table.output[0].outputValues.text).toBe('1,2,3');
    });

    scenario(
      'CAMUNDA7-127',
      'Allowed-values list with the wrong literal kind is rejected',
      async (dir) => {
        const rows = avSheet([W0_COLS[0], region('EU,US'), resultCol()], regionRules());
        expectFailure(await convertSheet(dir, rows, { config: AV() }), 'Base DMN!B4');
      },
    );

    const amountDomain = (allowed, rules = W0_RULES) =>
      avSheet([W0_COLS[0], { ...W0_COLS[1], allowed }, W0_COLS[2]], rules);

    scenario('CAMUNDA7-128', 'Numeric domain with a string member is rejected', async (dir) => {
      const r = await convertSheet(dir, amountDomain('1,"2"'), { config: AV() });
      expectFailure(r, 'Base DMN!B4');
    });

    scenario('CAMUNDA7-129', 'Allowed-values FEEL syntax error is rejected', async (dir) => {
      const r = await convertSheet(dir, amountDomain('[0..'), { config: AV() });
      expectFailure(r, 'Base DMN!B4');
    });

    scenario(
      'CAMUNDA7-130',
      'Out-of-domain entries pass when `enforceAllowedValues` is false (default)',
      async (dir) => {
        const rows = avSheet([W0_COLS[0], region(), resultCol()], regionRules('"APAC"'));
        const { table } = await expectDmn(await convertSheet(dir, rows, { config: AV() }));
        expect(inputTexts(table)[0]).toBe('"APAC"');
      },
    );

    const ENFORCE = AV({ validation: { enforceAllowedValues: true } });

    scenario(
      'CAMUNDA7-131',
      'Out-of-domain scalar is rejected when `enforceAllowedValues` is true',
      async (dir) => {
        const rows = avSheet([W0_COLS[0], region(), resultCol()], regionRules('"APAC"'));
        expectFailure(await convertSheet(dir, rows, { config: ENFORCE }), 'Base DMN!B6', 'region');
      },
    );

    scenario(
      'CAMUNDA7-132',
      'Numeric range outside the domain is rejected when enforcement is on',
      async (dir) => {
        const rows = amountDomain('[0..100]', [
          [null, '[50..150]', '"LOW"'],
          [null, '< 20', '"HIGH"'],
        ]);
        const r = await convertSheet(dir, rows, { config: ENFORCE });
        expectFailure(r, 'Base DMN!B6');
        expect(r.stderr).not.toContain('Base DMN!B7');
      },
    );

    scenario(
      'CAMUNDA7-133',
      'Wildcard and empty entries always pass domain enforcement',
      async (dir) => {
        const rows = avSheet([W0_COLS[0], region(), resultCol()], regionRules('-', null));
        await expectDmn(await convertSheet(dir, rows, { config: ENFORCE }));
      },
    );

    scenario(
      'CAMUNDA7-134',
      'Output entry outside the output domain is rejected when enforcement is on',
      async (dir) => {
        const rows = avSheet(
          [W0_COLS[0], W0_COLS[1], resultCol('"LOW","HIGH"')],
          [
            [null, '< 10', '"MID"'],
            [null, '>= 10', '"HIGH"'],
          ],
        );
        expectFailure(await convertSheet(dir, rows, { config: ENFORCE }), 'Base DMN!C6');
      },
    );

    scenario(
      'CAMUNDA7-135',
      'Allowed-values layout without allowed data still converts like the default',
      async (dir) => {
        const rows = avSheet(W0_COLS, W0_RULES);
        const { xml, table } = await expectDmn(await convertSheet(dir, rows, { config: AV() }));
        expect(xml).not.toContain('<inputValues');
        expect(xml).not.toContain('<outputValues');
        expect(table.input[0].label).toBe('Amount');
        expect(table.output[0].label).toBe('Result');
        expect(inputTexts(table)).toEqual(['< 10', '>= 10']);
      },
    );
  });

  describe('10. Annotations to rule <description>', () => {
    const annotated = (marker = 'annotations', d5 = 'small orders', d6 = null) =>
      w0([{ marker }], [[d5], [d6]]);

    async function expectAnnotated(r) {
      const { xml, table } = await expectDmn(r);
      expect(xml).toMatch(
        /<rule id="rule_1">\s*<description>small orders<\/description>\s*<inputEntry/,
      );
      expect(table.rule[0].description).toBe('small orders');
      expect(table.rule[1].description).toBeUndefined();
      expect(xml).not.toMatch(/<annotation/);
      expect(table.input).toHaveLength(1);
      expect(table.output).toHaveLength(1);
      return xml;
    }

    scenario(
      'CAMUNDA7-136',
      "Annotation cell becomes the rule's `<description>`, written first",
      async (dir) => {
        await expectAnnotated(await convertSheet(dir, annotated()));
      },
    );

    scenario(
      'CAMUNDA7-137',
      'Annotations marker is case-insensitive (`Annotations`, `ANNOTATIONS`)',
      async (dir) => {
        const ref = await expectAnnotated(await convertSheet(join(dir, '0'), annotated()));
        for (const marker of ['Annotations', 'ANNOTATIONS']) {
          const xml = await expectAnnotated(
            await convertSheet(join(dir, marker), annotated(marker)),
          );
          expect(xml).toBe(ref);
        }
      },
    );

    const twoNotes = () =>
      w0(
        [{ marker: 'annotations' }, { marker: 'annotations' }],
        [
          ['a', 'b'],
          [null, 'only-e'],
        ],
      );

    scenario('CAMUNDA7-138', 'Multiple annotation columns are joined with `|`', async (dir) => {
      const { table } = await expectDmn(await convertSheet(dir, twoNotes()));
      expect(table.rule.map((r) => r.description)).toEqual(['a | b', 'only-e']);
    });

    scenario('CAMUNDA7-139', 'Custom annotation separator', async (dir) => {
      const r = await convertSheet(dir, twoNotes(), {
        config: { markers: { annotationSeparator: '; ' } },
      });
      const { table } = await expectDmn(r);
      expect(table.rule[0].description).toBe('a; b');
    });

    scenario(
      'CAMUNDA7-140',
      'Annotation text is free text: not FEEL-checked, not quoted, escaped in XML',
      async (dir) => {
        const text = 'unquoted words & "quotes" <tag> [1..';
        const { xml, table } = await expectDmn(
          await convertSheet(dir, annotated('annotations', `${text} `)),
        );
        expect(table.rule[0].description).toBe(text);
        expect(xml).toContain('&amp;');
        expect(xml).toMatch(/&lt;tag(>|&gt;)/);
      },
    );

    scenario('CAMUNDA7-141', 'Annotation-only row ends the table', async (dir) => {
      const rows = setCells(annotated(), {
        D7: 'orphan note',
        B8: '< 0',
        C8: '"NEG"',
        D8: 'late',
      });
      const { xml, table } = await expectDmn(await convertSheet(dir, rows));
      expect(table.rule).toHaveLength(2);
      expect(xml).not.toContain('orphan note');
      expect(xml).not.toContain('NEG');
    });

    scenario('CAMUNDA7-142', 'Annotation header rows (M+1..M+3) are ignored', async (dir) => {
      const rows = w0(
        [{ marker: 'annotations', name: 'noteName', type: 'string', label: 'Comment' }],
        [['n'], [null]],
      );
      const { xml } = await expectDmn(await convertSheet(dir, rows));
      expect(xml).not.toContain('noteName');
      expect(xml).not.toContain('Comment');
      expect(tags(xml, 'output')).toHaveLength(1);
    });

    scenario('CAMUNDA7-143', 'Whitespace-only annotation means no description', async (dir) => {
      const { xml, table } = await expectDmn(
        await convertSheet(dir, annotated('annotations', '   ')),
      );
      expect(table.rule[0].description).toBeUndefined();
      expect(xml).not.toContain('<description');
    });
  });

  describe('11. Helper and ignored columns', () => {
    scenario('CAMUNDA7-144', 'Blank-marker helper column is ignored entirely', async (dir) => {
      const rows = decisionSheet(
        [
          W0_COLS[0],
          W0_COLS[1],
          { marker: null, name: 'helperName', type: 'helperType', label: 'HelperLabel' },
          W0_COLS[2],
        ],
        [
          [null, '< 10', 'junk', '"LOW"'],
          [null, '>= 10', '[1..', '"HIGH"'],
          [null, '>= 99', '"x"', '"TOP"'],
        ],
      );
      const { xml, table } = await expectDmn(await convertSheet(dir, rows));
      expect(table.input).toHaveLength(1);
      expect(table.output).toHaveLength(1);
      for (const s of ['junk', '[1..', '"x"', 'helperName', 'helperType', 'HelperLabel'])
        expect(xml).not.toContain(s);
    });

    scenario(
      'CAMUNDA7-145',
      'Arbitrary marker text (`NOT PART OF DMN`, `No.`, `Notes`) makes a helper column',
      async (dir) => {
        const ref = await w0Bytes(dir);
        const rows = w0(
          [{ marker: 'NOT PART OF DMN' }, { marker: 'No.' }, { marker: 'Notes', name: 'n' }],
          [
            ['x', '1', 'some note'],
            ['[1..', '2', 'other'],
          ],
        );
        const { xml } = await expectDmn(await convertSheet(dir, rows));
        expect(xml).toBe(ref);
      },
    );

    scenario('CAMUNDA7-146', 'Legacy `DMN_X` rule-number column is a helper', async (dir) => {
      const ref = await w0Bytes(dir);
      const rows = decisionSheet(
        [{ marker: null }, ...W0_COLS],
        [
          ['DMN_1', ...W0_RULES[0]],
          ['DMN_2', ...W0_RULES[1]],
        ],
      );
      const { xml, table } = await expectDmn(await convertSheet(dir, rows));
      expect(xml).toBe(ref);
      expect(table.rule.map((r) => r.id)).toEqual(['rule_1', 'rule_2']);
    });

    scenario(
      'CAMUNDA7-147',
      'Data in a helper column alone does not make a row a rule',
      async (dir) => {
        const rows = setCells(w0([{ marker: null }, { marker: 'Notes' }]), {
          E7: 'note',
          B8: '< 0',
          C8: '"NEG"',
        });
        const { table } = await expectDmn(await convertSheet(dir, rows));
        expect(table.rule).toHaveLength(2);
      },
    );

    scenario(
      'CAMUNDA7-148',
      'Marker cell containing the keyword inside other text is a helper',
      async (dir) => {
        const rows = w0(
          [
            { marker: 'input data', name: 'x', type: 'integer' },
            { marker: 'output (old)', name: 'y', type: 'string' },
          ],
          [
            ['1', '"a"'],
            ['2', '"b"'],
          ],
        );
        const { table } = await expectDmn(await convertSheet(dir, rows));
        expect(table.input.map((i) => i.id)).toEqual(['amount']);
        expect(table.output.map((o) => o.id)).toEqual(['result']);
      },
    );
  });

  describe('12. Header discovery', () => {
    const shiftDown = (n, rows) => [...Array.from({ length: n }, () => []), ...rows];

    scenario('CAMUNDA7-149', 'Marker row on row 3 (banner rows above)', async (dir) => {
      const ref = await w0Bytes(dir);
      const rows = [['Shipping rules'], [], ...w0()];
      const { xml } = await expectDmn(await convertSheet(dir, rows));
      expect(xml).toBe(ref);
    });

    scenario('CAMUNDA7-150', 'Marker row on row 5 (last scanned row)', async (dir) => {
      const ref = await w0Bytes(dir);
      const { xml } = await expectDmn(await convertSheet(dir, shiftDown(4, w0())));
      expect(xml).toBe(ref);
    });

    scenario('CAMUNDA7-151', 'Marker row on row 6 is not found by default', async (dir) => {
      const r = await convertSheet(dir, shiftDown(5, w0()));
      expectFailure(r, 'Base DMN', /marker/i, '5');
    });

    scenario('CAMUNDA7-152', '`header.scanRows` extends the search', async (dir) => {
      const ref = await w0Bytes(dir);
      const r = await convertSheet(dir, shiftDown(5, w0()), {
        config: { header: { scanRows: 10 } },
      });
      const { xml } = await expectDmn(r);
      expect(xml).toBe(ref);
    });

    scenario(
      'CAMUNDA7-153',
      'Table starting in a later column (leading blank columns)',
      async (dir) => {
        const ref = await w0Bytes(dir);
        const shifted = w0().map((row) => [null, null, ...row]);
        const { xml } = await expectDmn(await convertSheet(join(dir, 'ok'), shifted));
        expect(xml).toBe(ref);
        const bad = await convertSheet(join(dir, 'bad'), setCells(shifted, { D5: '"5"' }));
        expectFailure(bad, 'Base DMN!D5');
      },
    );

    scenario(
      'CAMUNDA7-154',
      'The first row with an input/output marker wins, even if an earlier row has `id`',
      async (dir) => {
        const rows = [['id'], ...w0()];
        const { decision, table } = await expectDmn(await convertSheet(dir, rows));
        expect(decision.id).toBe('BASE');
        expect(table.input[0].id).toBe('amount');
        expect(inputTexts(table)).toEqual(['< 10', '>= 10']);
      },
    );

    scenario('CAMUNDA7-155', 'Markers are case-insensitive and trimmed', async (dir) => {
      const ref = await w0Bytes(dir);
      const rows = setCells(w0(), { A1: ' ID ', B1: 'INPUT', C1: 'Output ' });
      const { xml } = await expectDmn(await convertSheet(dir, rows));
      expect(xml).toBe(ref);
    });

    scenario(
      'CAMUNDA7-156',
      '`markers.caseInsensitive: false` makes markers case-sensitive',
      async (dir) => {
        const r = await convertSheet(dir, setCells(w0(), { B1: 'INPUT' }), {
          config: { markers: { caseInsensitive: false } },
        });
        const { table } = await expectDmn(r);
        expect(table.input ?? []).toHaveLength(0);
        expect(table.output).toHaveLength(1);
        expect(r.stderr).toMatch(/input/i);
      },
    );

    scenario('CAMUNDA7-157', 'Renamed marker keywords via config', async (dir) => {
      const ref = await w0Bytes(dir);
      const rows = setCells(w0(), { A1: 'KEY', B1: 'in', C1: 'out' });
      const r = await convertSheet(dir, rows, {
        config: { markers: { id: 'KEY', input: 'in', output: 'out' } },
      });
      const { xml } = await expectDmn(r);
      expect(xml).toBe(ref);
    });

    scenario('CAMUNDA7-158', 'Relocated header rows via offsets', async (dir) => {
      const ref = await w0Bytes(dir);
      const rows = [
        ['id', 'input', 'output'],
        [null, 'integer', 'string'],
        ['BASE', 'amount', 'result'],
        [null, 'Amount', 'Result'],
        ...W0_RULES,
      ];
      const r = await convertSheet(dir, rows, {
        config: { header: { nameOffset: 2, typeOffset: 1 } },
      });
      const { xml } = await expectDmn(r);
      expect(xml).toBe(ref);
    });
  });

  describe('13. Rule detection', () => {
    scenario(
      'CAMUNDA7-159',
      'Rules stop at the first fully empty input/output row',
      async (dir) => {
        const rows = setCells(w0(), { B8: '< 0', C8: '"NEG"' });
        const { xml, table } = await expectDmn(await convertSheet(dir, rows));
        expect(table.rule).toHaveLength(2);
        expect(xml).not.toContain('NEG');
      },
    );

    scenario('CAMUNDA7-160', 'A row with only an output filled is a rule', async (dir) => {
      const { table } = await expectDmn(
        await convertSheet(dir, setCells(w0(), { C7: '"DEFAULT"' })),
      );
      expect(table.rule).toHaveLength(3);
      expect(table.rule[2].inputEntry[0].text ?? '').toBe('');
      expect(table.rule[2].outputEntry[0].text).toBe('"DEFAULT"');
    });

    scenario(
      'CAMUNDA7-161',
      'A row with only an input filled is a rule with an empty output',
      async (dir) => {
        const { xml, table } = await expectDmn(
          await convertSheet(dir, setCells(w0(), { B7: '100' })),
        );
        expect(table.rule).toHaveLength(3);
        expect(xml).toMatch(emptyEntry('outputEntry', 'result_3'));
      },
    );

    scenario(
      'CAMUNDA7-162',
      'A row whose input is `-` and output empty is still a rule',
      async (dir) => {
        const { xml, table } = await expectDmn(
          await convertSheet(dir, setCells(w0(), { B7: '-' })),
        );
        expect(table.rule).toHaveLength(3);
        expect(xml).toMatch(emptyEntry('inputEntry', 'amount_3'));
        expect(xml).toMatch(emptyEntry('outputEntry', 'result_3'));
      },
    );

    scenario('CAMUNDA7-163', 'No rules at all is an error', async (dir) => {
      const r = await convertSheet(dir, decisionSheet(W0_COLS, []));
      expectFailure(r, /no rules found/i, 'Base DMN');
    });

    scenario('CAMUNDA7-164', 'Many rules keep order and sequential ids', async (dir) => {
      const rules = Array.from({ length: 50 }, (_, i) => [null, `= ${i + 1}`, `"R${i + 1}"`]);
      const { table } = await expectDmn(await convertSheet(dir, decisionSheet(W0_COLS, rules)));
      expect(table.rule.map((r) => r.id)).toEqual(rules.map((_, i) => `rule_${i + 1}`));
      expect(outputTexts(table)).toEqual(rules.map((r) => r[2]));
      expect(table.rule[49].inputEntry[0].id).toBe('amount_50');
      expect(table.rule[49].inputEntry[0].text).toBe('= 50');
    });
  });

  describe('14. Decision identity', () => {
    scenario('CAMUNDA7-165', 'Decision name falls back to the raw id value', async (dir) => {
      const r = await convertSheet(dir, setCells(w0(), { A2: 'Shipping rates' }));
      expect(listFiles(r.out)).toEqual(['SHIPPING_RATES.dmn']);
      const { definitions, decision } = await expectDmn(r, 'SHIPPING_RATES');
      expect(decision.id).toBe('SHIPPING_RATES');
      expect(decision.name).toBe('Shipping rates');
      expect(definitions.name).toBe('Shipping rates');
    });

    scenario('CAMUNDA7-166', '`name` column sets the display name verbatim', async (dir) => {
      const rows = w0([{ marker: 'name', name: ' Shipping Rate Decision (v2)' }]);
      const { definitions, decision } = await expectDmn(await convertSheet(dir, rows));
      expect(decision.id).toBe('BASE');
      expect(decision.name).toBe('Shipping Rate Decision (v2)');
      expect(definitions.name).toBe('Shipping Rate Decision (v2)');
    });

    scenario(
      'CAMUNDA7-167',
      'id sanitization: diacritics, fold map, punctuation, leading digit (one run each)',
      async (dir) => {
        const cases = [
          ['Zürich Süd', 'ZURICH_SUD'],
          ['Straße łódź', 'STRASSE_LODZ'],
          ['rates-v2.final', 'RATES_V2_FINAL'],
          ['2024 rates', '_2024_RATES'],
          ['__a  b__', 'A_B'],
        ];
        for (const [i, [raw, id]] of cases.entries()) {
          const r = await convertSheet(join(dir, String(i)), setCells(w0(), { A2: raw }));
          expect(dmnFiles(r.out), raw).toEqual([`${id}.dmn`]);
          const { xml, definitions, decision } = await expectDmn(r, id);
          expect(decision.id).toBe(id);
          expect(definitions.id).toBe(`definitions_${id}`);
          expect(tag(xml, 'dmndi:DMNShape').id).toBe(`DMNShape_${id}`);
        }
      },
    );

    scenario('CAMUNDA7-168', '`identity.idCase: "preserve"` keeps the case', async (dir) => {
      const r = await convertSheet(dir, setCells(w0(), { A2: 'ShippingRates' }), {
        config: { identity: { idCase: 'preserve' } },
      });
      expect(dmnFiles(r.out)).toEqual(['ShippingRates.dmn']);
      const { decision } = await expectDmn(r, 'ShippingRates');
      expect(decision.id).toBe('ShippingRates');
    });

    scenario(
      'CAMUNDA7-169',
      'Missing id column, empty id value, two id columns, two name columns (one run each)',
      async (dir) => {
        const noId = decisionSheet(
          W0_COLS.slice(1),
          W0_RULES.map((r) => r.slice(1)),
        );
        expectFailure(
          await convertSheet(join(dir, 'a'), noId),
          /missing required id marker column/i,
          'Base DMN',
        );
        expectFailure(
          await convertSheet(join(dir, 'b'), setCells(w0(), { A2: null })),
          'Base DMN!A2',
        );
        expectFailure(
          await convertSheet(join(dir, 'c'), w0([{ marker: 'id', name: 'OTHER' }])),
          /more than one/i,
          'Base DMN!D1',
        );
        expectFailure(
          await convertSheet(
            join(dir, 'd'),
            w0([
              { marker: 'name', name: 'One' },
              { marker: 'name', name: 'Two' },
            ]),
          ),
          /more than one/i,
          'Base DMN!E1',
        );
      },
    );
  });

  describe('15. Header validation and structure', () => {
    scenario('CAMUNDA7-170', 'Zero input columns warns but converts', async (dir) => {
      const rows = decisionSheet(
        [W0_COLS[0], W0_COLS[2]],
        [
          [null, '"A"'],
          [null, '"B"'],
        ],
      );
      const r = await convertSheet(dir, rows);
      const { xml, table } = await expectDmn(r);
      expect(xml).not.toContain('<input ');
      expect(table.input ?? []).toHaveLength(0);
      expect(table.rule).toHaveLength(2);
      expect(table.rule.map((x) => x.inputEntry ?? [])).toEqual([[], []]);
      expect(outputTexts(table)).toEqual(['"A"', '"B"']);
      expect(r.stderr).toMatch(/input/i);
    });

    scenario('CAMUNDA7-171', 'No output column is an error', async (dir) => {
      const rows = decisionSheet(
        W0_COLS.slice(0, 2),
        W0_RULES.map((r) => r.slice(0, 2)),
      );
      expectFailure(await convertSheet(dir, rows), /no output column/i, 'Base DMN');
    });

    scenario('CAMUNDA7-172', 'Missing technical name', async (dir) => {
      const r = await convertSheet(dir, setCells(w0(), { B2: null }));
      expectFailure(r, 'Base DMN!B2', /missing technical name for input/i);
    });

    scenario('CAMUNDA7-173', 'Missing typeRef', async (dir) => {
      const r = await convertSheet(dir, setCells(w0(), { C3: null }));
      expectFailure(r, 'Base DMN!C3', /missing typeRef/i, 'result');
    });

    scenario('CAMUNDA7-174', 'All header problems are reported in one pass', async (dir) => {
      const rows = setCells(w0([{ marker: 'input', name: 'x', type: 'text' }], [['-'], ['-']]), {
        B2: null,
        C3: null,
      });
      expectFailure(await convertSheet(dir, rows), 'Base DMN!B2', 'Base DMN!C3', 'Base DMN!D3');
    });

    scenario(
      'CAMUNDA7-175',
      'Missing label is allowed and the attribute is omitted',
      async (dir) => {
        const { xml } = await expectDmn(
          await convertSheet(dir, setCells(w0(), { B4: null, C4: null })),
        );
        expect(tags(xml, 'input')).toEqual([{ id: 'amount' }]);
        expect(tags(xml, 'output')).toEqual([{ id: 'result', name: 'result', typeRef: 'string' }]);
        expect(xml).not.toContain('label=');
      },
    );
  });

  describe('16. Multiple inputs and outputs', () => {
    scenario('CAMUNDA7-176', 'Several inputs and outputs keep left-to-right order', async (dir) => {
      const rows = decisionSheet(
        [
          { marker: 'id', name: 'MULTI' },
          { marker: 'input', name: 'orderTotal', type: 'double' },
          { marker: 'output', name: 'shippingMethod', type: 'string' },
          { marker: 'input', name: 'region', type: 'string' },
          { marker: null },
          { marker: 'input', name: 'isMember', type: 'boolean' },
          { marker: 'output', name: 'deliveryDays', type: 'integer' },
          { marker: 'input', name: 'tags', type: 'Any' },
        ],
        [
          [null, '< 50', '"STANDARD"', '"EU"', 'h', 'false', '5', '-'],
          [null, '>= 50', '"EXPRESS"', '"US"', 'h', 'true', '2', '"fragile"'],
        ],
      );
      const { table } = await expectDmn(await convertSheet(dir, rows), 'MULTI');
      const ins = ['orderTotal', 'region', 'isMember', 'tags'];
      const outs = ['shippingMethod', 'deliveryDays'];
      expect(table.input.map((i) => i.id)).toEqual(ins);
      expect(table.output.map((o) => o.id)).toEqual(outs);
      for (const [n, rule] of table.rule.entries()) {
        expect(rule.inputEntry.map((e) => e.id)).toEqual(ins.map((x) => `${x}_${n + 1}`));
        expect(rule.outputEntry.map((e) => e.id)).toEqual(outs.map((x) => `${x}_${n + 1}`));
      }
      expect(table.rule[0].inputEntry.map((e) => e.text ?? '')).toEqual([
        '< 50',
        '"EU"',
        'false',
        '',
      ]);
      expect(table.rule[1].outputEntry.map((e) => e.text)).toEqual(['"EXPRESS"', '2']);
    });

    scenario('CAMUNDA7-177', 'Spec reference example (shipping rates) end to end', async (dir) => {
      const rows = decisionSheet(
        [
          { marker: 'policy', name: 'UNIQUE' },
          { marker: 'ID', name: 'SHIPPING_RATES' },
          { marker: 'name', name: 'Shipping Rate Decision' },
          { marker: 'No.' },
          { marker: 'input', name: 'orderTotal', type: 'double', label: 'Order total' },
          { marker: 'input', name: 'region', type: 'string', label: 'Region' },
          { marker: 'input', name: 'isMember', type: 'boolean', label: 'Member' },
          { marker: 'input', name: 'weightKg', type: 'double', label: 'Weight (kg)' },
          { marker: 'input', name: 'tags', type: 'Any', label: 'Tags' },
          { marker: 'output', name: 'shippingMethod', type: 'string', label: 'Shipping method' },
          { marker: 'output', name: 'deliveryDays', type: 'integer', label: 'Delivery days' },
          { marker: 'annotations', label: 'Comment' },
          { marker: 'NOT PART OF DMN', name: 'Internal code' },
        ],
        [
          [
            null,
            null,
            null,
            1,
            '< 50',
            '"EU"',
            'false',
            '<= 5',
            '-',
            '"STANDARD"',
            '5',
            'standard EU parcel',
            'X1',
          ],
          [
            null,
            null,
            null,
            2,
            '>= 50',
            '"US"',
            'true',
            '> 5',
            '-',
            '"EXPRESS"',
            '2',
            'US ground',
            'X2',
          ],
        ],
      );
      const r = await convertBook(
        dir,
        { 'Shipping Rates_ DMN': rows },
        { file: 'shipping_rates_DMN.xlsx' },
      );
      expect(listFiles(r.out)).toEqual(['SHIPPING_RATES.dmn']);
      const { xml, decision, table } = await expectDmn(r, 'SHIPPING_RATES');
      expect(decision.name).toBe('Shipping Rate Decision');
      expect(tag(xml, 'decision')['camunda:historyTimeToLive']).toBe('P180D');
      expect(tag(xml, 'decisionTable')).not.toHaveProperty('hitPolicy');
      expect(xml).toMatch(/<rule id="rule_1">\s*<description>standard EU parcel<\/description>/);
      const r1 = table.rule[0];
      expect(r1.inputEntry.map((e) => e.text ?? '')).toEqual(['< 50', '"EU"', 'false', '<= 5', '']);
      expect(r1.outputEntry.map((e) => e.text)).toEqual(['"STANDARD"', '5']);
      expect(xml).toContain('&lt; 50');
      expect(xml).toContain('&lt;= 5');
      expect(tag(xml, 'inputExpression', 'tags_expression')).not.toHaveProperty('typeRef');
      for (const s of ['X1', 'Internal code', 'No.']) expect(xml).not.toContain(s);
    });

    /** Either a header error naming `cell`, or a DMN whose ids are all unique. */
    async function expectNoDuplicateIds(r, cell) {
      if (r.code !== 0) {
        expectFailure(r, cell);
        return;
      }
      const { xml } = await loadDmn(join(r.out, 'BASE.dmn'));
      const ids = [...xml.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
      expect(ids.length).toBe(new Set(ids).size);
    }

    scenario('CAMUNDA7-178', 'Duplicate technical names among inputs', async (dir) => {
      const rows = w0([{ marker: 'input', name: 'amount', type: 'integer' }], [['1'], ['2']]);
      await expectNoDuplicateIds(await convertSheet(dir, rows), 'Base DMN!D2');
    });

    scenario('CAMUNDA7-179', 'Input name colliding with an output name', async (dir) => {
      const rows = w0([{ marker: 'input', name: 'result', type: 'integer' }], [['1'], ['2']]);
      await expectNoDuplicateIds(await convertSheet(dir, rows), 'Base DMN!D2');
    });
  });

  describe('17. CLI output modes and files', () => {
    const twoSheets = (bRows = w0()) => ({
      'A DMN': setCells(w0(), { A2: 'A' }),
      'B DMN': setCells(bRows, { A2: 'B' }),
    });

    scenario(
      'CAMUNDA7-180',
      'Default output directory is beside the input workbook',
      async (dir) => {
        const r = await convertSheet(dir, w0(), { file: 'in/base_DMN.xlsx', outDir: null });
        expect(r.code, r.stderr).toBe(0);
        await loadDmn(join(dir, 'in', 'BASE.dmn'));
        expect(dmnFiles(dir)).toEqual([]);
      },
    );

    scenario('CAMUNDA7-181', '`-o` writes a single-sheet result to a named file', async (dir) => {
      const r = await convertSheet(dir, w0(), {
        outDir: null,
        args: ['-o', 'out/custom-name.dmn'],
      });
      expect(r.code, r.stderr).toBe(0);
      const { decision, table } = await loadDmn(join(dir, 'out', 'custom-name.dmn'));
      expect(decision.id).toBe('BASE');
      expect(table.rule).toHaveLength(2);
      expect(dmnFiles(join(dir, 'out'))).toEqual(['custom-name.dmn']);
      expect(dmnFiles(dir)).toEqual([]);
    });

    scenario('CAMUNDA7-182', '`-o` with two DMN sheets is an error', async (dir) => {
      const r = await convertBook(dir, twoSheets(), {
        file: 'book.xlsx',
        outDir: null,
        args: ['-o', 'out/x.dmn'],
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/--out/);
      expect(r.stderr).toMatch(/single/i);
      expect(dmnFiles(dir)).toEqual([]);
      expect(dmnFiles(join(dir, 'out'))).toEqual([]);
    });

    scenario('CAMUNDA7-183', '`-j/--json` writes the intermediate model', async (dir) => {
      const r = await convertSheet(dir, w0(), { args: ['--json'] });
      await expectDmn(r);
      const model = JSON.parse(readText(join(r.out, 'BASE.model.json')));
      expect(model).toMatchObject({
        definitions: { id: 'definitions_BASE', name: 'BASE', namespace: CAMUNDA_NS },
        decisions: [
          {
            id: 'BASE',
            name: 'BASE',
            hitPolicy: 'UNIQUE',
            aggregation: null,
            inputs: [
              { expression: 'amount', typeRef: 'integer', label: 'Amount', allowedValues: null },
            ],
            outputs: [{ name: 'result', typeRef: 'string', label: 'Result', allowedValues: null }],
            rules: [
              { id: 'rule_1', row: 5, inputEntries: ['< 10'], outputEntries: ['"LOW"'] },
              { id: 'rule_2', row: 6, inputEntries: ['>= 10'], outputEntries: ['"HIGH"'] },
            ],
          },
        ],
      });
      expect(Object.keys(model).some((k) => k.startsWith('__'))).toBe(false);
      const d = model.decisions[0];
      expect(d.inputs[0]).not.toHaveProperty('id');
      expect(d.outputs[0]).not.toHaveProperty('id');
      expect(JSON.stringify(model)).not.toMatch(/"__/);
    });

    scenario(
      'CAMUNDA7-184',
      '`output.writeModelJson: true` writes JSON without the flag',
      async (dir) => {
        const r = await convertSheet(dir, w0(), { config: { output: { writeModelJson: true } } });
        await expectDmn(r);
        expect(existsSync(join(r.out, 'BASE.model.json'))).toBe(true);
      },
    );

    scenario('CAMUNDA7-185', '`output.fileNameTemplate: "<sheetName>.dmn"`', async (dir) => {
      const r = await convertSheet(dir, w0(), {
        config: { output: { fileNameTemplate: '<sheetName>.dmn' } },
      });
      expect(r.code, r.stderr).toBe(0);
      expect(listFiles(r.out)).toEqual(['Base DMN.dmn']);
      await loadDmn(join(r.out, 'Base DMN.dmn'));
    });

    scenario(
      'CAMUNDA7-186',
      '`--validate-only` writes nothing and reports success',
      async (dir) => {
        const r = await convertSheet(dir, w0(), { args: ['--validate-only'] });
        expect(r.code, r.stderr).toBe(0);
        expect(existsSync(r.out) ? listFiles(r.out) : []).toEqual([]);
        expect(r.stdout).toContain('Base DMN');
        expect(r.stdout).toContain('BASE');
        expect(r.stdout).toMatch(/valid/i);
      },
    );

    scenario('CAMUNDA7-187', '`--validate-only` fails on an invalid workbook', async (dir) => {
      const r = await convertSheet(dir, setCells(w0(), { B5: '"5"' }), {
        args: ['--validate-only'],
      });
      expectFailure(r, 'Base DMN!B5');
      expect(existsSync(r.out) ? listFiles(r.out) : []).toEqual([]);
    });

    scenario(
      'CAMUNDA7-188',
      '`--no-pretty` / `output.format: false` emits unformatted XML',
      async (dir) => {
        await writeBook(dir, { 'Base DMN': w0() });
        const pretty = await expectDmn(runConvert(dir, { outDir: 'pretty' }));
        const runs = [
          runConvert(dir, { outDir: 'flag', args: ['--no-pretty'] }),
          runConvert(dir, { outDir: 'cfg', config: { output: { format: false } } }),
        ];
        for (const r of runs) {
          const flat = await expectDmn(r);
          const body = flat.xml.replace(/^<\?xml[^>]*\?>\s*/, '');
          expect(body).not.toMatch(/>\s*\n\s*</);
          expect(summarize(flat)).toEqual(summarize(pretty));
        }
      },
    );

    scenario('CAMUNDA7-189', 'Workbook without any DMN sheet', async (dir) => {
      const r = await convertBook(dir, { Rates: w0() }, { file: 'rates.xlsx' });
      expectFailure(r, /no sheet/i, 'DMN');
    });

    scenario('CAMUNDA7-190', 'Non-DMN sheets are ignored', async (dir) => {
      const r = await convertBook(dir, {
        'Base DMN': w0(),
        Notes: [['input', 'output'], ['garbage', '[1..'], [], [], ['x', 'y']],
      });
      await expectDmn(r);
      expect(listFiles(r.out)).toEqual(['BASE.dmn']);
    });

    scenario('CAMUNDA7-191', 'Sheet-name match is a case-insensitive substring', async (dir) => {
      const r = await convertBook(dir, { rates_dmn: w0() });
      await expectDmn(r);
      expect(listFiles(r.out)).toEqual(['BASE.dmn']);
    });

    scenario('CAMUNDA7-192', '`--sheet` restricts conversion', async (dir) => {
      const r = await convertBook(dir, twoSheets(), {
        file: 'book.xlsx',
        args: ['--sheet', 'B DMN'],
      });
      await expectDmn(r, 'B');
      expect(listFiles(r.out)).toEqual(['B.dmn']);
    });

    scenario('CAMUNDA7-193', 'Two DMN sheets give two files', async (dir) => {
      const r = await convertBook(dir, twoSheets(), { file: 'book.xlsx' });
      expect(r.code, r.stderr).toBe(0);
      expect(listFiles(r.out)).toEqual(['A.dmn', 'B.dmn']);
      expect((await loadDmn(join(r.out, 'A.dmn'))).definitions.id).toBe('definitions_A');
      expect((await loadDmn(join(r.out, 'B.dmn'))).definitions.id).toBe('definitions_B');
    });

    scenario(
      'CAMUNDA7-194',
      'One invalid sheet does not block a valid sibling, but the exit is non-zero',
      async (dir) => {
        const r = await convertBook(dir, twoSheets(setCells(w0(), { B5: '"5"' })), {
          file: 'book.xlsx',
        });
        expect(r.code).toBe(1);
        expect(dmnFiles(r.out)).toEqual(['A.dmn']);
        await loadDmn(join(r.out, 'A.dmn'));
        expect(r.stderr).toContain('B DMN');
        expect(r.stderr).toContain('B DMN!B5');
      },
    );

    scenario('CAMUNDA7-195', 'Duplicate decision id across two sheets', async (dir) => {
      const r = await convertBook(
        dir,
        { 'A DMN': setCells(w0(), { A2: 'SAME' }), 'B DMN': setCells(w0(), { A2: 'SAME' }) },
        { file: 'book.xlsx' },
      );
      expect(r.code, r.stdout).toBe(1);
      expect(r.stderr).toContain('SAME');
      expect(r.stderr).toContain('A DMN');
      expect(r.stderr).toContain('B DMN');
      expect(dmnFiles(r.out).filter((f) => f.startsWith('SAME'))).toHaveLength(0);
    });

    scenario(
      'CAMUNDA7-196',
      'Config auto-loaded from `excel2dmn.config.json` in cwd',
      async (dir) => {
        writeFileSync(
          join(dir, 'excel2dmn.config.json'),
          JSON.stringify({ camunda: { versionTag: '7.0' } }),
        );
        const { xml } = await expectDmn(await convertSheet(dir, w0()));
        expect(tag(xml, 'decision')['camunda:versionTag']).toBe('7.0');
      },
    );

    scenario('CAMUNDA7-197', '`--config` beats the cwd config file', async (dir) => {
      writeFileSync(
        join(dir, 'excel2dmn.config.json'),
        JSON.stringify({ camunda: { versionTag: '7.0' } }),
      );
      const r = await convertSheet(dir, w0(), { config: { camunda: { versionTag: '9.9' } } });
      const { xml } = await expectDmn(r);
      expect(tag(xml, 'decision')['camunda:versionTag']).toBe('9.9');
    });

    scenario('CAMUNDA7-198', 'Empty config file `{}` works out of the box', async (dir) => {
      const ref = await w0Bytes(dir);
      const { xml } = await expectDmn(await convertSheet(dir, w0(), { config: {} }));
      expect(xml).toBe(ref);
    });

    scenario('CAMUNDA7-199', 'Malformed config JSON fails clearly', async (dir) => {
      const r = await convertSheet(dir, w0(), { config: '{ not json' });
      expectFailure(r, CFG);
      expect(r.stderr).toMatch(/json|parse|token|expected/i);
    });

    scenario('CAMUNDA7-200', 'Missing input workbook', async (dir) => {
      const r = runConvert(dir, { file: 'missing_DMN.xlsx' });
      expectFailure(r, 'missing_DMN.xlsx');
      expect(r.stderr).not.toMatch(/^\s+at /m);
    });

    scenario(
      'CAMUNDA7-201',
      'Conversion errors exit non-zero without a stack trace',
      async (dir) => {
        const r = await convertSheet(dir, setCells(w0(), { B5: '"5"' }));
        expectFailure(r, 'Base DMN!B5', 'amount');
        expect(r.stderr).not.toMatch(/^\s+at .*:\d+/m);
      },
    );
  });

  describe('17b. Programmatic API (Camunda 7 default)', () => {
    scenario(
      'CAMUNDA7-202',
      '`convert()` returns results with paths and no problems',
      async (dir) => {
        const xlsx = await writeBook(dir, { 'Base DMN': w0() });
        const outDir = join(dir, 'out');
        const { results, problems } = await convert(xlsx, {
          config: loadConfig({ cwd: dir, overrides: { output: { outDir } } }),
        });
        expect(problems).toEqual([]);
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ sheet: 'Base DMN', decisionId: 'BASE' });
        expect(results[0].path.endsWith('BASE.dmn')).toBe(true);
        expect(results[0].xml).toBe(readText(results[0].path));
        await parseDmn(results[0].xml);
      },
    );

    scenario('CAMUNDA7-203', '`parseWorkbook` + `buildDmn` equals CLI output', async (dir) => {
      const ref = await w0Bytes(dir);
      const xlsx = await writeBook(dir, { 'Base DMN': w0() });
      const cfg = loadConfig({ cwd: dir });
      const [model] = await parseWorkbook(xlsx, cfg);
      const xml = await buildDmn(model, cfg);
      expect(xml).toBe(ref);
      await parseDmn(xml);
    });

    scenario('CAMUNDA7-204', '`loadConfig({})` defaults to camunda7 with P180D', async (dir) => {
      const cfg = loadConfig({ cwd: dir });
      expect(cfg.platform).toBe('camunda7');
      expect(cfg.camunda.historyTimeToLive).toBe('P180D');
      expect(cfg.camunda.versionTag).toBeNull();
      expect(cfg.types.nonCamundaTypeAction).toBe('error');
      expect(cfg.header.allowedValuesOffset).toBeNull();
      expect(cfg.rules.idTemplate).toBe('rule_<n>');
    });
  });
});
