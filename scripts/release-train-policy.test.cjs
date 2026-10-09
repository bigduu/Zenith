"use strict"

const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const { spawnSync } = require("node:child_process")
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

test("accepts the committed release authority and fixed identities", () => {
  const config = readConfig(configPath)
  assert.equal(config.schemaVersion, 2)
  assert.equal(config.sources.bamboo.ref, "refs/tags/bamboo-bodhi-source-2026.10.9")
  assert.equal(config.sources.bamboo.revision, "16e98d94cd971b7341dbd82110dd056497090d26")
  assert.equal(config.sources.bamboo.tagObjectSha, "62b59ae2b878d2f9e666167483a5103929348e25")
  assert.equal(config.sources.bodhi.ref, "refs/tags/bodhi-source-2026.10.9")
  assert.equal(config.sources.bodhi.revision, "571a6a9b716e6fd6967ed64db0c054f864f4b6aa")
  assert.equal(config.sources.bodhi.tagObjectSha, "41bd30938936c6f3c894d89172664bbdf089b031")
  assert.equal(config.frontend.defaultPackage, "@bigduu/lotus-next")
  assert.equal(config.frontend.lotusNext.ref, "refs/tags/lotus-next-v2026.10.8")
  assert.equal(config.frontend.lotusNext.packageVersion, "2026.10.8")
  assert.equal(config.frontend.lotusNext.sourceRevision, "5242eaf1d6e8cd8d437e8a4dcb82c63d00af82f1")
  assert.equal(config.frontend.lotusNext.sourceDirty, false)
  assert.equal(config.frontend.lotusNext.publication.workflowRevision, "0730499f9e87cfcf818eec67557409b4ba4f7ba3")
  assert.equal(config.frontend.lotusNext.publication.runId, 37781330129)
  assert.equal(config.frontend.lotusNext.publication.tagObjectSha, "4d0e2ec1780efea0798dc4f8ef55e528ffc32b38")
  assert.deepEqual(config.frontend.legacyRollback, {
    packageName: "@bigduu/lotus",
    packageVersion: "2026.8.28",
    npmShasum: "33b44396bba7f6ad81ab4c23631ff1f6bd8191e2",
    npmIntegrity:
      "sha512-XHsTmskpprHNSr7w+qwBICZvYsqowdgtQ7H5OcWwjXlzl17M7K91eMGQEMN/LLzD+XGnaWuGlVmiawRknJ2yrg==",
  })
})

// Exercise the workflow's actual shell so a verifier failure cannot silently
// become an absent version or fall through to a Bodhi dispatch.
const runTrainShell = (step, options = {}) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "zenith-train-admission-"))
  try {
    const workflow = readFileSync(path.join(repositoryRoot, ".github/workflows/release-train.yml"), "utf8")
    const section = workflow.split("      - name: " + step + "\n")[1]?.split(/\n      - name:/)[0]
    assert.ok(section, "Missing release train step: " + step)
    const lines = section.split("        run: |\n")[1].split("\n")
    const end = lines.findIndex((line) => line.trim() && !line.startsWith("          "))
    const shell = lines.slice(0, end < 0 ? undefined : end).map((line) => line.replace(/^          /, "")).join("\n")
    const bin = path.join(directory, "bin")
    mkdirSync(bin)
    writeFileSync(path.join(bin, "node"), `#!/bin/bash
set -eu
if [[ "$1" == *"verify-bamboo-publication.cjs" ]]; then
  echo verify >> "$VERIFY_LOG"
  if [ "$MOCK_BAMBOO_STATE" = error ]; then exit 47; fi
  printf '{"state":"%s"}\\n' "$MOCK_BAMBOO_STATE"
elif [[ "$1" != *"release-publication.cjs" ]]; then
  exit 48
fi
`, { mode: 0o755 })
    writeFileSync(path.join(bin, "gh"), `#!/bin/bash
set -eu
revision="$BAMBOO_REVISION"
if [[ "$*" == *"bigduu/Bodhi-AI"* ]]; then revision="$BODHI_REVISION"; fi
case "$1 $2" in
  "release view") [ "$MOCK_BODHI_EXISTS" = true ] ;;
  "workflow run") echo "$*" >> "$DISPATCH_LOG" ;;
  "run list") printf '[{"databaseId":1,"createdAt":"2099-01-01T00:00:00Z","headSha":"%s"}]' "$revision" ;;
  "run view") echo "$revision" ;;
  "run watch") exit 0 ;;
  *) exit 49 ;;
esac
`, { mode: 0o755 })
    const result = spawnSync("bash", ["-c", shell], {
      encoding: "utf8",
      env: {
        PATH: bin + path.delimiter + process.env.PATH,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: path.join(directory, "output"),
        VERIFY_LOG: path.join(directory, "verify"),
        DISPATCH_LOG: path.join(directory, "dispatch"),
        MOCK_BAMBOO_STATE: "verified",
        MOCK_BODHI_EXISTS: "false",
        INCLUDE_BAMBOO: "true", INCLUDE_BODHI: "true", RESUME: "true",
        SKIP_BAMBOO: "false", SKIP_BODHI: "false",
        BAMBOO_VERSION: "2026.10.10", BODHI_VERSION: "2026.10.10",
        BAMBOO_REPOSITORY: "bigduu/Bamboo-agent", BAMBOO_WORKFLOW: "publish-crate.yml",
        BAMBOO_REF: "refs/tags/bamboo-source", BAMBOO_REVISION: "1".repeat(40),
        BODHI_REPOSITORY: "bigduu/Bodhi-AI", BODHI_WORKFLOW: "release.yml",
        BODHI_REF: "refs/tags/bodhi-source", BODHI_REVISION: "2".repeat(40),
        FRONTEND_PACKAGE: "@bigduu/lotus-next", FRONTEND_VERSION: "2026.10.8",
        FRONTEND_PACKAGE_DIR: path.join(directory, "frontend"),
        BAMBOO_SOURCE_DIR: path.join(directory, "bamboo"),
        ...options,
      },
    })
    const contents = (name) => {
      try { return readFileSync(path.join(directory, name), "utf8") } catch (error) {
        if (error.code !== "ENOENT") throw error
        return ""
      }
    }
    return { ...result, output: contents("output"), dispatch: contents("dispatch"), verification: contents("verify") }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test("train preflight admits only a complete identity or an entirely unused version", () => {
  const cases = [
    [{}, true, "skip_bamboo=true"],
    [{ RESUME: "false" }, false],
    [{ MOCK_BAMBOO_STATE: "absent" }, true, "skip_bamboo=false"],
    [{ INCLUDE_BAMBOO: "false" }, true, "skip_bamboo=false"],
    [{ INCLUDE_BAMBOO: "false", MOCK_BAMBOO_STATE: "absent" }, false],
    [{ MOCK_BAMBOO_STATE: "error" }, false],
    [{ MOCK_BAMBOO_STATE: "unexpected" }, false],
  ]
  for (const [options, success, expectedOutput] of cases) {
    const result = runTrainShell("Check downstream version collisions", options)
    assert.equal(result.status === 0, success, JSON.stringify(options) + result.stderr)
    assert.equal(result.dispatch, "")
    assert.equal(result.verification, "verify\n")
    if (success) assert.ok(result.output.includes(expectedOutput))
    else assert.equal(result.output, "")
  }
})

test("train rechecks Bamboo after publication and before every Bodhi admission", () => {
  const cases = [
    [{}, true, ["bigduu/Bamboo-agent", "bigduu/Bodhi-AI"]],
    [{ MOCK_BAMBOO_STATE: "error" }, false, ["bigduu/Bamboo-agent"]],
    [{ MOCK_BAMBOO_STATE: "absent" }, false, ["bigduu/Bamboo-agent"]],
    [{ SKIP_BAMBOO: "true", MOCK_BAMBOO_STATE: "error" }, false, []],
    [{ INCLUDE_BAMBOO: "false", MOCK_BAMBOO_STATE: "error" }, false, []],
    [{ INCLUDE_BAMBOO: "false" }, true, ["bigduu/Bodhi-AI"]],
    [{ INCLUDE_BODHI: "false", MOCK_BAMBOO_STATE: "error" }, false, ["bigduu/Bamboo-agent"]],
  ]
  for (const [options, success, repositories] of cases) {
    const result = runTrainShell("Run Bamboo then Bodhi", options)
    assert.equal(result.status === 0, success, JSON.stringify(options) + result.stderr)
    assert.equal(result.verification, "verify\n")
    const actual = result.dispatch.trim().split("\n").filter(Boolean).map((line) => line.match(/-R ([^ ]+)/)[1])
    assert.deepEqual(actual, repositories)
  }
})

test("defaults to a Bamboo then Bodhi train with the locked Lotus Next artifact", () => {
  const config = readConfig(configPath)
  const resolved = resolvePolicy(config)
  assert.equal(resolved.include_bamboo, "true")
  assert.equal(resolved.include_bodhi, "true")
  assert.equal(resolved.release_version, config.versions.release)
  assert.equal(resolved.bamboo_version, config.versions.release)
  assert.equal(resolved.bodhi_version, config.versions.release)
  assert.equal(resolved.frontend_selection, "lotus-next")
  assert.equal(resolved.frontend_package, "@bigduu/lotus-next")
  assert.equal(
    resolved.frontend_version,
    config.frontend.lotusNext.packageVersion,
  )
})

test("preserves partial-train version pinning", () => {
  const config = clone(readConfig(configPath))
  config.versions = {
    release: "2030.1.3",
    bamboo: "2030.1.1",
    bodhi: "2030.1.2",
  }
  const resolved = resolvePolicy(config, { targets: "bodhi" })
  assert.equal(resolved.include_bamboo, "false")
  assert.equal(resolved.include_bodhi, "true")
  assert.equal(resolved.bamboo_version, config.versions.bamboo)
  assert.equal(resolved.bodhi_version, config.versions.release)
})

test("resolves only the fixed legacy rollback when explicitly selected", () => {
  const config = clone(readConfig(configPath))
  config.versions.bodhi = "2030.1.2"
  const resolved = resolvePolicy(config, {
    targets: "bamboo",
    frontendPackage: "@bigduu/lotus",
    releaseVersion: "2026.9.15",
  })
  assert.equal(resolved.frontend_selection, "legacy-rollback")
  assert.equal(resolved.frontend_package, "@bigduu/lotus")
  assert.equal(resolved.frontend_version, "2026.8.28")
  assert.equal(resolved.bamboo_version, "2026.9.15")
  assert.equal(resolved.bodhi_version, config.versions.bodhi)
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

test("requires an immutable annotated tag object and publication receipt authority", () => {
  const tagged = clone(readConfig(configPath))
  tagged.sources.bamboo.ref = "refs/tags/bamboo-bodhi-source-2026.10.8"
  delete tagged.sources.bamboo.tagObjectSha
  assert.throws(() => validateConfig(tagged), /Git object ID/)
  tagged.sources.bamboo.tagObjectSha = "1".repeat(40)
  assert.doesNotThrow(() => validateConfig(tagged))
  tagged.sources.bamboo.ref = "dev"
  assert.throws(() => validateConfig(tagged), /requires an annotated tag/)

  const frontend = clone(readConfig(configPath))
  frontend.frontend.lotusNext.ref = "refs/tags/lotus-next-v" + frontend.frontend.lotusNext.packageVersion
  delete frontend.frontend.lotusNext.publication
  assert.throws(() => validateConfig(frontend))
  frontend.frontend.lotusNext.publication = {
    workflowRef: "bigduu/lotus-next/.github/workflows/publish-npm.yml@refs/heads/main",
    workflowRevision: "2".repeat(40), runId: 123, runAttempt: 1,
    tagObjectSha: "3".repeat(40), sourceReceiptSha256: "4".repeat(64), workflowEvidenceSha256: "5".repeat(64),
  }
  assert.doesNotThrow(() => validateConfig(frontend))
  frontend.frontend.lotusNext.publication.workflowRef = "bigduu/lotus-next/.github/workflows/publish-npm.yml@refs/heads/dev"
  assert.throws(() => validateConfig(frontend))
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
  const config = clone(readConfig(configPath))
  mkdirSync(path.join(distDirectory, "assets"), { recursive: true })
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify(
      {
        name: "@bigduu/lotus-next",
        version: config.frontend.lotusNext.packageVersion,
      },
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
