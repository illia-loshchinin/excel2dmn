# Releasing

`excel2dmn` is published to npm automatically by GitHub Actions. Pushing a
version tag (`v*`) triggers the [`release.yml`](.github/workflows/release.yml)
workflow, which runs the tests and publishes to npm over **OIDC Trusted
Publishing** — no tokens are stored anywhere, and each release gets a signed
**provenance** attestation. It also creates the GitHub Release, with the package
tarball and its [SLSA](https://slsa.dev/) Build L3 provenance attached.

## TL;DR

```bash
# 1. commit your code changes
git add -A
git commit -m "fix: <what changed>"

# 2. bump the version (creates a commit + a matching git tag)
npm version patch        # 0.1.0 -> 0.1.1   (see "Choosing the bump" below)

# 3. push the branch AND the tag
git push --follow-tags
```

The tag push starts the Release workflow. Watch it under the repo's **Actions**
tab; a green check means the new version is live on npm and its GitHub Release
exists.

## Choosing the bump

Follow [semantic versioning](https://semver.org/):

| Command             | Example        | Use when                                            |
| ------------------- | -------------- | --------------------------------------------------- |
| `npm version patch` | 0.1.0 -> 0.1.1 | Bug fixes, docs, internal changes; no API change    |
| `npm version minor` | 0.1.1 -> 0.2.0 | New backwards-compatible features or config options |
| `npm version major` | 0.2.0 -> 1.0.0 | Breaking changes to the CLI, config, or output      |

`npm version` requires a **clean working tree** (commit or stash first). It
edits `package.json`, commits that change, and creates the `vX.Y.Z` tag in one
step, so the tag and the published version always match.

## What the Release workflow does

Triggered by a `v*` tag. The **build** job runs on a fresh Ubuntu runner:

1. **Checkout** the repo at the tagged commit.
2. **Setup Node 22** pointed at the public npm registry.
3. **`npm install -g npm@latest`** — Trusted Publishing needs npm >= 11.5.1.
4. **`npm ci`** — clean, exact install from `package-lock.json`.
5. **`npm run lint && npm test`** — if either fails, the job stops and nothing
   is published. This is the safety gate.
6. **`npm run licenses:notices`, then `npm pack`** — builds
   `excel2dmn-X.Y.Z.tgz` with `THIRD-PARTY-NOTICES.txt` inside. (Publishing a
   tarball skips `prepublishOnly`, so the notices are generated here.)
7. **`npm publish ./excel2dmn-X.Y.Z.tgz --access public`** — publishes that
   exact tarball to npm. The runner's OIDC identity is verified against the
   package's Trusted Publisher config, and an npm provenance attestation is
   generated automatically (`publishConfig.provenance` is `true` in
   `package.json`).

Then:

- **release** — creates the GitHub Release for the tag (title = tag, notes
  generated from merged PRs) if it doesn't exist yet, and uploads the tarball.
- **provenance** — the official
  [`slsa-github-generator`](https://github.com/slsa-framework/slsa-github-generator)
  signs SLSA Build L3 provenance for the tarball and uploads it to the release
  as `excel2dmn-X.Y.Z.tgz.intoto.jsonl`. This is what the OpenSSF Scorecard
  **Signed-Releases** check looks for. The generator is referenced by tag
  (`@v2.1.0`), not by commit SHA, because it verifies its own ref.

## Before you tag: checklist

- [ ] Tests pass locally: `npm test`
- [ ] Lint is clean: `npm run lint`
- [ ] Formatting is clean: `npm run format:check`
- [ ] Production dependencies are clean: `npm audit --omit=dev`
- [ ] `CHANGELOG.md`: rename `[Unreleased]` to the new version with today's date,
      add a fresh empty `[Unreleased]`, and update the compare links at the bottom
- [ ] `npm pack --dry-run` lists only the intended files
- [ ] Working tree is clean (`git status`)
- [ ] The version you're about to publish does **not** already exist on npm

## Verifying a release

- **Actions tab:** the Release run is green.
- **npm:** <https://www.npmjs.com/package/excel2dmn> shows the new version with a
  green **Provenance** check.
- **Install test:** `npx excel2dmn@latest --help`.
- **GitHub Release:** has `excel2dmn-X.Y.Z.tgz` and
  `excel2dmn-X.Y.Z.tgz.intoto.jsonl` attached. To verify the provenance, download
  both and run
  [`slsa-verifier`](https://github.com/slsa-framework/slsa-verifier):

  ```bash
  slsa-verifier verify-artifact excel2dmn-X.Y.Z.tgz \
    --provenance-path excel2dmn-X.Y.Z.tgz.intoto.jsonl \
    --source-uri github.com/illia-loshchinin/excel2dmn \
    --source-tag vX.Y.Z
  ```

## Adding provenance to an existing release

For a release published before provenance existed (e.g. `v1.0.0`), run the
Release workflow by hand: **Actions → Release → Run workflow**, enter the tag
(e.g. `v1.0.0`). It checks out that tag, runs lint and tests, packs the tarball
and attaches it plus its provenance to the existing release. It **never
publishes to npm**, and the tarball is rebuilt from the tag, so it may differ
byte-for-byte from the one npm already holds.

Because a manual run is started from `main`, its provenance names the `main`
branch as the build ref rather than the tag; verify it with
`--source-branch main` instead of `--source-tag`.

## Notes & gotchas

- **npm versions are permanent.** Once published, a version number can never be
  reused, even after `npm unpublish`. Never re-tag an existing version.
- **A plain `git push` does not push tags.** Use `git push --follow-tags` (or a
  separate `git push --tags`). Without the tag, the Release workflow won't run.
- **Republishing with no code change is allowed** but discouraged as a habit —
  it adds noise to the version history. If you do it (e.g. to validate the
  pipeline), say so in `CHANGELOG.md`.
- **Manual publish (rarely needed).** Because `publishConfig.provenance` is on,
  a local `npm publish` fails with "provider: null" (no OIDC on your laptop).
  Override with `npm publish --access public --no-provenance`. Prefer the tagged
  CI release so provenance is preserved.

## One-time setup (already done)

For reference, publishing works because:

- The npm package has a **Trusted Publisher** configured: GitHub Actions,
  `illia-loshchinin/excel2dmn`, workflow `release.yml`, action `npm publish`.
- `release.yml` has `permissions: id-token: write` for the OIDC handshake.
- `package.json` sets `publishConfig: { access: "public", provenance: true }`.

No `NPM_TOKEN` secret is required.
