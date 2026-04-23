# Repository Guidelines

## Project Structure & Module Organization
Zenith is a thin monorepo wrapper around five Git submodules:
- `bamboo/`: Rust AI-agent backend framework (`src/`, `tests/`, `docs/`).
- `lotus/`: React + Vite web app (`src/`, `e2e/`, `public/`).
- `bodhi/`: Tauri desktop shell (`src-tauri/`) that coordinates with `lotus`.
- `pavilion/`: React + Vite official website and docs (`src/`, `public/`).
- `bodhi-server/`: Go backend API server (`api/`, `internal/`, `cmd/`).

Root files (`README.md`, `.gitmodules`) manage submodule pointers; most feature work happens inside submodules.

## Build, Test, and Development Commands
From repository root:
- `git submodule update --init --recursive` - initialize all module checkouts.
- `git submodule update --remote --recursive` - pull latest upstream submodule commits.
- `git submodule status` - show current pinned revisions.

Common per-module commands:
- `cd bamboo && cargo build && cargo test` - build and test backend.
- `cd bamboo && cargo fmt --check && cargo clippy` - Rust formatting/lint checks.
- `cd lotus && npm run dev` - run web app locally.
- `cd lotus && npm run type-check && npm run test:run` - TS + Vitest validation.
- `cd lotus && npm run test:e2e` - Playwright browser tests.
- `cd bodhi && npm run tauri:dev` - run desktop app in development mode.
- `cd pavilion && npm run dev` - run website/docs locally.

## Coding Style & Naming Conventions
- Rust (`bamboo`): enforce `cargo fmt` and `cargo clippy`; use `snake_case` for functions/modules, `PascalCase` for types.
- TypeScript/React (`lotus`, `bodhi`): run `npm run format` (Prettier); use `PascalCase` for components/classes, `camelCase` for functions/variables, and `use*` for hooks.
- Keep tests near code when possible (`*.test.ts`, `*.test.tsx`) and use explicit, behavior-focused names.

## Testing Guidelines
Run the smallest meaningful suite while iterating, then run full affected suites before opening a PR. Minimum expectation:
- Backend changes: `cargo test` in `bamboo`.
- Frontend changes: `npm run test:run` in `lotus`.
- UI/workflow changes: include `lotus/e2e` coverage when behavior crosses pages or services.

## Commit & Pull Request Guidelines
Follow Conventional Commit style already used in history (for example, `chore: bump bamboo and bodhi submodule pointers`, `docs: add submodule usage guide`).
- Commit in the submodule first, push, then commit updated pointer in root.
- Keep root commits focused on pointer updates or monorepo docs/config.
- PRs should include: scope summary, affected submodule(s), test evidence, and screenshots for UI-facing changes.

## Multi-Agent Collaboration

This project uses [GitHub Projects "Zenith Roadmap"](https://github.com/users/bigduu/projects/3) to coordinate multiple agents working in parallel across submodules.

### Workflow

```
Backlog → Triaged → Ready → In Progress → In Review → Done
```

### 1. Claiming a Task

- Pick from Board "Ready" column, sorted by Priority (P0 first).
- Prefer tasks matching your current module to avoid context switching.
- Comment on the Issue: `🔒 claimed by <agent-id> at <timestamp>`.
- Update Board: Status → In Progress, set Assignee Type and Branch fields.

### 2. Parallel Constraints

- Same module: max 2 agents simultaneously (e.g. one feature + one fix).
- `scope:cross-module` tasks: serialize — wait until all involved modules are free.
- Always work in an isolated worktree: `git worktree add` or equivalent.

### 3. Branch Naming

```
<module>/<type>/<issue-number>-<short-desc>
```

Examples:
- `lotus/feat/142-conversation-export`
- `bamboo/fix/88-streaming-timeout`
- `bodhi/refactor/55-window-mgmt`

### 4. Commit Conventions

Follow Conventional Commits. Reference the Issue in the body:

```
feat: add conversation export (#142)
```

Commit in the submodule first, push, then update the root pointer if needed.

### 5. Pull Request

- One PR per Issue.
- PR description must include:
  - **Summary**: what changed and why
  - **Test Plan**: how to verify
  - **Screenshots**: for any UI change
- Add `review:needed` label and set Board Status → In Review.

### 6. Review

- Agents may cross-review PRs in **different** modules.
- After agent review, add `review:agent` label — signals human final review.
- Human merges after approval.
- Review checklist:
  - [ ] Meets Acceptance Criteria from the Issue
  - [ ] Tests pass and coverage is adequate
  - [ ] No security concerns (OWASP top 10)
  - [ ] Follows project code style (cargo fmt/clippy, prettier)

### 7. Completion

- Merge → Board Status → Done.
- Delete the working branch.
- Update root submodule pointer if the submodule changed.

### Labels

See `.github/labels.tsv` for the full label taxonomy. Key labels:

| Label | Meaning |
|-------|---------|
| `agent:ready` | Well-scoped task ready for an agent |
| `agent:locked` | Claimed — do not pick up |
| `agent:blocked` | Stuck on a dependency |
| `review:needed` | Waiting for review |
| `review:agent` | Agent review done, human needed |
| `scope:cross-module` | Requires coordination across modules |

### Issue Title Convention

```
[module] type: short description
```

Examples: `[lotus] feat: add conversation export`, `[bamboo] fix: streaming timeout`

## Release Playbook
Use this checklist for every Bamboo/Lotus/Bodhi release.

1. Commit local work in each changed submodule and push:
   - `cd bamboo && git add -A && git commit -m "<message>" && git push origin main`
   - `cd lotus && git add -A && git commit -m "<message>" && git push origin main`
   - `cd bodhi && git add -A && git commit -m "<message>" && git push origin main`
   - If website changed: `cd pavilion && git add -A && git commit -m "<message>" && git push origin main`
2. Bump release version in manifests:
   - `bamboo/Cargo.toml`
   - `lotus/package.json` and `lotus/package-lock.json`
   - `bodhi/package.json`, `bodhi/package-lock.json`, `bodhi/src-tauri/Cargo.toml`, `bodhi/src-tauri/tauri.conf.json`, `bodhi/Cargo.lock`
   - `.github/release-train.config.json` (`versions.release`, `versions.bamboo`, `versions.lotus`, `versions.bodhi`)
3. Commit and push version bump in each released submodule:
   - `cd bamboo && git add Cargo.toml && git commit -m "chore: bump version to <version>" && git push origin main`
   - `cd lotus && git add package.json package-lock.json && git commit -m "chore: bump version to <version>" && git push origin main`
   - `cd bodhi && git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/tauri.conf.json Cargo.lock && git commit -m "chore: bump version to <version>" && git push origin main`
4. Commit and push root pointer/config updates:
   - `git add .github/release-train.config.json .gitmodules bamboo lotus bodhi pavilion README.md AGENTS.md`
   - `git commit -m "chore: prepare <version> release train"`
   - `git push origin main`
5. Trigger release train:
   - `gh workflow run release-train.yml -R bigduu/Zenith --ref main -f release_version=<version> -f bamboo_version=<version> -f lotus_version=<version> -f bodhi_version=<version> -f bamboo_ref=main -f lotus_ref=main -f bodhi_ref=main`
6. Watch and verify:
   - `gh run watch <root_run_id> -R bigduu/Zenith --exit-status`
   - `gh run list -R bigduu/Bamboo-agent --workflow publish-crate.yml --limit 1`
   - `gh run list -R bigduu/Lotus --workflow publish-npm.yml --limit 1`
   - `gh run list -R bigduu/Bodhi --workflow release.yml --limit 1`
7. If Bodhi Linux fails with npm `ETARGET` for Lotus:
   - wait until `npm view @bigduu/lotus@<version> version` succeeds
   - rerun failed job only: `gh run rerun <bodhi_run_id> -R bigduu/Bodhi --failed`
