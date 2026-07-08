// Write intermediate model(s) back into the Excel template (4-row, or 5-row when allowed-values enabled).
import ExcelJS from 'exceljs';

function ensureDmnName(name, marker) {
  return /dmn/i.test(name) ? name : `${name} ${marker}`;
}

/** Build a workbook from models and write it. One sheet per model. */
export async function modelsToWorkbook(models, cfg, outPath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'excel2dmn';
  const m = cfg.markers;
  const H = cfg.header;

  for (const model of models) {
    const d = model.decisions[0];
    const sheetName = ensureDmnName(d.name || d.id, m.id === 'ID' ? 'DMN' : 'DMN');
    const ws = wb.addWorksheet(sheetName.slice(0, 31)); // Excel sheet-name limit

    const hasAnnotations = d.rules.some((r) => r.description);
    const columns = [
      { marker: m.policy, name: d.hitPolicy, type: '', label: '', allowed: '' },
      { marker: m.id, name: d.id, type: '', label: '', allowed: '' },
      ...(d.name && d.name !== d.id
        ? [{ marker: m.name, name: d.name, type: '', label: '', allowed: '' }]
        : []),
      ...d.inputs.map((i) => ({
        marker: m.input,
        name: i.expression,
        type: i.typeRef,
        label: i.label || '',
        allowed: i.allowedValues || '',
        kind: 'input',
      })),
      ...d.outputs.map((o) => ({
        marker: m.output,
        name: o.name,
        type: o.typeRef,
        label: o.label || '',
        allowed: o.allowedValues || '',
        kind: 'output',
      })),
      ...(hasAnnotations
        ? [
            {
              marker: m.annotations,
              name: '',
              type: '',
              label: 'Comment',
              allowed: '',
              kind: 'annotation',
            },
          ]
        : []),
    ];

    // header rows
    columns.forEach((c, idx) => {
      const col = idx + 1;
      ws.getCell(1, col).value = c.marker || null;
      ws.getCell(1 + H.nameOffset, col).value = c.name || null;
      ws.getCell(1 + H.typeOffset, col).value = c.type || null;
      ws.getCell(1 + H.labelOffset, col).value = c.label || null;
      if (H.allowedValuesOffset != null)
        ws.getCell(1 + H.allowedValuesOffset, col).value = c.allowed || null;
    });

    // rule rows
    const startRow = 1 + cfg.rules.startOffset;
    d.rules.forEach((rule, ri) => {
      let ci = 0;
      for (const c of columns) {
        ci += 1;
        if (c.kind === 'input') {
          const i = d.inputs.findIndex((x) => x.expression === c.name);
          ws.getCell(startRow + ri, ci).value = rule.inputEntries[i] || null;
        } else if (c.kind === 'output') {
          const oi = d.outputs.findIndex((x) => x.name === c.name);
          ws.getCell(startRow + ri, ci).value = rule.outputEntries[oi] || null;
        } else if (c.kind === 'annotation') {
          ws.getCell(startRow + ri, ci).value = rule.description || null;
        }
      }
    });

    // styling
    const fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    const headerRows =
      H.allowedValuesOffset != null ? H.allowedValuesOffset + 1 : H.labelOffset + 1;
    for (let r = 1; r <= headerRows; r++)
      for (let c = 1; c <= columns.length; c++) ws.getCell(r, c).fill = fill;
    ws.views = [{ state: 'frozen', ySplit: headerRows }];
    columns.forEach((_, i) => (ws.getColumn(i + 1).width = 18));
  }

  await wb.xlsx.writeFile(outPath);
  return outPath;
}
