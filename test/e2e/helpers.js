// Shared harness for the end-to-end suites: build workbooks in code, run the
// real CLI, and re-parse the DMN it writes.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { reparse } from '../../src/index.js';

export const CLI = fileURLToPath(new URL('../../bin/excel2dmn.js', import.meta.url));

/** Fresh temp dir per test; call the returned cleanup in afterEach. */
export function tempDir(prefix = 'e2d-e2e-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Run the CLI as a user would. `args` excludes `node` and the script path.
 * Returns { code, stdout, stderr }. Never throws on a non-zero exit.
 */
export function runCli(args, { cwd, input } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Write an .xlsx from plain data. `sheets` maps sheet name -> 2D array of
 * cell values (row-major, starting at A1). `null`/`undefined` leaves a cell empty.
 */
export async function writeWorkbook(path, sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    rows.forEach((row, r) =>
      row.forEach((v, c) => {
        if (v != null) ws.getCell(r + 1, c + 1).value = v;
      }),
    );
  }
  await wb.xlsx.writeFile(path);
  return path;
}

/** Read an .xlsx back as { sheetName: 2D array of cell values }. */
export async function readWorkbook(path) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const out = {};
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: true }, (row, r) => {
      const vals = [];
      row.eachCell({ includeEmpty: true }, (cell, c) => (vals[c - 1] = cell.value));
      rows[r - 1] = vals;
    });
    out[ws.name] = rows;
  });
  return out;
}

/**
 * Build the rows of a decision-table sheet in the default 4-row layout
 * (marker / name / type / label), or the 5-row layout when any column has
 * `allowed` and `allowedValues: true` is passed (allowed-values row above the label).
 *
 * columns: [{ marker, name, type?, label?, allowed? }], rules: 2D array aligned to columns.
 */
export function decisionSheet(columns, rules = [], { allowedValues = false } = {}) {
  const rows = [
    columns.map((c) => c.marker),
    columns.map((c) => c.name ?? null),
    columns.map((c) => c.type ?? null),
  ];
  if (allowedValues) rows.push(columns.map((c) => c.allowed ?? null));
  rows.push(columns.map((c) => c.label ?? null));
  return [...rows, ...rules];
}

/** Config overrides that enable the 5-row allowed-values layout. */
export const ALLOWED_VALUES_LAYOUT = {
  header: { allowedValuesOffset: 3, labelOffset: 4 },
  rules: { startOffset: 5 },
};

/** Parse DMN XML with dmn-moddle; fails the test on any import warning. */
export async function parseDmn(xml) {
  const { rootElement, warnings } = await reparse(xml);
  if (warnings.length) {
    throw new Error(`DMN re-parse warnings:\n${warnings.map((w) => w.message).join('\n')}`);
  }
  return rootElement;
}

/** The first decision table of a parsed <definitions>. */
export function firstTable(definitions) {
  const decision = definitions.drgElement.find((e) => e.$type === 'dmn:Decision');
  return { decision, table: decision.decisionLogic };
}

export const readText = (p) => readFileSync(p, 'utf8');
export const listFiles = (dir) => readdirSync(dir).sort();
