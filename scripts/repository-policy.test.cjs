"use strict";

const assert = require("node:assert/strict");
const { existsSync, readdirSync, readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("Zenith no longer owns downstream release state or recovery", () => {
  for (const retired of [
    ".github/release-train.config.json",
    ".github/workflows/release-train.yml",
    ".github/workflows/nightly-release.yml",
    ".github/workflows/recover-bodhi-release.yml",
    ".github/workflows/release-policy.yml",
    "scripts/release-train-policy.cjs",
    "scripts/release-publication.cjs",
    "scripts/verify-bamboo-publication.cjs",
    "scripts/verify-bamboo-publication.py",
    "scripts/finalize-bodhi-release.cjs",
  ]) {
    assert.equal(existsSync(path.join(root, retired)), false, `${retired} must remain retired`);
  }
});

test("wrapper workflows only check source and cannot dispatch or publish", () => {
  const workflows = path.join(root, ".github/workflows");
  const files = readdirSync(workflows).filter((file) => /\.ya?ml$/.test(file));
  assert.ok(files.includes("submodule-guard.yml"), "Preserve source pointer validation");
  for (const file of files) {
    const body = readFileSync(path.join(workflows, file), "utf8");
    assert.match(body, /\bcontents:\s*read\b/, `${file} must be read-only`);
    assert.doesNotMatch(body, /:\s*write\b/, `${file} must not have write permissions`);
    assert.doesNotMatch(body, /workflow_dispatch:|schedule:|RELEASE_ORCHESTRATOR_TOKEN/, `${file} must not be a publisher entrypoint`);
    assert.doesNotMatch(body, /gh\s+(?:workflow\s+run|release\s+)|git\s+(?:push|commit)\b/, `${file} must not orchestrate releases or write versions`);
  }
});

test("policy runs when a retired script is restored without other file changes", () => {
  const policy = readFileSync(path.join(root, ".github/workflows/repository-policy.yml"), "utf8");
  const eventFilters = [
    policy.match(/  push:([\s\S]*?)  pull_request:/)?.[1],
    policy.match(/  pull_request:([\s\S]*?)\npermissions:/)?.[1],
  ];
  for (const filter of eventFilters) {
    assert.ok(filter, "Push and pull_request must both check policy changes");
    const patterns = [...filter.matchAll(/^\s+- "([^"]+)"$/gm)].map((match) => match[1]);
    for (const changed of [
      "scripts/release-publication.cjs",
      "scripts/release-train-policy.cjs",
      "scripts/finalize-bodhi-release.cjs",
      "scripts/verify-bamboo-publication.py",
      "scripts/repository-policy.test.cjs",
    ]) {
      assert.ok(patterns.some((pattern) => path.matchesGlob(changed, pattern)), `Policy would miss ${changed}`);
    }
  }
});

test("current playbook and READMEs point to repository-owned publishers", () => {
  for (const file of ["AGENTS.md", "README.md", "README.zh-CN.md"]) {
    const body = readFileSync(path.join(root, file), "utf8");
    assert.match(body, /bigduu\/Bodhi-AI\/blob\/main\/docs\/releasing\.md/, `${file} must link Bodhi's playbook`);
    assert.doesNotMatch(body, /\]\([^)]*(?:release-train|nightly-release|recover-bodhi-release|release-policy)/, `${file} must not link a retired release authority`);
  }
});
