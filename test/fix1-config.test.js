import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLinuxConfig } from '../src/linux-entry.js';

const linuxTest = (name, fn) => test(name, { skip: process.platform !== 'linux' && 'Linux-only behavioral test' }, fn);
const value = {
  bindHost: '127.0.0.1', port: 34567, minutes: 30, operatorPrincipal: 'operator',
  tokens: { operator: 'a'.repeat(43) }, sources: { operator: ['127.0.0.1'] },
  vision: { baseUrl: 'http://127.0.0.1:11434', model: 'synthetic' },
};

for (const seam of ['original-root', 'between-opens', 'file-replacement']) {
  linuxTest(`config rejects ${seam} and closes descriptors`, () => {
    const temp = fs.mkdtempSync(join(tmpdir(), 'fix1-config-'));
    const parent = join(temp, 'private');
    fs.mkdirSync(parent, { mode: 0o700 });
    const path = join(parent, 'config.json');
    const save = () => fs.writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    save();
    const stat = fs.lstatSync, open = fs.openSync;
    let roots = 0, swapped = false;
    const swap = () => {
      swapped = true;
      fs.renameSync(parent, join(temp, 'moved'));
      fs.symlinkSync(join(temp, 'moved'), parent);
    };
    const count = () => fs.readdirSync('/proc/self/fd').length;
    const before = count();
    fs.lstatSync = (pathArg, ...args) => {
      const result = stat(pathArg, ...args);
      if (seam === 'original-root' && pathArg === '/' && ++roots === 2) swap();
      if (seam === 'file-replacement' && pathArg === path && !swapped) {
        swapped = true;
        fs.renameSync(path, join(parent, 'old'));
        save();
      }
      return result;
    };
    fs.openSync = (pathArg, ...args) => {
      const fd = open(pathArg, ...args);
      if (seam === 'between-opens' && String(pathArg).endsWith('/private') && !swapped) swap();
      return fd;
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => readLinuxConfig(path, 30));
      assert.ok(swapped, 'seam must execute');
      assert.equal(count(), before);
    } finally {
      fs.lstatSync = stat;
      fs.openSync = open;
      syncBuiltinESMExports();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}

linuxTest('pinned reader rejects unsafe ancestors, symlinks, hardlinks and bounded invalid data', () => {
  const temp = fs.mkdtempSync(join(tmpdir(), 'fix1-config-'));
  const parent = join(temp, 'private');
  fs.mkdirSync(parent, { mode: 0o700 });
  const path = join(parent, 'config.json');
  fs.writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  try {
    assert.deepEqual(readLinuxConfig(path, 30), value);
    fs.symlinkSync(parent, join(temp, 'link'));
    assert.throws(() => readLinuxConfig(join(temp, 'link', 'config.json'), 30));
    fs.chmodSync(temp, 0o770);
    assert.throws(() => readLinuxConfig(path, 30));
    fs.chmodSync(temp, 0o700);
    fs.linkSync(path, join(parent, 'hard'));
    assert.throws(() => readLinuxConfig(path, 30));
    fs.unlinkSync(join(parent, 'hard'));
    fs.writeFileSync(path, ' '.repeat(65537));
    assert.throws(() => readLinuxConfig(path, 30));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
