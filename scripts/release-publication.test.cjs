"use strict"
const { test } = require("node:test")
const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const { canonicalRef, verifyRemoteRows, verifyPublicationReceipt } = require("./release-publication.cjs")
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
})
