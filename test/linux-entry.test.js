import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readLinuxConfig } from '../src/linux-entry.js';

const linuxTest = (name, fn) => test(name, { skip: process.platform !== 'linux' && 'Linux-only behavioral test' }, fn);
linuxTest('Linux preflight rejects unsafe or malformed config without loading runtime', () => {
  const dir = mkdtempSync(join(tmpdir(),'camera-preflight-'));
  const vendor = join(dir,'fake vendor');
  mkdirSync(vendor);
  const config = join(dir,'secrets.json');
  const marker = 'SECRET_PARSE_VALUE_DO_NOT_LOG';
  const check = (path=config, minutes='30') => {
    assert.throws(() => readLinuxConfig(path,Number(minutes)));

  };
  try {
    writeFileSync(config,'{"token":"'+marker+'",',{mode:0o600});
    check();
    writeFileSync(config,JSON.stringify({bindHost:'127.0.0.1',port:8766,minutes:30,operatorPrincipal:'operator',tokens:{operator:'a'.repeat(43)},sources:{operator:['127.0.0.1']},vision:{baseUrl:'http://127.0.0.1:11434',model:'qwen3.5:9b'}}));
    chmodSync(config,0o644); check();
    chmodSync(config,0o600); symlinkSync(config,join(dir,'link')); check(join(dir,'link'));
    chmodSync(dir,0o755); check();
    chmodSync(dir,0o700); check(config,'10081');
    writeFileSync(config,' '.repeat(65537)+'{}'); check();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
linuxTest('Linux config reader accepts only secured config and rejects semantic endpoint errors before runtime', () => {
  const dir = mkdtempSync(join(tmpdir(),'camera-valid-config-'));
  const path = join(dir,'secrets.json');
  const config = {bindHost:'127.0.0.1',port:8766,minutes:30,operatorPrincipal:'operator',tokens:{operator:'a'.repeat(43)},sources:{operator:['127.0.0.1']},vision:{baseUrl:'http://127.0.0.1:11434',model:'qwen3.5:9b',num_ctx:4096,keep_alive:0}};
  try {
    writeFileSync(path,JSON.stringify(config),{mode:0o600});
    assert.deepEqual(readLinuxConfig(path,30),config);
    for (const baseUrl of ['https://example.com','http://127.0.0.1:11434/private','http://user:secret@127.0.0.1:11434','http://127.0.0.1:11434?token=secret','invalid']) {
      writeFileSync(path,JSON.stringify({...config,vision:{...config.vision,baseUrl}}));
      assert.throws(() => readLinuxConfig(path,30));
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
