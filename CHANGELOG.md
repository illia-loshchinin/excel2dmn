# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- Camunda 8 output target. Select it with `--platform camunda8` (or `"platform": "camunda8"` in the config). Camunda 8 files carry `modeler:executionPlatform="Camunda Cloud"` / `modeler:executionPlatformVersion` on `<definitions>` and omit the Camunda 7 `historyTimeToLive` / `versionTag` extension attributes. The execution-platform version is configurable via `camunda8.executionPlatformVersion` (default `8.6.0`).
- Camunda 8 relaxes the Camunda 7 decision-table type restriction, so the full DMN/FEEL type set (`number`, `time`, `dateTime`, durations, …) is accepted.
- `excel2dmn import` detects the source platform from `modeler:executionPlatform`.

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
