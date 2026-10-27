// Command-line interface. Spec §7.
import { Command, Option } from 'commander';
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from './config.js';
import { convert, importDmn } from './index.js';
import { writeTemplate } from './init-template.js';
import { buildConfig, serializeConfig } from './init-config.js';
import { formatAnalysis } from './analyze.js';
import { ConversionError } from './errors.js';
import { sheetMatches } from './excel-to-json.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function buildOverrides(opts) {
  const o = {};
  if (opts.hitPolicy) o.hitPolicy = { default: opts.hitPolicy };
  if (opts.platform) o.platform = opts.platform;
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
    out: opts.out ? resolve(opts.out) : undefined,
  });

  for (const r of results) {
    console.log(
      opts.validateOnly ? `✓ ${r.sheet} → ${r.decisionId} (valid)` : `✓ ${r.sheet} → ${r.path}`,
    );
    // Warnings (e.g. nonCamundaTypeAction "warn", zero inputs) go to stderr; stdout stays clean.
    for (const w of r.warnings)
      console.error(`⚠ ${r.sheet}: ${w.location ? `[${w.location}] ` : ''}${w.message}`);
    if (r.analysis) {
      const text = formatAnalysis([r.analysis], cfg.analysis.format);
      if (text && !text.startsWith('Analysis: no issues')) console.log(text);
    }
  }

  // analysis.failOn: the DMN is still written; only the exit code reflects the findings.
  const failOn = cfg.analysis.failOn;
  const failing = results
    .flatMap((r) => r.analysis?.findings ?? [])
    .filter((f) => (failOn === 'any' ? f.severity !== 'info' : f.severity === failOn));
  if (failOn !== 'none' && failing.length) {
    console.error(`✗ analysis: ${failing.length} finding(s) at analysis.failOn "${failOn}"`);
    process.exitCode = 1;
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

/** Quote a path for a copy-pasteable POSIX shell command (left bare when already safe). */
export function shellQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

async function importAction(input, opts) {
  const cfg = loadConfig({ configPath: opts.config });
  const out = opts.out ? resolve(opts.out) : undefined;
  const { path, models, platform, layoutUpgraded } = await importDmn(resolve(input), {
    config: cfg,
    out,
  });
  console.log(`✓ imported ${models.length} decision(s) → ${path}`);
  if (layoutUpgraded)
    console.log(
      '  ℹ the DMN has allowed values, so the template uses the 5-row header; to convert it back, set "header": { "allowedValuesOffset": 3, "labelOffset": 4 } and "rules": { "startOffset": 5 } in your config',
    );
  if (platform === 'camunda8') {
    console.log(
      `  ℹ detected Camunda 8 — re-convert with: excel2dmn ${shellQuote(path)} --platform camunda8`,
    );
    // The workbook does not carry the target version, so point out when re-converting would change it.
    const version = models.map((m) => m.__camunda8?.executionPlatformVersion).find(Boolean);
    if (version && version !== cfg.camunda8.executionPlatformVersion)
      console.log(
        `  ℹ source targets Camunda ${version}; to keep it, set "camunda8": { "executionPlatformVersion": "${version}" } in your config`,
      );
  }
}

async function initAction(opts) {
  const cfg = loadConfig({ configPath: opts.config });
  const target = resolve(opts.out);
  // The existing file is likely a filled-in template; never replace it silently.
  if (existsSync(target) && !opts.force) fail(`${target} exists; use --force to overwrite`);
  if (opts.sheet && !sheetMatches(opts.sheet, cfg))
    console.error(
      `warning: sheet "${opts.sheet}" does not match the sheet config (${cfg.sheet.match} "${cfg.sheet.value}"), so converting this workbook will not select it${cfg.sheet.match === 'contains' ? `; include "${cfg.sheet.value}" in the sheet name` : ''}`,
    );
  const out = await writeTemplate(target, cfg, {
    name: opts.name,
    sheetName: opts.sheet,
    minimal: opts.minimal,
  });
  console.log(`✓ wrote template ${out}`);
}

async function confirmOverwrite(path) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(`${path} already exists — overwrite? [y/N] `);
    return /^(y|yes)$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

async function configAction(opts) {
  const out = resolve(opts.out);
  if (existsSync(out) && !opts.force && !(await confirmOverwrite(out))) {
    fail(`${out} exists; use --force to overwrite`);
  }
  // The wizard needs a terminal; say so rather than silently writing the full defaults.
  if (!opts.defaults && !process.stdin.isTTY)
    console.error(
      'note: stdin is not a TTY, so the interactive wizard cannot run; writing the full default config (as with --defaults)',
    );
  const cfg = await buildConfig({
    input: process.stdin,
    output: process.stdout,
    defaults: opts.defaults,
    full: opts.full,
  });
  writeFileSync(out, serializeConfig(cfg), 'utf8');
  console.log(`✓ wrote config ${out}`);
}

export function buildProgram() {
  const program = new Command();
  program
    .name('excel2dmn')
    .description('Convert pre-formatted Excel decision tables into Camunda 7 or 8 DMN 1.3 files.')
    .version(version);

  const convertCmd = program
    .command('convert', { isDefault: true })
    .description('convert a workbook to one .dmn per DMN sheet')
    .argument('<input.xlsx>', 'the workbook to convert')
    .option('-O, --out-dir <dir>', 'output directory (default: beside the input file)')
    .option('-o, --out <file>', 'output .dmn path (single-sheet only)')
    .option('-j, --json', 'also write <decisionId>.model.json per sheet')
    .option('--config <file>', 'config JSON file')
    .option('--sheet <name...>', 'restrict to these sheet name(s)')
    .addOption(new Option('--platform <name>', 'target platform').choices(['camunda7', 'camunda8']))
    .option('--hit-policy <p>', 'fallback hit policy')
    .option('--namespace <uri>', 'definitions target namespace')
    .option('--analyze', 'run static analysis (overlap/gaps/duplicates)')
    .option('--validate-only', 'parse + validate; do not emit DMN')
    .option('--no-pretty', 'disable XML pretty-printing')
    .action(convertAction);

  // convert is the default command, so `excel2dmn --help` lists its options too (spec §7).
  program.addHelpText('after', () => {
    const help = convertCmd.createHelp();
    const options = help.visibleOptions(convertCmd).filter((o) => o.long !== '--help');
    const width = Math.max(...options.map((o) => help.optionTerm(o).length));
    const rows = options.map(
      (o) => `  ${help.optionTerm(o).padEnd(width)}  ${help.optionDescription(o)}`,
    );
    return `\nConvert options (excel2dmn <input.xlsx> [options]):\n${rows.join('\n')}`;
  });

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
    .option('--force', 'overwrite an existing file')
    .action(initAction);

  program
    .command('config')
    .description('generate an excel2dmn.config.json (interactive wizard by default)')
    .option('-o, --out <file>', 'output config path', 'excel2dmn.config.json')
    .option('--full', 'write every key (default: only keys that differ from defaults)')
    .option('-y, --defaults', 'non-interactive: write the full default config without prompting')
    .option('--force', 'overwrite an existing file without confirmation')
    .action(configAction);

  return program;
}

export async function run(argv = process.argv) {
  await buildProgram().parseAsync(argv);
}
