# Contributing

Thanks for your interest! This project favours small, well-tested changes.

## Setup

```bash
npm install
npm test
npm run lint
```

## Guidelines

- **ESM, Node ≥ 18.** Keep modules small and pure where possible.
- **Every behaviour change ships with a test.** Golden fixtures live in `test/fixtures/`.
- Regenerate golden files intentionally (never hand-edit `*.expected.dmn`); ids are
  deterministic, so a legitimate change is a reviewable diff.
- Run `npm run format` (Prettier) and `npm run lint` (ESLint) before opening a PR.
- Verify any dmn-moddle structural change by re-parsing the output with zero warnings.

## Reporting issues

Include the smallest workbook that reproduces the problem (or its header layout)
and the exact command + output.
