import assert from "node:assert/strict";
import test from "node:test";

import { SharedCameraBridge } from "../src/bridge.js";
import { PromptStore } from "../src/prompt-store.js";
import { CameraSession } from "../src/session.js";

const PRINCIPALS = ["operator", "agent_a", "agent_b"];

function makeBridge() {
  const deviceCalls = [];
  const visionCalls = [];
  const session = new CameraSession({
    durationMs: 60_000,
    now: () => 1_000,
    allowedAgents: PRINCIPALS,
  });
  const promptStore = new PromptStore({ now: () => 1_000, allowedActors: PRINCIPALS });
  const bridge = new SharedCameraBridge({
    session,
    promptStore,
    device: {
      async snapshot() {
        deviceCalls.push("snapshot");
        return { base64: "frame", mime: "image/jpeg", width: 640, height: 360 };
      },
      async sleep() { deviceCalls.push("sleep"); },
    },
    vision: {
      async describe(input) {
        visionCalls.push(input);
        return "Live prompt result";
      },
    },
    now: () => 1_000,
    minLookIntervalMs: 0,
  });
  return { bridge, deviceCalls, visionCalls };
}

test("prompt edits are shared, revisioned, and camera-free", () => {
  const { bridge, deviceCalls } = makeBridge();

  const initial = bridge.promptGet("operator");
  const replaced = bridge.promptReplace("operator", {
    prompt: "Describe everything as a cheerful field researcher.",
    expectedRevision: initial.revision,
  });
  const appended = bridge.promptAppend("agent_b", {
    text: "Mention visual composition and lighting.",
    expectedRevision: replaced.revision,
  });

  assert.equal(appended.revision, 2);
  assert.equal(appended.updatedBy, "agent_b");
  assert.equal(bridge.promptStatus("agent_a").revision, 2);
  assert.equal(
    bridge.promptGet("agent_a").prompt,
    "Describe everything as a cheerful field researcher.\n\nMention visual composition and lighting.",
  );
  assert.deepEqual(deviceCalls, []);

  const reset = bridge.promptReset("agent_a", { expectedRevision: 2 });
  assert.equal(reset.revision, 3);
  assert.equal(reset.action, "reset");
});

test("next look uses the latest prompt revision and reports it", async () => {
  const { bridge, visionCalls } = makeBridge();
  bridge.promptReplace("operator", {
    prompt: "Use concise stage-direction language.",
    expectedRevision: 0,
  });

  const result = await bridge.look("agent_a", { question: "What is visible?" });

  assert.equal(result.promptRevision, 1);
  assert.equal(visionCalls.length, 1);
  assert.equal(visionCalls[0].systemPrompt, "Use concise stage-direction language.");
});

test("camera status visibly includes shared prompt metadata", () => {
  const { bridge } = makeBridge();
  bridge.promptReplace("agent_b", { prompt: "agent_b experiment", expectedRevision: 0 });

  const status = bridge.status();
  assert.equal(status.promptRevision, 1);
  assert.equal(status.promptUpdatedBy, "agent_b");
  assert.equal(status.promptAction, "replace");
  assert.equal(status.promptChars, "agent_b experiment".length);
  assert.match(status.promptSha256, /^[a-f0-9]{64}$/);
});

test("prompt edits fail after Stop and stale revisions remain rejected", async () => {
  const { bridge } = makeBridge();
  bridge.promptReplace("operator", { prompt: "Revision one", expectedRevision: 0 });
  assert.throws(
    () => bridge.promptAppend("agent_a", { text: "stale", expectedRevision: 0 }),
    /revision conflict/i,
  );

  await bridge.stop("operator");
  assert.throws(() => bridge.promptGet("agent_b"), /session is off/i);
  assert.throws(
    () => bridge.promptReset("operator", { expectedRevision: 1 }),
    /session is off/i,
  );
});
