"use strict"

const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const { createHash } = require("node:crypto")
const { readFileSync } = require("node:fs")

const sha = /^[0-9a-f]{40}$/
const digest = /^[0-9a-f]{64}$/
const workflowRef = "bigduu/lotus-next/.github/workflows/publish-npm.yml@refs/heads/main"

const canonicalRef = (ref) => {
  assert.equal(typeof ref, "string")
  assert.match(ref, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  assert.ok(!ref.includes("..") && !ref.includes("//") && !ref.endsWith(".") && !ref.endsWith("/"))
  assert.ok(ref.split("/").every((segment) => !segment.endsWith(".lock")))
  if (ref.startsWith("refs/")) assert.match(ref, /^refs\/(heads|tags)\/.+$/)
  return ref.startsWith("refs/") ? ref : "refs/heads/" + ref
}

const verifyRemoteRows = (ref, revision, tagObjectSha, output) => {
  const fullRef = canonicalRef(ref)
  assert.match(revision, sha)
  const rows = output.trim().split("\n").filter(Boolean).map((line) => line.split(/\s+/))
  const tag = fullRef.startsWith("refs/tags/")
  assert.equal(rows.length, tag ? 2 : 1, "Missing or ambiguous accepted ref")
  for (const row of rows) {
    assert.equal(row.length, 2)
    assert.match(row[0], sha)
  }
  const exact = rows.filter((row) => row[1] === fullRef)
  assert.equal(exact.length, 1)
  if (tag) {
    assert.match(tagObjectSha, sha, "Accepted annotated tag object is required")
    assert.equal(exact[0][0], tagObjectSha, "Accepted tag object changed")
    const peeled = rows.filter((row) => row[1] === fullRef + "^{}")
    assert.equal(peeled.length, 1, "Annotated tag must peel to one commit")
    assert.equal(peeled[0][0], revision, "Accepted tag source moved")
  } else {
    assert.ok(!tagObjectSha, "A branch must not carry a tag object")
    assert.equal(exact[0][0], revision, "Accepted branch source moved")
  }
  return revision
}

const assertPublicationIdentity = (identity) => {
  const p = identity.publication
  assert.ok(p && typeof p === "object" && !Array.isArray(p))
  assert.deepEqual(Object.keys(p).sort(), ["workflowRef", "workflowRevision", "runId", "runAttempt", "sourceReceiptSha256", "workflowEvidenceSha256", "tagObjectSha"].sort())
  assert.equal(identity.ref, "refs/tags/lotus-next-v" + identity.packageVersion)
  assert.equal(p.workflowRef, workflowRef)
  assert.match(p.workflowRevision, sha)
  assert.match(p.tagObjectSha, sha)
  assert.match(p.sourceReceiptSha256, digest)
  assert.match(p.workflowEvidenceSha256, digest)
  assert.ok(Number.isSafeInteger(p.runId) && p.runId > 0)
  assert.ok(Number.isSafeInteger(p.runAttempt) && p.runAttempt > 0)
}

const verifyPublicationReceipt = (identity, bytes, run, jobs) => {
  assertPublicationIdentity(identity)
  const p = identity.publication
  assert.equal(createHash("sha256").update(bytes).digest("hex"), p.sourceReceiptSha256)
  const receipt = JSON.parse(bytes)
  assert.equal(receipt.schemaVersion, 1)
  assert.equal(receipt.repository, "bigduu/lotus-next")
  assert.equal(receipt.version, identity.packageVersion)
  assert.equal(receipt.sourceRef, identity.ref)
  assert.equal(receipt.sourceSha, identity.sourceRevision)
  assert.equal(receipt.sourceDirty, false)
  assert.equal(receipt.tagObjectSha, p.tagObjectSha)
  assert.equal(receipt.workflowSha, p.workflowRevision)
  assert.equal(receipt.workflowRef, p.workflowRef)
  assert.equal(receipt.runId, String(p.runId))
  assert.equal(receipt.runAttempt, String(p.runAttempt))
  for (const field of ["npmShasum", "npmIntegrity", "manifestSha256", "resourcesSha256"]) assert.equal(receipt[field], identity[field])
  assert.match(receipt.sourceTree, sha)
  assert.match(receipt.bambooSha, sha)
  assert.match(receipt.candidateRecordSha256, digest)
  if (run !== undefined || jobs !== undefined) {
    assert.ok(run && jobs)
    assert.equal(run.id, p.runId)
    assert.equal(run.run_attempt, p.runAttempt)
    assert.ok([".github/workflows/publish-npm.yml", ".github/workflows/publish-npm.yml@main"].includes(run.path))
    assert.equal(run.head_branch, "main")
    assert.equal(run.head_sha, p.workflowRevision, "The run identifies the reviewed workflow, not the product source")
    assert.equal(run.event, "workflow_dispatch")
    assert.equal(run.status, "completed")
    assert.equal(run.conclusion, "success")
    assert.equal(jobs.total_count, jobs.jobs.length)
    for (const name of ["Validate publication request", "Node 22 release artifact", "Node 24 release artifact", "Real Bamboo / Node 22 release artifact", "Pack, publish, and verify registry artifact"]) {
      const matches = jobs.jobs.filter((job) => job.name === name)
      assert.equal(matches.length, 1)
      assert.equal(matches[0].head_sha, p.workflowRevision)
      assert.equal(matches[0].status, "completed")
      assert.equal(matches[0].conclusion, "success", "An original publication gate did not succeed: " + name)
    }
  }
  return receipt
}

const main = async () => {
  const [command, configPath, selector, ...expected] = process.argv.slice(2)
  const { readConfig } = require("./release-train-policy.cjs")
  const config = readConfig(configPath)
  if (command === "ref") {
    assert.ok(["bamboo", "bodhi", "lotus-next"].includes(selector))
    const identity = selector === "lotus-next" ? config.frontend.lotusNext : config.sources[selector]
    if (selector === "lotus-next" && !identity.publication) return
    const ref = canonicalRef(identity.ref)
    if (expected.length) assert.deepEqual(expected, [identity.repository, identity.ref, identity.revision || identity.sourceRevision])
    const queries = [ref, ref + "^{}"]
    if (ref.startsWith("refs/tags/")) queries.push("refs/heads/" + ref.slice("refs/tags/".length))
    const output = execFileSync("git", ["ls-remote", "--exit-code", "https://github.com/" + identity.repository + ".git", ...queries], { encoding: "utf8" })
    verifyRemoteRows(identity.ref, identity.revision || identity.sourceRevision, identity.tagObjectSha || identity.publication?.tagObjectSha, output)
    console.log("Verified accepted " + selector + " ref " + ref)
    return
  }
  if (command === "publication") {
    const identity = config.frontend.lotusNext
    if (!identity.publication) return
    const bytes = readFileSync(selector)
    const evidenceBytes = readFileSync(".github/accepted-frontend-workflow.json")
    assert.equal(createHash("sha256").update(evidenceBytes).digest("hex"), identity.publication.workflowEvidenceSha256)
    const evidence = JSON.parse(evidenceBytes)
    assert.equal(evidence.schemaVersion, 1)
    assert.equal(evidence.repository, "bigduu/lotus-next")
    const { run, jobs } = evidence
    verifyPublicationReceipt(identity, bytes, run, jobs)
    console.log("Verified exact frontend source and main publication workflow identities")
    return
  }
  throw new Error("Usage: release-publication.cjs ref CONFIG bamboo|bodhi|lotus-next OR publication CONFIG RECEIPT")
}

module.exports = { canonicalRef, verifyRemoteRows, assertPublicationIdentity, verifyPublicationReceipt }
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1 })
