# Repository Guidelines

## Project Structure & Module Organization
Zenith is a thin monorepo wrapper around eight Git submodules:
- `bamboo/`: Rust AI-agent backend framework (`src/`, `tests/`, `docs/`).
- `bodhi/`: Tauri desktop shell (`src-tauri/`) that coordinates with `lotus-next`.
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
- `cd lotus-next && npm run dev` - run the canonical web app locally.
- `cd lotus-next && npm run type-check && npm run test:run` - TS + Vitest validation.
- `cd lotus-next && npm run test:e2e` - Playwright browser tests.
- `cd bodhi && npm run tauri:dev` - run desktop app in development mode.
- `cd pavilion && npm run dev` - run website/docs locally.

## Coding Style & Naming Conventions
- Rust (`bamboo`): enforce `cargo fmt` and `cargo clippy`; use `snake_case` for functions/modules, `PascalCase` for types.
- TypeScript/React (`lotus-next`, `bodhi`): follow each module's formatter/linter; use `PascalCase` for components/classes, `camelCase` for functions/variables, and `use*` for hooks.
- Keep tests near code when possible (`*.test.ts`, `*.test.tsx`) and use explicit, behavior-focused names.

## Testing Guidelines
Run the smallest meaningful suite while iterating, then run full affected suites before opening a PR. Minimum expectation:
- Backend changes: `cargo test` in `bamboo`.
- Frontend changes: `npm run test:run` in `lotus-next`.
- UI/workflow changes: include `lotus-next/e2e` coverage when behavior crosses pages or services.

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

- There is no fixed per-module agent limit. Independent acceptance slices may
  proceed in parallel, including within the same module or across modules.
- Coordinate by explicit file and contract ownership. Serialize overlapping
  edits or changes to the same persistence, recovery, lifecycle, or authority
  boundary; a busy module alone does not block unrelated work.
- Coordinate shared manifests and lockfiles before integration. Recheck the
  current base, resolve conflicts in an isolated worktree, and refresh affected
  tests and review evidence for the combined changes.
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
- `lotus-next/feat/142-conversation-export`
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

Examples: `[lotus-next] feat: add conversation export`, `[bamboo] fix: streaming timeout`

## Release Playbook

Each producer and product owns its release workflow. Zenith owns source gitlinks and documentation; it does not publish, allocate downstream versions, dispatch another repository, or recover Bodhi drafts. Use the [Bodhi release playbook](https://github.com/bigduu/Bodhi-AI/blob/main/docs/releasing.md) for exact commands and recovery requirements.

1. Land source and lock changes through the owning repository's reviewed PR flow:
   - Use isolated branches/worktrees and Conventional Commits. Bamboo feature PRs target `dev`; promotion to `main` remains a separate change.
   - Lotus Next publication is a separate protected producer step. Publish and verify its exact npm artifact before accepting that identity in a consumer lock.
   - Bodhi owns `scripts/bamboo-sidecar-lock.json` and `scripts/frontend-package-lock.json`. Preserve their full source, version, target and digest identities; do not substitute a moving `latest`, registry bytes with edited digests, or a local source build.
   - Bamboo's embedded frontend and Bodhi's external static directory can use different accepted Lotus Next identities. Validate each consumer's own lock.
   - Update Zenith gitlinks in a separate focused PR after source merge. Those development pins are not a publication prerequisite or a second artifact lock.

2. Verify the exact candidate in the owning repository:
   - Bamboo: `cargo fmt --check`, `cargo clippy` and `cargo test`, plus its publisher's source, dependency-closure and frontend gates.
   - Lotus Next: `npm run verify` and `npm run test:e2e:built`, plus its publish workflow's real Bamboo round trip.
   - Bodhi: `npm run test:build`, `node scripts/verify-boundaries.cjs migration`, `node scripts/verify-boundaries.cjs docs-boundary`, and actionlint for its workflows.
   - Bodhi retains all four native targets: macOS Intel, macOS ARM64, Linux x64 and Windows x64. Real assembly, actor transport, browser-host and external static-directory gates must pass before final publication.
   - Zenith policy changes: `node --test scripts/repository-policy.test.cjs` and `actionlint .github/workflows/*.yml`. No registry downloads or cross-repository publication checks run here.

3. Publish independently:
   - Bamboo publishes from its own successful main CI source or authorized exact-source manual publisher. Keep its publication queue and provenance checks in Bamboo.
   - Bodhi's `release.yml` takes an explicit unused `bodhi_version` and full `expected_source_sha`, dispatched directly in `bigduu/Bodhi-AI` against that source. Source manifests retain `0.0.0`; only temporary publishing checkouts are stamped. The candidate's committed upstream locks remain authoritative.
   - An ordinary Bodhi shell release reuses the locked published Bamboo binary and frontend. It does not republish Bamboo or Lotus Next.
   - Watch the owning repository's run and verify its exact source, all four platform outcomes, final `app-v<version>` and eight asset identities. A draft or version's mere existence is not successful publication.

4. Recover in the owning repository:
   - Never rerun a Zenith train or dispatch through an old frozen train definition. Existing published assets and historical tags remain unchanged.
   - Bodhi recovery binds the original release run, original attempt, exact source/version and verified asset receipt. All four original native jobs and gates must have succeeded; only finalization may be recovered without rebuilding.
   - Missing or mismatched source, lock, gate, receipt or asset evidence stops recovery. A failed native build is not a finalizer-only recovery candidate.
   - If a producer lock needs changing, publish and verify a new producer artifact, then accept it through a consumer PR. Do not mutate a lock to fit unexpected bytes or reuse a version for a different source.

5. Verify delivery:
   - Check final published identities in the producer/product repository. Source, configuration or a green fixture suite alone does not establish publication or native acceptance.
   - The Homebrew tap independently follows stable Bodhi, Jiandu and Nova releases through its update PR and ARM64/Intel macOS checks. Zenith does not dispatch or update the tap.
   - A tap no-op means its definitions already match published releases; installed users still run `brew update`, `brew upgrade bigduu/tap/jiandu bigduu/tap/nova`, and `brew upgrade --cask bigduu/tap/bodhi`.
