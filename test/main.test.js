import assert from "node:assert/strict";
import test from "node:test";

import { finishStoppedRuntime, initializeBridge, initializeMedia, parseArgs } from "../src/main.js";
import { ObsbotDevice } from "../src/obsbot-device.js";
import { CameraRuntime } from "../src/runtime.js";

test("entry point requires explicit config and reviewed vendor roots", () => {
  assert.deepEqual(
    parseArgs([
      "--config", "./secrets.json",
      "--vendor-root", "./vendor/obsbot-mcp",
      "--minutes", "30",
    ]),
    {
      configPath: "./secrets.json",
      vendorRoot: "./vendor/obsbot-mcp",
      minutes: 30,
    },
  );

  assert.throws(() => parseArgs([]), /--config.*--vendor-root/i);
  assert.throws(
    () => parseArgs(["--config", "x", "--vendor-root", "y", "--minutes", "thirty"]),
    /--minutes/i,
  );
  assert.throws(
    () => parseArgs(["--config", "x", "--vendor-root", "y", "--surprise", "z"]),
    /unknown argument/i,
  );
});

test("vision configuration is validated before device construction", async () => {
  let deviceFactoryCalls = 0;
  class InvalidVision {
    constructor() {
      throw new Error("vision URL must be loopback");
    }
  }
  class FakeDevice {
    static async fromVendor() {
      deviceFactoryCalls += 1;
      return {};
    }
  }

  await assert.rejects(
    () => initializeMedia(
      { vision: { baseUrl: "https://example.com", model: "bad" } },
      "./vendor",
      { DeviceClass: FakeDevice, VisionClass: InvalidVision, deviceLog: () => {} },
    ),
    /vision URL must be loopback/i,
  );
  assert.equal(deviceFactoryCalls, 0);
});

test("main bridge wiring grants configured principals shared prompt access", () => {
  const { bridge, session, promptStore } = initializeBridge(
    { durationMs: 60_000, principals: ["ops", "desk-cam_01"] },
    {
      device: {},
      vision: {},
      now: () => 1_000,
    },
  );

  assert.equal(session.status().active, true);
  assert.equal(bridge.promptGet("ops").revision, 0);
  assert.equal(promptStore.status("desk-cam_01").revision, 0);
  assert.throws(() => session.assertActive("operator"), /agent is not allowed/i);
  assert.throws(() => promptStore.status("agent_a"), /not allowed to edit/i);
});

for (const mode of ["legacy", "repaired", "failed-sleep"]) {
  test(`synthetic Stop lifecycle: ${mode}`, async () => {
    const events = [];
    let releaseClose;
    let markClose;
    const closing = new Promise((resolve) => { markClose = resolve; });
    const closeGate = new Promise((resolve) => { releaseClose = resolve; });
    const device = new ObsbotDevice({
      invoke: async () => { throw new Error("old backend must receive no commands"); },
      shutdown: async () => {
        events.push("old-close");
        markClose();
        await closeGate;
      },
      restart: async () => {
        events.push("replacement");
        return {
          invoke: async (tool) => {
            assert.equal(tool, "obsbot_sleep");
            events.push("sleep");
            return { ok: mode !== "failed-sleep", state: "sleep" };
          },
          shutdown: async () => { events.push("replacement-close"); },
        };
      },
    });
    const { bridge } = initializeBridge(
      { durationMs: 60_000, principals: ["ops"] },
      { device, vision: {}, now: () => 1_000 },
    );
    const runtime = new CameraRuntime({
      bridge, device, http: { async close() { events.push("http-close"); } },
    });
    const stop = bridge.stop("ops");
    await closing;
    assert.equal(bridge.status().active, false);
    await assert.rejects(bridge.look("ops"), /session is off/i);
    const cleanup = mode === "legacy"
      ? runtime.shutdown("operator", { bridgeAlreadyQuiesced: true })
      : finishStoppedRuntime({ bridge, runtime });
    const cleanupOutcome = Promise.allSettled([cleanup]);
    // Model the setImmediate callback running during an asynchronous close.
    await new Promise((resolve) => setImmediate(resolve));
    if (mode !== "legacy") assert.deepEqual(events, ["old-close"]);
    releaseClose();
    const result = await stop;
    const cleanupResult = await cleanupOutcome;
    assert.equal(result.parked, mode === "repaired");
    assert.equal(result.parkingVerification, "unverified");
    assert.equal(result.active, false);
    assert.equal(result.reason, "stopped");
    assert.equal(cleanupResult[0].status, mode === "failed-sleep" ? "rejected" : "fulfilled");
    assert.deepEqual(events, mode === "legacy"
      ? ["old-close", "http-close"]
      : mode === "failed-sleep"
        ? ["old-close", "replacement", "sleep", "replacement-close", "http-close"]
        : ["old-close", "replacement", "sleep", "http-close", "replacement-close"]);
    await assert.rejects(device.status(), /terminal/i);
  });
}

test("Stop completion still cleans runtime if bridge quiesce rejects", async () => {
  let cleaned = false;
  await assert.rejects(finishStoppedRuntime({
    bridge: { async terminate() { throw new Error("quiesce failed"); } },
    runtime: { async shutdown(reason, options) {
      assert.equal(reason, "operator");
      assert.equal(options.bridgeAlreadyQuiesced, true);
      cleaned = true;
    } },
  }), /quiesce failed/);
  assert.equal(cleaned, true);
});
