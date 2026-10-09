#!/usr/bin/env node
"use strict"

// Admission only: no Cargo, source scripts, credentials or publication writes.
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const { readConfig, resolvePolicy, selectFrontend, verifyPackageArtifact } = require("./release-train-policy.cjs")

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
const cleanEnv = () => Object.fromEntries(["PATH", "SYSTEMROOT", "TMPDIR", "TEMP"]
  .filter(key => process.env[key]).map(key => [key, process.env[key]]))
const git = (source, args) => execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", source, ...args], {
  encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  env: { ...cleanEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1" },
})

function verifySource(source, revision) {
  assert.match(revision, /^[a-f0-9]{40}$/)
  assert.equal(git(source, ["rev-parse", "HEAD"]).trim(), revision, "Bamboo checkout must equal accepted source")
  assert.equal(git(source, ["status", "--porcelain", "--untracked-files=all"]).trim(), "", "Bamboo checkout must be clean")
}

function parser(command, input, pythonCommand) {
  return JSON.parse(execFileSync(pythonCommand, ["-I", path.join(__dirname, "verify-bamboo-publication.py"), command], {
    input: JSON.stringify(input), encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env: cleanEnv(),
  }))
}

async function fetchResponse(fetchImpl, url, allowAbsent = false) {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "zenith-bamboo-publication-verifier/1.0 (+https://github.com/bigduu/Zenith)" },
    signal: AbortSignal.timeout(60000),
  })
  if (allowAbsent && response.status === 404) return null
  assert.equal(response.status, 200, `Registry request failed (${response.status}): ${url}`)
  return response
}

async function readBytes(response, limit) {
  const declared = response.headers?.get("content-length")
  if (declared !== null && declared !== undefined) {
    assert.ok(/^\d+$/.test(declared) && Number(declared) <= limit, "Registry response exceeds verification limit")
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.ok(bytes.length <= limit, "Registry response exceeds verification limit")
    return bytes
  }
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      assert.ok(length <= limit, "Registry response exceeds verification limit")
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, length)
}

async function readJson(response) {
  return response.body?.getReader ? JSON.parse((await readBytes(response, 4 * 1024 * 1024)).toString("utf8")) : response.json()
}

async function inspectPublication(options) {
  const config = typeof options.config === "string" ? readConfig(options.config) : options.config
  const policy = resolvePolicy(config, { targets: "bamboo", bambooVersion: options.version, frontendPackage: options.frontendPackage })
  const selected = selectFrontend(config, policy.frontend_package)
  const version = policy.bamboo_version
  const sourceDir = fs.realpathSync(options.sourceDir)
  const frontendPackageDir = fs.realpathSync(options.frontendPackageDir)
  const sourceRevision = config.sources.bamboo.revision
  const pythonCommand = options.pythonCommand || process.env.PYTHON || "python3"
  const fetchImpl = options.fetchImpl || globalThis.fetch
  assert.equal(typeof fetchImpl, "function", "A registry fetch implementation is required")
  verifySource(sourceDir, sourceRevision)
  verifyPackageArtifact(config, policy.frontend_package, frontendPackageDir)
  const inputs = { sourceDir, sourceRevision, version, frontendPackageDir,
    frontend: { ...selected.identity, selection: selected.selection } }
  const description = parser("describe", inputs, pythonCommand)
  const crates = description.crates
  assert.ok(Array.isArray(crates) && crates.length > 0 && crates.length <= 200, "Invalid source crate closure")
  for (const crate of crates) assert.match(crate.name, /^[a-zA-Z0-9_-]+$/)
  assert.equal(new Set(crates.map(crate => crate.name)).size, crates.length)

  const records = []
  for (const crate of crates) {
    const response = await fetchResponse(fetchImpl, `https://crates.io/api/v1/crates/${crate.name}/${version}`, true)
    if (!response) { records.push({ name: crate.name, absent: true }); continue }
    const metadata = (await readJson(response)).version
    assert.ok(metadata && typeof metadata === "object", `Malformed metadata for ${crate.name}`)
    assert.equal(metadata.num, version, `Wrong registry version for ${crate.name}`)
    assert.equal(metadata.crate, crate.name, `Wrong registry crate identity for ${crate.name}`)
    assert.equal(metadata.yanked, false, `Yanked crate ${crate.name}`)
    assert.match(metadata.checksum, /^[a-f0-9]{64}$/)
    assert.ok(Number.isSafeInteger(metadata.crate_size) && metadata.crate_size > 0 && metadata.crate_size <= MAX_ARCHIVE_BYTES,
      `Invalid registry archive size for ${crate.name}`)
    records.push({ name: crate.name, metadata })
  }
  const absent = records.filter(record => record.absent)
  if (absent.length === crates.length) {
    verifySource(sourceDir, sourceRevision)
    return { state: "absent", version, sourceRevision, crateCount: crates.length }
  }
  assert.equal(absent.length, 0, `Partial Bamboo publication: missing ${absent.map(record => record.name).join(", ")}`)

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-bamboo-publication-"))
  try {
    for (const record of records) {
      const dependencies = await fetchResponse(fetchImpl, `https://crates.io/api/v1/crates/${record.name}/${version}/dependencies`)
      record.dependencies = (await readJson(dependencies)).dependencies
      assert.ok(Array.isArray(record.dependencies), `Malformed registry dependencies for ${record.name}`)
      const response = await fetchResponse(fetchImpl, `https://static.crates.io/crates/${record.name}/${record.name}-${version}.crate`)
      const bytes = await readBytes(response, record.metadata.crate_size)
      assert.equal(bytes.length, record.metadata.crate_size, `Archive size mismatch for ${record.name}`)
      assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), record.metadata.checksum,
        `Archive checksum mismatch for ${record.name}`)
      record.archive = path.join(directory, `${record.name}.crate`)
      fs.writeFileSync(record.archive, bytes, { mode: 0o600, flag: "wx" })
    }
    const verification = parser("verify", { ...inputs, records }, pythonCommand)
    verifySource(sourceDir, sourceRevision)
    return { state: "verified", version, sourceRevision, crateCount: crates.length,
      frontendPackage: policy.frontend_package, frontendVersion: policy.frontend_version,
      ...verification, crates: records.map(record => ({ name: record.name, checksum: record.metadata.checksum })) }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

async function main(args) {
  assert.equal(args.shift(), "inspect", "Expected inspect command")
  const names = new Map([["--config", "config"], ["--version", "version"], ["--frontend-package", "frontendPackage"],
    ["--frontend-package-dir", "frontendPackageDir"], ["--source-dir", "sourceDir"]])
  const options = {}
  assert.equal(args.length % 2, 0, "Every option needs a value")
  for (let index = 0; index < args.length; index += 2) {
    const name = names.get(args[index])
    assert.ok(name && !Object.hasOwn(options, name), `Invalid or duplicate option ${args[index]}`)
    options[name] = args[index + 1]
  }
  for (const name of names.values()) assert.ok(options[name], `Missing ${name}`)
  process.stdout.write(JSON.stringify(await inspectPublication(options)) + "\n")
}

module.exports = { inspectPublication, verifySource }
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n")
  process.exitCode = 1
})
