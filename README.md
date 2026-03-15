# Zenith Monorepo Index

Zenith is a lightweight umbrella repository that tracks four independent projects as Git submodules:

- `bamboo` -> `https://github.com/bigduu/Bamboo-agent.git`
- `bodhi` -> `https://github.com/bigduu/Bodhi.git`
- `lotus` -> `https://github.com/bigduu/Lotus.git`
- `pavilion` -> `https://github.com/bigduu/Pavilion.git` (official website and docs for end users and developers)

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
git add .gitmodules bamboo bodhi lotus pavilion
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
- For one-click unified releases, set only `release_version` (it drives Bamboo, Lotus, and Bodhi versions).
- You can still override `bamboo_version`, `lotus_version`, or `bodhi_version` independently when needed.

Release manifest fields:

```json
{
  "refs": { "bamboo": "main", "lotus": "main", "bodhi": "main" },
  "versions": { "release": "2026.3.11", "bamboo": "2026.3.11", "lotus": "2026.3.11", "bodhi": "2026.3.11" },
  "options": { "lotus_skip_tests": true }
}
```

Typical version bump flow:

1. Update `.github/release-train.config.json` (`versions.release` is the preferred single knob).
2. Commit and push to Zenith `main`.
3. Run `Release Train` with default `from_manifest` inputs.

Version guardrails:

- Release Train passes version inputs to Bamboo/Lotus publish workflows, so those workflows publish the requested versions directly.
- After each publish, Zenith waits until `bamboo-agent@<version>` appears on crates.io and `@bigduu/lotus@<version>` appears on npm before starting Bodhi.
- Zenith also passes `bodhi_version` to Bodhi release workflow so the generated Tauri release tag/version matches the unified train version.
- If registry propagation fails, the train stops early with a clear error.

Single release entrypoint policy:

- Use **only** `Zenith -> Release Train` for normal releases.
- Sub-repo auto release triggers were disabled to avoid split/duplicate publish paths.
- Manual sub-repo publish workflows remain available for emergency recovery only.
