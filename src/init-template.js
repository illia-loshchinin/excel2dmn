// `excel2dmn init` — write a ready-to-fill starter workbook. Spec §7.2.
import ExcelJS from 'exceljs';
import { toNcNameId } from './ids.js';

export async function writeTemplate(
  outPath,
  cfg,
  { name = 'My Decision', sheetName, minimal = false } = {},
) {
  const m = cfg.markers;
  const sheet = sheetName || 'My Decision_ DMN';
  const wb = new ExcelJS.Workbook();
  wb.creator = 'excel2dmn';
  const ws = wb.addWorksheet(sheet);

  // Column layout: policy | ID | name | input1 | input2 | output1 | Annotations
  const cols = [
    { marker: m.policy, name: cfg.hitPolicy.default, type: '', label: '', allowed: '' },
    { marker: m.id, name: toNcNameId(name), type: '', label: '', allowed: '' },
    { marker: m.name, name, type: '', label: '', allowed: '' },
    { marker: m.input, name: 'input1', type: 'string', label: 'Input 1', allowed: '"A","B"' },
    { marker: m.input, name: 'input2', type: 'integer', label: 'Input 2', allowed: '' },
    { marker: m.output, name: 'output1', type: 'string', label: 'Output 1', allowed: '"X","Y"' },
  ];
  if (!minimal)
    cols.push({ marker: m.annotations, name: '', type: '', label: 'Comment', allowed: '' });

  const H = cfg.header;
  cols.forEach((c, i) => {
    const col = i + 1;
    ws.getCell(1, col).value = c.marker || null;
    ws.getCell(1 + H.nameOffset, col).value = c.name || null;
    ws.getCell(1 + H.typeOffset, col).value = c.type || null;
    ws.getCell(1 + H.labelOffset, col).value = c.label || null;
    if (H.allowedValuesOffset != null)
      ws.getCell(1 + H.allowedValuesOffset, col).value = c.allowed || null;
  });

  if (!minimal) {
    const rowStart = 1 + cfg.rules.startOffset;
    const examples = [
      ['', '', '', '"A"', '< 10', '"X"', 'small A'],
      ['', '', '', '"B"', '>= 10', '"Y"', 'big B'],
    ];
    examples.forEach((r, ri) =>
      r.forEach((v, ci) => (ws.getCell(rowStart + ri, ci + 1).value = v || null)),
    );
  }

  // Instructions helper (spec §7.2): one cell, a blank column right of the table. Its text
  // is not a marker keyword, so the converter ignores the column.
  const help = ws.getCell(1, cols.length + 2);
  help.value = instructions(cfg);
  help.alignment = { wrapText: true, vertical: 'top' };
  ws.getColumn(cols.length + 2).width = 70;

  // light styling
  const fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
  const rows = H.allowedValuesOffset != null ? H.allowedValuesOffset + 1 : H.labelOffset + 1;
  for (let r = 1; r <= rows; r++)
    for (let c = 1; c <= cols.length; c++) ws.getCell(r, c).fill = fill;
  ws.views = [{ state: 'frozen', ySplit: rows }];
  cols.forEach((_, i) => (ws.getColumn(i + 1).width = 16));

  await wb.xlsx.writeFile(outPath);
  return outPath;
}

/** Instructions text for the helper cell, using the configured marker keywords and offsets. */
function instructions(cfg) {
  const m = cfg.markers;
  const H = cfg.header;
  const lines = [
    'How to fill this sheet (this column is ignored by excel2dmn):',
    `Row 1 holds the markers; below each marker, row ${1 + H.nameOffset} holds the technical name, ` +
      `row ${1 + H.typeOffset} the type and row ${1 + H.labelOffset} the label` +
      (H.allowedValuesOffset != null
        ? ` (row ${1 + H.allowedValuesOffset}: allowed values).`
        : '.'),
    `"${m.policy}": hit policy (e.g. UNIQUE, FIRST, COLLECT).`,
    `"${m.id}": decision id (also the .dmn file name); "${m.name}": decision name.`,
    `"${m.input}": an input column; "${m.output}": an output column (at least one).`,
    `"${m.annotations}": free-text rule description.`,
    `Rules start at row ${1 + cfg.rules.startOffset}, one rule per row; "-" or an empty input cell means any value.`,
    'Quote string outputs, e.g. "X".',
  ];
  return lines.join('\n');
}
