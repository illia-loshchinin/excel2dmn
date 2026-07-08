// Command-line interface. Spec §7.
import { Command } from 'commander';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { convert, importDmn } from './index.js';
import { writeTemplate } from './init-template.js';
import { formatAnalysis } from './analyze.js';
import { ConversionError } from './errors.js';

function buildOverrides(opts) {
  const o = {};
  if (opts.hitPolicy) o.hitPolicy = { default: opts.hitPolicy };
  if (opts.namespace) o.output = { ...(o.output || {}), namespace: opts.namespace };
  if (opts.outDir) o.output = { ...(o.output || {}), outDir: resolve(opts.outDir) };
  if (opts.pretty === false) o.output = { ...(o.output || {}), format: false };
  if (opts.analyze) o.analysis = { enabled: true };
  return o;
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

async function convertAction(input, opts) {
  const cfg = loadConfig({ configPath: opts.config, overrides: buildOverrides(opts) });
  const inputPath = resolve(input);

  const { results, problems } = await convert(inputPath, {
    config: cfg,
    sheet: opts.sheet,
    json: opts.json,
    analyze: opts.analyze,
    validateOnly: opts.validateOnly,
  });

  if (opts.out && results.length > 1) {
    fail(`--out is only valid for a single DMN sheet (found ${results.length}); use --out-dir`);
  }

  for (const r of results) {
    console.log(
      opts.validateOnly ? `✓ ${r.sheet} → ${r.decisionId} (valid)` : `✓ ${r.sheet} → ${r.path}`,
    );
    if (r.analysis) {
      const text = formatAnalysis([r.analysis], cfg.analysis.format);
      if (text && !text.startsWith('Analysis: no issues')) console.log(text);
    }
  }

  if (problems.length) {
    for (const p of problems) {
      console.error(`\n✗ ${p.sheet}:`);
      console.error(p.error instanceof ConversionError ? p.error.message : `  ${p.error.message}`);
    }
    process.exitCode = 1;
  }
  if (!results.length && !problems.length) fail('nothing to convert');
}

async function importAction(input, opts) {
  const cfg = loadConfig({ configPath: opts.config });
  const out = opts.out ? resolve(opts.out) : undefined;
  const { path, models } = await importDmn(resolve(input), { config: cfg, out });
  console.log(`✓ imported ${models.length} decision(s) → ${path}`);
}

async function initAction(opts) {
  const cfg = loadConfig({ configPath: opts.config });
  const out = await writeTemplate(resolve(opts.out), cfg, {
    name: opts.name,
    sheetName: opts.sheet,
    minimal: opts.minimal,
  });
  console.log(`✓ wrote template ${out}`);
}

export function buildProgram() {
  const program = new Command();
  program
    .name('excel2dmn')
    .description('Convert pre-formatted Excel decision tables into Camunda 7 DMN 1.3 files.')
    .version('0.1.0');

  program
    .command('convert', { isDefault: true })
    .description('convert a workbook to one .dmn per DMN sheet')
    .argument('<input.xlsx>', 'the workbook to convert')
    .option('-O, --out-dir <dir>', 'output directory (default: beside the input file)')
    .option('-o, --out <file>', 'output .dmn path (single-sheet only)')
    .option('-j, --json', 'also write <decisionId>.model.json per sheet')
    .option('--config <file>', 'config JSON file')
    .option('--sheet <name...>', 'restrict to these sheet name(s)')
    .option('--hit-policy <p>', 'fallback hit policy')
    .option('--namespace <uri>', 'definitions target namespace')
    .option('--analyze', 'run static analysis (overlap/gaps/duplicates)')
    .option('--validate-only', 'parse + validate; do not emit DMN')
    .option('--no-pretty', 'disable XML pretty-printing')
    .action(convertAction);

  program
    .command('import')
    .description('reverse: build an .xlsx template from an existing .dmn file')
    .argument('<input.dmn>', 'the DMN file to import')
    .option('-o, --out <file>', 'output .xlsx path (default: <input>.xlsx)')
    .option('--config <file>', 'config JSON file')
    .action(importAction);

  program
    .command('init')
    .description('write a ready-to-fill starter workbook')
    .option('-o, --out <file>', 'output .xlsx path', 'decision_DMN.xlsx')
    .option('--name <name>', 'decision name', 'My Decision')
    .option('--sheet <name>', 'sheet name')
    .option('--config <file>', 'config JSON file')
    .option('--minimal', 'skip example rules / annotation column')
    .action(initAction);

  return program;
}

export async function run(argv = process.argv) {
  await buildProgram().parseAsync(argv);
}
