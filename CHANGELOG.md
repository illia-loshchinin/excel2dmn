# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- Standardised the wildcard/untyped column keyword to canonical **`Any`** (aligned with Camunda 8's documented type name). `any`/`none`/`object` are still accepted case-insensitively on input; reverse `import` now writes `Any` into the Excel type cell. Emitted DMN is unchanged (untyped columns still omit `typeRef`, matching the Camunda Modeler).
- `commander` 12 → 15, `dmn-moddle` 12.0 → 12.2, `feelin` 7 → 8 (FEEL parsing is unchanged; `luxon` is no longer a dependency).
- Patched vulnerable transitive dependencies (`fast-uri`, `brace-expansion`).

### Fixed

- `excel2dmn --version` reported `0.1.0` regardless of the installed version.
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
