import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRuntimeConfig } from '../src/config.js';
import { OllamaVision } from '../src/ollama-vision.js';
const config = (vision) => ({ bindHost:'127.0.0.1', port:8766, minutes:30, operatorPrincipal:'operator', tokens:{operator:'a'.repeat(43)}, sources:{operator:['127.0.0.1']}, vision });
test('Linux config sends exact native context and residency values through fake fetch', async () => {
  let body;
  const vision = validateRuntimeConfig(config({baseUrl:'http://127.0.0.1:11434',model:'qwen3.5:9b',num_ctx:4096,num_predict:300,keep_alive:0})).vision;
  const fetchImpl = async (url, options) => {
    assert.equal(url,'http://127.0.0.1:11434/api/chat');
    assert.equal(options.redirect,'error');
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({message:{content:'Desk.'}}), {headers:{'content-type':'application/json'}});
  };
  assert.equal(await new OllamaVision({...vision,fetchImpl}).describe({imageBase64:'QUJD',mime:'image/jpeg',question:'Visible?'}), 'Desk.');
  assert.equal(body.model,'qwen3.5:9b');
  assert.equal(body.keep_alive,0);
  assert.deepEqual(body.options,{temperature:0.2,num_predict:300,num_ctx:4096});
});
test('optional context and residency controls reject unbounded or ambiguous values before fetch', () => {
  for (const overrides of [{num_ctx:0},{num_ctx:32769},{num_ctx:4096.5},{num_ctx:'4096'},{num_predict:-1},{num_predict:1001},{num_predict:null},{keep_alive:-1},{keep_alive:'forever'},{keep_alive:null},{model:''}]) {
    const vision = {baseUrl:'http://127.0.0.1:11434',model:'qwen3.5:9b',...overrides};
    assert.throws(() => validateRuntimeConfig(config(vision)));
    assert.throws(() => new OllamaVision(vision));
  }
});
test('native vision fails closed on invalid empty oversized or explicitly truncated responses', async () => {
  for (const body of ['{',JSON.stringify({message:{content:''}}),JSON.stringify({message:{content:'Partial'},done:false}),JSON.stringify({message:{content:'Partial'},done:true,done_reason:'length'}),JSON.stringify({message:{content:'x'.repeat(20000)}})]) {
    const vision = new OllamaVision({model:'qwen3.5:9b',num_ctx:4096,keep_alive:0,fetchImpl:async () => new Response(body,{headers:{'content-type':'application/json'}})});
    await assert.rejects(vision.describe({imageBase64:'QUJD',mime:'image/jpeg',question:'Visible?'}));
  }
});
