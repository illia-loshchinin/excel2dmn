// Public API: parseWorkbook, buildDmn, convert. Spec §5–§6.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename, extname, relative, isAbsolute, resolve, sep } from 'node:path';
import { loadConfig, deepMerge } from './config.js';
import { parseWorkbookSheets } from './excel-to-json.js';
import { buildDmn } from './json-to-dmn.js';
import { analyzeModel } from './analyze.js';
import { readFileSync as _read } from 'node:fs';
import { dmnToModels } from './dmn-to-json.js';
import { modelsToWorkbook } from './json-to-excel.js';
import { readError } from './errors.js';

export { parseWorkbook } from './excel-to-json.js';
export { buildDmn, reparse } from './json-to-dmn.js';
export { loadConfig, DEFAULT_CONFIG, deepMerge } from './config.js';
export { analyzeModel } from './analyze.js';
export { dmnToModels } from './dmn-to-json.js';
export { modelsToWorkbook } from './json-to-excel.js';
export { ConversionError } from './errors.js';

function outputPath(model, inputPath, cfg) {
  const dir = cfg.output.outDir || dirname(inputPath);
  const id = model.decisions[0].id;
  const file = cfg.output.fileNameTemplate
    .replace('<decisionId>', () => id)
    .replace('<sheetName>', () => model.__sheet || id);
  const path = join(dir, file);
  const rel = relative(dir, path);
  // '' = the directory itself (e.g. a "." template); '..' segments or an absolute path escape it.
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(
      `output path ${path} for decision '${id}' (sheet "${model.__sheet}") would be written outside the output directory ${dir} — check output.fileNameTemplate and the decision id`,
    );
  return path;
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

  // Two sheets resolving to one output file would overwrite each other: fail them all.
  const paths = new Map();
  const colliding = new Set();
  if (!options.out && options.write !== false) {
    const byPath = new Map();
    for (const { model } of parsed.filter((p) => p.model)) {
      try {
        const path = outputPath(model, inputPath, cfg);
        paths.set(model, path);
        const key = resolve(path).toLowerCase();
        byPath.set(key, [...(byPath.get(key) || []), model]);
      } catch (error) {
        problems.push({ sheet: model.__sheet, error });
        colliding.add(model);
      }
    }
    for (const group of byPath.values()) {
      if (group.length < 2) continue;
      const names = group.map((m) => `"${m.__sheet}"`).join(', ');
      for (const m of group) {
        problems.push({
          sheet: m.__sheet,
          error: new Error(
            `output path ${paths.get(m)} is used by sheets ${names} — check output.fileNameTemplate`,
          ),
        });
        colliding.add(m);
      }
    }
  }
  const inputResolved = resolve(inputPath);
  for (const { model } of parsed.filter((p) => p.model && !colliding.has(p.model))) {
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
          const dmnPath = options.out || paths.get(model) || outputPath(model, inputPath, cfg);
          const jsonPath =
            cfg.output.writeModelJson || options.json
              ? /\.dmn$/i.test(dmnPath)
                ? dmnPath.replace(/\.dmn$/i, '.model.json')
                : `${dmnPath}.model.json`
              : null;
          for (const p of [dmnPath, jsonPath])
            if (p && resolve(p) === inputResolved)
              throw new Error(
                `output path ${p} is the input workbook — choose another --out / output.fileNameTemplate`,
              );
          mkdirSync(dirname(dmnPath), { recursive: true });
          writeFileSync(dmnPath, xml, 'utf8');
          result.path = dmnPath;
          if (jsonPath) {
            // An --out name without a .dmn extension must not be overwritten by its model.
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

// DMN MODEL namespaces by version; only 1.3 (20191111) is supported (spec §6).
const DMN_VERSIONS = {
  'http://www.omg.org/spec/DMN/20151101/dmn.xsd': '1.1',
  'http://www.omg.org/spec/DMN/20180521/MODEL/': '1.2',
  'https://www.omg.org/spec/DMN/20211108/MODEL/': '1.4',
  'https://www.omg.org/spec/DMN/20230324/MODEL/': '1.5',
};

/** Reject a DMN whose root <definitions> uses another DMN version's namespace. */
function assertDmn13(xml) {
  const root = /<(?:([\w.-]+):)?definitions\b[^>]*>/.exec(xml.replace(/<!--[\s\S]*?-->/g, ''));
  if (!root) return; // not DMN at all: dmnToModels reports that
  const attr = root[1] ? `xmlns:${root[1]}` : 'xmlns';
  const ns = new RegExp(`\\s${attr}\\s*=\\s*(["'])(.*?)\\1`).exec(root[0])?.[2];
  const version = DMN_VERSIONS[ns];
  if (version)
    throw new Error(
      `this is a DMN ${version} file (namespace ${ns}), not DMN 1.3 — open and save it in a current Camunda Modeler to upgrade it`,
    );
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
 * `layoutUpgraded` is true when the template uses the 5-row allowed-values header
 * although the config has none (it must be converted back with that layout).
 * @returns {Promise<{path:string, models:Array, config:object, platform:string, layoutUpgraded:boolean}>}
 */
export async function importDmn(dmnPath, options = {}) {
  const cfg =
    options.config || loadConfig({ configPath: options.configPath, overrides: options.overrides });
  let xml = options.xml;
  if (xml == null) {
    try {
      xml = _read(dmnPath, 'utf8');
    } catch (err) {
      throw readError(dmnPath, err) || err;
    }
  }
  let models;
  try {
    assertDmn13(xml);
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
  const layoutUpgraded = hasAllowed && cfg.header.allowedValuesOffset == null;
  const writeCfg = layoutUpgraded
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
  if (options.write !== false) {
    if (dmnPath && resolve(out) === resolve(dmnPath))
      throw new Error(
        `Cannot import ${dmnPath}: the output would overwrite the input DMN — choose another -o`,
      );
    try {
      // Like convert, create missing parent directories of the output (spec §7).
      mkdirSync(dirname(out), { recursive: true });
      await modelsToWorkbook(models, writeCfg, out);
    } catch (err) {
      throw err.code ? new Error(`Cannot write ${out}: ${err.message}`) : err;
    }
  }
  // Platform detected from the source DMN's modeler metadata (§6.6). Surfaced so callers
  // (and the CLI) can re-convert the produced template with the matching --platform.
  const platform = models.some((m) => m.__platform === 'camunda8') ? 'camunda8' : 'camunda7';
  return { path: out, models, config: writeCfg, platform, layoutUpgraded };
}

export { basename, extname }; // re-export path helpers used by the CLI
