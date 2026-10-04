# Release readiness — read-only review, refreshed 2026-10-04

This is preparation, not a release approval or a completed release. No workflow was dispatched, tag pushed, tap updated, credential accessed, or root gitlink/configuration changed. Supervisor #1481 and #791 work remains outside this task. Documentation publication is separately authorized; this review does not authorize releases or Homebrew updates.

## Current release policy cannot pass

This snapshot is tied to accepted Zenith `main` commit `93aa6fc796564602168ad6120d7c6a78d69002e3`, checked on 2026-10-04. The checked-in release authority is `.github/release-train.config.json`. The policy workflow checks **committed root gitlinks**, then checks that downstream dispatch branches still point at the exact accepted revision. Local documentation commits in submodule worktrees are not accepted release candidates.

| Source | Root HEAD gitlink | Config authority | Remote dispatch ref observed | Result |
|---|---|---|---|---|
| Bamboo | `025641317c5703226052a4b94a52d1844615c352` | `d0e4dd8c56dba13977df18ab713c729a5882ac54` | `dev`: `2f393c92da8ef592fa1bce19106bc82a4ebf194d` | Root/config mismatch; dispatch/config mismatch |
| Bodhi | `6d850368c6fe83bea85c70aea7d8426ee5575321` | same as root | `main`: `36c3f11c8c237380cd56c6b0ab1cb73fb176c874` | Root matches, but dispatch ref has advanced |
| Lotus Next | `1131c275cb441694a41f996228d9f91473d920f5` | artifact source `a480e2bb94f5dd08fe4b01b2f8844a2c9ed03245` | `main`: `6e6bd0d277502c7e56f085d51762072ab9bb5fa4` (may advance independently of the locked artifact) | Root/artifact-source mismatch |

Evidence: `git ls-tree HEAD bamboo bodhi lotus-next`, read-only `git ls-remote` on Bamboo `dev` and Bodhi `main`, and `.github/workflows/release-policy.yml` functions `verify_root_pointer` / `verify_dispatch_source`. Remote observations can change; repeat immediately before any authorized release.

`node --test scripts/release-train-policy.test.cjs` passed **10/10**. Running the policy CLI `resolve` also succeeded. Those establish that the configuration is structurally accepted, not that live source/artifact gates pass. The mismatches above would fail the workflow's exact-source step.

Configured downstream version is `2026.10.4`. Configured frontend is `@bigduu/lotus-next@2026.9.22`, with one fixed rollback `@bigduu/lotus@2026.8.28`. This review has not downloaded and verified both npm tarballs, confirmed whether downstream version `2026.10.4` is already published, run platform release builds, or checked signing availability. Do not change recorded hashes to accommodate different bytes or reuse a published version. `resume=true` is for the same exact partial train, not a newer source under an old version.

## Homebrew snapshot and update ownership

Reviewed tap: [`bigduu/homebrew-tap`](https://github.com/bigduu/homebrew-tap), commit `4684d244053c7c0216165b0a1a58f1de56d3f2c4` (`feat: self-sign Bodhi in Homebrew postflight (#3) (#4)`). No tap edits were made.

| Tap entry | Current source/version | Installation and dependencies | Update path observed |
|---|---|---|---|
| `Formula/jiandu.rb` | `v0.2.0` GitHub source archive | Builds `crates/jiandu-mcp` with Homebrew Rust; no background service | Jiandu has only `ci.yml` in the inspected workflow directory; no automated release/tap update was found. A deliberate maintainer update is needed unless another external process exists. |
| `Formula/nova.rb` | `v0.2.1` universal Apple Darwin release archive | macOS-only CLI; no Nova.app installation | Nova release workflow has an optional automatic tap update, described below. |
| `Casks/bodhi.rb` | `2026.9.20`, separate arm64/Intel DMG hashes | macOS app; depends on `bigduu/tap/jiandu` and `bigduu/tap/nova`; Bamboo bundled in app | Inspected Bodhi release workflow publishes verified releases but has no Homebrew update step. Tap cask update is a separate maintainer operation. |

Nova `.github/workflows/release.yml` defines `gate` after `build`; it reports only whether `HOMEBREW_TAP_TOKEN` is nonempty. `homebrew` needs `[build, gate]` and runs if `needs.gate.outputs.homebrew == 'true'`. It generates `Formula/nova.rb` from the **actual build outputs** (`version`, `asset`, `sha256`) and commits/pushes `bigduu/homebrew-tap` directly. It does not depend on Windows/plugin completion. A Nova release may therefore mutate the tap before all other release jobs finish. Secret presence and token permission were **not verified**; no secret value was read or requested. Do not promise an automatic tap update until authorized workflow results confirm it.

The Bodhi cask currently removes the installed app's quarantine attribute and ad-hoc re-signs it locally. This is not Developer ID signing or notarization. Its `postflight_steps` and tap README accurately document that behavior. A new release's signing state must be checked before carrying those steps forward; the tap CI currently explicitly expects `Signature=adhoc`, so a notarized release requires an intentional cask/test change too.

The tap `check.yml` runs on Apple Silicon (`macos-15`) and Intel (`macos-15-intel`): strict audits, asset fetch/hash verification, install-plan check, actual cask/dependency installation, architecture/signature/quarantine checks, CLI smoke checks, and dependency assertions. None of those macOS checks ran in this Linux review. Existing hashes were inspected, not regenerated or independently verified against downloaded assets.

The 2026-10-04 public recheck still resolves Bamboo GitHub releases to `v2026.3.3`, Bodhi to `app-v2026.9.20`, Jiandu to `v0.2.0`, and Nova to `v0.2.1`. The official Cargo sparse index still ends at non-yanked `bamboo-agent@2026.9.20`. These are observations of published surfaces, not a claim that the configured `2026.10.4` candidate is ready or that a version is available for reuse.

## Safe proposed publication sequence

1. Obtain explicit authorization for public releases and their side effects, including Nova's possible automatic tap push. This document does not authorize those actions.
2. Have owners finish and merge intended source changes through each repository's protected flow. Exclude unfinished Supervisor work and unmerged feature branches; identify the exact approved release scope first.
3. If a new Lotus Next artifact is required, run its own producer verification/publication, then accept the exact package/version/source/digests in Bamboo and Bodhi. Otherwise retain the existing artifact identity and align the approved source plan with it; do not silently substitute moving `latest`.
4. Through a separate authorized, focused Zenith change, reconcile root gitlinks and the release authority with those accepted, merged source revisions. Re-run focused tests, workflow syntax checks, exact remote-ref checks, and both npm artifact round trips. Select a verified unused downstream version or an exact partial-train resume; do not invent versions or hashes in advance.
5. Use the normal **Zenith `release-train.yml` entrypoint**, which releases Bamboo before Bodhi. Confirm downstream workflow `headSha` and final artifact identity. Bodhi finalization must succeed before treating its draft artifacts as published.
6. Release Jiandu/Nova/Magpie independently only if their new source capabilities are meant to be part of the public offering and those releases are authorized. They are not targets of the two-target Bamboo/Bodhi train. For Nova, account for the optional automatic tap job; do not race a manual formula update against it.
7. After final upstream assets exist, prepare Bodhi/Jiandu tap updates (and Nova only if automation did not produce the correct result). Compute SHA-256 from downloaded final assets, review the diff, and run both macOS tap CI jobs before merging through the authorized flow. Keep Bodhi's Jiandu/Nova dependencies; verify version compatibility rather than merely choosing every newest release.
8. Update README release claims and recordings against the actual published artifacts and verified installation path. Existing source-only documentation can remain explicit about its source/release boundary in the meantime. No cloud terminal recording establishes a successful macOS Homebrew or native desktop install.
