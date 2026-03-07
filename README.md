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

Required secret in the **Zenith** repo:

- `RELEASE_ORCHESTRATOR_TOKEN`: token that can trigger and read workflows in:
  - `bigduu/Bamboo-agent`
  - `bigduu/Lotus`
  - `bigduu/Bodhi`

Suggested trigger:

- Manual: `Actions -> Release Train -> Run workflow`
- Optional input: `bamboo_version` (default `latest`) to control which `bamboo-agent` crates.io version Bodhi embeds.
- Optional input: `lotus_version` (default `latest`) to control which `@bigduu/lotus` npm version Bodhi bundles.
- Optional input: `lotus_skip_tests=true` (default) to skip Lotus publish tests during coordinated release.
