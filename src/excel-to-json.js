// Stage A: parse a workbook into intermediate models (one per DMN sheet). Spec §5.
import ExcelJS from 'exceljs';
import { existsSync } from 'node:fs';
import { toNcNameId, cellRef, dedupe } from './ids.js';
import { ProblemCollector } from './errors.js';
import { createEntryValidator, isStringLiteral, analyzeFeel } from './feel-validate.js';
import { parseDomain, outOfDomain } from './domain.js';
import { isAnyType, C8_UNSUPPORTED_HIT_POLICIES } from './config.js';

const AGGREGATORS = ['SUM', 'MIN', 'MAX', 'COUNT'];

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
  return (s) =>
    ci
      ? String(s ?? '')
          .trim()
          .toLowerCase()
      : String(s ?? '').trim();
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
    id: nm(m.id),
    name: nm(m.name),
    input: nm(m.input),
    output: nm(m.output),
    policy: nm(m.policy),
    annotations: nm(m.annotations),
  };

  const M = findMarkerRow(ws, cfg);
  if (!M)
    throw new Error(
      `No input/output marker row found in "${ws.name}" (scanned first ${cfg.header.scanRows} rows)`,
    );

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
        idCol = desc;
        break;
      case kw.name:
        if (nameCol) problems.add('more than one name column', cellRef(ws.name, M, c));
        nameCol = desc;
        break;
      case kw.policy:
        if (policyCol) problems.add('more than one policy column', cellRef(ws.name, M, c));
        policyCol = desc;
        break;
      case kw.input:
        inputs.push(desc);
        break;
      case kw.output:
        outputs.push(desc);
        break;
      case kw.annotations:
        annotationCols.push(desc);
        break;
      default:
        break;
    }
  }

  if (!idCol) problems.add(`missing required ${m.id} marker column`);
  else if (!idCol.name)
    problems.add(
      `${m.id} column has no value`,
      cellRef(ws.name, M + cfg.header.nameOffset, idCol.col),
    );
  if (outputs.length === 0) problems.add('no output column found (DMN requires ≥1 output)');
  // DMN allows a table without inputs (every rule always matches) — legal but rarely intended.
  if (inputs.length === 0)
    warnings.push({ message: 'no input columns found — every rule matches unconditionally' });

  // Clause ids are derived from the technical names (§6.4), so they must be unique per sheet.
  const nameCells = new Map();
  for (const d of [...inputs, ...outputs].sort((a, b) => a.col - b.col)) {
    if (!d.name) continue;
    const ref = cellRef(ws.name, M + cfg.header.nameOffset, d.col);
    if (nameCells.has(d.name))
      problems.add(
        `duplicate technical name '${d.name}' (already used at ${nameCells.get(d.name)})`,
        ref,
      );
    else nameCells.set(d.name, ref);
  }

  for (const d of [...inputs, ...outputs]) {
    const role = inputs.includes(d) ? 'input' : 'output';
    if (!d.name)
      problems.add(
        `missing technical name for ${role}`,
        cellRef(ws.name, M + cfg.header.nameOffset, d.col),
      );
    if (!d.typeRef)
      problems.add(
        `missing typeRef for ${role} '${d.name}'`,
        cellRef(ws.name, M + cfg.header.typeOffset, d.col),
      );
    else if (!cfg.types.allowed.includes(d.typeRef) && !isAnyType(d.typeRef, cfg))
      problems.add(
        `unknown typeRef '${d.typeRef}'`,
        cellRef(ws.name, M + cfg.header.typeOffset, d.col),
      );
    else if (
      // Camunda 8's FEEL engine supports the full DMN type set, so the narrow
      // decision-table type restriction only applies to Camunda 7.
      cfg.platform !== 'camunda8' &&
      cfg.types.nonCamundaTypeAction !== 'off' &&
      !isAnyType(d.typeRef, cfg) &&
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

  const hitPolicy = (
    policyCol && policyCol.name ? policyCol.name : cfg.hitPolicy.default
  ).toUpperCase();
  let aggregation = null;
  if (hitPolicy === 'COLLECT' && policyCol) {
    const aggRow = M + cfg.hitPolicy.aggregatorOffset;
    aggregation = cellText(ws, aggRow, policyCol.col).toUpperCase() || null;
    if (aggregation && !AGGREGATORS.includes(aggregation))
      problems.add(
        `unknown COLLECT aggregator '${aggregation}' (expected ${AGGREGATORS.join(', ')})`,
        cellRef(ws.name, aggRow, policyCol.col),
      );
  }
  if (!cfg.hitPolicy.allowed.map((h) => h.toUpperCase()).includes(hitPolicy))
    problems.add(
      `unknown hit policy '${hitPolicy}' (expected one of ${cfg.hitPolicy.allowed.join(', ')})`,
    );
  // Camunda 8 does not implement the PRIORITY / OUTPUT ORDER hit policies.
  else if (cfg.platform === 'camunda8' && C8_UNSUPPORTED_HIT_POLICIES.includes(hitPolicy))
    problems.add(
      `hit policy '${hitPolicy}' is not supported by Camunda 8 (use COLLECT or RULE ORDER)`,
    );

  if (['PRIORITY', 'OUTPUT ORDER'].includes(hitPolicy)) {
    for (const o of outputs)
      if (!o.allowedValues)
        problems.add(
          `hit policy '${hitPolicy}' requires output allowed values for '${o.name}'`,
          cellRef(ws.name, M + avOffset, o.col),
        );
  }

  for (const d of [...inputs, ...outputs]) {
    if (d.allowedValues) {
      const err = check(d.allowedValues, d.typeRef, 'unary');
      if (err) problems.add(`allowed values: ${err}`, cellRef(ws.name, M + avOffset, d.col));
      else if (cfg.validation.enforceAllowedValues) d.domain = parseDomain(d.allowedValues);
    }
  }
  /** §3.6: report entry items outside the column's declared domain (when enforced). */
  const checkDomain = (d, role, text, unit, r) => {
    if (!d.domain) return;
    const bad = outOfDomain(text, d.domain, unit);
    if (bad.length)
      problems.add(
        `${role} '${d.name}': ${bad.join(', ')} is outside the allowed values ${d.allowedValues}`,
        cellRef(ws.name, r, d.col),
      );
  };

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
        if (cfg.validation.feel.mode === 'any-inputs' && !isAnyType(d.typeRef, cfg)) return;
        const err = check(inputEntries[i], d.typeRef, 'unary');
        if (err) problems.add(`input '${d.name}': ${err}`, cellRef(ws.name, r, d.col));
        else checkDomain(d, 'input', inputEntries[i], 'unary', r);
      });
    }
    outputs.forEach((d, i) => {
      let text = outputEntries[i];
      if (text === '') return;
      const loc = cellRef(ws.name, r, d.col);
      // §3b: a string output must be a quoted literal unless requireQuotes is off;
      // with autoQuote a raw value is wrapped before it is validated and emitted.
      const unquotedString = d.typeRef === 'string' && !isStringLiteral(text);
      if (unquotedString && !cfg.outputEntries.requireQuotes) {
        if (analyzeFeel(text, 'expression').hasError)
          problems.add(`output '${d.name}': invalid FEEL syntax`, loc);
        return;
      }
      if (unquotedString && cfg.outputEntries.autoQuote)
        text = outputEntries[i] = `"${text.replace(/^"|"$/g, '')}"`;
      const err = check(text, d.typeRef, 'expression');
      if (err) problems.add(`output '${d.name}': ${err}`, loc);
      else if (d.typeRef === 'string' && !isStringLiteral(text))
        problems.add(`output '${d.name}' must be a quoted string`, loc);
      else checkDomain(d, 'output', text, 'expression', r);
    });

    const description = annotationCols
      .map((d) => cellText(ws, r, d.col))
      .filter(Boolean)
      .join(m.annotationSeparator);

    seq += 1;
    const rule = {
      id: cfg.rules.idTemplate.replace('<n>', String(seq)).replace('<row>', String(r)),
      seq,
      row: r,
      inputEntries,
      outputEntries,
    };
    if (description) rule.description = description;
    rules.push(rule);
  }
  if (rules.length === 0)
    problems.add(`no rules found in "${ws.name}" (no data rows below the header)`);

  problems.throwIfAny(`Cannot convert sheet "${ws.name}":`);

  const decisionId = cfg.identity.sanitizeId
    ? toNcNameId(idCol.name, { upper: cfg.identity.idCase === 'upper' })
    : idCol.name;
  const uniqueId = dedupe(decisionId, seenDecisionIds, cfg.identity.collisionSuffix);
  const decisionName = nameCol && nameCol.name ? nameCol.name : idCol.name;

  return {
    definitions: {
      id: `definitions_${uniqueId}`,
      name: decisionName,
      namespace: cfg.output.namespace,
    },
    decisions: [
      {
        id: uniqueId,
        name: decisionName,
        hitPolicy,
        aggregation,
        inputs: inputs.map((d) => ({
          label: d.label || undefined,
          expression: d.name,
          typeRef: d.typeRef,
          allowedValues: d.allowedValues,
        })),
        outputs: outputs.map((d) => ({
          name: d.name,
          label: d.label || undefined,
          typeRef: d.typeRef,
          allowedValues: d.allowedValues,
        })),
        rules,
      },
    ],
    __warnings: warnings,
  };
}

/**
 * Parse every selected sheet independently (spec §7: atomic per sheet).
 * @returns {Promise<Array<{sheet:string, model?:object, error?:Error}>>} one entry per sheet
 */
export async function parseWorkbookSheets(path, cfg, { sheet } = {}) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(path);
  } catch (err) {
    // A missing file keeps its own message; anything else is an unreadable workbook.
    if (err.code === 'ENOENT' || !existsSync(path)) throw err;
    throw new Error(`${path} is not a valid .xlsx workbook (${err.message})`);
  }
  const sheets = selectSheets(workbook, cfg, sheet);
  if (sheets.length === 0) {
    const wanted = sheet && sheet.length ? sheet.map((n) => `"${n}"`).join(', ') : null;
    throw new Error(
      wanted
        ? `No sheet named ${wanted} matching "${cfg.sheet.value}" found in ${path}`
        : `No sheet matching "${cfg.sheet.value}" found in ${path}`,
    );
  }
  const seenDecisionIds = new Set();
  return sheets.map((ws) => {
    try {
      const model = parseSheet(ws, cfg, seenDecisionIds);
      model.__sheet = ws.name;
      return { sheet: ws.name, model };
    } catch (error) {
      return { sheet: ws.name, error };
    }
  });
}

/** Parse all selected sheets; throws the first sheet's error if any sheet is invalid. */
export async function parseWorkbook(path, cfg, options = {}) {
  const parsed = await parseWorkbookSheets(path, cfg, options);
  const failed = parsed.find((p) => p.error);
  if (failed) throw failed.error;
  return parsed.map((p) => p.model);
}

export { cellText };
