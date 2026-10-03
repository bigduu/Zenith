# Independent documentation and media QA

Date: 2026-10-03. A separate reviewer checked the root plus all eight modules,
current source instructions, release evidence, claims and actual recording scope.
No product code, root gitlinks or release configuration changed.

## Findings and resolution

1. **P2 — project demo did not independently isolate Jiandu.** `--data-dir`
   isolates Bamboo only. Startup background memory maintenance can access the
   separately selected Jiandu root even without an explicit memory UI action.
   The old recording was withdrawn, not uploaded to Library, and replaced using
   fresh Bamboo and Jiandu roots and explicit `BAMBOO_JIANDU_DATA_DIR`.
   `strace -f -e trace=%file` from launch through the new recording observed
   17 isolated-root accesses, zero default Jiandu/Bamboo-root references and
   zero `memory/v1` paths outside the isolated root. The startup log selected
   `mode="explicit"`. Sanitized evidence: `lotus-next/docs/demos/isolation-evidence.json`.
   Default Jiandu root was absent at investigation time; old logs do not establish
   its historical state. No default-store contents were read. Old visible frames
   contained only the demo project, but no retrospective backend-isolation claim
   is made. Old assets remain in local history and must not be used as the delivery.
2. **P2 — default Bodhi lifecycle was described as start-or-reuse.** Corrected
   Bamboo, Pavilion and Bodhi Server READMEs, including their existing Chinese
   versions. Default Lotus Next builds start and health-check an owned sidecar;
   external-server reuse is limited to the explicit legacy rollback path.
   Evidence: `bodhi/src-tauri/src/lib.rs:236-239`.
3. **P3 — Nova command said source/release binary.** Corrected the `chrome-devtools`
   example to current-source binary only, with an explicit note that published
   `v0.2.1` lacks the subcommand.

## What each recording actually demonstrates

| Recording | Runtime and entry point | Data / input driver | Model call? | Claim supported |
|---|---|---|---|---|
| Project workspace | Bamboo `0256413` `bamboo serve`; Lotus Next `1131c27` Vite UI | Fresh Bamboo/Jiandu roots, temporary workspace; real Playwright UI input and real project API | No | Create a project and select its context for a future task |
| Memory console | Jiandu `5b50834`, actual stdio `memory` tool then `jiandu ui` | Dedicated host-authorized Project in a temporary store; MCP seed before browser recording | No | Search and open a saved fact in the source-only read-only console |
| Browser checklist | Nova source tree `19dfeaa` (recorded after docs-only `d59dbf8`), `nova chrome-devtools --headless --npx <adapter>` | Dedicated local fixture; actual official `chrome-devtools-mcp@1.8.0` calls; capture adapter selects disposable browser | No | Navigate, inspect and click browser controls through MCP |

None demonstrates model reasoning, autonomous end-to-end work, released desktop
acceptance, native operating-system interaction or an actual documentation release.
Nova fixture checklist text is demonstration data, not a claim that reviews ran.
The source-only qualifiers appear directly beside each README embed:
`bamboo/README{,.zh-CN}.md`, `lotus-next/README.md`, `nova/README.md`,
`jiandu/README.md`, and the root's two READMEs. Full reproduction stays in each
recorded module's `docs/demos/`.

## Media checks

All GIFs were fully decoded and checked for loop count 0. Middle and final frames
were independently viewed after project rerecording. At original resolution the
text and state changes are readable; narrow mobile rendering reduces small text,
so static PNG links are retained for zooming. No guarantee of small-screen text
legibility without zoom is made. GIFs are palette-compressed recordings, not
image-generated or composited simulations.

| Final GIF | Dimensions | Duration | Bytes |
|---|---:|---:|---:|
| project-workspace.gif | 1100×720 | 15.51 s | 2,033,461 |
| memory-console.gif | 1120×800 | 16.60 s | 3,093,178 |
| browser-checklist.gif | 900×720 | 17.13 s | 1,794,592 |

## Installation and version checks

All nine repository roles were checked against manifests, start scripts and
source references in their `docs/readme-audit.md`. Source-build commands are
separated from published installation routes. Platform restrictions and external
provider/messaging/database configuration are retained. This is source/command
inspection plus the three explicit Linux runs, not a rerun of every installation.
Bamboo staging/build, Jiandu build/tests, Nova build and the three local flows ran.
No Mac/Windows/Homebrew, live messaging, real provider or hosted database acceptance
is inferred. Jiandu's previously reported Clippy errors remain source limitations.

The root's committed eight pins remain unchanged. Each submodule's documentation
branch has a clean internal working tree after its commits, but root `git status`
reports eight `M` submodules because their HEADs differ from the old gitlinks.
**The root is not reported as entirely clean.**

## Brand-image and release boundary

The original Bamboo SVG was identified and preserved. Candidate imagegen brand
illustrations are separate from real software captures. Official Library download
plus one supported retry failed for the supplied candidates; they were not added
to the repository. A subsequent user request explicitly paused those candidates
pending redesign. No unreadable candidate or dead reference is committed.

The only direct release-related user message received was:

> 那可能要考虑先release 然后再更新README, homebrew 也要更新

The coordinating follow-ups explicitly keep release/Homebrew/push/PR outside this
work. No release or Homebrew mutation was performed; read-only readiness findings remain in
`release-readiness.md`.

A subsequent explicit authorization permits documentation branch pushes and draft
PRs for MacBook handoff. This cloud task does not merge them or integrate feature
branches; the prior no-public-write statement describes the initial local phase.
