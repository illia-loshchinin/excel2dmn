# E2E scenarios — DMN → Excel import and round-trips

Area: `excel2dmn import <input.dmn> [-o <file>] [--config <file>]`, the programmatic
`importDmn` / `dmnToModels` / `modelsToWorkbook` / `buildDmn` path, and full round-trips
`xlsx → dmn → xlsx → dmn` for Camunda 7 and Camunda 8.

Sources of truth, in order: `SOLUTION_SPEC.md` (cited as `§x.y`), `README.md` (cited as
`README: <section>`), `excel2dmn.config.example.json` (cited as `example config`). Where
none of them settles the expected result, the scenario is flagged **spec silent** and
states the most reasonable expectation.

> Note for everyone: the spec refers to the reverse importer as "§16" (§1 Goals, §6.6), but
> `SOLUTION_SPEC.md` has no §16. The import contract therefore comes from §1 ("round-trips
> losslessly"), §4 notes (Any normalization on import), §6.6 (platform detection and the
> re-convert hint) and README (Usage, the Camunda 8 round-trip note, Programmatic API,
> "Reverse import … round-trips byte-identically").

Test-writer notes:

- Build every workbook in code with `writeWorkbook` + `decisionSheet` from
  `test/e2e/helpers.js`; write hand-written DMN inputs as string literals into the temp dir.
  Never add binary fixtures.
- "Convert" means `runCli(['<x>.xlsx', ...flags, '--out-dir', 'out'], { cwd })`; "import"
  means `runCli(['import', '<x>.dmn', ...], { cwd })`. A config file is a JSON file in the
  temp dir passed with `--config <file>`, unless the scenario places it in cwd as
  `excel2dmn.config.json`.
- **Round-trip** (`RT(flags, cfg)`) = (1) convert the source workbook → `dmn1`; (2) import
  `dmn1` → `back.xlsx`; (3) convert `back.xlsx` with the same flags/config → `dmn2`. The
  assertion is `readText(dmn2) === readText(dmn1)` (byte-identical **DMN**; the two `.xlsx`
  files are not compared byte-for-byte). Unless stated, step 3 writes into a different
  directory than step 1 so the files cannot be confused.
- "Re-parses cleanly" means `parseDmn(xml)` resolves (0 dmn-moddle warnings).
- "The imported sheet" is read with `readWorkbook`. Layout assertions are made **relative to
  the marker row** (the row holding `input`/`output`), using the config in force: name row =
  M+1, type row = M+2, allowed-values row = M+3 (5-row layout only), label row = M+3 (4-row)
  or M+4 (5-row), first rule row = M+4 (4-row) or M+5 (5-row). Do not assert absolute
  column letters for the `policy`/`id`/`name` columns; do assert that inputs then outputs
  appear left-to-right in DMN document order.
- Messages are matched with the stable fragments quoted below (case-insensitive regex is
  fine); the full wording is not part of the contract unless the scenario says "exact".
- Every CLI error scenario also asserts: no stack trace in stderr (no `   at` lines) and no
  output file was created.

---

## Shared fixtures

### W-C7 — Camunda 7 baseline workbook (`fees_DMN.xlsx`, sheet `Fees DMN`, 4-row layout)

| Col | Marker (row 1) | Name (row 2)   | Type (row 3) | Label (row 4) |
| --- | -------------- | -------------- | ------------ | ------------- |
| A   | `policy`       | `UNIQUE`       |              |               |
| B   | `ID`           | `FEES`         |              |               |
| C   | `name`         | `Fee Decision` |              |               |
| D   | `input`        | `amount`       | `integer`    | `Amount`      |
| E   | `input`        | `region`       | `string`     | `Region`      |
| F   | `input`        | `tags`         | `Any`        | `Tags`        |
| G   | `output`       | `fee`          | `double`     | `Fee`         |
| H   | `output`       | `tier`         | `string`     | `Tier`        |
| I   | `annotations`  |                |              |               |

Rules (rows 5–6):

| Row | D `amount` | E `region` | F `tags` | G `fee` | H `tier` | I          |
| --- | ---------- | ---------- | -------- | ------- | -------- | ---------- |
| 5   | `< 100`    | `"EU"`     | `-`      | `1.5`   | `"LOW"`  | `small EU` |
| 6   | `>= 100`   | _(empty)_  | `"vip"`  | `0`     | `"HIGH"` | _(empty)_  |

### W-C7-AV — W-C7 in the 5-row allowed-values layout

Same columns and rules; allowed-values row (row 4, config `ALLOWED_VALUES_LAYOUT`):
`amount` = `[0..10000]`, `region` = `"EU","US"`, `tier` = `"LOW","HIGH"`; other cells
blank. Labels on row 5, rules on rows 6–7. Converted and re-converted with a config file
`av.json` = `ALLOWED_VALUES_LAYOUT`.

### W-C8 — Camunda 8 baseline (`fees_DMN.xlsx`, sheet `Fees DMN`)

W-C7 with types changed to C8-only values: `amount` = `number`, `fee` = `number`, plus an
extra input column `when` (`dateTime`, label `When`) inserted after `tags` with entries
`< date and time("2026-01-01T00:00:00")` (row 5) and empty (row 6). Always converted with
`--platform camunda8`.

### W-SUM — single-output COLLECT table (`sum_DMN.xlsx`, sheet `Sum DMN`)

`policy` = `COLLECT` with aggregator at row 3 (the type row of the policy column,
`hitPolicy.aggregatorOffset: 2`) = `<AGG>`; `ID` = `SURCHARGES`; inputs `amount`
(`integer`), `region` (`string`); one output `surcharge` (`double`). Rules:
`> 10` / `"EU"` / `2.5` and `-` / `"US"` / `1`.

### W-PRIO — PRIORITY / OUTPUT ORDER table (5-row layout)

`policy` = `<POLICY>`; `ID` = `RANKED`; input `score` (`integer`); output `grade`
(`string`, allowed values `"A","B","C"`). Rules: `>= 90` → `"A"`, `>= 50` → `"B"`, `-` → `"C"`.

### D-MODELER-C7 — hand-written Camunda Modeler (C7) file `dish.dmn`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" xmlns:dmndi="https://www.omg.org/spec/DMN/20191111/DMNDI/" xmlns:dc="http://www.omg.org/spec/DMN/20180521/DC/" xmlns:camunda="http://camunda.org/schema/1.0/dmn" xmlns:modeler="http://camunda.org/schema/modeler/1.0" id="Definitions_0x1y2z" name="DRD" namespace="http://camunda.org/schema/1.0/dmn" exporter="Camunda Modeler" exporterVersion="5.28.0" modeler:executionPlatform="Camunda Platform" modeler:executionPlatformVersion="7.22.0">
  <decision id="Decision_0abc" name="Dish" camunda:historyTimeToLive="P30D" camunda:versionTag="2">
    <decisionTable id="DecisionTable_1k2" hitPolicy="FIRST">
      <input id="Input_1" label="Season">
        <inputExpression id="InputExpression_1" typeRef="string"><text>season</text></inputExpression>
      </input>
      <input id="InputClause_0g" label="Guests">
        <inputExpression id="LiteralExpression_0h" typeRef="integer"><text>guestCount</text></inputExpression>
      </input>
      <output id="Output_1" label="Dish" name="dish" typeRef="string" />
      <rule id="DecisionRule_1a">
        <description>winter feast</description>
        <inputEntry id="UnaryTests_1"><text>"Winter"</text></inputEntry>
        <inputEntry id="UnaryTests_2"><text>&lt;= 8</text></inputEntry>
        <outputEntry id="LiteralExpression_1"><text>"Roastbeef"</text></outputEntry>
      </rule>
      <rule id="DecisionRule_2b">
        <inputEntry id="UnaryTests_3"><text>"Summer"</text></inputEntry>
        <inputEntry id="UnaryTests_4"><text></text></inputEntry>
        <outputEntry id="LiteralExpression_2"><text>"Salad"</text></outputEntry>
      </rule>
    </decisionTable>
  </decision>
  <dmndi:DMNDI>
    <dmndi:DMNDiagram id="DMNDiagram_1">
      <dmndi:DMNShape id="DMNShape_1" dmnElementRef="Decision_0abc">
        <dc:Bounds height="80" width="180" x="160" y="100" />
      </dmndi:DMNShape>
    </dmndi:DMNDiagram>
  </dmndi:DMNDI>
</definitions>
```

### D-MODELER-C8 — hand-written Camunda Modeler (C8) file `risk.dmn`

Root: `<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/"
xmlns:modeler="http://camunda.org/schema/modeler/1.0" id="Definitions_1" name="Risk"
namespace="http://camunda.org/schema/1.0/dmn" modeler:executionPlatform="Camunda Cloud"
modeler:executionPlatformVersion="8.5.0">`. **No DMNDI.** One decision
`<decision id="Risk_1" name="Risk">` with a decision table (hit policy omitted ⇒ UNIQUE):

- input `Input_1` label `Age`, `inputExpression typeRef="number"`, text `age`;
- input `Input_2` label `Payload`, `inputExpression` with **typeRef="Any"**, text `payload`;
- input `Input_3` label `Extra`, `inputExpression` with **no typeRef**, text `extra`;
- output `Output_1` label `Risk`, `name="risk"`, `typeRef="string"`;
- rule 1: `>= 18`, empty, empty → `"LOW"`; rule 2: `< 18`, `-`, empty → `"HIGH"`.

### D-BARE — minimal hand-written file `bare.dmn`

Only the MODEL namespace (no `modeler:`, no `camunda:`, no DMNDI), `id="defs"`,
`namespace="urn:x"`, one decision `<decision id="Bare">` **without a `name`**, a table with
one input (`x`, no typeRef, no label) and one output (`y`, `typeRef="string"`, no label) and
one rule `1` → `"one"`.

### D-MULTI — two decision tables in one file `drd.dmn`

C7-style root (no modeler attributes). Decisions in document order:
`<decision id="Eligibility" name="Eligibility">` (table: input `age` integer, output
`eligible` boolean; rules `>= 18` → `true`, `< 18` → `false`) and
`<decision id="Offer" name="Offer">` with an `<informationRequirement>` on `Eligibility`
(table: input `eligible` boolean, output `offer` string; rules `true` → `"GOLD"`,
`false` → `"NONE"`). Plus an `<inputData id="Applicant" name="Applicant">` element and a
DMNDI with one shape per element and a `DMNEdge` for the requirement.

### D-LITERAL — a decision with a literal expression only `lit.dmn`

`<decision id="Greeting" name="Greeting"><variable name="Greeting" typeRef="string" />
<literalExpression id="le1"><text>"hello"</text></literalExpression></decision>`, no
decision table anywhere in the file.

### D-MIXED — `mixed.dmn`

D-LITERAL's `Greeting` decision followed by D-MULTI's `Eligibility` decision (table).

---

## A. CLI basics and output path

### IMPORT-001 — import a C7 file produced by the tool, default output path

- **Given** `dmn1` = `out/FEES.dmn` from converting W-C7 (no flags).
- **When** `excel2dmn import out/FEES.dmn`.
- **Then** exit `0`; stderr empty; `out/FEES.xlsx` exists (the input path with `.dmn`
  replaced by `.xlsx`); stdout has one success line naming `1` decision and the path of
  `out/FEES.xlsx`; stdout does **not** mention `camunda8`.
- **Spec:** README: Usage (`excel2dmn import existing.dmn -o existing.xlsx`); §6.6 last
  paragraph (hint only for a Camunda 8 source). Default `<input>.xlsx` naming and the
  success line wording are **spec silent** (CLI `--help` documents `default: <input>.xlsx`).

### IMPORT-002 — `-o` writes exactly the requested file

- **Given** `dmn1` from W-C7.
- **When** `excel2dmn import out/FEES.dmn -o back/rules.xlsx` with `back/` existing.
- **Then** exit `0`; `back/rules.xlsx` exists; no `out/FEES.xlsx` was created; the success
  line names `back/rules.xlsx` (as an absolute path or the path as given).
- **Spec:** README: Usage.

### IMPORT-003 — `-o` relative path is resolved against cwd

- **Given** cwd = temp dir `T`, `T/in/FEES.dmn` from W-C7.
- **When** import with `-o result.xlsx`.
- **Then** `T/result.xlsx` exists (not `T/in/result.xlsx`).
- **Spec:** spec silent — standard CLI convention.

### IMPORT-004 — `-o` into a directory that does not exist yet

- **Given** `dmn1` from W-C7; `T/new/deeper/` does not exist.
- **When** import with `-o new/deeper/x.xlsx`.
- **Then** exit `0`; parent directories are created; `T/new/deeper/x.xlsx` exists.
- **Spec:** §7.3 (decided: create missing parent directories, like convert).

### IMPORT-005 — `-o` overwrites an existing workbook

- **Given** `T/x.xlsx` exists with unrelated content (sheet `Old`).
- **When** import W-C7's `dmn1` with `-o x.xlsx`.
- **Then** exit `0`; `x.xlsx` now has exactly one sheet (the imported decision), no `Old`.
- **Spec:** spec silent — consistent with convert overwriting its outputs.

### IMPORT-006 — upper-case `.DMN` extension maps to `.xlsx`

- **Given** W-C7's `dmn1` copied to `T/RULES.DMN`.
- **When** `excel2dmn import RULES.DMN`.
- **Then** exit `0`; `T/RULES.xlsx` exists; `RULES.DMN` is unchanged (same bytes).
- **Spec:** spec silent (extension match should be case-insensitive).

### IMPORT-007 — input without a `.dmn` extension never overwrites the input

- **Given** W-C7's `dmn1` copied to `T/rules.xml`.
- **When** `excel2dmn import rules.xml` (no `-o`).
- **Then** exit `0`; `T/rules.xml` still holds the original XML bytes; the workbook is
  written to a different path (`T/rules.xml.xlsx` or `T/rules.xlsx`) that the success line
  names.
- **Spec:** spec silent. Overwriting the source file with a workbook is never acceptable.

### IMPORT-008 — paths containing spaces work

- **Given** `T/my rules/FEES v2.dmn` from W-C7.
- **When** `excel2dmn import "my rules/FEES v2.dmn"`.
- **Then** exit `0`; `T/my rules/FEES v2.xlsx` exists.
- **Spec:** spec silent.

### IMPORT-009 — import does not modify the source DMN

- **Given** `dmn1` from W-C7, bytes recorded.
- **When** import it (with and without `-o`).
- **Then** `dmn1` bytes are unchanged; `listFiles(out)` gains only the `.xlsx`.
- **Spec:** spec silent.

### IMPORT-010 — `import` with no argument is a usage error

- **When** `excel2dmn import`.
- **Then** exit code non-zero; stderr mentions the missing argument (`input.dmn` / "missing
  required argument"); no file written.
- **Spec:** spec silent (commander usage error).

### IMPORT-011 — `import --help` documents `-o` and `--config`

- **When** `excel2dmn import --help`.
- **Then** exit `0`; stdout lists `-o, --out <file>` and `--config <file>`.
- **Spec:** README: Usage; spec silent on help text.

### IMPORT-012 — unknown option is rejected

- **When** `excel2dmn import out/FEES.dmn --platform camunda8`.
- **Then** exit non-zero; stderr names the unknown option `--platform`; no `.xlsx` written.
- **Spec:** spec silent. The platform is detected from the file (§6.6); `import` takes no
  `--platform`.

---

## B. Platform detection and the re-convert hint

### IMPORT-013 — C8 source prints the re-convert hint

- **Given** `dmn1` = convert W-C8 with `--platform camunda8`.
- **When** `excel2dmn import out/FEES.dmn -o back.xlsx`.
- **Then** exit `0`; stdout, after the success line, contains a hint that the source is
  Camunda 8 and the command `excel2dmn <path-to-back.xlsx> --platform camunda8`.
- **Spec:** §6.6 last paragraph ("surfaced by the CLI as a hint"); README: Usage, Camunda 8
  round-trip note.

### IMPORT-014 — the hint's command is copy-pasteable and works

- **Given** IMPORT-013's stdout.
- **When** extract the command after `re-convert with:` (or equivalent) and run its
  arguments through `runCli` (after `excel2dmn`, splitting as a POSIX shell would) with
  `--out-dir out2` appended.
- **Then** exit `0`; `out2/FEES.dmn` equals `dmn1` byte for byte.
- **Spec:** §6.6; README: Camunda 8 round-trip note.

### IMPORT-015 — hint path with spaces is shell-quoted

- **Given** C8 `dmn1`; output `-o "my out/fees file.xlsx"`.
- **When** import.
- **Then** the hint contains `'<abs>/my out/fees file.xlsx'` wrapped in single quotes;
  the unquoted form does not appear as a bare argument.
- **Spec:** spec silent on quoting; required for the hint to be copy-pasteable (§6.6).

### IMPORT-016 — hint path with a single quote is escaped

- **Given** C8 `dmn1`; `-o "it's.xlsx"`.
- **When** import.
- **Then** the hint contains `'<abs-dir>/it'\''s.xlsx'` (POSIX `'\''` escaping); running the
  command line through `sh -c` resolves to the existing file.
- **Spec:** spec silent.

### IMPORT-017 — hint path with shell metacharacters is quoted

- **Given** C8 `dmn1`; `-o 'a;b$c.xlsx'`.
- **When** import.
- **Then** the hint wraps the path in single quotes so `;` and `$` are literal.
- **Spec:** spec silent.

### IMPORT-018 — safe path is printed bare

- **Given** C8 `dmn1`; `-o back/fees_v2.xlsx` (only `[\w./-]` characters).
- **Then** the hint contains the absolute path unquoted.
- **Spec:** spec silent.

### IMPORT-019 — C7 source prints no Camunda 8 hint

- **Given** `dmn1` from W-C7 (no `modeler:` attributes).
- **When** import.
- **Then** stdout does not contain `--platform` nor `Camunda 8`.
- **Spec:** §6.6 (only `"Camunda Cloud"` → `camunda8`).

### IMPORT-020 — `modeler:executionPlatform="Camunda Platform"` is Camunda 7

- **Given** D-MODELER-C7.
- **When** import.
- **Then** exit `0`; no `--platform camunda8` hint.
- **Spec:** §6.6 ("`"Camunda Cloud"` → `camunda8`"); C7 Modeler files carry "Camunda
  Platform".

### IMPORT-021 — hand-written Modeler C8 file prints the hint

- **Given** D-MODELER-C8.
- **When** import.
- **Then** exit `0`; stdout contains `--platform camunda8`.
- **Spec:** §6.6.

### IMPORT-022 — version hint when source version differs from config

- **Given** D-MODELER-C8 (`executionPlatformVersion="8.5.0"`), default config (8.6.0).
- **When** import.
- **Then** stdout additionally contains a hint naming `8.5.0` and the config key
  `executionPlatformVersion` (e.g. `"camunda8": { "executionPlatformVersion": "8.5.0" }`).
- **Spec:** spec silent — the workbook does not carry the version (§6.6 "does not carry the
  platform"), so re-converting would silently retarget 8.6.0; a hint is the reasonable
  expectation. Default 8.6.0 from §6.6 / example config.

### IMPORT-023 — no version hint when versions match

- **Given** C8 `dmn1` from W-C8 (version `8.6.0`), default config.
- **When** import.
- **Then** the `--platform camunda8` hint is printed; no line mentions
  `executionPlatformVersion`.
- **Spec:** spec silent (see IMPORT-022).

### IMPORT-024 — no version hint when `--config` already targets the source version

- **Given** D-MODELER-C8; `c.json` = `{ "camunda8": { "executionPlatformVersion": "8.5.0" } }`.
- **When** `excel2dmn import risk.dmn --config c.json`.
- **Then** platform hint printed; no version hint.
- **Spec:** spec silent; §7.1 config precedence.

### IMPORT-025 — `excel2dmn.config.json` in cwd is honoured for the version comparison

- **Given** D-MODELER-C8; cwd `excel2dmn.config.json` = same as IMPORT-024's `c.json`.
- **When** import without `--config`.
- **Then** no version hint.
- **Spec:** §7.1 precedence ("`excel2dmn.config.json` in CWD").

### IMPORT-026 — C8 source without `executionPlatformVersion`

- **Given** D-MODELER-C8 with the `modeler:executionPlatformVersion` attribute removed.
- **When** import.
- **Then** exit `0`; platform hint printed; no version hint.
- **Spec:** spec silent.

### IMPORT-027 — no `modeler:` attributes at all ⇒ Camunda 7

- **Given** D-BARE.
- **When** import.
- **Then** exit `0`; no platform hint.
- **Spec:** §6.6 (default platform `camunda7`, §7.1).

### IMPORT-028 — platform value matching is case-insensitive

- **Given** D-MODELER-C8 with `modeler:executionPlatform="camunda cloud"`.
- **When** import.
- **Then** platform hint printed.
- **Spec:** spec silent; reasonable to match the documented value case-insensitively.

### IMPORT-029 — hint goes to stdout, exit code stays 0

- **Given** C8 `dmn1`.
- **Then** the hint lines are on stdout (not stderr) and the exit code is `0`.
- **Spec:** spec silent; a hint is informational, not an error (§6.6 "hint").

---

## C. Round-trips — Camunda 7

### IMPORT-030 — baseline C7 round-trip is byte-identical

- **Given** W-C7.
- **When** `RT([], none)`.
- **Then** `dmn2 === dmn1`; both re-parse cleanly.
- **Spec:** §1 Goals ("round-trips losslessly"); README feature list ("round-trips
  byte-identically"); §6.4 deterministic ids.

### IMPORT-031 — imported C7 sheet layout (4-row)

- **Given** W-C7 → `dmn1` → import.
- **Then** the workbook has exactly one sheet whose name contains `DMN`; the marker row has
  one `policy` cell with `UNIQUE` below it, one `id`/`ID` cell with `FEES` below it, one
  `name` cell with `Fee Decision` below it, `input` × 3 (`amount`, `region`, `tags`) then
  `output` × 2 (`fee`, `tier`) in that order, and one `annotations` column; type row reads
  `integer`, `string`, `Any`, `double`, `string`; label row reads `Amount`, `Region`,
  `Tags`, `Fee`, `Tier`; rule rows hold `< 100`/`"EU"`/_(empty)_/`1.5`/`"LOW"`/`small EU`
  and `>= 100`/_(empty)_/`"vip"`/`0`/`"HIGH"`/_(empty)_; the row after the last rule is
  empty in every input/output column.
- **Spec:** §3.1 (4-row header), §3.2 (roles, column order preserved), §3.3 (any-input
  emitted as empty), §3.4 (policy at M+1).

### IMPORT-032 — C7 `historyTimeToLive` from config survives the round-trip

- **Given** W-C7; `c.json` = `{ "camunda": { "historyTimeToLive": "P30D", "versionTag": "1.2" } }`.
- **When** `RT(--config c.json)`.
- **Then** `dmn2 === dmn1`; both contain `camunda:historyTimeToLive="P30D"` and
  `camunda:versionTag="1.2"`.
- **Spec:** §6.5; §1 round-trip.

### IMPORT-033 — C7 extension values in the source are not carried by the workbook

- **Given** D-MODELER-C7 (`historyTimeToLive="P30D"`, `versionTag="2"`).
- **When** import, then convert `dish.xlsx` with default config.
- **Then** convert exit `0`; output has `camunda:historyTimeToLive="P180D"` (config default)
  and no `camunda:versionTag`.
- **Spec:** spec silent. The template has no cell for these (§3.1/§3.2), so the config
  value applies (§6.5). Optional improvement (not required): an import hint analogous to
  IMPORT-022.

### IMPORT-034 — allowed values survive the round-trip (5-row layout)

- **Given** W-C7-AV.
- **When** `RT(--config av.json)`.
- **Then** `dmn2 === dmn1`; `dmn1` contains `<inputValues>` for `amount` and `region` and
  `<outputValues>` for `tier`, none for `tags`/`fee`.
- **Spec:** §3.6, §6.1 (inputValues/outputValues); §1 round-trip.

### IMPORT-035 — imported sheet puts allowed values above the label row

- **Given** W-C7-AV → `dmn1` → import with `--config av.json`.
- **Then** row M+3 holds `[0..10000]`, `"EU","US"`, _(empty)_, _(empty)_, `"LOW","HIGH"` for
  amount/region/tags/fee/tier; row M+4 holds the labels; rules start at M+5.
- **Spec:** §3.1 allowed-values table; §3.6.

### IMPORT-036 — DMN with allowed values imported under the default 4-row config

- **Given** W-C7-AV → `dmn1`.
- **When** import **without** a config.
- **Then** exit `0`; the workbook uses the 5-row layout (allowed values at M+3, labels at
  M+4, rules from M+5) so nothing is lost; converting it with `--config av.json` gives
  `dmn2 === dmn1`.
- **Spec:** §1 lossless import; §3.1/§3.6 layout. (The auto-upgrade itself is spec silent.)

### IMPORT-037 — the 5-row auto-upgrade is announced

- **Given** IMPORT-036.
- **Then** stdout contains a hint that the template uses the allowed-values layout and how
  to enable it on re-convert (mentions `allowedValuesOffset`, `labelOffset` and
  `startOffset`, with the values `3`, `4` and `5`); importing with the 5-row config prints no hint.
- **Spec:** spec silent. Without it, re-converting with the default config misreads the
  allowed-values row as the label row and the label row as a rule (§3.1 offsets). Decided:
  print the hint (§7.3).

### IMPORT-038 — no auto-upgrade when the DMN has no allowed values

- **Given** W-C7 → `dmn1` → import with default config.
- **Then** labels are at M+3 and rules start at M+4 (4-row layout); no allowed-values hint.
- **Spec:** §3.1 (`allowedValuesOffset` default `null`).

### IMPORT-039 — annotations survive, including empty ones

- **Given** W-C7 extended with a third rule (row 7: `>= 1000`, `"US"`, `-`, `0`, `"HIGH"`,
  annotation `bulk | over 1k`).
- **When** `RT([], none)`.
- **Then** `dmn2 === dmn1`; `dmn1` has `<description>small EU</description>` on `rule_1`,
  none on `rule_2`, `<description>bulk | over 1k</description>` on `rule_3`.
- **Spec:** §3.2 annotations, §3.3, §6.4 (`<description>` only when non-empty).

### IMPORT-040 — table without any annotation has no annotations column after import

- **Given** W-C7 with column I removed.
- **When** convert → import.
- **Then** the marker row has no `annotations` cell; `RT` is byte-identical.
- **Spec:** §3.2 ("Optional"); spec silent on the importer omitting the column.

### IMPORT-041 — multi-column annotations collapse into one and stay stable

- **Given** W-C7 with a second `annotations` column J; row 5 J = `check rate`.
- **When** `RT([], none)`.
- **Then** `dmn1` rule_1 description = `small EU | check rate`; the imported sheet has one
  `annotations` column holding `small EU | check rate`; `dmn2 === dmn1`.
- **Spec:** §3.2 (joined with `markers.annotationSeparator`).

### IMPORT-042 — every non-default hit policy round-trips (C7)

- **Given** W-C7 with policy cell = each of `FIRST`, `ANY`, `COLLECT`, `RULE ORDER`.
- **When** `RT([], none)` for each.
- **Then** `dmn2 === dmn1`; `dmn1` carries `hitPolicy="<policy>"`; the imported sheet's
  policy column holds `<policy>` at M+1.
- **Spec:** §3.4; §6.1 (non-default hitPolicy written); §6.4.

### IMPORT-043 — UNIQUE round-trips with no `hitPolicy` attribute

- **Given** W-C7 (UNIQUE).
- **Then** neither `dmn1` nor `dmn2` contains `hitPolicy=`; the imported policy cell is
  `UNIQUE`.
- **Spec:** §6.1 ("moddle OMITS it"), §6.4.

### IMPORT-044 — COLLECT aggregators round-trip (C7)

- **Given** W-SUM with `<AGG>` = each of `SUM`, `MIN`, `MAX`, `COUNT`.
- **When** `RT([], none)`.
- **Then** `dmn1` has `hitPolicy="COLLECT" aggregation="<AGG>"`; the imported sheet's policy
  column holds `COLLECT` at M+1 and `<AGG>` at M+2; `dmn2 === dmn1`.
- **Spec:** §3.4 (aggregator at M+2), §7.1 `hitPolicy.aggregatorOffset`.

### IMPORT-045 — COLLECT without aggregator round-trips

- **Given** W-SUM with `<AGG>` empty.
- **Then** `dmn1` has `hitPolicy="COLLECT"` and no `aggregation=`; `dmn2 === dmn1`; the
  imported policy column's M+2 cell is empty.
- **Spec:** §3.4 ("optional aggregator").

### IMPORT-046 — PRIORITY and OUTPUT ORDER round-trip on Camunda 7

- **Given** W-PRIO with `<POLICY>` = `PRIORITY` and = `OUTPUT ORDER`.
- **When** `RT(--config av.json)`.
- **Then** `dmn2 === dmn1`; `<outputValues>` holds `"A","B","C"` in that order.
- **Spec:** §3.6 (required for PRIORITY/OUTPUT ORDER; order defines ranking), §6.1.

### IMPORT-047 — Any columns round-trip with the default (omitted) typeRef

- **Given** W-C7 (`tags` = `Any`).
- **Then** in `dmn1` and `dmn2` the `tags` `<inputExpression>` has no `typeRef`; the imported
  type cell is exactly `Any`; `dmn2 === dmn1`.
- **Spec:** §4 notes (omit typeRef; normalized to canonical `Any` on import); §6.1.

### IMPORT-048 — Any alias spellings in the source workbook normalise to `Any`

- **Given** W-C7 with `tags` type = `object`, plus an extra `Any`-typed output `meta` typed
  `None` (entries `null`, `null`).
- **When** convert → import → convert.
- **Then** imported type cells for `tags` and `meta` are exactly `Any`; `dmn2 === dmn1`
  (neither has a typeRef on those columns).
- **Spec:** §3.1 Type row (aliases), §4 notes, README: The sheet template.

### IMPORT-049 — Any columns round-trip with `anyDmnPlaceholder: "Any"`

- **Given** W-C7; `c.json` = `{ "types": { "anyDmnPlaceholder": "Any" } }`.
- **When** `RT(--config c.json)`.
- **Then** `dmn1` has `typeRef="Any"` on `tags`; the imported type cell is `Any`;
  `dmn2 === dmn1`.
- **Spec:** §4 notes; §7.1 `types.anyDmnPlaceholder`.

### IMPORT-050 — "any" input entries (`-` and empty) round-trip as empty

- **Given** W-C7 (row 5 `tags` = `-`, row 6 `region` empty).
- **Then** `dmn1` has `<text></text>` for both (no `<text>-</text>`); the imported cells are
  empty; `dmn2 === dmn1`.
- **Spec:** §3.3 any-token, §4 notes.

### IMPORT-051 — empty output entries round-trip

- **Given** W-C7 with row 6 `tier` empty.
- **Then** `dmn1` has an empty `<text></text>` for `tier_2`; the imported cell is empty;
  `dmn2 === dmn1`.
- **Spec:** §3.3/§4 ("Empty output cell ⇒ `""`").

### IMPORT-052 — XML-special characters in entries round-trip

- **Given** W-C7 with `region` row 5 = `"A&B","<x>"` and `tier` row 5 = `"it's \"q\""`.
- **Then** the imported cells hold the exact unescaped FEEL text; `dmn2 === dmn1`.
- **Spec:** §1 lossless round-trip; §3.3 (verbatim).

### IMPORT-053 — Unicode in names, labels, entries and annotations round-trips

- **Given** W-C7 with name `Opłata – Zürich`, label `Kwota ≤ limit`, `tier` entry `"Zażółć"`,
  annotation `naïve ✓`.
- **Then** imported cells match exactly; `dmn2 === dmn1`.
- **Spec:** §5 last bullet ("preserve interior UTF-8"), §6.4 (name verbatim).

### IMPORT-054 — decision without a separate name (name == id)

- **Given** W-C7 with column C (`name`) removed.
- **When** `RT([], none)`.
- **Then** `dmn1` has `<decision id="FEES" name="FEES">`; the imported sheet has no `name`
  marker column; `dmn2 === dmn1`.
- **Spec:** §3.2 (`name` optional; falls back to the id value).

### IMPORT-055 — helper columns are dropped and the second round-trip is stable

- **Given** W-C7 with helper columns `No.` (blank marker) and `NOT PART OF DMN` banner.
- **When** `RT([], none)`.
- **Then** the imported sheet has no helper columns; `dmn2 === dmn1`.
- **Spec:** §3.2 (helpers ignored entirely), §1.

### IMPORT-056 — header shifted down / leading blank columns in the source

- **Given** W-C7 with two blank rows above the marker row and one blank leading column.
- **When** `RT([], none)`.
- **Then** `dmn2 === dmn1` (sheet position never affects the DMN).
- **Spec:** §3.1 (position-independent header), §6.4 (ids from names and seq, not rows).

### IMPORT-057 — every Camunda 7 type round-trips

- **Given** a sheet `Types DMN` (`ID` `TYPES`) with inputs `s` string `"A"`, `b` boolean
  `true`, `i` integer `> 1`, `l` long `< 10`, `d` double `>= 1.5`, `dt` date
  `< date("2026-01-01")`, `x` Any `-`; output `r` string `"OK"`.
- **When** `RT([], none)`.
- **Then** type cells read back exactly as written; `dmn2 === dmn1`.
- **Spec:** §3.1 Type row (Camunda types); §1.

### IMPORT-058 — boolean entries round-trip as lower-case FEEL

- **Given** a table with a `boolean` input whose cells are real Excel booleans `TRUE`/`FALSE`.
- **When** convert → import.
- **Then** `dmn1` entries are `true`/`false`; imported cells hold `true`/`false` (text or
  boolean, but convert back to `true`/`false`); `dmn2 === dmn1`.
- **Spec:** §5 cell-value extraction (boolean coercion).

### IMPORT-059 — numeric entries are not reformatted by Excel

- **Given** a `double` output with entries `1.50`, `1000000`, `0.1`.
- **When** convert → import → convert.
- **Then** `dmn2 === dmn1` (the numbers come back with identical text).
- **Spec:** §5 ("emit canonical FEEL … never Excel's formatted string"); §1 round-trip.

### IMPORT-060 — `--no-pretty` output round-trips

- **When** `RT(--no-pretty)` on W-C7.
- **Then** `dmn2 === dmn1`; `dmn1` is a single-line document after the XML declaration.
- **Spec:** §7 (`--pretty`, default true); §7.1 `output.format`.

### IMPORT-061 — prefixed namespace style round-trips

- **Given** W-C7; `c.json` = `{ "output": { "namespaceStyle": "prefixed" } }`.
- **When** `RT(--config c.json)`.
- **Then** `dmn1` uses `<dmn:definitions xmlns:dmn=…>`; import succeeds; `dmn2 === dmn1`.
- **Spec:** §6.3 namespace style; §7.1 `output.namespaceStyle`.

### IMPORT-062 — custom namespace and rule-id template round-trip with the same config

- **Given** W-C7; `c.json` = `{ "output": { "namespace": "urn:acme" }, "rules": { "idTemplate": "rule_<row>" } }`.
- **When** `RT(--config c.json)` (import also gets `--config c.json`).
- **Then** `dmn1` has `namespace="urn:acme"` and rule ids `rule_5`, `rule_6`; `dmn2 === dmn1`.
- **Spec:** §7.1 (`rules.idTemplate` `<row>`), §7 `--namespace`.

### IMPORT-063 — round-trip is a fixed point (second cycle changes nothing)

- **Given** W-C7.
- **When** convert → import → convert → import → convert (`dmn1`, `dmn2`, `dmn3`).
- **Then** `dmn1 === dmn2 === dmn3`; the two imported workbooks have identical cell values.
- **Spec:** §6.4 determinism; §1.

### IMPORT-064 — the reference shipping-rates golden file round-trips

- **Given** `test/fixtures/shipping_rates.expected.dmn` (no allowed values) copied into `T`.
- **When** import with default config → convert the produced workbook with default config.
- **Then** the converted file equals the golden file byte for byte; likewise
  `shipping_rates.c8.expected.dmn` imported and re-converted with `--platform camunda8`
  equals itself.
- **Spec:** §3.5 worked mapping; README feature list; §6.6.

---

## D. Round-trips — Camunda 8

### IMPORT-065 — baseline C8 round-trip is byte-identical with `--platform camunda8`

- **Given** W-C8.
- **When** `RT(--platform camunda8)`.
- **Then** `dmn2 === dmn1`; both carry `modeler:executionPlatform="Camunda Cloud"` and
  `modeler:executionPlatformVersion="8.6.0"`, no `camunda:` attributes.
- **Spec:** §6.6 last paragraph (two-step round-trip); README: Camunda 8 round-trip note.

### IMPORT-066 — re-converting a C8 import without `--platform camunda8` fails on C8 types

- **Given** W-C8 → `dmn1` → import → `back.xlsx`.
- **When** `excel2dmn back.xlsx --out-dir out2` (default C7).
- **Then** exit `1`; stderr names the `number` (and `dateTime`) type cells of the `amount`,
  `fee` and `when` columns with `Sheet!Cell` coordinates; no `.dmn` written for that sheet.
- **Spec:** §6.6 ("otherwise the default Camunda 7 type check rejects C8-only types such as
  `number`"); §3.1 (`nonCamundaTypeAction` default `error`); README note.

### IMPORT-067 — C7-only numeric types become `number` and stay stable

- **Given** W-C7 (integer/double columns) converted with `--platform camunda8`.
- **When** `RT(--platform camunda8)`.
- **Then** `dmn1` has `typeRef="number"` for `amount` and `fee`; the imported type cells are
  `number`; `dmn2 === dmn1`.
- **Spec:** §6.6 (C7 numeric types normalised to `number`, `types.camunda8NumericAlias`).

### IMPORT-068 — every C8 FEEL type round-trips

- **Given** a sheet with inputs typed `number`, `time`, `dateTime`, `dayTimeDuration`,
  `yearMonthDuration`, `date`, `string`, `boolean`, `Any` (entries as in the convert-C8
  W-TYPES fixture).
- **When** `RT(--platform camunda8)`.
- **Then** the imported type cells are exactly those names; `dmn2 === dmn1`.
- **Spec:** §6.6 (full FEEL type set on C8).

### IMPORT-069 — allowed values round-trip on C8

- **Given** W-C8 in the 5-row layout with W-C7-AV's allowed values.
- **When** `RT(--platform camunda8 --config av.json)`.
- **Then** `dmn2 === dmn1`; `<inputValues>`/`<outputValues>` present.
- **Spec:** §3.6, §6.6 ("Everything else … identical").

### IMPORT-070 — annotations round-trip on C8

- **Given** W-C8.
- **Then** `dmn1` and `dmn2` carry `<description>small EU</description>` on `rule_1`;
  `dmn2 === dmn1`.
- **Spec:** §3.2; §6.6.

### IMPORT-071 — supported hit policies round-trip on C8

- **Given** W-C8 with policy = `FIRST`, `ANY`, `RULE ORDER`, `COLLECT`; and W-SUM with
  `SUM`/`MIN`/`MAX`/`COUNT` converted for C8.
- **When** `RT(--platform camunda8)` each.
- **Then** `dmn2 === dmn1`; hit policy and aggregator present in the imported policy column.
- **Spec:** §6.6 (C8 supports UNIQUE, ANY, FIRST, RULE ORDER, COLLECT); §3.4.

### IMPORT-072 — Any columns on C8 are written as `Any` and omitted in DMN

- **Given** W-C8.
- **Then** the `tags` column has no typeRef in `dmn1`/`dmn2`; the imported type cell is
  `Any`; `dmn2 === dmn1`.
- **Spec:** §4 notes.

### IMPORT-073 — non-default target version round-trips with the matching config

- **Given** W-C8; `v.json` = `{ "platform": "camunda8", "camunda8": { "executionPlatformVersion": "8.5.0" } }`.
- **When** `RT(--config v.json)`, the import also using `--config v.json`.
- **Then** `dmn1` and `dmn2` carry `executionPlatformVersion="8.5.0"`; `dmn2 === dmn1`; the
  import prints the platform hint but no version hint.
- **Spec:** §6.6 bullet 1 (config `camunda8.executionPlatformVersion`); version hint spec
  silent (IMPORT-022).

### IMPORT-074 — re-converting a non-default-version C8 import with defaults retargets 8.6.0

- **Given** IMPORT-073's `dmn1` (8.5.0) imported **without** config.
- **When** convert `back.xlsx --platform camunda8`.
- **Then** exit `0`; output differs from `dmn1` only in `executionPlatformVersion="8.6.0"`
  (replace that attribute value and the files are equal); the import printed the version
  hint (IMPORT-022).
- **Spec:** §6.6; spec silent on the hint.

### IMPORT-075 — C8 file re-built as C7 drops modeler metadata (cross-platform)

- **Given** W-C7 converted with `--platform camunda8` (types become `number`), imported.
- **When** convert `back.xlsx` with `--platform camunda7` and
  `c.json` = `{ "types": { "nonCamundaTypeAction": "off" } }`.
- **Then** exit `0`; output has no `modeler:` attributes and has
  `camunda:historyTimeToLive="P180D"`.
- **Spec:** §6.6 (namespaces never co-occur), §6.5, §7.1 `nonCamundaTypeAction`.

### IMPORT-076 — C7 file re-built for C8 normalises types and drops C7 extensions

- **Given** W-C7 → `dmn1` (C7) → import.
- **When** convert `back.xlsx --platform camunda8`.
- **Then** exit `0`; output has `modeler:executionPlatform="Camunda Cloud"`, no
  `camunda:historyTimeToLive`, `typeRef="number"` on integer/double columns; it equals the
  direct `convert W-C7 --platform camunda8` output byte for byte.
- **Spec:** §6.6.

---

## E. Hand-written and Camunda-Modeler-style DMN

### IMPORT-077 — Modeler C7 file imports with its content intact

- **Given** D-MODELER-C7.
- **When** `excel2dmn import dish.dmn`.
- **Then** exit `0`; one sheet whose name contains `DMN` (e.g. `Dish DMN`); policy `FIRST`;
  id cell `Decision_0abc`; name cell `Dish`; inputs `season` (string, label `Season`),
  `guestCount` (integer, label `Guests`); output `dish` (string, label `Dish`); rule 1
  `"Winter"`, `<= 8`, `"Roastbeef"`, annotation `winter feast`; rule 2 `"Summer"`,
  _(empty)_, `"Salad"`, no annotation.
- **Spec:** §1 Goals ("existing `.dmn` files can be pulled back into the template");
  §3.1–§3.4 template layout.

### IMPORT-078 — Modeler C7 file re-converts with normalised ids

- **Given** IMPORT-077's `dish.xlsx`.
- **When** convert with default config.
- **Then** exit `0`; decision id `DECISION_0ABC`, name `Dish`; rule ids `rule_1`, `rule_2`;
  input ids `season`, `guestCount`; entry ids `season_1`, `guestCount_2`, `dish_1`; one
  `DMNShape_DECISION_0ABC`; re-parses cleanly.
- **Spec:** §6.4 id scheme (decision id sanitized to UPPER_SNAKE, readable deterministic
  ids); §6.2 DMNDI.

### IMPORT-079 — Modeler C7 file reaches a fixed point after one cycle

- **Given** IMPORT-078's output `dmnA`.
- **When** import `dmnA` → convert → `dmnB`.
- **Then** `dmnB === dmnA`.
- **Spec:** §6.4 determinism; §1.

### IMPORT-080 — Modeler C8 file: `typeRef="Any"` and missing typeRef become `Any`

- **Given** D-MODELER-C8.
- **When** import.
- **Then** exit `0`; type cells: `age` = `number`, `payload` = `Any`, `extra` = `Any`
  (exactly this spelling); output `risk` = `string`.
- **Spec:** §4 notes ("an untyped column's `typeRef` (`Any`/`None`/`object`/absent) is
  normalized to the canonical `Any`").

### IMPORT-081 — untyped spellings `any`, `None`, `object`, `OBJECT` are normalised

- **Given** D-BARE variants where the input `typeRef` is each of `any`, `None`, `object`,
  `OBJECT`, and the output `typeRef` is `Any`.
- **When** import.
- **Then** every such type cell is exactly `Any`.
- **Spec:** §4 notes; §7.1 `types.anyAliases`.

### IMPORT-082 — Modeler C8 file without DMNDI round-trips through C8 convert

- **Given** D-MODELER-C8 → import → convert `--platform camunda8` → `dmnA`.
- **Then** exit `0`; `dmnA` re-parses cleanly, contains a DMNDI with
  `DMNShape_RISK_1`, `modeler:executionPlatform="Camunda Cloud"`; the empty and `-`
  input entries are all `<text></text>`; importing `dmnA` and converting again gives the
  same bytes.
- **Spec:** §6.2 (DMNDI generated), §3.3 (any tokens), §6.6.

### IMPORT-083 — file without decision name uses the id as the sheet/name

- **Given** D-BARE.
- **When** import.
- **Then** exit `0`; sheet name contains `Bare` and `DMN`; id cell `Bare`; no `name`
  column (or a name equal to the id); type cell of `x` is `Any`; label cells empty.
- **Spec:** §3.2 (name falls back to id); §4 notes. Sheet naming is spec silent.

### IMPORT-084 — extra namespaces and unknown extension attributes are tolerated

- **Given** D-MODELER-C7 plus `xmlns:biodi="http://bpmn.io/schema/dmn/biodi/2.0"`,
  `biodi:width="192"` on `<input>`, and a `<extensionElements>` with a foreign element
  inside the decision.
- **When** import.
- **Then** exit `0`; workbook content identical to IMPORT-077's.
- **Spec:** spec silent. Foreign markup carries no decision logic (§1 non-goals) so it is
  ignored.

### IMPORT-085 — `<text>-</text>` input entries become empty cells

- **Given** D-BARE with a second rule whose input entry is `<text>-</text>`.
- **When** import → convert.
- **Then** the imported cell is `-` or empty; the converted DMN has `<text></text>` for it.
- **Spec:** §3.3 (`-` is an any-token; "never emits a literal `<text>-</text>`").

### IMPORT-086 — prefixed `dmn:` source file imports

- **Given** D-MODELER-C7 rewritten with `xmlns:dmn=` and `dmn:`-prefixed tags.
- **When** import.
- **Then** exit `0`; workbook identical to IMPORT-077's.
- **Spec:** §6.3 ("Both are semantically identical valid DMN 1.3").

### IMPORT-087 — input expression that is not a plain name

- **Given** D-BARE where the input text is `order.total` (typeRef `number`) on C8 root.
- **When** import → convert `--platform camunda8`.
- **Then** the name cell is `order.total`; convert exit `0`; all ids in the output are
  valid NCNames and unique; re-parses cleanly.
- **Spec:** §6.4 ("Sanitize each name component … only if it isn't already NCName-safe").

### IMPORT-088 — output without a `name` attribute

- **Given** D-BARE with the output's `name` removed (id `Output_1`).
- **When** import.
- **Then** exit `0`; the output name cell is non-empty (falls back to `Output_1`).
- **Spec:** spec silent; §6.4 ("we always set" output names), so the importer must supply
  one for the template to convert back.

### IMPORT-089 — two inputs with the same expression keep their own entries

- **Given** D-BARE with two inputs both on `amount` (`>= 10` and `< 100` in rule 1).
- **When** import.
- **Then** the two `amount` columns hold `>= 10` and `< 100` respectively (positional, not
  by name).
- **Spec:** §4 notes ("positionally aligned"); §1 lossless.

### IMPORT-090 — input entry with leading/trailing whitespace is normalised on re-convert

- **Given** D-BARE with input entry `<text>  1  </text>`.
- **When** import → convert.
- **Then** the converted entry text is `1`.
- **Spec:** §5 ("Trim leading/trailing whitespace on all extracted values").

### IMPORT-091 — unknown typeRef in the source surfaces on re-convert, not on import

- **Given** D-BARE with input `typeRef="xsd:int"`.
- **When** import, then convert.
- **Then** import exit `0` with type cell `xsd:int`; convert exit `1` with
  `Unknown typeRef 'xsd:int'` and the type cell coordinate.
- **Spec:** §5 Step 2 (`Unknown typeRef 'X' at <sheet>!<cell>`).

### IMPORT-092 — table with zero rules

- **Given** D-BARE with the `<rule>` removed.
- **When** import.
- **Then** exit `0`; a header-only sheet is written; converting it fails with
  `No rules found in <sheet>`.
- **Spec:** §5 Step 3 (no-rules error); import behaviour spec silent.

### IMPORT-093 — table with zero inputs

- **Given** D-BARE with the `<input>` and its entries removed.
- **When** import → convert.
- **Then** both exit `0`; the converted DMN has no `<input>`.
- **Spec:** §5 Step 2 ("Zero `input` columns is allowed … warn but continue").

### IMPORT-094 — Modeler PRIORITY table without outputValues

- **Given** D-MODELER-C7 with `hitPolicy="PRIORITY"` and no `<outputValues>`.
- **When** import → convert.
- **Then** import exit `0`; convert exit `1` with `hitPolicy 'PRIORITY' requires
<outputValues>` naming output `dish`.
- **Spec:** §3.6, §5 Step 2.

### IMPORT-095 — C8 file with a C7-only hit policy

- **Given** D-MODELER-C8 with `hitPolicy="OUTPUT ORDER"` and `<outputValues>` on `risk`.
- **When** import → convert `--platform camunda8`.
- **Then** import exit `0` (hint printed); convert exit `1` with "not supported by Camunda 8".
- **Spec:** §6.6 ("Rejects the PRIORITY and OUTPUT ORDER hit policies").

---

## F. Multiple decisions and sheet naming

### IMPORT-096 — multiple decision tables ⇒ one sheet each, in document order

- **Given** D-MULTI.
- **When** import.
- **Then** exit `0`; the success line reports `2` decisions; the workbook has two sheets,
  first for `Eligibility`, second for `Offer`, each name containing `DMN`; each sheet is a
  complete template (own policy/id/inputs/outputs/rules).
- **Spec:** §3 ("each sheet is fully self-contained"), §4 (one model per sheet).

### IMPORT-097 — multi-decision workbook converts back to one file per decision

- **Given** IMPORT-096's workbook.
- **When** convert `--out-dir out2`.
- **Then** exit `0`; `listFiles(out2)` = `['ELIGIBILITY.dmn', 'OFFER.dmn']`; each re-parses
  cleanly with one decision; `informationRequirement` and `inputData` are not reproduced.
- **Spec:** §3 (N sheets ⇒ N outputs), §7 output filenames. Dropping DRD requirements is
  spec silent (one decision per file, §4).

### IMPORT-098 — a multi-sheet workbook round-trips per sheet

- **Given** a workbook with sheets `Fees DMN` (W-C7) and `Sum DMN` (W-SUM, `SUM`) and a
  non-DMN sheet `Notes`.
- **When** convert → import each `.dmn` → convert each imported workbook.
- **Then** every re-converted file equals its first-pass file byte for byte.
- **Spec:** §3, §1.

### IMPORT-099 — decision tables mixed with a literal-expression decision

- **Given** D-MIXED.
- **When** import.
- **Then** exit `0`; one sheet (`Eligibility`); success line reports `1` decision.
  Recommended (spec silent): stderr/stdout notes that decision `Greeting` was skipped because
  it has no decision table.
- **Spec:** spec silent beyond the template only describing decision tables (§3).

### IMPORT-100 — two decisions with the same name get distinct sheets

- **Given** D-MULTI with both decisions named `Rules` (ids still distinct).
- **When** import.
- **Then** exit `0`; two sheets with distinct names, both containing `DMN`; converting the
  workbook yields `ELIGIBILITY.dmn` and `OFFER.dmn`.
- **Spec:** spec silent; Excel requires unique sheet names.

### IMPORT-101 — long decision name keeps `DMN` in the 31-char sheet name

- **Given** D-BARE with `name="Very Long Shipping Rate Decision Name 2026"` (42 chars).
- **When** import → convert.
- **Then** the sheet name is ≤ 31 characters **and** contains `DMN`; convert exit `0` and
  processes that sheet (decision name in the DMN is the full original name).
- **Spec:** §3 (only sheets containing `DMN` are processed); Excel's 31-char limit is spec
  silent.

### IMPORT-102 — decision name with characters illegal in sheet names

- **Given** D-BARE with `name="Rates: EU/US [v2]?*"`.
- **When** import → convert.
- **Then** import exit `0`; a valid sheet name containing `DMN`; the name cell holds the
  original name verbatim; the converted decision `name` is `Rates: EU/US [v2]?*`.
- **Spec:** §3.2 (`name` verbatim); sheet-name sanitising spec silent.

### IMPORT-103 — decision name already containing "DMN"

- **Given** D-BARE with `name="Pricing DMN"`.
- **When** import.
- **Then** sheet name is exactly `Pricing DMN` (no duplicated suffix).
- **Spec:** spec silent; §3 (sheet must contain `DMN`).

---

## G. Errors

### IMPORT-104 — missing input file

- **When** `excel2dmn import nope.dmn`.
- **Then** exit `1`; stderr names `nope.dmn` and says it does not exist / cannot be read
  (`ENOENT` or "not found"); no `.xlsx` written.
- **Spec:** spec silent; §7 (failures exit non-zero).

### IMPORT-105 — input is a directory

- **Given** `T/dir.dmn/` is a directory.
- **When** `excel2dmn import dir.dmn`.
- **Then** exit `1`; clear message naming the path; nothing written.
- **Spec:** §7 "Output channels" (decided: read errors name the path).

### IMPORT-106 — malformed XML

- **Given** `bad.dmn` = W-C7's `dmn1` truncated in the middle of `<decisionTable`.
- **When** import.
- **Then** exit `1`; stderr says the file is not well-formed / could not be parsed and
  names the file or a line/column; no `bad.xlsx`.
- **Spec:** spec silent.

### IMPORT-107 — empty file

- **Given** `empty.dmn` of 0 bytes.
- **Then** exit `1`; clear parse error; nothing written.
- **Spec:** spec silent.

### IMPORT-108 — XML that is not DMN (e.g. BPMN)

- **Given** a minimal BPMN 2.0 document saved as `process.dmn`.
- **When** import.
- **Then** exit `1`; stderr says no DMN decision table was found or the root is not DMN
  `definitions`; nothing written.
- **Spec:** spec silent.

### IMPORT-109 — DMN 1.1 / 1.2 namespace

- **Given** D-MODELER-C7 with the MODEL namespace replaced by
  `http://www.omg.org/spec/DMN/20151101/dmn.xsd` (DMN 1.1), and again by
  `http://www.omg.org/spec/DMN/20180521/MODEL/` (DMN 1.2).
- **When** import.
- **Then** exit `1`; the message names the file, the detected version (`DMN 1.1` / `DMN 1.2`)
  and says `not DMN 1.3`; nothing written.
- **Spec:** §7.3 (decided: detect and reject other DMN versions).

### IMPORT-109a — a comment before the root is ignored

- **Given** D-MODELER-C7 with an XML comment before `<definitions>` that itself contains a DMN 1.1 `<definitions xmlns="…20151101…">`.
- **When** import.
- **Then** exit `0`; the file imports (the version check looks at the real root only).
- **Spec:** §7.3 (version detection must not be fooled by comments).

### IMPORT-110 — only a literal-expression decision

- **Given** D-LITERAL.
- **When** import.
- **Then** exit `1`; stderr contains `No <decision> with a <decisionTable>` (or equivalent
  "no decision table found"); nothing written.
- **Spec:** spec silent; the template only represents decision tables (§3).

### IMPORT-111 — definitions with no decisions at all

- **Given** a DMN 1.3 `<definitions>` holding only an `<inputData>`.
- **Then** same as IMPORT-110.
- **Spec:** spec silent.

### IMPORT-112 — `--config` file missing or invalid

- **Given** D-BARE; `--config missing.json`; separately `--config bad.json` where
  `bad.json` = `{ "header": { "labelOffset": "x" } }`.
- **When** import.
- **Then** exit `1` in both cases with a config error naming the file / the invalid key;
  nothing written.
- **Spec:** §7.1 ("validated against `schema/config.schema.json` … with clear errors").

### IMPORT-113 — output path not writable

- **Given** `-o` pointing inside a read-only directory (skip on Windows / root).
- **Then** exit `1`; message names the output path; no partial file left.
- **Spec:** spec silent.

### IMPORT-114 — DMN with a UTF-8 BOM and CRLF line endings

- **Given** D-MODELER-C7 saved with a leading BOM and `\r\n` line endings.
- **When** import.
- **Then** exit `0`; same workbook content as IMPORT-077.
- **Spec:** spec silent; files exported on Windows commonly have both.

---

## H. Config-aware import

### IMPORT-115 — renamed markers are used in the imported sheet

- **Given** `m.json` = `{ "markers": { "id": "KEY", "input": "in", "output": "out", "policy": "hp", "annotations": "notes" } }`;
  W-C7 rewritten with those markers.
- **When** `RT(--config m.json)`, import also with `--config m.json`.
- **Then** the imported marker row uses `KEY`/`in`/`out`/`hp`/`notes`; `dmn2 === dmn1`.
- **Spec:** §7.1 rules of use ("reads marker keywords from `markers`"); §7.2 (generator is
  config-aware — same expectation for import, spec silent).

### IMPORT-116 — custom header offsets are respected

- **Given** `o.json` = `{ "header": { "nameOffset": 1, "typeOffset": 3, "labelOffset": 2 } }`
  (type and label swapped) and W-C7 laid out accordingly.
- **When** `RT(--config o.json)`.
- **Then** the imported sheet puts labels at M+2 and types at M+3; `dmn2 === dmn1`.
- **Spec:** §3.1 ("Every header row is an independent integer offset").

### IMPORT-117 — custom `types.anyKeyword` is used for untyped columns

- **Given** `k.json` = `{ "types": { "anyKeyword": "any" } }`; D-MODELER-C8.
- **When** import with `--config k.json`.
- **Then** `payload` and `extra` type cells read `any`.
- **Spec:** §7.1 (`anyKeyword` is the canonical untyped keyword); §4 notes.

### IMPORT-118 — explicit allowed-values config is used as-is

- **Given** W-C7-AV → `dmn1`; import with `--config av.json`.
- **Then** layout identical to IMPORT-035 and no allowed-values hint (IMPORT-037) is printed.
- **Spec:** §3.1; hint spec silent.

---

## I. Programmatic API

### IMPORT-119 — `dmnToModels` reports `__platform` for C8

- **Given** W-C8's `dmn1` text.
- **When** `const [m] = await dmnToModels(xml, loadConfig({}))`.
- **Then** `m.__platform === 'camunda8'`; `m.decisions[0].id === 'FEES'`;
  `m.decisions[0].inputs.map(i => i.typeRef)` = `['number', 'string', 'Any', 'dateTime']`.
- **Spec:** README: Programmatic API (`model.__platform`); §4 notes.

### IMPORT-120 — `dmnToModels` reports `camunda7` for C7 and modeler "Camunda Platform"

- **Given** W-C7's `dmn1`; D-MODELER-C7; D-BARE.
- **Then** `__platform === 'camunda7'` for all three.
- **Spec:** README: Programmatic API; §6.6.

### IMPORT-121 — README recipe rebuilds a C8 file byte-identically

- **Given** W-C8's `dmn1`.
- **When** `const [model] = await dmnToModels(xml, loadConfig({}));
const cfg = loadConfig({ overrides: { platform: model.__platform } });
const out = await buildDmn(model, cfg);`
- **Then** `out === dmn1`.
- **Spec:** README: Programmatic API (code sample).

### IMPORT-122 — `buildDmn` never switches platform on its own

- **Given** W-C8's `dmn1` → `dmnToModels`.
- **When** `buildDmn(model, loadConfig({}))` (default C7 config).
- **Then** the output has `camunda:historyTimeToLive="P180D"` and no `modeler:` attribute.
- **Spec:** README: Programmatic API ("`buildDmn` always builds for the platform in the
  config you pass — it never switches on its own").

### IMPORT-123 — README recipe on a C7 file rebuilds byte-identically

- **Given** W-C7's `dmn1`.
- **When** README recipe.
- **Then** `out === dmn1`.
- **Spec:** README: Programmatic API.

### IMPORT-124 — `dmnToModels` returns one model per decision table

- **Given** D-MULTI; D-MIXED.
- **Then** lengths `2` and `1`; each model has `decisions.length === 1`; ids `Eligibility`,
  `Offer` / `Eligibility`.
- **Spec:** §4 ("one model per … decision; `decisions` has length 1").

### IMPORT-125 — imported model shape matches §4

- **Given** W-C7's `dmn1` → `dmnToModels`.
- **Then** `definitions` = `{ id: 'definitions_FEES', name: 'Fee Decision', namespace:
'http://camunda.org/schema/1.0/dmn' }`; decision `hitPolicy: 'UNIQUE'`,
  `aggregation: null`; inputs carry `label`, `expression`, `typeRef`, `allowedValues: null`;
  rules have `id` `rule_1`/`rule_2`, `inputEntries` aligned with inputs (`['< 100', '"EU"', '']`),
  `description` only on rule 1.
- **Spec:** §4.1 shape and notes.

### IMPORT-126 — `importDmn` with `write: false` writes nothing

- **When** `importDmn(join(T, 'x.dmn'), { config, xml: dmn1Text, write: false })`.
- **Then** returns `{ path, models, platform }` with `path === join(T, 'x.xlsx')`; no file
  exists at `path`.
- **Spec:** spec silent (API surface in `src/index.js`; `platform` returned per §6.6).

### IMPORT-127 — `importDmn` returns the detected platform and writes the workbook

- **Given** W-C8's `dmn1` on disk.
- **When** `importDmn(path, { config: loadConfig({}), out: join(T, 'b.xlsx') })`.
- **Then** returns `platform === 'camunda8'`; `b.xlsx` exists; `parseWorkbook(b.xlsx,
loadConfig({ overrides: { platform: 'camunda8' } }))` then `buildDmn` equals `dmn1`.
- **Spec:** §6.6 ("The detected platform is returned from `importDmn`").

### IMPORT-128 — `modelsToWorkbook` + `parseWorkbook` are inverse on models

- **Given** `models = await dmnToModels(dmn1)` for W-C7-AV, `cfg` = `av.json` config.
- **When** `modelsToWorkbook(models, cfg, p)` then `parseWorkbook(p, cfg)`.
- **Then** each re-parsed decision deep-equals the original on `id`, `name`, `hitPolicy`,
  `aggregation`, `inputs`, `outputs` and on every rule's `inputEntries`, `outputEntries`,
  `description`.
- **Spec:** §1 lossless; §4.
