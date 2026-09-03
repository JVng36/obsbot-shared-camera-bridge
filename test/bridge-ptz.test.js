import assert from "node:assert/strict";
import test from "node:test";

import { SharedCameraBridge } from "../src/bridge.js";
import { CameraSession } from "../src/session.js";

function makeBridge(nowRef, moves) {
  return new SharedCameraBridge({
    session: new CameraSession({
      durationMs: 60_000,
      now: () => nowRef.value,
      allowedAgents: ["agent_a", "agent_b"],
    }),
    device: {
      async move(yaw, pitch) { moves.push(["move", yaw, pitch]); },
      async recenter() { moves.push(["recenter"]); },
    },
    vision: {},
    now: () => nowRef.value,
    ptzLeaseMs: 15_000,
  });
}

test("one agent holds the PTZ lease until its bounded expiry", async () => {
  const now = { value: 1_000 };
  const moves = [];
  const bridge = makeBridge(now, moves);

  const first = await bridge.move("agent_a", { yaw: 25, pitch: 10 });
  assert.equal(first.leaseHolder, "agent_a");
  assert.equal(first.leaseExpiresAtMs, 16_000);

  await assert.rejects(
    () => bridge.move("agent_b", { yaw: -10, pitch: 5 }),
    /PTZ lease is held by agent_a/i,
  );

  now.value = 16_000;
  const second = await bridge.move("agent_b", { yaw: -10, pitch: 5 });
  assert.equal(second.leaseHolder, "agent_b");
  assert.deepEqual(moves, [
    ["move", 25, 10],
    ["move", -10, 5],
  ]);
});

test("PTZ refuses angles outside the forward privacy zone", async () => {
  const now = { value: 1_000 };
  const moves = [];
  const bridge = makeBridge(now, moves);

  for (const request of [
    { yaw: 61, pitch: 0 },
    { yaw: -61, pitch: 0 },
    { yaw: 0, pitch: -31 },
    { yaw: 0, pitch: 46 },
    { yaw: Number.NaN, pitch: 0 },
  ]) {
    await assert.rejects(() => bridge.move("agent_a", request), /forward privacy zone/i);
  }
  assert.deepEqual(moves, []);
});

test("PTZ lease never extends past the camera session deadline", async () => {
  const now = { value: 1_000 };
  const moves = [];
  const bridge = makeBridge(now, moves);

  now.value = 60_500;
  const result = await bridge.move("agent_a", { yaw: 5, pitch: 5 });

  assert.equal(result.leaseExpiresAtMs, 61_000);
});

test("a queued PTZ command cannot execute after its lease transfers", async () => {
  const now = { value: 1_000 };
  let releaseSnapshot;
  let markSnapshotStarted;
  const snapshotStarted = new Promise((resolve) => { markSnapshotStarted = resolve; });
  const events = [];
  const bridge = new SharedCameraBridge({
    session: new CameraSession({
      durationMs: 60_000,
      now: () => now.value,
      allowedAgents: ["agent_a", "agent_b"],
    }),
    device: {
      async snapshot() {
        events.push("snapshot");
        markSnapshotStarted();
        await new Promise((resolve) => { releaseSnapshot = resolve; });
        return { base64: "frame", mime: "image/jpeg", width: 640, height: 360 };
      },
      async move(yaw, pitch) { events.push(["move", yaw, pitch]); },
    },
    vision: { async describe() { return "A direct observation."; } },
    now: () => now.value,
    ptzLeaseMs: 15_000,
  });

  const occupyingLook = bridge.look("agent_b");
  await snapshotStarted;
  const staleAgentAMove = bridge.move("agent_a", { yaw: 10, pitch: 5 });
  now.value = 16_000;
  const currentAgentBMove = bridge.move("agent_b", { yaw: -10, pitch: 5 });
  releaseSnapshot();

  await occupyingLook;
  await assert.rejects(staleAgentAMove, /PTZ lease is no longer valid/i);
  await currentAgentBMove;
  assert.deepEqual(events, ["snapshot", ["move", -10, 5]]);
});
