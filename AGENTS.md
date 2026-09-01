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
- `jiandu/`: agent-independent filesystem memory store and one-tool stdio MCP server.

Root files (`README.md`, `.gitmodules`) manage submodule pointers; most feature work happens inside submodules.

Key architecture docs:
- `bamboo/docs/design/architecture-overview.md` — start here: how the broker-mediated sub-agent system deploys (broker / orchestrator / worker), how the crates are organized, and how the deployment capability works.
- `bamboo/docs/design/remote-mailbox-broker-design.md` — the standalone message broker + `ask_agent`/`deploy_agent` design (SHIPPED status).
- `bamboo/docs/design/remote-actor-plan.md` — remote-actor seams (P0/P1/P2): launcher / discovery / placement abstractions.

## Shared Memory via Jiandu MCP

Use the Jiandu server's single `memory` tool; an MCP host may expose it under a
namespace such as `mcp__jiandu__memory`. Select behavior with its `action`.
Never edit Jiandu data files directly or create repository files as a memory
fallback. Bamboo may optimize recalled memory while assembling agent context;
other agents should use the same store only through Jiandu MCP.

- Recall before guessing. Build a short lexical `query` from the useful keywords
  and entities; a non-empty query defaults to three compact IDs and summaries.
  Use `get` only for a selected item, and use `session_read` only for continuity
  within the current host session or workstream. Do not request embeddings.
- Write at the right layer. Use Session notes for concise temporary progress; use
  durable `write` only for a confirmed, non-derivable fact that will help a future
  session. Do not store secrets, raw logs, tentative conclusions, or routine task
  completion.
- Treat Jiandu's independent data root as the only canonical durable store.
  Migration may seed it once; hosts must not keep a dual writer, second index, or
  repository-file fallback.
- Respect scope and authority. Project memory is for project-specific facts,
  Global memory is only for truly cross-project facts, and Session memory stays
  tied to the host `session_id`. Project access comes from the MCP host; do not
  invent a `project_key` or move a Project fact to Global when access is absent.
- Jiandu persists host-generated Dream snapshots and maintains the optional
  portable usage Skill. The host still owns Dream model choice, prompting,
  cadence, retries, and scheduling, and must explicitly install or enable the
  Skill; the memory tool never executes or stores a complete Skill.
- Treat recalled memory as supporting evidence and verify it against current
  files and tools. If a mutation result is uncertain, verify the targeted topic
  or item before retrying. Run `rebuild` only when Jiandu explicitly reports stale
  derived artifacts. If Jiandu is unavailable, continue from current evidence,
  disclose a material gap, and do not create a fallback memory file.

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

1. Land release changes through each repository's protected pull-request flow:
   - Use isolated branches/worktrees and Conventional Commits; never push feature or release-preparation commits directly to `main`.
   - Bamboo feature PRs target `dev`. Release only commits that have reached the canonical ref selected in `.github/release-train.config.json`.
   - If Zenith submodule pointers or release configuration change, update them in a focused Zenith PR after the submodule commits are merged.

2. Run release gates against the exact candidate refs:
   - `cd bamboo && cargo fmt --check && cargo clippy && cargo test`
   - `cd lotus && npm run type-check && npm run test:run && npm run lint`
   - `cd bodhi && npm run web:verify:migration && npm run web:verify:docs-boundary`
   - If website changed: `cd pavilion && npm run lint && npm run build`
   - For cross-page UI or workflow changes, also run `cd lotus && npm run test:e2e`.

3. Resolve the release version without editing package manifests:
   - Bamboo, Lotus, and Bodhi source manifests intentionally keep `0.0.0` placeholders. Their publish workflows stamp the requested release version in the temporary publishing checkout.
   - For a config-driven release, update `.github/release-train.config.json` through a focused Zenith PR or let the nightly workflow advance it.
   - For an ad-hoc release, pass an unused `release_version` to the release train; do not commit version bumps in submodules.

4. Trigger the release train:
   - Config-driven full train: `gh workflow run release-train.yml -R bigduu/Zenith --ref main`.
   - Ad-hoc full train: `gh workflow run release-train.yml -R bigduu/Zenith --ref main -f release_version=<version>`.
   - Add `-f targets=lotus,bamboo` (or another dependency-ordered subset) for a partial release.

5. Watch and verify the release chain:
   - `gh run watch <root_run_id> -R bigduu/Zenith --exit-status`
   - `gh run list -R bigduu/Bamboo-agent --workflow publish-crate.yml --limit 1`
   - `gh run list -R bigduu/Lotus --workflow publish-npm.yml --limit 1`
   - `gh run list -R bigduu/Bodhi --workflow release.yml --limit 1`

6. Handle failures without changing the release order:
   - If Bodhi Linux fails with npm `ETARGET` for Lotus:
     - Wait until `npm view @bigduu/lotus@<version> version` succeeds.
     - Rerun failed jobs only: `gh run rerun <bodhi_run_id> -R bigduu/Bodhi --failed`.
   - If root release train fails due transient GitHub API issues, resume the chain manually in the same Bamboo -> Lotus -> Bodhi order.

7. Run post-release checks:
   - `git status -sb` at root and inside all submodules (must be clean).
   - `npm view @bigduu/lotus@<version> version`
   - `cargo search bamboo-agent --limit 1` (confirm expected version is published)
