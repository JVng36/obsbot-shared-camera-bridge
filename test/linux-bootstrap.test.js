import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const linuxTest = (name, fn) => test(name, { skip: process.platform !== 'linux' && 'Linux-only behavioral test' }, fn);
linuxTest('Linux bootstrap refuses an existing destination before git or npm and reconstructs pinned source', () => {
  const path = fileURLToPath(new URL('../scripts/install-obsbot-adapter.sh',import.meta.url));
  const dir = mkdtempSync(join(tmpdir(),'camera-bootstrap-'));
  try {
    const result = spawnSync('bash',[path,'--destination',dir],{encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/refuses to overwrite/);
    const script = readFileSync(path,'utf8');
    assert.match(script,/vendor\.lock\.json/);
    assert.match(script,/clone --no-checkout/);
    assert.match(script,/checkout --detach/);
    assert.match(script,/rev-parse HEAD/);
    assert.match(script,/apply --check/);
    assert.match(script,/npm ci/);
    assert.match(script,/npm run build/);
    assert.match(script,/npm test/);
    assert.match(script,/cmake -S .*native\/linux/);
    assert.match(script,/cmake --build/);
    assert.match(script,/linux-\$arch/);
    assert.doesNotMatch(script,/sudo|apt-get|systemctl|audit fix/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
