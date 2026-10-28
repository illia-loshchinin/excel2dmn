# E2E scenarios — Camunda 8: Excel → DMN conversion

Area: converting decision-table workbooks to DMN 1.3 with `platform: "camunda8"`
(`--platform camunda8` or config), plus the programmatic `convert` / `buildDmn` /
`loadConfig` API for the same target.

Sources of truth, in order: `SOLUTION_SPEC.md` (cited as `§x.y`), `README.md`
(cited as `README: <section>`), `excel2dmn.config.example.json` (cited as
`example config`). Where none of them settles the expected result, the scenario is
flagged **spec silent** and states the most reasonable expectation.

Test-writer notes:

- Build every workbook in code with `writeWorkbook` + `decisionSheet` from
  `test/e2e/helpers.js`; never add binary fixtures.
- "Run the CLI" means `runCli([...args], { cwd: tmp.dir })`. A config file means a JSON
  file written into the temp dir and passed with `--config <file>`, unless the scenario
  says it is placed in cwd as `excel2dmn.config.json`.
- "Re-parses cleanly" means `parseDmn(xml)` resolves (dmn-moddle import with **0**
  warnings; the helper registers the `camunda` and `modeler` extensions).
- XML assertions on attributes of `<definitions>` / `<decision>` are on the raw XML
  string; structural assertions (ids, entries, typeRefs) are on the parsed tree via
  `firstTable(...)` where convenient.
- Message assertions use the stable fragments quoted below (case-insensitive regex is
  fine); do not assert the full wording unless the scenario quotes it as exact.

---

## Shared fixtures

### W-BASE — baseline workbook (`fees_DMN.xlsx`, sheet `Fees DMN`, 4-row layout)

| Col | Marker (row 1) | Name (row 2)   | Type (row 3) | Label (row 4) |
| --- | -------------- | -------------- | ------------ | ------------- |
| A   | `policy`       | `UNIQUE`       |              |               |
| B   | `ID`           | `FEES`         |              |               |
| C   | `name`         | `Fee Decision` |              |               |
| D   | `input`        | `amount`       | `integer`    | `Amount`      |
| E   | `input`        | `region`       | `string`     | `Region`      |
| F   | `output`       | `fee`          | `double`     | `Fee`         |
| G   | `output`       | `tier`         | `string`     | `Tier`        |
| H   | `annotations`  |                |              |               |

Rules (rows 5–6):

| Row | D (`amount`) | E (`region`) | F (`fee`) | G (`tier`) | H          |
| --- | ------------ | ------------ | --------- | ---------- | ---------- |
| 5   | `< 100`      | `"EU"`       | `1.5`     | `"LOW"`    | `small EU` |
| 6   | `>= 100`     | `-`          | `0`       | `"HIGH"`   | _(empty)_  |

Converting W-BASE with `--platform camunda8 --out-dir <tmp>` must produce
`<tmp>/FEES.dmn`.

### W-AV — W-BASE in the 5-row allowed-values layout

Same columns and rules as W-BASE, with an allowed-values row inserted between Type
and Label (config `ALLOWED_VALUES_LAYOUT`): `region` = `"EU","US"`,
`tier` = `"LOW","HIGH"`; the other columns blank. Rules start at row 6.

### W-TYPES — one input per FEEL type (sheet `Types DMN`, ID `TYPES`, policy column absent)

Inputs (name → type → rule-5 entry):
`n` `number` `>= 1.5`; `t` `time` `< time("10:00:00")`;
`dt` `dateTime` `< date and time("2026-01-01T00:00:00")`;
`dtd` `dayTimeDuration` `> duration("P1D")`;
`ymd` `yearMonthDuration` `<= duration("P1Y2M")`; `d` `date` `< date("2026-01-01")`;
`s` `string` `"A"`; `b` `boolean` `true`; `x` `Any` `-`.
One output `result` `string` = `"OK"`.

---

## A. Selecting the Camunda 8 platform

### CAMUNDA8-001 — `--platform camunda8` emits the modeler execution-platform metadata

- **Given** W-BASE and no config file in cwd.
- **When** `excel2dmn fees_DMN.xlsx --platform camunda8 --out-dir out`.
- **Then** exit code `0`; stdout contains `✓ Fees DMN →` and the path of `out/FEES.dmn`;
  stderr is empty; `out/` contains exactly `FEES.dmn`. The root element is
  `<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" …>` and carries
  `xmlns:modeler="http://camunda.org/schema/modeler/1.0"`,
  `modeler:executionPlatform="Camunda Cloud"` and
  `modeler:executionPlatformVersion="8.6.0"`. The file re-parses cleanly.
- **Spec:** §6.6 bullet 1 (attributes, default version `8.6.0`, modeler URI); README:
  Usage ("Target Camunda 8 instead of Camunda 7"); §7.1 `camunda8` defaults.

### CAMUNDA8-002 — `platform: "camunda8"` in a `--config` file selects Camunda 8

- **Given** W-BASE and `c8.json` = `{ "platform": "camunda8" }`.
- **When** `excel2dmn fees_DMN.xlsx --config c8.json --out-dir out`.
- **Then** exit `0`; `out/FEES.dmn` has the same bytes as the output of CAMUNDA8-001.
- **Spec:** §6.6 intro ("config or `--platform camunda8`"); §7.1 `platform`.

### CAMUNDA8-003 — `excel2dmn.config.json` in cwd selects Camunda 8

- **Given** W-BASE and `excel2dmn.config.json` = `{ "platform": "camunda8" }` in cwd;
  no `--config`.
- **When** `excel2dmn fees_DMN.xlsx --out-dir out` (run with that cwd).
- **Then** exit `0`; `out/FEES.dmn` contains `modeler:executionPlatform="Camunda Cloud"`
  and no `camunda:` attribute.
- **Spec:** §7.1 precedence ("`excel2dmn.config.json` in CWD"); README: Configuration.

### CAMUNDA8-004 — CLI flag beats config: `--platform camunda7` overrides config `camunda8`

- **Given** W-BASE and `c8.json` = `{ "platform": "camunda8" }`.
- **When** `excel2dmn fees_DMN.xlsx --config c8.json --platform camunda7 --out-dir out`.
- **Then** exit `0`; output is Camunda 7: contains `xmlns:camunda=` and
  `camunda:historyTimeToLive="P180D"`, contains no `modeler:` and no `xmlns:modeler`.
- **Spec:** §7.1 precedence "CLI flags → `--config` → …"; README: Configuration.

### CAMUNDA8-005 — CLI flag beats config: `--platform camunda8` overrides config `camunda7`

- **Given** W-BASE and `c7.json` = `{ "platform": "camunda7" }`.
- **When** `excel2dmn fees_DMN.xlsx --config c7.json --platform camunda8 --out-dir out`.
- **Then** exit `0`; output equals CAMUNDA8-001 byte for byte.
- **Spec:** §7.1 precedence.

### CAMUNDA8-006 — `--config` beats `./excel2dmn.config.json`

- **Given** W-BASE; cwd `excel2dmn.config.json` = `{ "platform": "camunda7" }`;
  `c8.json` = `{ "platform": "camunda8" }`.
- **When** `excel2dmn fees_DMN.xlsx --config c8.json --out-dir out`.
- **Then** exit `0`; output is Camunda 8 (has `modeler:executionPlatform`, no `camunda:`).
- **Spec:** §7.1 precedence.

### CAMUNDA8-007 — default platform is still Camunda 7

- **Given** W-BASE, no config, no `--platform`.
- **When** `excel2dmn fees_DMN.xlsx --out-dir out`.
- **Then** exit `0`; output has `camunda:historyTimeToLive="P180D"` on `<decision>`,
  `xmlns:camunda="http://camunda.org/schema/1.0/dmn"`, and no `modeler:` text at all.
- **Spec:** §6.6 intro ("default is `camunda7`"); §7.1 `platform` default; README
  feature list "Camunda 7 (default)".

### CAMUNDA8-008 — unknown `--platform` value is rejected

- **Given** W-BASE.
- **When** `excel2dmn fees_DMN.xlsx --platform camunda9 --out-dir out`.
- **Then** exit code non-zero; stderr names the bad value `camunda9` and the allowed
  choices `camunda7`, `camunda8`; no file is written in `out/`.
- **Spec:** spec silent on the error text; §7.1 documents only `"camunda7" | "camunda8"`.
  Reasonable expectation: argument rejected before any conversion.

### CAMUNDA8-009 — unknown `platform` in a config file is rejected

- **Given** W-BASE; `bad.json` = `{ "platform": "zeebe" }`.
- **When** `excel2dmn fees_DMN.xlsx --config bad.json --out-dir out`.
- **Then** exit `1`; stderr contains `platform` and `zeebe` (e.g.
  `Invalid platform 'zeebe' (expected 'camunda7' or 'camunda8')`); no `.dmn` written.
- **Spec:** §7.1 "validated … with clear errors at startup"; `platform` enum
  `"camunda7" | "camunda8"`. Exact wording spec silent.

### CAMUNDA8-010 — `platform` is case-sensitive (`"Camunda8"` rejected)

- **Given** W-BASE; config `{ "platform": "Camunda8" }`.
- **When** convert with `--config`.
- **Then** exit `1`; stderr names `Camunda8` as an invalid platform; no output.
- **Spec:** spec silent on casing. Reasonable expectation: the documented values are
  exact lower-case tokens, so other spellings are invalid rather than silently C7.

---

## B. `<definitions>` metadata and execution-platform version

### CAMUNDA8-011 — configured `camunda8.executionPlatformVersion` is emitted verbatim

- **Given** W-BASE; config `{ "platform": "camunda8", "camunda8": { "executionPlatformVersion": "8.7.0" } }`.
- **When** convert with `--config … --out-dir out`.
- **Then** exit `0`; `<definitions>` has `modeler:executionPlatformVersion="8.7.0"` and
  does not contain `8.6.0`; `modeler:executionPlatform="Camunda Cloud"` unchanged.
- **Spec:** §6.6 bullet 1 ("config `camunda8.executionPlatformVersion`"); §7.1 `camunda8`.

### CAMUNDA8-012 — version given via `--platform` + config file version only

- **Given** W-BASE; config `{ "camunda8": { "executionPlatformVersion": "8.5.1" } }`
  (no `platform` key).
- **When** `excel2dmn fees_DMN.xlsx --config cfg.json --platform camunda8 --out-dir out`.
- **Then** exit `0`; `modeler:executionPlatformVersion="8.5.1"`.
- **Spec:** §7.1 deep-merge of config + CLI overrides; §6.6.

### CAMUNDA8-013 — pre-release / non-numeric version strings pass through unchanged

- **Given** W-BASE; config `{ "platform": "camunda8", "camunda8": { "executionPlatformVersion": "8.8.0-alpha3" } }`.
- **When** convert.
- **Then** exit `0`; `modeler:executionPlatformVersion="8.8.0-alpha3"`; re-parses cleanly.
- **Spec:** spec silent on version format; §6.6 treats it as a config string. Reasonable
  expectation: emitted verbatim, no validation.

### CAMUNDA8-014 — `camunda8.executionPlatform` from config is honored

- **Given** W-BASE; config `{ "platform": "camunda8", "camunda8": { "executionPlatform": "Camunda Cloud" } }`
  versus the same with no `camunda8` key.
- **When** convert both.
- **Then** both outputs are byte-identical and carry `modeler:executionPlatform="Camunda Cloud"`.
- **Spec:** §7.1 `camunda8.executionPlatform` default `"Camunda Cloud"`; §6.6.

### CAMUNDA8-015 — Camunda 8 metadata sits on `<definitions>` only

- **Given** W-BASE.
- **When** convert with `--platform camunda8`.
- **Then** every occurrence of `modeler` appears only inside the opening `<definitions …>`
  tag (`xmlns:modeler` once, `modeler:executionPlatform` once,
  `modeler:executionPlatformVersion` once — i.e. two `modeler:` prefixes); `<decision>` has only `id` and `name` attributes.
- **Spec:** §6.6 bullets 1–2.

### CAMUNDA8-016 — standard `<definitions>` attributes are unchanged on C8

- **Given** W-BASE.
- **When** convert with `--platform camunda8`.
- **Then** `<definitions>` has `id="definitions_FEES"`, `name="Fee Decision"`,
  `namespace="http://camunda.org/schema/1.0/dmn"`,
  `expressionLanguage="https://www.omg.org/spec/DMN/20191111/FEEL/"` and
  `typeLanguage="https://www.omg.org/spec/DMN/20191111/FEEL/"`; root uses the default
  (unprefixed) MODEL namespace, with `xmlns:dmndi` and `xmlns:dc` as in §6.3; no
  `<dmn:` tag anywhere.
- **Spec:** §4.1 notes (definitions id/name), §6.1, §6.3 (namespace style), §6.6
  last two bullets ("post-process rewrites only `dmn:` tags"; "Everything else …
  identical").

### CAMUNDA8-017 — `--namespace` still applies on C8

- **Given** W-BASE.
- **When** `excel2dmn fees_DMN.xlsx --platform camunda8 --namespace https://example.com/dmn --out-dir out`.
- **Then** exit `0`; `<definitions … namespace="https://example.com/dmn" …>` and the
  modeler attributes are still present.
- **Spec:** §7 CLI `--namespace`; §7.1 "`--namespace` → `output.namespace`"; §6.6.

### CAMUNDA8-018 — `output.namespaceStyle: "prefixed"` keeps `dmn:` tags and modeler attrs

- **Given** W-BASE; config `{ "platform": "camunda8", "output": { "namespaceStyle": "prefixed" } }`.
- **When** convert.
- **Then** exit `0`; root is `<dmn:definitions xmlns:dmn="https://www.omg.org/spec/DMN/20191111/MODEL/" …>`;
  `xmlns:modeler` and `modeler:executionPlatform*` present; re-parses cleanly.
- **Spec:** §7.1 `output.namespaceStyle` ("toggles the §6.3 post-process"); §6.6.

---

## C. No Camunda 7 extensions on C8

### CAMUNDA8-019 — no `camunda:historyTimeToLive`, no `camunda:versionTag`, no `xmlns:camunda`

- **Given** W-BASE.
- **When** convert with `--platform camunda8`.
- **Then** XML contains none of `historyTimeToLive`, `versionTag`, `xmlns:camunda`,
  `camunda:`.
- **Spec:** §6.6 bullet 2.

### CAMUNDA8-020 — explicitly configured C7 extensions are still omitted on C8

- **Given** W-BASE; config
  `{ "platform": "camunda8", "camunda": { "historyTimeToLive": "P30D", "versionTag": "2.1" } }`.
- **When** convert.
- **Then** exit `0`; no `historyTimeToLive`, no `versionTag`, no `xmlns:camunda`, no
  `P30D`, no `2.1` attribute value in the XML; no warning required.
- **Spec:** §6.6 bullet 2 ("Omits … unsupported in Camunda 8 DMN").

### CAMUNDA8-021 — `xmlns:camunda` and `xmlns:modeler` never co-occur

- **Given** W-BASE.
- **When** convert once with `--platform camunda7`, once with `--platform camunda8`.
- **Then** C7 XML contains `xmlns:camunda` and not `xmlns:modeler`; C8 XML contains
  `xmlns:modeler` and not `xmlns:camunda`.
- **Spec:** §6.6 bullet 2 ("the two never co-occur").

### CAMUNDA8-022 — C7 output is unaffected by the existence of C8 settings

- **Given** W-BASE; config A = `{}`; config B =
  `{ "camunda8": { "executionPlatformVersion": "9.9.9" }, "types": { "camunda8NumericAlias": null } }`
  (platform left at the default).
- **When** convert W-BASE with A and with B.
- **Then** both `FEES.dmn` files are byte-identical C7 output.
- **Spec:** §6.6 bullet 2 ("Camunda 7 output stays byte-identical"); bullet 3 ("C7
  output is untouched"); §7.1 `camunda8` "used when platform === camunda8".

---

## D. Types on Camunda 8

### CAMUNDA8-023 — the full DMN/FEEL type set is accepted with no error or warning

- **Given** W-TYPES; default config.
- **When** `excel2dmn types_DMN.xlsx --platform camunda8 --out-dir out`.
- **Then** exit `0`; stderr empty (no "not a Camunda type" text); `out/TYPES.dmn`
  has input typeRefs in order `number`, `time`, `dateTime`, `dayTimeDuration`,
  `yearMonthDuration`, `date`, `string`, `boolean`, and the `x` input has **no**
  `typeRef` attribute; output `result` has `typeRef="string"`; re-parses cleanly.
- **Spec:** §6.6 bullet 3 (relaxes `types.camundaTypes`; full set "pass without
  warning"); README: The sheet template, Type row; §4.1 note on `Any` (omit typeRef).

### CAMUNDA8-024 — the same W-TYPES workbook is rejected under Camunda 7

- **Given** W-TYPES.
- **When** convert with no `--platform`.
- **Then** exit `1`; stderr reports each of `number`, `time`, `dateTime`,
  `dayTimeDuration`, `yearMonthDuration` with `not a Camunda type` and its type-row
  cell (`Types DMN!A3`, `Types DMN!B3`, …); `date`, `string`, `boolean`, `Any` are not
  reported; no `TYPES.dmn` written.
- **Spec:** §3.1 Type row ("rejected by default"); §7.1 `types.nonCamundaTypeAction:
"error"`; §6.6 bullet 3 (contrast). Collect-all: §5 Step 2 "report them together".

### CAMUNDA8-025 — C8 relaxation applies even when `nonCamundaTypeAction` is `"error"`

- **Given** a sheet with a single `number` input; config
  `{ "platform": "camunda8", "types": { "nonCamundaTypeAction": "error" } }`.
- **When** convert.
- **Then** exit `0`; `typeRef="number"` emitted.
- **Spec:** §6.6 bullet 3 (relaxes the restriction on C8).

### CAMUNDA8-026 — each FEEL type individually, input side (one scenario per type)

Parametrised over `number`, `time`, `dateTime`, `dayTimeDuration`,
`yearMonthDuration`, `date`, `string`, `boolean`, `Any`.

- **Given** a sheet with one input `v` of the given type (a valid entry from W-TYPES)
  and one `string` output.
- **When** convert with `--platform camunda8`.
- **Then** exit `0`; `<inputExpression id="v_expression" typeRef="<type>">` (no
  `typeRef` for `Any`); entry text preserved verbatim in `<inputEntry id="v_1"><text>`.
- **Spec:** §6.6 bullet 3; §3b input table; §6.1 `typeRef` handling.

### CAMUNDA8-027 — each FEEL type individually, output side

Parametrised over `number` (`42`), `time` (`time("10:00:00")`), `dateTime`
(`date and time("2026-01-01T00:00:00")`), `dayTimeDuration` (`duration("PT2H")`),
`yearMonthDuration` (`duration("P1Y")`), `date` (`date("2026-01-01")`), `string`
(`"X"`), `boolean` (`false`), `Any` (`[1,2]`).

- **Given** a sheet with one `string` input (`"A"`) and one output `o` of the type.
- **When** convert with `--platform camunda8`.
- **Then** exit `0`; `<output id="o" name="o" typeRef="<type>">` (no `typeRef` for
  `Any`); `<outputEntry id="o_1"><text>` holds the cell text verbatim, unquoted for
  non-string types.
- **Spec:** §3b OUTPUT entries; §6.6 bullet 3.

### CAMUNDA8-028 — untyped aliases `any` / `none` / `object` / `Object` on C8

- **Given** four inputs typed `any`, `none`, `object`, `Object`.
- **When** convert with `--platform camunda8`.
- **Then** exit `0`; none of the four inputExpressions carries a `typeRef` attribute.
- **Spec:** §3.1 Type row (aliases, any casing); §4.1 notes; §7.1 `types.anyAliases`.

### CAMUNDA8-029 — `types.anyDmnPlaceholder` on C8

- **Given** a sheet with an `Any` input; config
  `{ "platform": "camunda8", "types": { "anyDmnPlaceholder": "Any" } }`.
- **When** convert.
- **Then** exit `0`; the input has `typeRef="Any"` (not rewritten by the numeric alias).
- **Spec:** §4.1 note on `anyDmnPlaceholder`; §6.1 typeRef handling.

### CAMUNDA8-030 — unknown typeRef is still rejected on C8

- **Given** a sheet whose output `fee` (column F) has type `float`.
- **When** convert with `--platform camunda8`.
- **Then** exit `1`; stderr contains `Unknown typeRef 'float'` (case-insensitive match
  on `unknown typeRef`) and the cell `<Sheet>!F3`; no `.dmn` written.
- **Spec:** §5 Step 2 ("every `typeRef` ∈ `types.allowed`"); §6.6 relaxes only the
  Camunda-type subset, not `types.allowed`.

### CAMUNDA8-031 — type names are case-sensitive except the Any aliases

- **Given** a sheet with input type `Number` (capital N).
- **When** convert with `--platform camunda8`.
- **Then** exit `1`; unknown-typeRef error at the type cell.
- **Spec:** spec silent on casing of non-Any types. Reasonable expectation: only the
  Any aliases are documented as "any casing" (§3.1), so `Number` ∉ `types.allowed`.

### CAMUNDA8-032 — missing typeRef still fails on C8 with a cell coordinate

- **Given** W-BASE with cell `E3` (type of `region`) blank.
- **When** convert with `--platform camunda8`.
- **Then** exit `1`; stderr contains `Fees DMN!E3` and `typeRef` and `region`.
- **Spec:** §5 Step 2 (missing typeRef ⇒ error naming the cell).

---

## E. C7 numeric types normalized to `number`

### CAMUNDA8-033 — `integer` input becomes `number`

- **Given** W-BASE (`amount` is `integer`).
- **When** convert with `--platform camunda8`.
- **Then** `<inputExpression id="amount_expression" typeRef="number">`; no
  `typeRef="integer"` anywhere.
- **Spec:** §6.6 bullet 3; §7.1 / example config `types.camunda8NumericAlias: "number"`.

### CAMUNDA8-034 — `double` output becomes `number`

- **Given** W-BASE (`fee` is `double`).
- **When** convert with `--platform camunda8`.
- **Then** `<output>` for `fee` has attributes `id="fee" name="fee" label="Fee"
typeRef="number"` (attribute order is serializer-defined; compare as a set); no
  `typeRef="double"`.
- **Spec:** §6.6 bullet 3.

### CAMUNDA8-035 — `long` (input and output) becomes `number`

- **Given** a sheet with input `count:long` and output `total:long`.
- **When** convert with `--platform camunda8`.
- **Then** both carry `typeRef="number"`; no `typeRef="long"`.
- **Spec:** §6.6 bullet 3.

### CAMUNDA8-036 — native `number` stays `number`

- **Given** a sheet with input `n:number`.
- **When** convert with `--platform camunda8`.
- **Then** `typeRef="number"`.
- **Spec:** §6.6 bullet 3.

### CAMUNDA8-037 — non-numeric types are never aliased

- **Given** W-TYPES plus an `integer` input.
- **When** convert with `--platform camunda8`.
- **Then** only the `integer` input changes to `number`; `string`, `boolean`, `date`,
  `time`, `dateTime`, durations keep their typeRef.
- **Spec:** §6.6 bullet 3 (only "C7-only numeric typeRefs").

### CAMUNDA8-038 — `camunda8NumericAlias: null` opts out

- **Given** W-BASE; config `{ "platform": "camunda8", "types": { "camunda8NumericAlias": null } }`.
- **When** convert.
- **Then** exit `0`; `amount` keeps `typeRef="integer"`, `fee` keeps `typeRef="double"`;
  modeler metadata still present.
- **Spec:** §6.6 bullet 3 ("set to `null` to emit them unchanged").

### CAMUNDA8-039 — custom alias value

- **Given** W-BASE; config `{ "platform": "camunda8", "types": { "camunda8NumericAlias": "double" } }`.
- **When** convert.
- **Then** `amount` (integer) → `typeRef="double"`; `fee` (already `double`) stays
  `double`.
- **Spec:** §6.6 bullet 3 names the key with "default `number`", implying other values;
  exact behavior for non-default values is **spec silent**. Reasonable expectation:
  every C7 numeric type in `types.numeric` other than the alias is rewritten to the alias.

### CAMUNDA8-040 — numeric validation still uses the authored type on C8

- **Given** W-BASE with `D5` (`amount`, integer) = `"100"` (quoted string).
- **When** convert with `--platform camunda8`.
- **Then** exit `1`; stderr contains `Fees DMN!D5` and `amount`; no `.dmn`.
- **Spec:** §3b input table (numeric types reject `StringLiteral`); §6.6 bullet 3
  normalizes only the emitted typeRef.

### CAMUNDA8-041 — decimals accepted in an `integer` column (validated as numeric)

- **Given** W-BASE with `D5` = `< 99.5`.
- **When** convert with `--platform camunda8`.
- **Then** exit `0`; `<inputEntry id="amount_1"><text>&lt; 99.5</text>` and
  `typeRef="number"`.
- **Spec:** §3b ("integers and decimals … all validated identically").

### CAMUNDA8-042 — `--json` model keeps the authored typeRef

- **Given** W-BASE.
- **When** `excel2dmn fees_DMN.xlsx --platform camunda8 --out-dir out --json`.
- **Then** exit `0`; `out/FEES.dmn` and `out/FEES.model.json` exist; the model JSON has
  `inputs[0].typeRef === "integer"` and `outputs[0].typeRef === "double"`, and no
  `__platform`/`__sheet`/`__warnings` keys; the DMN has `typeRef="number"`.
- **Spec:** spec silent on whether normalization happens in the model. Reasonable
  expectation from §6.6 ("normalized … on C8 output") and §4 (the model is the
  platform-neutral Excel contract): the model stays as authored.

### CAMUNDA8-043 — `--json` model is identical for C7 and C8

- **Given** W-BASE.
- **When** convert with `--json` once for C7 (dir `c7/`) and once for C8 (dir `c8/`).
- **Then** `c7/FEES.model.json` and `c8/FEES.model.json` are byte-identical.
- **Spec:** spec silent; follows from CAMUNDA8-042 and §4 (model is the Stage A
  output; platform only affects Stage B).

---

## F. Hit policies

### CAMUNDA8-044 — `UNIQUE` (sheet) → no `hitPolicy` attribute

- **Given** W-BASE (`A2` = `UNIQUE`).
- **When** convert with `--platform camunda8`.
- **Then** exit `0`; `<decisionTable id="FEES_decisionTable" preferredOrientation="Rule-as-Row">`
  with no `hitPolicy` attribute.
- **Spec:** §6.1 note ("UNIQUE … moddle OMITS it"); §6.4 hit policy bullet; §6.6 bullet 4.

### CAMUNDA8-045 — `FIRST`, `ANY`, `RULE ORDER` from the sheet (one scenario each)

- **Given** W-BASE with `A2` set to the policy.
- **When** convert with `--platform camunda8`.
- **Then** exit `0`; `<decisionTable … hitPolicy="<POLICY>">` (e.g.
  `hitPolicy="RULE ORDER"`); no `aggregation` attribute.
- **Spec:** §3.4 accepted values; §6.6 bullet 4 (C8 supports UNIQUE/ANY/FIRST/RULE
  ORDER/COLLECT).

### CAMUNDA8-046 — `COLLECT` without aggregator

- **Given** W-BASE with `A2` = `COLLECT`, `A3` empty.
- **When** convert with `--platform camunda8`.
- **Then** exit `0`; `hitPolicy="COLLECT"` and no `aggregation` attribute.
- **Spec:** §3.4 (aggregator optional); §6.6 bullet 4.

### CAMUNDA8-047 — `COLLECT` with each aggregator `SUM` / `MIN` / `MAX` / `COUNT`

- **Given** W-BASE with only `fee` as output (drop `tier`), `A2` = `COLLECT`, `A3` =
  aggregator.
- **When** convert with `--platform camunda8`.
- **Then** exit `0`; `<decisionTable … hitPolicy="COLLECT" aggregation="<AGG>">`.
- **Spec:** §3.4 ("optional aggregator at row M+2: SUM, MIN, MAX, COUNT"); §6.1
  `aggregation?`; §6.6 bullet 4.

### CAMUNDA8-048 — lower-case policy value in the sheet is normalized

- **Given** W-BASE with `A2` = `rule order`.
- **When** convert with `--platform camunda8`.
- **Then** exit `0`; `hitPolicy="RULE ORDER"`.
- **Spec:** spec silent on policy-value casing (§3.4 lists upper-case DMN values).
  Reasonable expectation: case-insensitive like markers, emitted in DMN upper case.

### CAMUNDA8-049 — `PRIORITY` in the sheet is rejected on C8

- **Given** W-AV with `A2` = `PRIORITY` and, in addition, `fee` allowed values `1.5,0`
  (§5 Step 2: _every_ output needs allowed values for PRIORITY/OUTPUT ORDER, so the
  workbook is valid on C7).
- **When** convert with `--platform camunda8` and `--config` = `ALLOWED_VALUES_LAYOUT`.
- **Then** exit `1`; stderr contains `PRIORITY` and `not supported by Camunda 8`; no
  `FEES.dmn` written.
- **Spec:** §6.6 bullet 4 ("Rejects … with a conversion error").

### CAMUNDA8-050 — `OUTPUT ORDER` in the sheet is rejected on C8

- **Given** the workbook of CAMUNDA8-049 with `A2` = `OUTPUT ORDER`.
- **When** convert as in CAMUNDA8-049.
- **Then** exit `1`; stderr contains `OUTPUT ORDER` and `not supported by Camunda 8`;
  no output file.
- **Spec:** §6.6 bullet 4.

### CAMUNDA8-051 — the same PRIORITY workbook converts on C7

- **Given** the workbook of CAMUNDA8-049.
- **When** convert with `--platform camunda7` (same layout config).
- **Then** exit `0`; `hitPolicy="PRIORITY"`; `<outputValues><text>"LOW","HIGH"</text>`.
- **Spec:** §3.4; §3.6 (PRIORITY requires output values); §6.6 (rejection is C8-only).

### CAMUNDA8-052 — lower-case `priority` / `output order` in the sheet are also rejected on C8

- **Given** the workbook of CAMUNDA8-049 with `A2` = `priority` (and separately `output order`).
- **When** convert with `--platform camunda8`.
- **Then** exit `1`; stderr contains `not supported by Camunda 8`.
- **Spec:** §6.6 bullet 4; casing spec silent (see CAMUNDA8-048).

### CAMUNDA8-053 — PRIORITY without allowed values on C8 reports the C8 error

- **Given** W-BASE (4-row layout, no allowed values) with `A2` = `PRIORITY`.
- **When** convert with `--platform camunda8`.
- **Then** exit `1`; stderr contains `not supported by Camunda 8`.
- **Spec:** §6.6 bullet 4. Whether the "requires output allowed values" error is also
  listed is **spec silent**; tests must not assert its presence or absence.

### CAMUNDA8-054 — `--hit-policy` fallback with a supported policy

- **Given** W-BASE with the `policy` column (A) removed.
- **When** `excel2dmn fees_DMN.xlsx --platform camunda8 --hit-policy FIRST --out-dir out`.
- **Then** exit `0`; `hitPolicy="FIRST"`.
- **Spec:** §3.4 resolution order (2. `--hit-policy`); §7.1 "`--hit-policy` →
  `hitPolicy.default`".

### CAMUNDA8-055 — sheet `policy` beats `--hit-policy`

- **Given** W-BASE (`A2` = `UNIQUE`).
- **When** convert with `--platform camunda8 --hit-policy COLLECT`.
- **Then** exit `0`; no `hitPolicy` attribute (UNIQUE wins).
- **Spec:** §3.4 resolution order (1. policy column).

### CAMUNDA8-056 — `--hit-policy PRIORITY` with `--platform camunda8` is rejected at startup

- **Given** W-BASE with no policy column.
- **When** `excel2dmn fees_DMN.xlsx --platform camunda8 --hit-policy PRIORITY --out-dir out`.
- **Then** exit `1`; stderr contains `hitPolicy.default`, `PRIORITY` and
  `not supported by Camunda 8`; no `.dmn` written; stdout has no `✓` line.
- **Spec:** §6.6 bullet 4; §7.1 `--hit-policy` maps to `hitPolicy.default`, config
  validated at startup. The requirement that `loadConfig` rejects it is from the task
  scope; spec wording silent.

### CAMUNDA8-057 — config `hitPolicy.default: "OUTPUT ORDER"` + `platform: "camunda8"` is rejected

- **Given** W-BASE; config `{ "platform": "camunda8", "hitPolicy": { "default": "OUTPUT ORDER" } }`.
- **When** convert with `--config`.
- **Then** exit `1`; stderr contains `OUTPUT ORDER` and `not supported by Camunda 8`;
  no `.dmn`.
- **Spec:** as CAMUNDA8-056.

### CAMUNDA8-058 — the startup rejection happens even if every sheet has its own policy

- **Given** W-BASE (`A2` = `UNIQUE`); config `{ "hitPolicy": { "default": "priority" } }`.
- **When** convert with `--config … --platform camunda8`.
- **Then** exit `1`; stderr contains `not supported by Camunda 8`; no `.dmn`.
- **Spec:** spec silent on whether an unused fallback should block. Reasonable
  expectation (task scope): the config itself is invalid for C8 and is rejected at load,
  case-insensitively.

### CAMUNDA8-059 — the same `hitPolicy.default: "PRIORITY"` config is fine on C7

- **Given** W-BASE; config `{ "hitPolicy": { "default": "PRIORITY" } }`.
- **When** convert without `--platform`.
- **Then** exit `0` (the sheet's own `UNIQUE` applies).
- **Spec:** §3.4; §7.1 (`PRIORITY` is an allowed default); §6.6 rejection is C8-only.

### CAMUNDA8-060 — unknown hit policy still reported on C8

- **Given** W-BASE with `A2` = `HIGHEST`.
- **When** convert with `--platform camunda8`.
- **Then** exit `1`; stderr contains `HIGHEST` and `hit policy`; no output.
- **Spec:** §3.4 accepted values; §7.1 `hitPolicy.allowed`.

---

## G. Programmatic API (same contract without the CLI)

### CAMUNDA8-061 — `convert()` with a C8 config writes C8 DMN

- **Given** W-BASE; `cfg = loadConfig({ overrides: { platform: 'camunda8', output: { outDir: tmp } } })`.
- **When** `await convert(xlsx, { config: cfg })`.
- **Then** `problems` is `[]`; `results.length === 1`; `results[0].decisionId === 'FEES'`;
  `results[0].xml` equals the bytes written to `results[0].path`, which equal the CLI
  output of CAMUNDA8-001.
- **Spec:** README: Programmatic API; §6.6.

### CAMUNDA8-062 — `buildDmn` rejects `PRIORITY` on C8 for a hand-built model

- **Given** the model parsed from W-BASE under C8, then `decisions[0].hitPolicy = 'PRIORITY'`.
- **When** `await buildDmn(model, loadConfig({ overrides: { platform: 'camunda8' } }))`.
- **Then** the promise rejects with a `ConversionError` whose message contains
  `PRIORITY` and `not supported by Camunda 8`.
- **Spec:** §6.6 bullet 4 (rejection is a conversion error irrespective of source);
  README: Programmatic API (`buildDmn` builds for the config's platform).

### CAMUNDA8-063 — `buildDmn` rejects `OUTPUT ORDER` on C8

- **Given/When** as CAMUNDA8-062 with `hitPolicy = 'OUTPUT ORDER'` (also with
  `'output order'`).
- **Then** rejects with `ConversionError` mentioning `not supported by Camunda 8`.
- **Spec:** §6.6 bullet 4.

### CAMUNDA8-064 — the same PRIORITY model builds on C7

- **Given** the model of CAMUNDA8-062 (with output allowed values set).
- **When** `buildDmn(model, loadConfig({}))`.
- **Then** resolves; XML contains `hitPolicy="PRIORITY"` and `camunda:historyTimeToLive`.
- **Spec:** §6.6 (C8-only rejection); §6.5.

### CAMUNDA8-065 — `loadConfig` throws for C8 + PRIORITY/OUTPUT ORDER default

- **Given** nothing.
- **When** `loadConfig({ overrides: { platform: 'camunda8', hitPolicy: { default: P } } })`
  for `P` ∈ `PRIORITY`, `OUTPUT ORDER`, `priority`.
- **Then** throws an `Error` whose message contains `not supported by Camunda 8`;
  with `platform: 'camunda7'` the same call returns a config.
- **Spec:** task scope; §6.6 bullet 4; §7.1 startup validation.

### CAMUNDA8-066 — `loadConfig` throws for an unknown platform

- **When** `loadConfig({ overrides: { platform: 'camunda6' } })`.
- **Then** throws, message mentions `camunda6`.
- **Spec:** §7.1 (`"camunda7" | "camunda8"`, validated at startup).

### CAMUNDA8-067 — `buildDmn` follows the config, not the model origin

- **Given** `[model] = await dmnToModels(<C7 XML of W-BASE>, loadConfig({}))`.
- **When** `buildDmn(model, loadConfig({ overrides: { platform: 'camunda8' } }))`.
- **Then** output equals the C8 output of W-BASE (CAMUNDA8-001) byte for byte.
- **Spec:** README: Programmatic API ("`buildDmn` always builds for the platform in the
  config you pass — it never switches on its own").

### CAMUNDA8-068 — `parseWorkbook` under C8 does not flag C8 types; under C7 it throws

- **Given** W-TYPES.
- **When** `parseWorkbook(xlsx, c8cfg)` and `parseWorkbook(xlsx, loadConfig({}))`.
- **Then** C8: resolves, `model.__warnings` has no `Camunda type` entry; C7: rejects
  with `not a Camunda type`.
- **Spec:** §6.6 bullet 3; §3.1.

---

## H. Allowed values, annotations, multiple inputs/outputs

### CAMUNDA8-069 — allowed values become `<inputValues>` / `<outputValues>` on C8

- **Given** W-AV; config `{ "platform": "camunda8", ...ALLOWED_VALUES_LAYOUT }`.
- **When** convert.
- **Then** exit `0`; `region` input has `<inputValues><text>"EU","US"</text></inputValues>`
  (no id on `inputValues`); `tier` output has
  `<outputValues><text>"LOW","HIGH"</text></outputValues>`; `amount`/`fee` have none;
  rules are read from row 6 (`rule_1` = Excel row 6).
- **Spec:** §3.6; §6.1 inputs/outputs bullets; §3.1 offsets table.

### CAMUNDA8-070 — numeric allowed values on a C7 numeric column under C8

- **Given** W-AV with `amount` allowed values `[0..1000]`.
- **When** convert for C8.
- **Then** exit `0`; `amount` has `typeRef="number"` and `<inputValues><text>[0..1000]</text>`.
- **Spec:** §3.6 (`[0..100]` for number); §6.6 bullet 3.

### CAMUNDA8-071 — allowed values for C8-only types (`time`, `date`)

- **Given** a 5-row sheet with input `t:time` allowed `time("08:00:00"),time("17:00:00")`.
- **When** convert for C8.
- **Then** exit `0`; `<inputValues><text>time("08:00:00"),time("17:00:00")</text>`.
- **Spec:** §3.6 / §3b (syntax-only types: syntax check only); §6.6.

### CAMUNDA8-072 — invalid allowed values list reported with coordinate on C8

- **Given** W-AV with `region` allowed values `EU,US` (unquoted) in `E4`.
- **When** convert for C8.
- **Then** exit `1`; stderr contains `Fees DMN!E4` and `allowed values`.
- **Spec:** §3.6 Validation; §3b allowed-values checks.

### CAMUNDA8-073 — `enforceAllowedValues` on C8

- **Given** W-AV, rule row 6 `region` = `"APAC"`; config adds
  `{ "validation": { "enforceAllowedValues": true } }`.
- **When** convert for C8.
- **Then** exit `1`; stderr names `Fees DMN!E6` and `"APAC"` (out of domain). With
  `enforceAllowedValues: false` (default) the same workbook converts with exit `0`.
- **Spec:** §3.6 last para; §3b allowed-values checks; §7.1. (If the implementation has
  no domain check yet, this is a gap to fix.)

### CAMUNDA8-074 — annotations become `<description>` first inside `<rule>`

- **Given** W-BASE.
- **When** convert for C8.
- **Then** `<rule id="rule_1">` has first child `<description>small EU</description>`;
  `<rule id="rule_2">` has no `<description>`.
- **Spec:** §3.2 `annotations`; §6.1 rules bullet; §6.4 annotation bullet.

### CAMUNDA8-075 — multiple annotation columns joined with the separator

- **Given** W-BASE plus a second `annotations` column I with `I5` = `reviewed`.
- **When** convert for C8.
- **Then** `rule_1` description is `small EU | reviewed`.
- **Spec:** §3.2; §7.1 `markers.annotationSeparator`.

### CAMUNDA8-076 — annotation text is not FEEL-validated or quoted on C8

- **Given** W-BASE with `H5` = `if x < 5 then "a"` (and an `&` / `<` character).
- **When** convert for C8.
- **Then** exit `0`; description round-trips XML-escaped and verbatim after parse.
- **Spec:** §3.2 ("Not FEEL-validated, not quoted"); §3b.

### CAMUNDA8-077 — multiple inputs and outputs keep left-to-right order and readable ids

- **Given** W-BASE.
- **When** convert for C8.
- **Then** inputs in order `amount`, `region`; outputs `fee`, `tier`; ids:
  `FEES_decisionTable`, `amount`, `amount_expression`, `region`, `region_expression`,
  `fee`, `tier`, `rule_1`, `rule_2`, `amount_1`, `region_1`, `fee_1`, `tier_1`,
  `amount_2`, …; `DMNDiagram_FEES`, `DMNShape_FEES` with `dmnElementRef="FEES"`.
- **Spec:** §3.2 (column order preserved); §6.4 id table; §6.2.

### CAMUNDA8-078 — helper columns ignored on C8

- **Given** W-BASE with a column `No.` (marker blank) and a column whose marker is
  `NOT PART OF DMN`, both filled on every row.
- **When** convert for C8.
- **Then** output is byte-identical to CAMUNDA8-001.
- **Spec:** §3.2 helper bullet; §5 Step 3.

### CAMUNDA8-079 — `-` and empty input cells become `<text></text>`

- **Given** W-BASE (`E6` = `-`) plus a variant with `E6` empty.
- **When** convert both for C8.
- **Then** `<inputEntry id="region_2"><text></text></inputEntry>` in both; outputs
  byte-identical.
- **Spec:** §3.3 input cell bullet; §4.1 notes.

### CAMUNDA8-080 — zero-input table on C8

- **Given** a sheet with only `ID`, one `output` `result:string` and rule `"X"`.
- **When** convert for C8.
- **Then** exit `0`; DMN has no `<input>`, one `<output>`, one rule; re-parses cleanly.
  A warning may be printed.
- **Spec:** §5 Step 2 ("Zero `input` columns is allowed … warn but continue").

### CAMUNDA8-081 — DMNDI shape on C8

- **Given** W-BASE.
- **When** convert for C8.
- **Then** one `dmndi:DMNDiagram id="DMNDiagram_FEES"` with one
  `dmndi:DMNShape id="DMNShape_FEES" dmnElementRef="FEES"` and
  `dc:Bounds` with `x="160" y="100" width="180" height="80"` (any attribute order).
- **Spec:** §6.2; example config `output.shape`; §6.6 last bullet.

---

## I. Determinism and C7 vs C8 differences

### CAMUNDA8-082 — byte-stable output on repeat runs

- **Given** W-BASE.
- **When** convert for C8 twice into two different out dirs.
- **Then** the two `FEES.dmn` files are byte-identical.
- **Spec:** §6.4 ("byte-identical XML"); README feature list "byte-stable output".

### CAMUNDA8-083 — byte-stable regardless of how C8 is selected

- **Given** W-BASE.
- **When** convert via `--platform camunda8`, via `--config`, via cwd config, and via
  the programmatic `convert`.
- **Then** all four `FEES.dmn` files are byte-identical.
- **Spec:** §6.4; §7.1 (config sources are equivalent after merge).

### CAMUNDA8-084 — C7 vs C8 differ only in the expected places

- **Given** W-BASE.
- **When** convert to `c7/FEES.dmn` (default) and `c8/FEES.dmn` (`--platform camunda8`).
- **Then** after applying these normalizations to the C7 text, it equals the C8 text
  exactly:
  1. remove ` xmlns:camunda="http://camunda.org/schema/1.0/dmn"` from `<definitions>`;
  2. remove ` camunda:historyTimeToLive="P180D"` from `<decision>`;
  3. replace `typeRef="integer"` / `typeRef="long"` / `typeRef="double"` with
     `typeRef="number"`;
  4. insert ` xmlns:modeler="http://camunda.org/schema/modeler/1.0"` and
     ` modeler:executionPlatform="Camunda Cloud" modeler:executionPlatformVersion="8.6.0"`
     on `<definitions>`.
     Equivalent tree check: ids, labels, rule/entry texts, descriptions, hit policy and
     DMNDI are identical in both parsed trees.
- **Spec:** §6.6 (bullets 1–3 list the differences; last bullet "Everything else …
  identical"). Attribute placement order inside the start tag is spec silent; compare
  with an order-insensitive attribute set if the literal approach is too brittle.

### CAMUNDA8-085 — with `camunda8NumericAlias: null` the only differences are the metadata

- **Given** W-BASE; both runs use `types.camunda8NumericAlias: null`.
- **When** convert for C7 and C8.
- **Then** differences are only items 1, 2 and 4 of CAMUNDA8-084; typeRefs identical.
- **Spec:** §6.6 bullets 1–3.

### CAMUNDA8-086 — with `versionTag` configured, it shows up only in C7

- **Given** W-BASE; config `{ "camunda": { "versionTag": "1.0" } }`.
- **When** convert for C7 and for C8 (`--platform camunda8`).
- **Then** C7 has `camunda:versionTag="1.0"`; C8 has no `versionTag`.
- **Spec:** §6.5; §6.6 bullet 2.

### CAMUNDA8-087 — `--no-pretty` on C8

- **Given** W-BASE.
- **When** convert with `--platform camunda8 --no-pretty`.
- **Then** exit `0`; XML has no newline-indented child elements (single line after
  the XML declaration), still contains the modeler attributes, and re-parses to the same
  tree as the pretty output.
- **Spec:** §7 `--pretty` / §7.1 `output.format`; §6.6. Exact whitespace spec silent.

---

## J. FEEL validation on C8 (errors as `Sheet!Cell`)

### CAMUNDA8-088 — unquoted string input reported with its cell

- **Given** W-BASE with `E5` = `EU` (no quotes).
- **When** convert for C8.
- **Then** exit `1`; stderr contains `✗ Fees DMN:`, `Fees DMN!E5`, `region`, and the
  quote hint `"EU"`; no `FEES.dmn` written.
- **Spec:** §3b (string inputs require quotes; example message); §5 coordinate-anchored
  errors; README feature "precise `Sheet!Cell` errors".

### CAMUNDA8-089 — FEEL syntax error in a `dateTime` input

- **Given** W-TYPES with the `dt` cell (`C5`) = `< date and time(`.
- **When** convert for C8.
- **Then** exit `1`; stderr contains `Types DMN!C5` and `dt` and indicates invalid FEEL.
- **Spec:** §3b (syntax-only types reject syntax errors).

### CAMUNDA8-090 — syntax-only types accept any well-formed FEEL (no literal-kind check)

- **Given** W-TYPES with `t` = `"10:00"` (a string literal in a `time` column).
- **When** convert for C8.
- **Then** exit `0`.
- **Spec:** §3b table row for syntax-only types ("no literal-kind enforcement").

### CAMUNDA8-091 — unquoted string output reported; `autoQuote` fixes it

- **Given** W-BASE with `G5` = `LOW`.
- **When** convert for C8; then again with config `{ "outputEntries": { "autoQuote": true } }`.
- **Then** first: exit `1`, stderr has `Fees DMN!G5` and `tier` and "quoted string";
  second: exit `0`, `<outputEntry id="tier_1"><text>"LOW"</text>`.
- **Spec:** §3b OUTPUT entries; §7.1 `outputEntries`.

### CAMUNDA8-092 — boolean column rejects non-boolean on C8

- **Given** a sheet with `isMember:boolean` input, `D5` = `"true"`.
- **When** convert for C8.
- **Then** exit `1`; stderr has the cell and `true or false`.
- **Spec:** §3b boolean row.

### CAMUNDA8-093 — numeric output with a string value rejected (C7 numeric type, C8 target)

- **Given** W-BASE with `F5` = `"1.5"`.
- **When** convert for C8.
- **Then** exit `1`; stderr has `Fees DMN!F5` and `fee`.
- **Spec:** §3b OUTPUT entries (validated per type).

### CAMUNDA8-094 — all errors collected and reported together

- **Given** W-BASE with `E5` = `EU`, `G6` = `HIGH`, and `D6` = `"x"`.
- **When** convert for C8.
- **Then** exit `1`; stderr lists all three cells `E5`, `G6`, `D6` in one report.
- **Spec:** §3b "Collect all validation problems and report them together"; §7.1
  `validation.feel.failFast: false`.

### CAMUNDA8-095 — `validation.feel.mode: "off"` on C8

- **Given** W-BASE with `E5` = `EU`.
- **When** convert for C8 with config `{ "validation": { "feel": { "mode": "off" } } }`.
- **Then** exit `0`; `<text>EU</text>` emitted verbatim.
- **Spec:** §3b / §7.1 `validation.feel.mode`. (Output quote rule is independent and not
  exercised here.)

### CAMUNDA8-096 — `--validate-only` on C8

- **Given** W-TYPES (valid for C8 only).
- **When** `excel2dmn types_DMN.xlsx --platform camunda8 --validate-only --out-dir out`.
- **Then** exit `0`; stdout `✓ Types DMN → TYPES (valid)`; `out/` is empty or absent.
  The same command without `--platform` exits `1` with `not a Camunda type`.
- **Spec:** §7 `--validate-only`; §6.6 bullet 3.

### CAMUNDA8-097 — `--validate-only` catches PRIORITY on C8

- **Given** the workbook of CAMUNDA8-049.
- **When** convert with `--platform camunda8 --validate-only`.
- **Then** exit `1`; stderr contains `not supported by Camunda 8`; no file written.
- **Spec:** §7 `--validate-only` (parse + validate); §6.6 bullet 4. Spec silent on
  whether this check runs in validate-only; reasonable expectation: yes, since it is a
  conversion error a CI gate should catch.

---

## K. Multi-sheet, output paths and partial failures

### CAMUNDA8-098 — multi-sheet workbook → one C8 file per sheet

- **Given** a workbook with sheets `Fees DMN` (W-BASE), `Types DMN` (W-TYPES) and
  `Notes` (non-DMN).
- **When** convert with `--platform camunda8 --out-dir out`.
- **Then** exit `0`; `listFiles(out)` = `['FEES.dmn', 'TYPES.dmn']`; both carry the
  modeler metadata; `Notes` ignored.
- **Spec:** §3 intro; §7 output filenames; §6.6.

### CAMUNDA8-099 — one C8-invalid sheet does not block the valid one

- **Given** sheets `Fees DMN` (W-BASE) and `Prio DMN` (ID `PRIO`, `PRIORITY` policy).
- **When** convert with `--platform camunda8 --out-dir out`.
- **Then** exit `1`; `out/FEES.dmn` exists and is valid C8; no `PRIO.dmn`; stdout has
  `✓ Fees DMN`; stderr has `✗ Prio DMN:` and `not supported by Camunda 8`.
- **Spec:** §7 ("emitted atomically per sheet — a validation error in sheet B does not
  delete sheet A's … output, but the process still exits non-zero").

### CAMUNDA8-100 — `-o/--out` single-file output on C8

- **Given** W-BASE.
- **When** `excel2dmn fees_DMN.xlsx --platform camunda8 -o out/custom.dmn`.
- **Then** exit `0`; `out/custom.dmn` exists with C8 content (spec intent).
- **Spec:** §7 `-o, --out <file>`; README Usage. (Note for the TDD writer: assert the
  file at the requested path; if the CLI ignores `--out`, that is a gap.)

### CAMUNDA8-101 — `-o` with multiple sheets errors on C8 too

- **Given** the workbook of CAMUNDA8-098.
- **When** convert with `--platform camunda8 -o out/one.dmn`.
- **Then** exit `1`; stderr mentions `--out` and `--out-dir`.
- **Spec:** §7 ("`--out` … errors when 2+ sheets match").

### CAMUNDA8-102 — `--sheet` restricts conversion on C8

- **Given** the workbook of CAMUNDA8-098.
- **When** convert with `--platform camunda8 --sheet "Types DMN" --out-dir out`.
- **Then** exit `0`; only `TYPES.dmn` written.
- **Spec:** §3 intro / §7 `--sheet`.

### CAMUNDA8-103 — default output location beside the workbook

- **Given** W-BASE at `<tmp>/in/fees_DMN.xlsx`.
- **When** `excel2dmn in/fees_DMN.xlsx --platform camunda8` (no out options).
- **Then** exit `0`; `<tmp>/in/FEES.dmn` exists with C8 content.
- **Spec:** §7 ("default: alongside <input.xlsx>"); §7.1 `output.outDir: null`.

### CAMUNDA8-104 — `fileNameTemplate: "<sheetName>.dmn"` on C8

- **Given** W-BASE; config `{ "platform": "camunda8", "output": { "fileNameTemplate": "<sheetName>.dmn" } }`.
- **When** convert with `--out-dir out`.
- **Then** exit `0`; `out/Fees DMN.dmn` exists.
- **Spec:** §7.1 `output.fileNameTemplate` ("also `<sheetName>.dmn`").

---

## L. Identity and content preservation on C8

### CAMUNDA8-105 — id sanitization and verbatim name on C8

- **Given** W-BASE with `B2` = `Zürich Süd` and `C2` = `Opłaty – Zürich`.
- **When** convert for C8.
- **Then** file `ZURICH_SUD.dmn`; `<decision id="ZURICH_SUD" name="Opłaty – Zürich">`;
  `definitions id="definitions_ZURICH_SUD"`; UTF-8 preserved.
- **Spec:** §6.4 `toNcNameId` (verified `Zürich Süd` → `ZURICH_SUD`); §3.2 name verbatim.

### CAMUNDA8-106 — no `name` column: name falls back to the raw id value

- **Given** W-BASE without column C.
- **When** convert for C8.
- **Then** `<decision id="FEES" name="FEES">`, `<definitions … name="FEES">`.
- **Spec:** §3.2 `id` bullet; §6.4.

### CAMUNDA8-107 — native Excel number/boolean cells emit canonical FEEL on C8

- **Given** W-BASE where `F5` is a numeric cell `1.5` (not text) and a boolean input
  column whose cell is a real Excel `TRUE`.
- **When** convert for C8.
- **Then** `<text>1.5</text>` and `<text>true</text>` (lowercase).
- **Spec:** §5 cell-value extraction (boolean coerce to lowercase; canonical numbers).

### CAMUNDA8-108 — header problems still reported with coordinates on C8

- **Given** W-BASE with `D2` (input technical name) blank and no `output` columns
  variant separately.
- **When** convert for C8.
- **Then** exit `1`; first: stderr contains `Fees DMN!D2` and `technical name`;
  second: stderr contains `no output column`.
- **Spec:** §5 Step 2 (header validation, structural requirements).

### CAMUNDA8-109 — C8 output imports back and is detected as Camunda 8 (cross-check)

- **Given** `out/FEES.dmn` from CAMUNDA8-001.
- **When** `excel2dmn import out/FEES.dmn -o back.xlsx`, then
  `excel2dmn back.xlsx --platform camunda8 --out-dir again`.
- **Then** import exits `0` and stdout contains `detected Camunda 8` and
  `--platform camunda8`; the re-converted `again/FEES.dmn` re-parses cleanly and has
  `typeRef="number"` for `amount`/`fee` (authored types are now `number`, so the bytes
  equal CAMUNDA8-001).
- **Spec:** §6.6 last paragraph (import detection + two-step round-trip); README
  "Camunda 8 round-trip". (Owned primarily by the import area; included here as a
  consumer check of the C8 writer.)

### CAMUNDA8-110 — `init` template converts on C8 out of the box

- **Given** `excel2dmn init -o t_DMN.xlsx`.
- **When** `excel2dmn t_DMN.xlsx --platform camunda8 --out-dir out`.
- **Then** exit `0`; one `.dmn` with modeler metadata; re-parses cleanly.
- **Spec:** §7.2 ("running `excel2dmn` on a freshly `init`-ed workbook produces a valid
  `.dmn` with 0 warnings"); §6.6 bullet 3 ("C7 templates therefore convert to valid C8
  without edits").
