# Excel → DMN 1.3 Converter — Solution Spec & Implementation Prompt

A blueprint for a **Node.js end-to-end** tool that takes a pre-formatted Excel decision table, converts it to an intermediate JSON model, and emits **DMN 1.3 XML (with a DRD + DMNDI layout)** that imports cleanly into **Camunda 7 Web Modeler** and renders as a standard `dmn-js` decision table.

Pipeline: `.xlsx` → **parse** → `model.json` → **build (dmn-moddle)** → `.dmn` (DMN 1.3 XML).

---

## 1. Goals & non-goals

**Goals**

- Single Node.js project — no Python, no external services. Excel parsing and DMN generation live in one toolchain.
- Deterministic, reviewable **intermediate JSON** between the two stages so each half is independently testable and diffable in CI.
- Output is a valid DMN 1.3 file that opens in Camunda Modeler / Web Modeler with the table laid out (via generated DMNDI) inside a DRD.
- Runs identically **locally** (`npm run convert`) and in **GitLab CI/CD** (artifact = the `.dmn`).
- Hit policy is **configurable** via a `policy` marker in the Excel header (see §3.4).
- **Reverse `import`** (DMN → Excel) round-trips losslessly, so existing `.dmn` files can be pulled back into the template (§7.2/§16).

**Non-goals**

- No business-logic validation of FEEL semantics beyond structural/syntactic checks.
- Helper columns (marked "not applicable to DMN") are ignored entirely — not read into JSON and never emitted into the DMN logic.

---

## 2. Tech stack

| Concern | Choice |
|---|---|
| Runtime | Node.js ≥ 18 (ESM) |
| Excel reading | [`exceljs`](https://github.com/exceljs/exceljs) (reads styles/fills, needed to detect highlights if ever required) |
| DMN model + serialization | [`dmn-moddle`](https://github.com/bpmn-io/dmn-moddle) |
| ID generation | none — ids are **readable & deterministic** (`<name>_<n>`, §6.4), no random-id library |
| CLI | `commander` |
| Validation | `ajv` against the intermediate JSON Schema |
| FEEL syntax check | [`feelin`](https://github.com/nikku/feelin) (bpmn-io FEEL; wraps `lezer-feel`) — validates `any`-typed input entries |
| Tests | `vitest` (or `jest`) |
| Lint | `eslint` + `prettier` |

`dmn-moddle` bundles the DI packages (`dmndi`, `dc`, `di`) needed for layout, and the DMN 1.3 MODEL package. It is the canonical way `dmn-js`/Camunda produce DMN XML, so output is guaranteed to match what the modeler expects.

---

## 3. Input contract — the pre-formatted Excel template

**Each DMN sheet → one decision → one `.dmn` file.** The converter processes **every worksheet whose name contains `"DMN"`** (case-insensitive substring, e.g. `Shipping Rates_ DMN`, `Returns_ DMN`). A workbook may hold **several** such sheets; the tool emits **exactly one `.dmn` (and one `model.json`) per matching sheet**. Non-matching sheets are ignored.

- **0 matching sheets** ⇒ hard error: "no sheet containing 'DMN' found".
- **N matching sheets** ⇒ N independent outputs. Each sheet is **fully self-contained**: its own `id`/`name`/`policy` markers, its own rule rows, its own `<definitions>`. Sheets do not reference each other.
- `--sheet <name...>` restricts processing to a subset (otherwise all matching sheets are converted).
- Output filenames derive from each sheet's decision id (§7). A **duplicate decision id across two sheets** ⇒ hard error (they would overwrite each other) — fix the `id` markers.

The parser is **position-independent** — it does not assume markers are on row 1. It locates the header by the **marker row** and reads rules from the rows beneath it via the `input`/`output` columns (see §3.1 and the algorithm in §5).

### 3.1 Header block — located by the marker row, not a fixed row

Every data column is described by a **4-row header (default)**. The header is found by scanning the **top of the sheet (rows 1–5)** for the first row that contains at least one `input` or `output` cell — that row is the **marker row** (row *M*). The three rows beneath it complete the header:

| Row | Meaning | Example |
|---|---|---|
| *M* (marker row) | **Marker** — one of `input`, `output`, `policy`, `id`, `name`, `annotations`, or blank (blank ⇒ helper column, ignored entirely) | `input` |
| *M+1* | **Technical name** — the FEEL input variable / output name (camelCase) | `region` |
| *M+2* | **Type** — `typeRef`. Use **Camunda types**: `string`, `boolean`, `integer`, `long`, `double`, `date`, `any`. The untyped type may also be written `none` or `object` (any casing — `Any`, `Object`, … — all mean untyped; see `types.anyAliases`, §7.1). DMN/FEEL-only types (`number`, `time`, `dateTime`, durations) are **rejected by default** (`types.nonCamundaTypeAction`, §7.1). | `integer` |
| *M+3* | **Label** — human-readable column title (directly above the rules) | `Region` |

Rules start at **row *M+4***. This 4-row layout is the **default** and matches typical hand-authored Camunda decision tables.

**Optional allowed-values row (opt-in).** To constrain columns to a value list (§3.6), enable an extra row that sits **between `type` and `label`** — i.e. **above** the human label row, which stays directly on top of the rules:

| Row | Meaning (allowed-values enabled) |
|---|---|
| *M+1* | technical name |
| *M+2* | type |
| *M+3* | **allowed values** (`"EU","US"`) — config `header.allowedValuesOffset: 3` |
| *M+4* | **label** — config `header.labelOffset: 4` |
| *M+5+* | rules — config `rules.startOffset: 5` |

So enabling allowed values is the three-line config `{ header: { allowedValuesOffset: 3, labelOffset: 4 }, rules: { startOffset: 5 } }`. By **default `allowedValuesOffset` is `null`** (no allowed-values row).

**Every header row is an independent integer offset from the marker row *M*** — there are no hard-coded row positions. Each is a config key (§7.1):

| Config key | Row read | Default | With allowed values |
|---|---|---|---|
| `header.nameOffset` | technical name / `id`·`name`·`policy` value | `1` (*M+1*) | `1` |
| `header.typeOffset` | `typeRef` | `2` (*M+2*) | `2` |
| `header.allowedValuesOffset` | allowed values (`null` ⇒ row absent) | `null` | `3` (*M+3*) |
| `header.labelOffset` | human label | `3` (*M+3*) | `4` (*M+4*) |
| `rules.startOffset` | first rule row | `4` (*M+4*) | `5` (*M+5*) |

Set any of these to re-order or relocate the header rows for a team's template; the parser reads `cell(M + <offset>)` for each, independently.

Each column's **role and coordinates** are read from the marker row: every column that carries `id`/`name`/`input`/`output`/`policy`/`annotations` is recorded with its column index. Column order is preserved left-to-right.

Rules begin on the **first row after the header** (row *M+4* by default; *M+5* when the allowed-values row is enabled) and are detected by **data in the `input`/`output` columns** — there is no rule-id anchor column (§3.3).

### 3.2 Column roles (derived from the marker row)

- `id` → carries the **decision id**. The value at row *M+1* becomes `decision.id` (NCName-sanitized, see §6.4) and, **when no `name` column is present**, also `decision.name`. **Required: exactly one `id` column per sheet.** Not a data column.
- `name` → **optional** marker carrying the **decision display name**. Its value at row *M+1* becomes `decision.name` **verbatim** (as-is, no sanitization), overriding the `id`-derived default. At most one `name` column. Not a data column.
- `input` → a DMN **input clause**. `inputExpression.text` = row *M+1* name, `typeRef` = row *M+2*, `label` = row *M+3* (or *M+4* when allowed values are enabled), optional **allowed values** = row *M+3* → `<inputValues>` (§3.6).
- `output` → a DMN **output clause**. `name` = row *M+1*, `typeRef` = row *M+2*, `label` = row *M+3* (or *M+4* when allowed values are enabled), optional **allowed values** = row *M+3* → `<outputValues>` (§3.6).
- `policy` → **table-level hit policy** carrier (see §3.4). Not a data column.
- `annotations` → the rule **`<description>`**. **Optional.** Only the **marker** matters — there is **no clause, no name, no dedicated `<annotation>`/`<annotationEntry>` tag**. For each rule row, the annotation cell's **free text** (if any) becomes that rule's `description`, emitted inline as `<rule id="…"><description>value</description>…</rule>` (this is how Camunda's decision-table "Annotations" column is stored). Empty cell ⇒ no `<description>` for that rule. The `M+1`/`M+2`/`M+3` rows don't apply. If **more than one** `annotations` column exists, their non-empty values are joined with `markers.annotationSeparator` (default `" | "`) into the single `description`. Not FEEL-validated, not quoted.
- *blank **or any cell not matching a recognized marker keyword*** → **helper** column. This covers empty marker cells and marker-row cells holding arbitrary text such as a literal banner like `NOT PART OF DMN` (seen at `L1` in the reference), or helper columns like `No.`, a lookup/notes column, an internal-code column, etc. Only the exact keywords in `markers.*` (case-insensitive, trimmed) are roles; **everything else is a helper column, ignored entirely** — not read into the JSON and never written to the DMN.

Column order is preserved: inputs and outputs appear in the DMN table in the same left-to-right order as the sheet.

### 3.3 Rule rows — detected by the `input`/`output` columns (no anchor column)

There is **no rule-id anchor column**. Rules are read from the **first row after the header** (row *M+4* default; *M+5* with the allowed-values row) downward, and a row **is a rule** if any of its `input`/`output` cells is non-empty. Reading **stops** at the first row where **all** `input` and `output` cells are empty (end of table), or at the end of the used range.

- **Rule id** is **generated** as `rule_<n>` — a **1-based sequential index** (`rule_1`, `rule_2`, …), so it lines up with a `DMN_1…DMN_N` column if you keep one. It is **not** read from any cell and **not** emitted as `<rule><description>` (§6.4). (`rule.row` keeps the Excel row for messages/tracing.)
- A legacy `DMN_X` / rule-number column (if one still exists in a sheet) carries **no special role** — it is a blank-marker **helper column, ignored entirely** (§3.2), exactly like `No.`.
- **Input cell** → `inputEntry` (a FEEL *unary test*). A cell whose text matches a configured **"any" token** (`rules.anyInputTokens`, default `["-", ""]` — i.e. a literal `-`/Excel text-dash `'-`, **or an empty cell**) is normalized to **`rules.emitAnyInputAs`** (default `""`) and emitted as an empty `<text></text>`, which DMN treats as **any / irrelevant** (Camunda renders it as `-`). The tool never emits a literal `<text>-</text>` for an input by default. Both the token set and the emitted representation are configurable (§7.1).
- **Output cell** → `outputEntry` (a FEEL *literal expression*). Values are stored already-quoted where they are FEEL strings (`"STANDARD"`, `"EXPRESS"`, `""`). The converter passes cell text through **verbatim** — it does not add or strip quotes. Authoring quotes correctly in Excel is part of the template contract.
- **Annotation cell** (if any `annotations` column exists) → the rule's **`description`** (free text, verbatim; **no FEEL parsing, no quoting, no type check**). Empty ⇒ no `description`. Multiple annotation columns ⇒ join non-empty values with the separator. Annotation cells do **not** count toward rule detection (a row with only annotations and no input/output data ends the table).
- Cell values are taken as the literal string of the cell. Booleans `true`/`false` and numbers are emitted unquoted (they are valid FEEL literals as-is).

### 3.4 Hit policy via the `policy` marker

Reusing the marker-row mechanism: place a column whose **marker cell (row *M*) = `policy`**. The hit policy value is read from **row *M+1*** of that column (mirroring how input/output put their technical name at *M+1*). Accepted values (DMN 1.3):

`UNIQUE` (default), `FIRST`, `PRIORITY`, `ANY`, `COLLECT`, `RULE ORDER`, `OUTPUT ORDER`.

For `COLLECT`, an optional aggregator may be given at **row *M+2*** of the `policy` column: `SUM`, `MIN`, `MAX`, `COUNT`.

Resolution order for the effective hit policy:
1. `policy` marker column, if present.
2. `--hit-policy` CLI flag / config file value.
3. Default `UNIQUE`.

> If no `policy` column exists in the sheet, the tool falls back to config/flag/default — so existing templates keep working.

### 3.5 Worked mapping (from the reference file)

Reference workbook: `shipping_rates_DMN.xlsx`, sheet `Shipping Rates_ DMN`. It includes `id`, `name`, and `policy` marker columns in the marker row; rules are read from the rows below the header via the `input`/`output` columns (no anchor column).

- Identity: `id` = `SHIPPING_RATES` → `decision.id`; `name` = `Shipping Rate Decision` → `decision.name`; `policy` = `UNIQUE`. Markers sit in the marker row: `A=policy`, `B=ID`, `C=name`; the `L1` cell holds the literal banner `NOT PART OF DMN` (a helper, ignored). 4-row header (marker/name/type/label); 5 inputs, 2 outputs, 1 annotation column (`Comment`), 5 rules (Excel rows 5–9 → ids `rule_5`…`rule_9`). (Allowed values are the opt-in layout; see §3.6.)
- Inputs: `orderTotal:number`, `region:string`, `isMember:boolean`, `weightKg:number`, `tags:any`.
- Outputs: `shippingMethod:string`, `deliveryDays:number` (exercises both the quoted-string-output rule and the unquoted-number-output path).
- Allowed values (row 5): `region` = `"EU","US"` → `<inputValues>`; `isMember` = `true,false`; `shippingMethod` = `"STANDARD","EXPRESS","FREIGHT"` → `<outputValues>`.
- Camunda: `<decision … camunda:historyTimeToLive="P180D">` (config default).
- Annotation: the `annotations` column (marker at `M1`) → each rule's `<description>` (`standard EU parcel`, `US ground`, …) inline in `<rule>`. No `<annotation>` clause, no header name.
- Helper columns ignored by logic: `No.` (B), a `Notes` lookup column, and an `Internal code` column carrying the `NOT PART OF DMN` banner.
- First rule (Excel row 6 → `rule_6`): inputs `< 50`, `"EU"`, `false`, `<= 5`, `-` → outputs `"STANDARD"`, `5`.

### 3.6 Allowed values (opt-in row, above the label)

When enabled (config `header.allowedValuesOffset: 3`, `labelOffset: 4`, `rules.startOffset: 5`), each `input`/`output` column may declare a **list of permitted values** — its domain — in the allowed-values row, which sits **above the label row** (row *M+3*). The cell holds a FEEL value list (the same syntax as a DMN unary test list): `"EU","US","APAC"` for a string column, `1,2,3` or `[0..100]` for a number column, `true,false` for boolean. A **blank** cell means the column is unconstrained (current behavior). This maps to DMN's `<inputValues>` / `<outputValues>` (§6.1).

Why it matters:
- **Modeler dropdowns + data-entry validation.** Camunda's decision-table editor renders these cells as dropdowns and flags out-of-domain values.
- **Required for `PRIORITY` and `OUTPUT ORDER`.** These hit policies rank results by the **order of the output value list**, not by row order. Without `<outputValues>` they are undefined — so a table using either policy **must** supply the output column's allowed values (the tool errors otherwise).
- **Enables gap/overlap analysis** (§16) — finite domains make completeness checking possible.

Validation (§3b): the list entries must match the column `typeRef` (strings quoted, numbers numeric, …). Optionally (config `validation.enforceAllowedValues`), each **rule entry** is checked to fall within the declared domain, reported with a cell coordinate.

---

## 4. Intermediate JSON model

Stable, human-diffable contract between the two stages. **One model per DMN sheet**, each producing one `.dmn` file. Within a model, `decisions` has length 1 (one decision per sheet) — the array shape is kept for DRD serialization and forward-compatibility. A workbook with N DMN sheets yields N independent models (and N `.dmn` files); the models are never merged.

### 4.1 Shape (example, abbreviated)

```json
{
  "definitions": {
    "id": "definitions_SHIPPING_RATES",
    "name": "Shipping Rate Decision",
    "namespace": "http://camunda.org/schema/1.0/dmn"
  },
  "decisions": [
    {
      "id": "SHIPPING_RATES",
      "name": "Shipping Rate Decision",
      "hitPolicy": "UNIQUE",
      "aggregation": null,
      "inputs": [
        { "label": "Order total", "expression": "orderTotal", "typeRef": "number", "allowedValues": null },
        { "label": "Region",      "expression": "region",     "typeRef": "string", "allowedValues": "\"EU\",\"US\"" }
      ],
      "outputs": [
        { "name": "shippingMethod", "label": "Shipping method", "typeRef": "string", "allowedValues": "\"STANDARD\",\"EXPRESS\",\"FREIGHT\"" },
        { "name": "deliveryDays",   "label": "Delivery days",   "typeRef": "number", "allowedValues": null }
      ],
      "rules": [
        {
          "id": "rule_6",
          "row": 6,
          "inputEntries": ["< 50", "\"EU\""],
          "outputEntries": ["\"STANDARD\"", "5"],
          "description": "standard EU parcel"
        }
      ]
    }
  ]
}
```

Notes:
- `definitions.id` = `"definitions_" + decision.id`; `definitions.name` = `decision.name`.
- **Clause and entry ids are NOT stored in the model** — Stage B derives all DMN element ids deterministically from `expression`/`name` + the rule's `seq` (1-based index) (§6.4). `decision.id` (from the id marker) is the only business id carried in the model; `rule.id` = `rule_<seq>`. `rule.row` (Excel row) is kept for error/analysis messages.
- `rule.seq` = the **1-based index** of the rule (used for ids: `rule_<seq>`, `<name>_<seq>`). `rule.row` = the **Excel row number** (used for error/analysis messages).
- `inputEntries` / `outputEntries` arrays are **positionally aligned** with `inputs` / `outputs`.
- Any input cell matching `rules.anyInputTokens` (default `["-", ""]` — a `-` **or an empty cell**) ⇒ `""` in `inputEntries`, emitted as `<text></text>` (DMN "any"; renders as `-`). Never a literal `<text>-</text>` by default. Empty output cell ⇒ `""` (emitted as an empty `<text></text>`).
- `typeRef: "any"` ⇒ by default omit `typeRef` in the DMN (Camunda shows it as "Any"); set `types.anyDmnPlaceholder` to instead emit `typeRef="<value>"` (e.g. `"Any"`). The aliases `none`/`object` (any casing) are treated the same; on import, an untyped column's `typeRef` (`Any`/`None`/`object`/absent) is normalized to `any`.
- **Allowed values (optional):** each input/output carries `allowedValues` — a verbatim FEEL list string (e.g. `"\"EU\",\"US\""`) or `null`. Non-null ⇒ `<inputValues>`/`<outputValues>` in the DMN (§6.1).
- **Annotations (optional):** a rule's annotation value is carried as `rule.description` (a string). Blank/absent ⇒ the field is omitted and no `<description>` is emitted. There is **no** decision-level `annotations` array and no per-rule `annotationEntries` — annotations are just the rule description (§3.2).
- Helper columns are not represented in the model at all — only `inputs`, `outputs`, rule entries, and (if present) rule `description` appear.

### 4.2 JSON Schema

Ship `schema/model.schema.json` (Draft 2020-12) and validate with `ajv` after the parse stage and before the build stage. Required: `definitions.id`, `definitions.name`, `decisions[].id`, `decisions[].name`, `decisions[].hitPolicy`, `decisions[].outputs` with **at least one** item (`minItems: 1` — DMN requires ≥1 output), each `rule` has `id` + `row` + `inputEntries` + `outputEntries` (and an **optional** `description` string). Positional alignment of entries with clauses is enforced in code (JSON Schema can't cross-check sibling array lengths). Enumerate `hitPolicy` and `aggregation`; clause/entry ids are absent (derived in Stage B).

---

## 5. Stage A — `excel-to-json`

`src/excel-to-json.js` — pure function `parseWorkbook(path, opts) → model[]` (one model per DMN sheet).

The algorithm follows the four discovery steps in order; each step keys off the **marker row** (not fixed row/column positions), so it tolerates leading blank rows/columns and shifted layouts. **Steps 2–4 run per DMN sheet**, independently.

**Step 1 — Select the sheet(s).**
Load with `exceljs`. Find **all** worksheets whose name **contains `"DMN"`** (case-insensitive), optionally filtered by `--sheet <name...>`. 0 matches ⇒ error (§3 intro). Then run Steps 2–4 on **each** selected sheet, producing one model per sheet; collect them into `model[]`. Track decision ids across sheets and error on a duplicate. For large workbooks use the **streaming reader** and process rules in chunks — see §13.

**Step 2 — Find the header block (`id`/input/output markers).**
Scan rows 1–5 for the first row containing an `input` or `output` cell → this is the **marker row** *M*. Walk every column in row *M*; for each `id`/`name`/`input`/`output`/`policy`/`annotations` cell record a **column descriptor** `{ colIndex, role, name: cell(M+1), typeRef: cell(M+2), label: cell(M+3) }`. This yields the ordered `inputs` and `outputs` and their exact **coordinates**, plus the column index(es) of any `annotations` column(s). Annotation columns carry **no name/type** — only their per-rule values matter (§3.2).

Capture the decision identity:
   - **`id` column** (required): read its value at *M+1* → `decision.id` via `toNcNameId` (§6.4). If there is **no `id` column**, abort: `Missing required ID marker column in <sheet>`.
   - **`name` column** (optional): if present, `decision.name` = its value at *M+1* **verbatim**; otherwise `decision.name` = the `id` value.

Validate each descriptor as it is built: an `input`/`output` column **must** have a non-empty `name` (M+1) and `typeRef` (M+2), and the `id` column **must** have a non-empty value (M+1). If either is missing, **abort with a human-readable error that names the cell coordinates**, e.g. `Missing typeRef for output at Shipping Rates_ DMN!J3 (column J)` or `Missing technical name for input at ...!E2 (column E)`. Collect all such problems and report them together so the author fixes the header in one pass.

Structural requirements (each ⇒ hard error): **≥ 1 `output` column** (DMN requires at least one output — `No output column found in <sheet>`); exactly one `id` column; at most one `name` / `policy` column; and every `typeRef` ∈ `types.allowed` (`Unknown typeRef 'X' at <sheet>!<cell>`). Zero `input` columns is allowed by DMN (rare) — warn but continue.

Capture **allowed values** (§3.6): for each `input`/`output` descriptor, read the allowed-values row (`header.allowedValuesOffset`, default `null` = disabled) → `descriptor.allowedValues` (verbatim FEEL list, or `null` if blank). For `PRIORITY`/`OUTPUT ORDER` hit policies, **every output column must have a non-blank allowed-values cell** or abort (`hitPolicy 'PRIORITY' requires <outputValues> — set allowed values for output '<name>' at <sheet>!<cell>`).

Resolve the hit policy: use the `policy` column if one exists (value at M+1, optional COLLECT aggregator at M+2); **if there is no `policy` column in the sheet, default to `UNIQUE`** (then flag/config only override when explicitly given — see §3.4).

**Step 3 — Read rules from the `input`/`output` columns.**
Rules have **no anchor column**. Start at the **first row after the header** (`rules.startOffset`; default *M+4*) and read downward. For each row, collect the `input`/`output` cells (by coordinate):
   - A row **is a rule** if **any** `input`/`output` cell is non-empty. **Stop** at the first row where all `input` and `output` cells are empty (end of table), or at the end of the used range. If **no rule row** exists, abort: `No rules found in <sheet> (no data rows below the header)`.
   - `rule.id` = **`rule_<seq>`** (1-based index), generated — emitted as `<rule id="rule_1">`, `<rule id="rule_2">`, …. `rule.seq` = the index; `rule.row` = the Excel row (kept for messages).
   - For each `input`/`output` descriptor (in coordinate order), read the cell at `(ruleRow, descriptor.colIndex)` → push text into `inputEntries` / `outputEntries` (empty ⇒ `""`).
   - For each `annotations` column, read the cell (verbatim free text). Join the non-empty values (separator, default `" | "`) → `rule.description` (omit the field entirely if all blank). Row-is-a-rule detection uses **only** `input`/`output` cells, never annotation cells.
   - **Ignore all non-marker helper columns entirely** (including any legacy `DMN_X`/rule-number column) — do not read them, do not store them, do not emit them. Only `input`/`output`/`policy`/`annotations` columns are consumed.

**Step 3b — Type-aware FEEL validation of entries.**
Every non-empty **input/output** entry is parsed with `feelin` and checked against its column's `typeRef`. Two layers: (1) **syntax** — the Lezer tree must contain no `type.isError` node; (2) **type consistency** — the literal leaf kinds in the tree must match the column type. Inputs are parsed as **unary tests** (`parseUnaryTests`), outputs as **expressions** (`parseExpression`). Empty cells and `-` (a `Wildcard`) are always valid (they mean "any / irrelevant"). **`annotations` columns are skipped** — free text, never parsed or type-checked.

```js
import { parseUnaryTests, parseExpression } from 'feelin';   // verified: feelin 7.0.1
function leafKinds(tree) {                    // collect literal node names + error flag
  const kinds = new Set(); let hasError = false; const c = tree.cursor();
  do {
    if (c.type.isError) hasError = true;
    if (/Literal$|^Wildcard$|^VariableName$/.test(c.type.name)) kinds.add(c.type.name);
  } while (c.next());
  return { kinds, hasError };
}
```

Verified Lezer node kinds: quoted string → `StringLiteral`; integer/decimal → `NumericLiteral`; `true`/`false` → `BooleanLiteral`; `-` → `Wildcard`; a **bare unquoted word** (e.g. `EU`) → `VariableName` (a variable reference, *not* a string).

**Per-`typeRef` rules for INPUT entries** (after syntax passes; ranges `[1..10]`, comparisons `< 5`, and comma lists inherit their operands' leaf kinds, so the same checks apply):

| `typeRef` | Valid entry | Rejected (type error) |
|---|---|---|
| `number`/`integer`/`long`/`double` (`types.numeric`) | `NumericLiteral`s — integers (`1`, `1221`) **and decimals** (`3.5`), ranges `[1..10]`, comparisons `>= 3`, lists `1, 2, 3`, `not(...)`. Camunda's editor uses `integer`/`long`/`double`; DMN/FEEL uses `number` — all validated identically. | any `StringLiteral` or `BooleanLiteral`; a bare `VariableName` (likely a typo) unless `allowExpressions` |
| `string` | `StringLiteral`s — **quotes required** (`"EU"`), lists of quoted strings, `not(...)`, and (if `allowExpressions`) supported comparisons | a bare `VariableName` (unquoted word — missing quotes); `NumericLiteral`/`BooleanLiteral` |
| `boolean` | `BooleanLiteral` — `true` / `false` (and `-`) | anything else (`"true"`, `1`, identifiers) |
| `any` (`types.anyKeyword`; aliases `none`/`object`, any casing) | any syntactically valid unary test (e.g. the `tags` expression) | syntax errors only |
| `date` / `time` / `dateTime` / `dayTimeDuration` / `yearMonthDuration` (config `types.syntaxOnly`) | any syntactically valid unary test (e.g. `date("2026-01-01")`, `< date("2026-01-01")`) | syntax errors only — **no** literal-kind enforcement |

**OUTPUT entries — validated by their `typeRef` (quotes enforced for `string` only).** Outputs are FEEL literal expressions, parsed with `parseExpression` and checked against the output column's `typeRef` using the same literal-kind rules as the table above:

- **`string` output** → must be a `StringLiteral` (wrapped in `"..."`), including the empty string `""`. This is what `outputEntries.requireQuotes` (**default `true`**) enforces: a raw unquoted value (`EXPRESS`, `5`, `X`) is either **rejected** with a coordinate error or, if `outputEntries.autoQuote` is `true`, **auto-wrapped** in quotes before emit. Set `outputEntries.requireQuotes: false` to skip this.
- **`number` / `boolean` / `date` / … outputs** → validated per their DMN 1.3 type (`NumericLiteral`, `BooleanLiteral`, etc.) and emitted **verbatim, unquoted** — the quote rule does **not** apply to them. E.g. a `number` output cell is `42` (not `"42"`), a `boolean` output is `true`.

In the reference file the `shippingMethod` output is `string` (values quoted: `"STANDARD"`, `"EXPRESS"`, `""`), while `deliveryDays` is `number` (values unquoted: `5`, `10`).

**Allowed-values checks (§3.6):** the allowed-values list itself is validated for FEEL syntax and per-type literal kinds (a `string` domain must be quoted strings, a `number` domain numeric, etc.) — same rules as entries. When `validation.enforceAllowedValues` is `true`, each rule's `input`/`output` **entry** is additionally checked to fall within its column's declared domain (a scalar not in the set, or a range outside the numeric domain, is reported with a cell coordinate). `-`/empty always pass. Default `false` (advisory), since inputs are often ranges/expressions rather than single domain members.

On any failure, **abort with a coordinate-anchored message** naming the cell, column, type, and offending offset, e.g. `Type error: 'string' input 'region' at ...!E7 has unquoted value 'US' (add quotes: "US")` or `Invalid FEEL in input 'tags' at ...!H8 (col 23): unexpected token`. Collect all validation problems and report them together. Scope/strictness is configurable (§7.1): `validation.feel.mode` (`all-inputs` (default) / `any-inputs` / `off`), per-type `types.<t>.allowExpressions`, `validation.enforceAllowedValues`, and the `outputEntries.requireQuotes` / `outputEntries.autoQuote` pair. All checks are **static** — no evaluation.

> Verified with `feelin` 7.0.1: `"EU"`→`StringLiteral`, `1`/`50`→`NumericLiteral`, `true`/`false`→`BooleanLiteral`, `< 5`/`[1..10]`/`1, 2, 3`→`NumericLiteral` operands, `-`→`Wildcard`, bare `EU`→`VariableName`; outputs `"STANDARD"` and `""`→`StringLiteral` while `5`/`true`/`someVar` are non-string; the `tags` expression `not(some t in ["fragile","hazmat"] satisfies t = tag)` passes syntax with no error node.

**Step 4 — Emit and validate.**
Assemble the `model` (§4) with the single decision (`decision.id` = NCName-sanitized `id` value; `decision.name` = `name`-column value verbatim, or the `id` value when no `name` column — per §6.4). Run `ajv` against `schema/model.schema.json`; fail fast with precise `sheet!cell` locations. This JSON is the handoff to Stage B (§6).

> Rationale for keying off the `input`/`output` marker row (and reading rules beneath it) rather than fixed rows: templates gain/lose leading rows (titles, "not part of DMN" banners) and columns over time. Marker-relative reading keeps the parser stable without per-file configuration.

**Cell-value extraction (exceljs).** Read each cell via `cell.text` (exceljs's rendered string), then normalize/validate by the **column's `typeRef`** — exceljs may hand back a JS number, boolean, `Date`, formula object (`{ formula, result }`), or rich-text object, not a plain string, so extraction is type-aware:

- **boolean** column → coerce to exactly `true` / `false` (lowercase). If a cell is a real Excel boolean, `cell.text` may be `TRUE`/`FALSE` → lowercase it. Any other value (`1`, `"true"`, `yes`) is a **type error** (§3b).
- **number** column → take the numeric value; emit **canonical FEEL** (`1`, `1221`, `3.5`), never Excel's formatted string (`1 221,00`). If the cell is text that isn't a valid number/expression → type error.
- **string** column → use `cell.text` verbatim; it **must already contain FEEL quotes** (`"EU"`). A bare unquoted word is a type error (§3b) — the tool does not auto-add quotes to inputs.
- **any** / **date** / **time** / duration → use `cell.text` verbatim (FEEL syntax-checked only).
- **Formula cells** → use the computed `result` (via `cell.text`, which renders the result); never the formula source.
- Trim leading/trailing whitespace on all extracted values and marker cells; preserve interior UTF-8 (Polish diacritics, `≤`, en-dash `–`).

---

## 6. Stage B — `json-to-dmn` (dmn-moddle)

`src/json-to-dmn.js` — `buildDmn(model) → Promise<string xml>`, called **once per model** (i.e. once per DMN sheet). Each call yields a complete, standalone DMN 1.3 document with its own `<definitions>`; the driver writes each to its own `.dmn` file (§7).

### 6.1 Element construction

```js
import { DmnModdle } from 'dmn-moddle';   // NAMED export
const moddle = new DmnModdle();

// definitions — match the target Camunda-7 working file exactly
const definitions = moddle.create('dmn:Definitions', {
  id: model.definitions.id,
  name: model.definitions.name,
  namespace: model.definitions.namespace,                         // e.g. http://camunda.org/schema/1.0/dmn
  expressionLanguage: 'https://www.omg.org/spec/DMN/20191111/FEEL/',   // present in the target file
  typeLanguage:       'https://www.omg.org/spec/DMN/20191111/FEEL/'    // present in the target file
});
```

> **`expressionLanguage` and `typeLanguage` (both = the DMN 1.3 FEEL URI) MUST be set** — the reference working `.dmn` carries them on `<definitions>`. `exporter`/`exporterVersion` are optional and absent from the target file; leave them off (or set them) as preferred.

For each decision (all ids follow the **readable, deterministic scheme** in §6.4):
- `dmn:Decision { id, name }`.
- `dmn:DecisionTable { id, hitPolicy, aggregation?, preferredOrientation: 'Rule-as-Row' }`.
- Inputs → `dmn:InputClause { id, label }` each with `dmn:LiteralExpression` as `inputExpression` carrying `text` (the FEEL variable) and `typeRef`; when `allowedValues` is set, also `inputValues: dmn:UnaryTests { text: <list> }` (no id).
- Outputs → `dmn:OutputClause { id, name, label, typeRef }`; when `allowedValues` is set, also `outputValues: dmn:UnaryTests { text: <list> }` (no id). Output value order defines `PRIORITY`/`OUTPUT ORDER` ranking.
- Rules → `dmn:DecisionRule { id, description? }` — set `description` (from the annotation value, §3.2) **only when non-empty**; it serializes as `<description>` **first inside `<rule>`** (before the entries, verified). With:
  - `inputEntry`: `dmn:UnaryTests { id, text }` (empty text ⇒ `-`).
  - `outputEntry`: `dmn:LiteralExpression { id, text }` (empty cell ⇒ empty `text`).
- Attach the table to **`decision.decisionLogic`** (NOT `decision.decisionTable` — that property does not exist and silently serializes as a bogus attribute); push decisions into `definitions.drgElement`.

> **Verified against `dmn-moddle` 12.0.1** (empirically serialized + re-parsed with 0 warnings). Exact moddle property names and the emitted structure:
>
> ```
> dmn:Definitions            { drgElement: [...], dmnDI: <dmndi:DMNDI> }
>   └ dmn:Decision           { decisionLogic: <dmn:DecisionTable> }   ← property is decisionLogic
>       └ dmn:DecisionTable  { input:[], output:[], rule:[], hitPolicy(attr), aggregation(attr), preferredOrientation(attr) }
>           ├ dmn:InputClause  { id, label(attr), inputExpression: <dmn:LiteralExpression{ text, typeRef }> }
>           ├ dmn:OutputClause { id, name(attr), label(attr), typeRef(attr) }
>           └ dmn:DecisionRule { id, description?, inputEntry:[<dmn:UnaryTests{text}>], outputEntry:[<dmn:LiteralExpression{text}>] }
> ```
>
> - `id`, `label`, `description` come from the base `DMNElement` (`label` is an attribute; `description` is a child element serialized first inside `<rule>`). `description` is emitted **only** when the rule has an `annotations` value (§3.2).
> - **Hit policy `UNIQUE` is the DMN default and moddle OMITS it from the XML.** It only writes `hitPolicy=` for non-default values (FIRST, COLLECT, …). This is correct and Camunda-compatible — do not treat a missing `hitPolicy` attribute as a bug.
> - dmn-moddle import is a **named** export: `import { DmnModdle } from 'dmn-moddle'` (not a default import).

`typeRef` handling: for `any` (and its aliases `none`/`object`, any casing) emit `types.anyDmnPlaceholder` when set, else omit the attribute; otherwise pass the type through. Only DMN 1.3 built-in FEEL types should reach the writer — validate against the allowed set and warn on unknowns.

### 6.2 DRD + DMNDI (layout)

Because the user wants a laid-out DRD (one decision per DMN sheet):
- Create `dmndi:DMNDI` → one `dmndi:DMNDiagram { id }` → one `dmndi:DMNShape { id, dmnElementRef: <decisionId>, isCollapsed: false }` with `dc:Bounds { x, y, width: 180, height: 80 }`.
- Position: a single fixed placement is fine (`x:160, y:100`; the target file uses `x:-230, y:0` — any coordinates render, the modeler lets the user move it).
- `DMNShape.id` = `DMNShape_<decisionId>`, `DMNDiagram.id` = `DMNDiagram_<decisionId>` (§6.4); `dmnElementRef` = the decision's business-key id.

Assign the `DMNDI` to `definitions.dmnDI` (or push into `definitions.extensionElements`/`di` per the moddle package's property name — confirm with `dmn-moddle`'s `DMNDI` package; the property is `dmnDI`).

### 6.3 Serialize

```js
const { xml } = await moddle.toXML(definitions, { format: true });
```

dmn-moddle emits the XML declaration and injects namespaces **only for prefixes actually used**.

### Namespace style — match the target file exactly

The reference working `.dmn` uses the **default (unprefixed) MODEL namespace**: `<definitions xmlns="…/MODEL/">`, `<decision>`, `<decisionTable>`, `<input>`, `<text>`, etc. — no `dmn:` prefix. **dmn-moddle instead emits the `dmn:` prefix** (`<dmn:definitions xmlns:dmn="…/MODEL/">`). Both are semantically identical valid DMN 1.3 and both import into Camunda 7 — but to byte-match the target style, apply a scoped post-process to the serialized string:

```js
let { xml } = await moddle.toXML(definitions, { format: true });
xml = xml
  .replace(/<dmn:/g, '<')
  .replace(/<\/dmn:/g, '</')
  .replace(
    'xmlns:dmn="https://www.omg.org/spec/DMN/20191111/MODEL/"',
    'xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/"'
  );
```

This is safe because `dmn:` only ever appears as the MODEL prefix on tag names and the one xmlns declaration; FEEL `<text>` content never contains `<dmn:`. **Verified: the post-processed output is byte-identical to the target header + element structure.**

Verified namespace URIs (exactly as in the target file):

```
xmlns   = "https://www.omg.org/spec/DMN/20191111/MODEL/"     (default, unprefixed)
xmlns:dmndi = "https://www.omg.org/spec/DMN/20191111/DMNDI/"
xmlns:dc    = "http://www.omg.org/spec/DMN/20180521/DC/"
```

### Camunda namespace

The target file also declares `xmlns:ns0="http://camunda.org/schema/1.0/dmn"` — this is an **auto-generated prefix** emitted because the `namespace="http://camunda.org/schema/1.0/dmn"` attribute value is registered as a known namespace; it carries no elements. A **pure decision table needs no functional `camunda:` namespace** — plain DMN 1.3 imports fine into Camunda 7. Setting `definitions.namespace` to the camunda URI (as the target does) reproduces the `ns0` declaration; it is harmless either way.

### 6.4 Camunda 7 compatibility checklist

- Root `<definitions>` in DMN 1.3 namespace, unique `id`, a `namespace` (target) attribute.
- Every `id` is a valid NCName and unique across the file. **ID convention — readable & deterministic** (no random ids, so re-running the tool on unchanged input yields **byte-identical** XML — clean CI diffs and byte-level golden tests). All ids are built from the decision id, the column technical name, and the rule's Excel row:

  | Element | id pattern | example |
  |---|---|---|
  | `definitions` | `definitions_<decisionId>` | `definitions_SHIPPING_RATES` |
  | `decision` | `<decisionId>` (from `id` marker) | `SHIPPING_RATES` |
  | `decisionTable` | `<decisionId>_decisionTable` | `SHIPPING_RATES_decisionTable` |
  | `input` (InputClause) | `<expression>` | `region` |
  | input's `inputExpression` | `<expression>_expression` | `region_expression` |
  | `output` (OutputClause) | `<name>` | `shippingMethod` |
  | `rule` | `rule_<seq>` (1-based index) | `rule_1` |
  | `inputEntry` (UnaryTests) | `<expression>_<seq>` | `region_1` |
  | `outputEntry` (LiteralExpression) | `<name>_<seq>` | `shippingMethod_1` |
  | `DMNDiagram` | `DMNDiagram_<decisionId>` | `DMNDiagram_SHIPPING_RATES` |
  | `DMNShape` | `DMNShape_<decisionId>` | `DMNShape_SHIPPING_RATES` |

  (A rule's annotation is emitted as its `<description>` child, which has no id of its own — §3.2.) Here `<seq>` is the rule's **1-based index** (`rule.seq`), so `rule_4` / `region_4` line up with the 4th rule (and a `DMN_4` label if you keep one); `rule.row` still records the Excel row for error and analysis messages. Sanitize each name component with `toNcNameId`-style rules only if it isn't already NCName-safe (technical names are camelCase, so normally untouched). No `ids`/`nanoid` dependency is needed.

- **`decision.id` comes from the required `id` marker column; `decision.name` comes from the optional `name` marker column (falling back to the `id` value)** (§3.2). `decision.id` = the `id` value **after NCName sanitization** (`UPPER_SNAKE_CASE`, diacritics folded to ASCII). `decision.name` = the `name`-column value **verbatim** if a `name` column exists, otherwise the raw `id` value. The sanitizer is a no-op when the `id` value is already an identifier (e.g. `SHIPPING_RATES`); it only normalizes values that contain spaces/diacritics/punctuation:

  ```js
  const FOLD = { 'ł':'l','Ł':'L','ø':'o','Ø':'O','đ':'d','Đ':'D','ß':'ss' };
  function toNcNameId(value) {                        // apply to the ID-marker value
    return value
      .replace(/[łŁøØđĐß]/g, c => FOLD[c] || c)     // letters NFD can't decompose
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // fold combining marks (ó→o, ą→a, ś→s…)
      .replace(/[^A-Za-z0-9]+/g, '_')                // any run of non-alphanumerics → one _
      .replace(/_+/g, '_').replace(/^_+|_+$/g, '')   // collapse + trim underscores
      .toUpperCase()
      .replace(/^([0-9])/, '_$1');                   // NCName must not start with a digit
  }
  ```

  Verified: `SHIPPING_RATES` → unchanged; `Zürich Süd` → `ZURICH_SUD`. The explicit `FOLD` map is **required** — `ł`/`Ł` (and `ø`, `đ`, `ß`) do **not** decompose under NFD and would otherwise be dropped (e.g. `Straße` folds to `STRASSE` only via the map; without it `ł`-words lose the letter). If two decisions across the repo produce the same id, suffix `_2`, `_3`, … on collision.
- **`<rule><description>` = the annotation.** A rule emits `<description>` **only when its `annotations` column has a value** (§3.2); rules without an annotation have no `<description>` (matching the earlier target file, which had no annotations). This is exactly how Camunda's decision-table annotation column is stored. Helper columns like `No.` (and any legacy `DMN_X` column) are not carried anywhere — they are ignored entirely (§3.2).
- `preferredOrientation="Rule-as-Row"` is present on `<decisionTable>` in the target — always set it.
- Hit policy: the target `<decisionTable>` has **no `hitPolicy` attribute** ⇒ it is `UNIQUE` (the default). Emit `hitPolicy` only for non-default policies (moddle does this automatically; see §6.1).
- Each output clause has a `name` (Camunda uses it as the result variable key); single-output tables may leave `name` optional but we always set it.
- DMNDI present so the table opens positioned; `dmnElementRef` on each shape matches a `drgElement` id.

### 6.5 Camunda 7 extensions — `historyTimeToLive` & `versionTag`

Modern **Camunda 7 refuses to deploy** a decision without a `historyTimeToLive` (unless the engine's `historyCleanupEnabled`/`enforceHistoryTimeToLive` is relaxed), so emitting it makes files deploy cleanly out of the box. Both live in the **Camunda namespace** as attributes on `<decision>`:

```xml
<decision id="SHIPPING_RATES" name="Shipping Rate Decision"
          camunda:historyTimeToLive="P180D" camunda:versionTag="1.0">
```

dmn-moddle doesn't know Camunda attributes, so register a **tiny inline moddle extension** (no extra dependency — ship the descriptor):

```js
const camunda = {
  name: 'Camunda', uri: 'http://camunda.org/schema/1.0/dmn', prefix: 'camunda',
  xml: { tagAlias: 'lowerCase' },
  types: [{ name: 'CamundaDecision', extends: ['dmn:Decision'], properties: [
    { name: 'historyTimeToLive', isAttr: true, type: 'String' },
    { name: 'versionTag',        isAttr: true, type: 'String' }
  ]}]
};
const moddle = new DmnModdle({ camunda });
// then: moddle.create('dmn:Decision', { id, name, historyTimeToLive: cfg, versionTag: cfg?, decisionLogic })
```

Behavior:
- Emit `camunda:historyTimeToLive` when `camunda.historyTimeToLive` is set (config default `"P180D"`; set to `null` to omit). Accepts an ISO-8601 duration (`P180D`) or an integer number of days.
- Emit `camunda:versionTag` only when `camunda.versionTag` is set (default `null`).
- Using the `camunda:` prefix causes moddle to declare **`xmlns:camunda`** on the root automatically (a real prefix now, not the `ns0` artifact from §6.3). The default-namespace **post-process (§6.3) only rewrites `dmn:`** tags, so `camunda:` attributes and the `xmlns:camunda` declaration pass through untouched.

> **Verified** (dmn-moddle 12.0.1): the extension emits `camunda:historyTimeToLive="P180D"` / `camunda:versionTag="1.2"` on `<decision>` and re-parses with **0 warnings**.

### 6.6 Camunda 8 target — `platform: "camunda8"`

Setting `platform` to `"camunda8"` (config or `--platform camunda8`; default is `"camunda7"`) emits a Camunda 8 (Zeebe/SaaS) flavor of the same DMN 1.3:

- Adds `modeler:executionPlatform="Camunda Cloud"` and `modeler:executionPlatformVersion` (config `camunda8.executionPlatformVersion`, default `"8.6.0"`) as attributes on `<definitions>`, via an inline `modeler` moddle extension (`http://camunda.org/schema/modeler/1.0`).
- **Omits** the Camunda 7 `camunda:historyTimeToLive` / `camunda:versionTag` attributes (unsupported in Camunda 8 DMN). Because moddle only declares a namespace it actually uses, `xmlns:camunda` disappears and `xmlns:modeler` appears — the two never co-occur, so Camunda 7 output stays byte-identical.
- Relaxes the Camunda 7 `types.camundaTypes` restriction (§5): Camunda 8's FEEL engine supports the full DMN/FEEL type set, so `number`, `time`, `dateTime`, and the duration types pass without warning.
- The default-namespace post-process (§6.3) rewrites only `dmn:` tags, so the `modeler:` attribute prefix and `xmlns:modeler` pass through untouched.
- Everything else — decisionTable, inputs/outputs, rules, DMNDI — is identical standard DMN 1.3.

Reverse `import` (§16) detects the source platform from `modeler:executionPlatform` (`"Camunda Cloud"` → `camunda8`) and registers the same extension so Camunda 8 files parse with 0 warnings.

---

## 7. CLI & config

`src/cli.js` (bin `excel2dmn`):

```
excel2dmn <input.xlsx> [options]     # convert (default command)
  -O, --out-dir <dir>       output directory for the .dmn (and .json) files
                            (default: alongside <input.xlsx>)
  -o, --out <file>          output .dmn path — ONLY valid when exactly one DMN
                            sheet is processed; error if multiple
  -j, --json                also write one <decisionId>.model.json per sheet
      --config <file>       config JSON (default: ./excel2dmn.config.json if present)
      --sheet <name...>     restrict to these sheet name(s); default = all "DMN" sheets
      --hit-policy <p>      fallback hit policy (default UNIQUE)
      --namespace <uri>     definitions target namespace
      --analyze             run static analysis (overlap/gaps/duplicates, §16)
      --validate-only       parse + schema-validate all sheets, do not emit DMN
      --pretty              format XML (default true)

excel2dmn init [options]             # write a starter template workbook (§7.2)
```

**Output filenames (one per DMN sheet).** Each `.dmn` is named from that sheet's decision id via `output.fileNameTemplate` (default `"<decisionId>.dmn"`, e.g. `SHIPPING_RATES.dmn`, `RETURNS.dmn`), written into `--out-dir`. `--out <file>` is a convenience for the single-sheet case and errors when 2+ sheets match. Files are emitted **atomically per sheet** — a validation error in sheet B does not delete sheet A's already-written output, but the process still exits non-zero and reports every failing sheet.

### 7.1 Config file — `excel2dmn.config.json`

All marker keywords and parsing/naming rules are **externalized** here so they can be changed without touching code. The tool loads config in this precedence (highest wins): **CLI flags → `--config <file>` → `excel2dmn.config.json` in CWD → built-in defaults**. Config is deep-merged over defaults, then validated against `schema/config.schema.json` (ship it; `ajv`-checked at startup with clear errors).

```jsonc
{
  // --- sheet selection (ALL matching sheets are converted, one .dmn each) ---
  "sheet": {
    "match": "contains",          // "contains" | "regex" | "exact"
    "value": "DMN",               // substring, /regex/ source, or exact name
    "caseInsensitive": true
  },

  // --- header discovery ---
  "header": {
    "scanRows": 5,                // rows 1..scanRows searched for the marker row
    "nameOffset": 1,             // technical name at markerRow + nameOffset
    "typeOffset": 2,             // typeRef at markerRow + typeOffset
    "labelOffset": 3,            // label at markerRow + labelOffset
    "allowedValuesOffset": null  // null = no allowed-values row (default); set 3 to enable it above the label
  },

  // --- marker keywords (row-M cell text → role). Rename freely. ---
  "markers": {
    "id": "id",
    "name": "name",
    "input": "input",
    "output": "output",
    "policy": "policy",
    "annotations": "annotations", // 0+ columns → rule <description> (free text)
    "annotationSeparator": " | ", // join value when multiple Annotations columns
    "caseInsensitive": true       // match marker cells ignoring case/whitespace
  },

  // --- rule detection (no anchor column; driven by input/output data) ---
  "rules": {
    "startOffset": 5,             // rules start at markerRow + startOffset (M+5 with allowed-values row; 4 without)
    "detectBy": "input-output",   // a row is a rule if any input/output cell is non-empty
    "stopOnEmptyRow": true,       // stop at first row with all input/output cells empty
    "idTemplate": "rule_<n>",     // <n> = 1-based rule index (default); <row> = Excel row also available
    "anyInputTokens": ["-", ""],  // input cell values that mean "any/irrelevant" ("" = empty cell)
    "emitAnyInputAs": ""          // what an "any" input emits; "" → <text></text>
    // note: <rule><description> is emitted only from an Annotations value (§3.2)
  },

  // --- decision id / name rules ---
  "identity": {
    "idFrom": "ID",               // marker role that supplies decision.id
    "nameFrom": "name",           // marker role for decision.name (falls back to idFrom)
    "sanitizeId": true,           // apply toNcNameId to decision.id
    "idCase": "upper",            // "upper" | "preserve"
    "foldMap": { "ł":"l","Ł":"L","ø":"o","Ø":"O","đ":"d","Đ":"D","ß":"ss" },
    "collisionSuffix": "_"        // _2, _3 … on duplicate ids
  },

  // --- hit policy ---
  "hitPolicy": {
    "default": "UNIQUE",
    "allowed": ["UNIQUE","FIRST","PRIORITY","ANY","COLLECT","RULE ORDER","OUTPUT ORDER"],
    "aggregatorOffset": 2         // COLLECT aggregator at policyRow + this (M+2)
  },

  // --- type mapping ---
  "types": {
    "anyKeyword": "any",          // canonical untyped keyword
    "anyAliases": ["any","none","object"], // all mean "untyped" (matched case-insensitively);
                                  // on import any of these is normalized to "any"
    "anyDmnPlaceholder": null,    // typeRef written for an "any" column in the DMN:
                                  // null/"" → omit the attribute (Camunda shows "Any");
                                  // a string (e.g. "Any") → emit typeRef="<value>"
    "allowed": ["string","boolean","number","integer","long","double","any",
                "date","time","dateTime","dayTimeDuration","yearMonthDuration"],
    "numeric": ["number","integer","long","double"], // validated with numeric rules
    "camundaTypes": ["string","boolean","integer","long","double","date"], // Camunda decision-table types (+ "any")
    "nonCamundaTypeAction": "error", // typeRef valid in DMN/FEEL but not Camunda (e.g. "number"): "error" (default) | "warn" | "off"
    "syntaxOnly": ["date","time","dateTime","dayTimeDuration","yearMonthDuration"],
                                  // these + "any": FEEL syntax check only, no literal-kind rule
    "number":  { "allowExpressions": true },   // integers + decimals; ranges/compares/lists
    "string":  { "allowExpressions": true },   // require quotes; allow supported exprs
    "boolean": { "allowExpressions": false }   // only true/false (and -)
  },

  // --- type-aware FEEL validation of entries (§3b) ---
  "validation": {
    "feel": {
      "mode": "all-inputs",       // "all-inputs" | "any-inputs" | "off"
      "failFast": false           // false → collect all errors, report together
    },
    "enforceAllowedValues": false // true → rule entries must fall within row-M+4 domains (§3.6)
  },

  // --- output entries (quote rule applies to string-typed outputs only) ---
  "outputEntries": {
    "requireQuotes": true,        // string outputs must be a "string" literal (incl "")
    "autoQuote": false            // true → wrap unquoted string outputs instead of erroring
  },

  // --- output serialization ---
  "platform": "camunda7",         // "camunda7" | "camunda8" (§6.6)
  // --- Camunda 7 extensions on <decision> (§6.5) ---
  "camunda": {
    "historyTimeToLive": "P180D", // null → omit; "P180D" or an integer day count
    "versionTag": null            // null → omit; else e.g. "1.0"
  },
  // --- Camunda 8 modeler metadata on <definitions> (§6.6); used when platform === "camunda8" ---
  "camunda8": {
    "executionPlatform": "Camunda Cloud",
    "executionPlatformVersion": "8.6.0"
  },

  "output": {
    "namespace": "http://camunda.org/schema/1.0/dmn",
    "expressionLanguage": "https://www.omg.org/spec/DMN/20191111/FEEL/",
    "typeLanguage": "https://www.omg.org/spec/DMN/20191111/FEEL/",
    "namespaceStyle": "default",  // "default" (unprefixed MODEL ns) | "prefixed" (dmn:)
    "shape": { "x": -230, "y": 0, "width": 180, "height": 80 },
    "format": true,               // pretty-print
    "outDir": null,               // null → write beside the input .xlsx; else this dir
    "fileNameTemplate": "<decisionId>.dmn",   // one file per DMN sheet; also "<sheetName>.dmn"
    "writeModelJson": false       // true → also emit <decisionId>.model.json per sheet
  }
}
```

Rules of use:
- The parser **reads marker keywords from `markers`**, never from hardcoded literals — so renaming `id`→`KEY` or `input`→`in` in the sheet is a one-line config change.
- `sheet.match: "regex"` restores pattern-based selection if a team prefers it (e.g. `"value": "_?\\s?DMN$"`).
- `header.*Offset` and `header.scanRows` cover templates whose header block is laid out differently.
- `rules.startOffset` / `detectBy` / `stopOnEmptyRow` control where rules begin and end; `idTemplate` sets the generated rule id (`rule_<n>` sequential by default; `<row>` for the Excel row).
- `identity` fully controls decision id/name derivation (§6.4); `output.namespaceStyle` toggles the §6.3 post-process.
- Every field has a default (the values shown are the defaults), so an **empty or absent config file works out of the box**.

CLI flags map onto config paths: `--hit-policy` → `hitPolicy.default`, `--namespace` → `output.namespace`, `--sheet` → forces `sheet.match:"exact"` with the given name. `--config <file>` points at an alternate JSON.

### 7.2 `excel2dmn init` — starter-template generator

The single biggest adoption barrier is "how do I lay out the sheet?" — so ship a generator that writes a **ready-to-fill workbook** with the marker scaffold already in place:

```
excel2dmn init [--out <file>] [--name "<Decision name>"] [--sheet "<Sheet name>"]
               [--minimal]        # skip the example rules / annotation column
```

It emits an `.xlsx` (default `decision_DMN.xlsx`) with a single `… DMN` sheet containing the header pre-populated from the current config's markers (5-row when allowed values are enabled, else 4-row):

- Marker row with `policy`, `id`, `name`, a couple of `input` columns, an `output` column, and (unless `--minimal`) an `annotations` column.
- Header rows seeded: technical names (`input1`, `output1`), example types (`string`/`number`/`boolean`), friendly labels, and (when enabled) a sample allowed-values cell.
- 2–3 example rules below the header (unless `--minimal`) so the shape is obvious.
- A short **instructions** helper column / cell explaining each marker (ignored by the converter since it isn't a recognized marker).

Built with `exceljs` (styling: header fill, frozen header rows, column widths). The generated file must **round-trip** — running `excel2dmn` on a freshly `init`-ed workbook produces a valid `.dmn` with 0 warnings (add this as a test). Keep the generator config-aware: if the user renamed markers (e.g. `id`→`KEY`), `init` writes the renamed markers so the template always matches their setup.

`.gitlab-ci.yml`:

```yaml
stages: [install, validate, convert, publish]

default:
  image: node:20-alpine
  cache:
    key: ${CI_COMMIT_REF_SLUG}
    paths: [.npm/, node_modules/]

install:
  stage: install
  script:
    - npm ci --cache .npm --prefer-offline

validate:
  stage: validate
  script:
    - npm run lint
    - npm test
    - for f in definitions/*.xlsx; do node src/cli.js "$f" --validate-only; done  # schema-check every DMN sheet in each workbook

convert:
  stage: convert
  script:
    - mkdir -p dist
    - |
      # each workbook may hold several "DMN" sheets → several .dmn files
      for f in definitions/*.xlsx; do
        node src/cli.js "$f" --out-dir dist --json
      done
    - ls -1 dist/*.dmn | wc -l   # sanity: number of emitted decisions
  artifacts:
    paths: [dist/]
    expire_in: 30 days

publish:
  stage: publish
  rules:
    - if: '$CI_COMMIT_TAG'          # only publish .dmn artifacts on tags
  script:
    - echo "Attach dist/*.dmn to the release / upload to package registry"
  artifacts:
    paths: [dist/]
```

Design notes:
- **`validate` stage fails the pipeline** on malformed templates before any DMN is produced — the reason for the strict JSON Schema.
- `.dmn` files are pipeline **artifacts**; developers download them or a later job pushes them to a Camunda 7 deployment endpoint (`POST /engine-rest/deployment/create`) if you want continuous deployment — kept out of the default pipeline since Web Modeler import is a manual step per the goal.

---

## 9. Local usage

```bash
npm install

# Single-sheet workbook → one file (‑o allowed):
node src/cli.js shipping_rates_DMN.xlsx -o out/SHIPPING_RATES.dmn

# Multi-sheet workbook → one .dmn per "DMN" sheet into out/ :
node src/cli.js rules_book.xlsx --out-dir out --json
#   out/SHIPPING_RATES.dmn, out/RETURNS.dmn, out/PRICING.dmn (+ .model.json each)

# then: Camunda Modeler / Web Modeler → Import each out/*.dmn
```

---

## 10. Project structure

```
excel-to-dmn/
├─ src/
│  ├─ cli.js
│  ├─ excel-to-json.js        # Stage A
│  ├─ json-to-dmn.js          # Stage B (dmn-moddle)
│  ├─ config.js               # load + deep-merge + ajv-validate config
│  ├─ feel-validate.js        # FEEL syntax check for any-typed inputs (feelin)
│  ├─ layout.js               # DMNDI grid layout
│  ├─ hit-policy.js           # marker + fallback resolution
│  └─ ids.js                  # NCName-safe id generation
├─ schema/
│  ├─ model.schema.json       # intermediate JSON Schema
│  └─ c