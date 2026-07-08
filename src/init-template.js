// `excel2dmn init` — write a ready-to-fill starter workbook. Spec §7.2.
import ExcelJS from 'exceljs';

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
    { marker: m.id, name: idFromName(name), type: '', label: '', allowed: '' },
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

function idFromName(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}
