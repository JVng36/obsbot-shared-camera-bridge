import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (name) => readFileSync(new URL(name, root), "utf8");

test("vendor bootstrap reconstructs only the pinned audited adapter", () => {
  const script = read("scripts/Install-ObsbotAdapter.ps1");
  const lock = JSON.parse(read("vendor.lock.json"));

  assert.match(lock.repository, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
  assert.match(lock.commit, /^[a-f0-9]{40}$/);
  assert.equal(lock.hardening.patch, "patches/obsbot-mcp-hardening.patch");
  assert.equal("deployed_vendor_path" in lock, false);
  assert.equal("helper_sha256" in lock, false);

  assert.match(script, /refuses to overwrite/i);
  assert.match(script, /foreach \(\$Command in @\('git', 'node', 'npm', 'cmake'\)\)/);
  assert.match(script, /Get-Command \$Command/);
  assert.match(script, /clone.+--no-checkout/is);
  assert.match(script, /checkout.+--detach/is);
  assert.match(script, /rev-parse.+HEAD/is);
  assert.match(script, /apply.+--check/is);

  const install = script.indexOf("@('ci')");
  const audit = script.indexOf("@('audit', '--omit=dev')");
  const build = script.indexOf("@('run', 'build')");
  const tests = script.indexOf("@('test')");
  const helper = script.indexOf("@('run', 'build:helper')");
  assert.ok(install >= 0 && install < audit);
  assert.ok(audit < build && build < tests && tests < helper);

  assert.match(script, /native\\prebuilt\\win32-x64\\obsbot-helper\.exe/);
  assert.match(script, /Get-FileHash.+SHA256/);
  assert.doesNotMatch(script, /audit\s+fix/i);
  assert.doesNotMatch(script, /Invoke-WebRequest|curl|wget/i);
});
