"use strict"

const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const { createHash } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const version = "2026.10.10"
const names = ["bamboo-agent", "bamboo-domain", "bamboo-server"]
const paths = { "bamboo-agent": "", "bamboo-domain": "crates/core/bamboo-domain", "bamboo-server": "crates/app/bamboo-server" }
const edges = { "bamboo-agent": ["bamboo-domain", "bamboo-server"], "bamboo-domain": [], "bamboo-server": ["bamboo-domain"] }
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")
const json = value => JSON.stringify(value, null, 2) + "\n"
const clone = value => JSON.parse(JSON.stringify(value))
const python = process.env.PYTHON || ["/opt/homebrew/bin/python3.12", "/opt/homebrew/bin/python3.14", "python3"].find(p => !p.includes("/") || fs.existsSync(p))

// Real standard-format archives, independent of the verifier's Python parser.
// No archive is extracted and no source, build script or Cargo command executes.
function archive(format, entries) {
  return execFileSync(python, ["-c", `
import base64,io,json,sys,tarfile,zipfile
data=json.load(sys.stdin); output=io.BytesIO()
if data['format']=='zip':
 with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED) as archive:
  for item in data['entries']: archive.writestr(item['name'],base64.b64decode(item['bytes']))
else:
 with tarfile.open(fileobj=output,mode='w:gz') as archive:
  for item in data['entries']:
   payload=base64.b64decode(item['bytes']); member=tarfile.TarInfo(item['name']); member.mode=0o644
   if item.get('link'): member.type=tarfile.SYMTYPE; member.linkname=item['link']; archive.addfile(member)
   else: member.size=len(payload); archive.addfile(member,io.BytesIO(payload))
sys.stdout.buffer.write(output.getvalue())
`], { input: JSON.stringify({ format, entries: entries.map(e => ({ ...e, bytes: Buffer.from(e.bytes).toString("base64") })) }), maxBuffer: 8 * 1024 * 1024 })
}

function bundle(payload, overrides = {}) {
  const hash = createHash("sha256")
  for (const item of [...payload].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    hash.update(item.name).update("\0").update(item.bytes).update("\0")
  }
  const wrapper = Buffer.from(json({ schema_version: 1, frontend_name: "lotus-next", frontend_version: "2026.10.8", bundle_hash: "sha256:" + hash.digest("hex"), built_at: "2026-10-09T04:24:30.756Z", entry: "index.html", ...overrides }))
  return { wrapper, zip: archive("zip", [...payload, { name: "frontend-manifest.json", bytes: wrapper }]) }
}

function fixture(t, exact = false, indirectKind, legacy = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zenith-publication-test-")))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sourceDir = path.join(root, "source")
  const frontendPackageDir = path.join(root, "frontend")
  const write = (base, relative, bytes) => {
    const filename = path.join(base, relative)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, bytes)
  }
  const config = clone(JSON.parse(fs.readFileSync(path.join(__dirname, "../.github/release-train.config.json"))))
  const resources = [
    { name: "assets/app.js", bytes: Buffer.from("export const ready = true;\n") },
    { name: "index.html", bytes: Buffer.from("<main>accepted frontend</main>\n") },
  ]
  const records = resources.map(r => ({ path: r.name, size: r.bytes.length, sha256: sha256(r.bytes) }))
  const resourcesSha256 = sha256(records.map(r => `${r.path}\0${r.size}\0${r.sha256}\n`).join(""))
  Object.assign(config.frontend.lotusNext, { resourcesSha256 })
  const identity = config.frontend.lotusNext
  const manifest = Buffer.from(json({ schemaVersion: 1, packageName: identity.packageName, packageVersion: identity.packageVersion, sourceRevision: identity.sourceRevision, sourceDirty: false, entrypoint: "index.html", resourcesSha256, resources: records }))
  identity.manifestSha256 = sha256(manifest)
  const nextPayload = [...resources, { name: "lotus-next-manifest.json", bytes: manifest }]
  const payload = legacy ? resources : nextPayload
  const frontendPackage = legacy ? config.frontend.legacyRollback.packageName : identity.packageName
  const frontendVersion = legacy ? config.frontend.legacyRollback.packageVersion : identity.packageVersion
  for (const item of payload) write(frontendPackageDir, "dist/" + item.name, item.bytes)
  write(frontendPackageDir, "package.json", json({ name: frontendPackage, version: frontendVersion }))
  const acceptedFrontend = bundle(nextPayload)
  const frontend = legacy ? bundle(payload, { frontend_name: "lotus", frontend_version: frontendVersion }) : acceptedFrontend
  const manifests = {}
  const fixtureEdges = indirectKind ? { ...edges, "bamboo-agent": ["bamboo-server"] } : edges
  const section = name => name !== "bamboo-server" ? "dependencies"
    : indirectKind === "build" ? "target.'cfg(windows)'.build-dependencies"
      : indirectKind === "dev" ? "dev-dependencies" : "dependencies"
  const optional = name => name === "bamboo-server" && indirectKind === "optional"
  for (const name of names) {
    const prefix = paths[name] ? paths[name] + "/" : ""
    const workspace = name === "bamboo-agent" ? '[workspace]\nmembers = ["crates/core/bamboo-domain", "crates/app/bamboo-server"]\nresolver = "2"\n\n[workspace.package]\nversion = "0.0.0"\n\n' : ""
    const deps = fixtureEdges[name].map(dep => `${dep} = { path = "${path.posix.relative(paths[name] || ".", paths[dep])}"${optional(name) ? ", optional = true" : ""} }`).join("\n") + (name === "bamboo-agent" ? '\nserde = { version = "1", default-features = false }' : "")
    manifests[name] = workspace + `[package]\nname = "${name}"\nversion.workspace = true\nedition = "2021"\nlicense = "MIT"\n` + (deps ? `\n[${section(name)}]\n` + deps + "\n" : "") + (optional(name) ? '\n[features]\ndomain = ["dep:bamboo-domain"]\n' : "")
    write(sourceDir, prefix + "Cargo.toml", manifests[name])
    write(sourceDir, prefix + "src/lib.rs", `pub fn ${name.replaceAll("-", "_")}() -> bool { true }\n`)
  }
  write(sourceDir, "build.rs", "fn main() {}\n")
  write(sourceDir, "README.md", "Independent publication fixture\n")
  const registry = "registry+https://github.com/rust-lang/crates.io-index"
  const externalLock = `\n[[package]]\nname = "serde"\nversion = "1.0.228"\nsource = "${registry}"\nchecksum = "${"a".repeat(64)}"\n`
  write(sourceDir, "Cargo.lock", "version = 4\n" + names.map(name => `\n[[package]]\nname = "${name}"\nversion = "0.0.0"\n`).join("") + externalLock)
  write(sourceDir, "scripts/frontend-package-lock.json", json({ schemaVersion: 1, packageName: identity.packageName, packageVersion: identity.packageVersion, sourceRevision: identity.sourceRevision, sourceDirty: false, entrypoint: identity.entrypoint, resourcesSha256, manifestSha256: identity.manifestSha256 }))
  write(sourceDir, "crates/app/bamboo-server/frontend_package/frontend-manifest.json", acceptedFrontend.wrapper)
  write(sourceDir, "crates/app/bamboo-server/frontend_package/lotus-frontend.zip", acceptedFrontend.zip)
  if (exact) write(sourceDir, "scripts/crate-release-lock.py", '# accepted exact stamping contract\nline = f\'version = "={target_version}"\'\n')
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: sourceDir, encoding: "utf8" }).trim()
  git("init", "-q")
  git("add", ".")
  git("commit", "-qm", "accepted independent source")
  const sourceRevision = git("rev-parse", "HEAD")
  git("tag", "-a", "bamboo-source-fixture", "-m", "accepted frozen source")
  Object.assign(config.sources.bamboo, { revision: sourceRevision, ref: "refs/tags/bamboo-source-fixture", tagObjectSha: git("rev-parse", "refs/tags/bamboo-source-fixture") })
  const requirement = exact ? "=" + version : version
  const registryRequirement = exact ? requirement : "^" + version
  const entries = new Map()
  const archives = new Map()
  const registryDeps = new Map()
  for (const name of names) {
    const sourcePrefix = paths[name] ? paths[name] + "/" : ""
    let original = manifests[name].replace('version = "0.0.0"', `version = "${version}"`)
    original = original.split("\n").map(line => line.includes("path = ") ? line.replace(" }", `, version = "${requirement}" }`) : line).join("\n")
    const normalized = `[package]\nname = "${name}"\nversion = "${version}"\nedition = "2021"\nlicense = "MIT"\nbuild = ${name === "bamboo-agent" ? '"build.rs"' : "false"}\nautolib = false\nautobins = false\nautoexamples = false\nautotests = false\nautobenches = false\n\n[lib]\nname = "${name.replaceAll("-", "_")}"\npath = "src/lib.rs"\n` + fixtureEdges[name].map(dep => `\n[${section(name)}.${dep}]\nversion = "${requirement}"\n${optional(name) ? "optional = true\n" : ""}`).join("") + (name === "bamboo-agent" ? '\n[dependencies.serde]\nversion = "1"\ndefault-features = false\n' : "") + (optional(name) ? '\n[features]\ndomain = ["dep:bamboo-domain"]\n' : "")
    const files = [
      { name: ".cargo_vcs_info.json", bytes: Buffer.from(json({ git: { sha1: sourceRevision, dirty: true }, path_in_vcs: paths[name] })) },
      { name: "Cargo.toml", bytes: Buffer.from(normalized) },
      { name: "Cargo.toml.orig", bytes: Buffer.from(original) },
      { name: "Cargo.lock", bytes: Buffer.alloc(0) },
      { name: "src/lib.rs", bytes: fs.readFileSync(path.join(sourceDir, sourcePrefix, "src/lib.rs")) },
    ]
    if (name === "bamboo-agent") files.push({ name: "build.rs", bytes: fs.readFileSync(path.join(sourceDir, "build.rs")) }, { name: "README.md", bytes: fs.readFileSync(path.join(sourceDir, "README.md")) })
    if (name === "bamboo-server") files.push({ name: "frontend_package/frontend-manifest.json", bytes: frontend.wrapper }, { name: "frontend_package/lotus-frontend.zip", bytes: frontend.zip })
    entries.set(name, files)
    registryDeps.set(name, fixtureEdges[name].map(dep => ({ crate_id: dep, req: registryRequirement, kind: name === "bamboo-server" && ["build", "dev"].includes(indirectKind) ? indirectKind : "normal", target: name === "bamboo-server" && indirectKind === "build" ? "cfg(windows)" : null, optional: optional(name), explicit_name: null, default_features: true, features: [] })))
    if (name === "bamboo-agent") registryDeps.get(name).push({ crate_id: "serde", req: "^1", kind: "normal", target: null, optional: false, explicit_name: null, default_features: false, features: [] })
  }
  const closure = name => [...new Set([name, ...fixtureEdges[name].flatMap(closure)])]
  const refreshLock = name => {
    const lock = "version = 4\n" + closure(name).map(dep => `\n[[package]]\nname = "${dep}"\nversion = "${version}"\n` + (dep === name ? "" : `source = "${registry}"\nchecksum = "${sha256(archives.get(dep))}"\n`)).join("") + (name === "bamboo-agent" ? externalLock : "")
    entries.get(name).find(e => e.name === "Cargo.lock").bytes = Buffer.from(lock)
  }
  const rebuildOne = name => archives.set(name, archive("tar", entries.get(name).map(e => ({ ...e, name: e.rawName || `${name}-${version}/${e.name}` }))))
  const order = ["bamboo-domain", "bamboo-server", "bamboo-agent"]
  for (const name of order) { refreshLock(name); rebuildOne(name) }
  const rebuild = name => {
    rebuildOne(name)
    // Keep dependent package locks honest when mutating a child's real bytes;
    // rejection must come from that child's targeted defect, not stale hashes.
    for (const parent of order.filter(p => p !== name && closure(p).includes(name))) {
      refreshLock(parent)
      rebuildOne(parent)
    }
  }
  const absent = new Set()
  const overrides = new Map()
  const calls = []
  const response = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) })
  const fetchImpl = async url => {
    const address = new URL(url)
    calls.push(address.href)
    if (overrides.has(address.pathname)) {
      const value = overrides.get(address.pathname)
      if (value instanceof Error) throw value
      return value
    }
    const match = /^\/api\/v1\/crates\/([^/]+)\/([^/]+)(\/dependencies)?$/.exec(address.pathname)
    if (address.hostname === "crates.io" && match) {
      const [, name, requested, dependencies] = match
      assert.ok(names.includes(name), "unexpected registry crate " + name)
      assert.equal(requested, version)
      if (absent.has(name)) return response(404, { errors: [{ detail: "not found" }] })
      if (dependencies) return response(200, { dependencies: registryDeps.get(name) })
      const bytes = archives.get(name)
      return response(200, { version: { crate: name, num: version, checksum: sha256(bytes), crate_size: bytes.length, yanked: false, dl_path: `/api/v1/crates/${name}/${version}/download` } })
    }
    const download = /^\/crates\/([^/]+)\/\1-([^/]+)\.crate$/.exec(address.pathname)
    assert.equal(address.hostname, "static.crates.io", "unexpected external host")
    assert.ok(download && names.includes(download[1]), "unexpected archive URL " + address.href)
    assert.equal(download[2], version)
    return response(200, archives.get(download[1]))
  }
  const inspect = extra => require("./verify-bamboo-publication.cjs").inspectPublication({ config, version, frontendPackage, frontendPackageDir, sourceDir, fetchImpl, pythonCommand: python, ...extra })
  const change = (name, filename, bytes) => {
    const entry = entries.get(name).find(e => e.name === filename)
    assert.ok(entry, "fixture member missing " + filename)
    entry.bytes = Buffer.from(bytes)
    rebuild(name)
  }
  const changeFrontend = (items, wrapper = {}) => {
    const next = bundle(items, wrapper)
    change("bamboo-server", "frontend_package/frontend-manifest.json", next.wrapper)
    change("bamboo-server", "frontend_package/lotus-frontend.zip", next.zip)
  }
  return { root, sourceDir, frontendPackageDir, config, sourceRevision, entries, archives, registryDeps, absent, overrides, calls, response, inspect, change, changeFrontend, payload, rebuild }
}

for (const exact of [false, true]) {
  test(`verifies complete real source/archive/frontend closure with ${exact ? "exact" : "legacy caret"} internal stamping`, async t => {
    const f = fixture(t, exact)
    const result = await f.inspect()
    assert.equal(result.state, "verified")
    assert.equal(result.crateCount, 3)
    assert.equal(result.sourceRevision, f.sourceRevision)
    assert.equal(f.calls.filter(url => url.includes("static.crates.io/")).length, 3)
  })
}

for (const kind of ["build", "dev", "optional"]) {
  test(`verifies a child reachable only through ${kind === "build" ? "target-specific build" : kind} dependencies`, async t => {
    const f = fixture(t, false, kind)
    const result = await f.inspect()
    assert.equal(result.state, "verified")
    assert.equal(result.crateCount, 3)
    assert.ok(f.calls.some(url => url === `https://static.crates.io/crates/bamboo-domain/bamboo-domain-${version}.crate`))
  })
}

test("verifies the fixed legacy rollback payload while accepted source remains locked to Lotus Next", async t => {
  const f = fixture(t, false, undefined, true)
  const result = await f.inspect()
  assert.equal(result.state, "verified")
  assert.equal(result.frontendPackage, "@bigduu/lotus")
  assert.equal(result.frontendVersion, "2026.8.28")
  assert.equal(fs.existsSync(path.join(f.frontendPackageDir, "dist/lotus-next-manifest.json")), false)
})

test("only a uniformly absent closure permits a fresh dispatch without archive downloads", async t => {
  const f = fixture(t)
  names.forEach(name => f.absent.add(name))
  assert.equal((await f.inspect()).state, "absent")
  assert.equal(f.calls.filter(url => url.includes("static.crates.io/")).length, 0)
})

for (const published of [["bamboo-agent"], ["bamboo-domain"], ["bamboo-domain", "bamboo-server"]]) {
  test(`rejects partial publication even when ${published.join(" and ")} already exists`, async t => {
    const f = fixture(t)
    names.filter(name => !published.includes(name)).forEach(name => f.absent.add(name))
    await assert.rejects(f.inspect(), /partial|incomplete/i)
  })
}

for (const status of [401, 403, 429, 500, 503]) {
  test(`registry HTTP ${status} is an error rather than evidence of absence`, async t => {
    const f = fixture(t)
    names.forEach(name => f.absent.add(name))
    f.overrides.set(`/api/v1/crates/bamboo-domain/${version}`, f.response(status, {}))
    await assert.rejects(f.inspect())
  })
}

test("registry transport and malformed JSON errors cannot authorize a fresh publication", async t => {
  for (const failure of [new Error("offline fixture"), { status: 200, ok: true, json: async () => { throw new SyntaxError("invalid JSON") } }, { status: 200, ok: true, json: async () => ({ version: {} }) }]) {
    const f = fixture(t)
    names.forEach(name => f.absent.add(name))
    f.overrides.set(`/api/v1/crates/bamboo-domain/${version}`, failure)
    await assert.rejects(f.inspect())
  }
})

test("registry checksum and yanked status are verified against the actual archive", async t => {
  for (const mutation of [{ checksum: "f".repeat(64) }, { yanked: true }, { num: "2026.10.11" }, { crate: "another-crate" }]) {
    const f = fixture(t)
    const bytes = f.archives.get("bamboo-domain")
    f.overrides.set(`/api/v1/crates/bamboo-domain/${version}`, f.response(200, { version: { crate: "bamboo-domain", num: version, checksum: sha256(bytes), crate_size: bytes.length, yanked: false, ...mutation } }))
    await assert.rejects(f.inspect())
  }
})

test("each package must have the accepted Git revision and workspace path", async t => {
  for (const mutation of [{ git: { sha1: "b".repeat(40), dirty: true }, path_in_vcs: paths["bamboo-domain"] }, { git: { sha1: null, dirty: true }, path_in_vcs: paths["bamboo-domain"] }, { git: { dirty: true }, path_in_vcs: "wrong/path" }]) {
    const f = fixture(t)
    if (!mutation.git.sha1) mutation.git.sha1 = mutation.git.sha1 === null ? "" : f.sourceRevision
    f.change("bamboo-domain", ".cargo_vcs_info.json", json(mutation))
    await assert.rejects(f.inspect())
  }
})

test("a recomputed registry checksum cannot hide changed or missing tracked runtime source", async t => {
  for (const filename of ["src/lib.rs", "build.rs"]) {
    const f = fixture(t)
    f.change("bamboo-agent", filename, "// a different implementation\n")
    await assert.rejects(f.inspect())
  }
  for (const [name, filename] of [["bamboo-domain", "src/lib.rs"], ["bamboo-agent", "build.rs"]]) {
    const f = fixture(t)
    f.entries.set(name, f.entries.get(name).filter(e => e.name !== filename))
    f.rebuild(name)
    await assert.rejects(f.inspect())
  }
})

test("original manifests allow only the accepted publication stamp", async t => {
  for (const filename of ["Cargo.toml.orig", "Cargo.toml"]) {
    const f = fixture(t)
    const entry = f.entries.get("bamboo-agent").find(e => e.name === filename)
    f.change("bamboo-agent", filename, entry.bytes.toString().replace("bamboo-domain", "unaccepted-domain"))
    await assert.rejects(f.inspect())
  }
})

test("generated and original manifests cannot change accepted package fields or external dependencies", async t => {
  for (const filename of ["Cargo.toml.orig", "Cargo.toml"]) {
    for (const [before, after] of [['edition = "2021"', 'edition = "2018"'], ['license = "MIT"', 'license = "GPL-3.0"'], ['version = "1"', 'version = "2"']]) {
      const f = fixture(t)
      const entry = f.entries.get("bamboo-agent").find(e => e.name === filename)
      f.change("bamboo-agent", filename, entry.bytes.toString().replace(before, after))
      await assert.rejects(f.inspect())
    }
  }
})

test("normalization cannot inject patches, a different implicit library or arbitrary auto-discovery settings", async t => {
  for (const mutate of [
    text => text + '\n[patch.crates-io]\nserde = { path = "unaccepted" }\n',
    text => text.replace('[lib]\n', '[lib]\nproc-macro = true\n'),
    text => text.replace('[lib]\n', '[lib]\ncrate-type = ["cdylib"]\n'),
    text => text.replace('name = "bamboo_agent"', 'name = "other_library"'),
    text => text.replace('[lib]\nname = "bamboo_agent"\npath = "src/lib.rs"\n', ""),
    text => text.replace('build = "build.rs"', "build = false"),
    ...["autolib", "autobins", "autoexamples", "autotests", "autobenches"].map(key => text => text.replace(`${key} = false`, `${key} = true`)),
  ]) {
    const f = fixture(t)
    const original = f.entries.get("bamboo-agent").find(e => e.name === "Cargo.toml").bytes.toString()
    f.change("bamboo-agent", "Cargo.toml", mutate(original))
    await assert.rejects(f.inspect())
  }
})

test("published locks retain accepted external coordinates and exact internal registry versions and checksums", async t => {
  for (const mutate of [
    text => text.replace(`version = "${version}"`, 'version = "2026.10.9"'),
    text => text.replace(/checksum = "[a-f0-9]{64}"/, `checksum = "${"b".repeat(64)}"`),
    text => text.replace('version = "1.0.228"', 'version = "1.0.229"'),
    text => text + '\n[[package]]\nname = "unaccepted"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
  ]) {
    const f = fixture(t)
    const original = f.entries.get("bamboo-agent").find(e => e.name === "Cargo.lock").bytes.toString()
    f.change("bamboo-agent", "Cargo.lock", mutate(original))
    await assert.rejects(f.inspect())
  }
  const missing = fixture(t)
  missing.entries.set("bamboo-domain", missing.entries.get("bamboo-domain").filter(e => e.name !== "Cargo.lock"))
  missing.rebuild("bamboo-domain")
  await assert.rejects(missing.inspect())
})

test("internal requirements must follow the accepted source's caret or exact stamp", async t => {
  for (const exact of [false, true]) {
    const f = fixture(t, exact)
    const desired = exact ? "^" + version : "=" + version
    const entry = f.entries.get("bamboo-server").find(e => e.name === "Cargo.toml")
    f.change("bamboo-server", "Cargo.toml", entry.bytes.toString().replace(`[dependencies.bamboo-domain]\nversion = "${exact ? "=" + version : version}"`, `[dependencies.bamboo-domain]\nversion = "${desired}"`))
    f.registryDeps.get("bamboo-server")[0].req = desired
    await assert.rejects(f.inspect())
  }
})

test("registry and actual manifest internal edges must agree in all identity fields", async t => {
  for (const mutation of [{ req: "^2026.10.9" }, { kind: "build" }, { target: "cfg(windows)" }, { optional: true }, { explicit_name: "renamed-domain" }]) {
    const f = fixture(t)
    Object.assign(f.registryDeps.get("bamboo-server")[0], mutation)
    await assert.rejects(f.inspect())
  }
})

test("full embedded frontend bytes, not only its version labels, must equal the accepted npm payload", async t => {
  for (const mutate of [
    items => items.map(e => e.name === "index.html" ? { ...e, bytes: Buffer.from("<main>other build</main>\n") } : e),
    items => items.filter(e => e.name !== "assets/app.js"),
    items => [...items, { name: "unlisted.js", bytes: Buffer.from("unaccepted") }],
    items => items.map(e => e.name === "lotus-next-manifest.json" ? { ...e, bytes: Buffer.from(e.bytes.toString().replace('"sourceDirty": false', '"sourceDirty": true')) } : e),
  ]) {
    const f = fixture(t)
    f.changeFrontend(mutate(f.payload))
    await assert.rejects(f.inspect())
  }
})

test("frontend wrapper identity and ZIP-sidecar equality are both enforced", async t => {
  const wrongVersion = fixture(t)
  wrongVersion.changeFrontend(wrongVersion.payload, { frontend_version: "2026.10.7" })
  await assert.rejects(wrongVersion.inspect())
  const wrongSidecar = fixture(t)
  wrongSidecar.change("bamboo-server", "frontend_package/frontend-manifest.json", json({ frontend_version: "2026.10.8" }))
  await assert.rejects(wrongSidecar.inspect())
})

test("tar duplicate paths, parent traversal, absolute paths and links are refused", async t => {
  for (const extra of [
    { name: "src/lib.rs", bytes: Buffer.from("duplicate") },
    { name: "../escaped.rs", bytes: Buffer.from("escape") },
    { name: "absolute", rawName: "/escaped.rs", bytes: Buffer.from("escape") },
    { name: "src/link.rs", link: "../../outside", bytes: Buffer.alloc(0) },
  ]) {
    const f = fixture(t)
    f.entries.get("bamboo-domain").push(extra)
    f.rebuild("bamboo-domain")
    await assert.rejects(f.inspect())
    assert.equal(fs.existsSync(path.join(f.root, "escaped.rs")), false)
  }
})

test("ZIP duplicates and escaping paths are refused even with consistent wrapper and registry hashes", async t => {
  for (const extra of [{ name: "index.html", bytes: Buffer.from("duplicate") }, { name: "../escaped.js", bytes: Buffer.from("escape") }, { name: "/escaped.js", bytes: Buffer.from("escape") }]) {
    const f = fixture(t)
    f.changeFrontend([...f.payload, extra])
    await assert.rejects(f.inspect())
  }
})

test("the narrow historical npm documentation footprint cannot admit extra runtime code", async t => {
  const docs = fixture(t)
  docs.entries.get("bamboo-agent").push({ name: "node_modules/fixture/LICENSE", bytes: Buffer.from("MIT fixture license\n") }, { name: "node_modules/fixture/README.md", bytes: Buffer.from("fixture readme\n") })
  docs.rebuild("bamboo-agent")
  assert.equal((await docs.inspect()).state, "verified")
  for (const filename of ["node_modules/fixture/index.js", "node_modules/fixture/README.rs", "src/untracked.rs"]) {
    const code = fixture(t)
    code.entries.get("bamboo-agent").push({ name: filename, bytes: Buffer.from("unaccepted runtime code\n") })
    code.rebuild("bamboo-agent")
    await assert.rejects(code.inspect())
  }
})

test("source inspection rejects a moved HEAD or dirty checkout before accepting registry evidence", async t => {
  const dirty = fixture(t)
  fs.appendFileSync(path.join(dirty.sourceDir, "src/lib.rs"), "// changed after acceptance\n")
  await assert.rejects(dirty.inspect())
  const moved = fixture(t)
  moved.config.sources.bamboo.revision = "c".repeat(40)
  await assert.rejects(moved.inspect())
})
