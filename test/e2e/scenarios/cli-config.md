# E2E scenarios: CLI commands, config, init and analysis

Scope: every `excel2dmn` command and flag (`convert` as the default command, `init`,
`config`, `import` basics, `--version`, `--help`), the config loader (file discovery,
precedence, validation, marker customization), multi-sheet behaviour, exit codes for
every error path, and the static analysis (`--analyze`). Platform-specific DMN content
(Camunda 7 extension attributes, Camunda 8 metadata and type aliasing) is covered in
`convert-camunda7.md` and `convert-camunda8.md`; here the platform only appears where
a flag or config value has to be plumbed through.

Every scenario drives the real CLI with `runCli(args, { cwd, input })` from
`test/e2e/helpers.js`, unless it says **API**, in which case it calls the public API
(`convert`, `loadConfig`, `importDmn`, `buildConfig` from `src/init-config.js`).
Expected results come from `SOLUTION_SPEC.md` ("spec") and `README.md`. Where the spec
says nothing, the scenario says what the most reasonable behaviour is and is flagged
**spec silent**. Where two passages disagree, it is flagged **spec conflict** and the
scenario names the passage it follows.

## Conventions

**Temp dir.** Each scenario runs in a fresh `tempDir()`, called `T`. Unless the
scenario says otherwise, `T` holds no `excel2dmn.config.json`, and the CLI runs with
`cwd: T`. Relative paths below are relative to `T`.

**Config.** "with config `{…}`" means: write that JSON to `T/cfg.json` and add
`--config cfg.json`. "with cwd config `{…}`" means: write it to
`T/excel2dmn.config.json` and pass no `--config`. Only the listed keys are given; the
rest stay at their defaults (spec §7.1: deep-merged over the defaults).

**Success.** "succeeds" means: exit code `0`, stderr empty, and every `.dmn` written
re-parses with `parseDmn` (no dmn-moddle warnings).

**Fails.** "fails with `<text>`" means: exit code `1`, stderr contains `<text>`
(case-insensitive substring match is enough; the exact wording is not part of the
contract unless the scenario says "exact"), stderr has no JavaScript stack trace (no
line matching `/^\s+at .+:\d+:\d+\)?$/`), and stdout holds no success line for the
failing item. **spec silent** on the stack-trace rule; it is the reasonable
expectation for a user-facing CLI.

**Workbooks.** Built in code with `writeWorkbook` + `decisionSheet`.

### W1: single-sheet baseline (`one_DMN.xlsx`)

Sheet `Rates DMN`, default 4-row layout, no `policy` and no `name` column:

| Col | Marker (row 1) | Name (row 2) | Type (row 3) | Label (row 4) | Row 5   | Row 6    |
| --- | -------------- | ------------ | ------------ | ------------- | ------- | -------- |
| A   | `id`           | `RATES`      |              |               |         |          |
| B   | `input`        | `amount`     | `integer`    | `Amount`      | `< 10`  | `>= 10`  |
| C   | `output`       | `result`     | `string`     | `Result`      | `"LOW"` | `"HIGH"` |

`excel2dmn one_DMN.xlsx` writes `T/RATES.dmn`.

### W2: multi-sheet workbook (`book.xlsx`)

Sheets, in this order:

1. `Shipping DMN`: W1's layout with id `SHIPPING`, input `weight` (`integer`), output
   `method` (`string`), rules `< 5` → `"STANDARD"`, `>= 5` → `"FREIGHT"`.
2. `Notes`: free text, including a row 1 that reads `input | output | id` in A1:C1 and
   `X` in A2 (looks like a header, but the sheet name has no `DMN`).
3. `Returns_ DMN`: W1's layout with id `RETURNS`, input `days` (`integer`), output
   `allowed` (`boolean`), rules `<= 30` → `true`, `> 30` → `false`.

`excel2dmn book.xlsx` writes `T/SHIPPING.dmn` and `T/RETURNS.dmn`.

### W-BAD: one broken sheet

W1 with B5 = `"ten"` (a string literal in an `integer` input column, a type error under
spec §5 Step 3b).

### W-OVL: overlapping rules for analysis (`ovl_DMN.xlsx`)

Sheet `Ovl DMN`, id `OVL`, no policy column (so `UNIQUE`), input `region` (`string`),
input `amount` (`integer`), output `fee` (`integer`):

| Row | `region` | `amount` | `fee` |
| --- | -------- | -------- | ----- |
| 5   | `"EU"`   | `< 100`  | `1`   |
| 6   | `"EU"`   | `< 50`   | `2`   |
| 7   | `"US"`   | `>= 100` | `3`   |

Rows 5 and 6 overlap (both match `region = "EU", amount = 10`); row 7 overlaps nothing.

---

## A. Global flags: version, help, usage errors

### CLI-001: `--version` prints the package.json version

- **Given** any `T`.
- **When** `excel2dmn --version`.
- **Then** exit `0`; stdout trimmed equals the `version` field of the repo's `package.json` (read it in the test; do not hard-code `0.1.5`); stderr empty.
- **Source** spec §7 (commander CLI), `package.json`. **spec silent** on the exact output format; printing the bare version is the commander convention.

### CLI-002: `-V` is an alias of `--version`

- **Given** any `T`. **When** `excel2dmn -V`.
- **Then** same as CLI-001.
- **Source** **spec silent**; commander's default short flag.

### CLI-003: `--help` lists every command and the convert options

- **Given** any `T`. **When** `excel2dmn --help`.
- **Then** exit `0`; stdout contains `Usage: excel2dmn`, the commands `convert`, `init`, `config`, `import`, and the options `--out-dir`, `--out`, `--json`, `--config`, `--sheet`, `--hit-policy`, `--namespace`, `--analyze`, `--validate-only`, `--platform`. No file is written in `T`.
- **Source** spec §7 command synopsis, README "Usage".

### CLI-004: `-h` is an alias of `--help`

- **Given** any `T`. **When** `excel2dmn -h`.
- **Then** same stdout and exit code as CLI-003.
- **Source** **spec silent**; commander default.

### CLI-005: per-command help for `init`, `config`, `import`, `convert`

- **Given** any `T`.
- **When** `excel2dmn init --help`, `excel2dmn config --help`, `excel2dmn import --help`, `excel2dmn convert --help` (four runs).
- **Then** each exits `0`. `init` help lists `--out`, `--name`, `--sheet`, `--minimal`, `--config`. `config` help lists `--out`, `--full`, `--defaults`, `--force`. `import` help lists `--out`, `--config`. `convert` help lists the convert options of CLI-003. No file is written.
- **Source** spec §7, §7.2; README "Usage" and "Configuration".

### CLI-006: no arguments at all is a usage error

- **Given** an empty `T`. **When** `excel2dmn` (no args).
- **Then** exit code non-zero (`1`); stderr mentions the missing `input.xlsx` argument (or prints usage); nothing written.
- **Source** spec §7 (`<input.xlsx>` is required for convert). **spec silent** on the message.

### CLI-007: unknown option is rejected

- **Given** W1. **When** `excel2dmn one_DMN.xlsx --bogus`.
- **Then** fails with `unknown option`; mentions `--bogus`; no `.dmn` written.
- **Source** **spec silent**; rejecting unknown flags is the only safe behaviour (a typo in `--out-dir` must not silently write elsewhere).

### CLI-008: explicit `convert` sub-command equals the default command

- **Given** W1.
- **When** run A: `excel2dmn convert one_DMN.xlsx --out-dir a`; run B: `excel2dmn one_DMN.xlsx --out-dir b`.
- **Then** both succeed; `a/RATES.dmn` and `b/RATES.dmn` are byte-identical.
- **Source** spec §7 ("convert (default command)"), §6.4 (deterministic output).

---

## B. Convert: input errors and exit codes

### CLI-010: missing input file

- **Given** empty `T`. **When** `excel2dmn nope.xlsx`.
- **Then** fails with a message naming `nope.xlsx` (e.g. "not found" / "no such file"); no file created in `T`.
- **Source** **spec silent** on wording; exit code 1 per spec §7 conventions ("process still exits non-zero").

### CLI-011: input is not an xlsx (plain text with .xlsx extension)

- **Given** `T/fake.xlsx` containing the text `hello`.
- **When** `excel2dmn fake.xlsx`.
- **Then** fails; stderr names `fake.xlsx` or says the file is not a valid xlsx workbook; no stack trace; no `.dmn` written.
- **Source** **spec silent**. Reasonable: one-line error, exit 1.

### CLI-012: input is a CSV file

- **Given** `T/rules.csv` with `id,input,output`.
- **When** `excel2dmn rules.csv`.
- **Then** fails (exit 1) with a clear error; no `.dmn` written.
- **Source** spec §3 (input contract is an `.xlsx` workbook). **spec silent** on the message.

### CLI-013: input path is a directory

- **Given** `T/folder_DMN.xlsx/` (empty directory). **When** `excel2dmn folder_DMN.xlsx`.
- **Then** fails (exit 1) with an error naming `folder_DMN.xlsx`; nothing written.
- **Source** **spec silent**.

### CLI-014: workbook with zero matching sheets

- **Given** `T/plain.xlsx` with one sheet `Sheet1` holding W1's cell data (valid header, but the name has no `DMN`).
- **When** `excel2dmn plain.xlsx`.
- **Then** fails with `no sheet` and `DMN` (spec text: "no sheet containing 'DMN' found"); no `.dmn` written.
- **Source** spec §3 intro ("0 matching sheets ⇒ hard error"), §5 Step 1.

### CLI-015: sheet name matching is case-insensitive substring by default

- **Given** three workbooks each with one sheet named `rates dmn`, `Rates_Dmn_v2`, `xDMNx` (W1's data, ids `A`, `B`, `C`).
- **When** convert each.
- **Then** each succeeds and writes `A.dmn`, `B.dmn`, `C.dmn` respectively.
- **Source** spec §3 intro ("case-insensitive substring"), §7.1 `sheet` defaults.

### CLI-016: input path containing spaces and non-ASCII characters

- **Given** W1 saved as `T/my rules (ü)/one_DMN.xlsx`.
- **When** `excel2dmn "my rules (ü)/one_DMN.xlsx"`.
- **Then** succeeds; `T/my rules (ü)/RATES.dmn` exists.
- **Source** spec §7 (default output dir is alongside the input). **spec silent** on path characters.

### CLI-017: relative input path is resolved against cwd

- **Given** W1 at `T/in/one_DMN.xlsx`; cwd `T`.
- **When** `excel2dmn in/one_DMN.xlsx`.
- **Then** succeeds; `T/in/RATES.dmn` exists; nothing is written to `T` itself.
- **Source** spec §7 (`--out-dir` default: alongside `<input.xlsx>`).

### CLI-018: sheet-level conversion error exits 1 with a coordinate

- **Given** W-BAD.
- **When** `excel2dmn one_DMN.xlsx`.
- **Then** fails; stderr names the sheet `Rates DMN`, the cell `Rates DMN!B5`, and the column `amount`; `RATES.dmn` is not written.
- **Source** spec §5 Step 3b ("abort with a coordinate-anchored message"), §7.

### CLI-019: all problems of a sheet are reported together

- **Given** W1 with B5 = `"ten"` and C6 = `HIGH` (unquoted string output).
- **When** `excel2dmn one_DMN.xlsx`.
- **Then** fails; stderr contains both `Rates DMN!B5` and `Rates DMN!C6` in one run.
- **Source** spec §5 Step 2 / 3b ("collect all validation problems and report them together"), §7.1 `validation.feel.failFast: false`.

### CLI-020: `validation.feel.failFast: true` stops at the first problem

- **Given** the workbook of CLI-019, with config `{ "validation": { "feel": { "failFast": true } } }`.
- **When** convert.
- **Then** fails; stderr contains `Rates DMN!B5` and does **not** contain `Rates DMN!C6`.
- **Source** spec §7.1 `validation.feel.failFast` ("false → collect all errors").

### CLI-021: re-running overwrites the existing `.dmn` with byte-identical content

- **Given** W1, already converted once (`T/RATES.dmn` exists).
- **When** convert again.
- **Then** succeeds; the new `T/RATES.dmn` is byte-identical to the first one.
- **Source** spec §6.4 ("re-running the tool on unchanged input yields byte-identical XML").

### CLI-022: success line on stdout names the sheet and output path

- **Given** W1. **When** `excel2dmn one_DMN.xlsx`.
- **Then** stdout contains exactly one line mentioning both `Rates DMN` and the absolute or relative path of `RATES.dmn`.
- **Source** **spec silent** on the format; one line per written file is the reasonable minimum.

---

## C. Output location: `--out-dir`, `--out`, `fileNameTemplate`

### CLI-030: default output goes beside the input, not into cwd

- **Given** W1 at `T/in/one_DMN.xlsx`; run with `cwd: T/elsewhere` (an empty dir).
- **When** `excel2dmn ../in/one_DMN.xlsx`.
- **Then** succeeds; `T/in/RATES.dmn` exists; `T/elsewhere` stays empty.
- **Source** spec §7 (`--out-dir` default "alongside `<input.xlsx>`"), §7.1 `output.outDir: null`.

### CLI-031: `--out-dir` writes there

- **Given** W1. **When** `excel2dmn one_DMN.xlsx --out-dir out`.
- **Then** succeeds; `listFiles('out')` is `['RATES.dmn']`; no `.dmn` beside the input.
- **Source** spec §7.

### CLI-032: `-O` is the short form of `--out-dir`

- **Given** W1. **When** `excel2dmn one_DMN.xlsx -O out`.
- **Then** same as CLI-031.
- **Source** spec §7 synopsis (`-O, --out-dir <dir>`).

### CLI-033: `--out-dir` creates missing nested directories

- **Given** W1; `T/a` does not exist.
- **When** `excel2dmn one_DMN.xlsx --out-dir a/b/c`.
- **Then** succeeds; `T/a/b/c/RATES.dmn` exists.
- **Source** **spec silent**; CI usage in spec §8 (`mkdir -p dist`) works either way, but creating the dir is the friendlier behaviour.

### CLI-034: `--out` writes a single sheet to the named file

- **Given** W1. **When** `excel2dmn one_DMN.xlsx --out out/custom-name.dmn`.
- **Then** succeeds; `T/out/custom-name.dmn` exists and is the RATES decision; **no** `RATES.dmn` is written anywhere (not beside the input, not in `out/`).
- **Source** spec §7 ("`-o, --out <file>` output .dmn path — ONLY valid when exactly one DMN sheet is processed"), README "Single-sheet workbook to a named file", spec §9.

### CLI-035: `-o` is the short form of `--out`

- **Given** W1. **When** `excel2dmn one_DMN.xlsx -o x.dmn`.
- **Then** succeeds; `T/x.dmn` exists; no `T/RATES.dmn`.
- **Source** spec §7.

### CLI-036: `--out` with a multi-sheet workbook is an error and writes nothing

- **Given** W2. **When** `excel2dmn book.xlsx --out x.dmn`.
- **Then** fails with `--out` and `single` (and suggests `--out-dir`); stderr mentions the count `2`; **no** `.dmn` file is written in `T` (neither `x.dmn` nor `SHIPPING.dmn`/`RETURNS.dmn`).
- **Source** spec §3 intro and §7 ("`--out <file>` … errors when 2+ sheets match"). **spec silent** on whether earlier files may already exist; the reasonable expectation is that the option conflict is detected before anything is written.

### CLI-037: `--out` with a multi-sheet workbook filtered to one sheet by `--sheet` is valid

- **Given** W2. **When** `excel2dmn book.xlsx --sheet "Returns_ DMN" --out r.dmn`.
- **Then** succeeds; `T/r.dmn` holds decision `RETURNS`; no other `.dmn` written.
- **Source** spec §7 ("ONLY valid when exactly one DMN sheet is **processed**").

### CLI-038: `--out` combined with `--json` writes the model beside the named file

- **Given** W1. **When** `excel2dmn one_DMN.xlsx --out out/r.dmn --json`.
- **Then** succeeds; `out/r.dmn` and `out/r.model.json` exist.
- **Source** spec §7 (`--json` writes one model per sheet). **spec silent** on the model's name with `--out`; deriving it from the `--out` basename is the reasonable choice.

### CLI-039: `--out` into a missing directory creates it

- **Given** W1. **When** `excel2dmn one_DMN.xlsx --out deep/er/r.dmn`.
- **Then** succeeds; `T/deep/er/r.dmn` exists.
- **Source** **spec silent**; consistent with CLI-033.

### CLI-040: `--out` and `--out-dir` together

- **Given** W1. **When** `excel2dmn one_DMN.xlsx --out-dir od --out o.dmn`.
- **Then** succeeds; `T/o.dmn` exists (the explicit file path wins); `od/` holds no `.dmn`.
- **Source** **spec silent**. Reasonable: the more specific `--out` wins. An error ("use one of --out / --out-dir") would also be acceptable; whichever is chosen must be documented.

### CLI-041: `output.outDir` in config is used when no flag is given

- **Given** W1, config `{ "output": { "outDir": "cfgout" } }`.
- **When** `excel2dmn one_DMN.xlsx --config cfg.json`.
- **Then** succeeds; `T/cfgout/RATES.dmn` exists. Relative `outDir` is resolved against cwd (**spec silent**; cwd is the reasonable base, matching `--out-dir`).
- **Source** spec §7.1 `output.outDir` ("null → write beside the input .xlsx; else this dir").

### CLI-042: `--out-dir` beats `output.outDir`

- **Given** W1, config `{ "output": { "outDir": "cfgout" } }`.
- **When** `excel2dmn one_DMN.xlsx --config cfg.json --out-dir flagout`.
- **Then** succeeds; `flagout/RATES.dmn` exists; `cfgout` does not exist.
- **Source** spec §7.1 precedence ("CLI flags → `--config` → …").

### CLI-043: `fileNameTemplate: "<sheetName>.dmn"`

- **Given** W1, config `{ "output": { "fileNameTemplate": "<sheetName>.dmn" } }`.
- **When** convert.
- **Then** succeeds; `T/Rates DMN.dmn` exists; no `RATES.dmn`.
- **Source** spec §7.1 `output.fileNameTemplate` ("also `<sheetName>.dmn`").

### CLI-044: `fileNameTemplate` with a prefix and both placeholders

- **Given** W1, config `{ "output": { "fileNameTemplate": "v1-<decisionId>.dmn" } }`.
- **When** convert.
- **Then** succeeds; `T/v1-RATES.dmn` exists.
- **Source** spec §7.1 `output.fileNameTemplate`.

### CLI-045: `fileNameTemplate` with `--json` names the model after the DMN file

- **Given** W1, config as CLI-044. **When** convert with `--json`.
- **Then** `T/v1-RATES.dmn` and `T/v1-RATES.model.json` exist.
- **Source** spec §7 (`<decisionId>.model.json` per sheet). **spec silent** on the combination; following the DMN file name keeps the pair together.

---

## D. `--json` and the intermediate model

### CLI-050: `--json` writes one model per sheet beside the DMN

- **Given** W1. **When** `excel2dmn one_DMN.xlsx --json --out-dir out`.
- **Then** succeeds; `listFiles('out')` is `['RATES.dmn', 'RATES.model.json']`.
- **Source** spec §7 (`-j, --json` "also write one `<decisionId>.model.json` per sheet").

### CLI-051: `-j` is the short form of `--json`

- **Given** W1. **When** `excel2dmn one_DMN.xlsx -j`.
- **Then** `T/RATES.model.json` exists.
- **Source** spec §7 synopsis.

### CLI-052: the model JSON validates against `schema/model.schema.json`

- **Given** W1. **When** convert with `--json`.
- **Then** compiling `schema/model.schema.json` with ajv (Draft 2020-12, `ajv/dist/2020`) and validating the parsed `RATES.model.json` returns `true` with no errors.
- **Source** spec §4.2.

### CLI-053: the model JSON content matches the spec shape

- **Given** W1. **When** convert with `--json`.
- **Then** the JSON equals:
  `definitions` = `{ id: "definitions_RATES", name: "RATES", namespace: "http://camunda.org/schema/1.0/dmn" }`;
  `decisions` has length 1 with `id: "RATES"`, `name: "RATES"`, `hitPolicy: "UNIQUE"`, `aggregation: null`;
  `inputs[0]` = `{ label: "Amount", expression: "amount", typeRef: "integer", allowedValues: null }`;
  `outputs[0]` = `{ name: "result", label: "Result", typeRef: "string", allowedValues: null }`;
  `rules[0]` has `id: "rule_1"`, `row: 5`, `inputEntries: ["< 10"]`, `outputEntries: ["\"LOW\""]`, and no `description` key; `rules[1]` has `id: "rule_2"`, `row: 6`.
- **Source** spec §4.1, §4.1 notes (rule id `rule_<seq>`, `rule.row` = Excel row, `description` omitted when blank), §3.3.

### CLI-054: the model JSON carries no internal bookkeeping keys

- **Given** W1. **When** convert with `--json`.
- **Then** the top-level keys of `RATES.model.json` are exactly `definitions` and `decisions` (no `__sheet`, `__warnings`, `__platform`, or other `__`-prefixed key anywhere in the file).
- **Source** spec §4.1 (stable, human-diffable contract; shape shown has only these keys).

### CLI-055: the model JSON is pretty-printed and stable across runs

- **Given** W1. **When** convert with `--json` twice.
- **Then** the two `RATES.model.json` files are byte-identical; the file is multi-line JSON (2-space indent).
- **Source** spec §1 ("deterministic, reviewable intermediate JSON … diffable in CI"). **spec silent** on the indent width.

### CLI-056: `output.writeModelJson: true` writes the model without `--json`

- **Given** W1, config `{ "output": { "writeModelJson": true } }`.
- **When** convert (no `--json`).
- **Then** `T/RATES.model.json` exists.
- **Source** spec §7.1 `output.writeModelJson`.

### CLI-057: without `--json` no model JSON is written

- **Given** W1. **When** convert.
- **Then** `listFiles(T)` holds no `*.model.json`.
- **Source** spec §7.1 `output.writeModelJson: false` default.

### CLI-058: `--json` on a multi-sheet workbook writes one model per sheet

- **Given** W2. **When** `excel2dmn book.xlsx --json --out-dir out`.
- **Then** `listFiles('out')` is `['RETURNS.dmn', 'RETURNS.model.json', 'SHIPPING.dmn', 'SHIPPING.model.json']`; each model has `decisions.length === 1` and validates against the schema; the models are not merged.
- **Source** spec §4 ("one model per DMN sheet … never merged"), §9.

### CLI-059: model JSON for a sheet with annotations, a name column and a COLLECT policy

- **Given** W1 plus a `policy` column (`COLLECT` at row 2, `SUM` at row 3), a `name` column (`Rate Decision`), and an `annotations` column with `small` in row 5 (blank in row 6). Output `result` retyped to `integer` with values `1`, `2`.
- **When** convert with `--json`.
- **Then** the model has `name: "Rate Decision"` on both `definitions` and the decision, `hitPolicy: "COLLECT"`, `aggregation: "SUM"`, `rules[0].description: "small"`, `rules[1]` has no `description` key; the JSON validates against the schema.
- **Source** spec §3.2, §3.4, §4.1 notes, §4.2.

---

## E. `--validate-only`

### CLI-060: valid workbook: exit 0, nothing written

- **Given** W1. **When** `excel2dmn one_DMN.xlsx --validate-only`.
- **Then** exit `0`; `listFiles(T)` is still exactly `['one_DMN.xlsx']`; stdout mentions `Rates DMN` and `RATES` and that it is valid.
- **Source** spec §7 (`--validate-only` "parse + schema-validate all sheets, do not emit DMN"), README "Validate only (CI gate)".

### CLI-061: invalid workbook: exit 1, nothing written, coordinate reported

- **Given** W-BAD. **When** `excel2dmn one_DMN.xlsx --validate-only`.
- **Then** fails; stderr contains `Rates DMN!B5`; no files written.
- **Source** spec §7, §8 ("validate stage fails the pipeline on malformed templates").

### CLI-062: `--validate-only` with `--json` writes no model either

- **Given** W1. **When** `excel2dmn one_DMN.xlsx --validate-only --json`.
- **Then** exit `0`; no `.dmn` and no `.model.json` in `T`.
- **Source** spec §7 ("do not emit"). **spec silent** on `--json`; validate-only must stay side-effect free for a CI gate.

### CLI-063: `--validate-only` with `--out-dir` does not create the directory

- **Given** W1. **When** `excel2dmn one_DMN.xlsx --validate-only --out-dir out`.
- **Then** exit `0`; `T/out` does not exist.
- **Source** **spec silent**; side-effect-free validation.

### CLI-064: `--validate-only` with `output.writeModelJson: true` writes nothing

- **Given** W1, config `{ "output": { "writeModelJson": true } }`.
- **When** `excel2dmn one_DMN.xlsx --config cfg.json --validate-only`.
- **Then** exit `0`; no `.dmn`, no `.model.json`.
- **Source** spec §7 (`--validate-only` does not emit). **spec silent** on the combination.

### CLI-065: `--validate-only` checks every sheet of a multi-sheet workbook

- **Given** W2 with `Returns_ DMN!B5` set to `"x"` (type error).
- **When** `excel2dmn book.xlsx --validate-only`.
- **Then** exit `1`; stdout reports `Shipping DMN` as valid; stderr reports `Returns_ DMN!B5`; nothing written.
- **Source** spec §7 ("parse + schema-validate **all** sheets"), §7 "reports every failing sheet".

### CLI-066: `--validate-only` detects Camunda 8 hit-policy errors with `--platform camunda8`

- **Given** W1 plus a `policy` column with `PRIORITY` (5-row layout with allowed values for `result`: `"LOW","HIGH"`, config `ALLOWED_VALUES_LAYOUT`).
- **When** `excel2dmn one_DMN.xlsx --config cfg.json --platform camunda8 --validate-only`.
- **Then** fails with `PRIORITY` and `Camunda 8`; nothing written. The same command without `--platform camunda8` exits `0`.
- **Source** spec §6.6 ("Rejects the `PRIORITY` and `OUTPUT ORDER` hit policies with a conversion error"); validation must apply the same checks as conversion.

---

## F. `--sheet` filtering

### CLI-070: `--sheet` restricts conversion to one sheet

- **Given** W2. **When** `excel2dmn book.xlsx --sheet "Shipping DMN"`.
- **Then** succeeds; only `T/SHIPPING.dmn` is written.
- **Source** spec §3 intro, §5 Step 1, §7.

### CLI-071: `--sheet` accepts several names

- **Given** W2 plus a third DMN sheet `Pricing DMN` (id `PRICING`).
- **When** `excel2dmn book.xlsx --sheet "Shipping DMN" "Pricing DMN"`.
- **Then** succeeds; `SHIPPING.dmn` and `PRICING.dmn` written; no `RETURNS.dmn`.
- **Source** spec §7 (`--sheet <name...>`).

### CLI-072: `--sheet` with a name that does not exist

- **Given** W2. **When** `excel2dmn book.xlsx --sheet "Missing DMN"`.
- **Then** fails with a "no sheet" message that names `Missing DMN` (or the selection); nothing written.
- **Source** spec §3 intro ("0 matching sheets ⇒ hard error"), §5 Step 1.

### CLI-073: `--sheet` naming a sheet without `DMN` in its name

- **Given** a workbook with sheet `Rates` holding W1's data.
- **When** `excel2dmn w.xlsx --sheet Rates`.
- **Then** fails with no sheet; nothing written; the error names `"Rates"` and `"DMN"` and says `--sheet only narrows` the sheets selected by `sheet.match`/`sheet.value`.
- **Source** spec §3 (decided: `--sheet` narrows the `DMN`-matched sheets; §7.1 no longer says it forces `sheet.match: "exact"`).

### CLI-074: `--sheet` uses exact (not substring) matching

- **Given** W2. **When** `excel2dmn book.xlsx --sheet Shipping`.
- **Then** fails with a "no sheet" message (`Shipping` is a substring of `Shipping DMN` but not an exact name); nothing written.
- **Source** spec §7.1 ("forces `sheet.match:"exact"`").

### CLI-075: `--sheet` filters away the broken sheet

- **Given** W2 with `Returns_ DMN!B5` = `"x"`.
- **When** `excel2dmn book.xlsx --sheet "Shipping DMN"`.
- **Then** succeeds (exit 0); `SHIPPING.dmn` written; stderr empty (the broken sheet is not parsed).
- **Source** spec §5 Step 1 ("Then run Steps 2–4 on each **selected** sheet").

---

## G. Multi-sheet workbooks

### CLI-080: one `.dmn` per DMN sheet; non-DMN sheets ignored

- **Given** W2. **When** `excel2dmn book.xlsx --out-dir out`.
- **Then** succeeds; `listFiles('out')` is exactly `['RETURNS.dmn', 'SHIPPING.dmn']`; stdout has two success lines (one per sheet, in workbook order `Shipping DMN` then `Returns_ DMN`); `Notes` is not mentioned on stdout or stderr.
- **Source** spec §3 intro ("exactly one `.dmn` … per matching sheet. Non-matching sheets are ignored"), §9.

### CLI-081: each output is self-contained

- **Given** W2. **When** convert.
- **Then** `SHIPPING.dmn` has `definitions id="definitions_SHIPPING"` and exactly one decision `SHIPPING`; `RETURNS.dmn` has `definitions_RETURNS` and only `RETURNS`; neither file mentions the other decision id.
- **Source** spec §3 intro ("Sheets do not reference each other"), §4, §6 ("complete, standalone DMN 1.3 document").

### CLI-082: one failing sheet does not block the others

- **Given** W2 with `Returns_ DMN!B5` = `"x"`.
- **When** `excel2dmn book.xlsx --out-dir out`.
- **Then** exit `1`; `out/SHIPPING.dmn` exists and re-parses cleanly; `out/RETURNS.dmn` does not exist; stderr names `Returns_ DMN` and `Returns_ DMN!B5`; stdout has a success line for `Shipping DMN`.
- **Source** spec §7 ("Files are emitted atomically per sheet — a validation error in sheet B does not delete sheet A's already-written output, but the process still exits non-zero and reports every failing sheet").

### CLI-083: failing sheet listed first does not block a later valid sheet

- **Given** W2 with `Shipping DMN!B5` = `"x"` (the **first** DMN sheet broken).
- **When** convert with `--out-dir out`.
- **Then** exit `1`; `out/RETURNS.dmn` exists; `out/SHIPPING.dmn` does not; stderr names `Shipping DMN!B5`.
- **Source** spec §7 (per-sheet atomicity; order must not matter).

### CLI-084: every failing sheet is reported

- **Given** W2 with both `Shipping DMN!B5` and `Returns_ DMN!B5` = `"x"`.
- **When** convert.
- **Then** exit `1`; stderr contains both `Shipping DMN!B5` and `Returns_ DMN!B5`; no `.dmn` written.
- **Source** spec §7 ("reports every failing sheet").

### CLI-085: duplicate decision ids across sheets are a hard error

- **Given** W2 with the `Returns_ DMN` id changed to `SHIPPING`, plus a third valid sheet `Other DMN` (id `OTHER`).
- **When** `excel2dmn book.xlsx --out-dir out`.
- **Then** fails; stderr names the id `SHIPPING` and both sheets `Shipping DMN` and `Returns_ DMN`; no `SHIPPING.dmn` or suffixed file appears; the third sheet is still written (`out/OTHER.dmn` is the only `.dmn`).
- **Source** spec §3 intro ("A duplicate decision id across two sheets ⇒ hard error (they would overwrite each other) — fix the `id` markers"), §5 Step 1 ("Track decision ids across sheets and error on a duplicate"). **spec conflict**: §6.4 and §7.1 `identity.collisionSuffix` describe suffixing `_2` on collision "across the repo". Decided: hard error, as §3/§5 say; §6.4 and §7.1 were corrected (`collisionSuffix` only applies to rule ids inside one decision).

### CLI-086: duplicate ids that only collide after sanitization

- **Given** W2 with ids `Zürich Süd` (Shipping) and `ZURICH_SUD` (Returns).
- **When** convert.
- **Then** fails as in CLI-085 (no `.dmn` written at all), naming `ZURICH_SUD`.
- **Source** spec §3 intro, §6.4 (`Zürich Süd` → `ZURICH_SUD`). Collision is on the output id because that is what names the file.

### CLI-087: duplicate ids are case-folded before comparison

- **Given** W2 with ids `shipping` and `SHIPPING`.
- **When** convert.
- **Then** fails as in CLI-085 (no `.dmn` written at all; both sanitize to `SHIPPING`).
- **Source** spec §6.4 (`toNcNameId` upper-cases), §3 intro.

### CLI-088: duplicate ids in a sheet excluded by `--sheet` are not an error

- **Given** W2 with ids both `SHIPPING`.
- **When** `excel2dmn book.xlsx --sheet "Shipping DMN"`.
- **Then** succeeds; `SHIPPING.dmn` written.
- **Source** spec §5 Step 1 (only selected sheets are processed).

### CLI-088a: a fixed `output.fileNameTemplate` shared by two sheets is an error

- **Given** W2, config `{ "output": { "fileNameTemplate": "fixed.dmn" } }`.
- **When** convert.
- **Then** exit `1`; stderr names `fixed.dmn`, both sheets and `output.fileNameTemplate`; no `.dmn` written.
- **Source** spec §3 intro (sheets must not overwrite each other's output). **spec silent** on template collisions.

### CLI-088b: an output path outside the output directory is a per-sheet error

- **Given** `T/sub/book.xlsx` with sheets `Evil DMN` (id `../evil`) and `Good DMN` (id `GOOD`); config `{ "identity": { "sanitizeId": false } }`.
- **When** convert.
- **Then** exit `1`; stderr names `Evil DMN` and says the output would be outside the output directory; `sub/GOOD.dmn` is written and nothing is written outside `sub/`.
- **Source** **spec silent**; a decision id must not steer the output outside the output directory.

### CLI-089: sheets with the same name prefix are independent

- **Given** workbook with sheets `A DMN` (id `A`) and `A DMN copy` (id `B`).
- **When** convert.
- **Then** succeeds; `A.dmn` and `B.dmn` written.
- **Source** spec §3 intro.

### CLI-090: a DMN sheet with no marker row fails, others still convert

- **Given** W2 plus sheet `Empty DMN` with only `hello` in A1.
- **When** convert.
- **Then** exit `1`; `SHIPPING.dmn` and `RETURNS.dmn` written; stderr names `Empty DMN` and says no `input`/`output` marker row was found in the first 5 rows.
- **Source** spec §3.1 (marker row in rows 1–5), §7 (per-sheet atomicity).

---

## H. `--hit-policy`, `--namespace`, `--platform`, `--no-pretty`

### CLI-100: `--hit-policy` applies when the sheet has no policy column

- **Given** W1. **When** `excel2dmn one_DMN.xlsx --hit-policy FIRST --json`.
- **Then** succeeds; `<decisionTable … hitPolicy="FIRST">`; model `hitPolicy: "FIRST"`.
- **Source** spec §3.4 resolution order (2. `--hit-policy`), §7.1 (`--hit-policy` → `hitPolicy.default`).

### CLI-101: sheet `policy` column beats `--hit-policy`

- **Given** W1 plus a `policy` column with `RULE ORDER`.
- **When** `excel2dmn one_DMN.xlsx --hit-policy FIRST`.
- **Then** succeeds; `hitPolicy="RULE ORDER"`.
- **Source** spec §3.4 (1. policy marker column wins).

### CLI-102: `--hit-policy` beats config `hitPolicy.default`

- **Given** W1, config `{ "hitPolicy": { "default": "ANY" } }`.
- **When** `excel2dmn one_DMN.xlsx --config cfg.json --hit-policy FIRST`.
- **Then** `hitPolicy="FIRST"`.
- **Source** spec §7.1 precedence.

### CLI-103: config `hitPolicy.default` applies without the flag

- **Given** W1, config `{ "hitPolicy": { "default": "ANY" } }`. **When** convert.
- **Then** `hitPolicy="ANY"`.
- **Source** spec §3.4, §7.1.

### CLI-104: `--hit-policy UNIQUE` emits no `hitPolicy` attribute

- **Given** W1, config `{ "hitPolicy": { "default": "FIRST" } }`.
- **When** convert with `--config cfg.json --hit-policy UNIQUE`.
- **Then** `<decisionTable>` has no `hitPolicy` attribute; model `hitPolicy: "UNIQUE"`.
- **Source** spec §6.1 ("UNIQUE … moddle OMITS it"), §6.4.

### CLI-105: `--hit-policy` value is case-insensitive

- **Given** W1. **When** `excel2dmn one_DMN.xlsx --hit-policy "rule order"`.
- **Then** succeeds; `hitPolicy="RULE ORDER"`.
- **Source** **spec silent**. The sheet policy is normalized to upper case, so the flag should be too.

### CLI-106: unknown `--hit-policy` value is rejected

- **Given** W1. **When** `excel2dmn one_DMN.xlsx --hit-policy SOMETIMES`.
- **Then** fails with `SOMETIMES` and lists or refers to the allowed policies; no `.dmn` written.
- **Source** spec §3.4 (accepted values), §7.1 `hitPolicy.allowed`.

### CLI-107: `--hit-policy COLLECT` without a policy column has no aggregation

- **Given** W1 with output `result` retyped `integer`, values `1`, `2`.
- **When** `excel2dmn one_DMN.xlsx --hit-policy COLLECT --json`.
- **Then** `hitPolicy="COLLECT"` and no `aggregation` attribute; model `aggregation: null`.
- **Source** spec §3.4 (aggregator only from the policy column's M+2 row).

### CLI-108: `--hit-policy PRIORITY` without allowed values fails

- **Given** W1 (default 4-row layout, so no allowed values).
- **When** `excel2dmn one_DMN.xlsx --hit-policy PRIORITY`.
- **Then** fails with `PRIORITY` and the output name `result`; no `.dmn` written.
- **Source** spec §3.6 ("must supply the output column's allowed values (the tool errors otherwise)"), §5 Step 2.

### CLI-109: `--namespace` sets the definitions namespace

- **Given** W1. **When** `excel2dmn one_DMN.xlsx --namespace https://example.com/dmn --json`.
- **Then** succeeds; `<definitions … namespace="https://example.com/dmn">`; model `definitions.namespace` is `https://example.com/dmn`.
- **Source** spec §7 (`--namespace <uri>`), §7.1 (`--namespace` → `output.namespace`).

### CLI-110: `--namespace` beats config `output.namespace`

- **Given** W1, config `{ "output": { "namespace": "urn:cfg" } }`.
- **When** convert with `--config cfg.json --namespace urn:flag`.
- **Then** `namespace="urn:flag"`.
- **Source** spec §7.1 precedence.

### CLI-111: config `output.namespace` applies without the flag

- **Given** W1, config `{ "output": { "namespace": "urn:cfg" } }`. **When** convert.
- **Then** `namespace="urn:cfg"`.
- **Source** spec §7.1.

### CLI-112: `--platform camunda8` is plumbed through

- **Given** W1. **When** `excel2dmn one_DMN.xlsx --platform camunda8`.
- **Then** succeeds; `<definitions>` carries `modeler:executionPlatform="Camunda Cloud"`; `<decision>` has no `camunda:historyTimeToLive`. (Content details: `convert-camunda8.md`.)
- **Source** spec §6.6, README "Target Camunda 8".

### CLI-113: `--platform` with an invalid value

- **Given** W1. **When** `excel2dmn one_DMN.xlsx --platform camunda9`.
- **Then** fails; stderr names `camunda9` and the allowed values `camunda7`, `camunda8`; no `.dmn` written.
- **Source** spec §7.1 `platform` ("camunda7" | "camunda8").

### CLI-114: `--no-pretty` writes unformatted XML

- **Given** W1.
- **When** run A: `excel2dmn one_DMN.xlsx --out-dir a`; run B: `excel2dmn one_DMN.xlsx --out-dir b --no-pretty`.
- **Then** both succeed; `b/RATES.dmn` holds no newline followed by indentation between tags (it is a single line after the XML declaration), and is shorter than `a/RATES.dmn`; parsing both with `parseDmn` yields the same decision id, inputs, outputs and rule entries.
- **Source** spec §7 (`--pretty format XML (default true)`), §7.1 `output.format` ("pretty-print"). **spec silent** on `--no-pretty` (the synopsis shows `--pretty`); the negated flag is the commander way to turn off a default-true option.

### CLI-115: config `output.format: false` equals `--no-pretty`

- **Given** W1, config `{ "output": { "format": false } }`.
- **When** convert with `--config cfg.json`.
- **Then** the DMN is byte-identical to run B of CLI-114.
- **Source** spec §7.1 `output.format`.

### CLI-116: `output.namespaceStyle: "prefixed"` keeps `dmn:` tags

- **Given** W1, config `{ "output": { "namespaceStyle": "prefixed" } }`.
- **When** convert.
- **Then** succeeds; XML contains `<dmn:definitions` and `xmlns:dmn="https://www.omg.org/spec/DMN/20191111/MODEL/"`, and no unprefixed `<definitions`; re-parses cleanly.
- **Source** spec §7.1 `output.namespaceStyle` ("default" | "prefixed"), §6.3.

---

## I. `--analyze`

Analysis reports, it does not block: by default (`analysis.failOn: "none"`) findings
never change the exit code and the `.dmn` is still written. The spec's analysis section
(§16) is referenced but not present in `SOLUTION_SPEC.md`; expectations below come from
the §7 synopsis, §3.6, README ("overlap / duplicate / shadowed / gap detection") and the
`analysis` block of `excel2dmn.config.example.json`. Each is therefore partly **spec
silent** on exact wording; the tests should match on the check name, the severity word
and the rule ids, not on full sentences.

### CLI-120: overlapping rules under UNIQUE are reported

- **Given** W-OVL. **When** `excel2dmn ovl_DMN.xlsx --analyze`.
- **Then** exit `0`; `T/OVL.dmn` written; stdout contains a line with `overlap`, `OVL`, `rule_1`, `rule_2` (and the sheet rows `5` and `6`), marked as an error-level finding for UNIQUE; no overlap line mentions `rule_3`.
- **Source** spec §7 (`--analyze` "overlap/gaps/duplicates"), README features list; §3.4 (UNIQUE means at most one rule may match).

### CLI-121: no overlap reported when inputs are disjoint

- **Given** W-OVL with row 6 changed to `"US"`, `< 50`, `2`.
- **When** `excel2dmn ovl_DMN.xlsx --analyze`.
- **Then** exit `0`; stdout has no line containing `overlap`.
- **Source** as CLI-120.

### CLI-122: numeric boundaries: `< 50` and `>= 50` do not overlap

- **Given** W-OVL with rows 5–6 = `"EU"`/`< 50`/`1` and `"EU"`/`>= 50`/`2`; row 7 removed.
- **When** `--analyze`.
- **Then** no `overlap` finding.
- **Source** **spec silent** on interval semantics; FEEL `< 50` excludes 50, `>= 50` includes it.

### CLI-123: numeric boundaries: `<= 50` and `>= 50` do overlap

- **Given** as CLI-122 with `<= 50` and `>= 50`.
- **When** `--analyze`.
- **Then** one `overlap` finding for `rule_1` and `rule_2`.
- **Source** **spec silent**; both match 50.

### CLI-124: ranges `[1..10]` and `[10..20]` overlap; `[1..10)` and `[10..20]` do not

- **Given** two variants of W-OVL reduced to the single input column `amount`: variant A has rows `[1..10]` and `[10..20]`; variant B has rows `[1..10)` and `[10..20]`.
- **When** `--analyze` on each.
- **Then** the first reports an `overlap`; the second reports none.
- **Source** **spec silent**; FEEL range inclusivity.

### CLI-125: duplicate rules are reported

- **Given** W-OVL with row 6 = `"EU"`, `< 100`, `9` (same inputs as row 5).
- **When** `--analyze`.
- **Then** stdout contains a `duplicate` finding naming `rule_1` and `rule_2`.
- **Source** README ("duplicate"), spec §7 synopsis.

### CLI-126: duplicate detection is independent of the hit policy

- **Given** CLI-125's workbook plus a `policy` column `FIRST`.
- **When** `--analyze`.
- **Then** a `duplicate` finding for `rule_1`/`rule_2` is still reported.
- **Source** **spec silent**; identical inputs are suspicious under every policy.

### CLI-127: overlaps are not reported under FIRST, RULE ORDER or COLLECT

- **Given** W-OVL plus a `policy` column set to `FIRST`, `RULE ORDER`, `COLLECT` (three runs).
- **When** `--analyze`.
- **Then** no `overlap` finding in any run (overlap is the intended behaviour for these policies).
- **Source** spec §3.4 (these policies allow several matches by definition). **spec silent** on the analyzer's policy filter.

### CLI-128: ANY with overlapping rules and different outputs is reported; same outputs are not

- **Given** W-OVL plus `policy` = `ANY` (rows 5/6 have outputs `1` and `2`); variant with row 6 output `1`.
- **When** `--analyze` on each.
- **Then** first: an `overlap` finding for `rule_1`/`rule_2` (warning level); second: none.
- **Source** DMN 1.3 ANY semantics (overlapping rules must agree on output). **spec silent** on severity.

### CLI-129: shadowed rule under FIRST

- **Given** sheet `Sh DMN`, id `SH`, `policy` = `FIRST`, input `region` (`string`), output `fee` (`integer`); rows: `-` → `1`, `"EU"` → `2`.
- **When** `--analyze`.
- **Then** stdout contains a `shadowed` finding naming `rule_2`.
- **Source** README ("shadowed"), spec §3.4 (FIRST returns the first match, so a later rule fully covered by an earlier one never fires).

### CLI-130: no shadowed finding when the later rule is not covered

- **Given** CLI-129 with rows reversed (`"EU"` → `2`, then `-` → `1`).
- **When** `--analyze`.
- **Then** no `shadowed` finding.
- **Source** as CLI-129.

### CLI-131: gaps are reported for finite domains

- **Given** sheet `Gap DMN`, id `GAP`, config `ALLOWED_VALUES_LAYOUT`, input `region` (`string`, allowed `"EU","US","APAC"`), input `member` (`boolean`, allowed blank), output `fee` (`integer`); rules: `"EU"`,`true`→`1`; `"US"`,`-`→`2`.
- **When** `excel2dmn gap.xlsx --config cfg.json --analyze`.
- **Then** exit `0`; stdout contains `gaps` findings for the uncovered combinations `[EU, false]`, `[APAC, true]`, `[APAC, false]` (3 lines; the order of the values inside the brackets follows the input columns) and a coverage summary saying 3 of 6 combinations are uncovered (`50.0%`).
- **Source** spec §3.6 ("Enables gap/overlap analysis — finite domains make completeness checking possible"), README.

### CLI-132: no gap analysis when a domain is not finite

- **Given** W-OVL (a numeric `amount` input without allowed values).
- **When** `--analyze`.
- **Then** no `gaps` finding at all (neither combinations nor coverage line).
- **Source** spec §3.6 (gap analysis needs finite domains).

### CLI-133: full coverage reports no gaps

- **Given** CLI-131 with an extra rule `-`,`-`→`9` and policy `FIRST`.
- **When** `--analyze`.
- **Then** no `gaps` finding.
- **Source** spec §3.6.

### CLI-134: clean table prints no analysis noise

- **Given** W1. **When** `excel2dmn one_DMN.xlsx --analyze`.
- **Then** exit `0`; stdout contains no line with `overlap`, `duplicate`, `shadowed` or `gaps`.
- **Source** **spec silent** on a "no issues" line; either nothing or a single "no issues" line is acceptable.

### CLI-135: `--analyze` still writes the DMN

- **Given** W-OVL. **When** `excel2dmn ovl_DMN.xlsx --analyze --out-dir out`.
- **Then** `out/OVL.dmn` exists and re-parses cleanly.
- **Source** spec §7 (`--analyze` is an addition to convert, not a mode).

### CLI-136: `--analyze --validate-only` analyzes without writing

- **Given** W-OVL. **When** `excel2dmn ovl_DMN.xlsx --analyze --validate-only`.
- **Then** exit `0`; stdout contains the `overlap` finding of CLI-120; no `.dmn` written.
- **Source** spec §7 (both flags documented independently); §8 (CI gate).

### CLI-137: config `analysis.enabled: true` runs analysis without the flag

- **Given** W-OVL, config `{ "analysis": { "enabled": true } }`.
- **When** convert with `--config cfg.json` (no `--analyze`).
- **Then** stdout contains the `overlap` finding.
- **Source** `excel2dmn.config.example.json` `analysis.enabled`; spec §7.1 (flags map onto config paths).

### CLI-138: config `analysis.checks` limits the checks

- **Given** CLI-125's workbook (duplicate + overlap), config `{ "analysis": { "checks": ["duplicate"] } }`.
- **When** `--analyze`.
- **Then** stdout contains `duplicate` and no `overlap`.
- **Source** `excel2dmn.config.example.json` `analysis.checks`.

### CLI-139: `analysis.failOn: "error"` turns an error finding into exit 1

- **Given** W-OVL (UNIQUE overlap is error-level), config `{ "analysis": { "failOn": "error" } }`.
- **When** `--analyze`.
- **Then** exit `1`; the finding is printed; the `.dmn` is still written (analysis runs on a valid model). **spec silent** on whether the DMN is kept; keeping it matches "convert + report".
- **Source** `excel2dmn.config.example.json` `analysis.failOn`; the wizard offers `none` / `any` / `error`.

### CLI-140: `analysis.failOn: "error"` ignores warnings

- **Given** CLI-129's FIRST workbook (only a `shadowed` warning), config `{ "analysis": { "failOn": "error" } }`.
- **When** `--analyze`.
- **Then** exit `0`.
- **Source** as CLI-139.

### CLI-141: `analysis.failOn: "any"` fails on warnings too

- **Given** CLI-129's workbook, config `{ "analysis": { "failOn": "any" } }`.
- **When** `--analyze`.
- **Then** exit `1`.
- **Source** as CLI-139.

### CLI-142: `analysis.failOn: "none"` (default) never fails

- **Given** W-OVL. **When** `--analyze` (default config).
- **Then** exit `0`.
- **Source** `excel2dmn.config.example.json` (`failOn: "none"`).

### CLI-143: `analysis.format: "json"` prints machine-readable findings

- **Given** W-OVL, config `{ "analysis": { "format": "json" } }`.
- **When** `--analyze`.
- **Then** stdout contains a JSON document (parseable after removing the success line) that holds `decisionId: "OVL"` and a `findings` array with an entry `{ check: "overlap", severity: "error", message: <mentions rule_1 and rule_2> }`.
- **Source** `excel2dmn.config.example.json` `analysis.format`. **spec silent** on the JSON shape; this is the minimum needed to be useful.

### CLI-144: analysis runs per sheet on a multi-sheet workbook

- **Given** a workbook with sheets `Ovl DMN` (W-OVL) and `Rates DMN` (W1).
- **When** `--analyze`.
- **Then** exit `0`; both `.dmn` written; the `overlap` finding names `OVL`; no finding names `RATES`.
- **Source** spec §3 intro (sheets independent).

---

## J. Config file discovery, precedence and validation

### CLI-150: `./excel2dmn.config.json` in cwd is picked up automatically

- **Given** W1, cwd config `{ "camunda": { "historyTimeToLive": "P30D" } }`.
- **When** `excel2dmn one_DMN.xlsx`.
- **Then** succeeds; `<decision … camunda:historyTimeToLive="P30D">`.
- **Source** spec §7 (`--config` default: `./excel2dmn.config.json` if present), §7.1 precedence.

### CLI-151: the cwd config is looked up in cwd, not beside the input

- **Given** W1 at `T/in/one_DMN.xlsx`; `T/in/excel2dmn.config.json` = `{ "camunda": { "historyTimeToLive": "P30D" } }`; cwd is `T` (which has no config).
- **When** `excel2dmn in/one_DMN.xlsx`.
- **Then** succeeds; `historyTimeToLive="P180D"` (the default; the file beside the input is not read).
- **Source** spec §7.1 ("`excel2dmn.config.json` in CWD").

### CLI-152: `--config` beats the cwd config

- **Given** W1, cwd config `{ "camunda": { "historyTimeToLive": "P30D" } }`, config `{ "camunda": { "historyTimeToLive": "P60D" } }`.
- **When** `excel2dmn one_DMN.xlsx --config cfg.json`.
- **Then** `historyTimeToLive="P60D"`.
- **Source** spec §7.1 precedence.

### CLI-153: with `--config`, keys only in the cwd config are not applied

- **Given** W1, cwd config `{ "camunda": { "versionTag": "9.9" } }`, config `{ "camunda": { "historyTimeToLive": "P60D" } }`.
- **When** `excel2dmn one_DMN.xlsx --config cfg.json`.
- **Then** `historyTimeToLive="P60D"` and **no** `camunda:versionTag` attribute.
- **Source** spec §7 synopsis (`--config <file>` "default: ./excel2dmn.config.json if present", i.e. `--config` replaces the default file). **spec conflict** (mild): §7.1 lists the two as precedence levels, which could be read as layering. This scenario follows §7; the chosen behaviour must be documented either way.

### CLI-154: CLI flag beats `--config` beats cwd config beats defaults (full chain)

- **Given** W1 with no policy column; cwd config `{ "hitPolicy": { "default": "ANY" }, "output": { "namespace": "urn:cwd" } }`; `cfg.json` = `{ "hitPolicy": { "default": "COLLECT" } }`.
- **When** four runs, each into its own `--out-dir`:
  1. `excel2dmn one_DMN.xlsx` → `hitPolicy="ANY"`, `namespace="urn:cwd"`.
  2. `excel2dmn one_DMN.xlsx --config cfg.json` → `hitPolicy="COLLECT"`, `namespace="http://camunda.org/schema/1.0/dmn"` (default; see CLI-153).
  3. `excel2dmn one_DMN.xlsx --config cfg.json --hit-policy FIRST` → `hitPolicy="FIRST"`.
  4. Run 1 with the cwd config deleted → no `hitPolicy` attribute (UNIQUE), default namespace.
- **Then** as listed, all exit `0` (output `result` retyped to `integer` so COLLECT is meaningful).
- **Source** spec §7.1 ("CLI flags → `--config <file>` → `excel2dmn.config.json` in CWD → built-in defaults").

### CLI-155: config is deep-merged over the defaults

- **Given** W1, config `{ "markers": { "id": "KEY" } }`, sheet's `id` marker replaced by `KEY`.
- **When** convert.
- **Then** succeeds: `KEY` is the id marker while `input`/`output` (not mentioned in the config) still work.
- **Source** spec §7.1 ("Config is deep-merged over defaults"; "every field has a default").

### CLI-156: arrays in config replace, not merge

- **Given** W1 with B6 = `*` and config `{ "rules": { "anyInputTokens": ["*"] } }`.
- **When** convert with `--json`.
- **Then** succeeds; `rules[1].inputEntries` is `[""]` (the `*` was treated as "any").
- **And** a second run with B6 = `-` and the same config also succeeds (`-` is still a valid FEEL wildcard), but the model keeps `"-"` verbatim instead of `""`, which proves the default token list was replaced rather than merged.
- **Source** spec §3.3 (`rules.anyInputTokens` configurable), §7.1. **spec silent** on array-merge semantics; replacing is the only way to remove a default token.

### CLI-157: an empty config object `{}` works out of the box

- **Given** W1, `T/cfg.json` = `{}`.
- **When** `excel2dmn one_DMN.xlsx --config cfg.json`.
- **Then** succeeds; output byte-identical to a run without any config.
- **Source** spec §7.1 ("an empty or absent config file works out of the box").

### CLI-158: a zero-byte config file works out of the box

- **Given** W1, `T/cfg.json` is an empty file (0 bytes).
- **When** `excel2dmn one_DMN.xlsx --config cfg.json`.
- **Then** succeeds; output byte-identical to a run without any config.
- **Source** spec §7.1 ("an **empty** or absent config file works out of the box").

### CLI-159: a zero-byte cwd config works out of the box

- **Given** W1, `T/excel2dmn.config.json` is 0 bytes.
- **When** `excel2dmn one_DMN.xlsx`.
- **Then** succeeds as CLI-158.
- **Source** spec §7.1.

### CLI-160: `--config` pointing at a missing file

- **Given** W1. **When** `excel2dmn one_DMN.xlsx --config missing.json`.
- **Then** fails; stderr names `missing.json`; no `.dmn` written.
- **Source** spec §7.1 ("ajv-checked at startup with clear errors"). **spec silent** on the missing-file case; failing is required since the user asked for that file explicitly.

### CLI-161: invalid JSON in `--config`

- **Given** W1, `T/cfg.json` = `{ "platform": "camunda8", }` (trailing comma).
- **When** `excel2dmn one_DMN.xlsx --config cfg.json`.
- **Then** fails; stderr names `cfg.json` and says it could not be read/parsed; no stack trace; no `.dmn` written.
- **Source** spec §7.1 ("clear errors").

### CLI-162: invalid JSON in the cwd config

- **Given** W1, `T/excel2dmn.config.json` = `not json`.
- **When** `excel2dmn one_DMN.xlsx`.
- **Then** fails as CLI-161, naming `excel2dmn.config.json`.
- **Source** spec §7.1.

### CLI-163: config that is valid JSON but not an object

- **Given** W1, `T/cfg.json` = `[1, 2]` (and, in a second run, `"text"`, and in a third, `null`).
- **When** convert with `--config cfg.json`.
- **Then** each run fails with a message that the config must be a JSON object; no `.dmn`.
- **Source** spec §7.1 (validated against `schema/config.schema.json`). **spec silent** on the exact case.

### CLI-164: unknown `platform` value in config

- **Given** W1, config `{ "platform": "zeebe" }`.
- **When** convert.
- **Then** fails naming `zeebe` and the allowed values `camunda7` / `camunda8`.
- **Source** spec §7.1 (`platform`: "camunda7" | "camunda8"; config validated at startup).

### CLI-165: unknown `sheet.match` value

- **Given** W1, config `{ "sheet": { "match": "fuzzy" } }`.
- **When** convert.
- **Then** fails naming `sheet.match` and `fuzzy` (allowed: `contains`, `regex`, `exact`); no `.dmn`.
- **Source** spec §7.1 (`"contains" | "regex" | "exact"`; "validated against `schema/config.schema.json` … with clear errors").

### CLI-166: unknown `hitPolicy.default` in config

- **Given** W1, config `{ "hitPolicy": { "default": "SOMETIMES" } }`.
- **When** convert.
- **Then** fails naming `SOMETIMES`; no `.dmn`.
- **Source** spec §3.4, §7.1.

### CLI-167: unknown `output.namespaceStyle`

- **Given** W1, config `{ "output": { "namespaceStyle": "weird" } }`.
- **When** convert.
- **Then** fails naming `output.namespaceStyle` and `weird` (allowed `default` / `prefixed`).
- **Source** spec §7.1.

### CLI-168: unknown `identity.idCase`

- **Given** W1, config `{ "identity": { "idCase": "lower" } }`.
- **When** convert.
- **Then** fails naming `identity.idCase` (allowed `upper` / `preserve`).
- **Source** spec §7.1.

### CLI-169: unknown `types.nonCamundaTypeAction`

- **Given** W1, config `{ "types": { "nonCamundaTypeAction": "ignore" } }`.
- **When** convert.
- **Then** fails naming `types.nonCamundaTypeAction` (allowed `error` / `warn` / `off`).
- **Source** spec §7.1.

### CLI-170: unknown `validation.feel.mode`

- **Given** W1, config `{ "validation": { "feel": { "mode": "some" } } }`.
- **When** convert.
- **Then** fails naming `validation.feel.mode` (allowed `all-inputs` / `any-inputs` / `off`).
- **Source** spec §5 Step 3b, §7.1.

### CLI-171: unknown `analysis.failOn` / `analysis.format`

- **Given** W1, config `{ "analysis": { "failOn": "sometimes" } }`; second run `{ "analysis": { "format": "yaml" } }`.
- **When** convert with `--analyze`.
- **Then** each fails naming the key and the bad value.
- **Source** `excel2dmn.config.example.json`, spec §7.1 (config validated at startup).

### CLI-172: wrong value type for a known key

- **Given** W1, config `{ "header": { "scanRows": "five" } }`; second run `{ "markers": { "caseInsensitive": "yes" } }`.
- **When** convert.
- **Then** each fails naming the key path and the expected type (integer / boolean).
- **Source** spec §7.1 (ajv validation).

### CLI-173: unknown top-level key is reported

- **Given** W1, config `{ "platfrom": "camunda8" }` (typo).
- **When** convert.
- **Then** exit `0`; stderr has one `unknown config key "<path>"` warning per unknown key, naming its full path (also nested ones such as `header.scanrows` and `types.number.allowExpression`); a top-level `$schema` is not reported; the typo falls back to the default (a Camunda 7 file).
- **Source** spec §7.1 "Unknown keys" (decided: a stderr warning, not an error).

### CLI-174: config validation errors are reported all at once

- **Given** W1, config `{ "platform": "zeebe", "sheet": { "match": "fuzzy" } }`.
- **When** convert.
- **Then** fails; stderr names both `platform` and `sheet.match`.
- **Source** spec §7.1 ("clear errors"); spec's general "collect and report together" rule (§5).

### CLI-175: `--config` applies to `init`

- **Given** config `{ "markers": { "id": "KEY", "input": "in", "output": "out" } }`.
- **When** `excel2dmn init --config cfg.json -o t_DMN.xlsx`.
- **Then** succeeds; the template's marker row contains `KEY`, `in`, `out` and not `id`/`input`/`output`.
- **Source** spec §7.2 ("Keep the generator config-aware: if the user renamed markers … `init` writes the renamed markers").

### CLI-176: cwd config applies to `init` too

- **Given** cwd config as CLI-175. **When** `excel2dmn init`.
- **Then** `T/decision_DMN.xlsx` uses the renamed markers.
- **Source** spec §7.1 (cwd config is the default config for the tool), §7.2.

### CLI-177: `types.nonCamundaTypeAction: "warn"` prints the warning and succeeds

- **Given** W1 with `amount` typed `number`, config `{ "types": { "nonCamundaTypeAction": "warn" } }`.
- **When** convert.
- **Then** exit `0`; `RATES.dmn` written with `typeRef="number"`; stderr (or stdout) contains a warning naming `Rates DMN!B3` and `number`.
- **Source** spec §7.1 (`"warn"`), spec §3.1 type row. A warning nobody sees is not a warning, so it must be printed.

### CLI-178: `types.nonCamundaTypeAction: "off"` is silent

- **Given** as CLI-177 with `"off"`.
- **When** convert.
- **Then** exit `0`; stderr empty; no warning text on stdout.
- **Source** spec §7.1.

### CLI-174a: invalid regex in `sheet.value` is a config error

- **Given** W1, config `{ "sheet": { "match": "regex", "value": "([" } }`.
- **When** convert.
- **Then** exit `1`; stderr says `sheet.value is not a valid regular expression`; nothing written.
- **Source** spec §7.1 ("clear errors").

### CLI-179: zero input columns: warn but continue

- **Given** sheet `NoIn DMN`: `id` = `NOIN`, one `output` `result` (`string`), rows 5 `"A"`.
- **When** convert.
- **Then** exit `0`; `NOIN.dmn` written with no `<input>` and one rule; a warning about zero inputs is printed (naming `NoIn DMN`).
- **Source** spec §5 Step 2 ("Zero `input` columns is allowed by DMN (rare) — warn but continue").

### CLI-179a: `enforceAllowedValues` rejects an out-of-domain input whatever `validation.feel.mode` is

- **Given** sheet `Dom DMN` with the allowed-values layout: `id` = `DOM`, `input` `region` (`string`) with allowed values `"EU","US"`, `output` `result` (`string`), one rule `"APAC"` → `"X"`; config with `validation.enforceAllowedValues: true` and `validation.feel.mode` `all-inputs`, `any-inputs`, `off` in turn.
- **When** convert.
- **Then** each run exits `1`, naming `Dom DMN!B6` and that the value is outside the allowed values; nothing written.
- **Source** spec §3.6 (domain checks are independent of FEEL validation).

---

## K. Marker and sheet customization via config

### CLI-190: renamed markers are recognized

- **Given** W1 with marker row `KEY | in | out`, config `{ "markers": { "id": "KEY", "input": "in", "output": "out" } }`.
- **When** convert.
- **Then** succeeds; same DMN content as W1 (decision `RATES`, input `amount`, output `result`).
- **Source** spec §7.1 rules of use ("renaming `id`→`KEY` or `input`→`in` … is a one-line config change").

### CLI-191: with renamed markers, the default keywords become helper columns

- **Given** CLI-190's config; sheet has `KEY | in | out | input` where column D has `input` / `extra` / `string` / `Extra` and rows `"x"`, `"y"`.
- **When** convert with `--json`.
- **Then** succeeds; the model has exactly one input (`amount`); no `extra` anywhere in the DMN.
- **Source** spec §3.2 ("Only the exact keywords in `markers.*` … are roles; everything else is a helper column").

### CLI-192: marker matching is case-insensitive and trimmed by default

- **Given** W1 with marker row ` ID  | INPUT | Output`.
- **When** convert.
- **Then** succeeds; same content as W1.
- **Source** spec §3.2 ("case-insensitive, trimmed"), §7.1 `markers.caseInsensitive: true`.

### CLI-193: `markers.caseInsensitive: false` makes markers exact

- **Given** W1 with marker row `ID | input | output`, config `{ "markers": { "caseInsensitive": false } }`.
- **When** convert.
- **Then** fails; the `ID` column is a helper, so stderr says the required `id` marker column is missing (spec: "Missing required ID marker column in <sheet>"), naming `Rates DMN`.
- **Source** spec §7.1 `markers.caseInsensitive`, §5 Step 2.

### CLI-194: renamed `annotations` marker and custom separator

- **Given** W1 plus two columns marked `note` with rows 5 `a` / `b`, config `{ "markers": { "annotations": "note", "annotationSeparator": " // " } }`.
- **When** convert with `--json`.
- **Then** `rules[0].description` is `a // b`; `<rule id="rule_1"><description>a // b</description>`.
- **Source** spec §3.2 (`annotations`, separator), §7.1.

### CLI-195: renamed `policy` and `name` markers

- **Given** W1 plus columns `hp` (`FIRST`) and `title` (`Rates Title`), config `{ "markers": { "policy": "hp", "name": "title" } }`.
- **When** convert.
- **Then** `hitPolicy="FIRST"`, `<decision id="RATES" name="Rates Title">`.
- **Source** spec §7.1 `markers`.

### CLI-196: `sheet.value` changes the sheet filter

- **Given** a workbook with sheets `Rates TABLE` (W1 data) and `Other DMN` (W1 data, id `OTHER`); config `{ "sheet": { "value": "TABLE" } }`.
- **When** convert.
- **Then** succeeds; only `RATES.dmn` written.
- **Source** spec §7.1 `sheet.value`.

### CLI-197: `sheet.match: "exact"`

- **Given** a workbook with sheets `DMN` (id `A`) and `My DMN` (id `B`); config `{ "sheet": { "match": "exact", "value": "DMN" } }`.
- **When** convert.
- **Then** only `A.dmn` written.
- **Source** spec §7.1.

### CLI-198: `sheet.match: "regex"`

- **Given** sheets `Rates_ DMN` (id `A`), `DMN old` (id `B`); config `{ "sheet": { "match": "regex", "value": "_?\\s?DMN$" } }`.
- **When** convert.
- **Then** only `A.dmn` written.
- **Source** spec §7.1 rules of use (the exact regex example).

### CLI-199: invalid regex in `sheet.value`

- **Given** W1, config `{ "sheet": { "match": "regex", "value": "([" } }`.
- **When** convert.
- **Then** fails naming `sheet.value` / the bad pattern; no stack trace.
- **Source** spec §7.1 ("clear errors"). **spec silent** on this case.

### CLI-200: `sheet.caseInsensitive: false`

- **Given** sheets `rates dmn` (id `A`) and `Other DMN` (id `B`); config `{ "sheet": { "caseInsensitive": false } }`. (Excel sheet names are unique case-insensitively, so `rates dmn` and `Rates DMN` cannot coexist in one workbook.)
- **When** convert.
- **Then** only `B.dmn` written.
- **Source** spec §7.1 `sheet.caseInsensitive`.

### CLI-201: `header.scanRows` limits marker-row discovery

- **Given** W1 shifted down so the marker row is row 7 (rows 1–6 blank except a title `Rates` in A1); default config.
- **When** convert.
- **Then** fails; stderr says no marker row found in the first 5 rows of `Rates DMN`.
- **And** with config `{ "header": { "scanRows": 7 } }` the same workbook succeeds and the model's first rule has `row: 11`.
- **Source** spec §3.1 (scan rows 1–5), §7.1 `header.scanRows`.

### CLI-202: custom header offsets

- **Given** a sheet whose rows below the marker are: label (M+1), type (M+2), name (M+3), rules from M+4; config `{ "header": { "nameOffset": 3, "typeOffset": 2, "labelOffset": 1 } }`.
- **When** convert with `--json`.
- **Then** succeeds; inputs/outputs have the expected `expression`/`name`, `typeRef` and `label`.
- **Source** spec §3.1 ("Every header row is an independent integer offset"), §7.1.

### CLI-203: `rules.idTemplate` with `<row>`

- **Given** W1, config `{ "rules": { "idTemplate": "r<row>" } }`.
- **When** convert with `--json`.
- **Then** rule ids are `r5`, `r6` in both the model and the DMN.
- **Source** spec §7.1 rules of use ("`<row>` for the Excel row").

### CLI-203a: `identity.collisionSuffix` de-duplicates rule ids from a fixed `idTemplate`

- **Given** W1, config `{ "rules": { "idTemplate": "rule" }, "identity": { "collisionSuffix": "-" } }`.
- **When** convert.
- **Then** succeeds; the rule ids are `rule`, `rule-2`.
- **Source** spec §7.1 (`collisionSuffix` applies to ids inside one decision).

### CLI-204: `identity.idCase: "preserve"`

- **Given** W1 with id `Rates Table`, config `{ "identity": { "idCase": "preserve" } }`.
- **When** convert.
- **Then** decision id `Rates_Table`; file `Rates_Table.dmn`.
- **Source** spec §7.1 `identity.idCase`.

### CLI-205: `identity.sanitizeId: false`

- **Given** W1 with id `RatesTable`, config `{ "identity": { "sanitizeId": false } }`.
- **When** convert.
- **Then** decision id `RatesTable` (unchanged, not upper-cased); file `RatesTable.dmn`.
- **Source** spec §7.1 `identity.sanitizeId`.

---

## L. `init`

### CLI-210: default `init` writes `decision_DMN.xlsx` in cwd

- **Given** empty `T`. **When** `excel2dmn init`.
- **Then** exit `0`; `T/decision_DMN.xlsx` exists; stdout names that path; the workbook has exactly one sheet, whose name contains `DMN`.
- **Source** spec §7.2 ("default `decision_DMN.xlsx` with a single `… DMN` sheet").

### CLI-211: the default template converts cleanly

- **Given** the output of CLI-210.
- **When** `excel2dmn decision_DMN.xlsx --out-dir out`.
- **Then** succeeds; exactly one `.dmn` written; `parseDmn` reports 0 warnings; the decision has at least one input, one output and 2–3 rules; at least one rule has a `<description>` (annotations column present).
- **Source** spec §7.2 ("The generated file must round-trip — running `excel2dmn` on a freshly `init`-ed workbook produces a valid `.dmn` with 0 warnings (add this as a test)").

### CLI-212: template layout: marker row content

- **Given** the output of CLI-210, read with `readWorkbook`.
- **Then** row 1 holds `policy`, `id`, `name`, at least two `input`, one `output`, and one `annotations` marker; the `input`/`output` columns have non-empty name (row 2), type (row 3) and label (row 4); the types used come from `string` / `integer` / `boolean` and similar Camunda types.
- **Source** spec §7.2 bullet list.

### CLI-213: template has an instructions helper the converter ignores

- **Given** the output of CLI-210.
- **Then** the sheet holds a cell with explanatory text about the markers, in a column whose marker cell is not a recognized keyword; converting (CLI-211) does not mention this text in the DMN.
- **Source** spec §7.2 ("A short instructions helper column / cell explaining each marker (ignored by the converter)").

### CLI-214: `--name` sets decision name and derived id

- **Given** empty `T`. **When** `excel2dmn init --name "Shipping Rate Decision" -o s_DMN.xlsx`, then convert `s_DMN.xlsx`.
- **Then** both exit `0`; `SHIPPING_RATE_DECISION.dmn` written with `<decision id="SHIPPING_RATE_DECISION" name="Shipping Rate Decision">`.
- **Source** README ("`excel2dmn init --name "Shipping Rate Decision" -o shipping_DMN.xlsx`"), spec §7.2, §6.4 (id sanitization; name verbatim).

### CLI-215: `--name` with diacritics folds the id

- **Given** empty `T`. **When** `excel2dmn init --name "Zürich Süd" -o z_DMN.xlsx`, then convert.
- **Then** decision id `ZURICH_SUD`, name `Zürich Süd`.
- **Source** spec §6.4 (verified: `Zürich Süd` → `ZURICH_SUD`).

### CLI-216: `--name` with letters NFD cannot decompose uses the fold map

- **Given** empty `T`. **When** `excel2dmn init --name "Straße Łódź" -o s_DMN.xlsx`, then convert.
- **Then** decision id `STRASSE_LODZ`; name `Straße Łódź`.
- **Source** spec §6.4 (FOLD map is "required"; `Straße` → `STRASSE`). **spec silent** on init's own id derivation; the template id must equal what the converter's sanitizer would produce from the name.

### CLI-217: `--name` starting with a digit

- **Given** empty `T`. **When** `excel2dmn init --name "2026 Rates" -o r_DMN.xlsx`, then convert.
- **Then** decision id `_2026_RATES`; conversion succeeds.
- **Source** spec §6.4 ("NCName must not start with a digit").

### CLI-218: `-o` / `--out` writes to the given path

- **Given** empty `T`. **When** `excel2dmn init -o templates/x_DMN.xlsx` (with `T/templates` existing) and `excel2dmn init --out y_DMN.xlsx`.
- **Then** both files exist; no `decision_DMN.xlsx` in `T`.
- **Source** spec §7.2 (`--out <file>`), README.

### CLI-219: `init -o` into a missing directory

- **Given** empty `T`. **When** `excel2dmn init -o new/dir/x_DMN.xlsx`.
- **Then** exit `0` and `T/new/dir/x_DMN.xlsx` exists.
- **Source** **spec silent**; consistent with CLI-033 (convert creates its output directories). A clear one-line error with exit 1 would be the acceptable alternative; a raw `ENOENT` stack trace is not.

### CLI-220: `--sheet` sets the sheet name

- **Given** empty `T`. **When** `excel2dmn init --sheet "Pricing DMN" -o p.xlsx`, then convert `p.xlsx`.
- **Then** the workbook's only sheet is `Pricing DMN`; conversion succeeds.
- **Source** spec §7.2 (`--sheet "<Sheet name>"`).

### CLI-221: `--sheet` without `DMN` in the name warns

- **Given** empty `T`. **When** `excel2dmn init --sheet "Pricing" -o p.xlsx`.
- **Then** exit `0`; the file is written; a warning on stderr says the sheet name does not match the configured sheet filter (`DMN`) so `excel2dmn` will not convert it.
- **Source** spec §7.2 (decided: write the file and warn). Converting `p.xlsx` afterwards fails as in CLI-014.

### CLI-221a: `--sheet` violating Excel's sheet-name rules is rejected

- **Given** empty `T`. **When** `excel2dmn init --sheet <name> -o p.xlsx` with a name longer than 31 characters, or containing one of `: \ / ? * [ ]`.
- **Then** exit `1`; stderr names the sheet and the violated rule; no file written.
- **Source** Excel's sheet-name rules. **spec silent**.

### CLI-222: `--minimal` drops the annotation column and example rules

- **Given** empty `T`. **When** `excel2dmn init --minimal -o m_DMN.xlsx`.
- **Then** exit `0`; the marker row has no `annotations` marker; there are no data rows below the label row.
- **Source** spec §7.2 (`--minimal` "skip the example rules / annotation column").

### CLI-223: a minimal template fails conversion until rules are added

- **Given** CLI-222's file.
- **When** convert.
- **Then** fails with `no rules` naming the sheet (spec text: "No rules found in <sheet> (no data rows below the header)").
- **And** after appending one rule row (e.g. `"A"`, `1`, `"X"` under the input/output columns) the conversion succeeds.
- **Source** spec §5 Step 3 (no rule rows ⇒ abort). **spec conflict** (mild): §7.2 asks that a freshly init-ed workbook round-trip; this scenario reads that for the default template only, since `--minimal` explicitly has no rules.

### CLI-224: `init` with the allowed-values layout writes a 5-row header

- **Given** config `ALLOWED_VALUES_LAYOUT`.
- **When** `excel2dmn init --config cfg.json -o av_DMN.xlsx`, then `excel2dmn av_DMN.xlsx --config cfg.json`.
- **Then** both succeed; the template has the allowed-values row (row 4) between type (row 3) and label (row 5), with at least one sample list (e.g. `"A","B"`); the DMN contains at least one `<inputValues>` or `<outputValues>`.
- **Source** spec §7.2 ("5-row when allowed values are enabled, else 4-row"; "when enabled a sample allowed-values cell"), §3.6.

### CLI-225: the 4-row template does not convert under the 5-row config (layout mismatch is detected)

- **Given** CLI-210's default template.
- **When** convert with config `ALLOWED_VALUES_LAYOUT`.
- **Then** exit `1` with a coordinate error (the label row is read as allowed values, or the first rule row is read as the label), not a silently wrong DMN.
- **Source** spec §3.1 (offsets are read independently), §5 Step 3b. **spec silent** on the exact message.

### CLI-226: `init` honours `hitPolicy.default` from config

- **Given** config `{ "hitPolicy": { "default": "FIRST" } }`.
- **When** `excel2dmn init --config cfg.json -o f_DMN.xlsx`, then convert with no config.
- **Then** the template's policy cell (row 2 of the `policy` column) is `FIRST`; the DMN has `hitPolicy="FIRST"`.
- **Source** spec §7.2 ("header pre-populated from the current config").

### CLI-227: `init` for Camunda 8 converts with `--platform camunda8`

- **Given** config `{ "platform": "camunda8" }`.
- **When** `excel2dmn init --config cfg.json -o c8_DMN.xlsx`, then `excel2dmn c8_DMN.xlsx --config cfg.json`.
- **Then** both succeed; the DMN has `modeler:executionPlatform="Camunda Cloud"`; the template's types also convert under Camunda 7 (`excel2dmn c8_DMN.xlsx` with no config succeeds).
- **Source** spec §6.6 (C7 templates convert to valid C8 without edits), §7.2.

### CLI-228: `init` with renamed markers round-trips with the same config

- **Given** config `{ "markers": { "id": "KEY", "input": "in", "output": "out", "policy": "hp", "name": "title", "annotations": "note" } }`.
- **When** `excel2dmn init --config cfg.json -o k_DMN.xlsx`, then `excel2dmn k_DMN.xlsx --config cfg.json`.
- **Then** both succeed; the DMN equals (byte-for-byte) the DMN produced from a default `init` + default convert with the same `--name`.
- **Source** spec §7.2 (config-aware generator).

### CLI-229: `init` over an existing file

- **Given** `T/decision_DMN.xlsx` exists (any content).
- **When** `excel2dmn init`.
- **Then** exit `1`; the message names the file and `--force`; the file is unchanged. `excel2dmn init --force` then replaces it with a template that converts.
- **Source** spec §7.2 (decided: refuse without `--force`).

### CLI-230: `init` output re-imports the example rules exactly

- **Given** CLI-210's template, converted with `--json`.
- **Then** the model's rule entries equal the cells written in the template's example rows (inputs, outputs and the annotation text as `description`).
- **Source** spec §3.3, §4.1.

---

## M. `config`

### CLI-240: `config --defaults` writes the full default config

- **Given** empty `T`. **When** `excel2dmn config --defaults`.
- **Then** exit `0`; `T/excel2dmn.config.json` exists; stdout names it; the file parses as JSON and deep-equals `DEFAULT_CONFIG` (exported from `src/index.js`); the file ends with a newline.
- **Source** README ("`excel2dmn config --defaults` non-interactive: write the full default config").

### CLI-241: `-y` is the short form of `--defaults`

- **Given** empty `T`. **When** `excel2dmn config -y`.
- **Then** same as CLI-240.
- **Source** **spec silent**; `--help` (CLI-005) documents it.

### CLI-242: the defaults equal the checked-in example config

- **Given** CLI-240's output.
- **Then** it deep-equals `excel2dmn.config.example.json` from the repo root.
- **Source** README ("`excel2dmn.config.example.json` is a checked-in copy of the complete default config").

### CLI-243: a defaults config changes nothing

- **Given** W1 and CLI-240's `excel2dmn.config.json` in cwd.
- **When** convert W1.
- **Then** the DMN is byte-identical to converting W1 with no config.
- **Source** spec §7.1 ("the values shown are the defaults").

### CLI-244: `config -o` chooses the output path

- **Given** empty `T`. **When** `excel2dmn config --defaults -o my.config.json`.
- **Then** `T/my.config.json` exists; `T/excel2dmn.config.json` does not.
- **Source** README (`excel2dmn config -o my.config.json`).

### CLI-245: existing file is protected without `--force` (non-interactive)

- **Given** `T/excel2dmn.config.json` = `{"keep":true}`.
- **When** `excel2dmn config --defaults` (stdin is not a TTY).
- **Then** exit `1`; stderr names the file and mentions `--force`; the file still contains exactly `{"keep":true}`.
- **Source** README / `--help` (`--force` "overwrite an existing file without confirmation"). **spec silent** on the non-TTY case; refusing is the only safe default.

### CLI-246: `--force` overwrites

- **Given** as CLI-245. **When** `excel2dmn config --defaults --force`.
- **Then** exit `0`; the file now deep-equals the default config.
- **Source** as CLI-245.

### CLI-247: `-o` target protection works for custom paths too

- **Given** `T/my.json` exists. **When** `excel2dmn config --defaults -o my.json`.
- **Then** exit `1`; `my.json` unchanged. With `--force`: exit `0`, overwritten.
- **Source** as CLI-245.

### CLI-248: `config --defaults --full` still writes the full config

- **Given** empty `T`. **When** `excel2dmn config --defaults --full`.
- **Then** same file content as CLI-240.
- **Source** README (`--full` writes every key; `--defaults` already writes the full default config).

### CLI-249: `config -o` into a missing directory

- **Given** empty `T`. **When** `excel2dmn config --defaults -o sub/c.json`.
- **Then** **spec silent**. Reasonable: exit `0` and the directory is created; acceptable alternative: exit `1` with a one-line error naming the path (no stack trace).
- **Source** none (spec silent).

### CLI-250: interactive wizard via stdin: all defaults gives a minimal empty config

- **Given** empty `T`.
- **When** `excel2dmn config` with `input` = a newline for every prompt (enough newlines for the essential prompts plus the "advanced?" prompt, e.g. 30 × `\n`).
- **Then** exit `0`; `T/excel2dmn.config.json` parses to `{}` (the wizard writes only keys that differ from the defaults); stdout shows the wizard's intro line and at least one `[default]` hint.
- **Source** README ("walks you through the common settings … press Enter to accept it"; "By default the wizard writes only the keys you changed (a minimal file)"). Decided: piped (non-TTY) stdin does not drive the wizard; it writes the full default config (CLI-240) and says so on stderr. CLI-251..259 therefore drive the wizard itself through `buildConfig`'s `prompt` hook (as CLI-258 does), with the same answers the scenarios list.

### CLI-251: wizard via stdin: choose Camunda 8

- **Given** empty `T`.
- **When** `excel2dmn config` with stdin answering Enter to every prompt except the "Target platform" prompt, which gets `camunda8` (or its option number `2`).
- **Then** the file parses to `{ "platform": "camunda8" }`.
- **Source** README "Configuration"; **spec silent** on piped stdin (see CLI-250).

### CLI-252: wizard via stdin: enabling allowed values writes the three-key layout

- **Given** empty `T`.
- **When** `excel2dmn config`, answering `y` to "Enable an allowed-values row" and Enter elsewhere.
- **Then** the file parses to `{ "header": { "allowedValuesOffset": 3, "labelOffset": 4 }, "rules": { "startOffset": 5 } }`.
- **Source** spec §3.1 ("enabling allowed values is the three-line config"), README.

### CLI-253: wizard via stdin with `--full`

- **Given** empty `T`.
- **When** `excel2dmn config --full` with stdin as CLI-251.
- **Then** the file deep-equals `DEFAULT_CONFIG` with `platform` set to `camunda8`.
- **Source** README ("pass `--full` to write every key").

### CLI-254: wizard re-asks on an invalid answer

- **Given** empty `T`.
- **When** `excel2dmn config`, answering `maybe` to the first boolean prompt ("Case-insensitive sheet match?"), then `n`, and Enter elsewhere.
- **Then** stdout shows an error hint (e.g. `please answer y or n`) once; the file parses to `{ "sheet": { "caseInsensitive": false } }`.
- **Source** README (step-by-step wizard). **spec silent** on validation messages.

### CLI-255: wizard: Camunda 8 hides PRIORITY / OUTPUT ORDER from the hit-policy choices

- **Given** empty `T`.
- **When** `excel2dmn config`, answering `camunda8` to the platform prompt and Enter elsewhere.
- **Then** the options line printed for "Fallback hit policy" does not contain `PRIORITY` or `OUTPUT ORDER`.
- **Source** spec §6.6 (C8 rejects these policies); a wizard must not offer a value the loader then rejects.

### CLI-256: wizard: advanced section is asked only on request

- **Given** empty `T`.
- **When** run A: Enter everywhere (advanced = no); run B: answer `y` to "Configure advanced options", then `P30D` to the `historyTimeToLive` prompt, Enter elsewhere.
- **Then** A's stdout does not contain `historyTimeToLive`; B's file parses to `{ "camunda": { "historyTimeToLive": "P30D" } }`.
- **Source** README ("walks you through the common settings (and, on request, the advanced ones)").

### CLI-257: wizard: `null` answer for a nullable key

- **Given** empty `T`.
- **When** advanced = `y`, `historyTimeToLive` answered `null`, Enter elsewhere.
- **Then** file parses to `{ "camunda": { "historyTimeToLive": null } }`; converting W1 with that config emits no `camunda:historyTimeToLive`.
- **Source** spec §6.5 ("set to `null` to omit"), §7.1.

### CLI-258: API: wizard driven by a scripted prompt

- **API** `buildConfig({ prompt, output })` where `prompt` returns answers from a list (Enter = `''`) and `output` is a writable sink.
- **Given** answers: Enter for all essentials except `markers.id` = `KEY`; advanced = `n`.
- **Then** the result deep-equals `{ markers: { id: 'KEY' } }`; with `full: true` it deep-equals `DEFAULT_CONFIG` with `markers.id = 'KEY'`.
- **Source** README "Configuration". This is the deterministic counterpart of CLI-250…257 that does not depend on TTY handling.

### CLI-259: wizard output is a loadable config

- **Given** the file produced by CLI-251.
- **When** convert W1 with that file in cwd.
- **Then** succeeds and writes Camunda 8 output (`modeler:executionPlatform` present).
- **Source** README, spec §7.1.

### CLI-260: overwrite prompt accepts `y` on a TTY

- **Given** `T/excel2dmn.config.json` exists.
- **When** `excel2dmn config --defaults` run under a pseudo-terminal, answering `y` to `… already exists — overwrite? [y/N]`.
- **Then** exit `0`; file overwritten. Answering Enter or `n`: exit `1`, file unchanged.
- **Source** `--help` for `--force` ("without confirmation" implies a confirmation otherwise). Needs a pty; mark the test `skip` when no pty helper is available (no new dependencies may be added).

### CLI-261: the wizard reads answers that arrive together on a TTY

- **Given** empty `T`; the `config -o w.json` wizard run under a pseudo-terminal.
- **When** every answer (`camunda8` for the platform, Enter elsewhere) is supplied at once as one stdin string.
- **Then** exit `0`; `w.json` parses to `{ "platform": "camunda8" }`.
- **Source** `config` wizard behaviour; regression for lines pasted together being dropped. Needs a pty; skipped when none is available.

---

## N. `import` basics

### CLI-270: import writes `<input>.xlsx` by default

- **Given** `T/RATES.dmn` produced from W1.
- **When** `excel2dmn import RATES.dmn`.
- **Then** exit `0`; `T/RATES.xlsx` exists; stdout says `imported 1 decision(s)` and names the path.
- **Source** README ("`excel2dmn import existing.dmn -o existing.xlsx`"), spec §1 goals.

### CLI-271: `import -o` chooses the path

- **Given** as CLI-270. **When** `excel2dmn import RATES.dmn -o back_DMN.xlsx`.
- **Then** `T/back_DMN.xlsx` exists; no `T/RATES.xlsx`.
- **Source** README.

### CLI-272: import → convert round-trips byte-identically

- **Given** `T/a/RATES.dmn` produced from W1.
- **When** `excel2dmn import a/RATES.dmn -o back_DMN.xlsx`, then `excel2dmn back_DMN.xlsx --out-dir b`.
- **Then** both exit `0`; `b/RATES.dmn` is byte-identical to `a/RATES.dmn`.
- **Source** README ("round-trips byte-identically"), spec §1 ("round-trips losslessly").

### CLI-273: imported workbook has a sheet the converter selects

- **Given** CLI-271's output.
- **Then** the workbook has exactly one sheet whose name contains `DMN`.
- **Source** spec §3 intro; implied by CLI-272.

### CLI-274: importing a Camunda 8 DMN prints the re-convert hint

- **Given** `T/c8/RATES.dmn` produced from W1 with `--platform camunda8`.
- **When** `excel2dmn import c8/RATES.dmn -o back_DMN.xlsx`.
- **Then** exit `0`; stdout contains `Camunda 8` and a copy-pasteable command `excel2dmn back_DMN.xlsx --platform camunda8` (path may be absolute); running that hint reproduces a C8 DMN with the same decision.
- **Source** spec §6.6 ("surfaced by the CLI as a hint"), README "Camunda 8 round-trip".

### CLI-275: C8 hint quotes paths with spaces

- **Given** as CLI-274 but output `-o "my back_DMN.xlsx"`.
- **Then** the printed command contains the path in single quotes so it can be pasted into a POSIX shell.
- **Source** **spec silent**; a hint that breaks on paste is wrong.

### CLI-276: Camunda 7 import prints no Camunda 8 hint

- **Given** `T/RATES.dmn` from W1 (C7). **When** `excel2dmn import RATES.dmn`.
- **Then** stdout has no `--platform camunda8`.
- **Source** spec §6.6.

### CLI-277: C8 import with a non-default version prints the version hint

- **Given** W1 converted with config `{ "platform": "camunda8", "camunda8": { "executionPlatformVersion": "8.7.0" } }`.
- **When** `excel2dmn import FILE.dmn -o back_DMN.xlsx` with no config.
- **Then** stdout mentions `8.7.0` and the config key `executionPlatformVersion`.
- **Source** spec §6.6 (the template does not carry the platform/version). **spec silent** on the version hint.

### CLI-278: import of a missing file

- **Given** empty `T`. **When** `excel2dmn import nope.dmn`.
- **Then** fails naming `nope.dmn`; no `.xlsx` written.
- **Source** **spec silent** on wording.

### CLI-279: import of malformed XML

- **Given** `T/bad.dmn` = `<definitions`.
- **When** `excel2dmn import bad.dmn`.
- **Then** fails (exit 1) with a parse error naming `bad.dmn`; no `bad.xlsx` written.
- **Source** **spec silent**.

### CLI-280: import with renamed markers in config writes the renamed markers

- **Given** `T/RATES.dmn` from W1; config `{ "markers": { "id": "KEY", "input": "in", "output": "out" } }`.
- **When** `excel2dmn import RATES.dmn --config cfg.json -o k_DMN.xlsx`, then `excel2dmn k_DMN.xlsx --config cfg.json --out-dir b`.
- **Then** the marker row of `k_DMN.xlsx` has `KEY`, `in`, `out`; `b/RATES.dmn` is byte-identical to `T/RATES.dmn`.
- **Source** spec §7.1 rules of use (parser reads markers from config); §7.2 (config-aware template).

### CLI-281: import of a DMN with allowed values produces a convertible template

- **Given** a DMN produced from a W1 variant in the allowed-values layout (`result` allowed `"LOW","HIGH"`), converted with config `ALLOWED_VALUES_LAYOUT`.
- **When** `excel2dmn import FILE.dmn -o av_DMN.xlsx`, then convert `av_DMN.xlsx` with config `ALLOWED_VALUES_LAYOUT`.
- **Then** both succeed; the second DMN is byte-identical to the first and keeps `<outputValues>`.
- **Source** spec §1 (lossless round trip), §3.6. **spec silent** on whether the user must pass the allowed-values config on the way back; the template layout chosen by import must be documented.

---

## O. Programmatic API (config and convert)

### CLI-290: API `loadConfig` precedence

- **API** with `T` holding `excel2dmn.config.json` = `{ "hitPolicy": { "default": "ANY" } }` and `cfg.json` = `{ "hitPolicy": { "default": "FIRST" } }`.
- **Then** `loadConfig({ cwd: T }).hitPolicy.default` is `ANY`; `loadConfig({ cwd: T, configPath: T/cfg.json }).hitPolicy.default` is `FIRST`; adding `overrides: { hitPolicy: { default: 'COLLECT' } }` gives `COLLECT`; `loadConfig({ cwd: <empty dir> }).hitPolicy.default` is `UNIQUE`.
- **Source** spec §7.1 precedence; README "Programmatic API".

### CLI-291: API `loadConfig` rejects bad JSON with a message naming the file

- **API** `loadConfig({ configPath: T/bad.json })` where the file holds `{,}`.
- **Then** throws an `Error` whose message contains `bad.json`.
- **Source** spec §7.1.

### CLI-292: API `loadConfig` does not mutate `DEFAULT_CONFIG`

- **API** call `loadConfig({ overrides: { markers: { id: 'KEY' } } })`, then read `DEFAULT_CONFIG.markers.id`.
- **Then** still `id`; a second `loadConfig({})` returns `markers.id === 'id'`.
- **Source** spec §7.1 (defaults are built-in and constant).

### CLI-293: API `convert` returns results and problems per sheet

- **API** `convert(T/book.xlsx, { config: loadConfig({ overrides: { output: { outDir: T/out } } }) })` on W2 with `Returns_ DMN!B5` = `"x"`.
- **Then** resolves (does not throw) with `results.length === 1` (sheet `Shipping DMN`, `decisionId: 'SHIPPING'`, `path` ending in `SHIPPING.dmn`) and `problems.length === 1` (sheet `Returns_ DMN`, error message containing `Returns_ DMN!B5`).
- **Source** README "Programmatic API" (`const { results, problems } = await convert(…)`), spec §7 per-sheet atomicity.

### CLI-294: API `convert` with `validateOnly` writes nothing

- **API** `convert(W1, { config: loadConfig({ cwd: T }), validateOnly: true })`.
- **Then** `results[0].decisionId === 'RATES'`, `results[0].xml` and `path` undefined; `T` has no `.dmn`.
- **Source** spec §7 (`--validate-only`).

### CLI-295: API `convert` with no matching sheet rejects

- **API** `convert(T/plain.xlsx, …)` (CLI-014's workbook).
- **Then** rejects with an error mentioning `DMN`.
- **Source** spec §3 intro.
