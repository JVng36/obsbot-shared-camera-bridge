import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const linuxTest = (name, fn) => test(name, { skip: process.platform !== 'linux' && 'Linux-only behavioral test' }, fn);
const runner = fileURLToPath(new URL('./linux-launcher-fixture.py', import.meta.url));
linuxTest('Linux launcher requires a terminal before invoking even a fake child', () => {
  const result = spawnSync('python3',[runner,'terminal'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
linuxTest('Linux launcher rejects invalid durations before fake child import in a PTY', () => {
  const result = spawnSync('python3',[runner,'duration'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
linuxTest('Linux launcher requires explicit START and execs fake Node with absolute spaced paths', () => {
  const result = spawnSync('python3',[runner,'confirmation'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
linuxTest('Linux launcher holds stable lock through exec and contender cannot disturb owner', () => {
  const result = spawnSync('python3',[runner,'duplicate'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
linuxTest('desktop template starts in a visible terminal with explicit installation paths', async () => {
  const {readFileSync} = await import('node:fs');
  const desktop = readFileSync(new URL('../scripts/shared-camera.desktop.in',import.meta.url),'utf8');
  assert.match(desktop,/^Terminal=true$/m);
  assert.match(desktop,/^Exec="@APP_ROOT@\/scripts\/start-shared-camera.sh" --config "@CONFIG_PATH@" --vendor-root "@VENDOR_ROOT@" --node "@NODE_PATH@"$/m);
  assert.doesNotMatch(desktop,/autostart|--yes|--renew/i);
});
linuxTest('explicit Node path works when Node is absent from PATH', () => {
  const result = spawnSync('python3',[runner,'explicit-node'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
