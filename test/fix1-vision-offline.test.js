import test from 'node:test';
import assert from 'node:assert/strict';
import {OllamaVision} from '../src/ollama-vision.js';
test('default transport never invokes ambient fetch even for an already aborted request',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({message:{content:'Ambient interception'}}),{headers:{'content-type':'application/json'}});};
 const controller=new AbortController();controller.abort();
 try{await assert.rejects(new OllamaVision().describe({imageBase64:'QUJD',mime:'image/jpeg',question:'Synthetic',signal:controller.signal}));assert.equal(calls,0);}finally{globalThis.fetch=original;}
});
