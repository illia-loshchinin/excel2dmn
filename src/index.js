// Public API: parseWorkbook, buildDmn, convert. Spec §5–§6.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import { loadConfig, deepMerge } from './config.js';
import { parseWorkbookSheets } from './excel-to-json.js';
import { buildDmn } from './json-to-dmn.js';
import { analyzeModel } from './analyze.js';
import { readFileSync as _read } from 'node:fs';
import { dmnToModels } from './dmn-to-json.js';
import { modelsToWorkbook } from './json-to-excel.js';

export { parseWorkbook } from './excel-to-json.js';
export { buildDmn, reparse } from './json-to-dmn.js';
export { loadConfig, DEFAULT_CONFIG, deepMerge } from './config.js';
export { analyzeModel } from './analyze.js';
export { dmnToModels } from './dmn-to-json.js';
export { modelsToWorkbook } from './json-to-excel.js';
export { ConversionError } from './errors.js';

function outputPath(model, inputPath, cfg) {
  const dir = cfg.output.outDir || dirname(inputPath);
  const file = cfg.output.fileNameTemplate
    .replace('<decisionId>', model.decisions[0].id)
    .replace('<sheetName>', model.__sheet || model.decisions[0].id);
  return join(dir, file);
}

/**
 * Convert a workbook to one DMN file per DMN sheet. Sheets are independent: an invalid
 * sheet is reported in `problems` without blocking its valid siblings (spec §7).
 * `options.out` names the .dmn file for a single selected sheet (an error for 2+ sheets).
 * @returns {Promise<{results:Array, problems:Array}>}
 */
export async function convert(inputPath, options = {}) {
  const cfg =
    options.config || loadConfig({ configPath: options.configPath, overrides: options.overrides });
  const parsed = await parseWorkbookSheets(inputPath, cfg, { sheet: options.sheet });
  // Checked before anything is written, so a rejected --out leaves no files behind.
  if (options.out && parsed.length > 1)
    throw new Error(
      `--out is only valid for a single DMN sheet (found ${parsed.length}); use --out-dir`,
    );

  const results = [];
  const problems = parsed.filter((p) => p.error).map(({ sheet, error }) => ({ sheet, error }));
  for (const { model } of parsed.filter((p) => p.model)) {
    try {
      const analysis = cfg.analysis.enabled || options.analyze ? analyzeModel(model, cfg) : null;
      const result = {
        sheet: model.__sheet,
        model,
        analysis,
        decisionId: model.decisions[0].id,
        warnings: model.__warnings || [],
      };
      if (!options.validateOnly) {
        const xml = await buildDmn(model, cfg);
        result.xml = xml;
        if (options.write !== false) {
          const dmnPath = options.out || outputPath(model, inputPath, cfg);
          mkdirSync(dirname(dmnPath), { recursive: true });
          writeFileSync(dmnPath, xml, 'utf8');
          result.path = dmnPath;
          if (cfg.output.writeModelJson || options.json) {
            // An --out name without a .dmn extension must not be overwritten by its model.
            const jsonPath = /\.dmn$/i.test(dmnPath)
              ? dmnPath.replace(/\.dmn$/i, '.model.json')
              : `${dmnPath}.model.json`;
            writeFileSync(jsonPath, JSON.stringify(stripInternal(model), null, 2), 'utf8');
            result.jsonPath = jsonPath;
          }
        }
      }
      results.push(result);
    } catch (err) {
      problems.push({ sheet: model.__sheet, error: err });
    }
  }
  return { results, problems };
}

function stripInternal(model) {
  const { __sheet, __warnings, __platform, __camunda8, ...rest } = model;
  void __sheet;
  void __warnings;
  void __platform;
  void __camunda8;
  return rest;
}

/**
 * Reverse: read a .dmn file and write the equivalent .xlsx template.
 * @returns {Promise<{path:string, models:Array}>}
 */
export async function importDmn(dmnPath, options = {}) {
  const cfg =
    options.config || loadConfig({ configPath: options.configPath, overrides: options.overrides });
  const xml = options.xml != null ? options.xml : _read(dmnPath, 'utf8');
  let models;
  try {
    models = await dmnToModels(xml, cfg);
  } catch (err) {
    // Name the source file: moddle's parse errors ("unparsable content …") do not.
    throw dmnPath ? new Error(`Cannot import ${dmnPath}: ${err.message}`) : err;
  }
  // If the DMN carries allowed values but the config has no allowed-values row,
  // auto-upgrade to the opt-in layout (allowed values above the label row) so the
  // exported template is lossless.
  const hasAllowed = models.some((mo) =>
    [...mo.decisions[0].inputs, ...mo.decisions[0].outputs].some((c) => c.allowedValues),
  );
  const writeCfg =
    hasAllowed && cfg.header.allowedValuesOffset == null
      ? deepMerge(cfg, {
          header: { allowedValuesOffset: 3, labelOffset: 4 },
          rules: { startOffset: 5 },
        })
      : cfg;
  // A source without a .dmn extension gets ".xlsx" appended, so it is never overwritten.
  const out =
    options.out ||
    (dmnPath
      ? /\.dmn$/i.test(dmnPath)
        ? dmnPath.replace(/\.dmn$/i, '.xlsx')
        : `${dmnPath}.xlsx`
      : 'decision_DMN.xlsx');
  if (options.write !== false) await modelsToWorkbook(models, writeCfg, out);
  // Platform detected from the source DMN's modeler metadata (§6.6). Surfaced so callers
  // (and the CLI) can re-convert the produced template with the matching --platform.
  const platform = models.some((m) => m.__platform === 'camunda8') ? 'camunda8' : 'camunda7';
  return { path: out, models, config: writeCfg, platform };
}

export { basename, extname }; // re-export path helpers used by the CLI
