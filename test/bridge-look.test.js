import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SharedCameraBridge } from "../src/bridge.js";
import { CameraSession } from "../src/session.js";

const OBSERVATION_VECTORS = JSON.parse(readFileSync(
  new URL("../clients/hermes-plugin/observation-text-vectors.json", import.meta.url),
  "utf8",
));

function activeSession(now = () => 1_000) {
  return new CameraSession({
    durationMs: 60_000,
    now,
    allowedAgents: ["agent_a", "agent_b"],
  });
}

test("look sends the frame only to local vision and returns text only", async () => {
  const frameMarker = "PRIVATE_BASE64_FRAME_BYTES";
  const calls = [];
  const capturedFrame = {
    base64: frameMarker,
    mime: "image/jpeg",
    width: 1280,
    height: 720,
  };
  const device = {
    async snapshot(options) {
      calls.push(["snapshot", options]);
      return capturedFrame;
    },
  };
  const vision = {
    async describe(input) {
      calls.push(["vision", input]);
      assert.equal(input.imageBase64, frameMarker);
      assert.equal(input.question, "What is the person doing?");
      return "A person is seated and holding a mug.";
    },
  };
  const bridge = new SharedCameraBridge({
    session: activeSession(),
    device,
    vision,
    now: () => 1_000,
  });

  const result = await bridge.look("agent_a", { question: "What is the person doing?" });

  assert.deepEqual(calls.map(([name]) => name), ["snapshot", "vision"]);
  assert.equal(result.viewer, "agent_a");
  assert.equal(result.description, "A person is seated and holding a mug.");
  assert.equal(result.width, 1280);
  assert.equal(result.height, 720);
  assert.equal("image" in result, false);
  assert.equal("base64" in result, false);
  assert.equal(JSON.stringify(result).includes(frameMarker), false);
  assert.equal(capturedFrame.base64, "");
});

test("look rejects media-bearing VLM text and still scrubs the frame", async () => {
  for (const description of OBSERVATION_VECTORS.forbidden) {
    const frame = { base64: "frame", mime: "image/jpeg", width: 640, height: 360 };
    const bridge = new SharedCameraBridge({
      session: activeSession(),
      device: { async snapshot() { return frame; } },
      vision: { async describe() { return description; } },
      minLookIntervalMs: 0,
    });

    await assert.rejects(
      bridge.look("agent_a", { question: "What is visible?" }),
      /prohibited media-like observation/i,
    );
    assert.equal(frame.base64, "");
  }
});

test("look limits are independent per agent and never become a stream", async () => {
  let now = 1_000;
  let snapshots = 0;
  const bridge = new SharedCameraBridge({
    session: activeSession(() => now),
    device: {
      async snapshot() {
        snapshots += 1;
        return { base64: "frame", mime: "image/jpeg", width: 640, height: 360 };
      },
    },
    vision: { async describe() { return "A direct observation."; } },
    now: () => now,
    minLookIntervalMs: 2_000,
    maxLooksPerAgent: 2,
  });

  await bridge.look("agent_a");
  await assert.rejects(() => bridge.look("agent_a"), /wait before looking again/i);
  await bridge.look("agent_b");
  assert.equal(snapshots, 2);

  now += 2_000;
  await bridge.look("agent_a");
  now += 2_000;
  await assert.rejects(() => bridge.look("agent_a"), /look limit reached/i);
  assert.equal(snapshots, 3);
});

test("concurrent looks serialize physical camera capture", async () => {
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let firstStarted;
  const sawFirstStart = new Promise((resolve) => { firstStarted = resolve; });
  let activeCaptures = 0;
  let maxActiveCaptures = 0;
  let captureNumber = 0;

  const bridge = new SharedCameraBridge({
    session: activeSession(),
    device: {
      async snapshot() {
        captureNumber += 1;
        const mine = captureNumber;
        activeCaptures += 1;
        maxActiveCaptures = Math.max(maxActiveCaptures, activeCaptures);
        if (mine === 1) {
          firstStarted();
          await firstBlocked;
        }
        activeCaptures -= 1;
        return { base64: `frame-${mine}`, mime: "image/jpeg", width: 640, height: 360 };
      },
    },
    vision: { async describe({ imageBase64 }) { return imageBase64; } },
    now: () => 1_000,
  });

  const agentALook = bridge.look("agent_a");
  await sawFirstStart;
  const agentBLook = bridge.look("agent_b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captureNumber, 1);

  releaseFirst();
  await Promise.all([agentALook, agentBLook]);
  assert.equal(maxActiveCaptures, 1);
  assert.equal(captureNumber, 2);
});

test("in-flight looks reserve quota before vision completes", async () => {
  let resolveFirstVision;
  let markFirstVisionStarted;
  const firstVisionStarted = new Promise((resolve) => { markFirstVisionStarted = resolve; });
  let snapshots = 0;
  let visionCalls = 0;
  const bridge = new SharedCameraBridge({
    session: activeSession(),
    device: {
      async snapshot() {
        snapshots += 1;
        return { base64: `frame-${snapshots}`, mime: "image/jpeg", width: 640, height: 360 };
      },
    },
    vision: {
      async describe() {
        visionCalls += 1;
        if (visionCalls === 1) {
          markFirstVisionStarted();
          return new Promise((resolve) => { resolveFirstVision = resolve; });
        }
        return "A second observation that must never run.";
      },
    },
    now: () => 1_000,
    minLookIntervalMs: 0,
    maxLooksPerAgent: 1,
  });

  const firstLook = bridge.look("agent_a");
  await firstVisionStarted;
  const secondLookRejection = assert.rejects(
    bridge.look("agent_a"),
    /look limit reached/i,
  );
  await new Promise((resolve) => setImmediate(resolve));
  resolveFirstVision("The permitted observation.");
  await firstLook;

  await secondLookRejection;
  assert.equal(snapshots, 1);
  assert.equal(visionCalls, 1);
});

test("frame bytes are cleared when stop wins before vision starts", async () => {
  const frame = {
    base64: "PRIVATE_PRE_VISION_FRAME",
    mime: "image/jpeg",
    width: 640,
    height: 360,
  };
  let bridge;
  let stopPromise;
  let visionCalls = 0;
  bridge = new SharedCameraBridge({
    session: activeSession(),
    device: {
      snapshot() {
        return new Promise((resolve) => {
          queueMicrotask(() => {
            resolve(frame);
            stopPromise = bridge.stop("agent_b");
          });
        });
      },
      async sleep() {},
    },
    vision: {
      async describe() {
        visionCalls += 1;
        return "must not run";
      },
    },
    now: () => 1_000,
  });

  await assert.rejects(
    bridge.look("agent_a"),
    /discarded.*session stopped/i,
  );
  await stopPromise;
  assert.equal(frame.base64, "");
  assert.equal(visionCalls, 0);
});
