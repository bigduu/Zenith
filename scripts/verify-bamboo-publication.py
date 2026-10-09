#!/usr/bin/env python3
"""Read fixed Git objects and inert archives. Never import or run source code."""
import copy
import datetime
import fnmatch
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile
import tomllib
import zipfile

KINDS = ("dependencies", "dev-dependencies", "build-dependencies")
MAX_CONTENT = 512 * 1024 * 1024


def check(condition, message):
    if not condition:
        raise ValueError(message)


def safe_path(value):
    check(isinstance(value, str) and value and "\\" not in value and "\0" not in value,
          "Invalid archive/source path")
    check(not value.startswith("/") and all(p not in ("", ".", "..") for p in value.split("/")),
          "Unsafe archive/source path: " + value)
    return value


def git(request, *args):
    env = {k: os.environ[k] for k in ("PATH", "SYSTEMROOT") if k in os.environ}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null", GIT_NO_REPLACE_OBJECTS="1")
    return subprocess.check_output(["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
                                    "-C", request["sourceDir"], *args], env=env)


def source_bytes(request, relative):
    return git(request, "show", request["sourceRevision"] + ":" + safe_path(relative))


def tables(manifest):
    yield None, manifest
    for target, table in manifest.get("target", {}).items():
        yield target, table


def dependencies(manifest, workspace):
    result = []
    for target, table in tables(manifest):
        for kind in KINDS:
            for alias, raw in table.get(kind, {}).items():
                spec = {"version": raw} if isinstance(raw, str) else copy.deepcopy(raw)
                check(isinstance(spec, dict), "Invalid dependency specification")
                if spec.pop("workspace", False):
                    inherited = workspace.get("dependencies", {}).get(alias)
                    check(inherited is not None, "Missing inherited dependency " + alias)
                    inherited = {"version": inherited} if isinstance(inherited, str) else copy.deepcopy(inherited)
                    features = inherited.get("features", []) + spec.get("features", [])
                    inherited.update(spec)
                    if features:
                        inherited["features"] = features
                    spec = inherited
                result.append({"name": spec.get("package", alias), "alias": alias,
                               "kind": kind, "target": target, "spec": spec})
    return result


def describe(request):
    check(re.fullmatch(r"[a-f0-9]{40}", request["sourceRevision"]), "Invalid source revision")
    tracked = {}
    for entry in git(request, "ls-tree", "-rz", request["sourceRevision"]).split(b"\0"):
        if not entry:
            continue
        meta, relative = entry.split(b"\t", 1)
        mode, kind, oid = meta.decode().split()
        relative = safe_path(relative.decode())
        if kind == "blob":
            tracked[relative] = (mode, oid)
    root = tomllib.loads(source_bytes(request, "Cargo.toml").decode())
    workspace = root.get("workspace", {})
    members = workspace.get("members", ["."])
    check(isinstance(members, list) and all(isinstance(m, str) for m in members), "Invalid workspace members")
    if "package" in root and "." not in members:
        members = [".", *members]
    manifests = {}
    manifest_paths = [p[:-11].rstrip("/") for p in tracked if p.endswith("/Cargo.toml")] + [""]
    excluded = workspace.get("exclude", [])
    for member in members:
        pattern = "" if member == "." else member.rstrip("/")
        matches = [p for p in manifest_paths if fnmatch.fnmatchcase(p, pattern)
                   and not any(fnmatch.fnmatchcase(p, e) for e in excluded)]
        check(matches, "Workspace member is absent from accepted tree: " + member)
        for relative in matches:
            filename = relative + "/Cargo.toml" if relative else "Cargo.toml"
            manifest = tomllib.loads(source_bytes(request, filename).decode())
            package = manifest.get("package", {})
            name = package.get("name")
            check(isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9_-]+", name), "Invalid source package name")
            check(name not in manifests, "Duplicate workspace package " + name)
            manifests[name] = {"name": name, "path": relative, "manifest": manifest}
    check("bamboo-agent" in manifests and "bamboo-server" in manifests, "Missing Bamboo release roots")
    closure = set()
    stack = ["bamboo-agent"]
    while stack:
        name = stack.pop()
        if name in closure:
            continue
        closure.add(name)
        package = manifests[name]["manifest"]["package"]
        check(package.get("publish", True) not in (False, []), "Non-published member in release closure")
        for dep in dependencies(manifests[name]["manifest"], workspace):
            if dep["name"] in manifests:
                stack.append(dep["name"])
    check("bamboo-server" in closure, "Bamboo closure does not include the embedded frontend")
    marker = "scripts/crate-release-lock.py"
    exact = marker in tracked and b'version = "={target_version}"' in source_bytes(request, marker)
    frontend = request["frontend"]
    if frontend["selection"] == "lotus-next":
        lock = json.loads(source_bytes(request, "scripts/frontend-package-lock.json"))
        for key in ("packageName", "packageVersion", "sourceRevision", "sourceDirty", "entrypoint",
                    "resourcesSha256", "manifestSha256"):
            check(lock.get(key) == frontend.get(key), "Accepted Bamboo frontend lock mismatch: " + key)
        check(lock.get("schemaVersion") == frontend["manifestSchemaVersion"], "Frontend schema mismatch")
    return root, tracked, manifests, sorted(closure), exact


def stamped(original, root, names, version, exact):
    result = copy.deepcopy(original)
    if "workspace" in result and "package" in result["workspace"]:
        result["workspace"]["package"]["version"] = version
    if isinstance(result["package"].get("version"), str):
        result["package"]["version"] = version
    for _, table in tables(result):
        for kind in KINDS:
            for alias, spec in table.get(kind, {}).items():
                if isinstance(spec, dict) and spec.get("package", alias) in names and "path" in spec:
                    spec["version"] = ("=" if exact else "") + version
    return result


def archive_files(filename, name, version):
    files, total, seen = {}, 0, set()
    prefix = name + "-" + version + "/"
    with tarfile.open(filename, "r:gz") as archive:
        for item in archive:
            check(item.name.startswith(prefix), "Wrong crate archive root for " + name)
            relative = item.name[len(prefix):].rstrip("/")
            if not relative and item.isdir():
                continue
            safe_path(relative)
            check(relative not in seen, "Duplicate crate archive path: " + relative)
            seen.add(relative)
            if item.isdir():
                continue
            check(item.isfile(), "Non-regular crate archive entry: " + relative)
            total += item.size
            check(total <= MAX_CONTENT and len(seen) <= 50000, "Crate archive exceeds verification limits")
            files[relative] = archive.extractfile(item).read()
    for required in ("Cargo.toml", "Cargo.toml.orig", ".cargo_vcs_info.json"):
        check(required in files, "Missing crate evidence: " + required)
    return files


def semantic_spec(spec):
    result = copy.deepcopy(spec)
    result.pop("path", None)
    result.pop("workspace", None)
    result.setdefault("optional", False)
    result.setdefault("default-features", True)
    result["features"] = sorted(set(result.get("features", [])))
    return result


def dependency_key(dep):
    return dep["target"] or "", dep["kind"], dep["alias"]


def packaged_path(filename, package):
    def matches(pattern):
        return fnmatch.fnmatchcase(filename, pattern) or fnmatch.fnmatchcase(filename, pattern.replace("**/", ""))
    return ("include" not in package or any(matches(p) for p in package["include"])) and not any(matches(p) for p in package.get("exclude", []))


def expected_targets(kind, manifest, source_paths):
    package = manifest["package"]
    originals = manifest.get(kind, {} if kind == "lib" else [])
    originals = [originals] if isinstance(originals, dict) and originals else originals
    defaults = {}
    for filename in source_paths:
        if not packaged_path(filename, package):
            continue
        if kind == "lib" and filename == "src/lib.rs":
            defaults[package["name"].replace("-", "_")] = filename
        elif kind == "bin" and filename == "src/main.rs":
            defaults[package["name"]] = filename
        else:
            directory = {"bin": "src/bin", "test": "tests", "bench": "benches", "example": "examples"}.get(kind)
            if directory and filename.startswith(directory + "/"):
                remaining = filename[len(directory) + 1:]
                if "/" not in remaining and remaining.endswith(".rs"):
                    defaults[remaining[:-3]] = filename
                elif remaining.count("/") == 1 and remaining.endswith("/main.rs"):
                    defaults[remaining.split("/")[0]] = filename
    result = []
    for original in originals:
        target = copy.deepcopy(original)
        target.setdefault("name", package["name"].replace("-", "_") if kind == "lib" else package["name"])
        target.setdefault("path", defaults.get(target["name"], "src/lib.rs" if kind == "lib" else ""))
        check(target["path"] in source_paths, "Explicit target is outside accepted source: " + package["name"] + "/" + target["path"])
        if not packaged_path(target["path"], package):
            continue
        result.append(target)
    auto_key = {"lib": "autolib", "bin": "autobins", "test": "autotests", "bench": "autobenches", "example": "autoexamples"}[kind]
    if package.get(auto_key, True):
        for name, filename in defaults.items():
            if not any(t["name"] == name or t["path"] == filename for t in result):
                result.append({"name": name, "path": filename})
    return sorted(result, key=lambda t: (t["name"], t["path"]))


def normalized_manifest(actual, expected, root, files, name, version, source_paths):
    package = actual.get("package", {})
    expected_package = copy.deepcopy(expected["package"])
    workspace = expected.get("workspace", root.get("workspace", {}))
    for key, value in list(expected_package.items()):
        if isinstance(value, dict) and value.get("workspace") is True:
            expected_package[key] = workspace["package"][key]
    expected_package["version"] = version
    check(package.get("name") == name and package.get("version") == version, "Wrong normalized package identity")
    for key, value in expected_package.items():
        check(package.get(key) == value, "Normalized package field mismatch: " + key)
    generated = {"autolib", "autobins", "autoexamples", "autotests", "autobenches", "build", "readme"}
    check(set(package) <= set(expected_package) | generated, "Unexpected normalized package fields")
    for key in ("autolib", "autobins", "autoexamples", "autotests", "autobenches"):
        check(key not in package or package[key] is False, "Invalid generated Cargo discovery flag")
    expected_build = expected_package.get("build", "build.rs" if "build.rs" in files else False)
    check(package.get("build", False) == expected_build, "Normalized build script mismatch")
    if expected_build:
        check(expected_build in source_paths and expected_build in files, "Unaccepted build script entrypoint")
    check(actual.get("features", {}) == expected.get("features", {}), "Normalized feature contract mismatch")
    target_kinds = {"lib", "bin", "test", "bench", "example"}
    check(set(actual) <= (set(expected) - {"workspace"}) | target_kinds, "Unexpected normalized top-level contract")
    for key in set(expected) - {"workspace", "package", "features", "target", *KINDS, *target_kinds}:
        check(actual.get(key) == expected[key], "Normalized manifest section changed: " + key)
    for target, table in actual.get("target", {}).items():
        check(set(table) <= set(KINDS), "Unexpected normalized target-platform contract")
    source_deps = {dependency_key(d): semantic_spec(d["spec"]) for d in dependencies(expected, workspace)}
    actual_deps = {dependency_key(d): semantic_spec(d["spec"]) for d in dependencies(actual, {})}
    check(actual_deps == source_deps, "Normalized dependency contract mismatch: " + name)
    for dep in dependencies(actual, {}):
        check("path" not in dep["spec"] and "workspace" not in dep["spec"], "Published dependency retains local path")
    for kind in ("lib", "bin", "test", "bench", "example"):
        targets = actual.get(kind, [] if kind != "lib" else {})
        targets = [targets] if isinstance(targets, dict) and targets else targets
        for target in targets:
            entry = target.get("path", "src/lib.rs" if kind == "lib" else "")
            check(entry in source_paths and entry in files, "Unaccepted/missing normalized target source: " + entry)
        check(sorted(targets, key=lambda t: (t.get("name", ""), t.get("path", "")))
              == expected_targets(kind, expected, source_paths), "Normalized target contract mismatch: " + kind)
    return dependencies(actual, {})


def verify_lock(files, source_lock, names, version, checksums):
    if source_lock is None:
        return
    check("Cargo.lock" in files, "Missing published Cargo.lock")
    lock = tomllib.loads(files["Cargo.lock"].decode())
    check(isinstance(lock.get("package"), list), "Malformed published Cargo.lock")
    external = {(p["name"], p["version"], p["source"], p.get("checksum"))
                for p in source_lock["package"] if "source" in p and p["name"] not in names}
    for package in lock["package"]:
        if package["name"] in names:
            check(package["version"] == version, "Published lock has a different internal version")
            if "source" in package:
                check(package["source"] == "registry+https://github.com/rust-lang/crates.io-index"
                      and package.get("checksum") == checksums[package["name"]], "Published lock internal checksum/source mismatch")
        else:
            check((package["name"], package["version"], package.get("source"), package.get("checksum")) in external,
                  "Published lock changed a source-locked external dependency")


def verify_registry_edges(rows, manifest_deps, names, version, exact):
    expected, actual = [], []
    kinds = dict(zip(KINDS, ("normal", "dev", "build")))
    requirement = ("=" if exact else "^") + version
    for dep in manifest_deps:
        if dep["name"] not in names:
            continue
        check(dep["spec"].get("version") == ("=" if exact else "") + version,
              "Wrong internal manifest version requirement")
        expected.append((dep["name"], dep["alias"] if dep["alias"] != dep["name"] else None,
                         kinds[dep["kind"]], dep["target"], bool(dep["spec"].get("optional", False))))
    for row in rows:
        check(isinstance(row, dict) and isinstance(row.get("crate_id"), str), "Malformed registry dependency")
        if row["crate_id"] not in names:
            continue
        check(row.get("req") == requirement and isinstance(row.get("optional"), bool), "Wrong registry internal requirement")
        edge = (row["crate_id"], row.get("explicit_name"), row.get("kind"), row.get("target"), row["optional"])
        matching = [d for d in manifest_deps if (d["name"], d["alias"] if d["alias"] != d["name"] else None,
                    kinds[d["kind"]], d["target"], bool(d["spec"].get("optional", False))) == edge]
        check(len(matching) == 1, "Unexpected/ambiguous registry internal edge")
        spec = semantic_spec(matching[0]["spec"])
        if "default_features" in row:
            check(row["default_features"] == spec["default-features"], "Registry internal default-features mismatch")
        if "features" in row:
            check(isinstance(row["features"], list) and sorted(row["features"]) == spec["features"], "Registry internal features mismatch")
        actual.append(edge)
    check(sorted(expected, key=repr) == sorted(actual, key=repr), "Registry internal dependency closure mismatch")
    return len(expected)


def frontend_payload(files, request):
    sidecar = files.get("frontend_package/frontend-manifest.json")
    archive = files.get("frontend_package/lotus-frontend.zip")
    check(sidecar is not None and archive is not None, "Missing embedded frontend")
    wrapper = json.loads(sidecar)
    keys = ("schema_version", "frontend_name", "frontend_version", "bundle_hash", "built_at", "entry")
    check(list(wrapper) == list(keys), "Malformed frontend wrapper schema")
    # Match the canonical JS sidecar format without accepting extra whitespace.
    check(sidecar.decode() == json.dumps(wrapper, indent=2, ensure_ascii=False) + "\n", "Noncanonical frontend wrapper")
    check(wrapper["schema_version"] == 1 and wrapper["entry"] == "index.html", "Invalid frontend wrapper identity")
    expected = request["frontend"]
    check(wrapper["frontend_name"] == ("lotus-next" if expected["selection"] == "lotus-next" else "lotus")
          and wrapper["frontend_version"] == expected["packageVersion"], "Embedded frontend package mismatch")
    check(isinstance(wrapper["built_at"], str) and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", wrapper["built_at"]),
          "Invalid frontend build timestamp")
    datetime.datetime.fromisoformat(wrapper["built_at"].replace("Z", "+00:00"))
    payload, seen, total = {}, set(), 0
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        for item in zipped.infolist():
            relative = item.filename.rstrip("/")
            safe_path(relative)
            check(relative not in seen, "Duplicate embedded ZIP entry")
            seen.add(relative)
            mode = stat.S_IFMT(item.external_attr >> 16)
            check(mode in (0, stat.S_IFREG, stat.S_IFDIR) and not (item.flag_bits & 1), "Non-regular/encrypted frontend ZIP entry")
            if item.is_dir():
                check(mode in (0, stat.S_IFDIR), "Invalid ZIP directory type")
                continue
            check(mode in (0, stat.S_IFREG), "Invalid ZIP file type")
            total += item.file_size
            check(total <= MAX_CONTENT and len(seen) <= 50000, "Frontend ZIP exceeds verification limits")
            payload[relative] = zipped.read(item)
    check(payload.pop("frontend-manifest.json", None) == sidecar, "ZIP/sidecar wrapper mismatch")
    dist = Path(request["frontendPackageDir"]) / "dist"
    expected_files = {}
    for file in dist.rglob("*"):
        check(not file.is_symlink(), "Symlink in verified npm frontend")
        if file.is_file():
            expected_files[file.relative_to(dist).as_posix()] = file.read_bytes()
    check(payload == expected_files, "Embedded frontend complete resource bytes/inventory mismatch")
    bundle = hashlib.sha256()
    for relative in sorted(payload, key=lambda p: p.encode()):
        bundle.update(relative.encode() + b"\0" + payload[relative] + b"\0")
    check(wrapper["bundle_hash"] == "sha256:" + bundle.hexdigest(), "Embedded frontend bundle hash mismatch")
    return len(payload)


def verify(request):
    root, tracked, manifests, names, exact = describe(request)
    records = request["records"]
    check(sorted(r["name"] for r in records) == names, "Incomplete verification closure")
    source_lock = tomllib.loads(source_bytes(request, "Cargo.lock").decode()) if "Cargo.lock" in tracked else None
    checksums = {r["name"]: r["metadata"]["checksum"] for r in records}
    matched, edges, resources = 0, 0, 0
    for record in records:
        name = record["name"]
        source = manifests[name]
        relative = source["path"]
        prefix = relative + "/" if relative else ""
        files = archive_files(record["archive"], name, request["version"])
        check(hashlib.sha256(Path(record["archive"]).read_bytes()).hexdigest() == record["metadata"]["checksum"], "Archive checksum changed")
        vcs = json.loads(files[".cargo_vcs_info.json"])
        check(vcs.get("git", {}).get("sha1") == request["sourceRevision"] and vcs.get("path_in_vcs") == relative,
              "Wrong crate VCS source/path: " + name)
        check(isinstance(vcs["git"].get("dirty"), bool), "Malformed VCS dirty receipt")
        expected = stamped(source["manifest"], root, manifests, request["version"], exact)
        original = tomllib.loads(files["Cargo.toml.orig"].decode())
        check(original == expected, "Cargo.toml.orig differs from accepted stamped source: " + name)
        actual = tomllib.loads(files["Cargo.toml"].decode())
        source_paths = {p[len(prefix):] for p in tracked if p.startswith(prefix)}
        deps = normalized_manifest(actual, expected, root, files, name, request["version"], source_paths)
        edges += verify_registry_edges(record["dependencies"], deps, names, request["version"], exact)
        verify_lock(files, source_lock, names, request["version"], checksums)
        exceptions = {"frontend_package/frontend-manifest.json", "frontend_package/lotus-frontend.zip"} if name == "bamboo-server" else set()
        for filename, contents in files.items():
            if filename in {"Cargo.toml", "Cargo.toml.orig", "Cargo.lock", ".cargo_vcs_info.json"} | exceptions:
                continue
            entry = tracked.get(prefix + filename)
            if entry is None:
                # Existing Cargo root packaging includes npm license/readme
                # documentation. This narrow inert exception admits no code.
                check(name == "bamboo-agent" and filename.startswith("node_modules/")
                      and PurePosixPath(filename).name in ("LICENSE", "README.md"),
                      "Untracked crate payload: " + name + "/" + filename)
                continue
            mode, oid = entry
            check(mode in ("100644", "100755"), "Unsupported source payload mode")
            actual_oid = hashlib.sha1(b"blob " + str(len(contents)).encode() + b"\0" + contents).hexdigest()
            check(actual_oid == oid, "Crate source payload mismatch: " + name + "/" + filename)
            matched += 1
        # A matching subset is insufficient: all committed Rust sources and
        # build inputs must be present, even if an archive omits its target.
        for source_path in tracked:
            if not source_path.startswith(prefix):
                continue
            filename = source_path[len(prefix):]
            if filename.startswith("src/") or filename in ("build.rs", "frontend_build.rs"):
                check(filename in files, "Missing accepted source payload: " + name + "/" + filename)
        if name == "bamboo-server":
            resources = frontend_payload(files, request)
    return {"sourceFilesVerified": matched, "internalDependencyEdges": edges, "frontendFilesVerified": resources}


def main():
    request = json.load(sys.stdin)
    if sys.argv[1] == "describe":
        _, _, manifests, names, _ = describe(request)
        result = {"crates": [{"name": name, "path": manifests[name]["path"]} for name in names]}
    elif sys.argv[1] == "verify":
        result = verify(request)
    else:
        raise ValueError("Unknown parser command")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
