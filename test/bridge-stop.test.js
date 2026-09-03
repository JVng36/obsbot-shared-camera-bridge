import assert from "node:assert/strict";
import test from "node:test";

import { SharedCameraBridge } from "../src/bridge.js";
import { ObsbotDevice } from "../src/obsbot-device.js";
import { CameraSession } from "../src/session.js";

function makeSession() {
  return new CameraSession({
    durationMs: 60_000,
    now: () => 1_000,
    allowedAgents: ["agent_a", "agent_b"],
  });
}

test("stop aborts local vision, parks the camera, and discards a late result", async () => {
  let resolveVision;
  let visionSignal;
  let markVisionStarted;
  const visionStarted = new Promise((resolve) => { markVisionStarted = resolve; });
  const events = [];

  const bridge = new SharedCameraBridge({
    session: makeSession(),
    device: {
      async snapshot() {
        events.push("snapshot");
        return { base64: "private-frame", mime: "image/jpeg", width: 640, height: 360 };
      },
      async sleep() {
        events.push("sleep");
      },
    },
    vision: {
      async describe({ signal }) {
        visionSignal = signal;
        markVisionStarted();
        return new Promise((resolve) => { resolveVision = resolve; });
      },
    },
    now: () => 1_000,
  });

  const pendingLook = bridge.look("agent_b");
  await visionStarted;
  const stopPromise = bridge.stop("agent_a", { reason: "operator withdrew consent" });

  assert.equal(visionSignal.aborted, true);
  resolveVision("This late observation must not escape.");
  await stopPromise;

  await assert.rejects(pendingLook, /discarded.*session stopped/i);
  assert.deepEqual(events, ["snapshot", "sleep"]);
  assert.equal(bridge.status().active, false);
});

test("operator or deadline termination parks the camera without impersonating an agent", async () => {
  const events = [];
  const bridge = new SharedCameraBridge({
    session: makeSession(),
    device: { async sleep() { events.push("sleep"); } },
    vision: {},
    now: () => 1_000,
  });

  const result = await bridge.terminate("operator");

  assert.equal(result.active, false);
  assert.equal(result.reason, "operator");
  assert.deepEqual(events, ["sleep"]);
});

test("stop interrupts a blocked native snapshot instead of waiting behind it", async () => {
  let rejectSnapshot;
  let markSnapshotStarted;
  const snapshotStarted = new Promise((resolve) => { markSnapshotStarted = resolve; });
  const events = [];
  const bridge = new SharedCameraBridge({
    session: makeSession(),
    device: {
      async snapshot() {
        events.push("snapshot");
        markSnapshotStarted();
        return new Promise((_resolve, reject) => { rejectSnapshot = reject; });
      },
      async interruptAndSleep() {
        events.push("interrupt-and-sleep");
        rejectSnapshot(new Error("native snapshot interrupted"));
        return true;
      },
    },
    vision: { async describe() { throw new Error("vision must not start"); } },
    now: () => 1_000,
  });

  const pendingLook = bridge.look("agent_b");
  await snapshotStarted;
  const stopResult = await Promise.race([
    bridge.stop("agent_a"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("stop timed out")), 100)),
  ]);

  assert.equal(stopResult.active, false);
  assert.equal(stopResult.parked, true);
  await assert.rejects(pendingLook, /discarded.*session stopped/i);
  assert.deepEqual(events, ["snapshot", "interrupt-and-sleep"]);
});

test("a queued snapshot is rejected after stop without touching the camera", async () => {
  let rejectSnapshot;
  let snapshotCount = 0;
  let markSnapshotStarted;
  const snapshotStarted = new Promise((resolve) => { markSnapshotStarted = resolve; });
  const events = [];
  const bridge = new SharedCameraBridge({
    session: makeSession(),
    device: {
      async snapshot() {
        snapshotCount += 1;
        events.push(`snapshot-${snapshotCount}`);
        if (snapshotCount === 1) {
          markSnapshotStarted();
          return new Promise((_resolve, reject) => { rejectSnapshot = reject; });
        }
        return { base64: "post-stop-frame", mime: "image/jpeg", width: 640, height: 360 };
      },
      async interruptAndSleep() {
        events.push("interrupt-and-sleep");
        rejectSnapshot(new Error("native snapshot interrupted"));
        return true;
      },
    },
    vision: { async describe() { return "unused"; } },
    now: () => 1_000,
  });

  const activeLook = bridge.look("agent_a");
  await snapshotStarted;
  const queuedLook = bridge.look("agent_b");
  await bridge.stop("agent_a");

  await assert.rejects(activeLook, /discarded.*session stopped/i);
  await assert.rejects(queuedLook, /discarded.*session stopped|session is off/i);
  assert.deepEqual(events, ["snapshot-1", "interrupt-and-sleep"]);
});

test("a queued PTZ command is rejected after stop without moving the camera", async () => {
  let rejectSnapshot;
  let markSnapshotStarted;
  const snapshotStarted = new Promise((resolve) => { markSnapshotStarted = resolve; });
  const events = [];
  const bridge = new SharedCameraBridge({
    session: makeSession(),
    device: {
      async snapshot() {
        events.push("snapshot");
        markSnapshotStarted();
        return new Promise((_resolve, reject) => { rejectSnapshot = reject; });
      },
      async move(yaw, pitch) { events.push(["move", yaw, pitch]); },
      async interruptAndSleep() {
        events.push("interrupt-and-sleep");
        rejectSnapshot(new Error("native snapshot interrupted"));
        return true;
      },
    },
    vision: { async describe() { return "unused"; } },
    now: () => 1_000,
  });

  const activeLook = bridge.look("agent_b");
  await snapshotStarted;
  const queuedMove = bridge.move("agent_a", { yaw: 10, pitch: 5 });
  await bridge.stop("agent_b");

  await assert.rejects(activeLook, /discarded.*session stopped/i);
  await assert.rejects(queuedMove, /discarded.*session stopped|session is off/i);
  assert.deepEqual(events, ["snapshot", "interrupt-and-sleep"]);
});

test("concurrent terminal paths share one quiesce operation", async () => {
  let releaseParking;
  let interruptCalls = 0;
  const bridge = new SharedCameraBridge({
    session: makeSession(),
    device: {
      async interruptAndSleep() {
        interruptCalls += 1;
        await new Promise((resolve) => { releaseParking = resolve; });
        return true;
      },
    },
    vision: {},
    now: () => 1_000,
  });

  const userStop = bridge.stop("agent_a");
  const expiryStop = bridge.terminate("expired");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interruptCalls, 1);
  releaseParking();

  const [userResult, expiryResult] = await Promise.all([userStop, expiryStop]);
  assert.deepEqual(expiryResult, userResult);
  assert.equal(userResult.reason, "stopped");
  assert.equal(userResult.parked, true);
});

test("parking failures return a terminal parked-false result", async () => {
  const events = [];
  const bridge = new SharedCameraBridge({
    session: makeSession(),
    device: {
      async interruptAndSleep() {
        events.push("interrupt-failed");
        throw new Error("park failed");
      },
      async shutdown() {
        events.push("shutdown-failed");
        throw new Error("shutdown failed");
      },
    },
    vision: {},
    now: () => 1_000,
  });

  const result = await bridge.stop("agent_a");

  assert.equal(result.active, false);
  assert.equal(result.parked, false);
  assert.deepEqual(events, ["interrupt-failed", "shutdown-failed"]);
});

test("bridge stop prevents stale device wake from capturing on replacement backend", async () => {
  const events = [];
  let releaseOldWake;
  let markOldWakeStarted;
  const oldWakeStarted = new Promise((resolve) => { markOldWakeStarted = resolve; });
  const device = new ObsbotDevice({
    invoke: async (tool) => {
      events.push(`old:${tool}`);
      if (tool === "obsbot_wake") {
        markOldWakeStarted();
        await new Promise((resolve) => { releaseOldWake = resolve; });
      }
      return { ok: true };
    },
    shutdown: async () => { events.push("old:shutdown"); },
    restart: async () => ({
      invoke: async (tool) => {
        events.push(`new:${tool}`);
        if (tool === "obsbot_capture_snapshot") {
          throw new Error("replacement capture forbidden");
        }
        return { ok: true };
      },
      shutdown: async () => { events.push("new:shutdown"); },
    }),
  });
  const bridge = new SharedCameraBridge({
    session: makeSession(),
    device,
    vision: { async describe() { return "must not run"; } },
    now: () => 1_000,
  });

  const pendingLook = bridge.look("agent_a");
  await oldWakeStarted;
  const stopped = await bridge.stop("agent_b");
  events.push("stop:resolved");
  releaseOldWake();

  assert.equal(stopped.active, false);
  assert.equal(stopped.parked, true);
  await assert.rejects(pendingLook, /discarded.*session stopped|backend.*closed/i);
  assert.deepEqual(events, [
    "old:obsbot_wake",
    "old:shutdown",
    "new:obsbot_sleep",
    "stop:resolved",
  ]);
});
