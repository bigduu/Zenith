"use strict"

const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
  calculateResourcesSha256,
  formatGitHubOutputs,
  readConfig,
  resourceRecord,
  resolvePolicy,
  validateConfig,
  verifyPackageArtifact,
  verifyTarball,
} = require("./release-train-policy.cjs")

const repositoryRoot = path.resolve(__dirname, "..")
const configPath = path.join(
  repositoryRoot,
  ".github",
  "release-train.config.json",
)
const clone = (value) => JSON.parse(JSON.stringify(value))
const digest = (algorithm, value, encoding) =>
  createHash(algorithm).update(value).digest(encoding)

test("accepts the committed release authority", () => {
  const config = readConfig(configPath)
  assert.equal(config.schemaVersion, 2)
  assert.equal(config.sources.bamboo.ref, "dev")
  assert.equal(
    config.sources.bamboo.revision,
    "a8b5385dc4318ab02ba35c0692bdf48914275f6c",
  )
  assert.equal(
    config.sources.bodhi.revision,
    "d6b3353577ece7587ca3c71aafada076032f2478",
  )
  assert.deepEqual(config.versions, {
    release: "2026.9.14",
    bamboo: "2026.9.12",
    bodhi: "2026.9.12",
  })
  assert.equal(config.frontend.defaultPackage, "@bigduu/lotus-next")
  assert.equal(config.frontend.lotusNext.packageVersion, "2026.9.14")
  assert.equal(
    config.frontend.lotusNext.sourceRevision,
    "ae17b50574ccd86395cbc226b50c9fb2f0f51e0f",
  )
  assert.equal(config.frontend.lotusNext.sourceDirty, false)
})

test("defaults to a Bamboo then Bodhi train with the locked Lotus Next artifact", () => {
  const config = readConfig(configPath)
  const resolved = resolvePolicy(config)
  assert.equal(resolved.include_bamboo, "true")
  assert.equal(resolved.include_bodhi, "true")
  assert.equal(resolved.release_version, "2026.9.14")
  assert.equal(resolved.bamboo_version, "2026.9.14")
  assert.equal(resolved.bodhi_version, "2026.9.14")
  assert.equal(resolved.frontend_selection, "lotus-next")
  assert.equal(resolved.frontend_package, "@bigduu/lotus-next")
  assert.equal(resolved.frontend_version, "2026.9.14")
})

test("preserves partial-train version pinning", () => {
  const config = readConfig(configPath)
  const resolved = resolvePolicy(config, { targets: "bodhi" })
  assert.equal(resolved.include_bamboo, "false")
  assert.equal(resolved.include_bodhi, "true")
  assert.equal(resolved.bamboo_version, "2026.9.12")
  assert.equal(resolved.bodhi_version, "2026.9.14")
})

test("resolves only the fixed legacy rollback when explicitly selected", () => {
  const config = readConfig(configPath)
  const resolved = resolvePolicy(config, {
    targets: "bamboo",
    frontendPackage: "@bigduu/lotus",
    releaseVersion: "2026.9.15",
  })
  assert.equal(resolved.frontend_selection, "legacy-rollback")
  assert.equal(resolved.frontend_package, "@bigduu/lotus")
  assert.equal(resolved.frontend_version, "2026.8.28")
  assert.equal(resolved.bamboo_version, "2026.9.15")
  assert.equal(resolved.bodhi_version, "2026.9.12")
})

test("rejects malformed or mismatched release authority", () => {
  const config = readConfig(configPath)

  const extraKey = clone(config)
  extraKey.unreviewed = true
  assert.throws(() => validateConfig(extraKey), /must contain exactly/)

  const dirtySource = clone(config)
  dirtySource.frontend.lotusNext.sourceDirty = true
  assert.throws(() => validateConfig(dirtySource), /sourceDirty must be exactly false/)

  const wrongDefault = clone(config)
  wrongDefault.frontend.defaultPackage = "@bigduu/lotus"
  assert.throws(() => validateConfig(wrongDefault), /defaultPackage/)

  const badRevision = clone(config)
  badRevision.sources.bamboo.revision = "main"
  assert.throws(() => validateConfig(badRevision), /Git object ID/)

  const badIntegrity = clone(config)
  badIntegrity.frontend.legacyRollback.npmIntegrity = "sha512-not-base64"
  assert.throws(() => validateConfig(badIntegrity), /canonical SHA-512/)
})

test("rejects moving versions, unknown targets, and uncommitted package choices", () => {
  const config = readConfig(configPath)
  assert.throws(
    () => resolvePolicy(config, { releaseVersion: "latest" }),
    /exact, non-placeholder SemVer/,
  )
  assert.throws(
    () => resolvePolicy(config, { targets: "lotus" }),
    /Unknown release target/,
  )
  assert.throws(
    () => resolvePolicy(config, { targets: "bamboo,bamboo" }),
    /must not contain duplicates/,
  )
  assert.throws(
    () => resolvePolicy(config, { frontendPackage: "@bigduu/lotus-next@latest" }),
    /frontend_package must be exactly/,
  )
})

test("formats line-safe GitHub outputs and rejects output injection", () => {
  assert.equal(
    formatGitHubOutputs({ include_bamboo: "true", version: "2026.9.14" }),
    "include_bamboo=true\nversion=2026.9.14\n",
  )
  assert.throws(
    () => formatGitHubOutputs({ version: "2026.9.14\npoison=true" }),
    /contains a line break/,
  )
  assert.throws(
    () => formatGitHubOutputs({ "bad-key": "value" }),
    /Unsafe GitHub output key/,
  )
})

test("verifies the downloaded tarball against both locked npm digests", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "zenith-release-policy-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const tarball = path.join(directory, "artifact.tgz")
  const contents = Buffer.from("locked registry artifact")
  writeFileSync(tarball, contents)

  const config = clone(readConfig(configPath))
  config.frontend.legacyRollback.npmShasum = digest("sha1", contents, "hex")
  config.frontend.legacyRollback.npmIntegrity =
    "sha512-" + digest("sha512", contents, "base64")
  validateConfig(config)

  const verified = verifyTarball(config, "@bigduu/lotus", tarball)
  assert.equal(verified.npmShasum, config.frontend.legacyRollback.npmShasum)

  writeFileSync(tarball, Buffer.from("mutated registry artifact"))
  assert.throws(
    () => verifyTarball(config, "@bigduu/lotus", tarball),
    /does not match the committed identity/,
  )
})

test("verifies every Lotus Next manifest resource and rejects byte drift", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "zenith-release-policy-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const packageDirectory = path.join(directory, "package")
  const distDirectory = path.join(packageDirectory, "dist")
  mkdirSync(path.join(distDirectory, "assets"), { recursive: true })
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify(
      { name: "@bigduu/lotus-next", version: "2026.9.14" },
      null,
      2,
    ) + "\n",
  )
  writeFileSync(path.join(distDirectory, "index.html"), "<main>Lotus Next</main>\n")
  writeFileSync(path.join(distDirectory, "assets", "app.js"), "export {}\n")

  const resources = ["assets/app.js", "index.html"].map((resourcePath) =>
    resourceRecord(distDirectory, resourcePath),
  )
  const resourcesSha256 = calculateResourcesSha256(resources)
  const config = clone(readConfig(configPath))
  config.frontend.lotusNext.resourcesSha256 = resourcesSha256
  const manifest = {
    schemaVersion: 1,
    packageName: config.frontend.lotusNext.packageName,
    packageVersion: config.frontend.lotusNext.packageVersion,
    sourceRevision: config.frontend.lotusNext.sourceRevision,
    sourceDirty: false,
    entrypoint: "index.html",
    resourcesSha256,
    resources,
  }
  const manifestSource = JSON.stringify(manifest, null, 2) + "\n"
  writeFileSync(path.join(distDirectory, "lotus-next-manifest.json"), manifestSource)
  config.frontend.lotusNext.manifestSha256 = digest(
    "sha256",
    manifestSource,
    "hex",
  )
  validateConfig(config)

  const verified = verifyPackageArtifact(
    config,
    "@bigduu/lotus-next",
    packageDirectory,
  )
  assert.equal(verified.resourceCount, 2)
  assert.equal(verified.resourcesSha256, resourcesSha256)

  writeFileSync(path.join(distDirectory, "index.html"), "<main>tampered</main>\n")
  assert.throws(
    () =>
      verifyPackageArtifact(config, "@bigduu/lotus-next", packageDirectory),
    /does not match its manifest/,
  )
})

test("wires the release and nightly workflows to the immutable frontend", () => {
  const releaseWorkflow = readFileSync(
    path.join(repositoryRoot, ".github", "workflows", "release-train.yml"),
    "utf8",
  )
  const nightlyWorkflow = readFileSync(
    path.join(repositoryRoot, ".github", "workflows", "nightly-release.yml"),
    "utf8",
  )
  const policyWorkflow = readFileSync(
    path.join(repositoryRoot, ".github", "workflows", "release-policy.yml"),
    "utf8",
  )

  assert.match(releaseWorkflow, /default: "bamboo,bodhi"/)
  assert.match(releaseWorkflow, /release-train-policy\.cjs" verify-tarball/)
  assert.match(releaseWorkflow, /release-train-policy\.cjs" verify-package/)
  assert.match(releaseWorkflow, /frontend_package=\$\{FRONTEND_PACKAGE\}/)
  assert.match(releaseWorkflow, /lotus_version=\$\{FRONTEND_VERSION\}/)
  assert.match(releaseWorkflow, /bamboo_ref=\$\{BAMBOO_REVISION\}/)
  assert.doesNotMatch(releaseWorkflow, /include_lotus|INCLUDE_LOTUS/)
  assert.doesNotMatch(releaseWorkflow, /lotus_skip_tests/i)
  assert.doesNotMatch(releaseWorkflow, /bigduu\/Lotus/)
  assert.doesNotMatch(releaseWorkflow, /publish-npm\.yml/)

  assert.match(nightlyWorkflow, /registry\.npmjs\.org\/@bigduu%2flotus-next/)
  assert.match(nightlyWorkflow, /\.versions\.bamboo = \$v/)
  assert.match(nightlyWorkflow, /\.versions\.bodhi = \$v/)
  assert.match(nightlyWorkflow, /-f targets=bamboo,bodhi/)
  assert.match(nightlyWorkflow, /-f release_version="\$\{new_version\}"/)
  assert.doesNotMatch(nightlyWorkflow, /\.versions\.lotus\s*=/)
  assert.doesNotMatch(
    nightlyWorkflow,
    /registry\.npmjs\.org\/@bigduu%2flotus"/,
  )
  assert.doesNotMatch(nightlyWorkflow, /lotus_skip_tests/i)

  assert.match(policyWorkflow, /name: Validate Release Policy/)
  assert.match(policyWorkflow, /node --test scripts\/release-train-policy\.test\.cjs/)
  assert.match(policyWorkflow, /Round-trip both committed npm artifacts/)
  assert.match(
    policyWorkflow,
    /8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8/,
  )
})
