# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] — 2026-10-29

### Added

- README rewritten to introduce the **Excel-as-source-of-truth** paradigm: analysts author decision logic directly in Excel, alongside business data, and convert to deployment-ready DMN in a single command — eliminating the analyst→developer handoff for large rule sets.
- Quickstart sections for **Camunda 7** and **Camunda 8** in README.
- **Migrate from DMN** section in README documenting `excel2dmn import` for bringing existing `.dmn` files into the Excel workflow.

### Changed

- Package version 0.1.5 → **1.0.0** (stable public release).
- README restructured to lead with the workflow paradigm and feature `excel2dmn import` as a first-class migration path.

### Added

- Camunda 8 output target. Select it with `--platform camunda8` (or `"platform": "camunda8"` in the config). Camunda 8 files carry `modeler:executionPlatform="Camunda Cloud"` / `modeler:executionPlatformVersion` on `<definitions>` and omit the Camunda 7 `historyTimeToLive` / `versionTag` extension attributes. The execution-platform version is configurable via `camunda8.executionPlatformVersion` (default `8.6.0`).
- Camunda 8 relaxes the Camunda 7 decision-table type restriction, so the full DMN/FEEL type set (`number`, `time`, `dateTime`, durations, …) is accepted. Camunda 7-only numeric types (`integer`/`long`/`double`) are normalized to `number` in Camunda 8 output (configurable via `types.camunda8NumericAlias`), since Camunda 8's type set has no integer/long/double.
- Camunda 8 output rejects the `PRIORITY` and `OUTPUT ORDER` hit policies, which Camunda 8 does not support (only `UNIQUE`, `ANY`, `FIRST`, `RULE ORDER`, `COLLECT`).
- `excel2dmn import` detects the source platform from `modeler:executionPlatform`, exposes it on the `importDmn` return, and prints a hint to re-convert Camunda 8 templates with `--platform camunda8` (the `.xlsx` template does not itself carry the platform).
- `excel2dmn config` interactive config generator (step-by-step wizard with defaults; `--defaults` writes the full default config non-interactively, `--full` writes every key).
- `excel2dmn.config.example.json` — a complete, ready-to-copy reference config.
- Untyped columns may be written `any`, `none` or `object` (any casing); configurable via `types.anyAliases`.
- `types.anyDmnPlaceholder` controls the `typeRef` emitted for untyped columns (omitted by default).
- The npm package ships `THIRD-PARTY-NOTICES.txt` with the licenses of its production dependencies.

### Changed

- **Breaking:** requires Node.js 20.12 or newer (Node 18 is end-of-life).
- **Breaking:** two sheets with the same decision id (compared after sanitising, ignoring case) are now an error naming the id and both sheets, and neither is written. They used to be renamed `<ID>_2`, `<ID>_3`, … `identity.collisionSuffix` now only de-duplicates rule ids inside one decision (e.g. an `idTemplate` without `<n>`/`<row>`).
- **Breaking:** `excel2dmn init` refuses to overwrite an existing file; pass the new `--force` flag to replace it.
- Unknown config keys (e.g. a typo such as `platfrom`) print a `warning:` on stderr naming the key path. They are still ignored, not an error.
- `excel2dmn init --sheet <name>` warns when the converter would not select that sheet name (e.g. no `DMN` in it).
- `excel2dmn import` prints which config keys to set (`header.allowedValuesOffset`, `header.labelOffset`, `rules.startOffset`) when it switches to the 5-row allowed-values layout.
- The `--sheet` "no sheet" error explains that `--sheet` only narrows the sheets selected by `sheet.match`/`sheet.value`.
- Standardised the wildcard/untyped column keyword to canonical **`Any`** (aligned with Camunda 8's documented type name). `any`/`none`/`object` are still accepted case-insensitively on input; reverse `import` now writes `Any` into the Excel type cell. Emitted DMN is unchanged (untyped columns still omit `typeRef`, matching the Camunda Modeler).
- `commander` 12 → 15, `dmn-moddle` 12.0 → 12.2, `feelin` 7 → 8 (FEEL parsing is unchanged; `luxon` is no longer a dependency).
- Patched vulnerable transitive dependencies (`fast-uri`, `brace-expansion`).

### Fixed

- `validation.enforceAllowedValues` now rejects out-of-domain input values whatever `validation.feel.mode` is (they were skipped with `"off"`, and with `"any-inputs"` for typed columns).
- Every error printed by the CLI now carries the `error: ` prefix (read and config errors were bare).
- Two sheets whose output file is the same (e.g. a fixed `output.fileNameTemplate`) are reported as an error and not written, instead of silently overwriting each other; `output.fileNameTemplate` must be non-empty. An output path that would leave the output directory (e.g. an id of `../x` with `identity.sanitizeId: false`) is rejected for that sheet.
- `excel2dmn init --sheet` rejects names Excel does not allow (longer than 31 characters or containing `: \ / ? * [ ]`).
- An invalid regular expression in `sheet.value` (with `sheet.match: "regex"`) is reported as a config error.
- `output.fileNameTemplate` placeholders are substituted literally (an id containing `$&` is no longer expanded).
- `excel2dmn import` no longer mistakes an old-version `<definitions>` inside an XML comment for the root.
- The `excel2dmn config` wizard consumes answers that arrive together (pasted or piped into a terminal) instead of dropping all but the first.
- `excel2dmn import -o` into a directory that does not exist failed; missing parent directories are now created, as for convert.
- Read errors for the input of convert and import name the path (`Cannot read <path>: it is a directory, not a file` instead of a bare `EISDIR` or "not a valid .xlsx workbook").
- `excel2dmn config` answers to the overwrite question and the wizard no longer lose each other's lines when they arrive together (one shared input reader).
- `--validate-only` now reports output-path collisions and out-of-directory paths, as a real run would.
- convert refuses to overwrite its input workbook (`-o x.xlsx`, or a template resolving to it; also through a symlink, hard link or case-variant path, and under `--validate-only`), and `import -o` refuses to overwrite the input DMN (also through a link).
- `excel2dmn import` of a DMN 1.1/1.2 (or 1.4/1.5) file is rejected with a message naming the DMN version, instead of a confusing "no decision table" error.
- An `excel2dmn import` write error names the output path.
- `excel2dmn --version` reported `0.1.0` regardless of the installed version.
- `-o/--out` was ignored: the single-sheet result is now written to the named file, and the multi-sheet error is raised before any file is written.
- One invalid DMN sheet no longer blocks its valid siblings: each sheet is written independently and every failing sheet is reported (exit code stays non-zero).
- Conversion warnings (`types.nonCamundaTypeAction: "warn"`, a table with zero input columns) are now printed on stderr; zero input columns now produces a warning, as documented.
- `outputEntries.autoQuote` and `outputEntries.requireQuotes: false` had no effect, since unquoted string outputs were rejected before either option was applied.
- `validation.enforceAllowedValues` is now implemented: literal entries and numeric ranges outside a column's allowed values are reported with a cell coordinate.
- An unknown `COLLECT` aggregator (anything but `SUM`/`MIN`/`MAX`/`COUNT`) is rejected, and lower-case aggregators are upper-cased, instead of producing invalid DMN.
- Duplicate technical names among input/output columns are rejected with a header error instead of producing a DMN with duplicate element ids.
- `excel2dmn import` lost the `COLLECT` aggregator (`SUM`/`MIN`/`MAX`/`COUNT`), so re-converting the template dropped `aggregation`; it is now written into the `policy` column at `hitPolicy.aggregatorOffset`.
- `excel2dmn import` copied the first input's entries into every input that shares its expression (same for outputs sharing a name); entries are now placed by position.
- `excel2dmn import` crashed on two decisions with the same name or a name with characters Excel forbids in sheet names (`: \ / ? * [ ]`), and cut long names to 31 characters after adding ` DMN`, so the sheet was no longer converted. Sheet names are now sanitised, de-duplicated and keep `DMN`.
- `excel2dmn import` of a file without a `.dmn` extension overwrote the source with the workbook; the default output is now `<input>.xlsx` for such files.
- The config is now validated against `schema/config.schema.json` (spec §7.1), so a wrong type such as `"header": { "labelOffset": "x" }` fails with an error naming the file and key instead of being used.
- The config schema now checks the enumerated keys (`platform`, `sheet.match`, `identity.idCase`, `types.nonCamundaTypeAction`, `validation.feel.mode`, `output.namespaceStyle`, `analysis.failOn`, `analysis.format`); every violation is reported at once with the allowed values. An empty config file now means "all defaults" instead of a JSON parse error.
- `analysis.failOn: "error"` / `"any"` had no effect; matching findings now make the run exit 1 (the DMN is still written).
- `excel2dmn --help` now lists the options of the default `convert` command.
- A file that is not an `.xlsx` workbook, `import` of malformed XML, and `--sheet` naming a missing sheet now produce errors naming the file or sheet; an unknown hit policy lists the allowed ones.
- `excel2dmn init` folded `ß`/`Ł`/`ø`/`đ` in `--name` differently from the converter (`Straße` → `STRA_E`); it now uses the same id rules. The template gains the instructions helper cell from spec §7.2.
- `excel2dmn config` on a non-TTY stdin now says on stderr that it wrote the full defaults instead of running the wizard.
- README described a 5-row header and listed `number` as a type; the default
  header is 4 rows (allowed values are an opt-in fifth row) and `number` is
  rejected by default in favour of Camunda types.

## [0.1.5] - 2026-07-14 — not published

Tagged, but the release workflow failed and the version never reached npm. Its
changes are listed under [Unreleased].

## [0.1.4] - 2026-07-08

### Changed

- Example workbook uses the Camunda `integer` type instead of `number`.

## [0.1.3] - 2026-07-08

### Changed

- Example workbook uses the Camunda `integer` type instead of `number`.
- Added `RELEASING.md`.

## [0.1.2] - 2026-07-08 — not published

Tagged, but the release workflow failed and the version never reached npm.

## [0.1.1] - 2026-07-08

### Changed

- Releases are published from GitHub Actions over npm OIDC Trusted Publishing, with provenance.
- Added the OpenSSF Scorecard workflow.
- Pinned `uuid` to a non-vulnerable version via `overrides`.

## [0.1.0] - 2026-07-08

### Added

- Excel → DMN 1.3 conversion, one `.dmn` per `DMN` sheet.
- Marker-driven, position-independent parsing (`input`/`output`/`policy`/`ID`/`name`/`Annotations`).
- Type-aware FEEL validation with `Sheet!Cell` diagnostics (via `feelin`).
- Allowed values (`inputValues`/`outputValues`); hit policies incl. `COLLECT` aggregator.
- Annotations mapped to rule `<description>`.
- Camunda 7 `historyTimeToLive` / `versionTag`.
- Readable, deterministic element ids.
- Static analysis: overlap / duplicate / shadowed / gaps.
- `excel2dmn init` template generator.
- `excel2dmn import` reverse converter (DMN → xlsx), byte-identical round-trip.
- Config file + CLI, JSON Schema for the intermediate model.

[Unreleased]: https://github.com/illia-loshchinin/excel2dmn/compare/v0.1.4...HEAD
[0.1.5]: https://github.com/illia-loshchinin/excel2dmn/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/illia-loshchinin/excel2dmn/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/illia-loshchinin/excel2dmn/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/illia-loshchinin/excel2dmn/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/illia-loshchinin/excel2dmn/compare/3c3a1c9...v0.1.1
[0.1.0]: https://www.npmjs.com/package/excel2dmn/v/0.1.0
