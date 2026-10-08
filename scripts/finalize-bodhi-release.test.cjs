"use strict"
const test = require("node:test")
const assert = require("node:assert/strict")
const { verifyBuild, verifyDraft, assetIdentity } = require("./finalize-bodhi-release.cjs")
const source = { revision: "a".repeat(40), ref: "refs/tags/bodhi-source-2026.10.9" }
const version = "2026.10.9", runId = 42, attempt = 1, releaseId = 99
const gates = ["Require the exact accepted release source", "Set Bodhi app version (workflow override)", "Build Tauri app", "Verify exact frontend and real target sidecar", "Smoke native bundled sidecar actor transport", "Smoke bundled browser host", "Upload Build Artifacts to Workflow"]
function fixture() {
  const run = { id: runId, run_attempt: attempt, repository: { full_name: "bigduu/Bodhi-AI" }, path: ".github/workflows/release.yml", event: "workflow_dispatch", head_sha: source.revision, head_branch: "bodhi-source-2026.10.9", status: "completed", conclusion: "failure" }
  const platforms = ["macos-15-intel, x86_64-apple-darwin", "ubuntu-22.04, x86_64-unknown-linux-gnu", "windows-latest, x86_64-pc-windows-msvc", "macos-latest, aarch64-apple-darwin"]
  const jobs = platforms.map((p) => ({ name: `publish-tauri (${p}, args)`, head_sha: source.revision, run_attempt: attempt, status: "completed", conclusion: "success", steps: gates.map((name) => ({ name, conclusion: "success" })) }))
  jobs.push({ name: "Publish fully verified release", head_sha: source.revision, run_attempt: attempt, status: "completed", conclusion: "failure", steps: [{ name: "Require the exact accepted release source", conclusion: "success" }, { name: "Resolve verified release version", conclusion: "success" }, { name: "Publish the completed draft", conclusion: "failure" }] })
  const tag_name = `bodhi-draft-v${version}-${runId}-${attempt}`
  const names = [`Bodhi.AI-${version}-1.x86_64.rpm`, `Bodhi.AI_${version}_aarch64.dmg`, `Bodhi.AI_${version}_amd64.AppImage`, `Bodhi.AI_${version}_amd64.deb`, `Bodhi.AI_${version}_x64-setup.exe`, `Bodhi.AI_${version}_x64.dmg`, "Bodhi.AI_aarch64.app.tar.gz", "Bodhi.AI_x64.app.tar.gz"]
  const draft = { id: releaseId, url: `https://api.github.com/repos/bigduu/Bodhi-AI/releases/${releaseId}`, draft: true, prerelease: false, tag_name, target_commitish: source.revision, assets: names.map((name, i) => ({ id: i + 1, url: `https://api.github.com/repos/bigduu/Bodhi-AI/releases/assets/${i + 1}`, name, state: "uploaded", size: 2e6, digest: `sha256:${"b".repeat(64)}`, browser_download_url: `https://github.com/bigduu/Bodhi-AI/releases/download/${tag_name}/${name}` })) }
  return { run, jobs, draft }
}
test("fully passed original native builds permit recovery of their intact draft", () => {
  const { run, jobs, draft } = fixture()
  verifyBuild(run, jobs, source, runId, attempt)
  verifyDraft(draft, source, version, runId, attempt, releaseId)
})
for (const [name, mutate] of [
  ["rerun attempt", (f) => { f.run.run_attempt = 2 }],
  ["another product source", (f) => { f.run.head_sha = "c".repeat(40) }],
  ["failed native platform", (f) => { f.jobs[0].conclusion = "failure" }],
  ["skipped real actor smoke", (f) => { f.jobs[1].steps[5].conclusion = "skipped" }],
  ["missing browser gate", (f) => { f.jobs[2].steps = f.jobs[2].steps.filter((s) => s.name !== "Smoke bundled browser host") }],
  ["duplicate platform replacing ARM", (f) => { f.jobs[3].name = f.jobs[0].name }],
  ["failed source check in finalizer", (f) => { f.jobs[4].steps[0].conclusion = "failure" }],
  ["incomplete workflow", (f) => { f.run.status = "in_progress" }],
]) test(`reject ${name}`, () => { const f = fixture(); mutate(f); assert.throws(() => verifyBuild(f.run, f.jobs, source, runId, attempt)) })
for (const [name, mutate] of [
  ["attempt 2 draft", (d) => { d.tag_name = `bodhi-draft-v${version}-${runId}-2` }],
  ["different release ID", (d) => { d.id++ }],
  ["different product source", (d) => { d.target_commitish = "c".repeat(40) }],
  ["already published draft", (d) => { d.draft = false }],
  ["missing Windows installer", (d) => { d.assets = d.assets.filter((a) => !a.name.endsWith(".exe")) }],
  ["invalid content digest", (d) => { d.assets[0].digest = null }],
  ["unfinished asset upload", (d) => { d.assets[0].state = "new" }],
  ["tiny incomplete DMG", (d) => { d.assets[1].size = 100 }],
]) test(`reject draft with ${name}`, () => { const { draft } = fixture(); mutate(draft); assert.throws(() => verifyDraft(draft, source, version, runId, attempt, releaseId)) })
test("immutable asset identity detects replaced content even with the same names", () => {
  const { draft } = fixture()
  const original = assetIdentity(draft)
  draft.assets[0].id++
  draft.assets[0].digest = `sha256:${"c".repeat(64)}`
  assert.notDeepEqual(assetIdentity(draft), original)
})

test("GitHub untagged draft download URLs preserve asset API identities", () => {
  const { draft } = fixture()
  for (const asset of draft.assets) asset.browser_download_url = asset.browser_download_url.replace(draft.tag_name, "untagged-89823d7dc87e9f9701b8")
  verifyDraft(draft, source, version, runId, attempt, releaseId)
})
test("foreign asset API and mixed draft download prefixes are rejected", () => {
  const { draft } = fixture()
  draft.assets[0].url = draft.assets[0].url.replace("bigduu/Bodhi-AI", "bigduu/bodhi")
  assert.throws(() => verifyDraft(draft, source, version, runId, attempt, releaseId))
  const other = fixture().draft
  other.assets[0].browser_download_url = other.assets[0].browser_download_url.replace(other.tag_name, "untagged-abcdef")
  assert.throws(() => verifyDraft(other, source, version, runId, attempt, releaseId))
})
