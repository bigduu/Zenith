"use strict"
const { test } = require("node:test")
const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const { canonicalRef, verifyRemoteRows, assertPublicationIdentity, verifyPublicationReceipt, verifyRecoveryReceipt, readRecoveryEvidence } = require("./release-publication.cjs")
const recoveryFixture = require("./fixtures/lotus-recovery-2026.10.12.json")
const source = "1".repeat(40)
const workflow = "2".repeat(40)
const object = "3".repeat(40)
const ref = "refs/tags/lotus-next-v2026.10.8"

test("normalizes existing branch authority and preserves qualified tags", () => {
  assert.equal(canonicalRef("dev"), "refs/heads/dev")
  assert.equal(canonicalRef("release/2026.10.8"), "refs/heads/release/2026.10.8")
  assert.equal(canonicalRef(ref), ref)
  for (const bad of ["refs/pull/1/head", "main\npoison=true", "../main", "refs/tags/a.lock", "refs/tags/a//b"]) assert.throws(() => canonicalRef(bad))
})
test("requires both annotated tag object and peeled accepted source", () => {
  const rows = object + "\t" + ref + "\n" + source + "\t" + ref + "^{}\n"
  assert.equal(verifyRemoteRows(ref, source, object, rows), source)
  assert.throws(() => verifyRemoteRows(ref, source, workflow, rows))
  assert.throws(() => verifyRemoteRows(ref, workflow, object, rows))
  assert.throws(() => verifyRemoteRows(ref, source, object, source + "\t" + ref + "\n"))
  assert.throws(() => verifyRemoteRows(ref, source, object, rows + rows))
  assert.equal(verifyRemoteRows("dev", source, undefined, source + "\trefs/heads/dev\n"), source)
  assert.throws(() => verifyRemoteRows("dev", workflow, undefined, source + "\trefs/heads/dev\n"))
})
test("verifies product source via receipt while run identity remains the main workflow", () => {
  const identity = { ref, packageVersion: "2026.10.8", sourceRevision: source, npmShasum: "4".repeat(40), npmIntegrity: "sha512-fixture", manifestSha256: "5".repeat(64), resourcesSha256: "6".repeat(64) }
  const receipt = { schemaVersion: 1, repository: "bigduu/lotus-next", version: identity.packageVersion, sourceRef: ref, sourceSha: source, sourceDirty: false, sourceTree: "7".repeat(40), bambooSha: "8".repeat(40), candidateRecordSha256: "9".repeat(64), tagObjectSha: object, workflowSha: workflow, workflowRef: "bigduu/lotus-next/.github/workflows/publish-npm.yml@refs/heads/main", runId: "123", runAttempt: "1", npmShasum: identity.npmShasum, npmIntegrity: identity.npmIntegrity, manifestSha256: identity.manifestSha256, resourcesSha256: identity.resourcesSha256 }
  const bytes = Buffer.from(JSON.stringify(receipt))
  identity.publication = { workflowRef: receipt.workflowRef, workflowRevision: workflow, runId: 123, runAttempt: 1, workflowEvidenceSha256: "a".repeat(64), tagObjectSha: object, sourceReceiptSha256: createHash("sha256").update(bytes).digest("hex") }
  const run = { id: 123, run_attempt: 1, path: ".github/workflows/publish-npm.yml", head_branch: "main", head_sha: workflow, event: "workflow_dispatch", status: "completed", conclusion: "success" }
  const jobs = { total_count: 5, jobs: ["Validate publication request", "Node 22 release artifact", "Node 24 release artifact", "Real Bamboo / Node 22 release artifact", "Pack, publish, and verify registry artifact"].map((name) => ({ name, head_sha: workflow, status: "completed", conclusion: "success" })) }
  assert.equal(verifyPublicationReceipt(identity, bytes, run, jobs).sourceSha, source)
  assert.throws(() => verifyPublicationReceipt(identity, bytes, { ...run, head_sha: source }, jobs))
  assert.throws(() => verifyPublicationReceipt(identity, bytes, { ...run, run_attempt: 2 }, jobs))
  assert.throws(() => verifyPublicationReceipt(identity, Buffer.from(JSON.stringify({ ...receipt, sourceSha: workflow })), run, jobs))
  const skipped = structuredClone(jobs); skipped.jobs[3].conclusion = "skipped"
  assert.throws(() => verifyPublicationReceipt(identity, bytes, run, skipped))
  for (const update of [
    (r) => { r.path = ".github/workflows/verify-published-npm.yml" },
    (r) => { r.head_branch = "dev" },
    (r) => { r.event = "push" },
    (r) => { r.status = "in_progress" },
    (r) => { r.conclusion = "failure" },
  ]) {
    const changed = structuredClone(run); update(changed)
    assert.throws(() => verifyPublicationReceipt(identity, bytes, changed, jobs))
  }
  for (const update of [
    (j) => { j.jobs[0].conclusion = "failure" },
    (j) => { j.jobs[4].conclusion = "failure" },
    (j) => { j.jobs[1].head_sha = source },
    (j) => { j.jobs.push(j.jobs[0]); j.total_count++ },
    (j) => { j.jobs.pop(); j.total_count-- },
  ]) {
    const changed = structuredClone(jobs); update(changed)
    assert.throws(() => verifyPublicationReceipt(identity, bytes, run, changed))
  }
  for (const update of [
    (r) => { r.schemaVersion = 2 },
    (r) => { r.sourceDirty = true },
    (r) => { r.npmIntegrity = "sha512-wrong" },
    (r) => { r.tagObjectSha = workflow },
  ]) {
    const changed = structuredClone(receipt); update(changed)
    const changedBytes = Buffer.from(JSON.stringify(changed))
    const changedIdentity = structuredClone(identity)
    changedIdentity.publication.sourceReceiptSha256 = createHash("sha256").update(changedBytes).digest("hex")
    assert.throws(() => verifyPublicationReceipt(changedIdentity, changedBytes, run, jobs))
  }
})

const recoverySample = () => ({
  identity: structuredClone(recoveryFixture.identity),
  bytes: Buffer.from(recoveryFixture.receiptUtf8),
  evidenceBytes: Buffer.from(recoveryFixture.evidenceUtf8),
  live: JSON.parse(recoveryFixture.evidenceUtf8),
})
const verifyRecovery = (sample, now = new Date("2026-10-13T00:00:00Z")) => verifyRecoveryReceipt(sample.identity, sample.bytes, sample.evidenceBytes, sample.live, now)
const updateReceipt = (sample, update) => {
  const receipt = JSON.parse(sample.bytes); update(receipt)
  sample.bytes = Buffer.from(JSON.stringify(receipt))
  sample.identity.publication.recovery.receiptSha256 = createHash("sha256").update(sample.bytes).digest("hex")
}

test("admits the unmodified actual schema-2 receipt while preserving original failure", () => {
  const sample = recoverySample()
  assert.equal(createHash("sha256").update(sample.bytes).digest("hex"), "1b358fd60e9c8ab92e1f9059d652636139e1f439c1f603bd0cc7aa039771d3ce")
  const receipt = verifyRecovery(sample)
  assert.equal(receipt.originalPublication.conclusion, "failure")
  assert.equal(receipt.originalPublication.runId, "38228276879")
  assert.equal(receipt.verification.runId, "38243218607")
  assert.equal(receipt.registryIdentity.sourceDirty, false)
  assert.equal(receipt.registryIdentity.provenance.cryptographicVerification, false)
  assert.throws(() => verifyPublicationReceipt(sample.identity, sample.bytes))
  const originalOnly = structuredClone(sample.identity)
  delete originalOnly.publication.recovery
  originalOnly.publication.sourceReceiptSha256 = createHash("sha256").update(sample.bytes).digest("hex")
  assert.throws(() => verifyPublicationReceipt(originalOnly, sample.bytes))
})

for (const [name, update] of [
  ["another release", (s) => { s.identity.packageVersion = "2026.10.13"; s.identity.ref = "refs/tags/lotus-next-v2026.10.13" }],
  ["another product source", (s) => { s.identity.sourceRevision = "1".repeat(40) }],
  ["another original workflow", (s) => { s.identity.publication.workflowRevision = "2".repeat(40) }],
  ["another failed publication", (s) => { s.identity.publication.runId++ }],
  ["another original attempt", (s) => { s.identity.publication.runAttempt++ }],
  ["another reviewed recovery control", (s) => { s.identity.publication.recovery.workflowRevision = "3".repeat(40) }],
  ["non-main recovery", (s) => { s.identity.publication.recovery.workflowRef = s.identity.publication.recovery.workflowRef.replace("main", "dev") }],
  ["same original and recovery run", (s) => { s.identity.publication.recovery.runId = s.identity.publication.runId }],
  ["unknown header key", (s) => { s.identity.publication.recovery.allowFailure = true }],
  ["missing artifact binding", (s) => { delete s.identity.publication.recovery.artifactDigest }],
  ["changed canonical record", (s) => { s.identity.publication.recovery.recordSha256 = "4".repeat(64) }],
  ["changed receipt bytes", (s) => { s.bytes = Buffer.concat([s.bytes, Buffer.from(" ")]) }],
  ["changed committed evidence bytes", (s) => { s.evidenceBytes = Buffer.concat([s.evidenceBytes, Buffer.from(" ")]) }],
  ["missing fresh API evidence", (s) => { s.live = undefined }],
]) test("recovery rejects " + name, () => {
  const sample = recoverySample(); update(sample)
  assert.throws(() => verifyRecovery(sample))
})

for (const [name, update] of [
  ["relabelled original success", (r) => { r.originalPublication.conclusion = "success" }],
  ["unsuccessful publish claim", (r) => { r.originalPublication.publishStep.conclusion = "failure" }],
  ["different failure code", (r) => { r.originalPublication.failureStep.errorCode = "E401" }],
  ["different original source", (r) => { r.sourceReceipt.sourceSha = "1".repeat(40) }],
  ["different candidate", (r) => { r.sourceReceipt.candidateRecordSha256 = "1".repeat(64) }],
  ["different acceptance", (r) => { r.sourceReceipt.acceptanceReceiptSha256 = "1".repeat(64) }],
  ["different tag", (r) => { r.sourceReceipt.tagObjectSha = "1".repeat(40) }],
  ["different Bamboo", (r) => { r.sourceReceipt.bambooSha = "1".repeat(40) }],
  ["different verifier run", (r) => { r.verification.runId = "1" }],
  ["different verifier attempt", (r) => { r.verification.runAttempt = "2" }],
  ["future verification timestamp", (r) => { r.verification.verifiedAt = "2099-01-01T00:00:00Z" }],
  ["dirty registry source", (r) => { r.registryIdentity.sourceDirty = true }],
  ["different registry SRI", (r) => { r.registryIdentity.npmIntegrity = "sha512-wrong" }],
  ["different manifest", (r) => { r.registryIdentity.manifestSha256 = "1".repeat(64) }],
  ["different resource digest", (r) => { r.registryIdentity.resourcesSha256 = "1".repeat(64) }],
  ["different archive", (r) => { r.registryIdentity.tarballSha256 = "1".repeat(64) }],
  ["moving registry URL", (r) => { r.registryIdentity.tarballUrl = "https://registry.npmjs.org/@bigduu/lotus-next/latest" }],
  ["false cryptographic claim", (r) => { r.registryIdentity.provenance.cryptographicVerification = true }],
  ["wrong original provenance invocation", (r) => { r.registryIdentity.provenance.invocationId += "0" }],
  ["different original artifact", (r) => { r.evidence.originalArtifacts[0].digest = "sha256:" + "1".repeat(64) }],
  ["unknown receipt property", (r) => { r.publishSucceeded = true }],
]) test("recovery rejects a rehashed receipt with " + name, () => {
  const sample = recoverySample(); updateReceipt(sample, update)
  assert.throws(() => verifyRecovery(sample))
})

for (const [name, update] of [
  ["original outcome changed", (e) => { e.original.run.conclusion = "success" }],
  ["original attempt changed", (e) => { e.original.attempt.run_attempt++ }],
  ["skipped original admission", (e) => { e.original.jobs.jobs[0].conclusion = "skipped" }],
  ["failed original browser gate", (e) => { e.original.jobs.jobs[3].conclusion = "failure" }],
  ["failed publication", (e) => { e.original.jobs.jobs[4].steps.find((s) => s.number === 15).conclusion = "failure" }],
  ["another original failing step", (e) => { e.original.jobs.jobs[4].steps.find((s) => s.number === 16).conclusion = "failure" }],
  ["renamed original failure step", (e) => { e.original.jobs.jobs[4].steps.find((s) => s.number === 17).name = "Publish" }],
  ["duplicate original job", (e) => { e.original.jobs.jobs.push(e.original.jobs.jobs[0]); e.original.jobs.total_count++ }],
  ["truncated original jobs", (e) => { e.original.jobs.total_count++ }],
  ["expired original artifact", (e) => { e.original.artifacts.artifacts.find((a) => a.id === 11737635941).expired = true }],
  ["failed verifier", (e) => { e.recovery.run.conclusion = "failure" }],
  ["another verifier workflow", (e) => { e.recovery.run.path = ".github/workflows/publish-npm.yml" }],
  ["another verifier source", (e) => { e.recovery.attempt.head_sha = "1".repeat(40) }],
  ["another verifier attempt", (e) => { e.recovery.attempt.run_attempt++ }],
  ["non-main verifier", (e) => { e.recovery.jobs.jobs[0].head_branch = "dev" }],
  ["changed verifier job identity", (e) => { e.recovery.jobs.jobs[0].id++ }],
  ["failed verification job", (e) => { e.recovery.jobs.jobs[0].conclusion = "failure" }],
  ["skipped receipt upload", (e) => { e.recovery.jobs.jobs[0].steps.find((s) => s.number === 5).conclusion = "skipped" }],
  ["missing receipt upload", (e) => { e.recovery.jobs.jobs[0].steps = e.recovery.jobs.jobs[0].steps.filter((s) => s.number !== 5) }],
  ["duplicate receipt upload", (e) => { e.recovery.jobs.jobs[0].steps.push(e.recovery.jobs.jobs[0].steps.find((s) => s.number === 5)) }],
  ["missing receipt artifact", (e) => { e.recovery.artifacts.artifacts = []; e.recovery.artifacts.total_count = 0 }],
  ["duplicate receipt artifact", (e) => { e.recovery.artifacts.artifacts.push(e.recovery.artifacts.artifacts[0]); e.recovery.artifacts.total_count++ }],
  ["wrong receipt artifact digest", (e) => { e.recovery.artifacts.artifacts[0].digest = "sha256:" + "1".repeat(64) }],
  ["wrong receipt artifact owner", (e) => { e.recovery.artifacts.artifacts[0].workflow_run.id++ }],
  ["expired recovery receipt", (e) => { e.recovery.artifacts.artifacts[0].expired = true }],
  ["changed artifact metadata", (e) => { e.recovery.artifacts.artifacts[0].size_in_bytes++ }],
  ["changed canonical record bytes", (e) => { e.recordUtf8 += " " }],
  ["changed candidate bytes", (e) => { e.candidatesUtf8 += " " }],
  ["changed acceptance bytes", (e) => { e.acceptanceUtf8 += " " }],
]) test("recovery rejects current API evidence with " + name, () => {
  const sample = recoverySample(); update(sample.live)
  assert.throws(() => verifyRecovery(sample))
})

test("recovery requires unexpired original and receipt artifacts at admission", () => {
  assert.throws(() => verifyRecovery(recoverySample(), new Date("2099-01-01T00:00:00Z")))
})

const mockRecoveryFetch = (evidence, change = () => undefined) => async (url, options) => {
  assert.equal(options.method, "GET")
  assert.equal(options.redirect, "error")
  assert.equal(options.headers.authorization, undefined)
  const override = change(url)
  if (override) return override
  for (const kind of ["original", "recovery"]) {
    const e = evidence[kind]
    const base = `https://api.github.com/repos/bigduu/lotus-next/actions/runs/${e.run.id}`
    const responses = { [base]: e.run, [`${base}/attempts/${e.attempt.run_attempt}`]: e.attempt,
      [`${base}/attempts/${e.attempt.run_attempt}/jobs?per_page=100`]: e.jobs, [`${base}/artifacts?per_page=100`]: e.artifacts }
    if (Object.hasOwn(responses, url)) return new Response(JSON.stringify(responses[url]))
  }
  const raw = "https://raw.githubusercontent.com/bigduu/lotus-next/a08703a5c0eb5447d8fd80be7389108d6cc3db5b"
  const documents = { [`${raw}/.github/release-recoveries/2026.10.12.json`]: evidence.recordUtf8,
    [`${raw}/.github/release-candidates.json`]: evidence.candidatesUtf8, [`${raw}/.github/release-acceptance/2026.10.12.json`]: evidence.acceptanceUtf8 }
  assert.ok(Object.hasOwn(documents, url), "Unexpected public request: " + url)
  return new Response(documents[url])
}

test("bounded public reader rechecks both actual attempts/jobs/artifacts and immutable records", async () => {
  const sample = recoverySample()
  sample.live = await readRecoveryEvidence(sample.identity, mockRecoveryFetch(sample.live))
  assert.equal(verifyRecovery(sample).version, "2026.10.12")
})

for (const [name, response] of [
  ["HTTP failure", () => new Response("unavailable", { status: 503 })],
  ["paginated response", () => new Response("{}", { headers: { link: '<https://api.github.com/next>; rel="next"' } })],
  ["oversized response", () => new Response("x".repeat(4 * 1024 * 1024 + 1))],
  ["empty response", () => new Response("")],
  ["invalid JSON", () => new Response("not-json")],
]) test("public recovery reader rejects " + name, async () => {
  const sample = recoverySample()
  await assert.rejects(readRecoveryEvidence(sample.identity, mockRecoveryFetch(sample.live, (url) => url.endsWith("38228276879") ? response() : undefined)))
})
