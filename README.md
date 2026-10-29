# excel2dmn

[![CI](https://github.com/illia-loshchinin/excel2dmn/actions/workflows/ci.yml/badge.svg)](https://github.com/illia-loshchinin/excel2dmn/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/excel2dmn.svg)](https://www.npmjs.com/package/excel2dmn)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/excel2dmn.svg)](https://nodejs.org)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/illia-loshchinin/excel2dmn/badge)](https://securityscorecards.dev/viewer/?uri=github.com/illia-loshchinin/excel2dmn)
[![Provenance](https://img.shields.io/badge/npm-provenance-brightgreen)](https://docs.npmjs.com/generating-provenance-statements)

**The business rules are already in Excel. Now the DMN can be too.**

`excel2dmn` converts pre-formatted Excel workbooks into production-ready **DMN 1.3** decision
tables, and turns existing `.dmn` files back into editable Excel. Works with **Camunda 7**,
**Camunda 8**, and any DMN 1.3-compatible engine.

---

## The Problem

Large decision tables — pricing tiers, eligibility matrices, routing logic — are owned and
maintained by business analysts, and they live in Excel. Getting those rules into a BPM engine has
traditionally required a handoff: the analyst writes the logic in Excel, a developer re-enters it
into a modeler, and both sides try to stay in sync. The larger the table, the worse this gets — a
200-row decision table becomes a recurring, error-prone, multi-day exercise. The Excel and the
deployed DMN drift apart.

`excel2dmn` removes the handoff. The **workbook is the source**. Analysts write rules in Excel
using a simple header convention; one command produces a deployment-ready `.dmn`. No copy-paste,
no re-typing, no drift. A 300-row table takes the same command as a 10-row one.

---

## Features

- Marker-driven, position-independent parsing — no fixed rows or columns
- One workbook → **one `.dmn` per `DMN` sheet**
- **Camunda 7** (default) and **Camunda 8** output (`--platform camunda8`); compatible with any
  **DMN 1.3** engine
- Type-aware **FEEL validation** with precise `Sheet!Cell` error reporting
- **Allowed values**, **hit policies**, **annotations**
- **Readable, deterministic IDs** — clean diffs and byte-stable output
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

## Quickstart

```bash
# 1. Scaffold a template, open it in Excel and fill in your rules
excel2dmn init --name "Shipping Rate" -o shipping_DMN.xlsx

# 2. Convert to DMN (Camunda 7 is the default)
excel2dmn shipping_DMN.xlsx --out-dir out/

# 3. For Camunda 8, add --platform camunda8
excel2dmn shipping_DMN.xlsx --platform camunda8 --out-dir out/

# 4. Validate and run static analysis before deploying
excel2dmn shipping_DMN.xlsx --validate-only
excel2dmn shipping_DMN.xlsx --analyze
```

**Camunda 7** output includes `camunda:historyTimeToLive` / `camunda:versionTag` metadata. Deploy
via the REST API, Maven plugin, or Camunda Modeler.

**Camunda 8** output includes `modeler:executionPlatform="Camunda Cloud"` metadata, accepts the
full FEEL type set (`number`, `time`, `dateTime`, durations), and rejects `PRIORITY` /
`OUTPUT ORDER` hit policies (not supported by Camunda 8). Deploy via Zeebe or the Web Modeler.

**Other DMN 1.3 engines** — the decision table content (rules, inputs, outputs, FEEL expressions)
is standard DMN 1.3; the platform metadata above is additive and ignored by other engines. For
maximum portability, use `number` or untyped columns instead of the Camunda 7 numeric types
(`integer`, `long`, `double`).

---

## Import an Existing DMN

Already have `.dmn` files? `excel2dmn import` brings them into the Excel workflow:

```bash
# Turn an existing DMN into an editable Excel template
excel2dmn import existing.dmn -o existing_DMN.xlsx

# Edit in Excel, then convert back
excel2dmn existing_DMN.xlsx --out-dir out/

# Camunda 8 source: pass the platform flag on the way back
excel2dmn existing_DMN.xlsx --platform camunda8 --out-dir out/
```

`import` accepts DMN 1.3 only — open older files in Camunda Modeler first to upgrade them. When
the source DMN uses allowed values, `import` prints the config snippet needed to convert the
template back cleanly.

---

## Configuration

All markers, offsets, and output options are configurable via `excel2dmn.config.json` (or
`--config`). Precedence: CLI flags → `--config` → `./excel2dmn.config.json` → built-in defaults.

```bash
excel2dmn config              # interactive wizard → excel2dmn.config.json
excel2dmn config --defaults   # write the full default config without prompts
```

Key things you can configure:

| Area             | What you can change                                                         |
| ---------------- | --------------------------------------------------------------------------- |
| Sheet selection  | Which sheet name pattern triggers conversion (`sheet.match`, `sheet.value`) |
| Header offsets   | Row positions for name, type, allowed values, label (`header.*Offset`)      |
| Allowed values   | Enable the 5-row layout for dropdown constraints                            |
| Rule IDs         | Template for generated rule IDs (`rules.idTemplate`)                        |
| Output filenames | File naming template (`output.fileNameTemplate`)                            |
| Types            | Aliases for `Any`, numeric type normalisation (`types.*`)                   |
| FEEL validation  | Strictness mode (`validation.feel.mode`)                                    |
| Platform         | `camunda7` (default) or `camunda8`                                          |

The complete reference is
[`excel2dmn.config.example.json`](./excel2dmn.config.example.json); every field is documented in
[`SOLUTION_SPEC.md` §7.1](./SOLUTION_SPEC.md).

---

## The Sheet Template

Only sheets whose **name contains `DMN`** are processed. Each sheet uses a **4-row header**:

| Row    | Purpose                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Marker | `input` · `output` · `policy` · `ID` · `name` · `Annotations` (anything else = ignored)                                               |
| Name   | FEEL/technical name (`orderTotal`) — for `ID`/`name`/`policy` this row holds the value                                                |
| Type   | `string` · `boolean` · `integer` · `long` · `double` · `date` · `Any`; Camunda 8 also accepts `number`, `time`, `dateTime`, durations |
| Label  | Human column header, directly above the rules                                                                                         |

Rules follow beneath the header; reading stops at the first fully-empty row. An `Annotations` cell
becomes that rule's `<description>`. See [`SOLUTION_SPEC.md`](./SOLUTION_SPEC.md) for the full
format contract and `definitions/shipping_rates_DMN.xlsx` for a worked example.

---

## Programmatic API

```js
import { convert, loadConfig } from 'excel2dmn';

const { results, problems } = await convert('rules.xlsx', { config: loadConfig({}) });
```

```js
import { readFileSync } from 'node:fs';
import { dmnToModels, buildDmn, loadConfig } from 'excel2dmn';

const [model] = await dmnToModels(readFileSync('c8.dmn', 'utf8'), loadConfig({}));
const cfg = loadConfig({ overrides: { platform: model.__platform } });
const xml = await buildDmn(model, cfg);
```

`dmnToModels` exposes the detected platform as `model.__platform` (`'camunda7'` or `'camunda8'`).
`buildDmn` always builds for the platform in the config you pass.

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

`excel2dmn` is a local CLI: it makes **no network calls** and **never executes spreadsheet
content** (FEEL expressions are parsed, not evaluated). See [`SECURITY.md`](./SECURITY.md).

---

## Contributing

Issues and PRs welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) and
[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

---

## License

MIT © excel2dmn contributors. Third-party dependency licenses are listed in
`THIRD-PARTY-NOTICES.txt` (generate locally with `npm run licenses:notices`).
