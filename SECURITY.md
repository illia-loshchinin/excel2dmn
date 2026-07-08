# Security Policy

## Threat model

`excel2dmn` is a **local command-line tool**. The intended use is: an operator
runs it on their own spreadsheets to produce `.dmn` files. Given that model:

- It performs **no network access** — nothing is fetched, uploaded, or phoned home.
- It **never executes spreadsheet content.** FEEL expressions in cells are *parsed*
  (a syntax tree is built via `feelin`) and re-serialized — they are never evaluated.
- It contains no `eval`, `new Function`, `child_process`, or dynamic `require`.
- Output filenames are derived from the sanitized decision id (`[A-Z0-9_]` only),
  so generated paths cannot traverse directories.
- Config JSON is deep-merged with a prototype-pollution guard
  (`__proto__`/`constructor`/`prototype` keys are ignored).

### Residual considerations (relevant only if you wrap it as a service)

- **Untrusted `.xlsx` input:** `exceljs` loads the workbook into memory, so a
  hostile or enormous file could exhaust RAM (decompression-bomb style). Safe for
  local use on your own files; add resource limits if exposing it to untrusted uploads.
- **User-supplied `sheet.match: "regex"`** compiles an arbitrary regex — a ReDoS
  vector if that value ever comes from an untrusted caller. It is operator-controlled
  by default.

## Supported versions

The latest published minor version receives fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, or email the maintainer. We aim to acknowledge within 7 days.
