# E2E scenarios: Camunda 7 Excel to DMN conversion

Scope: the default platform (`camunda7`). Every scenario drives the real CLI
(`runCli`) or the public API (`convert` / `parseWorkbook` / `buildDmn`) against a
workbook built in code with `test/e2e/helpers.js`. Expected results come from
`SOLUTION_SPEC.md` (the spec) and `README.md`. Where the two disagree, or the spec
says nothing, the scenario says so and is flagged **spec silent** or **spec conflict**.

## Conventions used below

**Baseline workbook `W0`.** `base_DMN.xlsx`, one sheet `Base DMN`, built with
`decisionSheet` in the default 4-row layout:

| col | marker (row 1) | name (row 2) | type (row 3) | label (row 4) | row 5   | row 6    |
| --- | -------------- | ------------ | ------------ | ------------- | ------- | -------- |
| A   | `id`           | `BASE`       |              |               |         |          |
| B   | `input`        | `amount`     | `integer`    | `Amount`      | `< 10`  | `>= 10`  |
| C   | `output`       | `result`     | `string`     | `Result`      | `"LOW"` | `"HIGH"` |

**Baseline command `C0`.** Run in a fresh `tempDir()` with no `excel2dmn.config.json`:
`excel2dmn base_DMN.xlsx --out-dir out`. Success means: exit code `0`,
`out/BASE.dmn` exists, and `parseDmn(readText('out/BASE.dmn'))` finds no warnings.

**Config.** "with config `{…}`" means: write that JSON to `cfg.json` in the temp dir
and add `--config cfg.json` to the command. Only the listed keys are given; the
rest stay at their defaults (spec §7.1: config is deep-merged over the defaults).

**Conversion error.** "fails with a conversion error at `X`" means: exit code is
non-zero (`1`), stderr contains the cell reference `X` in `Sheet!Cell` form, and no
`.dmn` is written for that sheet (spec §5 Step 2 and Step 3b, "abort with a
coordinate-anchored message"). For rule-entry errors (Step 3b) the message also names
the column's technical name; header errors (Step 2, e.g. `Unknown typeRef 'X' at
<sheet>!<cell>`) only need the cell.

"W0 with B5 = `…`" means W0 with only that cell changed.

---

## 1. Baseline document shape

### CAMUNDA7-001: Baseline workbook converts to one DMN file named after the decision id

- **Given** W0.
- **When** C0.
- **Then** exit code `0`; `listFiles('out')` is exactly `['BASE.dmn']`; stdout has one success line naming sheet `Base DMN` and the output path; stderr is empty.
- **Source** spec §3 intro (one sheet, one `.dmn`), §7 "Output filenames" (`<decisionId>.dmn`).

### CAMUNDA7-002: Generated DMN re-parses cleanly with dmn-moddle

- **Given** W0. **When** C0.
- **Then** `parseDmn` returns `<definitions>` with no import warnings, holding exactly one `dmn:Decision` in `drgElement` whose `decisionLogic` is a `dmn:DecisionTable`.
- **Source** spec §1 goals, §6.1 ("attach the table to `decision.decisionLogic`"), §6.4.

### CAMUNDA7-003: Root uses the default, unprefixed DMN 1.3 MODEL namespace

- **Given** W0. **When** C0.
- **Then** the XML starts with an XML declaration; the root tag is `<definitions` with `xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/"`; the text holds no `<dmn:` or `</dmn:`; `xmlns:dmndi="https://www.omg.org/spec/DMN/20191111/DMNDI/"` and `xmlns:dc="http://www.omg.org/spec/DMN/20180521/DC/"` are declared.
- **Source** spec §6.3 "Namespace style" and "Verified namespace URIs".

### CAMUNDA7-004: Definitions carry id, name, namespace, expressionLanguage and typeLanguage

- **Given** W0. **When** C0.
- **Then** `<definitions>` has `id="definitions_BASE"`, `name="BASE"`, `namespace="http://camunda.org/schema/1.0/dmn"`, `expressionLanguage="https://www.omg.org/spec/DMN/20191111/FEEL/"`, and `typeLanguage="https://www.omg.org/spec/DMN/20191111/FEEL/"`.
- **Source** spec §4.1 notes (`definitions.id` = `definitions_` + decision id, `definitions.name` = decision name), §6.1 (expressionLanguage and typeLanguage MUST be set), §7.1 `output.namespace`.

### CAMUNDA7-005: Decision table has the Rule-as-Row orientation and readable ids

- **Given** W0. **When** C0.
- **Then** `<decision id="BASE" name="BASE">` holds `<decisionTable id="BASE_decisionTable" preferredOrientation="Rule-as-Row">`.
- **Source** spec §6.1, §6.4 id table, "`preferredOrientation="Rule-as-Row"` … always set it".

### CAMUNDA7-006: Input clause maps name, type and label

- **Given** W0. **When** C0.
- **Then** the single `<input id="amount" label="Amount">` holds `<inputExpression id="amount_expression" typeRef="integer"><text>amount</text></inputExpression>`.
- **Source** spec §3.2 `input`, §6.1, §6.4 (input `<expression>`, inputExpression `<expression>_expression`).

### CAMUNDA7-007: Output clause maps name, type and label

- **Given** W0. **When** C0.
- **Then** the single `<output id="result" name="result" label="Result" typeRef="string" />`.
- **Source** spec §3.2 `output`, §6.1, §6.4 (output id `<name>`; "we always set" `name`).

### CAMUNDA7-008: Rule and entry ids follow the deterministic scheme

- **Given** W0. **When** C0.
- **Then** rules are `rule_1` and `rule_2` in sheet order. `rule_1` holds `<inputEntry id="amount_1"><text>&lt; 10</text></inputEntry>` and `<outputEntry id="result_1"><text>"LOW"</text></outputEntry>`. `rule_2` holds `amount_2` = `>= 10` and `result_2` = `"HIGH"`.
- **Source** spec §3.3 (rule id `rule_<n>`, a 1-based index), §4.1 notes, §6.4 id table (`rule_<seq>`, `<expression>_<seq>`, `<name>_<seq>`), §7.1 `rules.idTemplate` default `rule_<n>`.
- **Note: spec conflict.** README ("Rule ids are generated as `rule_<excelRow>`") and spec §3.5/§4.1 examples (`rule_5…rule_9`, `rule_6` for Excel row 6) say the id is the Excel row. The normative text (§3.3, §6.4, §7.1 default `rule_<n>`) says it is the 1-based index. This scenario expects `rule_1`, `rule_2` (normative). The README sentence is stale. CAMUNDA7-009 covers the Excel-row form.

### CAMUNDA7-009: `rules.idTemplate: "rule_<row>"` produces Excel-row rule ids

- **Given** W0 (rules on Excel rows 5 and 6), with config `{ "rules": { "idTemplate": "rule_<row>" } }`.
- **When** C0 + `--config cfg.json`.
- **Then** the rules are `rule_5` and `rule_6`. Entry ids stay index-based (`amount_1`, `amount_2`, `result_1`, `result_2`); the spec defines entry ids only as `<expression>_<seq>`.
- **Source** spec §7.1 (`idTemplate` … "`<row>` for the Excel row"), §6.4.

### CAMUNDA7-010: Hit policy UNIQUE (the default) is not written as an attribute

- **Given** W0 (no `policy` column). **When** C0.
- **Then** `<decisionTable>` has no `hitPolicy` attribute and no `aggregation` attribute; the re-parsed `table.hitPolicy` is `UNIQUE`, the moddle default.
- **Source** spec §3.4 (default `UNIQUE`), §6.1 ("moddle OMITS it"), §6.4.

### CAMUNDA7-011: DRD / DMNDI layout is generated

- **Given** W0. **When** C0.
- **Then** `<dmndi:DMNDI>` holds one `<dmndi:DMNDiagram id="DMNDiagram_BASE">`. That holds one `<dmndi:DMNShape id="DMNShape_BASE" dmnElementRef="BASE">` with `<dc:Bounds x="160" y="100" width="180" height="80" />`. The `dmnElementRef` resolves to the decision in the parsed model.
- **Source** spec §6.2, §6.4 (DMNDiagram and DMNShape ids), `excel2dmn.config.example.json` `output.shape`.
- **Note: spec conflict.** The §7.1 sample config shows `shape: { x: -230, y: 0 }` and says "the values shown are the defaults". §6.2 says "`x:160, y:100`", and the checked-in example config also uses 160/100. Expected default: `160,100`.

### CAMUNDA7-012: Custom shape bounds from config

- **Given** W0, with config `{ "output": { "shape": { "x": -230, "y": 0, "width": 200, "height": 90 } } }`.
- **When** C0 + `--config`.
- **Then** `<dc:Bounds x="-230" y="0" width="200" height="90" />`.
- **Source** spec §7.1 `output.shape`, §6.2 ("any coordinates render").

### CAMUNDA7-013: FEEL operators are XML-escaped and survive a re-parse

- **Given** W0 with B5 = `<= 5`, B6 = `> 5`. **When** C0.
- **Then** the raw XML holds `&lt;= 5` (never a raw `<=` inside `<text>`). After `parseDmn`, `rule[0].inputEntry[0].text === '<= 5'` and `rule[1].inputEntry[0].text === '> 5'`.
- **Source** spec §6.3 (moddle serialization), §1 (valid DMN 1.3 output).

---

## 2. Camunda 7 extension attributes and namespaces

### CAMUNDA7-014: historyTimeToLive defaults to P180D

- **Given** W0. **When** C0.
- **Then** `<decision>` has `camunda:historyTimeToLive="P180D"`, and the root declares `xmlns:camunda="http://camunda.org/schema/1.0/dmn"`. The re-parsed decision has `historyTimeToLive === 'P180D'`.
- **Source** spec §6.5 (config default `"P180D"`; moddle declares `xmlns:camunda`), README feature list.

### CAMUNDA7-015: versionTag is omitted by default

- **Given** W0. **When** C0.
- **Then** there is no `camunda:versionTag` attribute anywhere in the XML.
- **Source** spec §6.5 ("Emit `camunda:versionTag` only when `camunda.versionTag` is set (default `null`)").

### CAMUNDA7-016: versionTag is emitted when configured

- **Given** W0, with config `{ "camunda": { "versionTag": "1.2" } }`.
- **When** C0 + `--config`.
- **Then** `<decision … camunda:historyTimeToLive="P180D" camunda:versionTag="1.2">`; it re-parses with 0 warnings.
- **Source** spec §6.5 example and "Verified" note.

### CAMUNDA7-017: Custom ISO-8601 historyTimeToLive

- **Given** W0, with config `{ "camunda": { "historyTimeToLive": "P30D" } }`.
- **When** C0 + `--config`.
- **Then** `camunda:historyTimeToLive="P30D"`.
- **Source** spec §6.5, §7.1 `camunda.historyTimeToLive`.

### CAMUNDA7-018: Integer day-count historyTimeToLive

- **Given** W0, with config `{ "camunda": { "historyTimeToLive": 30 } }` (a JSON number).
- **When** C0 + `--config`.
- **Then** exit `0`; `camunda:historyTimeToLive="30"`.
- **Source** spec §6.5 ("Accepts an ISO-8601 duration (`P180D`) or an integer number of days").

### CAMUNDA7-019: historyTimeToLive null omits the attribute

- **Given** W0, with config `{ "camunda": { "historyTimeToLive": null } }`.
- **When** C0 + `--config`.
- **Then** there is no `camunda:historyTimeToLive`. Because `versionTag` is also unset, no `camunda:` attribute is used, so there is no `xmlns:camunda` declaration either. The file still re-parses with 0 warnings.
- **Source** spec §6.5 ("set to `null` to omit"), §6.3 ("injects namespaces only for prefixes actually used").

### CAMUNDA7-020: Camunda 7 output never carries Camunda 8 modeler metadata

- **Given** W0. **When** C0 (no `--platform`).
- **Then** the XML holds no `modeler:executionPlatform`, no `modeler:executionPlatformVersion`, and no `xmlns:modeler`.
- **Source** spec §6.6 ("`xmlns:camunda` and `xmlns:modeler` never co-occur … Camunda 7 output stays byte-identical"); default `platform: "camunda7"` (§7.1).

### CAMUNDA7-021: Explicit `--platform camunda7` gives the same bytes as the default

- **Given** W0.
- **When** C0 into `out1`; then `excel2dmn base_DMN.xlsx --platform camunda7 --out-dir out2`.
- **Then** both exit `0`, and `out1/BASE.dmn` and `out2/BASE.dmn` are byte-identical.
- **Source** spec §6.6 (default is `camunda7`), §6.4 (byte-identical output).

### CAMUNDA7-022: `--namespace` sets the definitions namespace

- **Given** W0.
- **When** C0 + `--namespace https://example.com/dmn`.
- **Then** `<definitions … namespace="https://example.com/dmn">`. The MODEL `xmlns` is unchanged and so is `xmlns:camunda`.
- **Source** spec §7 (`--namespace <uri>`), §7.1 ("`--namespace` → `output.namespace`").

### CAMUNDA7-023: Namespace from the config file

- **Given** W0, with config `{ "output": { "namespace": "urn:acme:rules" } }`.
- **When** C0 + `--config`.
- **Then** `namespace="urn:acme:rules"`.
- **Source** spec §7.1 `output.namespace`.

### CAMUNDA7-024: `--namespace` beats the config file

- **Given** W0, with config `{ "output": { "namespace": "urn:from-config" } }`.
- **When** C0 + `--config cfg.json --namespace urn:from-flag`.
- **Then** `namespace="urn:from-flag"`.
- **Source** spec §7.1 precedence ("CLI flags → `--config <file>` → … → built-in defaults").

### CAMUNDA7-025: `namespaceStyle: "prefixed"` keeps the `dmn:` prefix

- **Given** W0, with config `{ "output": { "namespaceStyle": "prefixed" } }`.
- **When** C0 + `--config`.
- **Then** the root is `<dmn:definitions xmlns:dmn="https://www.omg.org/spec/DMN/20191111/MODEL/" …>`, there is no default `xmlns="…/MODEL/"`, and it re-parses with 0 warnings and the same decision/table/rule ids as CAMUNDA7-005..008.
- **Source** spec §7.1 (`output.namespaceStyle` "default" | "prefixed"; "toggles the §6.3 post-process").

### CAMUNDA7-026: Custom expressionLanguage / typeLanguage

- **Given** W0, with config `{ "output": { "expressionLanguage": "https://www.omg.org/spec/DMN/20191111/FEEL/", "typeLanguage": "http://www.omg.org/spec/FEEL/20140401" } }`.
- **When** C0 + `--config`.
- **Then** `<definitions>` carries exactly those two attribute values.
- **Source** spec §7.1 `output.expressionLanguage` / `output.typeLanguage`.

---

## 3. Determinism

### CAMUNDA7-027: Two runs on unchanged input give byte-identical XML

- **Given** W0.
- **When** C0 into `out1`, then again into `out2`.
- **Then** `readText('out1/BASE.dmn') === readText('out2/BASE.dmn')`. No id has a random or time-based part: every `id="…"` value is one of the deterministic forms in spec §6.4.
- **Source** spec §6.4 ("re-running the tool on unchanged input yields byte-identical XML"), README "byte-stable output", spec §2 (no random-id library).

### CAMUNDA7-028: Re-running into the same directory overwrites with the same bytes

- **Given** W0. **When** C0 twice into the same `out`.
- **Then** both runs exit `0`; `out` holds one `BASE.dmn`; its content after run 2 equals its content after run 1.
- **Source** spec §6.4 (determinism), §7 (output filenames). The spec does not mention overwrite prompts or refusal, so overwrite is silent (**spec silent**, reasonable expectation).

### CAMUNDA7-029: Workbook from a different path gives the same bytes

- **Given** two copies of W0, built separately at `a/base_DMN.xlsx` and `b/other_DMN.xlsx`.
- **When** each is converted to its own `--out-dir`.
- **Then** both `BASE.dmn` files are byte-identical; the workbook file name and path do not leak into the XML.
- **Source** spec §6.4 (ids built only from decision id, column names and rule index).

---

## 4. Types (`typeRef`) on Camunda 7

### CAMUNDA7-030: `string` column

- **Given** W0 plus input D `{ marker:'input', name:'region', type:'string', label:'Region' }` with D5 = `"EU"` and D6 = `"US"`.
- **When** C0.
- **Then** `<inputExpression id="region_expression" typeRef="string">`; entries `region_1` = `"EU"` and `region_2` = `"US"`, quotes kept verbatim.
- **Source** spec §3.1 type row (Camunda types), §3b string rules.

### CAMUNDA7-031: `boolean` column

- **Given** W0 plus input D `isMember` / `boolean`, with D5 = `true` and D6 = `false` (as text).
- **When** C0.
- **Then** `typeRef="boolean"`; entries `true` and `false`.
- **Source** spec §3.1, §3b boolean row.

### CAMUNDA7-032: `integer` column passes through unchanged on C7

- **Given** W0 (amount is `integer`). **When** C0.
- **Then** `typeRef="integer"`; it is not renamed to `number`.
- **Source** spec §3.1; §6.6 (the numeric alias applies to C8 only; "C7 output is untouched").

### CAMUNDA7-033: `long` column

- **Given** W0 with B3 = `long`. **When** C0.
- **Then** exit `0`; `typeRef="long"`.
- **Source** spec §3.1, §3b (numeric types validated identically).

### CAMUNDA7-034: `double` column with decimal entries

- **Given** W0 with B3 = `double`, B5 = `< 10.5`, B6 = `>= 10.5`, plus output D `fee`/`double` with D5 = `1.5` and D6 = `0`.
- **When** C0.
- **Then** exit `0`; input and output typeRefs are `double`; entries are emitted verbatim (`< 10.5`, `1.5`, `0`).
- **Source** spec §3b numeric row ("integers and decimals"), output rules (number outputs unquoted).

### CAMUNDA7-035: `date` column with FEEL date literals

- **Given** W0 plus input D `since` / `date`, with D5 = `< date("2026-01-01")` and D6 = `>= date("2026-01-01")`, plus output E `validFrom` / `date` with E5 = `date("2026-01-01")` and E6 empty.
- **When** C0.
- **Then** exit `0`; `typeRef="date"` on both; entries verbatim (XML-escaped `<`).
- **Source** spec §3.1 (`date` is a Camunda type), §3b (`date` is syntax-only).

### CAMUNDA7-036: `date` column with a FEEL syntax error is rejected

- **Given** CAMUNDA7-035 with D5 = `date("2026-01-01"` (missing `)`).
- **When** C0.
- **Then** it fails with a conversion error at `Base DMN!D5`, naming input `since` and invalid FEEL.
- **Source** spec §3b (syntax-only types: "syntax errors only").

### CAMUNDA7-037: `Any` column omits typeRef

- **Given** W0 plus input D `tags` / `Any`, with D5 = `not(some t in ["fragile","hazmat"] satisfies t = tag)` and D6 = `-`.
- **When** C0.
- **Then** exit `0`; `<inputExpression id="tags_expression">` has **no** `typeRef` attribute; D5 is emitted verbatim (escaped).
- **Source** spec §4.1 notes ("`typeRef: "Any"` ⇒ by default omit `typeRef`"), §6.1 typeRef handling, §3b Any row.

### CAMUNDA7-038: Any aliases in every casing are treated as untyped (one scenario per value)

- **Given** W0 plus input D with type set to each of `Any`, `any`, `ANY`, `none`, `None`, `NONE`, `object`, `Object`, `OBJECT`, `aNy` in turn (one workbook per value), with D5 = `"x"` and D6 = `5`.
- **When** C0.
- **Then** each run exits `0`, and `tags_expression` has no `typeRef` attribute. Mixed literal kinds pass because Any is syntax-checked only.
- **Source** spec §3.1 type row ("any casing … all mean untyped"), §7.1 `types.anyAliases`, §3b Any row.

### CAMUNDA7-039: Any output column omits typeRef

- **Given** W0 plus output D `payload` / `object`, with D5 = `{a: 1}` and D6 = `"x"`.
- **When** C0.
- **Then** exit `0`; `<output id="payload" name="payload" …>` has no `typeRef`.
- **Source** spec §6.1 typeRef handling (applies to clauses generally), §4.1 notes.

### CAMUNDA7-040: `types.anyDmnPlaceholder` emits an explicit typeRef for Any columns

- **Given** CAMUNDA7-037's workbook with D3 = `none`, with config `{ "types": { "anyDmnPlaceholder": "Any" } }`.
- **When** C0 + `--config`.
- **Then** `<inputExpression id="tags_expression" typeRef="Any">`; it re-parses with 0 warnings.
- **Source** spec §4.1 notes, §7.1 `types.anyDmnPlaceholder`.

### CAMUNDA7-041: Any column with a FEEL syntax error is rejected

- **Given** CAMUNDA7-037 with D5 = `[1..`.
- **When** C0.
- **Then** it fails with a conversion error at `Base DMN!D5` (input `tags`, invalid FEEL).
- **Source** spec §3b Any row ("syntax errors only").

### CAMUNDA7-042: DMN-only `number` is rejected by default (input)

- **Given** W0 with B3 = `number`.
- **When** C0.
- **Then** it fails with a conversion error at `Base DMN!B3`. The message says `number` is not a Camunda type and suggests integer/long/double. No `BASE.dmn`.
- **Source** spec §3.1 type row ("rejected by default"), §7.1 `types.nonCamundaTypeAction` default `"error"`, `types.camundaTypes`.

### CAMUNDA7-043: DMN-only `number` is rejected by default (output)

- **Given** W0 plus output D `fee` / `number` with D5 = `1` and D6 = `2`.
- **When** C0.
- **Then** it fails with a conversion error at `Base DMN!D3`.
- **Source** as CAMUNDA7-042; the type row applies to output columns too (§3.2 `output` reads `typeRef` from M+2).

### CAMUNDA7-044: `time` is rejected by default

- **Given** W0 plus input D `at` / `time` with D5 = `< time("12:00:00")` and D6 = `-`.
- **When** C0.
- **Then** it fails with a conversion error at `Base DMN!D3` ("not a Camunda type").
- **Source** spec §3.1, §7.1 `types.camundaTypes` (time not listed).

### CAMUNDA7-045: `dateTime` is rejected by default

- As CAMUNDA7-044 with type `dateTime` and D5 = `< date and time("2026-01-01T00:00:00")`. **Then** error at `Base DMN!D3`.
- **Source** spec §3.1, §7.1.

### CAMUNDA7-046: `dayTimeDuration` is rejected by default

- As CAMUNDA7-044 with type `dayTimeDuration` and D5 = `> duration("P1D")`. **Then** error at `Base DMN!D3`.
- **Source** spec §3.1, §7.1.

### CAMUNDA7-047: `yearMonthDuration` is rejected by default

- As CAMUNDA7-044 with type `yearMonthDuration` and D5 = `> duration("P1Y")`. **Then** error at `Base DMN!D3`.
- **Source** spec §3.1, §7.1.

### CAMUNDA7-048: All non-Camunda type errors are reported in one run

- **Given** W0 with B3 = `number`, plus input D `at` / `time` and output E `d` / `dateTime` (rules filled with `-` / empty).
- **When** C0.
- **Then** exit `1`; stderr names all three cells, `Base DMN!B3`, `Base DMN!D3` and `Base DMN!E3`, in a single run.
- **Source** spec §5 Step 2 ("Collect all such problems and report them together"), §3b ("Collect all validation problems").

### CAMUNDA7-049: `nonCamundaTypeAction: "warn"` converts and warns

- **Given** W0 with B3 = `number`, with config `{ "types": { "nonCamundaTypeAction": "warn" } }`.
- **When** C0 + `--config`.
- **Then** exit `0`; `BASE.dmn` is written with `typeRef="number"` verbatim (C7 never renames numeric types). A warning naming `Base DMN!B3` and "not a Camunda type" is shown to the user (stderr). **Spec silent** on where CLI warnings go; reasonable expectation is stderr, since a warning nobody sees is no warning. Through the API, `convert()` returns the warning in `results[0].warnings`.
- **Source** spec §7.1 `types.nonCamundaTypeAction` ("error" | "warn" | "off"), §6.6 (C7 output untouched).

### CAMUNDA7-050: `nonCamundaTypeAction: "warn"` for every DMN-only type

- **Given** one workbook with inputs typed `number`, `time`, `dateTime`, `dayTimeDuration` and `yearMonthDuration` (all entries `-`), and output `integer`; config `warn`.
- **When** C0 + `--config`.
- **Then** exit `0`; each typeRef is emitted verbatim; there are 5 warnings, one per type cell.
- **Source** spec §7.1.

### CAMUNDA7-051: `nonCamundaTypeAction: "off"` converts silently

- **Given** W0 with B3 = `number`, with config `{ "types": { "nonCamundaTypeAction": "off" } }`.
- **When** C0 + `--config`.
- **Then** exit `0`; `typeRef="number"`; no warning on stderr; `results[0].warnings` is empty through the API.
- **Source** spec §7.1.

### CAMUNDA7-052: Unknown typeRef is rejected with its coordinate

- **Given** W0 with B3 = `text`.
- **When** C0.
- **Then** it fails with a conversion error at `Base DMN!B3`, and the message contains `Unknown typeRef 'text'` (case-insensitive match on "unknown typeRef").
- **Source** spec §5 Step 2 ("every `typeRef` ∈ `types.allowed` (`Unknown typeRef 'X' at <sheet>!<cell>`)").

### CAMUNDA7-053: Wrong-case Camunda type (`String`, `Integer`, `BOOLEAN`)

- **Given** W0 with B3 = `Integer` (separate runs for `String` on C3 and `BOOLEAN` on a boolean column).
- **When** C0.
- **Then** it fails with an unknown-typeRef conversion error at the type cell. **Spec silent**: the spec lists case-insensitive matching only for the Any aliases (§3.1), and the `types.allowed` list is exact. DMN/Camunda typeRefs are case-sensitive, so reject with a coordinate rather than emitting an invalid typeRef.
- **Source** spec §3.1 (only Any is "any casing"), §7.1 `types.allowed`.

### CAMUNDA7-054: Type cell with surrounding whitespace is trimmed

- **Given** W0 with B3 = `  integer  `.
- **When** C0.
- **Then** exit `0`; `typeRef="integer"`.
- **Source** spec §5 "Cell-value extraction" ("Trim leading/trailing whitespace on all extracted values and marker cells").

---

## 5. FEEL validation of entries per type

### CAMUNDA7-055: Valid numeric unary tests are accepted

- **Given** W0 with rule rows B5..B11 = `1`, `[1..10]`, `>= 3`, `1, 2, 3`, `not(1, 2)`, `3.5`, `]0..100[` and C5..C11 = `"X"`.
- **When** C0.
- **Then** exit `0`; seven rules (`rule_1`..`rule_7`), each `amount_n` text verbatim.
- **Source** spec §3b numeric row (integers and decimals, ranges, comparisons, lists, `not(...)`).

### CAMUNDA7-056: String literal in an integer input is a type error

- **Given** W0 with B5 = `"5"`.
- **When** C0.
- **Then** it fails with a conversion error at `Base DMN!B5`, naming input `amount` and type `integer`.
- **Source** spec §3b numeric row (rejects any StringLiteral).

### CAMUNDA7-057: Boolean literal in an integer input is a type error

- **Given** W0 with B5 = `true`. **When** C0. **Then** error at `Base DMN!B5`.
- **Source** spec §3b numeric row (rejects BooleanLiteral).

### CAMUNDA7-058: Bare identifier in a numeric input is allowed by default

- **Given** W0 with B5 = `> threshold`.
- **When** C0.
- **Then** exit `0`; `amount_1` = `> threshold`.
- **Source** spec §3b numeric row ("a bare `VariableName` … unless `allowExpressions`"), §7.1 `types.number.allowExpressions: true` (default).

### CAMUNDA7-059: Bare identifier in a numeric input is rejected when `allowExpressions` is false

- **Given** CAMUNDA7-058, with config `{ "types": { "number": { "allowExpressions": false } } }`.
- **When** C0 + `--config`.
- **Then** it fails with a conversion error at `Base DMN!B5`. The rule applies to `integer` because all numeric types are "validated identically".
- **Source** spec §3b numeric row, §7.1 `types.number.allowExpressions`.

### CAMUNDA7-060: Unquoted word in a string input is rejected, with an add-quotes hint

- **Given** W0 plus input D `region` / `string` with D5 = `US` and D6 = `"EU"`.
- **When** C0.
- **Then** it fails with a conversion error at `Base DMN!D5`. The message names input `region` and suggests quoting (`"US"`).
- **Source** spec §3b string row, the example message `Type error: 'string' input 'region' at ...!E7 has unquoted value 'US' (add quotes: "US")`, and §5 "the tool does not auto-add quotes to inputs".

### CAMUNDA7-061: Number or boolean in a string input is rejected

- **Given** the CAMUNDA7-060 layout with D5 = `5` (run 1) and D5 = `true` (run 2).
- **When** C0.
- **Then** each fails with a conversion error at `Base DMN!D5`.
- **Source** spec §3b string row (rejects NumericLiteral/BooleanLiteral).

### CAMUNDA7-062: Valid string unary tests are accepted

- **Given** the CAMUNDA7-060 layout with rows `"EU"`, `"EU","US"`, `not("EU")`, `""`.
- **When** C0.
- **Then** exit `0`; entries verbatim.
- **Source** spec §3b string row.

### CAMUNDA7-063: Boolean input accepts only true / false / wildcard

- **Given** W0 plus input D `isMember` / `boolean` with rows `true`, `false`, `-` (and B and C filled).
- **When** C0.
- **Then** exit `0`; entries `true`, `false`, and empty `<text></text>` for `-`.
- **Source** spec §3b boolean row.

### CAMUNDA7-064: Boolean input rejects `"true"`, `1` and `yes` (one run each)

- **Given** the CAMUNDA7-063 layout with D5 = `"true"`, then `1`, then `yes`.
- **When** C0.
- **Then** each run fails with a conversion error at `Base DMN!D5` ("expected true or false" or similar).
- **Source** spec §3b boolean row, §5 Cell-value extraction ("Any other value (`1`, `"true"`, `yes`) is a type error").

### CAMUNDA7-065: Boolean input rejects a bare identifier even though expressions are allowed for other types

- **Given** the CAMUNDA7-063 layout with D5 = `flag`.
- **When** C0.
- **Then** error at `Base DMN!D5`.
- **Source** spec §3b boolean row (rejects "identifiers"), §7.1 `types.boolean.allowExpressions: false`.

### CAMUNDA7-066: Syntax error in an input entry is reported with its coordinate

- **Given** W0 with B5 = `[1..10`.
- **When** C0.
- **Then** it fails with a conversion error at `Base DMN!B5` (input `amount`, invalid FEEL).
- **Source** spec §3b layer 1 (syntax), example `Invalid FEEL in input 'tags' at ...!H8`.

### CAMUNDA7-067: String output must be quoted

- **Given** W0 with C5 = `LOW`.
- **When** C0.
- **Then** it fails with a conversion error at `Base DMN!C5`, naming output `result` and "quoted string".
- **Source** spec §3b OUTPUT entries (`outputEntries.requireQuotes` default `true`).

### CAMUNDA7-068: Numeric text in a string output is rejected

- **Given** W0 with C5 = `5`. **When** C0. **Then** error at `Base DMN!C5`.
- **Source** spec §3b OUTPUT entries ("a raw unquoted value (`EXPRESS`, `5`, `X`) is … rejected").

### CAMUNDA7-069: Empty string literal `""` is a valid string output

- **Given** W0 with C5 = `""`.
- **When** C0.
- **Then** exit `0`; `result_1` text = `""`.
- **Source** spec §3b OUTPUT entries ("including the empty string `""`").

### CAMUNDA7-070: `outputEntries.autoQuote` wraps unquoted string outputs

- **Given** W0 with C5 = `LOW`, with config `{ "outputEntries": { "autoQuote": true } }`.
- **When** C0 + `--config`.
- **Then** exit `0`; `result_1` text = `"LOW"`; `result_2` stays `"HIGH"` (it is not double-quoted).
- **Source** spec §3b OUTPUT entries, §7.1 `outputEntries.autoQuote`.

### CAMUNDA7-071: `outputEntries.requireQuotes: false` emits unquoted string outputs verbatim

- **Given** W0 with C5 = `LOW`, with config `{ "outputEntries": { "requireQuotes": false } }`.
- **When** C0 + `--config`.
- **Then** exit `0`; `result_1` text = `LOW` (unchanged).
- **Source** spec §3b ("Set `outputEntries.requireQuotes: false` to skip this"), §7.1 comment ("string outputs must be a "string" literal" is what requireQuotes controls).

### CAMUNDA7-072: Integer output rejects a string literal

- **Given** W0 plus output D `days` / `integer`, with D5 = `"5"` and D6 = `10`.
- **When** C0.
- **Then** it fails with a conversion error at `Base DMN!D5`.
- **Source** spec §3b OUTPUT entries ("`number` / `boolean` / `date` / … outputs → validated per their DMN 1.3 type"), §3b numeric row.

### CAMUNDA7-073: Numeric and boolean outputs are emitted unquoted

- **Given** W0 plus output D `days` / `integer` (D5 = `5`, D6 = `10`) and output E `express` / `boolean` (E5 = `true`, E6 = `false`).
- **When** C0.
- **Then** exit `0`; `days_1` = `5`, `express_1` = `true`, `express_2` = `false`; nothing is quoted.
- **Source** spec §3b OUTPUT entries ("emitted verbatim, unquoted"), §3.3 ("Booleans … and numbers are emitted unquoted").

### CAMUNDA7-074: Boolean output rejects `"true"`

- **Given** CAMUNDA7-073 with E5 = `"true"`. **When** C0. **Then** error at `Base DMN!E5`.
- **Source** spec §3b OUTPUT entries, §3b boolean row.

### CAMUNDA7-075: Empty output cell is allowed and emitted as empty text

- **Given** W0 plus output D `days` / `integer`, with D5 empty and D6 = `10`.
- **When** C0.
- **Then** exit `0`; `<outputEntry id="days_1"><text></text></outputEntry>` (an empty text element, no content).
- **Source** spec §4.1 notes ("Empty output cell ⇒ `""` (emitted as an empty `<text></text>`)"), §6.1, §3b ("Empty cells … are always valid").

### CAMUNDA7-076: All entry errors across rows and columns are reported together

- **Given** W0 with B5 = `"5"`, C6 = `HIGH`, and an extra rule row 7 with B7 = `[1..` and C7 = `"X"`.
- **When** C0.
- **Then** exit `1`; stderr lists all three cells, `Base DMN!B5`, `Base DMN!C6` and `Base DMN!B7`, in one run.
- **Source** spec §3b ("Collect all validation problems and report them together"), §7.1 `validation.feel.failFast: false`.

### CAMUNDA7-077: `validation.feel.failFast: true` stops at the first problem

- **Given** CAMUNDA7-076's workbook, with config `{ "validation": { "feel": { "failFast": true } } }`.
- **When** C0 + `--config`.
- **Then** exit `1`; stderr names exactly one of those cells, the first in reading order (`Base DMN!B5`), and not the others.
- **Source** spec §7.1 `validation.feel.failFast` ("false → collect all errors").

### CAMUNDA7-078: `validation.feel.mode: "off"` skips input validation

- **Given** W0 with B5 = `"5"` (a type error under the default mode), with config `{ "validation": { "feel": { "mode": "off" } } }`.
- **When** C0 + `--config`.
- **Then** exit `0`; `amount_1` = `"5"` verbatim.
- **Source** spec §3b ("`validation.feel.mode` (`all-inputs` (default) / `any-inputs` / `off`)").

### CAMUNDA7-079: `validation.feel.mode: "any-inputs"` validates only Any-typed inputs

- **Given** W0 plus input D `tags` / `Any`, with B5 = `"5"` (bad for integer) and D5 = `[1..` (bad syntax), with config `{ "validation": { "feel": { "mode": "any-inputs" } } }`.
- **When** C0 + `--config`.
- **Then** exit `1`; stderr names `Base DMN!D5` and does **not** name `Base DMN!B5`.
- **Source** spec §3b (`any-inputs` mode); the name describes validating only `any`-typed inputs (§2 "validates `any`-typed input entries"). **Spec silent** on exact semantics; this is the reasonable reading.

### CAMUNDA7-080: Error coordinates use the real column letter beyond Z

- **Given** a sheet where 26 helper columns (A..Z, blank markers) come before W0's three columns, so `id` is AA, `amount` is AB and `result` is AC. AB5 = `"5"`.
- **When** C0.
- **Then** error at `Base DMN!AB5`.
- **Source** spec §5 Step 2/3b (coordinate-anchored messages), §3.2 (helper columns ignored).

### CAMUNDA7-081: Sheet names with spaces and underscores appear verbatim in coordinates

- **Given** W0 with the sheet renamed `Shipping Rates_ DMN` and B5 = `"5"`.
- **When** C0.
- **Then** stderr contains `Shipping Rates_ DMN!B5`.
- **Source** spec §5 Step 2 example (`Shipping Rates_ DMN!J3`).

---

## 6. Wildcards, empty cells, and the "any" token

### CAMUNDA7-082: `-` input is emitted as empty text, never a literal dash

- **Given** W0 with B5 = `-`.
- **When** C0.
- **Then** exit `0`; `<inputEntry id="amount_1"><text></text></inputEntry>`; the XML holds no `<text>-</text>`.
- **Source** spec §3.3 Input cell ("never emits a literal `<text>-</text>` for an input by default"), §4.1 notes.

### CAMUNDA7-083: Empty input cell is emitted as empty text

- **Given** W0 with B5 empty (C5 still `"LOW"`).
- **When** C0.
- **Then** exit `0`; still two rules; `amount_1` has empty `<text></text>`.
- **Source** spec §3.3 (default `anyInputTokens` `["-", ""]`), §4.1 notes.

### CAMUNDA7-084: `rules.emitAnyInputAs: "-"` emits a literal dash

- **Given** W0 with B5 = `-`, with config `{ "rules": { "emitAnyInputAs": "-" } }`.
- **When** C0 + `--config`.
- **Then** `amount_1` text = `-`; it re-parses with 0 warnings.
- **Source** spec §3.3 ("the emitted representation [is] configurable"), §7.1 `rules.emitAnyInputAs`.

### CAMUNDA7-085: Custom any-token in `rules.anyInputTokens`

- **Given** W0 with B5 = `*`, with config `{ "rules": { "anyInputTokens": ["-", "", "*"] } }`.
- **When** C0 + `--config`.
- **Then** exit `0`; `amount_1` is empty `<text></text>`. (Without the config, `*` would fail FEEL validation at `Base DMN!B5`.)
- **Source** spec §3.3, §7.1 `rules.anyInputTokens`.

### CAMUNDA7-086: Wildcard is valid for every typeRef

- **Given** one workbook with inputs of type `string`, `boolean`, `integer`, `long`, `double`, `date` and `Any`, all with `-` in row 5 and empty in row 6 (output `result` filled).
- **When** C0.
- **Then** exit `0`; all 14 input entries are empty `<text></text>`.
- **Source** spec §3b ("Empty cells and `-` (a `Wildcard`) are always valid"), §3b boolean row ("and `-`").

### CAMUNDA7-087: Text dash entered as `'-` behaves as the wildcard

- **Given** W0 with B5 written as the string `-` (in Excel, typed `'-`; in code, the string value `'-'`).
- **When** C0.
- **Then** same as CAMUNDA7-082.
- **Source** spec §3.3 ("a literal `-`/Excel text-dash `'-`").

---

## 7. Cell values: real Excel numbers, booleans, formulas, whitespace

### CAMUNDA7-088: Real Excel integer in an integer input

- **Given** W0 with B5 set to the JS number `5` (a numeric cell, not text).
- **When** C0.
- **Then** exit `0`; `amount_1` text = `5`.
- **Source** spec §5 "Cell-value extraction" (number column takes the numeric value, canonical FEEL), §3.3 ("numbers are emitted unquoted").

### CAMUNDA7-089: Real Excel decimal in a double output

- **Given** W0 plus output D `fee` / `double`, with D5 = number `1.5` and D6 = number `0`.
- **When** C0.
- **Then** `fee_1` = `1.5` and `fee_2` = `0`.
- **Source** spec §5 Cell-value extraction ("emit canonical FEEL (`1`, `1221`, `3.5`)").

### CAMUNDA7-090: Formatted numeric cell emits canonical FEEL, not the display string

- **Given** CAMUNDA7-089, with D5 set to number `1221` and its `numFmt` set to `#,##0.00` (set through ExcelJS after `writeWorkbook`, or with a small local builder).
- **When** C0.
- **Then** `fee_1` text = `1221`, not `1,221.00` and not `1 221,00`.
- **Source** spec §5 Cell-value extraction ("never Excel's formatted string (`1 221,00`)").

### CAMUNDA7-091: Real Excel boolean in a boolean input is lowercased

- **Given** W0 plus input D `isMember` / `boolean`, with D5 = JS `true` and D6 = JS `false` (boolean cells).
- **When** C0.
- **Then** exit `0`; entries `true` and `false` (lowercase).
- **Source** spec §5 Cell-value extraction ("If a cell is a real Excel boolean, `cell.text` may be `TRUE`/`FALSE` → lowercase it").

### CAMUNDA7-092: Real Excel boolean in a boolean output

- **Given** W0 plus output D `express` / `boolean` with D5 = JS `true` and D6 = JS `false`.
- **When** C0.
- **Then** `express_1` = `true` and `express_2` = `false`.
- **Source** spec §5 Cell-value extraction, §3.3.

### CAMUNDA7-093: Real Excel number in a string column is a type error

- **Given** W0 with C5 = JS number `5` (string output).
- **When** C0.
- **Then** it fails with a conversion error at `Base DMN!C5` (must be a quoted string).
- **Source** spec §5 Cell-value extraction (string column "must already contain FEEL quotes"), §3b.

### CAMUNDA7-094: Real Excel boolean in an integer column is a type error

- **Given** W0 with B5 = JS `true`. **When** C0. **Then** error at `Base DMN!B5`.
- **Source** spec §5 Cell-value extraction, §3b numeric row.

### CAMUNDA7-095: Text `TRUE` (upper case) in a boolean column

- **Given** W0 plus input D `isMember` / `boolean` with D5 = the **string** `TRUE`.
- **When** C0.
- **Then** **Spec silent** on whether text `TRUE` is coerced like a real boolean. Reasonable expectation: it is a type error at `Base DMN!D5`, because in FEEL `TRUE` is an identifier and the spec's lowercase coercion is stated only for real Excel booleans.
- **Source** spec §5 Cell-value extraction (boolean bullet), §3b boolean row.

### CAMUNDA7-096: Formula cell uses its computed result

- **Given** W0 plus output D `days` / `integer` with D5 = `{ formula: '2+3', result: 5 }` and D6 = `10`.
- **When** C0.
- **Then** `days_1` text = `5`; the formula source `2+3` does not appear in the XML.
- **Source** spec §5 Cell-value extraction ("Formula cells → use the computed `result` … never the formula source").

### CAMUNDA7-097: Leading and trailing whitespace is trimmed from entries

- **Given** W0 with B5 = `   < 10  ` and C5 = ` "LOW"`.
- **When** C0.
- **Then** `amount_1` = `< 10` and `result_1` = `"LOW"`.
- **Source** spec §5 Cell-value extraction ("Trim leading/trailing whitespace").

### CAMUNDA7-098: Interior UTF-8 is preserved in entries, labels and names

- **Given** W0 with C4 (label) = `Wynik – opis ≤`, C5 = `"Zürich – Süd ≤ łódź"`, and a `name` column with value `Opłata za wysyłkę`.
- **When** C0.
- **Then** the label, output text and decision name come through byte-for-byte (UTF-8) after re-parse.
- **Source** spec §5 Cell-value extraction ("preserve interior UTF-8 (Polish diacritics, `≤`, en-dash `–`)").

### CAMUNDA7-099: XML-special characters in a string output are escaped and round-trip

- **Given** W0 with C5 = `"A & B <C>"`.
- **When** C0.
- **Then** the raw XML holds `&amp;` and `&lt;`. After re-parse, `result_1` text = `"A & B <C>"`.
- **Source** spec §6.3 (moddle serialization), §1 (valid DMN).

---

## 8. Hit policies

### CAMUNDA7-100: Policy marker column `FIRST`

- **Given** W0 plus a `policy` column (marker `policy`, row 2 = `FIRST`) placed before `id`.
- **When** C0.
- **Then** `<decisionTable … hitPolicy="FIRST">`; there is no `aggregation`; the policy column is not a data column (still one input and one output).
- **Source** spec §3.4, §3.2 `policy` ("Not a data column"), §6.1.

### CAMUNDA7-101: Policy `ANY`

- As CAMUNDA7-100 with `ANY`. **Then** `hitPolicy="ANY"`.
- **Source** spec §3.4.

### CAMUNDA7-102: Policy `RULE ORDER` (value with a space)

- As CAMUNDA7-100 with `RULE ORDER`. **Then** `hitPolicy="RULE ORDER"`; it re-parses with 0 warnings.
- **Source** spec §3.4.

### CAMUNDA7-103: Policy `COLLECT` without an aggregator

- As CAMUNDA7-100 with `COLLECT` and row 3 of the policy column empty. **Then** `hitPolicy="COLLECT"` and no `aggregation` attribute.
- **Source** spec §3.4 ("an optional aggregator").

### CAMUNDA7-104: COLLECT with each aggregator (SUM, MIN, MAX, COUNT; one run each)

- **Given** a policy column with row 2 = `COLLECT` and row 3 = `SUM` / `MIN` / `MAX` / `COUNT`, and output `days` / `integer` with numeric outputs.
- **When** C0.
- **Then** `hitPolicy="COLLECT" aggregation="<AGG>"` for each value.
- **Source** spec §3.4 ("aggregator may be given at row M+2 of the `policy` column: `SUM`, `MIN`, `MAX`, `COUNT`"), §7.1 `hitPolicy.aggregatorOffset`.

### CAMUNDA7-105: Unknown COLLECT aggregator is rejected

- **Given** a policy column with `COLLECT` / `AVG`.
- **When** C0.
- **Then** exit `1`; the error names the aggregator `AVG` and the policy column's M+2 cell (`Base DMN!A3`, with the policy column in A).
- **Source** spec §3.4 (aggregator ∈ SUM/MIN/MAX/COUNT), §4.2 ("Enumerate `hitPolicy` and `aggregation`" in the schema; schema validation fails with sheet!cell). **Spec silent** on the exact message.

### CAMUNDA7-106: Aggregator on a non-COLLECT policy is ignored

- **Given** a policy column with `FIRST` / `SUM`.
- **When** C0.
- **Then** exit `0`; `hitPolicy="FIRST"` with no `aggregation` attribute. **Spec silent**; the spec defines the aggregator only "for `COLLECT`", so it is ignored elsewhere.
- **Source** spec §3.4.

### CAMUNDA7-107: Explicit `UNIQUE` in the policy column is not written

- As CAMUNDA7-100 with `UNIQUE`. **Then** no `hitPolicy` attribute.
- **Source** spec §6.1 / §6.4 (UNIQUE omitted).

### CAMUNDA7-108: Lower-case policy and aggregator values are accepted

- **Given** a policy column with `collect` / `sum` (second run: `rule order`).
- **When** C0.
- **Then** exit `0`; `hitPolicy="COLLECT" aggregation="SUM"` (and `hitPolicy="RULE ORDER"`). **Spec silent** on casing. Markers are case-insensitive (§7.1 `markers.caseInsensitive`), and DMN requires upper-case enum values, so normalizing is the reasonable expectation.
- **Source** spec §3.4, §7.1.

### CAMUNDA7-109: Unknown hit policy is rejected

- **Given** a policy column with `RANDOM`.
- **When** C0.
- **Then** exit `1`; stderr names `RANDOM` as an unknown hit policy, ideally with the cell (`Base DMN!A2`).
- **Source** spec §3.4 (accepted values), §7.1 `hitPolicy.allowed`.

### CAMUNDA7-110: `--hit-policy` is the fallback when there is no policy column

- **Given** W0 (no policy column).
- **When** C0 + `--hit-policy FIRST`.
- **Then** `hitPolicy="FIRST"`.
- **Source** spec §3.4 resolution order (2. `--hit-policy` flag / config).

### CAMUNDA7-111: Policy column beats `--hit-policy`

- **Given** CAMUNDA7-100 (policy column `FIRST`).
- **When** C0 + `--hit-policy "RULE ORDER"`.
- **Then** `hitPolicy="FIRST"`.
- **Source** spec §3.4 resolution order (1. `policy` marker column).

### CAMUNDA7-112: `hitPolicy.default` from config is the fallback

- **Given** W0, with config `{ "hitPolicy": { "default": "ANY" } }`.
- **When** C0 + `--config`.
- **Then** `hitPolicy="ANY"`.
- **Source** spec §3.4, §7.1 ("`--hit-policy` → `hitPolicy.default`").

### CAMUNDA7-113: `--hit-policy` beats the config default

- **Given** CAMUNDA7-112's config.
- **When** C0 + `--config cfg.json --hit-policy FIRST`.
- **Then** `hitPolicy="FIRST"`.
- **Source** spec §7.1 precedence.

### CAMUNDA7-114: Policy column with an empty value falls back

- **Given** a policy column whose row 2 is empty, plus `--hit-policy FIRST`.
- **When** C0 + flag.
- **Then** `hitPolicy="FIRST"` (without the flag: UNIQUE, no attribute). **Spec silent**; an empty carrier is treated as absent.
- **Source** spec §3.4 resolution order.

### CAMUNDA7-115: `--hit-policy` with an invalid value is rejected

- **Given** W0. **When** C0 + `--hit-policy BOGUS`.
- **Then** exit `1`; the error names `BOGUS`.
- **Source** spec §3.4 accepted values, §7.1 `hitPolicy.allowed`.

### CAMUNDA7-116: Two policy columns are a structural error

- **Given** W0 plus two `policy` columns.
- **When** C0.
- **Then** exit `1`; the error says there is more than one policy column and names the second marker cell.
- **Source** spec §5 Step 2 ("at most one `name` / `policy` column").

### CAMUNDA7-117: PRIORITY with allowed values converts (C7 supports it)

- **Given** the allowed-values layout (config `ALLOWED_VALUES_LAYOUT`), a policy column `PRIORITY`, output `result` / `string` with allowed `"HIGH","LOW"`, and rules `< 10` → `"LOW"` and `>= 5` → `"HIGH"`.
- **When** C0 + `--config`.
- **Then** exit `0`; `hitPolicy="PRIORITY"`; `<output …><outputValues><text>"HIGH","LOW"</text></outputValues></output>`.
- **Source** spec §3.6 ("Required for `PRIORITY` and `OUTPUT ORDER`"), §6.1 (outputValues order defines ranking), §6.6 (only C8 rejects PRIORITY).

### CAMUNDA7-118: OUTPUT ORDER with allowed values converts

- As CAMUNDA7-117 with `OUTPUT ORDER`. **Then** `hitPolicy="OUTPUT ORDER"` and outputValues present.
- **Source** spec §3.6, §6.1.

### CAMUNDA7-119: PRIORITY in the default 4-row layout (no allowed-values row) is rejected

- **Given** W0 plus a policy column `PRIORITY` (no allowed-values config).
- **When** C0.
- **Then** exit `1`; the message says hit policy `PRIORITY` requires allowed values (`<outputValues>`) for output `result`; no `.dmn` written.
- **Source** spec §3.6 ("the tool errors otherwise"), §5 Step 2 (`hitPolicy 'PRIORITY' requires <outputValues> — set allowed values for output '<name>' at <sheet>!<cell>`).
- **Note:** with no allowed-values row there is no real cell to point at, so the message must not cite a meaningless coordinate such as a `NaN` row. **Spec silent** on the cell in this case.

### CAMUNDA7-120: OUTPUT ORDER with a blank output allowed-values cell is rejected with that cell

- **Given** the allowed-values layout, a policy column `OUTPUT ORDER`, and output `result` in column C whose allowed-values cell C4 is blank.
- **When** C0 + `--config`.
- **Then** exit `1`; the message names output `result` and `Base DMN!C4`.
- **Source** spec §5 Step 2 (message with `<sheet>!<cell>`).

### CAMUNDA7-121: PRIORITY with two outputs, one missing allowed values

- **Given** the allowed-values layout, PRIORITY, output C `result` with allowed `"HIGH","LOW"`, and output D `days` / `integer` with blank allowed values.
- **When** C0 + `--config`.
- **Then** exit `1`; the error names `days` and `Base DMN!D4` and does not name `result`.
- **Source** spec §5 Step 2 ("**every** output column must have a non-blank allowed-values cell").

---

## 9. Allowed values (opt-in 5-row layout)

All scenarios here use config `ALLOWED_VALUES_LAYOUT`
(`{ header: { allowedValuesOffset: 3, labelOffset: 4 }, rules: { startOffset: 5 } }`)
and `decisionSheet(..., { allowedValues: true })`: marker row 1, name 2, type 3,
allowed 4, label 5, rules from row 6.

### CAMUNDA7-122: Input allowed values map to `<inputValues>`

- **Given** input `region` / `string`, allowed `"EU","US"`, label `Region`, rules `"EU"`, `"US"`.
- **When** C0 + `--config`.
- **Then** `<input id="region" label="Region">` holds `<inputValues><text>"EU","US"</text></inputValues>`; inputValues has no `id` attribute.
- **Source** spec §3.6, §6.1 ("`inputValues: dmn:UnaryTests { text: <list> }` (no id)").

### CAMUNDA7-123: Output allowed values map to `<outputValues>`

- **Given** output `result` / `string`, allowed `"LOW","HIGH"`.
- **Then** `<outputValues><text>"LOW","HIGH"</text></outputValues>` with no id.
- **Source** spec §3.6, §6.1.

### CAMUNDA7-124: Label is read from row M+4 and rules from M+5 in this layout

- **Given** labels on row 5 and the first rule on row 6.
- **Then** `label="Region"` (not the allowed-values text); the first rule is `rule_1`, built from row 6; the label row does not become a rule.
- **Source** spec §3.1 allowed-values table.

### CAMUNDA7-125: A blank allowed-values cell means unconstrained

- **Given** input `amount` / `integer` with a blank allowed cell.
- **Then** that input has no `<inputValues>`.
- **Source** spec §3.6 ("A **blank** cell means the column is unconstrained").

### CAMUNDA7-126: Numeric range and boolean domains

- **Given** input `amount` / `integer` with allowed `[0..100]`, input `isMember` / `boolean` with allowed `true,false`, and output `days` / `integer` with allowed `1,2,3`.
- **Then** exit `0`; the three lists are emitted verbatim in inputValues/outputValues.
- **Source** spec §3.6 (examples `1,2,3`, `[0..100]`, `true,false`).

### CAMUNDA7-127: Allowed-values list with the wrong literal kind is rejected

- **Given** input `region` / `string` with allowed `EU,US` (unquoted), in column B.
- **Then** exit `1`; the error names `Base DMN!B4` (the allowed-values cell).
- **Source** spec §3.6 Validation, §3b "Allowed-values checks" ("a `string` domain must be quoted strings").

### CAMUNDA7-128: Numeric domain with a string member is rejected

- **Given** input `amount` / `integer` with allowed `1,"2"`.
- **Then** exit `1`; error at the allowed-values cell of `amount`.
- **Source** spec §3b Allowed-values checks.

### CAMUNDA7-129: Allowed-values FEEL syntax error is rejected

- **Given** input `amount` / `integer` with allowed `[0..`.
- **Then** exit `1`; error at the allowed-values cell.
- **Source** spec §3b Allowed-values checks ("validated for FEEL syntax").

### CAMUNDA7-130: Out-of-domain entries pass when `enforceAllowedValues` is false (default)

- **Given** input `region` with allowed `"EU","US"` and rule entry `"APAC"`.
- **Then** exit `0`; `region_1` = `"APAC"`.
- **Source** spec §3.6, §3b ("Default `false` (advisory)").

### CAMUNDA7-131: Out-of-domain scalar is rejected when `enforceAllowedValues` is true

- **Given** CAMUNDA7-130 with config adding `{ "validation": { "enforceAllowedValues": true } }`; `"APAC"` sits in cell B6.
- **Then** exit `1`; error at `Base DMN!B6` naming input `region`.
- **Source** spec §3b ("a scalar not in the set … is reported with a cell coordinate"), §7.1.

### CAMUNDA7-132: Numeric range outside the domain is rejected when enforcement is on

- **Given** input `amount` / `integer` with allowed `[0..100]`, rule entries `[50..150]` (row 6) and `< 20` (row 7); enforcement on.
- **Then** exit `1`; error at the row-6 cell; row 7 is not reported.
- **Source** spec §3b ("a range outside the numeric domain").

### CAMUNDA7-133: Wildcard and empty entries always pass domain enforcement

- **Given** enforcement on, input `region` with allowed `"EU","US"`, and entries `-` and empty.
- **Then** exit `0`.
- **Source** spec §3b ("`-`/empty always pass").

### CAMUNDA7-134: Output entry outside the output domain is rejected when enforcement is on

- **Given** enforcement on, output `result` with allowed `"LOW","HIGH"`, and rule output `"MID"` in C6.
- **Then** exit `1`; error at `Base DMN!C6`.
- **Source** spec §3b ("each rule's `input`/`output` **entry** is additionally checked").

### CAMUNDA7-135: Allowed-values layout without allowed data still converts like the default

- **Given** a 5-row sheet where every allowed cell is blank.
- **Then** exit `0`; no inputValues/outputValues; labels and rules as in CAMUNDA7-124.
- **Source** spec §3.6.

---

## 10. Annotations to rule `<description>`

### CAMUNDA7-136: Annotation cell becomes the rule's `<description>`, written first

- **Given** W0 plus column D with marker `annotations`, D5 = `small orders`, D6 empty.
- **When** C0.
- **Then** `rule_1` starts with `<description>small orders</description>` before its entries. `rule_2` has no `<description>`. There is no `<annotation>`/`<annotationEntry>` element, and no extra input/output clause.
- **Source** spec §3.2 `annotations`, §6.1 ("serializes as `<description>` **first inside `<rule>`**"), §6.4.

### CAMUNDA7-137: Annotations marker is case-insensitive (`Annotations`, `ANNOTATIONS`)

- As CAMUNDA7-136 with marker `Annotations` (run 2: `ANNOTATIONS`). **Then** the same output.
- **Source** spec §3.2 ("case-insensitive, trimmed"), README template table (`Annotations`).

### CAMUNDA7-138: Multiple annotation columns are joined with `|`

- **Given** W0 plus annotation columns D and E with D5 = `a`, E5 = `b`, D6 = empty, E6 = `only-e`.
- **Then** `rule_1` description = `a | b`; `rule_2` description = `only-e` (no leading separator).
- **Source** spec §3.2 ("join non-empty values with `markers.annotationSeparator` (default `" | "`)"), §5 Step 3.

### CAMUNDA7-139: Custom annotation separator

- **Given** CAMUNDA7-138, with config `{ "markers": { "annotationSeparator": "; " } }`.
- **Then** `rule_1` description = `a; b`.
- **Source** spec §7.1 `markers.annotationSeparator`.

### CAMUNDA7-140: Annotation text is free text: not FEEL-checked, not quoted, escaped in XML

- **Given** W0 plus annotations D5 = `unquoted words & "quotes" <tag> [1..` .
- **Then** exit `0`. After re-parse, the description equals the trimmed cell text exactly; the raw XML has `&amp;` and `&lt;`.
- **Source** spec §3.2 ("Not FEEL-validated, not quoted"), §3b ("`annotations` columns are skipped").

### CAMUNDA7-141: Annotation-only row ends the table

- **Given** W0 plus annotations column D, and a row 7 where only D7 = `orphan note` is filled, with row 8 a full rule.
- **Then** two rules only (rows 5 and 6); `orphan note` and row 8 do not appear.
- **Source** spec §3.3 ("a row with only annotations and no input/output data ends the table"), §5 Step 3.

### CAMUNDA7-142: Annotation header rows (M+1..M+3) are ignored

- **Given** the annotations column D with D2 = `noteName`, D3 = `string`, D4 = `Comment`.
- **Then** none of those values appear anywhere in the XML.
- **Source** spec §3.2 ("The `M+1`/`M+2`/`M+3` rows don't apply"), §5 Step 2.

### CAMUNDA7-143: Whitespace-only annotation means no description

- **Given** annotations D5 = `   `.
- **Then** `rule_1` has no `<description>`.
- **Source** spec §3.2 ("Empty cell ⇒ no `<description>`"), §5 (trim).

---

## 11. Helper and ignored columns

### CAMUNDA7-144: Blank-marker helper column is ignored entirely

- **Given** W0 with a column inserted between B and C whose marker cell is empty, with name/type/label rows and rule rows holding `junk`, `[1..` and `"x"`.
- **When** C0.
- **Then** exit `0`; still one input and one output; none of the helper text appears in the XML; there is no FEEL error for `[1..`.
- **Source** spec §1 Non-goals, §3.2 (blank → helper, "ignored entirely"), §5 Step 3.

### CAMUNDA7-145: Arbitrary marker text (`NOT PART OF DMN`, `No.`, `Notes`) makes a helper column

- **Given** W0 plus helper columns with markers `NOT PART OF DMN`, `No.` and `Notes`, holding rule data.
- **Then** exit `0`; the DMN is identical byte-for-byte to plain W0's output.
- **Source** spec §3.2 ("everything else is a helper column"), §3.5.

### CAMUNDA7-146: Legacy `DMN_X` rule-number column is a helper

- **Given** W0 plus a first column with a blank marker and rule cells `DMN_1`, `DMN_2`.
- **Then** byte-identical to plain W0's output; rule ids still `rule_1`, `rule_2` (not read from the column).
- **Source** spec §3.3 ("A legacy `DMN_X` … column … carries no special role").

### CAMUNDA7-147: Data in a helper column alone does not make a row a rule

- **Given** W0 plus a helper column E with E7 = `note`, while B7 and C7 are empty, and row 8 a full rule.
- **Then** two rules only.
- **Source** spec §3.3 ("a row is a rule if any of its `input`/`output` cells is non-empty").

### CAMUNDA7-148: Marker cell containing the keyword inside other text is a helper

- **Given** a column with marker `input data` and another with marker `output (old)`.
- **Then** both are helpers, not clauses (exact keyword match after trim and case-fold).
- **Source** spec §3.2 ("Only the exact keywords in `markers.*` (case-insensitive, trimmed) are roles").

---

## 12. Header discovery

### CAMUNDA7-149: Marker row on row 3 (banner rows above)

- **Given** W0 shifted down two rows: row 1 = `Shipping rules` (A1), row 2 empty, marker row 3, rules on rows 7–8.
- **When** C0.
- **Then** exit `0`; the output is byte-identical to plain W0's (rule ids are index-based).
- **Source** spec §3 intro and §3.1 ("position-independent … scanning … rows 1–5"), §5 Step 2.

### CAMUNDA7-150: Marker row on row 5 (last scanned row)

- **Given** W0 shifted down four rows.
- **Then** exit `0`, with the same DMN as W0.
- **Source** spec §3.1 (rows 1–5), §7.1 `header.scanRows: 5`.

### CAMUNDA7-151: Marker row on row 6 is not found by default

- **Given** W0 shifted down five rows.
- **When** C0.
- **Then** exit `1`; the error says no input/output marker row was found in sheet `Base DMN` within the first 5 rows; no `.dmn`.
- **Source** spec §3.1, §7.1 `header.scanRows`. **Spec silent** on the exact message.

### CAMUNDA7-152: `header.scanRows` extends the search

- **Given** CAMUNDA7-151, with config `{ "header": { "scanRows": 10 } }`.
- **Then** exit `0`, with the same DMN as W0.
- **Source** spec §7.1 ("`header.*Offset` and `header.scanRows` cover templates whose header block is laid out differently").

### CAMUNDA7-153: Table starting in a later column (leading blank columns)

- **Given** W0 shifted right by two columns (A and B empty).
- **Then** exit `0`, with the same DMN as W0; error coordinates (if any) use the shifted letters (e.g. `Base DMN!D5`).
- **Source** spec §5 ("tolerates leading blank rows/columns").

### CAMUNDA7-154: The first row with an input/output marker wins, even if an earlier row has `id`

- **Given** row 1 has only an `id`-looking cell (`id` in A1, nothing else), and the real marker row with `id`/`input`/`output` is row 2.
- **Then** row 2 is the marker row (the scan looks for `input` or `output`).
- **Source** spec §3.1 ("the first row that contains at least one `input` or `output` cell").

### CAMUNDA7-155: Markers are case-insensitive and trimmed

- **Given** W0 with markers `ID`, `INPUT`, `Output`.
- **Then** byte-identical output to W0's.
- **Source** spec §3.2 ("case-insensitive, trimmed"), §7.1 `markers.caseInsensitive: true`.

### CAMUNDA7-156: `markers.caseInsensitive: false` makes markers case-sensitive

- **Given** W0 with marker `INPUT` in B, with config `{ "markers": { "caseInsensitive": false } }`.
- **Then** B is a helper. The marker row is still found through `output`. The DMN has zero inputs, and the conversion proceeds with a warning (see CAMUNDA7-170).
- **Source** spec §7.1 `markers.caseInsensitive`. **Spec silent** on the exact outcome; this follows from the rules.

### CAMUNDA7-157: Renamed marker keywords via config

- **Given** a sheet using markers `KEY`, `in`, `out` instead of `id`, `input`, `output`, with config `{ "markers": { "id": "KEY", "input": "in", "output": "out" } }`.
- **Then** exit `0`; the DMN matches the equivalent default-marker sheet byte-for-byte.
- **Source** spec §7.1 Rules of use ("renaming `id`→`KEY` or `input`→`in` … is a one-line config change").

### CAMUNDA7-158: Relocated header rows via offsets

- **Given** a sheet where the type is on M+1 and the name on M+2, with config `{ "header": { "nameOffset": 2, "typeOffset": 1 } }`.
- **Then** exit `0`; same DMN as W0.
- **Source** spec §3.1 ("Every header row is an independent integer offset"), §7.1.

---

## 13. Rule detection

### CAMUNDA7-159: Rules stop at the first fully empty input/output row

- **Given** W0 plus an empty row 7 and a full rule on row 8 (`< 0`, `"NEG"`).
- **Then** two rules; `"NEG"` does not appear.
- **Source** spec §3.3 ("Reading **stops** at the first row where **all** `input` and `output` cells are empty"), README ("reading stops at the first fully-empty row").

### CAMUNDA7-160: A row with only an output filled is a rule

- **Given** W0 plus row 7 with B7 empty and C7 = `"DEFAULT"`.
- **Then** three rules; `rule_3` has an empty input entry and output `"DEFAULT"`.
- **Source** spec §3.3 ("a row **is a rule** if any of its `input`/`output` cells is non-empty").

### CAMUNDA7-161: A row with only an input filled is a rule with an empty output

- **Given** W0 plus row 7 with B7 = `100` and C7 empty.
- **Then** three rules; `result_3` is empty `<text></text>`.
- **Source** spec §3.3, §4.1 notes (empty output cell).

### CAMUNDA7-162: A row whose input is `-` and output empty is still a rule

- **Given** W0 plus row 7 with B7 = `-` and C7 empty.
- **Then** three rules (`-` is non-empty cell content); `rule_3` has two empty texts. **Spec silent** on whether the `-` token counts for detection. Detection is on the cell being non-empty, before normalization.
- **Source** spec §3.3.

### CAMUNDA7-163: No rules at all is an error

- **Given** W0 with rows 5 and 6 removed (header only).
- **Then** exit `1`; the message says no rules were found in `Base DMN` (no data rows below the header).
- **Source** spec §5 Step 3 (`No rules found in <sheet> (no data rows below the header)`).

### CAMUNDA7-164: Many rules keep order and sequential ids

- **Given** W0 with 50 rule rows (`= 1` … `= 50` → `"R1"` … `"R50"`).
- **Then** rules `rule_1` … `rule_50` in sheet order, with `amount_50` = `= 50`.
- **Source** spec §3.3, §6.4.

---

## 14. Decision identity

### CAMUNDA7-165: Decision name falls back to the raw id value

- **Given** W0 with A2 = `Shipping rates` and no `name` column.
- **Then** decision `id="SHIPPING_RATES"`, `name="Shipping rates"`, definitions `name="Shipping rates"`; the file is `SHIPPING_RATES.dmn`.
- **Source** spec §3.2 `id` ("also `decision.name`" when no name column), §6.4.

### CAMUNDA7-166: `name` column sets the display name verbatim

- **Given** W0 plus a `name` column with value ` Shipping Rate Decision (v2)` (inner text unchanged).
- **Then** `name="Shipping Rate Decision (v2)"` on both `<decision>` and `<definitions>`; the id is still `BASE`.
- **Source** spec §3.2 `name` ("verbatim (as-is, no sanitization)"), §5 (trim).

### CAMUNDA7-167: id sanitization: diacritics, fold map, punctuation, leading digit (one run each)

- **Given** id values `Zürich Süd`, `Straße łódź`, `rates-v2.final`, `2024 rates`, `__a  b__`.
- **Then** decision ids `ZURICH_SUD`, `STRASSE_LODZ`, `RATES_V2_FINAL`, `_2024_RATES` and `A_B`; files named after them; definitions id `definitions_<id>`; shape `DMNShape_<id>`.
- **Source** spec §6.4 `toNcNameId` and its "Verified" examples.

### CAMUNDA7-168: `identity.idCase: "preserve"` keeps the case

- **Given** id `ShippingRates`, with config `{ "identity": { "idCase": "preserve" } }`.
- **Then** decision id `ShippingRates`, file `ShippingRates.dmn`.
- **Source** spec §7.1 `identity.idCase`.

### CAMUNDA7-169: Missing id column, empty id value, two id columns, two name columns (one run each)

- **Given** (a) W0 without column A; (b) W0 with A2 empty; (c) W0 plus a second `id` column; (d) W0 plus two `name` columns.
- **Then** each exits `1` with no `.dmn`: (a) message about the missing required ID marker column in `Base DMN`; (b) error at `Base DMN!A2`; (c) and (d) "more than one" error naming the duplicate marker cell.
- **Source** spec §3.2, §5 Step 2 ("exactly one `id` column; at most one `name` / `policy` column"; `Missing required ID marker column in <sheet>`).

---

## 15. Header validation and structure

### CAMUNDA7-170: Zero input columns warns but converts

- **Given** a sheet with only `id` and one `output` column, and rules `"A"`, `"B"`.
- **When** C0.
- **Then** exit `0`; the decision table has no `<input>` and two rules with only output entries; a warning about zero inputs is shown (stderr; **spec silent** on the channel).
- **Source** spec §5 Step 2 ("Zero `input` columns is allowed by DMN (rare) — warn but continue").

### CAMUNDA7-171: No output column is an error

- **Given** W0 without column C.
- **Then** exit `1`; message about no output column found in `Base DMN`.
- **Source** spec §5 Step 2 (`No output column found in <sheet>`), §4.2 (`minItems: 1`).

### CAMUNDA7-172: Missing technical name

- **Given** W0 with B2 empty.
- **Then** exit `1`; error at `Base DMN!B2` mentioning a missing technical name for an input.
- **Source** spec §5 Step 2 (`Missing technical name for input at ...!E2 (column E)`).

### CAMUNDA7-173: Missing typeRef

- **Given** W0 with C3 empty.
- **Then** exit `1`; error at `Base DMN!C3` mentioning a missing typeRef for output `result`.
- **Source** spec §5 Step 2 (`Missing typeRef for output at Shipping Rates_ DMN!J3 (column J)`).

### CAMUNDA7-174: All header problems are reported in one pass

- **Given** W0 with B2 empty, C3 empty, and an extra input D with D3 = `text`.
- **Then** exit `1`; stderr names `Base DMN!B2`, `Base DMN!C3` and `Base DMN!D3` in one run.
- **Source** spec §5 Step 2 ("Collect all such problems and report them together so the author fixes the header in one pass").

### CAMUNDA7-175: Missing label is allowed and the attribute is omitted

- **Given** W0 with B4 and C4 empty.
- **Then** exit `0`; `<input id="amount">` and `<output id="result" name="result" typeRef="string">` have no `label` attribute (not `label=""`). **Spec silent**; label is not a required header field (§5 Step 2 requires only name and type).
- **Source** spec §5 Step 2.

---

## 16. Multiple inputs and outputs

### CAMUNDA7-176: Several inputs and outputs keep left-to-right order

- **Given** columns: A `id` = `MULTI`; B input `orderTotal` / `double`; C output `shippingMethod` / `string`; D input `region` / `string`; E helper; F input `isMember` / `boolean`; G output `deliveryDays` / `integer`; H input `tags` / `Any`. Two rules fill every clause.
- **When** C0.
- **Then** the inputs in order are `orderTotal`, `region`, `isMember` and `tags`; the outputs in order are `shippingMethod` and `deliveryDays`. Each rule has 4 inputEntries and 2 outputEntries in that order, with ids `orderTotal_1`, `region_1`, …, `shippingMethod_1` and `deliveryDays_1`.
- **Source** spec §3.2 ("Column order is preserved"), §4.1 notes (positional alignment), §6.4.

### CAMUNDA7-177: Spec reference example (shipping rates) end to end

- **Given** a workbook built in code mirroring spec §3.5 (camunda7 types): policy `UNIQUE`, `ID` = `SHIPPING_RATES`, `name` = `Shipping Rate Decision`, a `No.` helper, inputs `orderTotal` / `double`, `region` / `string`, `isMember` / `boolean`, `weightKg` / `double` and `tags` / `Any`, outputs `shippingMethod` / `string` and `deliveryDays` / `integer`, an `annotations` column, a `NOT PART OF DMN` helper, and first rule `< 50`, `"EU"`, `false`, `<= 5`, `-` → `"STANDARD"`, `5`, `standard EU parcel`.
- **When** C0.
- **Then** `SHIPPING_RATES.dmn` with `name="Shipping Rate Decision"` and `camunda:historyTimeToLive="P180D"`; no hitPolicy attribute. `rule_1` has `<description>standard EU parcel</description>`, entries `&lt; 50`, `"EU"`, `false`, `&lt;= 5`, empty, `"STANDARD"`, `5`. `tags_expression` has no typeRef.
- **Source** spec §3.5 (adapted to Camunda 7 types; §3.5 itself uses `number`, which C7 rejects by default, see CAMUNDA7-042).

### CAMUNDA7-178: Duplicate technical names among inputs

- **Given** two input columns both named `amount`.
- **Then** **Spec silent.** Reasonable expectation: either a header error naming the second name cell, or unique clause ids by suffix (`amount`, `amount_2`, per §6.4 "unique across the file" and `identity.collisionSuffix`). Either way the produced XML must never contain duplicate `id` values, and it must re-parse with 0 warnings.
- **Source** spec §6.4 ("Every `id` is a valid NCName and unique across the file").

### CAMUNDA7-179: Input name colliding with an output name

- **Given** an input named `result` and an output named `result`.
- **Then** **Spec silent.** As CAMUNDA7-178: no duplicate XML ids (input clause `result` and output clause `result` would collide), and either a clear header error or deduped ids.
- **Source** spec §6.4.

---

## 17. CLI output modes and files

### CAMUNDA7-180: Default output directory is beside the input workbook

- **Given** W0 at `tmp/in/base_DMN.xlsx`.
- **When** `excel2dmn in/base_DMN.xlsx` with cwd = `tmp` (no `--out-dir`).
- **Then** `tmp/in/BASE.dmn` exists; no `.dmn` in `tmp`.
- **Source** spec §7 (`--out-dir` "default: alongside <input.xlsx>"), §7.1 `output.outDir: null`.

### CAMUNDA7-181: `-o` writes a single-sheet result to a named file

- **Given** W0.
- **When** `excel2dmn base_DMN.xlsx -o out/custom-name.dmn`.
- **Then** exit `0`; `out/custom-name.dmn` exists with the W0 DMN; no `BASE.dmn` anywhere. **Spec gap check:** `-o` must be honored, not ignored.
- **Source** spec §7 (`-o, --out <file>`), README ("Single-sheet workbook to a named file").

### CAMUNDA7-182: `-o` with two DMN sheets is an error

- **Given** a workbook with sheets `A DMN` and `B DMN`, each a valid W0 variant (ids `A`, `B`).
- **When** `excel2dmn book.xlsx -o out/x.dmn`.
- **Then** exit `1`; stderr says `--out` is only valid for a single DMN sheet; **no** `.dmn` files written (spec: "error if multiple").
- **Source** spec §7 (`--out` "ONLY valid when exactly one DMN sheet is processed; error if multiple").

### CAMUNDA7-183: `-j/--json` writes the intermediate model

- **Given** W0. **When** C0 + `--json`.
- **Then** `out/BASE.model.json` exists. It parses to `{ definitions: { id: "definitions_BASE", name: "BASE", namespace: "http://camunda.org/schema/1.0/dmn" }, decisions: [ { id: "BASE", name: "BASE", hitPolicy: "UNIQUE", aggregation: null, inputs: [ { expression: "amount", typeRef: "integer", label: "Amount", allowedValues: null } ], outputs: [ { name: "result", … } ], rules: [ { id: "rule_1", row: 5, inputEntries: ["< 10"], outputEntries: ["\"LOW\""] }, … ] } ] }`. There are no clause/entry ids and no keys starting with `__`.
- **Source** spec §4.1, §4.1 notes, §7 (`-j, --json`).

### CAMUNDA7-184: `output.writeModelJson: true` writes JSON without the flag

- **Given** W0, with config `{ "output": { "writeModelJson": true } }`.
- **Then** `out/BASE.model.json` exists.
- **Source** spec §7.1 `output.writeModelJson`.

### CAMUNDA7-185: `output.fileNameTemplate: "<sheetName>.dmn"`

- **Given** W0, with config `{ "output": { "fileNameTemplate": "<sheetName>.dmn" } }`.
- **Then** `out/Base DMN.dmn` exists.
- **Source** spec §7.1 (`fileNameTemplate` … "also `<sheetName>.dmn`").

### CAMUNDA7-186: `--validate-only` writes nothing and reports success

- **Given** W0.
- **When** C0 + `--validate-only`.
- **Then** exit `0`; `out` is absent or empty; stdout reports sheet `Base DMN` / decision `BASE` as valid.
- **Source** spec §7 (`--validate-only` "parse + schema-validate all sheets, do not emit DMN"), README ("Validate only (CI gate)").

### CAMUNDA7-187: `--validate-only` fails on an invalid workbook

- **Given** W0 with B5 = `"5"`.
- **When** C0 + `--validate-only`.
- **Then** exit `1`; error at `Base DMN!B5`; no files.
- **Source** spec §7, §8 design notes ("`validate` stage fails the pipeline on malformed templates").

### CAMUNDA7-188: `--no-pretty` / `output.format: false` emits unformatted XML

- **Given** W0.
- **When** C0 + `--no-pretty` (run 2: config `{ "output": { "format": false } }`).
- **Then** exit `0`; the XML has no indentation newlines between elements (at most the declaration line break); it re-parses to the same model as the pretty output.
- **Source** spec §7 (`--pretty` "format XML (default true)"), §7.1 `output.format`. **Note:** the spec lists `--pretty`, while the CLI exposes `--no-pretty`; the scenario tests the ability to turn formatting off.

### CAMUNDA7-189: Workbook without any DMN sheet

- **Given** a workbook with a single sheet `Rates` (a valid table otherwise).
- **When** C0.
- **Then** exit `1`; the message says no sheet containing `DMN` was found; no files.
- **Source** spec §3 intro ("0 matching sheets ⇒ hard error: "no sheet containing 'DMN' found"").

### CAMUNDA7-190: Non-DMN sheets are ignored

- **Given** W0 plus a sheet `Notes` holding garbage (and its own `input` markers).
- **Then** exit `0`; only `BASE.dmn` is written.
- **Source** spec §3 intro ("Non-matching sheets are ignored").

### CAMUNDA7-191: Sheet-name match is a case-insensitive substring

- **Given** W0 with the sheet renamed `rates_dmn`.
- **Then** exit `0`; `BASE.dmn` is written.
- **Source** spec §3 intro ("case-insensitive substring").

### CAMUNDA7-192: `--sheet` restricts conversion

- **Given** sheets `A DMN` (id `A`) and `B DMN` (id `B`).
- **When** C0 + `--sheet "B DMN"`.
- **Then** only `B.dmn` is written.
- **Source** spec §3 intro (`--sheet <name...>`), §7.

### CAMUNDA7-193: Two DMN sheets give two files

- **Given** sheets `A DMN` and `B DMN`.
- **When** C0.
- **Then** `A.dmn` and `B.dmn`, each a standalone document with its own `<definitions id="definitions_A">` / `definitions_B`.
- **Source** spec §3 intro, §4, §6.

### CAMUNDA7-194: One invalid sheet does not block a valid sibling, but the exit is non-zero

- **Given** sheet `A DMN` valid and sheet `B DMN` with B5 = `"5"`.
- **When** C0.
- **Then** exit `1`; `out/A.dmn` is written and valid; no `B.dmn`; stderr names sheet `B DMN` and `B DMN!B5`.
- **Source** spec §7 ("a validation error in sheet B does not delete sheet A's already-written output, but the process still exits non-zero and reports every failing sheet").

### CAMUNDA7-195: Duplicate decision id across two sheets

- **Given** sheets `A DMN` and `B DMN`, both with id `SAME`.
- **When** C0.
- **Then** **spec conflict.** §3 intro and §5 Step 1 say a duplicate decision id across sheets is a **hard error** ("they would overwrite each other — fix the `id` markers"). §6.4 says "suffix `_2`, `_3` … on collision" for ids across the repo. Expected (per the more specific §3/§5): exit `1`, with the error naming the duplicate id `SAME` and both sheets. Under no circumstances may one file silently overwrite the other.
- **Source** spec §3 intro, §5 Step 1, §6.4.

### CAMUNDA7-196: Config auto-loaded from `excel2dmn.config.json` in cwd

- **Given** W0, and `excel2dmn.config.json` in cwd = `{ "camunda": { "versionTag": "7.0" } }`.
- **When** C0 (no `--config`).
- **Then** `camunda:versionTag="7.0"`.
- **Source** spec §7.1 precedence, README Configuration.

### CAMUNDA7-197: `--config` beats the cwd config file

- **Given** CAMUNDA7-196 plus `cfg.json` = `{ "camunda": { "versionTag": "9.9" } }`.
- **When** C0 + `--config cfg.json`.
- **Then** `camunda:versionTag="9.9"`.
- **Source** spec §7.1 precedence.

### CAMUNDA7-198: Empty config file `{}` works out of the box

- **Given** W0 and `cfg.json` = `{}`.
- **When** C0 + `--config`.
- **Then** byte-identical to plain C0 output.
- **Source** spec §7.1 ("an **empty or absent config file works out of the box**").

### CAMUNDA7-199: Malformed config JSON fails clearly

- **Given** `cfg.json` = `{ not json`.
- **When** C0 + `--config cfg.json`.
- **Then** exit `1`; stderr names the config path and the parse failure; no `.dmn`.
- **Source** spec §7.1 ("validated … with clear errors").

### CAMUNDA7-200: Missing input workbook

- **When** `excel2dmn missing_DMN.xlsx --out-dir out`.
- **Then** exit `1`; stderr names the missing file; no stack trace. **Spec silent** on the wording.
- **Source** spec §7 (CLI).

### CAMUNDA7-201: Conversion errors exit non-zero without a stack trace

- **Given** any failing scenario above (e.g. CAMUNDA7-056).
- **Then** stderr holds the human-readable message(s), and no `at …(file:line)` stack frames.
- **Source** spec §5 ("abort with a human-readable error"). **Spec silent** on stack traces; reasonable expectation for a CLI.

---

## 17b. Programmatic API (Camunda 7 default)

### CAMUNDA7-202: `convert()` returns results with paths and no problems

- **Given** W0.
- **When** `await convert(xlsx, { config: loadConfig({ overrides: { output: { outDir } } }) })`.
- **Then** `problems` is `[]`; `results` has length 1 with `sheet: 'Base DMN'`, `decisionId: 'BASE'` and `path` ending in `BASE.dmn`; `results[0].xml` equals the file contents.
- **Source** README "Programmatic API".

### CAMUNDA7-203: `parseWorkbook` + `buildDmn` equals CLI output

- **Given** W0.
- **When** `const [m] = await parseWorkbook(xlsx, loadConfig({}))`; `const xml = await buildDmn(m, loadConfig({}))`.
- **Then** `xml` is byte-identical to the file written by C0.
- **Source** spec §5 / §6 (pure two-stage pipeline), README Programmatic API.

### CAMUNDA7-204: `loadConfig({})` defaults to camunda7 with P180D

- **When** `loadConfig({ cwd: emptyTmp })`.
- **Then** `platform === 'camunda7'`, `camunda.historyTimeToLive === 'P180D'`, `camunda.versionTag === null`, `types.nonCamundaTypeAction === 'error'`, `header.allowedValuesOffset === null`, and `rules.idTemplate === 'rule_<n>'`.
- **Source** spec §7.1 defaults, `excel2dmn.config.example.json`.
