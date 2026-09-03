import assert from "node:assert/strict";
import test from "node:test";

import { TokenAuthenticator } from "../src/auth.js";
import { SharedCameraBridge } from "../src/bridge.js";
import { createCameraHttpServer } from "../src/http-server.js";
import { PromptStore } from "../src/prompt-store.js";
import { CameraSession } from "../src/session.js";

const PRINCIPALS = ["operator", "agent_a", "agent_b"];
const TOKENS = {
  operator: "operator-test-token-0123456789-abcdefg",
  agent_a: "agent-a-test-token-0123456789-abcdefgh",
  agent_b: "agent-b-test-token-0123456789-abcdefgh",
};

async function makeServer(principals = PRINCIPALS) {
  const cameraCalls = [];
  const bridge = new SharedCameraBridge({
    session: new CameraSession({
      durationMs: 60_000,
      now: () => 1_000,
      allowedAgents: principals,
    }),
    promptStore: new PromptStore({ now: () => 1_000, allowedActors: principals }),
    device: {
      async snapshot() { cameraCalls.push("snapshot"); throw new Error("not used"); },
      async sleep() { cameraCalls.push("sleep"); },
    },
    vision: {},
    now: () => 1_000,
  });
  const tokens = Object.fromEntries(principals.map((id) => [id, TOKENS[id] ?? `${id}-test-token-0123456789-abcdefghijk`]));
  const auth = new TokenAuthenticator(tokens, {
    allowedSourcesByAgent: Object.fromEntries(principals.map((id) => [id, ["127.0.0.1"]])),
  });
  const app = createCameraHttpServer({ bridge, auth, logger: () => {} });
  await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    app,
    baseUrl: `http://127.0.0.1:${app.address().port}`,
    cameraCalls,
    tokens,
  };
}

function headers(token) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function request(baseUrl, token, path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: headers(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, json: await response.json() };
}

test("prompt HTTP routes support get replace append reset and visible history", async () => {
  const { app, baseUrl, cameraCalls } = await makeServer();
  try {
    const initial = await request(baseUrl, TOKENS.operator, "/v1/prompt/get");
    assert.equal(initial.response.status, 200);
    assert.equal(initial.json.revision, 0);
    assert.equal(typeof initial.json.prompt, "string");

    const replaced = await request(baseUrl, TOKENS.operator, "/v1/prompt/replace", {
      method: "POST",
      body: { prompt: "Operator live experiment", expectedRevision: 0 },
    });
    assert.equal(replaced.response.status, 200);
    assert.equal(replaced.json.revision, 1);
    assert.equal(replaced.json.updatedBy, "operator");

    const appended = await request(baseUrl, TOKENS.agent_b, "/v1/prompt/append", {
      method: "POST",
      body: { text: "Add agent_b visual style.", expectedRevision: 1 },
    });
    assert.equal(appended.response.status, 200);
    assert.equal(appended.json.revision, 2);

    const status = await request(baseUrl, TOKENS.agent_a, "/v1/prompt/status");
    assert.equal(status.response.status, 200);
    assert.equal(status.json.revision, 2);
    assert.deepEqual(status.json.history.map((entry) => entry.revision), [0, 1, 2]);

    const reset = await request(baseUrl, TOKENS.agent_a, "/v1/prompt/reset", {
      method: "POST",
      body: { expectedRevision: 2 },
    });
    assert.equal(reset.response.status, 200);
    assert.equal(reset.json.revision, 3);
    assert.equal(reset.json.action, "reset");
    assert.deepEqual(cameraCalls, []);
  } finally {
    await app.close();
  }
});

test("prompt HTTP routes accept arbitrary valid configured principal IDs", async () => {
  const principals = ["ops", "desk-cam_01"];
  const { app, baseUrl, tokens } = await makeServer(principals);
  try {
    const replaced = await request(baseUrl, tokens.ops, "/v1/prompt/replace", {
      method: "POST",
      body: { prompt: "Desk camera experiment", expectedRevision: 0 },
    });
    assert.equal(replaced.response.status, 200);
    assert.equal(replaced.json.updatedBy, "ops");
    const status = await request(baseUrl, tokens["desk-cam_01"], "/v1/prompt/status");
    assert.equal(status.response.status, 200);
    assert.equal(status.json.updatedBy, "ops");
  } finally {
    await app.close();
  }
});

test("prompt HTTP mutation rejects stale expected revision with 409", async () => {
  const { app, baseUrl } = await makeServer();
  try {
    await request(baseUrl, TOKENS.operator, "/v1/prompt/replace", {
      method: "POST",
      body: { prompt: "Revision one", expectedRevision: 0 },
    });
    const stale = await request(baseUrl, TOKENS.agent_a, "/v1/prompt/append", {
      method: "POST",
      body: { text: "stale", expectedRevision: 0 },
    });
    assert.equal(stale.response.status, 409);
    assert.deepEqual(stale.json, { error: "camera bridge conflict" });
  } finally {
    await app.close();
  }
});

test("prompt replacement accepts a complete prompt larger than four KiB", async () => {
  const { app, baseUrl } = await makeServer();
  try {
    const prompt = "x".repeat(5_000);
    const result = await request(baseUrl, TOKENS.operator, "/v1/prompt/replace", {
      method: "POST",
      body: { prompt, expectedRevision: 0 },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.json.chars, 5_000);
  } finally {
    await app.close();
  }
});

test("prompt transport accepts sixteen thousand worst-case escaped characters", async () => {
  const { app, baseUrl } = await makeServer();
  try {
    const prompt = "\u0001".repeat(16_000);
    const result = await request(baseUrl, TOKENS.operator, "/v1/prompt/replace", {
      method: "POST",
      body: { prompt, expectedRevision: 0 },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.json.chars, 16_000);
  } finally {
    await app.close();
  }
});

test("real bridge Stop returns terminal state with visible prompt metadata", async () => {
  const { app, baseUrl, cameraCalls } = await makeServer();
  try {
    const stopped = await request(baseUrl, TOKENS.operator, "/v1/stop", {
      method: "POST",
      body: {},
    });
    assert.equal(stopped.response.status, 200);
    assert.equal(stopped.json.active, false);
    assert.equal(stopped.json.reason, "stopped");
    assert.equal(stopped.json.parked, true);
    assert.equal(stopped.json.promptRevision, 0);
    assert.equal(stopped.json.promptUpdatedBy, "system");
    assert.deepEqual(cameraCalls, ["sleep"]);
  } finally {
    await app.close();
  }
});
