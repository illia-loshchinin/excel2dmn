# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- Camunda 8 output target. Select it with `--platform camunda8` (or `"platform": "camunda8"` in the config). Camunda 8 files carry `modeler:executionPlatform="Camunda Cloud"` / `modeler:executionPlatformVersion` on `<definitions>` and omit the Camunda 7 `historyTimeToLive` / `versionTag` extension attributes. The execution-platform version is configurable via `camunda8.executionPlatformVersion` (default `8.6.0`).
- Camunda 8 relaxes the Camunda 7 decision-table type restriction, so the full DMN/FEEL type set (`number`, `time`, `dateTime`, durations, …) is accepted. Camunda 7-only numeric types (`integer`/`long`/`double`) are normalized to `number` in Camunda 8 output (configurable via `types.camunda8NumericAlias`), since Camunda 8's type set has no integer/long/double.
- `excel2dmn import` detects the source platform from `modeler:executionPlatform`, exposes it on the `importDmn` return, and prints a hint to re-convert Camunda 8 templates with `--platform camunda8` (the `.xlsx` template does not itself carry the platform).

### Changed
- Standardised the wildcard/untyped column keyword to canonical **`Any`** (aligned with Camunda 8's documented type name). `any`/`none`/`object` are still accepted case-insensitively on input; reverse `import` now writes `Any` into the Excel type cell. Emitted DMN is unchanged (untyped columns still omit `typeRef`, matching the Camunda Modeler).

## [0.1.0] - Unreleased

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
- `excel2dmn config` interactive config generator (step-by-step wizard with defaults; `--defaults` writes the full default config non-interactively).
- `excel2dmn.config.example.json` — a complete, ready-to-copy reference config.
- `excel2dmn import` reverse converter (DMN → xlsx), byte-identical round-trip.
- Config file + CLI, JSON Schema for the intermediate model.
