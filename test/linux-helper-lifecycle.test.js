import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const linuxTest = (name, fn) => test(name, { skip: process.platform !== 'linux' && 'Linux-only behavioral test' }, fn);
linuxTest('reviewed Linux helper close waits for fake child exit and escalates a ignored TERM', async () => {
  const dir = mkdtempSync(join(tmpdir(),'camera-helper-'));
  const sourcePath = fileURLToPath(new URL('./fixtures/obsbot-mcp/helper-process.ts',import.meta.url));
  const patch = fileURLToPath(new URL('../patches/obsbot-mcp-linux.patch',import.meta.url));
  try {
    // A nested TMPDIR must not inherit an enclosing repository's path prefix.
    const initialized = spawnSync('git',['init','--quiet'],{cwd:dir,encoding:'utf8'});
    assert.equal(initialized.status,0,initialized.stderr);
    mkdirSync(join(dir,'src/transport'),{recursive:true});
    const bytes = readFileSync(sourcePath);
    const provenance = JSON.parse(readFileSync(new URL('./fixtures/obsbot-mcp/provenance.json',import.meta.url),'utf8'));
    assert.equal(provenance.commit,'81200e519da2ef8c1f5d7a11513eee87b4797833');
    assert.equal(provenance.sourcePath,'src/transport/helper-process.ts');
    assert.equal(createHash('sha256').update(bytes).digest('hex'),provenance.sha256);
    const license = readFileSync(new URL('./fixtures/obsbot-mcp/LICENSE',import.meta.url),'utf8');
    assert.equal(createHash('sha256').update(license).digest('hex'),provenance.licenseSha256);
    writeFileSync(join(dir,'src/transport/helper-process.ts'),bytes);
    const checked = spawnSync('git',['apply','--check','--include=src/transport/helper-process.ts',patch],{cwd:dir,encoding:'utf8'});
    assert.equal(checked.status,0,checked.stderr);
    const apply = spawnSync('git',['apply','--include=src/transport/helper-process.ts',patch],{cwd:dir,encoding:'utf8'});
    assert.equal(apply.status,0,apply.stderr);
    const source = readFileSync(join(dir,'src/transport/helper-process.ts'),'utf8');
    assert.match(source, /Linux helper did not exit after bounded shutdown/);
    assert.notEqual(source, bytes.toString('utf8'), 'the filtered patch must change the fixture');
    const start = source.indexOf('  async close(): Promise<void> {');
    assert.ok(start > 0);
    let depth=1, end=source.indexOf('{',start)+1;
    for (; depth; end++) { if (source[end]==='{') depth++; if(source[end]==='}') depth--; }
    // Exercise the exact reviewed close method without loading vendor modules or native binaries.
    const method = source.slice(start,end).replace('(): Promise<void>', '()').replace('new Promise<void>', 'new Promise');
    const FakeOwner = new Function(`return class { failAll() {} ${method} }`)();
    const child = spawn('python3',['-u','-c','import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print("ready",flush=True); time.sleep(10)'],{stdio:['pipe','pipe','pipe']});
    await new Promise((resolve,reject) => { child.once('error',reject); child.stdout.once('data',resolve); });
    const owner = new FakeOwner(); owner.proc=child; owner.rl={close(){}};
    try {
      const first = owner.close(); const second = owner.close();
      await Promise.all([first,second]);
      assert.ok(child.exitCode !== null || child.signalCode !== null,'close returned before child exit');
      assert.equal(child.signalCode,'SIGKILL');
    } finally { if (child.exitCode===null && child.signalCode===null) child.kill('SIGKILL'); }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
