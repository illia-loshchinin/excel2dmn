# excel2dmn

[![CI](https://github.com/illia-loshchinin/excel2dmn/actions/workflows/ci.yml/badge.svg)](https://github.com/illia-loshchinin/excel2dmn/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/excel2dmn.svg)](https://www.npmjs.com/package/excel2dmn)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/excel2dmn.svg)](https://nodejs.org)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/illia-loshchinin/excel2dmn/badge)](https://securityscorecards.dev/viewer/?uri=github.com/illia-loshchinin/excel2dmn)
[![Provenance](https://img.shields.io/badge/npm-provenance-brightgreen)](https://docs.npmjs.com/generating-provenance-statements)

Convert pre-formatted **Excel decision tables** into **Camunda 7 or Camunda 8 DMN 1.3** files — one `.dmn` per sheet, ready to import into the Camunda Modeler / Web Modeler.

- Marker-driven, position-independent parsing (no fixed rows/columns)
- One workbook → **one `.dmn` per `DMN` sheet**
- Type-aware **FEEL validation** with precise `Sheet!Cell` errors
- **Allowed values** (`inputValues`/`outputValues`), **hit policies**, **annotations** (as `<description>`)
- **Camunda 7** (default) `historyTimeToLive` / `versionTag`, or **Camunda 8** (`--platform camunda8`) modeler execution-platform metadata
- **Readable, deterministic ids** → clean diffs and byte-stable output
- Static **analysis**: overlap / duplicate / shadowed / gap detection
- `excel2dmn init` scaffolds a ready-to-fill template
- **Reverse import** (`excel2dmn import`): existing `.dmn` → `.xlsx` (round-trips byte-identically)

## Install

Requires Node.js 20.12 or newer.

```bash
npm install -g excel2dmn        # or run without installing: npx excel2dmn <file.xlsx>
```

## Usage

```bash
# Convert every "DMN" sheet in a workbook into out/<DecisionId>.dmn
excel2dmn rules.xlsx --out-dir out --json

# Single-sheet workbook to a named file
excel2dmn shipping_rates_DMN.xlsx -o out/SHIPPING_RATES.dmn

# Target Camunda 8 instead of Camunda 7 (default)
excel2dmn rules.xlsx --platform camunda8 --out-dir out

# Validate only (CI gate) / run static analysis
excel2dmn rules.xlsx --validate-only
excel2dmn rules.xlsx --analyze

# Generate a starter template (refuses to overwrite an existing file without --force)
excel2dmn init --name "Shipping Rate Decision" -o shipping_DMN.xlsx

# Generate a config file interactively (step-by-step, with defaults)
excel2dmn config
excel2dmn config --defaults        # non-interactive: write the full default config

# Reverse: turn an existing DMN into an editable Excel template
excel2dmn import existing.dmn -o existing.xlsx
```

`--sheet <name...>` narrows the sheets that would be converted anyway (names containing
`DMN` by default) to the exact names given; it cannot select a sheet outside that set.
Two sheets with the same decision id (compared after sanitising, ignoring case) are an
error, since their files would overwrite each other.

**Output:** success lines and hints go to stdout; errors and warnings go to **stderr**
(conversion warnings as `⚠ <sheet>: [<cell>] <message>`, others as `warning: …`).
Warnings do not change the exit code.

`import` accepts DMN 1.3 only (open older DMN in a current Camunda Modeler to upgrade it)
and creates missing directories for `-o`. When the DMN has allowed values it writes the
5-row allowed-values layout and prints the config needed to convert the template back.

> **Camunda 8 round-trip:** the Excel template does not carry the platform, so when
> `import` detects a Camunda 8 source it prints a hint to re-convert with
> `--platform camunda8`. Pass that flag on the way back so C8-only types (e.g. `number`)
> aren't rejected by the default Camunda 7 type check.

### Programmatic API

```js
import { convert, parseWorkbook, buildDmn, loadConfig } from 'excel2dmn';

const { results, problems } = await convert('rules.xlsx', { config: loadConfig({}) });
```

`dmnToModels` reports the source platform it detects on each model as `model.__platform`
(`'camunda7'` or `'camunda8'`), but `buildDmn` always builds for the platform in the config
you pass — it never switches on its own. To rebuild a parsed DMN for the platform it came
from, pass the detected value explicitly:

```js
import { readFileSync } from 'node:fs';
import { dmnToModels, buildDmn, loadConfig } from 'excel2dmn';

const [model] = await dmnToModels(readFileSync('c8.dmn', 'utf8'), loadConfig({}));
const cfg = loadConfig({ overrides: { platform: model.__platform } });
const xml = await buildDmn(model, cfg);
```

## The sheet template

Only sheets whose **name contains `DMN`** are processed. Each is described by a
**4-row header** (found by the marker row, not a fixed position):

| Row    | Purpose                                                                                                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marker | `input` · `output` · `policy` · `ID` · `name` · `Annotations` (anything else = ignored helper)                                                                                                                                              |
| Name   | technical/FEEL name (`orderTotal`) — for `ID`/`name`/`policy` this row holds the value                                                                                                                                                      |
| Type   | Camunda types: `string` · `boolean` · `integer` · `long` · `double` · `date` · `Any`; Camunda 8 also accepts `number`, `time`, `dateTime` and durations (untyped is canonically `Any`; `any`/`none`/`object` are also accepted, any casing) |
| Label  | human column header, directly above the rules                                                                                                                                                                                               |

**Allowed values (opt-in).** An extra row between _Type_ and _Label_ can hold a
FEEL list (`"EU","US"`) per column → dropdowns in the Modeler; it is required for
`PRIORITY`/`OUTPUT ORDER`. Enable it with
`{ "header": { "allowedValuesOffset": 3, "labelOffset": 4 }, "rules": { "startOffset": 5 } }`
(see [`SOLUTION_SPEC.md` §3.6](./SOLUTION_SPEC.md)).

Rules follow beneath the header. A row is a rule if any input/output cell is
filled; reading stops at the first fully-empty row. Rule ids are generated as
`rule_<n>` (1-based; `rules.idTemplate` can use `<row>` for the Excel row). An `Annotations` cell becomes that rule's `<description>`.

See [`SOLUTION_SPEC.md`](./SOLUTION_SPEC.md) for the full contract, and
`definitions/shipping_rates_DMN.xlsx` for a worked example.

## Configuration

All markers and rules are configurable via `excel2dmn.config.json` (or `--config`).
Precedence: CLI flags → `--config` → `./excel2dmn.config.json` → built-in defaults.

The fastest way to get a config is the interactive generator, which walks you
through the common settings (and, on request, the advanced ones), showing the
default for each — press Enter to accept it or type a new value:

```bash
excel2dmn config                        # step-by-step wizard → excel2dmn.config.json
excel2dmn config --defaults             # write the full default config, no prompts
excel2dmn config -o my.config.json      # choose a different output path
```

By default the wizard writes only the keys you changed (a minimal file); pass
`--full` to write every key. [`excel2dmn.config.example.json`](./excel2dmn.config.example.json)
is a checked-in copy of the complete default config you can copy and edit by
hand. Every field is documented in [`SOLUTION_SPEC.md` §7.1](./SOLUTION_SPEC.md).
Unknown keys (typos) are ignored with a `warning:` on stderr naming the key; wrong types
or values for known keys are errors.

## Development

```bash
npm install
npm test          # vitest (golden-file, multi-sheet, validation, analysis, init)
npm run lint
npm run convert -- definitions/shipping_rates_DMN.xlsx --out-dir out
```

## Security

`excel2dmn` is a local CLI: it makes **no network calls** and **never executes
spreadsheet content** (FEEL is parsed, not evaluated). See [`SECURITY.md`](./SECURITY.md)
for the threat model and how to report a vulnerability.

## Contributing

Issues and PRs welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) and the
[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## License

MIT © excel2dmn contributors. Third-party dependency licenses are listed in
`THIRD-PARTY-NOTICES.txt`, which ships in the npm package (generate it locally
with `npm run licenses:notices`).
