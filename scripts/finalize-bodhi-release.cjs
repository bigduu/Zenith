"use strict"

const assert = require("node:assert/strict")
const { spawnSync, execFileSync } = require("node:child_process")
const { readFileSync, writeFileSync } = require("node:fs")

const repository = "bigduu/Bodhi-AI"
const gates = ["Require the exact accepted release source", "Set Bodhi app version (workflow override)", "Build Tauri app", "Verify exact frontend and real target sidecar", "Smoke native bundled sidecar actor transport", "Smoke bundled browser host", "Upload Build Artifacts to Workflow"]
const platforms = ["macos-15-intel, x86_64-apple-darwin", "ubuntu-22.04, x86_64-unknown-linux-gnu", "windows-latest, x86_64-pc-windows-msvc", "macos-latest, aarch64-apple-darwin"]

function verifyBuild(run, jobs, source, runId, attempt) {
  assert.equal(run.id, runId)
  assert.equal(run.run_attempt, attempt, "A rerun must not replace the original build attempt")
  assert.equal(run.repository.full_name, repository)
  assert.equal(run.path, ".github/workflows/release.yml")
  assert.equal(run.event, "workflow_dispatch")
  assert.equal(run.head_sha, source.revision)
  assert.equal(run.head_branch, source.ref.replace(/^refs\/tags\//, ""))
  assert.equal(run.status, "completed")
  assert.equal(run.conclusion, "failure", "Recovery is only for a failed finalizer")
  assert.equal(jobs.length, 5)
  for (const platform of platforms) {
    const matches = jobs.filter((j) => j.name.startsWith(`publish-tauri (${platform},`))
    assert.equal(matches.length, 1, `Missing or ambiguous native build: ${platform}`)
    const job = matches[0]
    assert.equal(job.head_sha, source.revision)
    assert.equal(job.run_attempt, attempt)
    assert.equal(job.status, "completed")
    assert.equal(job.conclusion, "success")
    for (const name of gates) {
      const steps = job.steps.filter((s) => s.name === name)
      assert.equal(steps.length, 1, `Missing native gate: ${name}`)
      assert.equal(steps[0].conclusion, "success", `Native gate did not pass: ${name}`)
    }
  }
  const finalizers = jobs.filter((j) => j.name === "Publish fully verified release")
  assert.equal(finalizers.length, 1)
  const finalizer = finalizers[0]
  assert.equal(finalizer.head_sha, source.revision)
  assert.equal(finalizer.run_attempt, attempt)
  assert.equal(finalizer.conclusion, "failure")
  assert.deepEqual(finalizer.steps.filter((s) => s.conclusion === "failure").map((s) => s.name), ["Publish the completed draft"])
  for (const name of ["Require the exact accepted release source", "Resolve verified release version"]) {
    assert.equal(finalizer.steps.filter((s) => s.name === name && s.conclusion === "success").length, 1)
  }
}

function assetIdentity(release) {
  return release.assets.map(({ id, name, size, digest, state }) => ({ id, name, size, digest, state })).sort((a, b) => a.name.localeCompare(b.name))
}

function verifyDraft(release, source, version, runId, attempt, expectedId) {
  assert.equal(release.id, expectedId)
  assert.equal(release.draft, true)
  assert.equal(release.prerelease, false)
  const tag = `bodhi-draft-v${version}-${runId}-${attempt}`
  assert.equal(release.tag_name, tag)
  assert.equal(release.target_commitish, source.revision)
  assert.equal(release.url, `https://api.github.com/repos/${repository}/releases/${expectedId}`)
  const downloadPrefixes = new Set()
  const names = [`Bodhi.AI-${version}-1.x86_64.rpm`, `Bodhi.AI_${version}_aarch64.dmg`, `Bodhi.AI_${version}_amd64.AppImage`, `Bodhi.AI_${version}_amd64.deb`, `Bodhi.AI_${version}_x64-setup.exe`, `Bodhi.AI_${version}_x64.dmg`, "Bodhi.AI_aarch64.app.tar.gz", "Bodhi.AI_x64.app.tar.gz"]
  assert.deepEqual(release.assets.map((a) => a.name).sort(), names.sort(), "All eight original platform assets are required")
  assert.equal(new Set(release.assets.map((a) => a.id)).size, 8)
  for (const asset of release.assets) {
    assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0)
    assert.equal(asset.state, "uploaded")
    assert.ok(Number.isSafeInteger(asset.size) && asset.size >= 1024 * 1024)
    assert.match(asset.digest, /^sha256:[0-9a-f]{64}$/)
    assert.equal(asset.url, `https://api.github.com/repos/${repository}/releases/assets/${asset.id}`)
    const download = new URL(asset.browser_download_url)
    assert.equal(download.origin, "https://github.com")
    const prefix = `/bigduu/Bodhi-AI/releases/download/`
    assert.ok(download.pathname.startsWith(prefix) && download.pathname.endsWith(`/${asset.name}`))
    assert.equal(download.search + download.hash, "")
    const downloadTag = download.pathname.slice(prefix.length, -(asset.name.length + 1))
    assert.ok(downloadTag === tag || /^untagged-[0-9a-f]+$/.test(downloadTag), "Unexpected draft download path")
    downloadPrefixes.add(downloadTag)
  }
  assert.equal(downloadPrefixes.size, 1, "Original draft assets must share one GitHub download prefix")
}

function api(path, method = "GET", body) {
  const args = ["api", `repos/${repository}/${path}`, "--method", method]
  if (body) args.push("--input", "-")
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, input: body && JSON.stringify(body) })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (method === "GET" && /HTTP 404/.test(result.stderr)) return null
    throw new Error(`GitHub ${method} ${path} failed: ${result.stderr.trim()}`)
  }
  return JSON.parse(result.stdout)
}

async function main() {
  const [configPath, runArg, attemptArg, idArg, mode, manifestPath, receiptPrefix] = process.argv.slice(2)
  assert.ok(["verify", "publish"].includes(mode))
  for (const arg of [runArg, attemptArg, idArg]) assert.match(arg, /^[1-9][0-9]*$/)
  const [runId, attempt, releaseId] = [runArg, attemptArg, idArg].map(Number)
  assert.ok([runId, attempt, releaseId].every(Number.isSafeInteger))
  const config = JSON.parse(readFileSync(configPath, "utf8"))
  const source = config.sources.bodhi
  const version = config.versions.bodhi
  assert.equal(source.repository, repository)
  assert.equal(source.workflow, "release.yml")
  assert.match(source.revision, /^[0-9a-f]{40}$/)
  assert.match(version, /^[1-9][0-9]{3}\.(?:[1-9]|1[0-2])\.[1-9][0-9]*$/)
  assert.equal(source.ref, `refs/tags/bodhi-source-${version}`)
  const verifyRef = () => execFileSync(process.execPath, [require.resolve("./release-publication.cjs"), "ref", configPath, "bodhi"], { stdio: "inherit" })
  verifyRef()
  const run = api(`actions/runs/${runId}/attempts/${attempt}`)
  const jobs = api(`actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`)
  assert.ok(run && jobs)
  assert.equal(jobs.total_count, jobs.jobs.length)
  verifyBuild(run, jobs.jobs, source, runId, attempt)
  const releases = []
  for (let page = 1; ; page++) {
    const rows = api(`releases?per_page=100&page=${page}`)
    assert.ok(Array.isArray(rows))
    releases.push(...rows)
    if (rows.length < 100) break
  }
  const draftTag = `bodhi-draft-v${version}-${runId}-${attempt}`
  const drafts = releases.filter((r) => r.tag_name === draftTag)
  assert.equal(drafts.length, 1, "Original run/attempt draft must be unique")
  assert.equal(drafts[0].id, releaseId)
  assert.equal(releases.filter((r) => r.tag_name === `app-v${version}`).length, 0, "Never replace an existing release, including a draft")
  assert.equal(api(`git/ref/tags/app-v${version}`), null, "Never move an existing final tag")
  const draft = api(`releases/${releaseId}`)
  verifyDraft(draft, source, version, runId, attempt, releaseId)
  const assets = assetIdentity(draft)
  if (manifestPath && manifestPath !== "-") {
    const original = JSON.parse(readFileSync(manifestPath, "utf8"))
    assert.equal(original.id, releaseId)
    assert.equal(original.tag_name, draftTag)
    assert.equal(original.target_commitish, source.revision)
    assert.deepEqual(assets, assetIdentity(original), "Original asset IDs/digests/sizes must not change")
  }
  const verified = { version, source: source.revision, runId, originalAttempt: attempt, releaseId, draftTag, nativeJobIds: jobs.jobs.filter((j) => j.conclusion === "success").map((j) => j.id), assets, observedAt: new Date().toISOString(), mode }
  if (receiptPrefix) writeFileSync(`${receiptPrefix}-verified.json`, JSON.stringify(verified, null, 2) + "\n", { flag: "wx" })
  console.log(JSON.stringify(verified, null, 2))
  if (mode === "verify") return
  verifyRef()
  const fresh = api(`releases/${releaseId}`)
  verifyDraft(fresh, source, version, runId, attempt, releaseId)
  assert.deepEqual(assetIdentity(fresh), assets)
  assert.equal(api(`releases/tags/app-v${version}`), null)
  assert.equal(api(`git/ref/tags/app-v${version}`), null)
  const published = api(`releases/${releaseId}`, "PATCH", { tag_name: `app-v${version}`, target_commitish: source.revision, name: `App v${version}`, draft: false, prerelease: false, make_latest: "true" })
  assert.equal(published.id, releaseId)
  assert.equal(published.draft, false)
  assert.equal(published.tag_name, `app-v${version}`)
  assert.equal(published.target_commitish, source.revision)
  assert.deepEqual(assetIdentity(published), assets, "Publication must preserve all original asset identities")
  if (receiptPrefix) writeFileSync(`${receiptPrefix}-published.json`, JSON.stringify(published, null, 2) + "\n", { flag: "wx" })
  console.log(`Published original verified release ${releaseId}: ${published.html_url}`)
}

module.exports = { verifyBuild, verifyDraft, assetIdentity }
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1 })
