// Write intermediate model(s) back into the Excel template (4-row, or 5-row when allowed-values enabled).
import ExcelJS from 'exceljs';

const SHEET_NAME_MAX = 31; // Excel sheet-name limit

/**
 * A sheet name for a decision that Excel accepts and that the converter picks up again:
 * characters Excel forbids (: \ / ? * [ ]) become '_', the name keeps "DMN" within the
 * 31-char limit (the base name is cut, not the suffix), and a clash with an earlier sheet
 * (Excel compares case-insensitively) gets a " 2", " 3", … suffix.
 */
function sheetNameFor(d, used) {
  const base =
    String(d.name || d.id)
      .replace(/[:\\/?*[\]]/g, '_')
      .replace(/^'+|'+$/g, '')
      .trim() || 'Decision';
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : ` ${n}`;
    let name = (/dmn/i.test(base) ? base : `${base} DMN`) + suffix;
    if (name.length > SHEET_NAME_MAX)
      name = `${base.slice(0, SHEET_NAME_MAX - 4 - suffix.length).trimEnd()} DMN${suffix}`;
    if (!used.has(name.toLowerCase())) {
      used.add(name.toLowerCase());
      return name;
    }
  }
}

/** Build a workbook from models and write it. One sheet per model. */
export async function modelsToWorkbook(models, cfg, outPath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'excel2dmn';
  const m = cfg.markers;
  const H = cfg.header;
  const usedSheetNames = new Set();

  for (const model of models) {
    const d = model.decisions[0];
    const ws = wb.addWorksheet(sheetNameFor(d, usedSheetNames));

    const hasAnnotations = d.rules.some((r) => r.description);
    const columns = [
      { marker: m.policy, name: d.hitPolicy, type: '', label: '', allowed: '' },
      { marker: m.id, name: d.id, type: '', label: '', allowed: '' },
      ...(d.name && d.name !== d.id
        ? [{ marker: m.name, name: d.name, type: '', label: '', allowed: '' }]
        : []),
      ...d.inputs.map((i, index) => ({
        marker: m.input,
        name: i.expression,
        type: i.typeRef,
        label: i.label || '',
        allowed: i.allowedValues || '',
        kind: 'input',
        index,
      })),
      ...d.outputs.map((o, index) => ({
        marker: m.output,
        name: o.name,
        type: o.typeRef,
        label: o.label || '',
        allowed: o.allowedValues || '',
        kind: 'output',
        index,
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
    // COLLECT aggregator (SUM/MIN/MAX/COUNT) sits in the policy column at M+aggregatorOffset.
    if (d.aggregation) ws.getCell(1 + cfg.hitPolicy.aggregatorOffset, 1).value = d.aggregation;

    // rule rows
    const startRow = 1 + cfg.rules.startOffset;
    d.rules.forEach((rule, ri) => {
      let ci = 0;
      for (const c of columns) {
        ci += 1;
        // Entries are positional: two clauses may share an expression or name.
        if (c.kind === 'input') {
          ws.getCell(startRow + ri, ci).value = rule.inputEntries[c.index] || null;
        } else if (c.kind === 'output') {
          ws.getCell(startRow + ri, ci).value = rule.outputEntries[c.index] || null;
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
