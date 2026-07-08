// Stage A: parse a workbook into intermediate models (one per DMN sheet). Spec §5.
import ExcelJS from 'exceljs';
import { toNcNameId, cellRef, dedupe } from './ids.js';
import { ProblemCollector } from './errors.js';
import { createEntryValidator, isStringLiteral } from './feel-validate.js';

function cellText(ws, row, col) {
  const cell = ws.getCell(row, col);
  const v = cell.text;
  return v == null ? '' : String(v).trim();
}

export function selectSheets(workbook, cfg, only) {
  const { match, value, caseInsensitive } = cfg.sheet;
  const test = (name) => {
    const a = caseInsensitive ? name.toLowerCase() : name;
    const b = caseInsensitive ? value.toLowerCase() : value;
    if (match === 'exact') return a === b;
    if (match === 'regex') return new RegExp(value, caseInsensitive ? 'i' : '').test(name);
    return a.includes(b);
  };
  let sheets = workbook.worksheets.filter((ws) => test(ws.name));
  if (only && only.length) sheets = sheets.filter((ws) => only.includes(ws.name));
  return sheets;
}

function markerNormalizer(cfg) {
  const ci = cfg.markers.caseInsensitive !== false;
  return (s) => (ci ? String(s ?? '').trim().toLowerCase() : String(s ?? '').trim());
}

function findMarkerRow(ws, cfg) {
  const nm = markerNormalizer(cfg);
  const inputKw = nm(cfg.markers.input);
  const outputKw = nm(cfg.markers.output);
  for (let r = 1; r <= cfg.header.scanRows; r++) {
    for (let c = 1; c <= ws.columnCount; c++) {
      const t = nm(cellText(ws, r, c));
      if (t === inputKw || t === outputKw) return r;
    }
  }
  return 0;
}

export function parseSheet(ws, cfg, seenDecisionIds) {
  const problems = new ProblemCollector({ failFast: cfg.validation.feel.failFast });
  const warnings = [];
  const check = createEntryValidator(cfg);
  const m = cfg.markers;
  const nm = markerNormalizer(cfg);
  const kw = {
    id: nm(m.id), name: nm(m.name), input: nm(m.input),
    output: nm(m.output), policy: nm(m.policy), annotations: nm(m.annotations),
  };

  const M = findMarkerRow(ws, cfg);
  if (!M)
    throw new Error(`No input/output marker row found in "${ws.name}" (scanned first ${cfg.header.scanRows} rows)`);

  const inputs = [];
  const outputs = [];
  const annotationCols = [];
  let idCol = null;
  let nameCol = null;
  let policyCol = null;

  const avOffset = cfg.header.allowedValuesOffset;
  for (let c = 1; c <= ws.columnCount; c++) {
    const marker = nm(cellText(ws, M, c));
    if (!marker) continue;
    const desc = {
      col: c,
      name: cellText(ws, M + cfg.header.nameOffset, c),
      typeRef: cellText(ws, M + cfg.header.typeOffset, c),
      label: cellText(ws, M + cfg.header.labelOffset, c),
      allowedValues: avOffset == null ? null : cellText(ws, M + avOffset, c) || null,
    };
    switch (marker) {
      case kw.id:
        if (idCol) problems.add('more than one ID column', cellRef(ws.name, M, c));
        idCol = desc; break;
      case kw.name:
        if (nameCol) problems.add('more than one name column', cellRef(ws.name, M, c));
        nameCol = desc; break;
      case kw.policy:
        if (policyCol) problems.add('more than one policy column', cellRef(ws.name, M, c));
        policyCol = desc; break;
      case kw.input: inputs.push(desc); break;
      case kw.output: outputs.push(desc); break;
      case kw.annotations: annotationCols.push(desc); break;
      default: break;
    }
  }

  if (!idCol) problems.add(`missing required ${m.id} marker column`);
  else if (!idCol.name)
    problems.add(`${m.id} column has no value`, cellRef(ws.name, M + cfg.header.nameOffset, idCol.col));
  if (outputs.length === 0) problems.add('no output column found (DMN requires ≥1 output)');

  for (const d of [...inputs, ...outputs]) {
    const role = inputs.includes(d) ? 'input' : 'output';
    if (!d.name) problems.add(`missing technical name for ${role}`, cellRef(ws.name, M + cfg.header.nameOffset, d.col));
    if (!d.typeRef) problems.add(`missing typeRef for ${role} '${d.name}'`, cellRef(ws.name, M + cfg.header.typeOffset, d.col));
    else if (!cfg.types.allowed.includes(d.typeRef))
      problems.add(`unknown typeRef '${d.typeRef}'`, cellRef(ws.name, M + cfg.header.typeOffset, d.col));
    else if (
      cfg.types.nonCamundaTypeAction !== 'off' &&
      d.typeRef !== cfg.types.anyKeyword &&
      !cfg.types.camundaTypes.includes(d.typeRef)
    ) {
      const hint = cfg.types.numeric.includes(d.typeRef)
        ? " — Camunda's decision-table types are integer/long/double"
        : ' — not a Camunda decision-table type';
      const msg = `typeRef '${d.typeRef}' is valid DMN/FEEL but not a Camunda type${hint}`;
      const loc = cellRef(ws.name, M + cfg.header.typeOffset, d.col);
      if (cfg.types.nonCamundaTypeAction === 'error') problems.add(msg, loc);
      else warnings.push({ message: msg, location: loc });
    }
  }

  const hitPolicy = (policyCol && policyCol.name ? policyCol.name : cfg.hitPolicy.default).toUpperCase();
  let aggregation = null;
  if (hitPolicy === 'COLLECT' && policyCol)
    aggregation = cellText(ws, M + cfg.hitPolicy.aggregatorOffset, policyCol.col) || null;
  if (!cfg.hitPolicy.allowed.map((h) => h.toUpperCase()).includes(hitPolicy))
    problems.add(`unknown hit policy '${hitPolicy}'`);

  if (['PRIORITY', 'OUTPUT ORDER'].includes(hitPolicy)) {
    for (const o of outputs)
      if (!o.allowedValues)
        problems.add(`hit policy '${hitPolicy}' requires output allowed values for '${o.name}'`, cellRef(ws.name, M + avOffset, o.col));
  }

  for (const d of [...inputs, ...outputs]) {
    if (d.allowedValues) {
      const err = check(d.allowedValues, d.typeRef, 'unary');
      if (err) problems.add(`allowed values: ${err}`, cellRef(ws.name, M + avOffset, d.col));
    }
  }

  const io = [...inputs, ...outputs];
  const startRow = M + cfg.rules.startOffset;
  const rules = [];
  let seq = 0;
  const anyTokens = new Set(cfg.rules.anyInputTokens || []);
  const normInput = (t) => (anyTokens.has(t) ? cfg.rules.emitAnyInputAs : t);
  for (let r = startRow; r <= ws.rowCount + 1; r++) {
    const values = io.map((d) => cellText(ws, r, d.col));
    if (cfg.rules.stopOnEmptyRow && values.every((v) => v === '')) break;

    const inputEntries = inputs.map((d) => normInput(cellText(ws, r, d.col)));
    const outputEntries = outputs.map((d) => cellText(ws, r, d.col));

    if (cfg.validation.feel.mode !== 'off') {
      inputs.forEach((d, i) => {
        if (cfg.validation.feel.mode === 'any-inputs' && d.typeRef !== cfg.types.anyKeyword) return;
        const err = check(inputEntries[i], d.typeRef, 'unary');
        if (err) problems.add(`input '${d.name}': ${err}`, cellRef(ws.name, r, d.col));
      });
    }
    outputs.forEach((d, i) => {
      const text = outputEntries[i];
      if (text === '') return;
      const err = check(text, d.typeRef, 'expression');
      if (err) problems.add(`output '${d.name}': ${err}`, cellRef(ws.name, r, d.col));
      if (d.typeRef === 'string' && cfg.outputEntries.requireQuotes && !isStringLiteral(text)) {
        if (cfg.outputEntries.autoQuote) outputEntries[i] = `"${text.replace(/^"|"$/g, '')}"`;
        else problems.add(`output '${d.name}' must be a quoted string`, cellRef(ws.name, r, d.col));
      }
    });

    const description = annotationCols.map((d) => cellText(ws, r, d.col)).filter(Boolean).join(m.annotationSeparator);

    seq += 1;
    const rule = {
      id: cfg.rules.idTemplate.replace('<n>', String(seq)).replace('<row>', String(r)),
      seq, row: r, inputEntries, outputEntries,
    };
    if (description) rule.description = description;
    rules.push(rule);
  }
  if (rules.length === 0) problems.add(`no rules found in "${ws.name}" (no data rows below the header)`);

  problems.throwIfAny(`Cannot convert sheet "${ws.name}":`);

  const decisionId = cfg.identity.sanitizeId
    ? toNcNameId(idCol.name, { upper: cfg.identity.idCase === 'upper' })
    : idCol.name;
  const uniqueId = dedupe(decisionId, seenDecisionIds, cfg.identity.collisionSuffix);
  const decisionName = nameCol && nameCol.name ? nameCol.name : idCol.name;

  return {
    definitions: { id: `definitions_${uniqueId}`, name: decisionName, namespace: cfg.output.namespace },
    decisions: [
      {
        id: uniqueId, name: decisionName, hitPolicy, aggregation,
        inputs: inputs.map((d) => ({ label: d.label || undefined, expression: d.name, typeRef: d.typeRef, allowedValues: d.allowedValues })),
        outputs: outputs.map((d) => ({ name: d.name, label: d.label || undefined, typeRef: d.typeRef, allowedValues: d.allowedValues })),
        rules,
      },
    ],
    __warnings: warnings,
  };
}

export async function parseWorkbook(path, cfg, { sheet } = {}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheets = selectSheets(workbook, cfg, sheet);
  if (sheets.length === 0) throw new Error(`No sheet matching "${cfg.sheet.value}" found in ${path}`);
  const seenDecisionIds = new Set();
  const models = [];
  for (const ws of sheets) {
    const model = parseSheet(ws, cfg, seenDecisionIds);
    model.__sheet = ws.name;
    models.push(model);
  }
  return models;
}

export { cellText };
