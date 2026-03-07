# Zenith Monorepo Index

Zenith is a lightweight umbrella repository that tracks three independent projects as Git submodules:

- `bamboo` -> `https://github.com/bigduu/Bamboo-agent.git`
- `bodhi` -> `https://github.com/bigduu/Bodhi.git`
- `lotus` -> `https://github.com/bigduu/Lotus.git`

## Clone

```bash
git clone --recursive https://github.com/bigduu/Zenith.git
cd Zenith
```

If you already cloned without `--recursive`:

```bash
git submodule update --init --recursive
```

## Daily Workflow

Check current submodule commit pointers:

```bash
git submodule status
```

Pull the latest commits inside each submodule checkout:

```bash
git submodule update --remote --recursive
```

After submodule pointers change, commit them in Zenith:

```bash
git add .gitmodules bamboo bodhi lotus
git commit -m "chore: bump submodule pointers"
git push
```

## Working On A Submodule

Enter the submodule, work as usual, and push there first:

```bash
cd bodhi
# edit, commit, push in bodhi
```

Then return to Zenith and commit the updated pointer:

```bash
cd ..
git add bodhi
git commit -m "chore: update bodhi submodule"
git push
```

## Sync URLs After Changes

If submodule URLs are updated in `.gitmodules`:

```bash
git submodule sync --recursive
git submodule update --init --recursive
```

## Coordinated Release Train

Zenith now provides a root workflow to orchestrate cross-repo releases in order:

1. `bamboo` -> publish crate (`publish-crate.yml`)
2. `lotus` -> publish npm package (`publish-npm.yml`)
3. `bodhi` -> build and publish Tauri binaries (`release.yml`)

Workflow file:

- `.github/workflows/release-train.yml`
- `.github/release-train.config.json` (central release manifest)

Required secret in the **Zenith** repo:

- `RELEASE_ORCHESTRATOR_TOKEN`: token that can trigger and read workflows in:
  - `bigduu/Bamboo-agent`
  - `bigduu/Lotus`
  - `bigduu/Bodhi`

Suggested trigger:

- Manual: `Actions -> Release Train -> Run workflow`
- Leave inputs as `from_manifest` to use values from `.github/release-train.config.json`.
- Override any input at dispatch time when you need a one-off release without changing the manifest.

Release manifest fields:

```json
{
  "refs": { "bamboo": "main", "lotus": "main", "bodhi": "main" },
  "versions": { "bamboo": "2026.3.3", "lotus": "2026.3.8" },
  "options": { "lotus_skip_tests": true }
}
```

Typical version bump flow:

1. Update `.github/release-train.config.json`.
2. Commit and push to Zenith `main`.
3. Run `Release Train` with default `from_manifest` inputs.

Version guardrails:

- `bamboo_version` must exist on crates.io (for example `bamboo-agent@2026.3.3`).
- `lotus_version` must exist on npm (for example `@bigduu/lotus@2026.3.8`).
- Release Train now waits for those versions after Bamboo/Lotus publish and fails early with a clear error if they are unavailable.

Single release entrypoint policy:

- Use **only** `Zenith -> Release Train` for normal releases.
- Sub-repo auto release triggers were disabled to avoid split/duplicate publish paths.
- Manual sub-repo publish workflows remain available for emergency recovery only.
