# README refresh: evidence and local delivery

Audited 2026-10-03. The task edits documentation and actual recording assets only.
The isolated worktree is `/workspace/zenith-readme`, branch `docs/readme-refresh`.
Original Zenith base: `f17d93372db51d7b81210e4e8227f31e8e6bde73`.
No remote writes, release dispatches, pushes, PRs, merges or deployments occurred.
Supervisor #1481 and #791 source branches were not modified.

## All eight submodules

Enumerated from `.gitmodules`. Gitlink pins in the root commit are preserved.
Local documentation commits inside submodules are separate deliverables; their
checked-out HEADs therefore differ from the root pins. A future root pointer
update must follow module review/merge, and is intentionally not part of this task.
The root copies recording assets so its own preview does not require new gitlinks.

| Module | Original Zenith pin | Observed upstream | Published evidence | Documentation change |
|---|---|---|---|---|
| Bamboo | `0256413` | dev `0256413`; main `28b4f84` | crates `2026.9.20`, VCS `284cfd0`; GitHub release `v2026.3.3` is older | EN/ZH rewritten for project work, runtime/API entry points and real configuration; removed recall/maturity guarantees |
| Bodhi | `6d85036` | main `d0e40e8` | `app-v2026.9.20`, locks UI `2026.9.16` | EN/ZH installation and native boundaries; assembly details retained in bilingual development docs |
| Lotus Next | `1131c27` | main `1131c27` | npm `2026.9.22`, source `a480e2b` | Corrected canonical UI status, user workflows, live backend requirements and published/source distinction |
| Nova | `19dfeaa` | HEAD `19dfeaa` | `v0.2.1`, 71 commits behind source | Root, Chrome, npm and plugin READMEs clarify source-only features, platform/permission requirements |
| Jiandu | `5b50834` | HEAD `5b50834` | `v0.2.0`, 8 commits behind source | Memory use cases, true MCP examples, fixed release identity versus source per-call context/console |
| Magpie | `192de16` | HEAD `192de16` | `v0.1.1`, 6 commits behind source | Messaging prerequisites and source/release boundary; plugin config path corrected |
| Pavilion | `b1a06f4` | HEAD `b1a06f4` | No GitHub releases observed | EN/ZH corrected eight-module map and default UI; illustrative homepage timeline clearly identified |
| Bodhi Server | `7d1d25b` | HEAD `7d1d25b` | No GitHub releases observed | EN/ZH optional hosted-service role and prerequisites; admin README replaces generic Vite template |

Every module includes a `docs/readme-audit.md` in its local documentation commit,
with commands, code locations and version evidence. Existing README language sets
are preserved: Bamboo/Bodhi/Pavilion/Bodhi Server EN+ZH; Lotus Next/Nova/Jiandu/
Magpie have their existing English README coverage (some contain Chinese UI labels).
No missing language file is advertised.

Registry evidence was read from official npm/crates endpoints and package
provenance. GitHub API returned 403 in this environment; public release HTML,
release redirects and `git ls-remote` supplied the corresponding public evidence.
A tag, source manifest, config value or development commit is not treated as
proof that a packaged release contains all current source features.

- [Bamboo published releases](https://github.com/bigduu/Bamboo-agent/releases)
- [Bodhi published releases](https://github.com/bigduu/Bodhi-AI/releases)
- [Nova published releases](https://github.com/bigduu/Nova/releases)
- [Jiandu published releases](https://github.com/bigduu/Jiandu/releases)
- [Magpie published releases](https://github.com/bigduu/Magpie/releases)
- [Homebrew and release readiness](release-readiness.md)

## Recordings

These are real Chromium captures of running code. Synthetic data is explicitly
identified; no personal configuration, credentials, private chats or daily desktop
were read. GIFs were converted from actual browser videos, palette-compressed,
decoded and visually reviewed. Every GIF has a static PNG and alt text. They loop
indefinitely. No recording calls an LLM or claims autonomous task completion.

### Prepare project context — Bamboo + Lotus Next

![Lotus Next creates a demo project through Bamboo and selects it for the next task.](demos/project-workspace.gif)

[Static alternative](demos/project-workspace.png)

1100×720, 15.38 s, 2,193,821 bytes. Real project creation through the UI, verified
against Bamboo's API response. No task is submitted. Lotus source `1131c27` and
Bamboo source `0256413`; not a published Bodhi or macOS/Windows acceptance run.
The setup-complete marker was applied only to a fresh disposable server to allow
this provider-free flow. Scripts and API evidence: `lotus-next/docs/demos/`.

### Recall a saved fact — Jiandu

![Jiandu searches a dedicated project for a demo release checklist and opens its saved text.](demos/memory-console.gif)

[Static alternative](demos/memory-console.png)

1120×800, 16.6 s, 3,093,178 bytes. A real stdio MCP host wrote one explicitly
labelled demo fact before recording. The source-only read-only console searches
and opens it. Source `5b50834`; this console is not in published `v0.2.0`.
Scripts and reproduction: `jiandu/docs/demos/`.

### Act on a browser page — Nova

![Nova's real browser MCP actions check two items on a demo page and prepare a review.](demos/browser-checklist.gif)

[Static alternative](demos/browser-checklist.png)

900×720, 17.13 s, 1,794,592 bytes. Nova launches the official pinned Chrome DevTools
MCP; actual MCP calls navigate, inspect and click a disposable fixture page.
A disclosed recording-only `--npx` adapter connects the dedicated Playwright
browser for capture; no product code was changed. The checklist labels do not
mean a real release was reviewed. Source tree `19dfeaa` (recorded after its docs-only
commit `d59dbf8`); launcher is not in release `v0.2.1`. No native GUI was tested.
Scripts, fixture and nine-call MCP transcript: `nova/docs/demos/`.

## Validation and remaining limits

- Bamboo source build and frontend staging succeeded; the locked frontend package
  is Lotus Next `2026.9.22`. Health returned `OK` for the isolated recording server.
- Jiandu source build, formatting, metadata and full tests passed. Its required
  Clippy gate fails on existing `nonminimal_bool` diagnostics at
  `crates/jiandu-memory/src/memory_store/paths.rs:245,255` and
  `crates/jiandu-memory/src/memory_store/store.rs:2756`. No source fix was made; use
  `cargo clippy --workspace --all-targets --all-features -- -D warnings` to reproduce.
- Nova source build and actual browser MCP flow succeeded. A headless Linux
  recording does not validate Mac/Windows permissions or native desktop tools.
- Root release policy unit tests: 10/10 passed. This does **not** make the current
  release inputs publishable: exact-source mismatches remain, as documented in
  [release readiness](release-readiness.md).
- Markdown file links, whitespace, recording-script syntax and GIF decoding/loop
  metadata were checked. No provider, live messaging, hosted database, Homebrew
  install, native desktop acceptance or deployment was run.

The user subsequently suggested release first and Homebrew updates. A concrete
readiness review is included; public mutation was not undertaken because the
original task explicitly prohibited it and expanded authorization remained pending.
The current tap matches observed releases; new source capability requires a real
new release before new asset versions/hashes can be written and verified.

## Local documentation commits

Full SHAs and unchanged original pins: [commits.json](commits.json).

| Module | Documentation HEAD |
|---|---|
| bamboo | `8ce8a5046dc88d49d1bdfe88398aac55916ced0d` |
| bodhi | `363766d609bf9f7fd454231952a9786c1b8e32c0` |
| bodhi-server | `1ca0c2beb7000136931055567036dd0b3379711d` |
| lotus-next | `feb3c4dc97888c5ef7b721d3cb02bc2bac6d6b3b` |
| nova | `57b8636c5137e4dec338a1a784bc2437ad8713d7` |
| jiandu | `5a58cbb9f635c39e343aae179b86ef684b04eec3` |
| magpie | `0b01b206c13d33a080fab1a7d862df10f115b35d` |
| pavilion | `148d22e963c2ff9aa50b7bbc5c2035d265d4d66f` |
