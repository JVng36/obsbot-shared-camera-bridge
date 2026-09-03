import assert from "node:assert/strict";
import test from "node:test";

import { initializeBridge, initializeMedia, parseArgs } from "../src/main.js";

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
