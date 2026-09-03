import assert from "node:assert/strict";
import test from "node:test";

import { CameraSession } from "../src/session.js";

test("session is active only until its hard deadline", () => {
  let now = 1_000;
  const session = new CameraSession({
    durationMs: 5_000,
    now: () => now,
    allowedAgents: ["agent_a", "agent_b"],
  });

  assert.equal(session.status().active, true);
  assert.equal(session.status().expiresAtMs, 6_000);

  now = 5_999;
  assert.equal(session.status().active, true);

  now = 6_000;
  assert.equal(session.status().active, false);
  assert.equal(session.status().reason, "expired");
});

test("stopped or expired sessions cannot be reactivated", () => {
  const session = new CameraSession({
    durationMs: 5_000,
    now: () => 1_000,
    allowedAgents: ["agent_a", "agent_b"],
  });

  session.stop("agent_a", "operator withdrew consent");
  assert.equal(session.status().active, false);
  assert.equal(session.status().reason, "stopped");
  assert.equal(typeof session.start, "undefined");
  assert.throws(() => session.assertActive("agent_b"), /camera session is off/i);
});

test("unknown agents cannot use a session", () => {
  const session = new CameraSession({
    durationMs: 5_000,
    now: () => 1_000,
    allowedAgents: ["agent_a", "agent_b"],
  });

  assert.throws(() => session.assertActive("intruder"), /agent is not allowed/i);
});

test("operator termination is terminal and records only a bounded reason", () => {
  const session = new CameraSession({
    durationMs: 5_000,
    now: () => 1_000,
    allowedAgents: ["agent_a", "agent_b"],
  });

  session.terminate("operator");
  assert.deepEqual(session.status(), {
    active: false,
    expiresAtMs: 6_000,
    reason: "operator",
  });
  assert.throws(() => session.terminate("arbitrary private details"), /termination reason/i);
});

test("the first terminal reason cannot be overwritten", () => {
  const stopped = new CameraSession({
    durationMs: 5_000,
    now: () => 1_000,
    allowedAgents: ["agent_a", "agent_b"],
  });
  stopped.stop("agent_a");
  stopped.terminate("expired");
  assert.equal(stopped.status().reason, "stopped");

  const operatorEnded = new CameraSession({
    durationMs: 5_000,
    now: () => 1_000,
    allowedAgents: ["agent_a", "agent_b"],
  });
  operatorEnded.terminate("operator");
  operatorEnded.stop("agent_b");
  assert.equal(operatorEnded.status().reason, "operator");
});
