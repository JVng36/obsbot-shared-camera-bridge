import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Linux launcher sanitizes inherited loader/proxy state and disables core dumps', {
  skip: process.platform !== 'linux' && 'Linux-only behavioral test',
}, () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./fix1-launcher.py', import.meta.url))], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /SC-1 real PTY preload\/config and fake executable environment\/core checks passed/);
});
