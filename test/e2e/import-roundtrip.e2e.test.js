// End-to-end: DMN -> Excel import and xlsx -> dmn -> xlsx -> dmn round-trips (Camunda 7 and 8).
// One it() per scenario in test/e2e/scenarios/import-roundtrip.md; assertions follow the
// expected behavior there, not necessarily the current one.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
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
import {
  buildDmn,
  dmnToModels,
  importDmn,
  loadConfig,
  modelsToWorkbook,
  parseWorkbook,
} from '../../src/index.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

// --- workbook builders ------------------------------------------------------

/** W-C7 / W-C8 columns (A..I, or A..J for C8 with the extra `when` input). */
function feesCols({ c8 = false, policy = 'UNIQUE', aggregator } = {}) {
  return [
    { marker: 'policy', name: policy, type: aggregator },
    { marker: 'ID', name: 'FEES' },
    { marker: 'name', name: 'Fee Decision' },
    {
      marker: 'input',
      name: 'amount',
      type: c8 ? 'number' : 'integer',
      label: 'Amount',
      allowed: '[0..10000]',
    },
    { marker: 'input', name: 'region', type: 'string', label: 'Region', allowed: '"EU","US"' },
    { marker: 'input', name: 'tags', type: 'Any', label: 'Tags' },
    ...(c8 ? [{ marker: 'input', name: 'when', type: 'dateTime', label: 'When' }] : []),
    { marker: 'output', name: 'fee', type: c8 ? 'number' : 'double', label: 'Fee' },
    { marker: 'output', name: 'tier', type: 'string', label: 'Tier', allowed: '"LOW","HIGH"' },
    { marker: 'annotations' },
  ];
}

function feesRules({ c8 = false } = {}) {
  const when1 = c8 ? ['< date and time("2026-01-01T00:00:00")'] : [];
  const when2 = c8 ? [null] : [];
  return [
    [null, null, null, '< 100', '"EU"', '-', ...when1, '1.5', '"LOW"', 'small EU'],
    [null, null, null, '>= 100', null, '"vip"', ...when2, '0', '"HIGH"', null],
  ];
}

// Column indexes of W-C7 (C8 shifts fee/tier/annotations right by one).
const C7 = { policy: 0, id: 1, name: 2, amount: 3, region: 4, tags: 5, fee: 6, tier: 7, ann: 8 };

/** The rows of a W-C7/W-C8 sheet; `edit(cols, rules)` may mutate the fresh arrays first. */
function feesSheet({ c8, av = false, policy, aggregator, edit } = {}) {
  const cols = feesCols({ c8, policy, aggregator });
  const rules = feesRules({ c8 });
  if (edit) edit(cols, rules);
  return decisionSheet(cols, rules, { allowedValues: av });
}

/** Remove column `i` from both the column list and every rule row. */
function dropCol(cols, rules, i) {
  cols.splice(i, 1);
  rules.forEach((r) => r.splice(i, 1));
}

/** Insert a column at `i` with one value per rule row. */
function insertCol(cols, rules, i, col, values) {
  cols.splice(i, 0, col);
  rules.forEach((r, k) => r.splice(i, 0, values[k] ?? null));
}

/** W-SUM: COLLECT with an optional aggregator in the policy column's type row. */
function sumSheet(agg) {
  return decisionSheet(
    [
      { marker: 'policy', name: 'COLLECT', type: agg || null },
      { marker: 'ID', name: 'SURCHARGES' },
      { marker: 'input', name: 'amount', type: 'integer', label: 'Amount' },
      { marker: 'input', name: 'region', type: 'string', label: 'Region' },
      { marker: 'output', name: 'surcharge', type: 'double', label: 'Surcharge' },
    ],
    [
      [null, null, '> 10', '"EU"', '2.5'],
      [null, null, '-', '"US"', '1'],
    ],
  );
}

/** W-PRIO (5-row layout). */
function prioSheet(policy) {
  return decisionSheet(
    [
      { marker: 'policy', name: policy },
      { marker: 'ID', name: 'RANKED' },
      { marker: 'input', name: 'score', type: 'integer', label: 'Score' },
      { marker: 'output', name: 'grade', type: 'string', label: 'Grade', allowed: '"A","B","C"' },
    ],
    [
      [null, null, '>= 90', '"A"'],
      [null, null, '>= 50', '"B"'],
      [null, null, '-', '"C"'],
    ],
    { allowedValues: true },
  );
}

/** C8 type fixture (as in the convert-C8 W-TYPES fixture). */
const C8_TYPE_INPUTS = [
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

/** A sheet with an ID column, the given typed inputs (one rule) and a string output `r`. */
function typesSheet(inputs, id = 'TYPES') {
  return decisionSheet(
    [
      { marker: 'ID', name: id },
      ...inputs.map(([name, type]) => ({ marker: 'input', name, type, label: name })),
      { marker: 'output', name: 'r', type: 'string', label: 'R' },
    ],
    [[null, ...inputs.map(([, , v]) => v), '"OK"']],
  );
}

// --- hand-written DMN inputs ----------------------------------------------------

const MODEL_NS = 'https://www.omg.org/spec/DMN/20191111/MODEL/';

const D_MODELER_C7 = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" xmlns:dmndi="https://www.omg.org/spec/DMN/20191111/DMNDI/" xmlns:dc="http://www.omg.org/spec/DMN/20180521/DC/" xmlns:camunda="http://camunda.org/schema/1.0/dmn" xmlns:modeler="http://camunda.org/schema/modeler/1.0" id="Definitions_0x1y2z" name="DRD" namespace="http://camunda.org/schema/1.0/dmn" exporter="Camunda Modeler" exporterVersion="5.28.0" modeler:executionPlatform="Camunda Platform" modeler:executionPlatformVersion="7.22.0">
  <decision id="Decision_0abc" name="Dish" camunda:historyTimeToLive="P30D" camunda:versionTag="2">
    <decisionTable id="DecisionTable_1k2" hitPolicy="FIRST">
      <input id="Input_1" label="Season">
        <inputExpression id="InputExpression_1" typeRef="string"><text>season</text></inputExpression>
      </input>
      <input id="InputClause_0g" label="Guests">
        <inputExpression id="LiteralExpression_0h" typeRef="integer"><text>guestCount</text></inputExpression>
      </input>
      <output id="Output_1" label="Dish" name="dish" typeRef="string" />
      <rule id="DecisionRule_1a">
        <description>winter feast</description>
        <inputEntry id="UnaryTests_1"><text>"Winter"</text></inputEntry>
        <inputEntry id="UnaryTests_2"><text>&lt;= 8</text></inputEntry>
        <outputEntry id="LiteralExpression_1"><text>"Roastbeef"</text></outputEntry>
      </rule>
      <rule id="DecisionRule_2b">
        <inputEntry id="UnaryTests_3"><text>"Summer"</text></inputEntry>
        <inputEntry id="UnaryTests_4"><text></text></inputEntry>
        <outputEntry id="LiteralExpression_2"><text>"Salad"</text></outputEntry>
      </rule>
    </decisionTable>
  </decision>
  <dmndi:DMNDI>
    <dmndi:DMNDiagram id="DMNDiagram_1">
      <dmndi:DMNShape id="DMNShape_1" dmnElementRef="Decision_0abc">
        <dc:Bounds height="80" width="180" x="160" y="100" />
      </dmndi:DMNShape>
    </dmndi:DMNDiagram>
  </dmndi:DMNDI>
</definitions>
`;

/** D-MODELER-C8, with knobs for the platform attributes, hit policy and output values. */
function modelerC8({
  platform = 'Camunda Cloud',
  version = '8.5.0',
  hitPolicy,
  outputValues,
} = {}) {
  const versionAttr = version ? ` modeler:executionPlatformVersion="${version}"` : '';
  const hp = hitPolicy ? ` hitPolicy="${hitPolicy}"` : '';
  const ov = outputValues ? `<outputValues><text>${outputValues}</text></outputValues>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="${MODEL_NS}" xmlns:modeler="http://camunda.org/schema/modeler/1.0" id="Definitions_1" name="Risk" namespace="http://camunda.org/schema/1.0/dmn" modeler:executionPlatform="${platform}"${versionAttr}>
  <decision id="Risk_1" name="Risk">
    <decisionTable id="DecisionTable_1"${hp}>
      <input id="Input_1" label="Age">
        <inputExpression id="InputExpression_1" typeRef="number"><text>age</text></inputExpression>
      </input>
      <input id="Input_2" label="Payload">
        <inputExpression id="InputExpression_2" typeRef="Any"><text>payload</text></inputExpression>
      </input>
      <input id="Input_3" label="Extra">
        <inputExpression id="InputExpression_3"><text>extra</text></inputExpression>
      </input>
      <output id="Output_1" label="Risk" name="risk" typeRef="string">${ov}</output>
      <rule id="Rule_1">
        <inputEntry id="UnaryTests_1"><text>&gt;= 18</text></inputEntry>
        <inputEntry id="UnaryTests_2"><text></text></inputEntry>
        <inputEntry id="UnaryTests_3"><text></text></inputEntry>
        <outputEntry id="LiteralExpression_1"><text>"LOW"</text></outputEntry>
      </rule>
      <rule id="Rule_2">
        <inputEntry id="UnaryTests_4"><text>&lt; 18</text></inputEntry>
        <inputEntry id="UnaryTests_5"><text>-</text></inputEntry>
        <inputEntry id="UnaryTests_6"><text></text></inputEntry>
        <outputEntry id="LiteralExpression_2"><text>"HIGH"</text></outputEntry>
      </rule>
    </decisionTable>
  </decision>
</definitions>
`;
}

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * D-BARE and variants. inputs: [{ text, typeRef?, label? }]; output: { name?, typeRef? };
 * rules: [{ in: [...], out: [...] }].
 */
function bareDmn({
  name,
  rootAttrs = '',
  inputs = [{ text: 'x' }],
  output = { name: 'y', typeRef: 'string' },
  rules = [{ in: ['1'], out: ['"one"'] }],
} = {}) {
  const attr = (k, v) => (v == null ? '' : ` ${k}="${xmlEscape(v)}"`);
  const ins = inputs
    .map(
      (i, k) =>
        `<input id="Input_${k + 1}"${attr('label', i.label)}><inputExpression id="InputExpression_${k + 1}"${attr('typeRef', i.typeRef)}><text>${xmlEscape(i.text)}</text></inputExpression></input>`,
    )
    .join('\n      ');
  const out = `<output id="Output_1"${attr('name', output.name)}${attr('typeRef', output.typeRef)} />`;
  const rs = rules
    .map(
      (r, k) =>
        `<rule id="Rule_${k + 1}">${r.in
          .map(
            (t, j) =>
              `<inputEntry id="In_${k + 1}_${j + 1}"><text>${xmlEscape(t)}</text></inputEntry>`,
          )
          .join('')}${r.out
          .map(
            (t, j) =>
              `<outputEntry id="Out_${k + 1}_${j + 1}"><text>${xmlEscape(t)}</text></outputEntry>`,
          )
          .join('')}</rule>`,
    )
    .join('\n      ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="${MODEL_NS}"${rootAttrs} id="defs" namespace="urn:x">
  <decision id="Bare"${attr('name', name)}>
    <decisionTable id="Table_1">
      ${ins}
      ${out}
      ${rs}
    </decisionTable>
  </decision>
</definitions>
`;
}

const C8_ROOT_ATTRS =
  ' xmlns:modeler="http://camunda.org/schema/modeler/1.0" modeler:executionPlatform="Camunda Cloud" modeler:executionPlatformVersion="8.6.0"';

const eligibilityDecision = (name = 'Eligibility') => `
  <decision id="Eligibility" name="${name}">
    <decisionTable id="Table_E">
      <input id="Input_E" label="Age"><inputExpression id="Expr_E" typeRef="integer"><text>age</text></inputExpression></input>
      <output id="Output_E" label="Eligible" name="eligible" typeRef="boolean" />
      <rule id="Rule_E1"><inputEntry id="E1i"><text>&gt;= 18</text></inputEntry><outputEntry id="E1o"><text>true</text></outputEntry></rule>
      <rule id="Rule_E2"><inputEntry id="E2i"><text>&lt; 18</text></inputEntry><outputEntry id="E2o"><text>false</text></outputEntry></rule>
    </decisionTable>
  </decision>`;

const offerDecision = (name = 'Offer') => `
  <decision id="Offer" name="${name}">
    <informationRequirement id="Req_1"><requiredDecision href="#Eligibility" /></informationRequirement>
    <decisionTable id="Table_O">
      <input id="Input_O" label="Eligible"><inputExpression id="Expr_O" typeRef="boolean"><text>eligible</text></inputExpression></input>
      <output id="Output_O" label="Offer" name="offer" typeRef="string" />
      <rule id="Rule_O1"><inputEntry id="O1i"><text>true</text></inputEntry><outputEntry id="O1o"><text>"GOLD"</text></outputEntry></rule>
      <rule id="Rule_O2"><inputEntry id="O2i"><text>false</text></inputEntry><outputEntry id="O2o"><text>"NONE"</text></outputEntry></rule>
    </decisionTable>
  </decision>`;

const greetingDecision = `
  <decision id="Greeting" name="Greeting">
    <variable name="Greeting" typeRef="string" />
    <literalExpression id="le1"><text>"hello"</text></literalExpression>
  </decision>`;

/** A DMN 1.3 <definitions> (C7 style, no modeler attributes) wrapping `body`. */
const defsDoc = (body, id = 'drd') => `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="${MODEL_NS}" xmlns:dmndi="https://www.omg.org/spec/DMN/20191111/DMNDI/" xmlns:dc="http://www.omg.org/spec/DMN/20180521/DC/" xmlns:di="http://www.omg.org/spec/DMN/20180521/DI/" id="${id}" name="DRD" namespace="http://camunda.org/schema/1.0/dmn">${body}
</definitions>
`;

/** D-MULTI: Eligibility + Offer (with a requirement), an inputData and a full DMNDI. */
const multiDmn = (names = ['Eligibility', 'Offer']) =>
  defsDoc(`${eligibilityDecision(names[0])}${offerDecision(names[1])}
  <inputData id="Applicant" name="Applicant" />
  <dmndi:DMNDI>
    <dmndi:DMNDiagram id="DMNDiagram_1">
      <dmndi:DMNShape id="Shape_E" dmnElementRef="Eligibility"><dc:Bounds height="80" width="180" x="100" y="300" /></dmndi:DMNShape>
      <dmndi:DMNShape id="Shape_O" dmnElementRef="Offer"><dc:Bounds height="80" width="180" x="100" y="100" /></dmndi:DMNShape>
      <dmndi:DMNShape id="Shape_A" dmnElementRef="Applicant"><dc:Bounds height="45" width="125" x="400" y="317" /></dmndi:DMNShape>
      <dmndi:DMNEdge id="Edge_1" dmnElementRef="Req_1"><di:waypoint x="190" y="300" /><di:waypoint x="190" y="180" /></dmndi:DMNEdge>
    </dmndi:DMNDiagram>
  </dmndi:DMNDI>`);

const D_LITERAL = defsDoc(greetingDecision, 'lit');
const D_MIXED = defsDoc(`${greetingDecision}${eligibilityDecision()}`, 'mixed');

// --- sheet readers --------------------------------------------------------------

/** Plain string of a cell value as read back by exceljs (rich text / formula aware). */
function str(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return String(v.result ?? '');
    if ('text' in v) return String(v.text);
  }
  return String(v);
}

/** 0-based column index -> spreadsheet letter. */
const colLetter = (i) => {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
};

/**
 * Locate the marker row of an imported sheet and expose relative readers.
 * Rows/columns are 0-based; `M` is the marker row index.
 */
function sheetView(rows, { input = 'input', output = 'output' } = {}) {
  const at = (r, c) => str(rows[r]?.[c]).trim();
  const kws = [input.toLowerCase(), output.toLowerCase()];
  const M = rows.findIndex((row) => row?.some((v) => kws.includes(str(v).trim().toLowerCase())));
  const width = Math.max(0, ...rows.map((r) => r?.length ?? 0));
  const markers = Array.from({ length: width }, (_, c) => at(M, c));
  const cols = (kw) => markers.flatMap((m, c) => (m.toLowerCase() === kw.toLowerCase() ? [c] : []));
  const inputs = cols(input);
  const outputs = cols(output);
  const io = [...inputs, ...outputs];
  return {
    M,
    at,
    markers,
    cols,
    inputs,
    outputs,
    io,
    /** Values at row M+off for the given columns (default: inputs then outputs). */
    row: (off, idxs = io) => idxs.map((c) => at(M + off, c)),
  };
}

/** The single sheet of a workbook (asserts there is exactly one). */
function onlySheet(wb) {
  const names = Object.keys(wb);
  expect(names).toHaveLength(1);
  return { name: names[0], rows: wb[names[0]] };
}

/** POSIX-shell word splitting for the hint command (single quotes, backslash escapes). */
function shellSplit(s) {
  const out = [];
  let cur = '';
  let has = false;
  for (let i = 0; i < s.length;) {
    const ch = s[i];
    if (ch === "'") {
      const j = s.indexOf("'", i + 1);
      cur += s.slice(i + 1, j);
      i = j + 1;
      has = true;
    } else if (ch === '\\') {
      cur += s[i + 1];
      i += 2;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
      i++;
    } else {
      cur += ch;
      has = true;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** The `excel2dmn … --platform camunda8` command printed in the import hint. */
function hintCommand(stdout) {
  const line = stdout.split('\n').find((l) => /excel2dmn .*--platform camunda8/.test(l));
  expect(line, stdout).toBeDefined();
  return line.slice(line.indexOf('excel2dmn '));
}

// --- per-test plumbing --------------------------------------------------------

let tmp;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp?.cleanup());

const p = (...parts) => join(tmp.dir, ...parts);
const cli = (args, opts = {}) => runCli(args, { cwd: tmp.dir, ...opts });

function writeJson(name, obj) {
  writeFileSync(p(name), JSON.stringify(obj), 'utf8');
  return name;
}

function writeDmn(name, xml) {
  writeFileSync(p(name), xml, 'utf8');
  return name;
}

function expectOk(r) {
  expect(r.code, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0);
}

/** Non-zero exit, no stack trace. */
function expectCleanFail(r) {
  expect(r.code, `stdout: ${r.stdout}`).not.toBe(0);
  expect(r.stderr).not.toMatch(/^\s+at /m);
}

/** No .xlsx anywhere directly in `dir` other than the listed ones. */
function expectNoXlsx(dir = '.', except = []) {
  const d = p(dir);
  const files = existsSync(d)
    ? listFiles(d).filter((f) => /\.xlsx$/i.test(f) && !except.includes(f))
    : [];
  expect(files).toEqual([]);
}

/** Write `sheets` to `file` (relative to the temp dir). */
async function book(file, sheets) {
  mkdirSync(join(p(file), '..'), { recursive: true });
  await writeWorkbook(p(file), sheets);
  return file;
}

/** Convert `file` into `outDir`, asserting success; returns the CLI result. */
function convertOk(file, outDir, flags = []) {
  const r = cli([file, ...flags, '--out-dir', outDir]);
  expectOk(r);
  return r;
}

/** Write W-C7 (or W-C8 with `c8`) and convert it; returns the relative dmn path. */
async function feesDmn({
  c8 = false,
  flags = [],
  out = 'out',
  file = 'fees_DMN.xlsx',
  ...sheet
} = {}) {
  await book(file, { 'Fees DMN': feesSheet({ c8, ...sheet }) });
  convertOk(file, out, c8 ? ['--platform', 'camunda8', ...flags] : flags);
  const dmn = join(out, 'FEES.dmn');
  await parseDmn(readText(p(dmn)));
  return dmn;
}

/** Only the `--config <file>` pair of a flag list (what the import step should share). */
function configArgs(flags) {
  const i = flags.indexOf('--config');
  return i >= 0 ? flags.slice(i, i + 2) : [];
}

/**
 * RT(flags, cfg): convert -> dmn1; import dmn1 -> back.xlsx; convert back.xlsx -> dmn2.
 * Every step runs under `dir` so several round-trips can share one test.
 */
async function roundTrip({
  sheets,
  file = 'fees_DMN.xlsx',
  flags = [],
  importArgs,
  id = 'FEES',
  dir = 'rt',
}) {
  const rel = (...x) => join(dir, ...x);
  await book(rel(file), sheets);
  convertOk(rel(file), rel('out1'), flags);
  const xml1 = readText(p(dir, 'out1', `${id}.dmn`));
  const imp = cli([
    'import',
    rel('out1', `${id}.dmn`),
    '-o',
    rel('back.xlsx'),
    ...(importArgs ?? configArgs(flags)),
  ]);
  expectOk(imp);
  const back = await readWorkbook(p(dir, 'back.xlsx'));
  convertOk(rel('back.xlsx'), rel('out2'), flags);
  const xml2 = readText(p(dir, 'out2', `${id}.dmn`));
  await parseDmn(xml1);
  await parseDmn(xml2);
  return { xml1, xml2, imp, back };
}

/** Import `dmn` (relative) to `out` (relative) and return { r, wb }. */
async function importOk(dmn, out, args = []) {
  const r = cli(['import', dmn, ...(out ? ['-o', out] : []), ...args]);
  expectOk(r);
  const target = out ?? dmn.replace(/\.dmn$/i, '.xlsx');
  return { r, wb: await readWorkbook(p(target)) };
}

const tableOf = async (xml) => firstTable(await parseDmn(xml));

// =============================================================================

// Every scenario spawns the real CLI several times; loops over policies spawn dozens.
describe('DMN -> Excel import and round-trips (e2e)', { timeout: 120_000 }, () => {
  describe('A. CLI basics and output path', () => {
    it('IMPORT-001 import a C7 file produced by the tool, default output path', async () => {
      const dmn = await feesDmn();
      const r = cli(['import', dmn]);
      expectOk(r);
      expect(r.stderr).toBe('');
      expect(existsSync(p('out', 'FEES.xlsx'))).toBe(true);
      const lines = r.stdout.split('\n').filter(Boolean);
      const success = lines.filter((l) => /\b1\b.*decision/i.test(l));
      expect(success).toHaveLength(1);
      expect(success[0]).toContain(join('out', 'FEES.xlsx'));
      expect(r.stdout).not.toMatch(/camunda8/i);
    });

    it('IMPORT-002 -o writes exactly the requested file', async () => {
      const dmn = await feesDmn();
      mkdirSync(p('back'));
      const r = cli(['import', dmn, '-o', 'back/rules.xlsx']);
      expectOk(r);
      expect(existsSync(p('back', 'rules.xlsx'))).toBe(true);
      expect(existsSync(p('out', 'FEES.xlsx'))).toBe(false);
      expect(r.stdout).toContain(join('back', 'rules.xlsx'));
    });

    it('IMPORT-003 -o relative path is resolved against cwd', async () => {
      await feesDmn({ out: 'in' });
      const r = cli(['import', 'in/FEES.dmn', '-o', 'result.xlsx']);
      expectOk(r);
      expect(existsSync(p('result.xlsx'))).toBe(true);
      expect(existsSync(p('in', 'result.xlsx'))).toBe(false);
    });

    it('IMPORT-004 -o into a directory that does not exist yet', async () => {
      const dmn = await feesDmn();
      const r = cli(['import', dmn, '-o', 'new/deeper/x.xlsx']);
      expectOk(r);
      expect(existsSync(p('new', 'deeper', 'x.xlsx'))).toBe(true);
    });

    it('IMPORT-005 -o overwrites an existing workbook', async () => {
      const dmn = await feesDmn();
      await book('x.xlsx', { Old: [['unrelated']] });
      const { wb } = await importOk(dmn, 'x.xlsx');
      const { name } = onlySheet(wb);
      expect(name).not.toBe('Old');
      expect(name).toMatch(/DMN/);
    });

    it('IMPORT-006 upper-case .DMN extension maps to .xlsx', async () => {
      const dmn = await feesDmn();
      copyFileSync(p(dmn), p('RULES.DMN'));
      const before = readFileSync(p('RULES.DMN'));
      const r = cli(['import', 'RULES.DMN']);
      expectOk(r);
      expect(existsSync(p('RULES.xlsx'))).toBe(true);
      expect(readFileSync(p('RULES.DMN')).equals(before)).toBe(true);
    });

    it('IMPORT-007 input without a .dmn extension never overwrites the input', async () => {
      const dmn = await feesDmn();
      copyFileSync(p(dmn), p('rules.xml'));
      const before = readFileSync(p('rules.xml'));
      const r = cli(['import', 'rules.xml']);
      expectOk(r);
      expect(readFileSync(p('rules.xml')).equals(before)).toBe(true);
      const target = ['rules.xml.xlsx', 'rules.xlsx'].find((f) => existsSync(p(f)));
      expect(target, `stdout: ${r.stdout}`).toBeDefined();
      expect(r.stdout).toContain(p(target));
    });

    it('IMPORT-008 paths containing spaces work', async () => {
      await book('fees_DMN.xlsx', { 'Fees DMN': feesSheet() });
      convertOk('fees_DMN.xlsx', 'my rules');
      copyFileSync(p('my rules', 'FEES.dmn'), p('my rules', 'FEES v2.dmn'));
      const r = cli(['import', 'my rules/FEES v2.dmn']);
      expectOk(r);
      expect(existsSync(p('my rules', 'FEES v2.xlsx'))).toBe(true);
    });

    it('IMPORT-009 import does not modify the source DMN', async () => {
      const dmn = await feesDmn();
      const before = readFileSync(p(dmn));
      expectOk(cli(['import', dmn]));
      mkdirSync(p('other'));
      expectOk(cli(['import', dmn, '-o', 'other/x.xlsx']));
      expect(readFileSync(p(dmn)).equals(before)).toBe(true);
      expect(listFiles(p('out'))).toEqual(['FEES.dmn', 'FEES.xlsx']);
    });

    it('IMPORT-010 import with no argument is a usage error', () => {
      const r = cli(['import']);
      expectCleanFail(r);
      expect(r.stderr).toMatch(/input\.dmn|missing required argument/i);
      expect(listFiles(tmp.dir)).toEqual([]);
    });

    it('IMPORT-011 import --help documents -o and --config', () => {
      const r = cli(['import', '--help']);
      expectOk(r);
      expect(r.stdout).toContain('-o, --out <file>');
      expect(r.stdout).toContain('--config <file>');
    });

    it('IMPORT-012 unknown option is rejected', async () => {
      const dmn = await feesDmn();
      const r = cli(['import', dmn, '--platform', 'camunda8']);
      expectCleanFail(r);
      expect(r.stderr).toContain('--platform');
      expectNoXlsx('out');
      expectNoXlsx('.', ['fees_DMN.xlsx']);
    });
  });

  describe('B. Platform detection and the re-convert hint', () => {
    it('IMPORT-013 C8 source prints the re-convert hint', async () => {
      const dmn = await feesDmn({ c8: true });
      const r = cli(['import', dmn, '-o', 'back.xlsx']);
      expectOk(r);
      const lines = r.stdout.split('\n');
      const success = lines.findIndex((l) => /decision/i.test(l) && l.includes(p('back.xlsx')));
      const hint = lines.findIndex((l) =>
        l.includes(`excel2dmn ${p('back.xlsx')} --platform camunda8`),
      );
      expect(success, r.stdout).toBeGreaterThanOrEqual(0);
      expect(hint, r.stdout).toBeGreaterThan(success);
      expect(r.stdout).toMatch(/Camunda 8/i);
    });

    it('IMPORT-014 the hint command is copy-pasteable and works', async () => {
      const dmn = await feesDmn({ c8: true });
      const r = cli(['import', dmn, '-o', 'back.xlsx']);
      expectOk(r);
      const [bin, ...args] = shellSplit(hintCommand(r.stdout));
      expect(bin).toBe('excel2dmn');
      expectOk(cli([...args, '--out-dir', 'out2']));
      expect(readText(p('out2', 'FEES.dmn'))).toBe(readText(p(dmn)));
    });

    it('IMPORT-015 hint path with spaces is shell-quoted', async () => {
      const dmn = await feesDmn({ c8: true });
      mkdirSync(p('my out'));
      const r = cli(['import', dmn, '-o', 'my out/fees file.xlsx']);
      expectOk(r);
      const abs = p('my out', 'fees file.xlsx');
      const cmd = hintCommand(r.stdout);
      expect(cmd).toContain(`'${abs}'`);
      expect(cmd.replace(`'${abs}'`, '')).not.toContain(abs);
      expect(shellSplit(cmd)[1]).toBe(abs);
    });

    it('IMPORT-016 hint path with a single quote is escaped', async () => {
      const dmn = await feesDmn({ c8: true });
      const r = cli(['import', dmn, '-o', "it's.xlsx"]);
      expectOk(r);
      const cmd = hintCommand(r.stdout);
      expect(cmd).toContain(`'${tmp.dir}/it'\\''s.xlsx'`);
      const rest = cmd.slice('excel2dmn '.length);
      const sh = spawnSync('sh', ['-c', `printf '%s\\n' ${rest}`], { encoding: 'utf8' });
      const first = sh.stdout.split('\n')[0];
      expect(first).toBe(p("it's.xlsx"));
      expect(existsSync(first)).toBe(true);
    });

    it('IMPORT-017 hint path with shell metacharacters is quoted', async () => {
      const dmn = await feesDmn({ c8: true });
      const r = cli(['import', dmn, '-o', 'a;b$c.xlsx']);
      expectOk(r);
      const abs = p('a;b$c.xlsx');
      const cmd = hintCommand(r.stdout);
      expect(cmd).toContain(`'${abs}'`);
      const rest = cmd.slice('excel2dmn '.length);
      const sh = spawnSync('sh', ['-c', `printf '%s\\n' ${rest}`], { encoding: 'utf8' });
      expect(sh.stdout.split('\n')[0]).toBe(abs);
    });

    it('IMPORT-018 safe path is printed bare', async () => {
      const dmn = await feesDmn({ c8: true });
      mkdirSync(p('back'));
      const r = cli(['import', dmn, '-o', 'back/fees_v2.xlsx']);
      expectOk(r);
      const abs = p('back', 'fees_v2.xlsx');
      const cmd = hintCommand(r.stdout);
      expect(cmd).toContain(`excel2dmn ${abs} --platform camunda8`);
      expect(cmd).not.toContain(`'${abs}'`);
    });

    it('IMPORT-019 C7 source prints no Camunda 8 hint', async () => {
      const dmn = await feesDmn();
      const r = cli(['import', dmn]);
      expectOk(r);
      expect(r.stdout).not.toContain('--platform');
      expect(r.stdout).not.toMatch(/Camunda 8/i);
    });

    it('IMPORT-020 modeler:executionPlatform="Camunda Platform" is Camunda 7', () => {
      writeDmn('dish.dmn', D_MODELER_C7);
      const r = cli(['import', 'dish.dmn']);
      expectOk(r);
      expect(r.stdout).not.toContain('--platform camunda8');
    });

    it('IMPORT-021 hand-written Modeler C8 file prints the hint', () => {
      writeDmn('risk.dmn', modelerC8());
      const r = cli(['import', 'risk.dmn']);
      expectOk(r);
      expect(r.stdout).toContain('--platform camunda8');
    });

    it('IMPORT-022 version hint when source version differs from config', () => {
      writeDmn('risk.dmn', modelerC8());
      const r = cli(['import', 'risk.dmn']);
      expectOk(r);
      const line = r.stdout.split('\n').find((l) => l.includes('executionPlatformVersion'));
      expect(line, r.stdout).toBeDefined();
      expect(line).toContain('8.5.0');
    });

    it('IMPORT-023 no version hint when versions match', async () => {
      const dmn = await feesDmn({ c8: true });
      const r = cli(['import', dmn]);
      expectOk(r);
      expect(r.stdout).toContain('--platform camunda8');
      expect(r.stdout).not.toContain('executionPlatformVersion');
    });

    it('IMPORT-024 no version hint when --config already targets the source version', () => {
      writeDmn('risk.dmn', modelerC8());
      writeJson('c.json', { camunda8: { executionPlatformVersion: '8.5.0' } });
      const r = cli(['import', 'risk.dmn', '--config', 'c.json']);
      expectOk(r);
      expect(r.stdout).toContain('--platform camunda8');
      expect(r.stdout).not.toContain('executionPlatformVersion');
    });

    it('IMPORT-025 excel2dmn.config.json in cwd is honoured for the version comparison', () => {
      writeDmn('risk.dmn', modelerC8());
      writeJson('excel2dmn.config.json', { camunda8: { executionPlatformVersion: '8.5.0' } });
      const r = cli(['import', 'risk.dmn']);
      expectOk(r);
      expect(r.stdout).toContain('--platform camunda8');
      expect(r.stdout).not.toContain('executionPlatformVersion');
    });

    it('IMPORT-026 C8 source without executionPlatformVersion', () => {
      writeDmn('risk.dmn', modelerC8({ version: null }));
      const r = cli(['import', 'risk.dmn']);
      expectOk(r);
      expect(r.stdout).toContain('--platform camunda8');
      expect(r.stdout).not.toContain('executionPlatformVersion');
    });

    it('IMPORT-027 no modeler: attributes at all => Camunda 7', () => {
      writeDmn('bare.dmn', bareDmn());
      const r = cli(['import', 'bare.dmn']);
      expectOk(r);
      expect(r.stdout).not.toContain('--platform');
    });

    it('IMPORT-028 platform value matching is case-insensitive', () => {
      writeDmn('risk.dmn', modelerC8({ platform: 'camunda cloud' }));
      const r = cli(['import', 'risk.dmn']);
      expectOk(r);
      expect(r.stdout).toContain('--platform camunda8');
    });

    it('IMPORT-029 hint goes to stdout, exit code stays 0', async () => {
      const dmn = await feesDmn({ c8: true });
      const r = cli(['import', dmn]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('--platform camunda8');
      expect(r.stderr).not.toContain('--platform');
    });
  });

  describe('C. Round-trips - Camunda 7', () => {
    it('IMPORT-030 baseline C7 round-trip is byte-identical', async () => {
      const { xml1, xml2 } = await roundTrip({ sheets: { 'Fees DMN': feesSheet() } });
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-031 imported C7 sheet layout (4-row)', async () => {
      const dmn = await feesDmn();
      const { wb } = await importOk(dmn, 'back.xlsx');
      const { name, rows } = onlySheet(wb);
      expect(name).toMatch(/DMN/);
      const v = sheetView(rows);
      const one = (kw) => {
        const c = v.cols(kw);
        expect(c, `marker ${kw}`).toHaveLength(1);
        return c[0];
      };
      expect(v.at(v.M + 1, one('policy'))).toBe('UNIQUE');
      expect(v.at(v.M + 1, one('id'))).toBe('FEES');
      expect(v.at(v.M + 1, one('name'))).toBe('Fee Decision');
      expect(v.row(1, v.inputs)).toEqual(['amount', 'region', 'tags']);
      expect(v.row(1, v.outputs)).toEqual(['fee', 'tier']);
      expect(Math.max(...v.inputs)).toBeLessThan(Math.min(...v.outputs));
      const ann = one('annotations');
      expect(v.row(2)).toEqual(['integer', 'string', 'Any', 'double', 'string']);
      expect(v.row(3)).toEqual(['Amount', 'Region', 'Tags', 'Fee', 'Tier']);
      expect(v.row(4, [...v.io, ann])).toEqual(['< 100', '"EU"', '', '1.5', '"LOW"', 'small EU']);
      expect(v.row(5, [...v.io, ann])).toEqual(['>= 100', '', '"vip"', '0', '"HIGH"', '']);
      expect(v.row(6)).toEqual(['', '', '', '', '']);
    });

    it('IMPORT-032 C7 historyTimeToLive from config survives the round-trip', async () => {
      writeJson('c.json', { camunda: { historyTimeToLive: 'P30D', versionTag: '1.2' } });
      const { xml1, xml2 } = await roundTrip({
        sheets: { 'Fees DMN': feesSheet() },
        flags: ['--config', 'c.json'],
      });
      expect(xml2).toBe(xml1);
      for (const x of [xml1, xml2]) {
        expect(x).toContain('camunda:historyTimeToLive="P30D"');
        expect(x).toContain('camunda:versionTag="1.2"');
      }
    });

    it('IMPORT-033 C7 extension values in the source are not carried by the workbook', async () => {
      writeDmn('dish.dmn', D_MODELER_C7);
      await importOk('dish.dmn');
      convertOk('dish.xlsx', 'out');
      const xml = readText(p('out', 'DECISION_0ABC.dmn'));
      await parseDmn(xml);
      expect(xml).toContain('camunda:historyTimeToLive="P180D"');
      expect(xml).not.toContain('camunda:versionTag');
    });

    it('IMPORT-034 allowed values survive the round-trip (5-row layout)', async () => {
      writeJson('av.json', ALLOWED_VALUES_LAYOUT);
      const { xml1, xml2 } = await roundTrip({
        sheets: { 'Fees DMN': feesSheet({ av: true }) },
        flags: ['--config', 'av.json'],
      });
      expect(xml2).toBe(xml1);
      const { table } = await tableOf(xml1);
      const iv = table.input.map((i) => i.inputValues?.text ?? null);
      const ov = table.output.map((o) => o.outputValues?.text ?? null);
      expect(iv).toEqual(['[0..10000]', '"EU","US"', null]);
      expect(ov).toEqual([null, '"LOW","HIGH"']);
    });

    it('IMPORT-035 imported sheet puts allowed values above the label row', async () => {
      writeJson('av.json', ALLOWED_VALUES_LAYOUT);
      const dmn = await feesDmn({ av: true, flags: ['--config', 'av.json'] });
      const { wb } = await importOk(dmn, 'back.xlsx', ['--config', 'av.json']);
      const v = sheetView(onlySheet(wb).rows);
      expect(v.row(3)).toEqual(['[0..10000]', '"EU","US"', '', '', '"LOW","HIGH"']);
      expect(v.row(4)).toEqual(['Amount', 'Region', 'Tags', 'Fee', 'Tier']);
      expect(v.row(5)).toEqual(['< 100', '"EU"', '', '1.5', '"LOW"']);
    });

    it('IMPORT-036 DMN with allowed values imported under the default 4-row config', async () => {
      writeJson('av.json', ALLOWED_VALUES_LAYOUT);
      const dmn = await feesDmn({ av: true, flags: ['--config', 'av.json'] });
      const { wb } = await importOk(dmn, 'back.xlsx');
      const v = sheetView(onlySheet(wb).rows);
      expect(v.row(3)).toEqual(['[0..10000]', '"EU","US"', '', '', '"LOW","HIGH"']);
      expect(v.row(4)).toEqual(['Amount', 'Region', 'Tags', 'Fee', 'Tier']);
      expect(v.row(5)).toEqual(['< 100', '"EU"', '', '1.5', '"LOW"']);
      convertOk('back.xlsx', 'out2', ['--config', 'av.json']);
      const xml2 = readText(p('out2', 'FEES.dmn'));
      await parseDmn(xml2);
      expect(xml2).toBe(readText(p(dmn)));
    });

    it('IMPORT-037 the 5-row auto-upgrade is announced', async () => {
      writeJson('av.json', ALLOWED_VALUES_LAYOUT);
      const dmn = await feesDmn({ av: true, flags: ['--config', 'av.json'] });
      const { r } = await importOk(dmn, 'back.xlsx');
      for (const key of ['allowedValuesOffset', 'labelOffset', 'startOffset'])
        expect(r.stdout).toContain(key);
      // The import under the 5-row config itself needs no hint.
      const again = cli(['import', dmn, '-o', 'again.xlsx', '--config', 'av.json']);
      expectOk(again);
      expect(again.stdout).not.toContain('allowedValuesOffset');
    });

    it('IMPORT-038 no auto-upgrade when the DMN has no allowed values', async () => {
      const dmn = await feesDmn();
      const { r, wb } = await importOk(dmn, 'back.xlsx');
      const v = sheetView(onlySheet(wb).rows);
      expect(v.row(3)).toEqual(['Amount', 'Region', 'Tags', 'Fee', 'Tier']);
      expect(v.row(4)).toEqual(['< 100', '"EU"', '', '1.5', '"LOW"']);
      expect(r.stdout).not.toContain('allowedValuesOffset');
    });

    it('IMPORT-039 annotations survive, including empty ones', async () => {
      const sheet = feesSheet({
        edit: (cols, rules) =>
          rules.push([null, null, null, '>= 1000', '"US"', '-', '0', '"HIGH"', 'bulk | over 1k']),
      });
      const { xml1, xml2 } = await roundTrip({ sheets: { 'Fees DMN': sheet } });
      expect(xml2).toBe(xml1);
      const { table } = await tableOf(xml1);
      expect(table.rule.map((r) => [r.id, r.description ?? null])).toEqual([
        ['rule_1', 'small EU'],
        ['rule_2', null],
        ['rule_3', 'bulk | over 1k'],
      ]);
      expect(xml1).toContain('<description>small EU</description>');
      expect(xml1).toContain('<description>bulk | over 1k</description>');
    });

    it('IMPORT-040 table without any annotation has no annotations column after import', async () => {
      const sheet = feesSheet({ edit: (cols, rules) => dropCol(cols, rules, C7.ann) });
      const { xml1, xml2, back } = await roundTrip({ sheets: { 'Fees DMN': sheet } });
      expect(xml2).toBe(xml1);
      const v = sheetView(onlySheet(back).rows);
      expect(v.cols('annotations')).toEqual([]);
    });

    it('IMPORT-041 multi-column annotations collapse into one and stay stable', async () => {
      const sheet = feesSheet({
        edit: (cols, rules) =>
          insertCol(cols, rules, cols.length, { marker: 'annotations' }, ['check rate', null]),
      });
      const { xml1, xml2, back } = await roundTrip({ sheets: { 'Fees DMN': sheet } });
      expect(xml2).toBe(xml1);
      const { table } = await tableOf(xml1);
      expect(table.rule[0].description).toBe('small EU | check rate');
      const v = sheetView(onlySheet(back).rows);
      const ann = v.cols('annotations');
      expect(ann).toHaveLength(1);
      expect(v.at(v.M + 4, ann[0])).toBe('small EU | check rate');
    });

    it('IMPORT-042 every non-default hit policy round-trips (C7)', async () => {
      for (const policy of ['FIRST', 'ANY', 'COLLECT', 'RULE ORDER']) {
        const { xml1, xml2, back } = await roundTrip({
          sheets: { 'Fees DMN': feesSheet({ policy }) },
          dir: policy.replace(' ', '_'),
        });
        expect(xml2, policy).toBe(xml1);
        expect(xml1).toContain(`hitPolicy="${policy}"`);
        const v = sheetView(onlySheet(back).rows);
        expect(v.at(v.M + 1, v.cols('policy')[0])).toBe(policy);
      }
    });

    it('IMPORT-043 UNIQUE round-trips with no hitPolicy attribute', async () => {
      const { xml1, xml2, back } = await roundTrip({ sheets: { 'Fees DMN': feesSheet() } });
      expect(xml1).not.toContain('hitPolicy=');
      expect(xml2).not.toContain('hitPolicy=');
      const v = sheetView(onlySheet(back).rows);
      expect(v.at(v.M + 1, v.cols('policy')[0])).toBe('UNIQUE');
    });

    it('IMPORT-044 COLLECT aggregators round-trip (C7)', async () => {
      for (const agg of ['SUM', 'MIN', 'MAX', 'COUNT']) {
        const { xml1, xml2, back } = await roundTrip({
          sheets: { 'Sum DMN': sumSheet(agg) },
          file: 'sum_DMN.xlsx',
          id: 'SURCHARGES',
          dir: agg,
        });
        expect(xml1).toContain(`hitPolicy="COLLECT" aggregation="${agg}"`);
        const v = sheetView(onlySheet(back).rows);
        const pol = v.cols('policy')[0];
        expect(v.at(v.M + 1, pol)).toBe('COLLECT');
        expect(v.at(v.M + 2, pol), agg).toBe(agg);
        expect(xml2, agg).toBe(xml1);
      }
    });

    it('IMPORT-045 COLLECT without aggregator round-trips', async () => {
      const { xml1, xml2, back } = await roundTrip({
        sheets: { 'Sum DMN': sumSheet(null) },
        file: 'sum_DMN.xlsx',
        id: 'SURCHARGES',
      });
      expect(xml1).toContain('hitPolicy="COLLECT"');
      expect(xml1).not.toContain('aggregation=');
      expect(xml2).toBe(xml1);
      const v = sheetView(onlySheet(back).rows);
      expect(v.at(v.M + 2, v.cols('policy')[0])).toBe('');
    });

    it('IMPORT-046 PRIORITY and OUTPUT ORDER round-trip on Camunda 7', async () => {
      writeJson('av.json', ALLOWED_VALUES_LAYOUT);
      for (const policy of ['PRIORITY', 'OUTPUT ORDER']) {
        const { xml1, xml2 } = await roundTrip({
          sheets: { 'Ranked DMN': prioSheet(policy) },
          file: 'ranked_DMN.xlsx',
          id: 'RANKED',
          flags: ['--config', 'av.json'],
          dir: policy.replace(' ', '_'),
        });
        expect(xml2, policy).toBe(xml1);
        const { table } = await tableOf(xml1);
        expect(table.output[0].outputValues.text).toBe('"A","B","C"');
      }
    });

    it('IMPORT-047 Any columns round-trip with the default (omitted) typeRef', async () => {
      const { xml1, xml2, back } = await roundTrip({ sheets: { 'Fees DMN': feesSheet() } });
      expect(xml2).toBe(xml1);
      for (const x of [xml1, xml2]) {
        const { table } = await tableOf(x);
        expect(table.input[2].inputExpression.text).toBe('tags');
        expect(table.input[2].inputExpression.typeRef).toBeUndefined();
      }
      const v = sheetView(onlySheet(back).rows);
      expect(v.at(v.M + 2, v.inputs[2])).toBe('Any');
    });

    it('IMPORT-048 Any alias spellings in the source workbook normalise to Any', async () => {
      const sheet = feesSheet({
        edit: (cols, rules) => {
          cols[C7.tags].type = 'object';
          insertCol(
            cols,
            rules,
            C7.ann,
            { marker: 'output', name: 'meta', type: 'None', label: 'Meta' },
            ['null', 'null'],
          );
        },
      });
      const { xml1, xml2, back } = await roundTrip({ sheets: { 'Fees DMN': sheet } });
      const v = sheetView(onlySheet(back).rows);
      expect(v.at(v.M + 2, v.inputs[2])).toBe('Any');
      expect(v.at(v.M + 2, v.outputs[2])).toBe('Any');
      expect(xml2).toBe(xml1);
      const { table } = await tableOf(xml1);
      expect(table.input[2].inputExpression.typeRef).toBeUndefined();
      expect(table.output[2].typeRef).toBeUndefined();
    });

    it('IMPORT-049 Any columns round-trip with anyDmnPlaceholder: "Any"', async () => {
      writeJson('c.json', { types: { anyDmnPlaceholder: 'Any' } });
      const { xml1, xml2, back } = await roundTrip({
        sheets: { 'Fees DMN': feesSheet() },
        flags: ['--config', 'c.json'],
      });
      const { table } = await tableOf(xml1);
      expect(table.input[2].inputExpression.typeRef).toBe('Any');
      const v = sheetView(onlySheet(back).rows);
      expect(v.at(v.M + 2, v.inputs[2])).toBe('Any');
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-050 "any" input entries (- and empty) round-trip as empty', async () => {
      const { xml1, xml2, back } = await roundTrip({ sheets: { 'Fees DMN': feesSheet() } });
      const { table } = await tableOf(xml1);
      expect(table.rule[0].inputEntry[2].text).toBe('');
      expect(table.rule[1].inputEntry[1].text).toBe('');
      expect(xml1).not.toContain('<text>-</text>');
      const v = sheetView(onlySheet(back).rows);
      expect(v.at(v.M + 4, v.inputs[2])).toBe('');
      expect(v.at(v.M + 5, v.inputs[1])).toBe('');
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-051 empty output entries round-trip', async () => {
      const sheet = feesSheet({ edit: (cols, rules) => (rules[1][C7.tier] = null) });
      const { xml1, xml2, back } = await roundTrip({ sheets: { 'Fees DMN': sheet } });
      const { table } = await tableOf(xml1);
      const entry = table.rule[1].outputEntry[1];
      expect(entry.id).toBe('tier_2');
      expect(entry.text).toBe('');
      const v = sheetView(onlySheet(back).rows);
      expect(v.at(v.M + 5, v.outputs[1])).toBe('');
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-052 XML-special characters in entries round-trip', async () => {
      const region = '"A&B","<x>"';
      const tier = '"it\'s \\"q\\""';
      const sheet = feesSheet({
        edit: (cols, rules) => {
          rules[0][C7.region] = region;
          rules[0][C7.tier] = tier;
        },
      });
      const { xml1, xml2, back } = await roundTrip({ sheets: { 'Fees DMN': sheet } });
      const v = sheetView(onlySheet(back).rows);
      expect(v.at(v.M + 4, v.inputs[1])).toBe(region);
      expect(v.at(v.M + 4, v.outputs[1])).toBe(tier);
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-053 Unicode in names, labels, entries and annotations round-trips', async () => {
      const sheet = feesSheet({
        edit: (cols, rules) => {
          cols[C7.name].name = 'Opłata – Zürich';
          cols[C7.amount].label = 'Kwota ≤ limit';
          rules[0][C7.tier] = '"Zażółć"';
          rules[0][C7.ann] = 'naïve ✓';
        },
      });
      const { xml1, xml2, back } = await roundTrip({ sheets: { 'Fees DMN': sheet } });
      const v = sheetView(onlySheet(back).rows);
      expect(v.at(v.M + 1, v.cols('name')[0])).toBe('Opłata – Zürich');
      expect(v.at(v.M + 3, v.inputs[0])).toBe('Kwota ≤ limit');
      expect(v.at(v.M + 4, v.outputs[1])).toBe('"Zażółć"');
      expect(v.at(v.M + 4, v.cols('annotations')[0])).toBe('naïve ✓');
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-054 decision without a separate name (name == id)', async () => {
      const sheet = feesSheet({ edit: (cols, rules) => dropCol(cols, rules, C7.name) });
      const { xml1, xml2, back } = await roundTrip({ sheets: { 'Fees DMN': sheet } });
      expect(xml1).toContain('<decision id="FEES" name="FEES"');
      const v = sheetView(onlySheet(back).rows);
      expect(v.cols('name')).toEqual([]);
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-055 helper columns are dropped and the second round-trip is stable', async () => {
      const sheet = feesSheet({
        edit: (cols, rules) => {
          insertCol(cols, rules, C7.amount, { marker: null, name: 'No.' }, [1, 2]);
          insertCol(cols, rules, cols.length, { marker: 'NOT PART OF DMN', name: 'internal' }, [
            'x',
            'y',
          ]);
        },
      });
      const { xml1, xml2, back } = await roundTrip({ sheets: { 'Fees DMN': sheet } });
      const { rows } = onlySheet(back);
      const v = sheetView(rows);
      const known = ['policy', 'id', 'name', 'input', 'output', 'annotations'];
      const used = v.markers.map((m, c) => [m, c]).filter(([m]) => m !== '');
      for (const [m] of used) expect(known).toContain(m.toLowerCase());
      // No column without a marker carries any header or rule data.
      for (let c = 0; c < v.markers.length; c++) {
        if (v.markers[c]) continue;
        for (let r = v.M; r < rows.length; r++) expect(v.at(r, c), `col ${c} row ${r}`).toBe('');
      }
      const flat = rows.flat().map(str);
      expect(flat).not.toContain('No.');
      expect(flat).not.toContain('NOT PART OF DMN');
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-056 header shifted down / leading blank columns in the source', async () => {
      const shifted = [[], [], ...feesSheet().map((r) => [null, ...r])];
      const { xml1, xml2 } = await roundTrip({ sheets: { 'Fees DMN': shifted } });
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-057 every Camunda 7 type round-trips', async () => {
      const inputs = [
        ['s', 'string', '"A"'],
        ['b', 'boolean', 'true'],
        ['i', 'integer', '> 1'],
        ['l', 'long', '< 10'],
        ['d', 'double', '>= 1.5'],
        ['dt', 'date', '< date("2026-01-01")'],
        ['x', 'Any', '-'],
      ];
      const { xml1, xml2, back } = await roundTrip({
        sheets: { 'Types DMN': typesSheet(inputs) },
        file: 'types_DMN.xlsx',
        id: 'TYPES',
      });
      const v = sheetView(onlySheet(back).rows);
      expect(v.row(2)).toEqual([...inputs.map(([, t]) => t), 'string']);
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-058 boolean entries round-trip as lower-case FEEL', async () => {
      const sheet = decisionSheet(
        [
          { marker: 'ID', name: 'BOOLS' },
          { marker: 'input', name: 'flag', type: 'boolean', label: 'Flag' },
          { marker: 'output', name: 'r', type: 'string', label: 'R' },
        ],
        [
          [null, true, '"Y"'],
          [null, false, '"N"'],
        ],
      );
      const { xml1, xml2, back } = await roundTrip({
        sheets: { 'Bools DMN': sheet },
        file: 'bools_DMN.xlsx',
        id: 'BOOLS',
      });
      const { table } = await tableOf(xml1);
      expect(table.rule.map((r) => r.inputEntry[0].text)).toEqual(['true', 'false']);
      const v = sheetView(onlySheet(back).rows);
      expect(
        [v.at(v.M + 4, v.inputs[0]), v.at(v.M + 5, v.inputs[0])].map((s) => s.toLowerCase()),
      ).toEqual(['true', 'false']);
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-059 numeric entries are not reformatted by Excel', async () => {
      const sheet = decisionSheet(
        [
          { marker: 'ID', name: 'NUMS' },
          { marker: 'input', name: 'i', type: 'integer', label: 'I' },
          { marker: 'output', name: 'v', type: 'double', label: 'V' },
        ],
        [
          [null, '1', '1.50'],
          [null, '2', 1000000],
          [null, '3', 0.1],
        ],
      );
      const { xml1, xml2 } = await roundTrip({
        sheets: { 'Nums DMN': sheet },
        file: 'nums_DMN.xlsx',
        id: 'NUMS',
      });
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-060 --no-pretty output round-trips', async () => {
      const { xml1, xml2 } = await roundTrip({
        sheets: { 'Fees DMN': feesSheet() },
        flags: ['--no-pretty'],
      });
      expect(xml2).toBe(xml1);
      const lines = xml1.trim().split('\n');
      expect(lines.length).toBeLessThanOrEqual(2);
      expect(lines[0]).toMatch(/^<\?xml/);
    });

    it('IMPORT-061 prefixed namespace style round-trips', async () => {
      writeJson('c.json', { output: { namespaceStyle: 'prefixed' } });
      const { xml1, xml2 } = await roundTrip({
        sheets: { 'Fees DMN': feesSheet() },
        flags: ['--config', 'c.json'],
      });
      expect(xml1).toContain('<dmn:definitions');
      expect(xml1).toContain('xmlns:dmn=');
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-062 custom namespace and rule-id template round-trip with the same config', async () => {
      writeJson('c.json', {
        output: { namespace: 'urn:acme' },
        rules: { idTemplate: 'rule_<row>' },
      });
      const { xml1, xml2 } = await roundTrip({
        sheets: { 'Fees DMN': feesSheet() },
        flags: ['--config', 'c.json'],
      });
      expect(xml1).toContain('namespace="urn:acme"');
      const { table } = await tableOf(xml1);
      expect(table.rule.map((r) => r.id)).toEqual(['rule_5', 'rule_6']);
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-063 round-trip is a fixed point (second cycle changes nothing)', async () => {
      const dmn1 = await feesDmn({ out: 'o1' });
      expectOk(cli(['import', dmn1, '-o', 'b1.xlsx']));
      convertOk('b1.xlsx', 'o2');
      expectOk(cli(['import', 'o2/FEES.dmn', '-o', 'b2.xlsx']));
      convertOk('b2.xlsx', 'o3');
      const [x1, x2, x3] = ['o1', 'o2', 'o3'].map((d) => readText(p(d, 'FEES.dmn')));
      for (const x of [x2, x3]) await parseDmn(x);
      expect(x2).toBe(x1);
      expect(x3).toBe(x1);
      expect(await readWorkbook(p('b2.xlsx'))).toEqual(await readWorkbook(p('b1.xlsx')));
    });

    it('IMPORT-064 the reference shipping-rates golden file round-trips', async () => {
      copyFileSync(join(FIXTURES, 'shipping_rates.expected.dmn'), p('c7.dmn'));
      expectOk(cli(['import', 'c7.dmn']));
      convertOk('c7.xlsx', 'out7');
      const c7 = readText(p('out7', 'SHIPPING_RATES.dmn'));
      await parseDmn(c7);
      expect(c7).toBe(readText(p('c7.dmn')));

      copyFileSync(join(FIXTURES, 'shipping_rates.c8.expected.dmn'), p('c8.dmn'));
      expectOk(cli(['import', 'c8.dmn']));
      convertOk('c8.xlsx', 'out8', ['--platform', 'camunda8']);
      const c8 = readText(p('out8', 'SHIPPING_RATES.dmn'));
      await parseDmn(c8);
      expect(c8).toBe(readText(p('c8.dmn')));
    });
  });

  describe('D. Round-trips - Camunda 8', () => {
    const C8 = ['--platform', 'camunda8'];

    it('IMPORT-065 baseline C8 round-trip is byte-identical with --platform camunda8', async () => {
      const { xml1, xml2 } = await roundTrip({
        sheets: { 'Fees DMN': feesSheet({ c8: true }) },
        flags: C8,
      });
      expect(xml2).toBe(xml1);
      for (const x of [xml1, xml2]) {
        expect(x).toContain('modeler:executionPlatform="Camunda Cloud"');
        expect(x).toContain('modeler:executionPlatformVersion="8.6.0"');
        expect(x).not.toMatch(/\scamunda:/);
      }
    });

    it('IMPORT-066 re-converting a C8 import without --platform camunda8 fails on C8 types', async () => {
      const dmn = await feesDmn({ c8: true });
      const { wb } = await importOk(dmn, 'back.xlsx');
      const { name, rows } = onlySheet(wb);
      const v = sheetView(rows);
      const r = cli(['back.xlsx', '--out-dir', 'out2']);
      expect(r.code).toBe(1);
      expect(r.stderr).not.toMatch(/^\s+at /m);
      const typeRow = v.M + 2 + 1; // 1-based Excel row of the type row
      for (const col of ['amount', 'when', 'fee']) {
        const c = v.io.find((i) => v.at(v.M + 1, i) === col);
        expect(r.stderr, col).toContain(`${name}!${colLetter(c)}${typeRow}`);
      }
      expect(r.stderr).toMatch(/number/);
      expect(r.stderr).toMatch(/dateTime/);
      expect(existsSync(p('out2', 'FEES.dmn'))).toBe(false);
    });

    it('IMPORT-067 C7-only numeric types become number and stay stable', async () => {
      const { xml1, xml2, back } = await roundTrip({
        sheets: { 'Fees DMN': feesSheet() },
        flags: C8,
      });
      const { table } = await tableOf(xml1);
      expect(table.input[0].inputExpression.typeRef).toBe('number');
      expect(table.output[0].typeRef).toBe('number');
      const v = sheetView(onlySheet(back).rows);
      expect(v.at(v.M + 2, v.inputs[0])).toBe('number');
      expect(v.at(v.M + 2, v.outputs[0])).toBe('number');
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-068 every C8 FEEL type round-trips', async () => {
      const { xml1, xml2, back } = await roundTrip({
        sheets: { 'Types DMN': typesSheet(C8_TYPE_INPUTS) },
        file: 'types_DMN.xlsx',
        id: 'TYPES',
        flags: C8,
      });
      const v = sheetView(onlySheet(back).rows);
      expect(v.row(2, v.inputs)).toEqual(C8_TYPE_INPUTS.map(([, t]) => t));
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-069 allowed values round-trip on C8', async () => {
      writeJson('av.json', ALLOWED_VALUES_LAYOUT);
      const { xml1, xml2 } = await roundTrip({
        sheets: { 'Fees DMN': feesSheet({ c8: true, av: true }) },
        flags: [...C8, '--config', 'av.json'],
      });
      expect(xml2).toBe(xml1);
      expect(xml1).toContain('<inputValues>');
      expect(xml1).toContain('<outputValues>');
    });

    it('IMPORT-070 annotations round-trip on C8', async () => {
      const { xml1, xml2 } = await roundTrip({
        sheets: { 'Fees DMN': feesSheet({ c8: true }) },
        flags: C8,
      });
      for (const x of [xml1, xml2]) {
        const { table } = await tableOf(x);
        expect(table.rule[0].id).toBe('rule_1');
        expect(table.rule[0].description).toBe('small EU');
      }
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-071 supported hit policies round-trip on C8', async () => {
      for (const policy of ['FIRST', 'ANY', 'RULE ORDER', 'COLLECT']) {
        const { xml1, xml2, back } = await roundTrip({
          sheets: { 'Fees DMN': feesSheet({ c8: true, policy }) },
          flags: C8,
          dir: policy.replace(' ', '_'),
        });
        expect(xml2, policy).toBe(xml1);
        const v = sheetView(onlySheet(back).rows);
        expect(v.at(v.M + 1, v.cols('policy')[0])).toBe(policy);
      }
      for (const agg of ['SUM', 'MIN', 'MAX', 'COUNT']) {
        const { xml1, xml2, back } = await roundTrip({
          sheets: { 'Sum DMN': sumSheet(agg) },
          file: 'sum_DMN.xlsx',
          id: 'SURCHARGES',
          flags: C8,
          dir: `sum_${agg}`,
        });
        const v = sheetView(onlySheet(back).rows);
        const pol = v.cols('policy')[0];
        expect(v.at(v.M + 1, pol)).toBe('COLLECT');
        expect(v.at(v.M + 2, pol), agg).toBe(agg);
        expect(xml2, agg).toBe(xml1);
      }
    });

    it('IMPORT-072 Any columns on C8 are written as Any and omitted in DMN', async () => {
      const { xml1, xml2, back } = await roundTrip({
        sheets: { 'Fees DMN': feesSheet({ c8: true }) },
        flags: C8,
      });
      for (const x of [xml1, xml2]) {
        const { table } = await tableOf(x);
        expect(table.input[2].inputExpression.typeRef).toBeUndefined();
      }
      const v = sheetView(onlySheet(back).rows);
      expect(v.at(v.M + 2, v.inputs[2])).toBe('Any');
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-073 non-default target version round-trips with the matching config', async () => {
      writeJson('v.json', {
        platform: 'camunda8',
        camunda8: { executionPlatformVersion: '8.5.0' },
      });
      const { xml1, xml2, imp } = await roundTrip({
        sheets: { 'Fees DMN': feesSheet({ c8: true }) },
        flags: ['--config', 'v.json'],
      });
      for (const x of [xml1, xml2]) expect(x).toContain('executionPlatformVersion="8.5.0"');
      expect(xml2).toBe(xml1);
      expect(imp.stdout).toContain('--platform camunda8');
      expect(imp.stdout).not.toContain('executionPlatformVersion');
    });

    it('IMPORT-074 re-converting a non-default-version C8 import with defaults retargets 8.6.0', async () => {
      writeJson('v.json', {
        platform: 'camunda8',
        camunda8: { executionPlatformVersion: '8.5.0' },
      });
      const dmn = await feesDmn({ flags: ['--config', 'v.json'] });
      const xml1 = readText(p(dmn));
      const { r } = await importOk(dmn, 'back.xlsx');
      convertOk('back.xlsx', 'out2', C8);
      const out = readText(p('out2', 'FEES.dmn'));
      await parseDmn(out);
      expect(out).toContain('executionPlatformVersion="8.6.0"');
      expect(out).toBe(
        xml1.replace('executionPlatformVersion="8.5.0"', 'executionPlatformVersion="8.6.0"'),
      );
      const hint = r.stdout.split('\n').find((l) => l.includes('executionPlatformVersion'));
      expect(hint, r.stdout).toBeDefined();
      expect(hint).toContain('8.5.0');
    });

    it('IMPORT-075 C8 file re-built as C7 drops modeler metadata (cross-platform)', async () => {
      const dmn = await feesDmn({ flags: C8 });
      await importOk(dmn, 'back.xlsx');
      writeJson('c.json', { types: { nonCamundaTypeAction: 'off' } });
      convertOk('back.xlsx', 'out2', ['--platform', 'camunda7', '--config', 'c.json']);
      const out = readText(p('out2', 'FEES.dmn'));
      await parseDmn(out);
      expect(out).not.toContain('modeler:');
      expect(out).toContain('camunda:historyTimeToLive="P180D"');
    });

    it('IMPORT-076 C7 file re-built for C8 normalises types and drops C7 extensions', async () => {
      const dmn = await feesDmn();
      await importOk(dmn, 'back.xlsx');
      convertOk('back.xlsx', 'out2', C8);
      const out = readText(p('out2', 'FEES.dmn'));
      await parseDmn(out);
      expect(out).toContain('modeler:executionPlatform="Camunda Cloud"');
      expect(out).not.toContain('camunda:historyTimeToLive');
      const { table } = await tableOf(out);
      expect(table.input[0].inputExpression.typeRef).toBe('number');
      expect(table.output[0].typeRef).toBe('number');
      convertOk('fees_DMN.xlsx', 'direct', C8);
      expect(out).toBe(readText(p('direct', 'FEES.dmn')));
    });
  });

  describe('E. Hand-written and Camunda-Modeler-style DMN', () => {
    /** Assert the IMPORT-077 content of an imported D-MODELER-C7 workbook. */
    function expectDishSheet(wb) {
      const { name, rows } = onlySheet(wb);
      expect(name).toMatch(/DMN/);
      const v = sheetView(rows);
      expect(v.at(v.M + 1, v.cols('policy')[0])).toBe('FIRST');
      expect(v.at(v.M + 1, v.cols('id')[0])).toBe('Decision_0abc');
      expect(v.at(v.M + 1, v.cols('name')[0])).toBe('Dish');
      expect(v.row(1)).toEqual(['season', 'guestCount', 'dish']);
      expect(v.row(2)).toEqual(['string', 'integer', 'string']);
      expect(v.row(3)).toEqual(['Season', 'Guests', 'Dish']);
      const ann = v.cols('annotations');
      expect(ann).toHaveLength(1);
      expect(v.row(4, [...v.io, ann[0]])).toEqual([
        '"Winter"',
        '<= 8',
        '"Roastbeef"',
        'winter feast',
      ]);
      expect(v.row(5, [...v.io, ann[0]])).toEqual(['"Summer"', '', '"Salad"', '']);
    }

    /** Import a D-MODELER-C7 variant and return the workbook values. */
    async function importVariant(xml, name = 'variant.dmn') {
      writeFileSync(p(name), xml, 'utf8');
      return (await importOk(name)).wb;
    }

    it('IMPORT-077 Modeler C7 file imports with its content intact', async () => {
      writeDmn('dish.dmn', D_MODELER_C7);
      const { wb } = await importOk('dish.dmn');
      expectDishSheet(wb);
    });

    it('IMPORT-078 Modeler C7 file re-converts with normalised ids', async () => {
      writeDmn('dish.dmn', D_MODELER_C7);
      await importOk('dish.dmn');
      convertOk('dish.xlsx', 'out');
      const defs = await parseDmn(readText(p('out', 'DECISION_0ABC.dmn')));
      const { decision, table } = firstTable(defs);
      expect(decision.id).toBe('DECISION_0ABC');
      expect(decision.name).toBe('Dish');
      expect(table.rule.map((r) => r.id)).toEqual(['rule_1', 'rule_2']);
      expect(table.input.map((i) => i.id)).toEqual(['season', 'guestCount']);
      expect(table.rule[0].inputEntry[0].id).toBe('season_1');
      expect(table.rule[1].inputEntry[1].id).toBe('guestCount_2');
      expect(table.rule[0].outputEntry[0].id).toBe('dish_1');
      const shapes = defs.dmnDI.diagrams.flatMap((d) => d.diagramElements);
      expect(shapes.map((s) => s.id)).toEqual(['DMNShape_DECISION_0ABC']);
    });

    it('IMPORT-079 Modeler C7 file reaches a fixed point after one cycle', async () => {
      writeDmn('dish.dmn', D_MODELER_C7);
      await importOk('dish.dmn');
      convertOk('dish.xlsx', 'a');
      await importOk('a/DECISION_0ABC.dmn', 'b.xlsx');
      convertOk('b.xlsx', 'b');
      const a = readText(p('a', 'DECISION_0ABC.dmn'));
      const b = readText(p('b', 'DECISION_0ABC.dmn'));
      await parseDmn(b);
      expect(b).toBe(a);
    });

    it('IMPORT-080 Modeler C8 file: typeRef="Any" and missing typeRef become Any', async () => {
      writeDmn('risk.dmn', modelerC8());
      const { wb } = await importOk('risk.dmn');
      const v = sheetView(onlySheet(wb).rows);
      expect(v.row(1)).toEqual(['age', 'payload', 'extra', 'risk']);
      expect(v.row(2)).toEqual(['number', 'Any', 'Any', 'string']);
    });

    it('IMPORT-081 untyped spellings any, None, object, OBJECT are normalised', async () => {
      for (const t of ['any', 'None', 'object', 'OBJECT']) {
        const file = `bare_${t}.dmn`;
        writeDmn(
          file,
          bareDmn({ inputs: [{ text: 'x', typeRef: t }], output: { name: 'y', typeRef: 'Any' } }),
        );
        const { wb } = await importOk(file);
        const v = sheetView(onlySheet(wb).rows);
        expect(v.row(2), t).toEqual(['Any', 'Any']);
      }
    });

    it('IMPORT-082 Modeler C8 file without DMNDI round-trips through C8 convert', async () => {
      writeDmn('risk.dmn', modelerC8());
      await importOk('risk.dmn');
      convertOk('risk.xlsx', 'a', ['--platform', 'camunda8']);
      const a = readText(p('a', 'RISK_1.dmn'));
      const defs = await parseDmn(a);
      expect(a).toContain('DMNShape_RISK_1');
      expect(a).toContain('modeler:executionPlatform="Camunda Cloud"');
      const { table } = firstTable(defs);
      for (const rule of table.rule) {
        expect(rule.inputEntry[1].text).toBe('');
        expect(rule.inputEntry[2].text).toBe('');
      }
      await importOk('a/RISK_1.dmn', 'b.xlsx');
      convertOk('b.xlsx', 'b', ['--platform', 'camunda8']);
      expect(readText(p('b', 'RISK_1.dmn'))).toBe(a);
    });

    it('IMPORT-083 file without decision name uses the id as the sheet/name', async () => {
      writeDmn('bare.dmn', bareDmn());
      const { wb } = await importOk('bare.dmn');
      const { name, rows } = onlySheet(wb);
      expect(name).toContain('Bare');
      expect(name).toContain('DMN');
      const v = sheetView(rows);
      expect(v.at(v.M + 1, v.cols('id')[0])).toBe('Bare');
      const nameCol = v.cols('name');
      if (nameCol.length) expect(v.at(v.M + 1, nameCol[0])).toBe('Bare');
      expect(v.at(v.M + 2, v.inputs[0])).toBe('Any');
      expect(v.row(3)).toEqual(['', '']);
    });

    it('IMPORT-084 extra namespaces and unknown extension attributes are tolerated', async () => {
      const base = await importVariant(D_MODELER_C7, 'dish.dmn');
      const xml = D_MODELER_C7.replace(
        'xmlns:modeler=',
        'xmlns:biodi="http://bpmn.io/schema/dmn/biodi/2.0" xmlns:foo="urn:foo" xmlns:modeler=',
      )
        .replace(
          '<input id="Input_1" label="Season">',
          '<input id="Input_1" label="Season" biodi:width="192">',
        )
        .replace(
          '<decisionTable id="DecisionTable_1k2"',
          '<extensionElements><foo:bar baz="1" /></extensionElements>\n    <decisionTable id="DecisionTable_1k2"',
        );
      expect(await importVariant(xml)).toEqual(base);
    });

    it('IMPORT-085 <text>-</text> input entries become empty cells', async () => {
      writeDmn(
        'bare.dmn',
        bareDmn({
          rules: [
            { in: ['1'], out: ['"one"'] },
            { in: ['-'], out: ['"two"'] },
          ],
        }),
      );
      const { wb } = await importOk('bare.dmn');
      const v = sheetView(onlySheet(wb).rows);
      expect(['-', '']).toContain(v.at(v.M + 5, v.inputs[0]));
      convertOk('bare.xlsx', 'out');
      const { table } = await tableOf(readText(p('out', 'BARE.dmn')));
      expect(table.rule[1].inputEntry[0].text).toBe('');
    });

    it('IMPORT-086 prefixed dmn: source file imports', async () => {
      const base = await importVariant(D_MODELER_C7, 'dish.dmn');
      const prefixed = D_MODELER_C7.replace(
        `xmlns="${MODEL_NS}"`,
        `xmlns:dmn="${MODEL_NS}"`,
      ).replace(/<(\/?)(?![\w-]+:)([A-Za-z]\w*)/g, '<$1dmn:$2');
      expect(prefixed).toContain('<dmn:definitions');
      expect(prefixed).toContain('<dmndi:DMNDI>');
      expect(await importVariant(prefixed)).toEqual(base);
    });

    it('IMPORT-087 input expression that is not a plain name', async () => {
      writeDmn(
        'bare.dmn',
        bareDmn({ rootAttrs: C8_ROOT_ATTRS, inputs: [{ text: 'order.total', typeRef: 'number' }] }),
      );
      const { wb } = await importOk('bare.dmn');
      const v = sheetView(onlySheet(wb).rows);
      expect(v.at(v.M + 1, v.inputs[0])).toBe('order.total');
      convertOk('bare.xlsx', 'out', ['--platform', 'camunda8']);
      const xml = readText(p('out', 'BARE.dmn'));
      await parseDmn(xml);
      const ids = [...xml.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
      for (const id of ids) expect(id).toMatch(/^[A-Za-z_][\w.-]*$/);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('IMPORT-088 output without a name attribute', async () => {
      writeDmn('bare.dmn', bareDmn({ output: { typeRef: 'string' } }));
      const { wb } = await importOk('bare.dmn');
      const v = sheetView(onlySheet(wb).rows);
      expect(v.at(v.M + 1, v.outputs[0])).toBe('Output_1');
    });

    it('IMPORT-089 two inputs with the same expression keep their own entries', async () => {
      writeDmn(
        'bare.dmn',
        bareDmn({
          inputs: [
            { text: 'amount', typeRef: 'integer' },
            { text: 'amount', typeRef: 'integer' },
          ],
          rules: [{ in: ['>= 10', '< 100'], out: ['"one"'] }],
        }),
      );
      const { wb } = await importOk('bare.dmn');
      const v = sheetView(onlySheet(wb).rows);
      expect(v.row(1, v.inputs)).toEqual(['amount', 'amount']);
      expect(v.row(4, v.inputs)).toEqual(['>= 10', '< 100']);
    });

    it('IMPORT-090 input entry with leading/trailing whitespace is normalised on re-convert', async () => {
      writeDmn('bare.dmn', bareDmn({ rules: [{ in: ['  1  '], out: ['"one"'] }] }));
      await importOk('bare.dmn');
      convertOk('bare.xlsx', 'out');
      const { table } = await tableOf(readText(p('out', 'BARE.dmn')));
      expect(table.rule[0].inputEntry[0].text).toBe('1');
    });

    it('IMPORT-091 unknown typeRef in the source surfaces on re-convert, not on import', async () => {
      writeDmn('bare.dmn', bareDmn({ inputs: [{ text: 'x', typeRef: 'xsd:int' }] }));
      const { wb } = await importOk('bare.dmn');
      const { name, rows } = onlySheet(wb);
      const v = sheetView(rows);
      expect(v.at(v.M + 2, v.inputs[0])).toBe('xsd:int');
      const r = cli(['bare.xlsx', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(r.stderr).not.toMatch(/^\s+at /m);
      expect(r.stderr).toMatch(/unknown typeRef 'xsd:int'/i);
      expect(r.stderr).toContain(`${name}!${colLetter(v.inputs[0])}${v.M + 3}`);
    });

    it('IMPORT-092 table with zero rules', async () => {
      writeDmn('bare.dmn', bareDmn({ rules: [] }));
      const { wb } = await importOk('bare.dmn');
      const { name, rows } = onlySheet(wb);
      const v = sheetView(rows);
      expect(v.row(4)).toEqual(['', '']);
      const r = cli(['bare.xlsx', '--out-dir', 'out']);
      expectCleanFail(r);
      expect(r.stderr).toMatch(new RegExp(`no rules found in "?${name}`, 'i'));
      expect(existsSync(p('out', 'BARE.dmn'))).toBe(false);
    });

    it('IMPORT-093 table with zero inputs', async () => {
      writeDmn('bare.dmn', bareDmn({ inputs: [], rules: [{ in: [], out: ['"one"'] }] }));
      await importOk('bare.dmn');
      convertOk('bare.xlsx', 'out');
      const xml = readText(p('out', 'BARE.dmn'));
      await parseDmn(xml);
      expect(xml).not.toMatch(/<input[\s>]/);
    });

    it('IMPORT-094 Modeler PRIORITY table without outputValues', async () => {
      writeDmn('dish.dmn', D_MODELER_C7.replace('hitPolicy="FIRST"', 'hitPolicy="PRIORITY"'));
      await importOk('dish.dmn');
      const r = cli(['dish.xlsx', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(r.stderr).not.toMatch(/^\s+at /m);
      expect(r.stderr).toMatch(/PRIORITY'? requires/i);
      expect(r.stderr).toContain('dish');
    });

    it('IMPORT-095 C8 file with a C7-only hit policy', async () => {
      writeDmn('risk.dmn', modelerC8({ hitPolicy: 'OUTPUT ORDER', outputValues: '"LOW","HIGH"' }));
      const { r: imp } = await importOk('risk.dmn');
      expect(imp.stdout).toContain('--platform camunda8');
      const r = cli(['risk.xlsx', '--platform', 'camunda8', '--out-dir', 'out']);
      expect(r.code).toBe(1);
      expect(r.stderr).not.toMatch(/^\s+at /m);
      expect(r.stderr).toMatch(/not supported by Camunda 8/i);
    });
  });

  describe('F. Multiple decisions and sheet naming', () => {
    it('IMPORT-096 multiple decision tables => one sheet each, in document order', async () => {
      writeDmn('drd.dmn', multiDmn());
      const { r, wb } = await importOk('drd.dmn');
      expect(r.stdout).toMatch(/\b2\b.*decision/i);
      const names = Object.keys(wb);
      expect(names).toHaveLength(2);
      expect(names[0]).toContain('Eligibility');
      expect(names[1]).toContain('Offer');
      const expected = [
        ['Eligibility', ['age', 'eligible']],
        ['Offer', ['eligible', 'offer']],
      ];
      names.forEach((n, k) => {
        expect(n).toContain('DMN');
        const v = sheetView(wb[n]);
        expect(v.cols('policy')).toHaveLength(1);
        expect(v.at(v.M + 1, v.cols('id')[0])).toBe(expected[k][0]);
        expect(v.row(1)).toEqual(expected[k][1]);
        expect(v.row(4)[0]).not.toBe('');
        expect(v.row(5)[0]).not.toBe('');
      });
    });

    it('IMPORT-097 multi-decision workbook converts back to one file per decision', async () => {
      writeDmn('drd.dmn', multiDmn());
      await importOk('drd.dmn');
      convertOk('drd.xlsx', 'out2');
      expect(listFiles(p('out2'))).toEqual(['ELIGIBILITY.dmn', 'OFFER.dmn']);
      for (const f of listFiles(p('out2'))) {
        const xml = readText(p('out2', f));
        const defs = await parseDmn(xml);
        expect(defs.drgElement.filter((e) => e.$type === 'dmn:Decision')).toHaveLength(1);
        expect(xml).not.toContain('informationRequirement');
        expect(xml).not.toContain('inputData');
      }
    });

    it('IMPORT-098 a multi-sheet workbook round-trips per sheet', async () => {
      await book('multi_DMN.xlsx', {
        'Fees DMN': feesSheet(),
        'Sum DMN': sumSheet('SUM'),
        Notes: [['just notes']],
      });
      convertOk('multi_DMN.xlsx', 'out1');
      expect(listFiles(p('out1'))).toEqual(['FEES.dmn', 'SURCHARGES.dmn']);
      for (const id of ['FEES', 'SURCHARGES']) {
        await importOk(`out1/${id}.dmn`, `back_${id}.xlsx`);
        convertOk(`back_${id}.xlsx`, `out2_${id}`);
        const xml2 = readText(p(`out2_${id}`, `${id}.dmn`));
        await parseDmn(xml2);
        expect(xml2, id).toBe(readText(p('out1', `${id}.dmn`)));
      }
    });

    it('IMPORT-099 decision tables mixed with a literal-expression decision', async () => {
      writeDmn('mixed.dmn', D_MIXED);
      const { r, wb } = await importOk('mixed.dmn');
      const { name } = onlySheet(wb);
      expect(name).toContain('Eligibility');
      expect(r.stdout).toMatch(/\b1\b.*decision/i);
    });

    it('IMPORT-100 two decisions with the same name get distinct sheets', async () => {
      writeDmn('drd.dmn', multiDmn(['Rules', 'Rules']));
      const { wb } = await importOk('drd.dmn');
      const names = Object.keys(wb);
      expect(names).toHaveLength(2);
      expect(new Set(names).size).toBe(2);
      for (const n of names) expect(n).toContain('DMN');
      convertOk('drd.xlsx', 'out2');
      expect(listFiles(p('out2'))).toEqual(['ELIGIBILITY.dmn', 'OFFER.dmn']);
    });

    it('IMPORT-101 long decision name keeps DMN in the 31-char sheet name', async () => {
      const long = 'Very Long Shipping Rate Decision Name 2026';
      writeDmn('bare.dmn', bareDmn({ name: long }));
      const { wb } = await importOk('bare.dmn');
      const { name } = onlySheet(wb);
      expect(name.length).toBeLessThanOrEqual(31);
      expect(name).toContain('DMN');
      convertOk('bare.xlsx', 'out');
      const { decision } = await tableOf(readText(p('out', 'BARE.dmn')));
      expect(decision.name).toBe(long);
    });

    it('IMPORT-102 decision name with characters illegal in sheet names', async () => {
      const odd = 'Rates: EU/US [v2]?*';
      writeDmn('bare.dmn', bareDmn({ name: odd }));
      const { wb } = await importOk('bare.dmn');
      const { name, rows } = onlySheet(wb);
      expect(name).toContain('DMN');
      expect(name).not.toMatch(/[:\\/?*[\]]/);
      const v = sheetView(rows);
      expect(v.at(v.M + 1, v.cols('name')[0])).toBe(odd);
      convertOk('bare.xlsx', 'out');
      const { decision } = await tableOf(readText(p('out', 'BARE.dmn')));
      expect(decision.name).toBe(odd);
    });

    it('IMPORT-103 decision name already containing "DMN"', async () => {
      writeDmn('bare.dmn', bareDmn({ name: 'Pricing DMN' }));
      const { wb } = await importOk('bare.dmn');
      expect(onlySheet(wb).name).toBe('Pricing DMN');
    });
  });

  describe('G. Errors', () => {
    it('IMPORT-104 missing input file', () => {
      const r = cli(['import', 'nope.dmn']);
      expect(r.code).toBe(1);
      expectCleanFail(r);
      expect(r.stderr).toContain('nope.dmn');
      expect(r.stderr).toMatch(/ENOENT|not found|does not exist|no such file|cannot be read/i);
      expectNoXlsx();
    });

    it('IMPORT-105 input is a directory', () => {
      mkdirSync(p('dir.dmn'));
      const r = cli(['import', 'dir.dmn']);
      expect(r.code).toBe(1);
      expectCleanFail(r);
      expect(r.stderr).toContain('dir.dmn');
      expectNoXlsx();
    });

    it('IMPORT-106 malformed XML', async () => {
      const dmn = await feesDmn();
      const xml = readText(p(dmn));
      writeFileSync(p('bad.dmn'), xml.slice(0, xml.indexOf('<decisionTable') + 8), 'utf8');
      const r = cli(['import', 'bad.dmn']);
      expect(r.code).toBe(1);
      expectCleanFail(r);
      expect(r.stderr).toMatch(/well-formed|could not be parsed|unparsable|parse error|line \d+/i);
      expect(existsSync(p('bad.xlsx'))).toBe(false);
    });

    it('IMPORT-107 empty file', () => {
      writeFileSync(p('empty.dmn'), '');
      const r = cli(['import', 'empty.dmn']);
      expect(r.code).toBe(1);
      expectCleanFail(r);
      expect(r.stderr).toMatch(/empty|well-formed|could not be parsed|unparsable|parse/i);
      expectNoXlsx();
    });

    it('IMPORT-108 XML that is not DMN (e.g. BPMN)', () => {
      writeDmn(
        'process.dmn',
        `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="true"><bpmn:startEvent id="Start_1" /></bpmn:process>
</bpmn:definitions>
`,
      );
      const r = cli(['import', 'process.dmn']);
      expect(r.code).toBe(1);
      expectCleanFail(r);
      // Either "no decision table" or "the root is not DMN <definitions>" is acceptable.
      expect(r.stderr).toMatch(/no .*decision ?table|decisionTable|not (a )?DMN|dmn:Definitions/i);
      expectNoXlsx();
    });

    it('IMPORT-109 DMN 1.1 / 1.2 namespace', () => {
      for (const [version, ns] of [
        ['1.1', 'http://www.omg.org/spec/DMN/20151101/dmn.xsd'],
        ['1.2', 'http://www.omg.org/spec/DMN/20180521/MODEL/'],
      ]) {
        writeDmn('old.dmn', D_MODELER_C7.replace(`xmlns="${MODEL_NS}"`, `xmlns="${ns}"`));
        const r = cli(['import', 'old.dmn']);
        expect(r.code).toBe(1);
        expectCleanFail(r);
        expect(r.stderr).toContain('old.dmn');
        expect(r.stderr).toContain(`DMN ${version}`);
        expect(r.stderr).toContain('not DMN 1.3');
        expectNoXlsx();
      }
    });

    it('IMPORT-110 only a literal-expression decision', () => {
      writeDmn('lit.dmn', D_LITERAL);
      const r = cli(['import', 'lit.dmn']);
      expect(r.code).toBe(1);
      expectCleanFail(r);
      expect(r.stderr).toMatch(/No <decision> with a <decisionTable>|no decision table/i);
      expectNoXlsx();
    });

    it('IMPORT-111 definitions with no decisions at all', () => {
      writeDmn(
        'input.dmn',
        defsDoc('\n  <inputData id="Applicant" name="Applicant" />', 'onlyInput'),
      );
      const r = cli(['import', 'input.dmn']);
      expect(r.code).toBe(1);
      expectCleanFail(r);
      expect(r.stderr).toMatch(/No <decision> with a <decisionTable>|no decision table/i);
      expectNoXlsx();
    });

    it('IMPORT-112 --config file missing or invalid', () => {
      writeDmn('bare.dmn', bareDmn());
      const missing = cli(['import', 'bare.dmn', '--config', 'missing.json']);
      expect(missing.code).toBe(1);
      expectCleanFail(missing);
      expect(missing.stderr).toContain('missing.json');
      expectNoXlsx();

      writeJson('bad.json', { header: { labelOffset: 'x' } });
      const bad = cli(['import', 'bare.dmn', '--config', 'bad.json']);
      expect(bad.code).toBe(1);
      expectCleanFail(bad);
      expect(bad.stderr).toMatch(/labelOffset/);
      expectNoXlsx();
    });

    it.skipIf(process.platform === 'win32')('IMPORT-113 output path not writable', async () => {
      writeDmn('bare.dmn', bareDmn());
      let target;
      if (process.getuid?.() === 0) {
        // root ignores directory permissions: use a regular file as the "directory".
        writeFileSync(p('locked'), 'not a directory');
        target = 'locked/x.xlsx';
      } else {
        mkdirSync(p('locked'));
        chmodSync(p('locked'), 0o555);
        target = 'locked/x.xlsx';
      }
      try {
        const r = cli(['import', 'bare.dmn', '-o', target]);
        expect(r.code).toBe(1);
        expectCleanFail(r);
        expect(r.stderr).toContain(join('locked', 'x.xlsx'));
        expect(existsSync(p(target))).toBe(false);
      } finally {
        if (process.getuid?.() !== 0) chmodSync(p('locked'), 0o755);
      }
    });

    it('IMPORT-114 DMN with a UTF-8 BOM and CRLF line endings', async () => {
      writeDmn('dish.dmn', `﻿${D_MODELER_C7.replace(/\n/g, '\r\n')}`);
      const { wb } = await importOk('dish.dmn');
      writeDmn('plain.dmn', D_MODELER_C7);
      const { wb: base } = await importOk('plain.dmn');
      expect(wb).toEqual(base);
    });
  });

  describe('H. Config-aware import', () => {
    it('IMPORT-115 renamed markers are used in the imported sheet', async () => {
      const markers = { id: 'KEY', input: 'in', output: 'out', policy: 'hp', annotations: 'notes' };
      writeJson('m.json', { markers });
      const rename = { policy: 'hp', ID: 'KEY', input: 'in', output: 'out', annotations: 'notes' };
      const sheet = feesSheet({
        edit: (cols) => cols.forEach((c) => (c.marker = rename[c.marker] ?? c.marker)),
      });
      const { xml1, xml2, back } = await roundTrip({
        sheets: { 'Fees DMN': sheet },
        flags: ['--config', 'm.json'],
      });
      const v = sheetView(onlySheet(back).rows, { input: 'in', output: 'out' });
      for (const m of ['KEY', 'in', 'out', 'hp', 'notes']) expect(v.markers).toContain(m);
      for (const m of ['policy', 'input', 'output', 'annotations'])
        expect(v.markers.map((x) => x.toLowerCase())).not.toContain(m);
      expect(v.cols('id')).toEqual([]);
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-116 custom header offsets are respected', async () => {
      writeJson('o.json', { header: { nameOffset: 1, typeOffset: 3, labelOffset: 2 } });
      const rows = feesSheet();
      [rows[2], rows[3]] = [rows[3], rows[2]]; // label at M+2, type at M+3
      const { xml1, xml2, back } = await roundTrip({
        sheets: { 'Fees DMN': rows },
        flags: ['--config', 'o.json'],
      });
      const v = sheetView(onlySheet(back).rows);
      expect(v.row(2)).toEqual(['Amount', 'Region', 'Tags', 'Fee', 'Tier']);
      expect(v.row(3)).toEqual(['integer', 'string', 'Any', 'double', 'string']);
      expect(xml2).toBe(xml1);
    });

    it('IMPORT-117 custom types.anyKeyword is used for untyped columns', async () => {
      writeJson('k.json', { types: { anyKeyword: 'any' } });
      writeDmn('risk.dmn', modelerC8());
      const { wb } = await importOk('risk.dmn', undefined, ['--config', 'k.json']);
      const v = sheetView(onlySheet(wb).rows);
      expect(v.row(2, v.inputs)).toEqual(['number', 'any', 'any']);
    });

    it('IMPORT-118 explicit allowed-values config is used as-is', async () => {
      writeJson('av.json', ALLOWED_VALUES_LAYOUT);
      const dmn = await feesDmn({ av: true, flags: ['--config', 'av.json'] });
      const { r, wb } = await importOk(dmn, 'back.xlsx', ['--config', 'av.json']);
      const v = sheetView(onlySheet(wb).rows);
      expect(v.row(3)).toEqual(['[0..10000]', '"EU","US"', '', '', '"LOW","HIGH"']);
      expect(v.row(4)).toEqual(['Amount', 'Region', 'Tags', 'Fee', 'Tier']);
      expect(v.row(5)).toEqual(['< 100', '"EU"', '', '1.5', '"LOW"']);
      expect(r.stdout).not.toContain('allowedValuesOffset');
    });
  });

  describe('I. Programmatic API', () => {
    const cfg = (overrides) => loadConfig({ cwd: tmp.dir, overrides });

    it('IMPORT-119 dmnToModels reports __platform for C8', async () => {
      const xml = readText(p(await feesDmn({ c8: true })));
      const [m] = await dmnToModels(xml, cfg());
      expect(m.__platform).toBe('camunda8');
      expect(m.decisions[0].id).toBe('FEES');
      expect(m.decisions[0].inputs.map((i) => i.typeRef)).toEqual([
        'number',
        'string',
        'Any',
        'dateTime',
      ]);
    });

    it('IMPORT-120 dmnToModels reports camunda7 for C7 and modeler "Camunda Platform"', async () => {
      const c7 = readText(p(await feesDmn()));
      for (const xml of [c7, D_MODELER_C7, bareDmn()]) {
        const [m] = await dmnToModels(xml, cfg());
        expect(m.__platform).toBe('camunda7');
      }
    });

    it('IMPORT-121 README recipe rebuilds a C8 file byte-identically', async () => {
      const xml = readText(p(await feesDmn({ c8: true })));
      const [model] = await dmnToModels(xml, cfg());
      const out = await buildDmn(model, cfg({ platform: model.__platform }));
      await parseDmn(out);
      expect(out).toBe(xml);
    });

    it('IMPORT-122 buildDmn never switches platform on its own', async () => {
      const xml = readText(p(await feesDmn({ c8: true })));
      const [model] = await dmnToModels(xml, cfg());
      const out = await buildDmn(model, cfg());
      await parseDmn(out);
      expect(out).toContain('camunda:historyTimeToLive="P180D"');
      expect(out).not.toContain('modeler:');
    });

    it('IMPORT-123 README recipe on a C7 file rebuilds byte-identically', async () => {
      const xml = readText(p(await feesDmn()));
      const [model] = await dmnToModels(xml, cfg());
      const out = await buildDmn(model, cfg({ platform: model.__platform }));
      expect(out).toBe(xml);
    });

    it('IMPORT-124 dmnToModels returns one model per decision table', async () => {
      const multi = await dmnToModels(multiDmn(), cfg());
      expect(multi).toHaveLength(2);
      expect(multi.map((m) => m.decisions.length)).toEqual([1, 1]);
      expect(multi.map((m) => m.decisions[0].id)).toEqual(['Eligibility', 'Offer']);
      const mixed = await dmnToModels(D_MIXED, cfg());
      expect(mixed).toHaveLength(1);
      expect(mixed[0].decisions).toHaveLength(1);
      expect(mixed[0].decisions[0].id).toBe('Eligibility');
    });

    it('IMPORT-125 imported model shape matches §4', async () => {
      const xml = readText(p(await feesDmn()));
      const [m] = await dmnToModels(xml, cfg());
      expect(m.definitions).toEqual({
        id: 'definitions_FEES',
        name: 'Fee Decision',
        namespace: 'http://camunda.org/schema/1.0/dmn',
      });
      const d = m.decisions[0];
      expect(d.hitPolicy).toBe('UNIQUE');
      expect(d.aggregation).toBeNull();
      expect(d.inputs).toEqual([
        { label: 'Amount', expression: 'amount', typeRef: 'integer', allowedValues: null },
        { label: 'Region', expression: 'region', typeRef: 'string', allowedValues: null },
        { label: 'Tags', expression: 'tags', typeRef: 'Any', allowedValues: null },
      ]);
      expect(d.rules.map((r) => r.id)).toEqual(['rule_1', 'rule_2']);
      expect(d.rules[0].inputEntries).toEqual(['< 100', '"EU"', '']);
      expect(d.rules[0].description).toBe('small EU');
      expect('description' in d.rules[1]).toBe(false);
    });

    it('IMPORT-126 importDmn with write: false writes nothing', async () => {
      const xml = readText(p(await feesDmn()));
      const res = await importDmn(join(tmp.dir, 'x.dmn'), { config: cfg(), xml, write: false });
      expect(res.path).toBe(join(tmp.dir, 'x.xlsx'));
      expect(res.models).toHaveLength(1);
      expect(res.platform).toBe('camunda7');
      expect(existsSync(res.path)).toBe(false);
    });

    it('IMPORT-127 importDmn returns the detected platform and writes the workbook', async () => {
      const dmn = p(await feesDmn({ c8: true }));
      const res = await importDmn(dmn, { config: cfg(), out: join(tmp.dir, 'b.xlsx') });
      expect(res.platform).toBe('camunda8');
      expect(existsSync(p('b.xlsx'))).toBe(true);
      const c8 = cfg({ platform: 'camunda8' });
      const [model] = await parseWorkbook(p('b.xlsx'), c8);
      const out = await buildDmn(model, c8);
      await parseDmn(out);
      expect(out).toBe(readText(dmn));
    });

    it('IMPORT-128 modelsToWorkbook + parseWorkbook are inverse on models', async () => {
      writeJson('av.json', ALLOWED_VALUES_LAYOUT);
      const xml = readText(p(await feesDmn({ av: true, flags: ['--config', 'av.json'] })));
      const c = cfg(ALLOWED_VALUES_LAYOUT);
      const models = await dmnToModels(xml, c);
      await modelsToWorkbook(models, c, p('inv.xlsx'));
      const again = await parseWorkbook(p('inv.xlsx'), c);
      expect(again).toHaveLength(models.length);
      const pick = (d) => ({
        id: d.id,
        name: d.name,
        hitPolicy: d.hitPolicy,
        aggregation: d.aggregation,
        inputs: d.inputs,
        outputs: d.outputs,
        rules: d.rules.map((r) => ({
          inputEntries: r.inputEntries,
          outputEntries: r.outputEntries,
          description: r.description,
        })),
      });
      again.forEach((m, k) => expect(pick(m.decisions[0])).toEqual(pick(models[k].decisions[0])));
    });
  });
});
