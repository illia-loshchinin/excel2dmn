# Releasing

`excel2dmn` is published to npm automatically by GitHub Actions. Pushing a
version tag (`v*`) triggers the [`release.yml`](.github/workflows/release.yml)
workflow, which runs the tests and publishes to npm over **OIDC Trusted
Publishing** — no tokens are stored anywhere, and each release gets a signed
**provenance** attestation.

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
tab; a green check means the new version is live on npm.

## Choosing the bump

Follow [semantic versioning](https://semver.org/):

| Command             | Example        | Use when                                             |
| ------------------- | -------------- | ---------------------------------------------------- |
| `npm version patch` | 0.1.0 -> 0.1.1 | Bug fixes, docs, internal changes; no API change     |
| `npm version minor` | 0.1.1 -> 0.2.0 | New backwards-compatible features or config options  |
| `npm version major` | 0.2.0 -> 1.0.0 | Breaking changes to the CLI, config, or output       |

`npm version` requires a **clean working tree** (commit or stash first). It
edits `package.json`, commits that change, and creates the `vX.Y.Z` tag in one
step, so the tag and the published version always match.

## What the Release workflow does

Triggered by a `v*` tag, on a fresh Ubuntu runner:

1. **Checkout** the repo at the tagged commit.
2. **Setup Node 20** pointed at the public npm registry.
3. **`npm install -g npm@latest`** — Trusted Publishing needs npm >= 11.5.1.
4. **`npm ci`** — clean, exact install from `package-lock.json`.
5. **`npm run lint && npm test`** — if either fails, the job stops and nothing
   is published. This is the safety gate.
6. **`npm publish --access public`** — publishes to npm. The runner's OIDC
   identity is verified against the package's Trusted Publisher config, and a
   provenance attestation is generated automatically (`publishConfig.provenance`
   is `true` in `package.json`).

## Before you tag: checklist

- [ ] Tests pass locally: `npm test`
- [ ] Lint is clean: `npm run lint`
- [ ] Production dependencies are clean: `npm audit --omit=dev`
- [ ] `CHANGELOG.md` has an entry for the new version
- [ ] Working tree is clean (`git status`)
- [ ] The version you're about to publish does **not** already exist on npm

## Verifying a release

- **Actions tab:** the Release run is green.
- **npm:** <https://www.npmjs.com/package/excel2dmn> shows the new version with a
  green **Provenance** check.
- **Install test:** `npx excel2dmn@latest --help`.

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
