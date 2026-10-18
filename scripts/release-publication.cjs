"use strict"

const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const { createHash } = require("node:crypto")
const { readFileSync } = require("node:fs")

const sha = /^[0-9a-f]{40}$/
const digest = /^[0-9a-f]{64}$/
const workflowRef = "bigduu/lotus-next/.github/workflows/publish-npm.yml@refs/heads/main"
const recoveryWorkflowRef = "bigduu/lotus-next/.github/workflows/verify-published-npm.yml@refs/heads/main"
// Lotus #313 reviewed this one post-publication ETARGET recovery. This is not
// permission to accept another failed publisher or a moving recovery workflow.
const recoveryScope = Object.freeze({
  version: "2026.10.12",
  source: "d8b0eb6cad98ec53afe8dc4f6aeaa35ef050ec9f",
  tag: "059e718f234acd7911f6a5822f5d43cf1e423f1e",
  controller: "c50e0805a83c5e1cbcd6b37a07ca8646c23d2f9e",
  originalRun: 38228276879,
  publishJob: 114758355794,
  verifier: "a08703a5c0eb5447d8fd80be7389108d6cc3db5b",
  record: "08489f5e33a69f713944a78db57ec822bb0e232d218caad5c5a7eaac43510c57",
  sourceReceipt: "171959bc171ac0e7913643876ef021c27bbf9941bf7a88225b0461ba47024b66",
  candidates: "303d6867ba697c9c6cfd1d88b0f6633b5a81e66bc65185c5de11a5f05468481e",
  acceptance: "86a085034db902b0f5895a1977898d36d3f7578e87149a72b419f2546e8b5ce8",
})
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const pick = (value, keys) => Object.fromEntries(keys.map((key) => [key, value[key]]))
const exactKeys = (value, keys) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value))
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort())
}
const only = (values, description) => {
  assert.equal(values.length, 1, "Missing or ambiguous " + description)
  return values[0]
}

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
  assert.deepEqual(Object.keys(p).sort(), ["workflowRef", "workflowRevision", "runId", "runAttempt", "sourceReceiptSha256", "workflowEvidenceSha256", "tagObjectSha", ...(Object.hasOwn(p, "recovery") ? ["recovery"] : [])].sort())
  assert.equal(identity.ref, "refs/tags/lotus-next-v" + identity.packageVersion)
  assert.equal(p.workflowRef, workflowRef)
  assert.match(p.workflowRevision, sha)
  assert.match(p.tagObjectSha, sha)
  assert.match(p.sourceReceiptSha256, digest)
  assert.match(p.workflowEvidenceSha256, digest)
  assert.ok(Number.isSafeInteger(p.runId) && p.runId > 0)
  assert.ok(Number.isSafeInteger(p.runAttempt) && p.runAttempt > 0)
  if (Object.hasOwn(p, "recovery")) {
    const q = p.recovery
    exactKeys(q, ["workflowRef", "workflowRevision", "runId", "runAttempt", "receiptSha256", "artifactId", "artifactDigest", "recordSha256"])
    assert.equal(identity.packageVersion, recoveryScope.version)
    assert.equal(identity.sourceRevision, recoveryScope.source)
    assert.equal(p.workflowRevision, recoveryScope.controller)
    assert.equal(p.runId, recoveryScope.originalRun)
    assert.equal(p.runAttempt, 1)
    assert.equal(p.tagObjectSha, recoveryScope.tag)
    assert.equal(p.sourceReceiptSha256, recoveryScope.sourceReceipt)
    assert.equal(q.workflowRef, recoveryWorkflowRef)
    assert.equal(q.workflowRevision, recoveryScope.verifier)
    assert.equal(q.recordSha256, recoveryScope.record)
    assert.match(q.receiptSha256, digest)
    assert.match(q.artifactDigest, /^sha256:[0-9a-f]{64}$/)
    for (const field of ["runId", "runAttempt", "artifactId"]) assert.ok(Number.isSafeInteger(q[field]) && q[field] > 0)
    assert.notEqual(q.runId, p.runId)
  }
}

const verifyPublicationReceipt = (identity, bytes, run, jobs) => {
  assertPublicationIdentity(identity)
  const p = identity.publication
  assert.ok(!Object.hasOwn(p, "recovery"), "Recovery requires its separate schema-2 reader")
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

const verifyRun = (run, id, attempt, revision, path, conclusion) => {
  assert.equal(run.id, id)
  assert.equal(run.run_attempt, attempt)
  assert.equal(run.head_sha, revision)
  assert.equal(run.head_branch, "main")
  assert.equal(run.path, path)
  assert.equal(run.event, "workflow_dispatch")
  assert.equal(run.status, "completed")
  assert.equal(run.conclusion, conclusion)
  assert.equal(run.html_url, `https://github.com/bigduu/lotus-next/actions/runs/${id}`)
}

const verifyJobs = (jobs, id, attempt, revision, names) => {
  assert.equal(jobs.total_count, jobs.jobs.length, "Jobs response is truncated")
  assert.equal(jobs.jobs.length, names.length)
  for (const name of names) {
    const job = only(jobs.jobs.filter((entry) => entry.name === name), name)
    assert.equal(job.run_id, id)
    assert.equal(job.run_attempt, attempt)
    assert.equal(job.head_sha, revision)
    assert.equal(job.head_branch, "main")
    assert.equal(job.status, "completed")
    assert.equal(new Set(job.steps.map((step) => step.name)).size, job.steps.length)
    assert.equal(new Set(job.steps.map((step) => step.number)).size, job.steps.length)
    for (const step of job.steps) assert.equal(step.status, "completed")
  }
}

const verifyArtifacts = (artifacts) => {
  assert.equal(artifacts.total_count, artifacts.artifacts.length, "Artifacts response is truncated")
  assert.equal(new Set(artifacts.artifacts.map((entry) => entry.id)).size, artifacts.total_count)
  assert.equal(new Set(artifacts.artifacts.map((entry) => entry.name)).size, artifacts.total_count)
}

const originalJobNames = ["Validate publication request", "Node 22 release artifact", "Node 24 release artifact", "Real Bamboo / Node 22 release artifact", "Pack, publish, and verify registry artifact"]
const jobKeys = ["id", "run_id", "run_attempt", "head_sha", "head_branch", "name", "status", "conclusion"]
const stepKeys = ["number", "name", "status", "conclusion"]
const artifactKeys = ["id", "name", "digest", "size_in_bytes", "created_at", "expires_at", "workflow_run"]

const verifyRecoveryEvidence = (identity, receipt, evidence, now) => {
  const p = identity.publication, q = p.recovery
  exactKeys(evidence, ["schemaVersion", "repository", "original", "recovery", "recordUtf8", "candidatesUtf8", "acceptanceUtf8"])
  assert.equal(evidence.schemaVersion, 2)
  assert.equal(evidence.repository, "bigduu/lotus-next")
  for (const key of ["original", "recovery"]) exactKeys(evidence[key], ["run", "attempt", "jobs", "artifacts"])
  for (const [field, expected] of [["recordUtf8", recoveryScope.record], ["candidatesUtf8", recoveryScope.candidates], ["acceptanceUtf8", recoveryScope.acceptance]]) {
    assert.equal(typeof evidence[field], "string")
    assert.equal(hash(evidence[field]), expected, "Reviewed recovery document changed: " + field)
  }
  const record = JSON.parse(evidence.recordUtf8)
  assert.equal(record.schemaVersion, 1)
  assert.equal(record.kind, "reviewed-original-publication-evidence")
  assert.equal(record.repository, evidence.repository)
  assert.equal(record.version, identity.packageVersion)
  const source = receipt.sourceReceipt
  assert.equal(hash(record.rawEvidence.sourceReceipt.utf8), p.sourceReceiptSha256)
  assert.deepEqual(source, JSON.parse(record.rawEvidence.sourceReceipt.utf8))
  const candidates = JSON.parse(evidence.candidatesUtf8)
  assert.equal(candidates.schemaVersion, 1)
  const candidate = candidates.candidates[identity.packageVersion]
  for (const key of Object.keys(candidate)) assert.deepEqual(source[key], candidate[key], "Accepted candidate changed: " + key)
  assert.equal(source.candidateRecordSha256, recoveryScope.candidates)
  assert.equal(source.acceptanceReceiptSha256, hash(evidence.acceptanceUtf8))
  assert.equal(source.sourceSha, identity.sourceRevision)
  assert.equal(source.sourceRef, identity.ref)
  assert.equal(source.tagObjectSha, p.tagObjectSha)
  assert.equal(source.workflowRef, p.workflowRef)
  assert.equal(source.workflowSha, p.workflowRevision)
  assert.equal(source.runId, String(p.runId))
  assert.equal(source.runAttempt, String(p.runAttempt))

  const original = evidence.original
  for (const run of [original.run, original.attempt]) verifyRun(run, p.runId, p.runAttempt, p.workflowRevision, ".github/workflows/publish-npm.yml", "failure")
  verifyJobs(original.jobs, p.runId, p.runAttempt, p.workflowRevision, originalJobNames)
  for (const job of original.jobs.jobs) {
    const expected = only(record.originalJobs.jobs.filter((entry) => entry.name === job.name), "recorded original job")
    assert.deepEqual(pick(job, jobKeys), pick(expected, jobKeys))
    assert.deepEqual(job.steps.map((step) => pick(step, stepKeys)), expected.steps)
    if (job.name !== originalJobNames[4]) {
      assert.equal(job.conclusion, "success")
      for (const step of job.steps) assert.equal(step.conclusion, "success")
    }
  }
  const publish = only(original.jobs.jobs.filter((job) => job.name === originalJobNames[4]), "original publisher")
  assert.equal(publish.id, recoveryScope.publishJob)
  assert.equal(publish.conclusion, "failure")
  for (let number = 1; number <= 20; number++) assert.equal(only(publish.steps.filter((step) => step.number === number), "publish step " + number).conclusion, number < 17 ? "success" : number === 17 ? "failure" : "skipped")
  assert.equal(publish.steps.filter((step) => step.conclusion === "failure").length, 1)
  assert.deepEqual(receipt.originalPublication, {
    runId: String(p.runId), runAttempt: String(p.runAttempt), workflowRef: p.workflowRef,
    workflowSha: p.workflowRevision, conclusion: "failure", jobId: String(publish.id),
    publishStep: pick(publish.steps.find((step) => step.number === 15), ["number", "name", "conclusion"]),
    failureStep: { ...pick(publish.steps.find((step) => step.number === 17), ["number", "name", "conclusion"]), errorCode: "ETARGET" },
  })
  verifyArtifacts(original.artifacts)
  assert.equal(original.artifacts.total_count, 8)
  assert.ok(original.artifacts.artifacts.every((entry) => !["publication-source-receipt", "publication-recovery-receipt"].includes(entry.name)))
  for (const expected of record.artifacts) {
    const artifact = only(original.artifacts.artifacts.filter((entry) => entry.id === expected.id && entry.name === expected.name), "original artifact")
    assert.deepEqual(pick(artifact, artifactKeys), pick(expected, artifactKeys))
    assert.equal(artifact.expired, false)
    assert.ok(Date.parse(artifact.expires_at) > now.getTime())
  }

  const recovery = evidence.recovery
  for (const run of [recovery.run, recovery.attempt]) verifyRun(run, q.runId, q.runAttempt, q.workflowRevision, ".github/workflows/verify-published-npm.yml", "success")
  verifyJobs(recovery.jobs, q.runId, q.runAttempt, q.workflowRevision, ["Verify immutable registry recovery"])
  const job = recovery.jobs.jobs[0]
  assert.equal(job.conclusion, "success")
  for (const step of job.steps) assert.equal(step.conclusion, "success")
  for (const [number, name] of [[4, "Verify original publication evidence and exact registry bytes"], [5, "Upload the verified recovery source receipt"]]) assert.equal(only(job.steps.filter((step) => step.number === number), "recovery step " + number).name, name)
  const verification = receipt.verification
  exactKeys(verification, ["workflowRef", "workflowSha", "runId", "runAttempt", "headRef", "event", "verifiedAt", "operation"])
  assert.deepEqual(pick(verification, ["workflowRef", "workflowSha", "runId", "runAttempt", "headRef", "event", "operation"]), {
    workflowRef: q.workflowRef, workflowSha: q.workflowRevision, runId: String(q.runId), runAttempt: String(q.runAttempt),
    headRef: "refs/heads/main", event: "workflow_dispatch", operation: "read-only-registry-verification",
  })
  const verifiedAt = Date.parse(verification.verifiedAt)
  assert.ok(Number.isFinite(verifiedAt) && verifiedAt >= Date.parse(job.started_at) && verifiedAt <= Date.parse(job.completed_at))
  verifyArtifacts(recovery.artifacts)
  assert.equal(recovery.artifacts.total_count, 1)
  const artifact = only(recovery.artifacts.artifacts.filter((entry) => entry.id === q.artifactId && entry.name === "publication-recovery-receipt"), "recovery receipt artifact")
  assert.equal(artifact.digest, q.artifactDigest)
  assert.equal(artifact.expired, false)
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0)
  assert.ok(Date.parse(artifact.expires_at) > now.getTime())
  assert.deepEqual(pick(artifact.workflow_run, ["id", "head_branch", "head_sha"]), { id: q.runId, head_branch: "main", head_sha: q.workflowRevision })

  const registry = receipt.registryIdentity
  exactKeys(registry, ["packageName", "packageVersion", "sourceRevision", "sourceDirty", "npmShasum", "npmIntegrity", "tarballSha256", "tarballUrl", "manifestSha256", "resourcesSha256", "resourceCount", "fileCount", "provenance"])
  assert.equal(registry.packageName, "@bigduu/lotus-next")
  assert.equal(registry.packageVersion, identity.packageVersion)
  assert.equal(registry.sourceRevision, identity.sourceRevision)
  assert.equal(registry.sourceDirty, false)
  for (const field of ["npmShasum", "npmIntegrity", "manifestSha256", "resourcesSha256"]) assert.equal(registry[field], identity[field])
  for (const field of ["npmShasum", "npmIntegrity", "fileCount"]) assert.equal(registry[field], record.originalFinalPack[field])
  assert.equal(registry.tarballSha256, record.independentlyObservedRegistry.tarballSha256)
  assert.equal(registry.tarballUrl, `https://registry.npmjs.org/@bigduu/lotus-next/-/lotus-next-${identity.packageVersion}.tgz`)
  const accepted = JSON.parse(record.rawEvidence.acceptedIdentity.utf8)
  for (const field of Object.keys(accepted)) assert.deepEqual(registry[field], accepted[field])
  exactKeys(registry.provenance, ["predicateType", "invocationId", "workflowSha", "payloadSha256", "cryptographicVerification"])
  assert.equal(registry.provenance.predicateType, "https://slsa.dev/provenance/v1")
  assert.equal(registry.provenance.invocationId, `https://github.com/bigduu/lotus-next/actions/runs/${p.runId}/attempts/${p.runAttempt}`)
  assert.equal(registry.provenance.workflowSha, p.workflowRevision)
  assert.match(registry.provenance.payloadSha256, digest)
  assert.equal(registry.provenance.cryptographicVerification, false)
  const proof = receipt.evidence
  exactKeys(proof, ["recordSha256", "originalArtifacts", "sourceReceiptSha256", "acceptedIdentitySha256", "localArtifactSha256", "httpsArtifactSha256", "publishLogSha256", "runResponseSha256", "attemptResponseSha256", "jobsResponseSha256", "artifactsResponseSha256", "registryMetadataSha256", "attestationsSha256"])
  for (const [field, value] of Object.entries(proof)) if (field !== "originalArtifacts") assert.match(value, digest)
  assert.equal(proof.recordSha256, q.recordSha256)
  assert.deepEqual(proof.originalArtifacts, record.artifacts.map((entry) => pick(entry, ["id", "name", "digest"])))
  for (const [field, raw] of [["sourceReceiptSha256", "sourceReceipt"], ["acceptedIdentitySha256", "acceptedIdentity"], ["localArtifactSha256", "localArtifact"], ["httpsArtifactSha256", "httpsArtifact"]]) {
    assert.equal(hash(record.rawEvidence[raw].utf8), record.rawEvidence[raw].sha256)
    assert.equal(proof[field], record.rawEvidence[raw].sha256)
  }
  assert.equal(proof.publishLogSha256, record.publishLog.sha256)
}

const verifyRecoveryReceipt = (identity, bytes, evidenceBytes, live, now = new Date()) => {
  assertPublicationIdentity(identity)
  assert.ok(identity.publication.recovery, "Explicit recovery identity required")
  assert.equal(hash(bytes), identity.publication.recovery.receiptSha256)
  assert.equal(hash(evidenceBytes), identity.publication.workflowEvidenceSha256)
  const receipt = JSON.parse(bytes)
  exactKeys(receipt, ["schemaVersion", "kind", "repository", "version", "sourceReceipt", "originalPublication", "verification", "registryIdentity", "evidence"])
  assert.equal(receipt.schemaVersion, 2)
  assert.equal(receipt.kind, "registry-verification-recovery")
  assert.equal(receipt.repository, "bigduu/lotus-next")
  assert.equal(receipt.version, identity.packageVersion)
  const recorded = JSON.parse(evidenceBytes)
  verifyRecoveryEvidence(identity, receipt, recorded, now)
  assert.ok(live, "Fresh public API evidence is required for recovery admission")
  verifyRecoveryEvidence(identity, receipt, live, now)
  for (const kind of ["original", "recovery"]) {
    const rows = (evidence) => evidence[kind].jobs.jobs.map((job) => pick(job, [...jobKeys, "started_at", "completed_at"])).sort((a, b) => a.id - b.id)
    assert.deepEqual(rows(live), rows(recorded), "Recorded and current job identities differ")
  }
  const receiptArtifact = (evidence) => pick(evidence.recovery.artifacts.artifacts[0], artifactKeys)
  assert.deepEqual(receiptArtifact(live), receiptArtifact(recorded), "Recovery artifact metadata changed")
  return receipt
}

const readRecoveryEvidence = async (identity, fetchImpl = fetch) => {
  assertPublicationIdentity(identity)
  const p = identity.publication, q = p.recovery
  assert.ok(q, "Explicit recovery identity required")
  const deadline = AbortSignal.timeout(60000)
  const read = async (url, json = true) => {
    const response = await fetchImpl(url, { method: "GET", redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.any([deadline, AbortSignal.timeout(15000)]) })
    assert.equal(response.status, 200, "Public recovery evidence GET failed: " + url)
    assert.ok(!response.headers.get("link")?.includes('rel="next"'), "Public recovery evidence is paginated")
    const chunks = []; let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      assert.ok(size <= 4 * 1024 * 1024, "Public recovery evidence exceeds the limit")
      chunks.push(chunk)
    }
    assert.ok(size > 0, "Empty public recovery evidence")
    const utf8 = Buffer.concat(chunks).toString("utf8")
    return json ? JSON.parse(utf8) : utf8
  }
  const collect = async (id, attempt) => {
    const base = `https://api.github.com/repos/bigduu/lotus-next/actions/runs/${id}`
    const [run, attemptRun, jobs, artifacts] = await Promise.all([read(base), read(`${base}/attempts/${attempt}`), read(`${base}/attempts/${attempt}/jobs?per_page=100`), read(`${base}/artifacts?per_page=100`)])
    return { run, attempt: attemptRun, jobs, artifacts }
  }
  const raw = `https://raw.githubusercontent.com/bigduu/lotus-next/${recoveryScope.verifier}`
  const [original, recovery, recordUtf8, candidatesUtf8, acceptanceUtf8] = await Promise.all([
    collect(p.runId, p.runAttempt), collect(q.runId, q.runAttempt),
    read(`${raw}/.github/release-recoveries/${recoveryScope.version}.json`, false),
    read(`${raw}/.github/release-candidates.json`, false),
    read(`${raw}/.github/release-acceptance/${recoveryScope.version}.json`, false),
  ])
  return { schemaVersion: 2, repository: "bigduu/lotus-next", original, recovery, recordUtf8, candidatesUtf8, acceptanceUtf8 }
}

const main = async () => {
  const [command, configPath, selector, ...expected] = process.argv.slice(2)
  const { readConfig, configForConsumer } = require("./release-train-policy.cjs")
  const config = readConfig(configPath)
  if (command === "ref") {
    assert.ok(["bamboo", "bodhi", "lotus-next", "bamboo-frontend"].includes(selector))
    const frontend = ["lotus-next", "bamboo-frontend"].includes(selector)
    const identity = frontend ? configForConsumer(config, selector === "bamboo-frontend" ? "bamboo" : "bodhi").frontend.lotusNext : config.sources[selector]
    if (frontend && !identity.publication) return
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
    assert.ok(expected.length <= 1)
    const consumer = expected[0] || "bodhi"
    const identity = configForConsumer(config, consumer).frontend.lotusNext
    if (!identity.publication) return
    const bytes = readFileSync(selector)
    const evidenceBytes = readFileSync(consumer === "bamboo" ? ".github/accepted-bamboo-frontend-workflow.json" : ".github/accepted-frontend-workflow.json")
    assert.equal(createHash("sha256").update(evidenceBytes).digest("hex"), identity.publication.workflowEvidenceSha256)
    const evidence = JSON.parse(evidenceBytes)
    if (identity.publication.recovery) {
      verifyRecoveryReceipt(identity, bytes, evidenceBytes, await readRecoveryEvidence(identity))
      console.log("Verified distinct failed publication and successful read-only recovery; artifact metadata/hash binding rechecked (archive/member proof is accepted separately)")
      return
    }
    assert.equal(evidence.schemaVersion, 1)
    assert.equal(evidence.repository, "bigduu/lotus-next")
    const { run, jobs } = evidence
    verifyPublicationReceipt(identity, bytes, run, jobs)
    console.log("Verified exact frontend source and main publication workflow identities")
    return
  }
  throw new Error("Usage: release-publication.cjs ref CONFIG bamboo|bodhi|lotus-next|bamboo-frontend OR publication CONFIG RECEIPT [bamboo|bodhi]")
}

module.exports = { canonicalRef, verifyRemoteRows, assertPublicationIdentity, verifyPublicationReceipt, verifyRecoveryReceipt, readRecoveryEvidence }
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1 })
