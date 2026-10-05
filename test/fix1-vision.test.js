import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { OllamaVision } from '../src/ollama-vision.js';

const frame = { imageBase64: 'RklYMV9TWU5USEVUSUM=', mime: 'image/jpeg', question: 'Synthetic only' };
const payload = JSON.stringify({ done: true, message: { content: 'Synthetic desk.' } });
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const close = async server => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
};

for (const poisonGlobals of [false, true]) {
  test(`direct transport ignores proxy environment${poisonGlobals ? ' and hostile ambient globals' : ' with unchanged native globals'}`, async () => {
    const bodies = [];
    let proxyCount = 0;
    const direct = http.createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      bodies.push({ url: request.url, body });
      response.setHeader('content-type', 'application/json');
      response.end(payload);
    });
    const proxy = http.createServer((request, response) => {
      proxyCount++;
      request.resume();
      response.setHeader('content-type', 'application/json');
      response.end(payload);
    });
    proxy.on('connect', (_request, socket) => { proxyCount++; socket.destroy(); });
    try {
      await listen(direct);
      await listen(proxy);
      const baseUrl = `http://${poisonGlobals ? 'localhost' : '127.0.0.1'}:${direct.address().port}`;
      const code = `
        import http from 'node:http';
        import {OllamaVision} from ${JSON.stringify(new URL('../src/ollama-vision.js', import.meta.url).href)};
        if (${poisonGlobals}) {
          globalThis.fetch = () => { throw Error('ambient fetch invoked'); };
          http.globalAgent.addRequest = () => { throw Error('global agent invoked'); };
        }
        console.log(await new OllamaVision({baseUrl:${JSON.stringify(baseUrl)},timeoutMs:1500}).describe(${JSON.stringify(frame)}));
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        env: {
          PATH: process.env.PATH,
          NODE_USE_ENV_PROXY: '1',
          HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`,
          HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`,
          ALL_PROXY: `http://127.0.0.1:${proxy.address().port}`,
          NO_PROXY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      child.stdout.on('data', data => { out += data; });
      child.stderr.on('data', data => { err += data; });
      const status = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(Error('child timeout')); }, 5000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(status, 0, err);
      assert.match(out, /Synthetic desk/);
      assert.equal(proxyCount, 0);
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].url, '/api/chat');
      assert.equal(JSON.parse(bodies[0].body).messages[1].images[0], frame.imageBase64);
      console.log(JSON.stringify({ poisonGlobals, proxyRequests: proxyCount, directRequests: bodies.length, syntheticImageReceivedDirectly: true }));
    } finally {
      await close(direct);
      await close(proxy);
    }
  });
}

test('native transport rejects redirects, streamed byte overflow, abort and timeout', async () => {
  let mode = 'redirect', targetCount = 0;
  const target = http.createServer((_request, response) => { targetCount++; response.end(payload); });
  const server = http.createServer((request, response) => {
    request.resume();
    if (mode === 'redirect') {
      response.writeHead(307, { location: `http://127.0.0.1:${target.address().port}/sink` });
      response.end();
    } else if (mode === 'overflow') {
      response.setHeader('content-type', 'application/json');
      response.write(' '.repeat(8192));
      response.end(' '.repeat(8193));
    } else {
      response.setHeader('content-type', 'application/json');
      response.write('{');
    }
  });
  try {
    await listen(target);
    await listen(server);
    const vision = new OllamaVision({ baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 100 });
    await assert.rejects(vision.describe(frame), /redirect/i);
    assert.equal(targetCount, 0);
    mode = 'overflow';
    await assert.rejects(vision.describe(frame), /byte limit/);
    mode = 'hang';
    await assert.rejects(vision.describe(frame));
    const controller = new AbortController();
    const pending = vision.describe({ ...frame, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 20);
    try { await assert.rejects(pending); } finally { clearTimeout(timer); }
    controller.abort();
    await assert.rejects(vision.describe({ ...frame, signal: controller.signal }));
  } finally {
    await close(server);
    await close(target);
  }
});
