import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import test from "node:test";

import { TokenAuthenticator } from "../src/auth.js";
import { createCameraHttpServer } from "../src/http-server.js";

const AGENT_A_TOKEN = "a".repeat(43);
const AGENT_B_TOKEN = "b".repeat(43);
const OBSERVATION_VECTORS = JSON.parse(readFileSync(
  new URL("../clients/hermes-plugin/observation-text-vectors.json", import.meta.url),
  "utf8",
));

async function withServer(run) {
  const calls = [];
  const bridge = {
    status() {
      return {
        active: true,
        expiresAtMs: 9_999,
        promptRevision: 0,
        promptUpdatedAtMs: 1_000,
        promptUpdatedBy: "system",
        promptAction: "initial",
        promptChars: 700,
        promptSha256: "a".repeat(64),
      };
    },
    async look(agent, body) {
      calls.push(["look", agent, body]);
      return {
        viewer: agent,
        description: "A person is seated.",
        width: 640,
        height: 360,
        promptRevision: 0,
      };
    },
    async move(agent, body) { calls.push(["move", agent, body]); return { leaseHolder: agent }; },
    async recenter(agent) { calls.push(["recenter", agent]); return { recentered: true }; },
    async stop(agent, body) { calls.push(["stop", agent, body]); return { active: false }; },
  };
  const auth = new TokenAuthenticator(
    { agent_a: AGENT_A_TOKEN, agent_b: AGENT_B_TOKEN },
    {
      allowedSourcesByAgent: {
        agent_a: ["127.0.0.1"],
        agent_b: ["127.0.0.1"],
      },
    },
  );
  const app = createCameraHttpServer({ bridge, auth, logger: () => {} });
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    await run({ baseUrl: `http://127.0.0.1:${app.address().port}`, calls });
  } finally {
    await app.close();
  }
}

function bearer(token) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

test("HTTP API derives viewer identity from the bearer token and returns text only", async () => {
  await withServer(async ({ baseUrl, calls }) => {
    const response = await fetch(`${baseUrl}/v1/look`, {
      method: "POST",
      headers: bearer(AGENT_A_TOKEN),
      body: JSON.stringify({ question: "What is visible?" }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const payload = await response.json();
    assert.equal(payload.description, "A person is seated.");
    assert.equal(JSON.stringify(payload).includes("base64"), false);
    assert.deepEqual(calls, [["look", "agent_a", { question: "What is visible?" }]]);
  });
});

test("HTTP API fails closed without authentication", async () => {
  await withServer(async ({ baseUrl, calls }) => {
    for (const path of ["/health", "/v1/status"]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 401);
    }
    assert.deepEqual(calls, []);
  });
});

test("authenticated health reveals only service liveness and activity", async () => {
  await withServer(async ({ baseUrl, calls }) => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: bearer(AGENT_A_TOKEN),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { service: "shared-camera", active: true });
    assert.deepEqual(calls, []);
  });
});

test("HTTP API deliberately exposes no start or arm route", async () => {
  await withServer(async ({ baseUrl, calls }) => {
    const response = await fetch(`${baseUrl}/v1/start`, {
      method: "POST",
      headers: bearer(AGENT_B_TOKEN),
      body: "{}",
    });
    assert.equal(response.status, 404);
    assert.deepEqual(calls, []);
  });
});

test("HTTP API deliberately exposes no autonomous follow route", async () => {
  await withServer(async ({ baseUrl, calls }) => {
    const response = await fetch(`${baseUrl}/v1/ptz/follow`, {
      method: "POST",
      headers: bearer(AGENT_B_TOKEN),
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(calls, []);
  });
});

test("HTTP close forcibly drains an authenticated incomplete body", async () => {
  const bridge = {
    status() { return { active: true, expiresAtMs: 9_999 }; },
  };
  const auth = new TokenAuthenticator(
    { agent_a: AGENT_A_TOKEN },
    { allowedSourcesByAgent: { agent_a: ["127.0.0.1"] } },
  );
  const app = createCameraHttpServer({ bridge, auth, logger: () => {} });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const socket = connect(app.address().port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(
    "POST /v1/look HTTP/1.1\r\n" +
    "Host: 127.0.0.1\r\n" +
    `Authorization: Bearer ${AGENT_A_TOKEN}\r\n` +
    "Content-Type: application/json\r\n" +
    "Transfer-Encoding: chunked\r\n\r\n",
  );
  await new Promise((resolve) => setImmediate(resolve));

  const closePromise = app.close({ graceMs: 25 });
  try {
    await Promise.race([
      closePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("HTTP close timed out")), 250)),
    ]);
  } finally {
    socket.destroy();
    await closePromise.catch(() => {});
  }
});

test("stop schedules runtime shutdown even when bridge stop throws", async () => {
  let markStopped;
  const stopped = new Promise((resolve) => { markStopped = resolve; });
  let callbackCalls = 0;
  const bridge = {
    status() { return { active: false, expiresAtMs: 9_999 }; },
    async stop() { throw new Error("bridge stop failed"); },
  };
  const auth = new TokenAuthenticator(
    { agent_a: AGENT_A_TOKEN },
    { allowedSourcesByAgent: { agent_a: ["127.0.0.1"] } },
  );
  const app = createCameraHttpServer({
    bridge,
    auth,
    logger: () => {},
    onStopped: () => {
      callbackCalls += 1;
      markStopped();
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/v1/stop`, {
      method: "POST",
      headers: bearer(AGENT_A_TOKEN),
      body: "{}",
    });
    assert.equal(response.status, 500);
    await Promise.race([
      stopped,
      new Promise((_, reject) => setTimeout(() => reject(new Error("onStopped timed out")), 250)),
    ]);
    assert.equal(callbackCalls, 1);
  } finally {
    await app.close();
  }
});

test("stop begins runtime shutdown before camera parking finishes", async () => {
  let finishParking;
  const parking = new Promise((resolve) => { finishParking = resolve; });
  let markStopped;
  const stopped = new Promise((resolve) => { markStopped = resolve; });
  const bridge = {
    status() { return { active: false, expiresAtMs: 9_999 }; },
    async stop() { return parking; },
  };
  const auth = new TokenAuthenticator(
    { agent_a: AGENT_A_TOKEN },
    { allowedSourcesByAgent: { agent_a: ["127.0.0.1"] } },
  );
  const app = createCameraHttpServer({
    bridge,
    auth,
    logger: () => {},
    onStopped: markStopped,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const stopResult = {
    active: false,
    expiresAtMs: 9_999,
    reason: "stopped",
    ptzLeaseHolder: null,
    ptzLeaseExpiresAtMs: null,
    parked: false,
    promptRevision: 0,
    promptUpdatedAtMs: 1_000,
    promptUpdatedBy: "system",
    promptAction: "initial",
    promptChars: 700,
    promptSha256: "a".repeat(64),
  };
  try {
    const responsePromise = fetch(`http://127.0.0.1:${app.address().port}/v1/stop`, {
      method: "POST",
      headers: bearer(AGENT_A_TOKEN),
      body: "{}",
    });
    await Promise.race([
      stopped,
      new Promise((_, reject) => setTimeout(() => reject(new Error("onStopped timed out")), 250)),
    ]);
    finishParking(stopResult);
    const response = await responsePromise;
    assert.equal(response.status, 200);
  } finally {
    finishParking?.(stopResult);
    await app.close();
  }
});

test("malformed absolute request targets return 400 without crashing the server", async () => {
  const bridge = { status() { return { active: true, expiresAtMs: 9_999 }; } };
  const auth = new TokenAuthenticator(
    { agent_a: AGENT_A_TOKEN },
    { allowedSourcesByAgent: { agent_a: ["127.0.0.1"] } },
  );
  const app = createCameraHttpServer({ bridge, auth, logger: () => {} });
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const socket = connect(app.address().port, "127.0.0.1");
    await once(socket, "connect");
    let responseText = "";
    socket.on("data", (chunk) => { responseText += chunk.toString("utf8"); });
    socket.write(
      "GET http://[ HTTP/1.1\r\n" +
      "Host: 127.0.0.1\r\n" +
      "Connection: close\r\n\r\n",
    );
    await once(socket, "close");
    assert.match(responseText, /^HTTP\/1\.1 400/);

    const health = await fetch(`http://127.0.0.1:${app.address().port}/health`, {
      headers: bearer(AGENT_A_TOKEN),
    });
    assert.equal(health.status, 200);
  } finally {
    await app.close();
  }
});

test("HTTP output schema blocks nested image data before serialization", async () => {
  const bridge = {
    status() { return { active: true, expiresAtMs: 9_999 }; },
    async look() {
      return {
        viewer: "agent_a",
        description: { base64: "PRIVATE_HTTP_IMAGE" },
        width: 640,
        height: 360,
      };
    },
  };
  const auth = new TokenAuthenticator(
    { agent_a: AGENT_A_TOKEN },
    { allowedSourcesByAgent: { agent_a: ["127.0.0.1"] } },
  );
  const app = createCameraHttpServer({ bridge, auth, logger: () => {} });
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/v1/look`, {
      method: "POST",
      headers: bearer(AGENT_A_TOKEN),
      body: JSON.stringify({ question: "What is visible?" }),
    });
    const responseText = await response.text();
    assert.equal(response.status, 500);
    assert.equal(responseText.includes("PRIVATE_HTTP_IMAGE"), false);
    assert.equal(responseText.includes("base64"), false);
  } finally {
    await app.close();
  }
});

test("HTTP errors never expose internal message detail", async () => {
  const marker = "PRIVATE_PROVIDER_DETAIL";
  const bridge = {
    status() { return { active: true, expiresAtMs: 9_999 }; },
    async look() { throw new Error(`question rejected: ${marker}`); },
  };
  const auth = new TokenAuthenticator(
    { agent_a: AGENT_A_TOKEN },
    { allowedSourcesByAgent: { agent_a: ["127.0.0.1"] } },
  );
  const app = createCameraHttpServer({ bridge, auth, logger: () => {} });
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/v1/look`, {
      method: "POST",
      headers: bearer(AGENT_A_TOKEN),
      body: JSON.stringify({ question: "What is visible?" }),
    });
    const responseText = await response.text();
    assert.equal(response.status, 400);
    assert.equal(responseText.includes(marker), false);
    assert.deepEqual(JSON.parse(responseText), { error: "invalid camera bridge request" });
  } finally {
    await app.close();
  }
});

test("unknown request paths are logged only as a canonical placeholder", async () => {
  const marker = "PROMPT_OR_SECRET_BODY_FORCED_INTO_PATH_LOG";
  const logs = [];
  const bridge = { status() { return { active: true, expiresAtMs: 9_999 }; } };
  const auth = new TokenAuthenticator(
    { agent_a: AGENT_A_TOKEN },
    { allowedSourcesByAgent: { agent_a: ["127.0.0.1"] } },
  );
  const app = createCameraHttpServer({ bridge, auth, logger: (event) => logs.push(event) });
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/v1/${marker}`, {
      headers: bearer(AGENT_A_TOKEN),
    });
    assert.equal(response.status, 404);
    assert.equal(logs.at(-1).path, "<unknown>");
    assert.equal(JSON.stringify(logs).includes(marker), false);
  } finally {
    await app.close();
  }
});

test("HTTP output schema rejects media-bearing description strings", async () => {
  for (const description of OBSERVATION_VECTORS.forbidden) {
    const bridge = {
      status() { return { active: true, expiresAtMs: 9_999 }; },
      async look() {
        return {
          viewer: "agent_a",
          description,
          width: 640,
          height: 360,
          promptRevision: 0,
        };
      },
    };
    const auth = new TokenAuthenticator(
      { agent_a: AGENT_A_TOKEN },
      { allowedSourcesByAgent: { agent_a: ["127.0.0.1"] } },
    );
    const app = createCameraHttpServer({ bridge, auth, logger: () => {} });
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const response = await fetch(`http://127.0.0.1:${app.address().port}/v1/look`, {
        method: "POST",
        headers: bearer(AGENT_A_TOKEN),
        body: JSON.stringify({ question: "What is visible?" }),
      });
      const responseText = await response.text();
      assert.equal(response.status, 500);
      assert.equal(responseText.includes("PRIVATE_RAW_IMAGE_PAYLOAD"), false);
    } finally {
      await app.close();
    }
  }
});
