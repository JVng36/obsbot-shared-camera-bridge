import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (name) => readFileSync(new URL(name, root), "utf8");

test("camera launcher exposes finite seven-day maximum", () => {
  const powershell = read("Start-SharedCamera.ps1");
  const cmd = read("Start Shared Camera.cmd");

  assert.match(powershell, /ValidateRange\(1,\s*10080\)/);
  assert.match(cmd, /1-10080/);
  assert.match(cmd, /10080 = 7 days/);
  assert.match(cmd, /-Minutes "%MINUTES%"/);
});

test("camera launcher console is generic operator language", () => {
  const powershell = read("Start-SharedCamera.ps1");
  assert.match(powershell, /SHARED CAMERA SESSION IS ACTIVE/);
  assert.match(powershell, /Operator editor|operator editor/i);
  assert.match(powershell, /authorized agent/i);
});

test("local prompt editor disables proxy and redirect and never persists prompt text", () => {
  const editor = read("Edit-SharedVlmPrompt.ps1");

  assert.match(editor, /UseProxy\s*=\s*\$false/);
  assert.match(editor, /AllowAutoRedirect\s*=\s*\$false/);
  assert.match(editor, /IPAddress\]::TryParse/);
  assert.match(editor, /100\.64\.0\.0\/10|octets/i);
  assert.match(editor, /Get-NetIPAddress/);
  assert.match(editor, /ResponseHeadersRead/);
  assert.match(editor, /131072|131_072/);
  assert.match(editor, /Assert-ExactProperties/);
  assert.match(editor, /Assert-PromptMetadata/);
  assert.match(editor, /Get-PromptSha256/);
  assert.match(editor, /\[decimal\]::Truncate/);
  assert.doesNotMatch(editor, /\$Value -isnot \[int\].*\$Value -isnot \[long\]/);
  assert.match(editor, /System\.UriBuilder/);
  assert.doesNotMatch(editor, /http:\/\/\$\(\$BindAddress\.IPAddressToString\):\$Port/);
  assert.match(editor, /request rejected/);
  assert.doesNotMatch(editor, /ReadAsStringAsync|ParsedError/);
  assert.match(editor, /StatusOnly/);
  assert.match(editor, /expectedRevision/);
  assert.match(editor, /\/v1\/prompt\/(get|replace|append|reset)/);
  assert.doesNotMatch(
    editor,
    /Set-Content|Out-File|WriteAllText|WriteAllLines|AppendAllText|Export-/i,
  );
});

test("GitHub CI exposes the plugin package to Python discovery", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.match(
    workflow,
    /Run Python client and plugin tests[\s\S]*?env:\s*\n\s+PYTHONPATH:\s*clients\/hermes-plugin[\s\S]*?python -m unittest discover/,
  );
});

test("Hermes Plugin Doctor CI installs an immutable source revision", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.match(
    workflow,
    /Install pinned Hermes Agent[\s\S]*?python -m pip install --editable "git\+https:\/\/github\.com\/NousResearch\/hermes-agent\.git@[0-9a-f]{40}#egg=hermes-agent"/,
  );
  assert.match(
    workflow,
    /Validate plugin against runtime contracts[\s\S]*?SHARED_CAMERA_URL:\s*http:\/\/127\.0\.0\.1:8766[\s\S]*?SHARED_CAMERA_AGENT:\s*agent_a[\s\S]*?hermes plugins doctor clients\/hermes-plugin --ci/,
  );
});

test("Windows CI executes the prompt editor against production-shaped loopback responses", () => {
  const workflow = read(".github/workflows/ci.yml");
  const integration = read("test/Invoke-WindowsEditorIntegration.ps1");

  assert.match(workflow, /Invoke-WindowsEditorIntegration\.ps1/);
  assert.match(integration, /1700000000000/);
  assert.match(integration, /127\.0\.0\.1/);
  assert.match(integration, /::1/);
  assert.match(integration, /powershell\.exe/);
});

test("prompt editor derives allowed actors from config token keys plus system", () => {
  const editor = read("Edit-SharedVlmPrompt.ps1");
  assert.match(editor, /tokens\.PSObject\.Properties\.Name|PSObject\.Properties\.Name/);
  assert.match(editor, /\^\[a-z\]\[a-z0-9_-\]\{0,31\}\$/);
  assert.match(editor, /system/);
  assert.match(editor, /\$Config\.operatorPrincipal/);
  assert.doesNotMatch(editor, /\$PrincipalIds\[0\]/);
});
