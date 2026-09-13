#!/usr/bin/env node
"use strict"

const { createHash } = require("node:crypto")
const {
  appendFileSync,
  lstatSync,
  readFileSync,
  readdirSync,
} = require("node:fs")
const path = require("node:path")

const CONFIG_SCHEMA_VERSION = 2
const MANIFEST_FILE = "lotus-next-manifest.json"
const LOTUS_NEXT_PACKAGE = "@bigduu/lotus-next"
const LEGACY_LOTUS_PACKAGE = "@bigduu/lotus"

const strictSemver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const sha1Pattern = /^[0-9a-f]{40}$/
const sha256Pattern = /^[0-9a-f]{64}$/
const revisionPattern = /^[0-9a-f]{40}$/
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const workflowPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/
const outputKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/

const isPlainObject = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype

const assertPlainObject = (value, label) => {
  if (!isPlainObject(value)) {
    throw new Error(label + " must be an object.")
  }
  return value
}

const assertExactKeys = (value, expectedKeys, label) => {
  assertPlainObject(value, label)
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(label + " must contain exactly: " + expectedKeys.join(", ") + ".")
  }
}

const assertString = (value, label) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(label + " must be a non-empty string.")
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(label + " must not contain control characters.")
  }
  return value
}

const assertSemver = (value, label) => {
  assertString(value, label)
  if (!strictSemver.test(value) || value === "0.0.0") {
    throw new Error(label + " must be an exact, non-placeholder SemVer.")
  }
  return value
}

const assertRevision = (value, label) => {
  if (typeof value !== "string" || !revisionPattern.test(value)) {
    throw new Error(label + " must be a lowercase 40-character Git object ID.")
  }
  return value
}

const assertDigest = (value, pattern, label) => {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(label + " has an invalid digest.")
  }
  return value
}

const assertNpmIntegrity = (value, label) => {
  assertString(value, label)
  if (!value.startsWith("sha512-")) {
    throw new Error(label + " must use sha512.")
  }
  const encoded = value.slice("sha512-".length)
  const decoded = Buffer.from(encoded, "base64")
  if (decoded.length !== 64 || decoded.toString("base64") !== encoded) {
    throw new Error(label + " is not a canonical SHA-512 integrity value.")
  }
  return value
}

const assertRef = (value, label) => {
  assertString(value, label)
  const segments = value.split("/")
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".lock"),
    )
  ) {
    throw new Error(label + " is not a safe branch ref.")
  }
  return value
}

const validateSource = (source, name, expected) => {
  const label = "sources." + name
  assertExactKeys(
    source,
    ["repository", "workflow", "ref", "revision", "rootPath"],
    label,
  )
  if (
    !repositoryPattern.test(assertString(source.repository, label + ".repository")) ||
    source.repository !== expected.repository
  ) {
    throw new Error(label + ".repository must be exactly " + expected.repository + ".")
  }
  if (
    !workflowPattern.test(assertString(source.workflow, label + ".workflow")) ||
    source.workflow !== expected.workflow
  ) {
    throw new Error(label + ".workflow must be exactly " + expected.workflow + ".")
  }
  assertRef(source.ref, label + ".ref")
  assertRevision(source.revision, label + ".revision")
  if (source.rootPath !== expected.rootPath) {
    throw new Error(label + ".rootPath must be exactly " + expected.rootPath + ".")
  }
}

const validateLotusNext = (frontend) => {
  const label = "frontend.lotusNext"
  assertExactKeys(
    frontend,
    [
      "repository",
      "ref",
      "rootPath",
      "manifestSchemaVersion",
      "packageName",
      "packageVersion",
      "sourceRevision",
      "sourceDirty",
      "entrypoint",
      "resourcesSha256",
      "manifestSha256",
      "npmShasum",
      "npmIntegrity",
    ],
    label,
  )
  if (frontend.repository !== "bigduu/lotus-next") {
    throw new Error(label + ".repository must be exactly bigduu/lotus-next.")
  }
  assertRef(frontend.ref, label + ".ref")
  if (frontend.rootPath !== "lotus-next") {
    throw new Error(label + ".rootPath must be exactly lotus-next.")
  }
  if (frontend.manifestSchemaVersion !== 1) {
    throw new Error(label + ".manifestSchemaVersion must be exactly 1.")
  }
  if (frontend.packageName !== LOTUS_NEXT_PACKAGE) {
    throw new Error(label + ".packageName must be exactly " + LOTUS_NEXT_PACKAGE + ".")
  }
  assertSemver(frontend.packageVersion, label + ".packageVersion")
  assertRevision(frontend.sourceRevision, label + ".sourceRevision")
  if (frontend.sourceDirty !== false) {
    throw new Error(label + ".sourceDirty must be exactly false.")
  }
  if (frontend.entrypoint !== "index.html") {
    throw new Error(label + ".entrypoint must be exactly index.html.")
  }
  assertDigest(frontend.resourcesSha256, sha256Pattern, label + ".resourcesSha256")
  assertDigest(frontend.manifestSha256, sha256Pattern, label + ".manifestSha256")
  assertDigest(frontend.npmShasum, sha1Pattern, label + ".npmShasum")
  assertNpmIntegrity(frontend.npmIntegrity, label + ".npmIntegrity")
}

const validateLegacyRollback = (frontend) => {
  const label = "frontend.legacyRollback"
  assertExactKeys(
    frontend,
    ["packageName", "packageVersion", "npmShasum", "npmIntegrity"],
    label,
  )
  if (frontend.packageName !== LEGACY_LOTUS_PACKAGE) {
    throw new Error(
      label + ".packageName must be exactly " + LEGACY_LOTUS_PACKAGE + ".",
    )
  }
  assertSemver(frontend.packageVersion, label + ".packageVersion")
  assertDigest(frontend.npmShasum, sha1Pattern, label + ".npmShasum")
  assertNpmIntegrity(frontend.npmIntegrity, label + ".npmIntegrity")
}

const validateConfig = (config) => {
  assertExactKeys(
    config,
    ["schemaVersion", "sources", "versions", "frontend"],
    "release-train config",
  )
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error(
      "release-train config schemaVersion must be exactly " +
        CONFIG_SCHEMA_VERSION +
        ".",
    )
  }

  assertExactKeys(config.sources, ["bamboo", "bodhi"], "sources")
  validateSource(config.sources.bamboo, "bamboo", {
    repository: "bigduu/Bamboo-agent",
    workflow: "publish-crate.yml",
    rootPath: "bamboo",
  })
  validateSource(config.sources.bodhi, "bodhi", {
    repository: "bigduu/Bodhi-AI",
    workflow: "release.yml",
    rootPath: "bodhi",
  })

  assertExactKeys(config.versions, ["release", "bamboo", "bodhi"], "versions")
  assertSemver(config.versions.release, "versions.release")
  assertSemver(config.versions.bamboo, "versions.bamboo")
  assertSemver(config.versions.bodhi, "versions.bodhi")

  assertExactKeys(
    config.frontend,
    ["defaultPackage", "lotusNext", "legacyRollback"],
    "frontend",
  )
  if (config.frontend.defaultPackage !== LOTUS_NEXT_PACKAGE) {
    throw new Error(
      "frontend.defaultPackage must be exactly " + LOTUS_NEXT_PACKAGE + ".",
    )
  }
  validateLotusNext(config.frontend.lotusNext)
  validateLegacyRollback(config.frontend.legacyRollback)
  return config
}

const readConfig = (configPath) => {
  const absolutePath = path.resolve(configPath)
  const metadata = lstatSync(absolutePath)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Release-train config must be a regular file.")
  }
  const source = readFileSync(absolutePath, "utf8")
  let config
  try {
    config = JSON.parse(source)
  } catch (error) {
    throw new Error(
      "Release-train config is not valid JSON: " +
        (error instanceof Error ? error.message : String(error)),
    )
  }
  validateConfig(config)
  if (source !== JSON.stringify(config, null, 2) + "\n") {
    throw new Error("Release-train config must use canonical two-space JSON.")
  }
  return config
}

const parseBoolean = (value, label, fallback) => {
  if (value === undefined || value === "") return fallback
  if (value === true || value === "true") return true
  if (value === false || value === "false") return false
  throw new Error(label + " must be exactly true or false.")
}

const parseTargets = (value) => {
  const raw = value === undefined || value.trim() === "" ? "bamboo,bodhi" : value
  const targets = raw.split(",").map((target) => target.trim())
  if (targets.some((target) => target.length === 0)) {
    throw new Error("targets must not contain an empty entry.")
  }
  if (new Set(targets).size !== targets.length) {
    throw new Error("targets must not contain duplicates.")
  }
  for (const target of targets) {
    if (target !== "bamboo" && target !== "bodhi") {
      throw new Error(
        "Unknown release target " +
          JSON.stringify(target) +
          " (expected bamboo and/or bodhi).",
      )
    }
  }
  return new Set(targets)
}

const resolveVersion = (input, fallback, label) => {
  const value =
    input === undefined || input === "" || input === "from_manifest"
      ? fallback
      : input
  return assertSemver(value, label)
}

const selectFrontend = (config, packageName) => {
  if (packageName === config.frontend.lotusNext.packageName) {
    return { selection: "lotus-next", identity: config.frontend.lotusNext }
  }
  if (packageName === config.frontend.legacyRollback.packageName) {
    return { selection: "legacy-rollback", identity: config.frontend.legacyRollback }
  }
  throw new Error(
    "frontend_package must be exactly " +
      config.frontend.lotusNext.packageName +
      " or " +
      config.frontend.legacyRollback.packageName +
      ".",
  )
}

const resolvePolicy = (config, input = {}) => {
  validateConfig(config)
  const targets = parseTargets(input.targets)
  const includeBamboo = targets.has("bamboo")
  const includeBodhi = targets.has("bodhi")
  const resume = parseBoolean(input.resume, "resume", false)
  const releaseVersion = resolveVersion(
    input.releaseVersion,
    config.versions.release,
    "release_version",
  )
  const bambooVersion = resolveVersion(
    input.bambooVersion,
    includeBamboo ? releaseVersion : config.versions.bamboo,
    "bamboo_version",
  )
  const bodhiVersion = resolveVersion(
    input.bodhiVersion,
    includeBodhi ? releaseVersion : config.versions.bodhi,
    "bodhi_version",
  )
  const requestedFrontend =
    input.frontendPackage === undefined ||
    input.frontendPackage === "" ||
    input.frontendPackage === "from_manifest"
      ? config.frontend.defaultPackage
      : input.frontendPackage
  const frontend = selectFrontend(config, requestedFrontend)

  return {
    include_bamboo: String(includeBamboo),
    include_bodhi: String(includeBodhi),
    resume: String(resume),
    release_version: releaseVersion,
    bamboo_version: bambooVersion,
    bodhi_version: bodhiVersion,
    bamboo_repository: config.sources.bamboo.repository,
    bamboo_workflow: config.sources.bamboo.workflow,
    bamboo_ref: config.sources.bamboo.ref,
    bamboo_revision: config.sources.bamboo.revision,
    bamboo_root_path: config.sources.bamboo.rootPath,
    bodhi_repository: config.sources.bodhi.repository,
    bodhi_workflow: config.sources.bodhi.workflow,
    bodhi_ref: config.sources.bodhi.ref,
    bodhi_revision: config.sources.bodhi.revision,
    bodhi_root_path: config.sources.bodhi.rootPath,
    lotus_next_repository: config.frontend.lotusNext.repository,
    lotus_next_ref: config.frontend.lotusNext.ref,
    lotus_next_revision: config.frontend.lotusNext.sourceRevision,
    lotus_next_root_path: config.frontend.lotusNext.rootPath,
    frontend_selection: frontend.selection,
    frontend_package: frontend.identity.packageName,
    frontend_version: frontend.identity.packageVersion,
  }
}

const formatGitHubOutputs = (outputs) => {
  assertPlainObject(outputs, "GitHub outputs")
  let result = ""
  for (const [key, rawValue] of Object.entries(outputs)) {
    if (!outputKeyPattern.test(key)) {
      throw new Error("Unsafe GitHub output key " + JSON.stringify(key) + ".")
    }
    if (!["string", "number", "boolean"].includes(typeof rawValue)) {
      throw new Error("GitHub output " + key + " must be scalar.")
    }
    const value = String(rawValue)
    if (/[\u0000\r\n]/u.test(value)) {
      throw new Error("GitHub output " + key + " contains a line break.")
    }
    result += key + "=" + value + "\n"
  }
  return result
}

const writeGitHubOutputs = (outputPath, outputs) => {
  appendFileSync(outputPath, formatGitHubOutputs(outputs), "utf8")
}

const hash = (algorithm, contents, encoding) =>
  createHash(algorithm).update(contents).digest(encoding)

const assertRegularFile = (filePath, label) => {
  const metadata = lstatSync(filePath)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(label + " must be a regular file and not a symbolic link.")
  }
  return metadata
}

const assertDirectory = (directoryPath, label) => {
  const metadata = lstatSync(directoryPath)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(label + " must be a directory and not a symbolic link.")
  }
}

const assertResourcePath = (resourcePath) => {
  if (
    typeof resourcePath !== "string" ||
    resourcePath.length === 0 ||
    resourcePath !== resourcePath.normalize("NFC") ||
    path.posix.isAbsolute(resourcePath) ||
    path.win32.isAbsolute(resourcePath) ||
    resourcePath.includes("\\") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(resourcePath)
  ) {
    throw new Error("Unsafe artifact resource path " + JSON.stringify(resourcePath) + ".")
  }
  const segments = resourcePath.split("/")
  if (
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    path.posix.normalize(resourcePath) !== resourcePath ||
    resourcePath === MANIFEST_FILE
  ) {
    throw new Error("Unsafe artifact resource path " + JSON.stringify(resourcePath) + ".")
  }
  return resourcePath
}

const listResourcePaths = (distDirectory) => {
  assertDirectory(distDirectory, "Artifact dist root")
  const resources = []
  const visit = (directory, prefix) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )
    for (const entry of entries) {
      const relativePath = prefix ? prefix + "/" + entry.name : entry.name
      const absolutePath = path.join(directory, entry.name)
      if (relativePath === MANIFEST_FILE) continue
      assertResourcePath(relativePath)
      if (entry.isSymbolicLink()) {
        throw new Error("Artifact resource " + relativePath + " must not be a symlink.")
      }
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath)
      } else if (entry.isFile()) {
        resources.push(relativePath)
      } else {
        throw new Error("Artifact resource " + relativePath + " is not a regular file.")
      }
    }
  }
  visit(distDirectory, "")
  return resources.sort()
}

const resourceRecord = (distDirectory, resourcePath) => {
  assertResourcePath(resourcePath)
  const absolutePath = path.join(distDirectory, ...resourcePath.split("/"))
  const metadata = assertRegularFile(
    absolutePath,
    "Artifact resource " + resourcePath,
  )
  const contents = readFileSync(absolutePath)
  if (metadata.size !== contents.byteLength) {
    throw new Error("Artifact resource " + resourcePath + " changed while read.")
  }
  return {
    path: resourcePath,
    size: contents.byteLength,
    sha256: hash("sha256", contents, "hex"),
  }
}

const calculateResourcesSha256 = (resources) =>
  hash(
    "sha256",
    resources
      .map(
        (resource) =>
          resource.path +
          "\0" +
          resource.size +
          "\0" +
          resource.sha256 +
          "\n",
      )
      .join(""),
    "hex",
  )

const verifyTarball = (config, packageName, tarballPath) => {
  validateConfig(config)
  const selected = selectFrontend(config, packageName)
  const absolutePath = path.resolve(tarballPath)
  assertRegularFile(absolutePath, "Downloaded npm tarball")
  const contents = readFileSync(absolutePath)
  const actualShasum = hash("sha1", contents, "hex")
  const actualIntegrity = "sha512-" + hash("sha512", contents, "base64")
  if (actualShasum !== selected.identity.npmShasum) {
    throw new Error(
      "Downloaded npm tarball SHA-1 " +
        actualShasum +
        " does not match the committed identity.",
    )
  }
  if (actualIntegrity !== selected.identity.npmIntegrity) {
    throw new Error(
      "Downloaded npm tarball integrity does not match the committed identity.",
    )
  }
  return {
    packageName: selected.identity.packageName,
    packageVersion: selected.identity.packageVersion,
    npmShasum: actualShasum,
    npmIntegrity: actualIntegrity,
  }
}

const readCanonicalManifest = (manifestPath) => {
  assertRegularFile(manifestPath, "Universal artifact manifest")
  const source = readFileSync(manifestPath, "utf8")
  let manifest
  try {
    manifest = JSON.parse(source)
  } catch (error) {
    throw new Error(
      "Universal artifact manifest is not valid JSON: " +
        (error instanceof Error ? error.message : String(error)),
    )
  }
  if (source !== JSON.stringify(manifest, null, 2) + "\n") {
    throw new Error("Universal artifact manifest is not canonical JSON.")
  }
  return { manifest, source }
}

const verifyLotusNextManifest = (packageDirectory, expected) => {
  const distDirectory = path.join(packageDirectory, "dist")
  assertDirectory(distDirectory, "Lotus Next dist root")
  const manifestPath = path.join(distDirectory, MANIFEST_FILE)
  const { manifest, source } = readCanonicalManifest(manifestPath)
  const actualManifestSha256 = hash("sha256", source, "hex")
  if (actualManifestSha256 !== expected.manifestSha256) {
    throw new Error(
      "Universal artifact manifest SHA-256 does not match the committed identity.",
    )
  }
  assertExactKeys(
    manifest,
    [
      "schemaVersion",
      "packageName",
      "packageVersion",
      "sourceRevision",
      "sourceDirty",
      "entrypoint",
      "resourcesSha256",
      "resources",
    ],
    "Universal artifact manifest",
  )
  const expectedIdentity = {
    schemaVersion: expected.manifestSchemaVersion,
    packageName: expected.packageName,
    packageVersion: expected.packageVersion,
    sourceRevision: expected.sourceRevision,
    sourceDirty: expected.sourceDirty,
    entrypoint: expected.entrypoint,
    resourcesSha256: expected.resourcesSha256,
  }
  for (const [key, expectedValue] of Object.entries(expectedIdentity)) {
    if (manifest[key] !== expectedValue) {
      throw new Error(
        "Universal artifact manifest " +
          key +
          " does not match the committed identity.",
      )
    }
  }
  if (!Array.isArray(manifest.resources) || manifest.resources.length === 0) {
    throw new Error("Universal artifact manifest resources must be non-empty.")
  }
  let previousPath
  for (const [index, resource] of manifest.resources.entries()) {
    assertExactKeys(
      resource,
      ["path", "size", "sha256"],
      "Universal artifact resource " + index,
    )
    assertResourcePath(resource.path)
    if (previousPath !== undefined && resource.path <= previousPath) {
      throw new Error("Universal artifact resources must be unique and sorted.")
    }
    if (!Number.isSafeInteger(resource.size) || resource.size < 0) {
      throw new Error("Artifact resource " + resource.path + " has an invalid size.")
    }
    assertDigest(
      resource.sha256,
      sha256Pattern,
      "Artifact resource " + resource.path + " SHA-256",
    )
    previousPath = resource.path
  }
  if (!manifest.resources.some((resource) => resource.path === manifest.entrypoint)) {
    throw new Error("Universal artifact manifest does not contain its entrypoint.")
  }
  if (calculateResourcesSha256(manifest.resources) !== expected.resourcesSha256) {
    throw new Error("Universal artifact combined resource digest is invalid.")
  }

  const actualPaths = listResourcePaths(distDirectory)
  const declaredPaths = manifest.resources.map((resource) => resource.path)
  if (
    actualPaths.length !== declaredPaths.length ||
    actualPaths.some((resourcePath, index) => resourcePath !== declaredPaths[index])
  ) {
    throw new Error("Universal artifact resource inventory does not match the package.")
  }
  for (const [index, resourcePath] of actualPaths.entries()) {
    const actual = resourceRecord(distDirectory, resourcePath)
    const declared = manifest.resources[index]
    if (actual.size !== declared.size || actual.sha256 !== declared.sha256) {
      throw new Error(
        "Artifact resource " + resourcePath + " does not match its manifest.",
      )
    }
  }
  return {
    manifestSha256: actualManifestSha256,
    resourcesSha256: expected.resourcesSha256,
    resourceCount: manifest.resources.length,
  }
}

const verifyPackageArtifact = (config, packageName, packageDirectory) => {
  validateConfig(config)
  const selected = selectFrontend(config, packageName)
  const absoluteDirectory = path.resolve(packageDirectory)
  assertDirectory(absoluteDirectory, "Extracted npm package")
  const packageJsonPath = path.join(absoluteDirectory, "package.json")
  assertRegularFile(packageJsonPath, "Extracted package.json")
  let packageJson
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"))
  } catch (error) {
    throw new Error(
      "Extracted package.json is invalid: " +
        (error instanceof Error ? error.message : String(error)),
    )
  }
  if (
    packageJson.name !== selected.identity.packageName ||
    packageJson.version !== selected.identity.packageVersion
  ) {
    throw new Error("Extracted package identity does not match the committed selection.")
  }

  if (selected.selection === "lotus-next") {
    return {
      selection: selected.selection,
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      ...verifyLotusNextManifest(absoluteDirectory, selected.identity),
    }
  }

  const legacyEntrypoint = path.join(absoluteDirectory, "dist", "index.html")
  assertRegularFile(legacyEntrypoint, "Legacy rollback entrypoint")
  return {
    selection: selected.selection,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
  }
}

const parseArguments = (rawArguments) => {
  const values = new Map()
  if (rawArguments.length % 2 !== 0) {
    throw new Error("Every command option must have a value.")
  }
  for (let index = 0; index < rawArguments.length; index += 2) {
    const name = rawArguments[index]
    const value = rawArguments[index + 1]
    if (!name.startsWith("--") || values.has(name)) {
      throw new Error("Invalid or duplicate command option " + JSON.stringify(name) + ".")
    }
    values.set(name, value)
  }
  return values
}

const requireOption = (arguments_, name) => {
  if (!arguments_.has(name) || arguments_.get(name) === "") {
    throw new Error("Missing required option " + name + ".")
  }
  return arguments_.get(name)
}

const rejectUnknownOptions = (arguments_, allowed) => {
  for (const name of arguments_.keys()) {
    if (!allowed.has(name)) {
      throw new Error("Unsupported command option " + name + ".")
    }
  }
}

const runCli = () => {
  const [command, ...rawArguments] = process.argv.slice(2)
  const arguments_ = parseArguments(rawArguments)

  if (command === "validate") {
    rejectUnknownOptions(arguments_, new Set(["--config"]))
    const config = readConfig(requireOption(arguments_, "--config"))
    process.stdout.write(
      "Validated release-train config schema " + config.schemaVersion + ".\n",
    )
    return
  }

  if (command === "resolve") {
    rejectUnknownOptions(
      arguments_,
      new Set([
        "--config",
        "--targets",
        "--frontend-package",
        "--release-version",
        "--bamboo-version",
        "--bodhi-version",
        "--resume",
        "--github-output",
      ]),
    )
    const config = readConfig(requireOption(arguments_, "--config"))
    const outputs = resolvePolicy(config, {
      targets: arguments_.get("--targets"),
      frontendPackage: arguments_.get("--frontend-package"),
      releaseVersion: arguments_.get("--release-version"),
      bambooVersion: arguments_.get("--bamboo-version"),
      bodhiVersion: arguments_.get("--bodhi-version"),
      resume: arguments_.get("--resume"),
    })
    if (arguments_.has("--github-output")) {
      writeGitHubOutputs(requireOption(arguments_, "--github-output"), outputs)
    }
    process.stdout.write(JSON.stringify(outputs, null, 2) + "\n")
    return
  }

  if (command === "verify-tarball") {
    rejectUnknownOptions(
      arguments_,
      new Set(["--config", "--frontend-package", "--tarball"]),
    )
    const config = readConfig(requireOption(arguments_, "--config"))
    const result = verifyTarball(
      config,
      requireOption(arguments_, "--frontend-package"),
      requireOption(arguments_, "--tarball"),
    )
    process.stdout.write(
      "Verified npm tarball for " +
        result.packageName +
        "@" +
        result.packageVersion +
        " (" +
        result.npmShasum +
        ").\n",
    )
    return
  }

  if (command === "verify-package") {
    rejectUnknownOptions(
      arguments_,
      new Set(["--config", "--frontend-package", "--package-dir"]),
    )
    const config = readConfig(requireOption(arguments_, "--config"))
    const result = verifyPackageArtifact(
      config,
      requireOption(arguments_, "--frontend-package"),
      requireOption(arguments_, "--package-dir"),
    )
    const resourceSummary =
      result.resourceCount === undefined ? "" : ", " + result.resourceCount + " resources"
    process.stdout.write(
      "Verified extracted " +
        result.packageName +
        "@" +
        result.packageVersion +
        " (" +
        result.selection +
        resourceSummary +
        ").\n",
    )
    return
  }

  throw new Error(
    "Usage: release-train-policy.cjs validate|resolve|verify-tarball|verify-package [options]",
  )
}

module.exports = {
  CONFIG_SCHEMA_VERSION,
  LEGACY_LOTUS_PACKAGE,
  LOTUS_NEXT_PACKAGE,
  calculateResourcesSha256,
  formatGitHubOutputs,
  listResourcePaths,
  readConfig,
  resourceRecord,
  resolvePolicy,
  selectFrontend,
  validateConfig,
  verifyPackageArtifact,
  verifyTarball,
}

if (require.main === module) {
  try {
    runCli()
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.message : String(error)) + "\n",
    )
    process.exitCode = 1
  }
}
