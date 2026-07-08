# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
- `excel2dmn import` reverse converter (DMN → xlsx), byte-identical round-trip.
- Config file + CLI, JSON Schema for the intermediate model.
