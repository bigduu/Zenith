# Repository Guidelines

## Project Structure & Module Organization
Zenith is a thin monorepo wrapper around nine Git submodules:
- `bamboo/`: Rust AI-agent backend framework (`src/`, `tests/`, `docs/`).
- `lotus/`: React + Vite web app (`src/`, `e2e/`, `public/`).
- `bodhi/`: Tauri desktop shell (`src-tauri/`) that coordinates with `lotus`.
- `pavilion/`: React + Vite official website and docs (`src/`, `public/`).
- `bodhi-server/`: Go backend API server (`api/`, `internal/`, `cmd/`).
- `nova/`: Rust computer-use MCP server for native desktop interaction.
- `lotus-next/`: responsive next-generation React + Vite frontend.
- `magpie/`: standalone IM connector and Bamboo service plugin.
- `jiandu/`: agent-independent, filesystem-backed shared-memory MCP service.

Root files (`README.md`, `.gitmodules`) manage submodule pointers; most feature work happens inside submodules.

Key architecture docs (in `bamboo/docs/`):
- `architecture-overview.md` — start here: how the broker-mediated sub-agent system deploys (broker / orchestrator / worker), how the crates are organized, and how the deployment capability works.
- `remote-mailbox-broker-design.md` — the standalone message broker + `ask_agent`/`deploy_agent` design (SHIPPED status).
- `remote-actor-plan.md` — remote-actor seams (P0/P1/P2): launcher / discovery / placement abstractions.

## Shared Memory via Jiandu MCP

Use the Jiandu server's single `memory` tool; an MCP host may expose it under a
namespace such as `mcp__jiandu__memory`. Select behavior with its `action`.
Never edit Jiandu data files directly or create repository files as a memory
fallback. Bamboo may optimize recalled memory while assembling agent context;
other agents should use the same store only through Jiandu MCP.

- Recall before guessing: use `query` when prior user preferences, confirmed
  decisions, or project history may affect the task. Use `get` for an ID returned
  by `query` when the exact or full item is needed. Use `session_read` for current
  host-session or workstream continuity, such as after resuming or compaction;
  session memory is not cross-session durable recall.
- Record at the right layer: use `session_append` for temporary progress,
  blockers, hypotheses, and next steps. Keep the note concise and use
  `session_replace` when it needs compression. Use `write` only for a confirmed,
  durable, non-derivable fact that will help future sessions. Query first, then
  store one atomic fact with a specific, searchable title. Never store secrets,
  credentials, or tokens.
- Respect scope and authority: Project/global durable memory is the cross-agent
  surface for agents connected to the same Jiandu data store; session memory is
  tied to the host `session_id`. Use Project scope for project-specific decisions
  and references, and Global only for truly cross-project preferences or stable
  references. Project access comes only from the MCP host context. Normally omit
  `project_key`; if supplied, it may only match the host Project. Never invent or
  copy a `project_key`, and never move a Project fact to Global because Project
  access is unavailable.
- Keep scratch out of durable memory: do not persist logs, tentative conclusions,
  derivable code facts, current file or runtime state, or routine task completion
  with `write`.
- Treat memory as supporting evidence: an empty query does not prove a fact is
  false, and recalled memory must be checked against current files and tools.
  Correct an evident argument or context error, but do not loop or claim recall or
  persistence unless the MCP call succeeds. A mutation error or interrupted
  response has an unknown outcome: run `inspect` first, run `rebuild` if only
  derived artifacts are stale, then verify with `query` or `get`; never blindly
  retry. If Jiandu is unavailable, continue from current evidence, disclose the
  gap when it materially affects the answer, and do not write a fallback memory
  file into the repository.

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

### 2.1 Scope Control and Issue Splitting

- Before implementation, define one end-to-end acceptance slice, its explicit
  in-scope files/systems, its non-goals, and a 4-8 hour delivery estimate.
- Recheck scope after roughly 4 hours. If the work is likely to exceed 8 hours,
  split it before adding another subsystem. Work that reaches 12 elapsed working
  hours is a hard stop: preserve the WIP, turn the parent into a tracking Issue,
  and continue only through smaller child Issues and fresh branches/worktrees.
- Treat any of the following as an immediate split signal:
  - a second independent persistence, recovery, or lifecycle protocol;
  - changes spanning more than two independently deployable subsystems;
  - multiple acceptance criteria that can be shipped and verified separately;
  - a patch growing beyond roughly 15 core files or 1,500-2,000 net new lines;
  - a review finding whose reproduction and fix do not require the current
    Issue's acceptance path.
- Do not follow a chain of adjacent findings into unrelated repairs. A valid
  finding is not automatically a blocker for the current Issue. Classify every
  finding as exactly one of:
  1. introduced by the current diff and required for this acceptance slice;
  2. a pre-existing or adjacent bug that gets its own focused Issue;
  3. unrelated debt that is recorded without changing the current branch.
- Severity alone does not expand scope. If a severe problem is outside the
  current acceptance slice, stop and open/route a focused Issue. If the current
  change introduces the problem, prefer removing or narrowing that change over
  importing a new subsystem into the PR.
- A cross-module or multi-surface Issue that cannot fit the timebox is a tracker,
  not an implementation unit. Give each child Issue its own acceptance criteria,
  tests, non-goals, branch, worktree, and PR; do not attach one monolithic branch
  to the parent tracker.
- Reviewers and implementation agents must report scope expansion as soon as it
  appears. Do not continue polishing a monolithic WIP because time has already
  been invested; preserve it as reference material and extract only focused,
  independently verifiable changes.

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
- After agent review, add `review:agent` label and remove `review:needed`.
- Agents may merge when acceptance criteria are satisfied, required checks are green,
  no unresolved review thread or requested change remains, the live PR head/base and
  mergeability have been reverified, and branch protection permits the merge.
  Human approval is required only when explicitly requested by the user or repository
  protection rules.
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
| `review:agent` | Agent review complete; merge gates may proceed |
| `scope:cross-module` | Requires coordination across modules |

### Issue Title Convention

```
[module] type: short description
```

Examples: `[lotus] feat: add conversation export`, `[bamboo] fix: streaming timeout`

## Release Playbook
Use this checklist for every release train. The only normal release entrypoint is `Zenith -> release-train.yml`.

1. Collect and commit local work by feature in each changed submodule:
   - Check status first: `git status -sb` and `git submodule status`.
   - Commit related changes in small logical groups (Conventional Commits), then push submodule branches.
   - Typical commands:
     - `cd bamboo && git add -A && git commit -m "<message>" && git push origin main`
     - `cd lotus && git add -A && git commit -m "<message>" && git push origin main`
     - `cd bodhi && git add -A && git commit -m "<message>" && git push origin main`
     - If website changed: `cd pavilion && git add -A && git commit -m "<message>" && git push origin main`

2. Run release gates (must pass before version bump):
   - `cd bamboo && cargo fmt --check && cargo clippy && cargo test`
   - `cd lotus && npm run type-check && npm run test:run && npm run lint`
   - `cd bodhi && npm run web:verify:migration && npm run web:verify:docs-boundary`
   - If website changed: `cd pavilion && npm run lint && npm run build`
   - For cross-page UI or workflow changes, also run `cd lotus && npm run test:e2e`.

3. Bump release version in manifests:
   - `bamboo/Cargo.toml`
   - `lotus/package.json` and `lotus/package-lock.json`
   - `bodhi/package.json`, `bodhi/package-lock.json`, `bodhi/src-tauri/Cargo.toml`, `bodhi/src-tauri/tauri.conf.json`, `bodhi/Cargo.lock`
   - `.github/release-train.config.json` (`versions.release`, `versions.bamboo`, `versions.lotus`, `versions.bodhi`)
   - Helpful commands:
     - `cd lotus && npm version <version> --no-git-tag-version`
     - `cd bodhi && npm version <version> --no-git-tag-version`

4. Commit and push version bumps in each released submodule:
   - `cd bamboo && git add Cargo.toml && git commit -m "chore: bump version to <version>" && git push origin main`
   - `cd lotus && git add package.json package-lock.json && git commit -m "chore: bump version to <version>" && git push origin main`
   - `cd bodhi && git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/tauri.conf.json Cargo.lock && git commit -m "chore: bump version to <version>" && git push origin main`

5. Commit and push root pointer/config updates:
   - `git add .github/release-train.config.json bamboo lotus bodhi pavilion`
   - `git commit -m "chore: prepare <version> release train"`
   - `git push origin main`

6. Trigger release train:
   - `gh workflow run release-train.yml -R bigduu/Zenith --ref main -f release_version=<version> -f bamboo_version=<version> -f lotus_version=<version> -f bodhi_version=<version> -f bamboo_ref=main -f lotus_ref=main -f bodhi_ref=main`

7. Watch and verify release chain:
   - `gh run watch <root_run_id> -R bigduu/Zenith --exit-status`
   - `gh run list -R bigduu/Bamboo-agent --workflow publish-crate.yml --limit 1`
   - `gh run list -R bigduu/Lotus --workflow publish-npm.yml --limit 1`
   - `gh run list -R bigduu/Bodhi --workflow release.yml --limit 1`

8. Failure handling:
   - If Bodhi Linux fails with npm `ETARGET` for Lotus:
     - Wait until `npm view @bigduu/lotus@<version> version` succeeds.
     - Rerun failed jobs only: `gh run rerun <bodhi_run_id> -R bigduu/Bodhi --failed`.
   - If root release train fails due transient GitHub API issues, resume the chain manually in the same Bamboo -> Lotus -> Bodhi order.

9. Post-release checks:
   - `git status -sb` at root and inside all submodules (must be clean).
   - `npm view @bigduu/lotus@<version> version`
   - `cargo search bamboo-agent --limit 1` (confirm expected version is published)
