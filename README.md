# excel2dmn

[![CI](https://github.com/illia-loshchinin/excel2dmn/actions/workflows/ci.yml/badge.svg)](https://github.com/illia-loshchinin/excel2dmn/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/excel2dmn.svg)](https://www.npmjs.com/package/excel2dmn)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/excel2dmn.svg)](https://nodejs.org)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/illia-loshchinin/excel2dmn/badge)](https://securityscorecards.dev/viewer/?uri=github.com/illia-loshchinin/excel2dmn)
[![Provenance](https://img.shields.io/badge/npm-provenance-brightgreen)](https://docs.npmjs.com/generating-provenance-statements)

**The business rules are already in Excel. Now the DMN can be too.**

`excel2dmn` converts pre-formatted Excel workbooks into production-ready **DMN 1.3** decision tables, and turns existing `.dmn` files back into editable Excel. It supports **Camunda 7**, **Camunda 8**, and any DMN 1.3-compatible engine.

---

## The Problem

Large decision tables — pricing tiers, eligibility matrices, routing logic — are owned and maintained by business analysts, and they live in Excel. That is where the logic is, where the data context is, and where the domain expertise is expressed.

Getting those rules into a BPM engine has traditionally required a handoff: the analyst writes or updates the logic in Excel, and a developer manually re-enters it into a modeler. The larger the table, the worse this gets. A 200-row decision table that changes frequently turns into a recurring, error-prone, multi-day translation exercise. The Excel and the deployed DMN drift apart. Nobody is quite sure which one is authoritative.

## The Shift

`excel2dmn` removes the handoff entirely. The **workbook is the source**. The analyst writes rules in Excel — using a straightforward header convention — and a single command produces a deployment-ready `.dmn` file. No copy-paste. No re-typing. No drift.

```bash
excel2dmn pricing_DMN.xlsx --out-dir out/
# → out/PRICING.dmn, ready to deploy
```

This is not a convenience wrapper. It is a change in who produces DMN and when. Analysts produce code-ready output directly from the tool they already use. Developers review deterministic XML diffs in git, not conversations in email. A table with 300 rows takes the same one command as a table with 10. Iteration that used to take days takes seconds.

---

## What It Does

- Marker-driven, position-independent parsing — no fixed rows or columns required
- One workbook → **one `.dmn` per `DMN` sheet**
- **Camunda 7** (default) and **Camunda 8** output (`--platform camunda8`)
- Compatible with any **DMN 1.3** engine
- Type-aware **FEEL validation** with precise `Sheet!Cell` error reporting
- **Allowed values** (`inputValues`/`outputValues`), **hit policies**, **annotations**
- **Readable, deterministic IDs** — clean diffs and byte-stable output across runs
- Static **analysis**: overlap, duplicate, shadowed, and gap detection
- `excel2dmn init` scaffolds a ready-to-fill template
- **Reverse import** (`excel2dmn import`): existing `.dmn` → `.xlsx`

---

## Install

Requires Node.js 20.12 or newer.

```bash
npm install -g excel2dmn
# or run without installing:
npx excel2dmn rules.xlsx
```

---

## Quickstart: Camunda 7

```bash
# 1. Install
npm install -g excel2dmn

# 2. Scaffold a template (open it in Excel and fill in your rules)
excel2dmn init --name "Shipping Rate" -o shipping_DMN.xlsx

# 3. Convert to DMN (Camunda 7 is the default)
excel2dmn shipping_DMN.xlsx --out-dir out/

# 4. Validate and run static analysis
excel2dmn shipping_DMN.xlsx --validate-only
excel2dmn shipping_DMN.xlsx --analyze
```

The output `out/SHIPPING_RATE.dmn` is ready to deploy to Camunda 7 via the REST API, Maven plugin, or Camunda Modeler.

---

## Quickstart: Camunda 8

```bash
# 1. Install
npm install -g excel2dmn

# 2. Scaffold a template
excel2dmn init --name "Loan Eligibility" -o loan_DMN.xlsx

# 3. Convert — pass --platform camunda8
excel2dmn loan_DMN.xlsx --platform camunda8 --out-dir out/

# 4. Deploy via Zeebe / Camunda 8 Web Modeler import
```

Camunda 8 output includes `modeler:executionPlatform="Camunda Cloud"` metadata and accepts the full FEEL type set (`number`, `time`, `dateTime`, durations). Hit policies `PRIORITY` and `OUTPUT ORDER` are rejected (Camunda 8 does not support them).

---

## Migrate an Existing DMN to Excel

Already have `.dmn` files you want to move into the Excel workflow? `excel2dmn import` does the round-trip:

```bash
# Turn an existing DMN into an editable Excel template
excel2dmn import existing.dmn -o existing_DMN.xlsx

# Edit the .xlsx in Excel, then convert back
excel2dmn existing_DMN.xlsx --out-dir out/

# If the original was Camunda 8, pass the platform flag on the way back
excel2dmn existing_DMN.xlsx --platform camunda8 --out-dir out/
```

`import` accepts DMN 1.3 only. To upgrade an older file, open it in a current Camunda Modeler first and save. When the imported DMN uses allowed values, `import` prints the config snippet to paste into `excel2dmn.config.json` so the template converts back cleanly.

---

## Usage Reference

```bash
# Convert every "DMN" sheet in a workbook
excel2dmn rules.xlsx --out-dir out/

# Single-sheet workbook to a named file
excel2dmn shipping_DMN.xlsx -o out/SHIPPING_RATES.dmn

# Camunda 8 output
excel2dmn rules.xlsx --platform camunda8 --out-dir out/

# Validate only (CI gate) and static analysis
excel2dmn rules.xlsx --validate-only
excel2dmn rules.xlsx --analyze

# Scaffold a template
excel2dmn init --name "Decision Name" -o my_DMN.xlsx

# Interactive config generator
excel2dmn config
excel2dmn config --defaults   # non-interactive: write the full default config

# Reverse: DMN → Excel
excel2dmn import existing.dmn -o existing_DMN.xlsx
```

`--sheet <name...>` narrows the sheets processed to the exact names given (names must already contain `DMN` by default).

**Output:** success lines and hints go to stdout; errors and warnings go to stderr. Warnings do not change the exit code.

---

## The Sheet Template

Only sheets whose **name contains `DMN`** are processed. Each sheet uses a **4-row header** (found by a marker row, not a fixed position):

| Row    | Purpose                                                                                                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marker | `input` · `output` · `policy` · `ID` · `name` · `Annotations` (anything else = ignored helper column)                                                                                                                                      |
| Name   | FEEL/technical name (`orderTotal`) — for `ID`/`name`/`policy` this row holds the value                                                                                                                                                     |
| Type   | `string` · `boolean` · `integer` · `long` · `double` · `date` · `Any`; Camunda 8 also accepts `number`, `time`, `dateTime`, durations                                                                                                      |
| Label  | Human column header, directly above the rules                                                                                                                                                                                               |

Rules follow beneath the header. A row is a rule if any input/output cell is filled; reading stops at the first fully-empty row. An `Annotations` cell becomes that rule's `<description>`.

**Allowed values (optional).** Add an extra row between _Type_ and _Label_ with a FEEL list (e.g. `"EU","US"`) to enable dropdowns in the Modeler. Required for `PRIORITY`/`OUTPUT ORDER` hit policies. Enable with:
```json
{ "header": { "allowedValuesOffset": 3, "labelOffset": 4 }, "rules": { "startOffset": 5 } }
```

See [`SOLUTION_SPEC.md`](./SOLUTION_SPEC.md) for the full format contract and `definitions/shipping_rates_DMN.xlsx` for a worked example.

---

## Configuration

All markers and offsets are configurable via `excel2dmn.config.json` (or `--config`).  
Precedence: CLI flags → `--config` → `./excel2dmn.config.json` → built-in defaults.

```bash
excel2dmn config                  # interactive wizard
excel2dmn config --defaults       # write the full default config without prompts
excel2dmn config -o my.config.json
```

The complete reference is [`excel2dmn.config.example.json`](./excel2dmn.config.example.json); every field is documented in [`SOLUTION_SPEC.md` §7.1](./SOLUTION_SPEC.md).

---

## Programmatic API

```js
import { convert, parseWorkbook, buildDmn, loadConfig } from 'excel2dmn';

const { results, problems } = await convert('rules.xlsx', { config: loadConfig({}) });
```

To rebuild a parsed DMN for the platform it was originally authored on:

```js
import { readFileSync } from 'node:fs';
import { dmnToModels, buildDmn, loadConfig } from 'excel2dmn';

const [model] = await dmnToModels(readFileSync('c8.dmn', 'utf8'), loadConfig({}));
const cfg = loadConfig({ overrides: { platform: model.__platform } });
const xml = await buildDmn(model, cfg);
```

`dmnToModels` exposes the detected platform as `model.__platform` (`'camunda7'` or `'camunda8'`). `buildDmn` always builds for the platform in the config you pass — it never auto-switches.

---

## Development

```bash
npm install
npm test          # vitest (golden-file, multi-sheet, validation, analysis, init)
npm run lint
npm run convert -- definitions/shipping_rates_DMN.xlsx --out-dir out
```

---

## Security

`excel2dmn` is a local CLI: it makes **no network calls** and **never executes spreadsheet content** (FEEL expressions are parsed, not evaluated). See [`SECURITY.md`](./SECURITY.md) for the threat model and vulnerability reporting process.

---

## Contributing

Issues and PRs welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

---

## License

MIT © excel2dmn contributors. Third-party dependency licenses are listed in `THIRD-PARTY-NOTICES.txt`, which ships in the npm package (generate locally with `npm run licenses:notices`).
