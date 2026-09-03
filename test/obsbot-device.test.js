import assert from "node:assert/strict";
import test from "node:test";

import { ObsbotDevice } from "../src/obsbot-device.js";

test("device adapter exposes one in-memory snapshot and no recording surface", async () => {
  const calls = [];
  const vendorResult = {
    content: [
      { type: "image", data: "SlBFR19CQVNFNjQ=", mimeType: "image/jpeg" },
      { type: "text", text: JSON.stringify({ width: 1280, height: 720, source: "device" }) },
    ],
  };
  const device = new ObsbotDevice({
    invoke: async (tool, args) => {
      calls.push([tool, args]);
      if (tool === "obsbot_wake") return { ok: true };
      if (tool === "obsbot_capture_snapshot") {
        return vendorResult;
      }
      throw new Error(`unexpected tool ${tool}`);
    },
  });

  const frame = await device.snapshot({ maxDim: 1280, quality: 85, settleMs: 600 });

  assert.deepEqual(frame, {
    base64: "SlBFR19CQVNFNjQ=",
    mime: "image/jpeg",
    width: 1280,
    height: 720,
  });
  assert.deepEqual(calls, [
    ["obsbot_wake", {}],
    ["obsbot_capture_snapshot", {
      resolution: 1280,
      quality: 85,
      settleMs: 600,
      source: "device",
    }],
  ]);
  assert.equal(typeof device.record, "undefined");
  assert.equal(typeof device.preview, "undefined");
  assert.equal(typeof device.raw, "undefined");
  assert.equal(typeof device.follow, "undefined");
  assert.equal(vendorResult.content[0].data, "");
});

test("snapshot rejects malformed vendor frames and always scrubs the original result", async () => {
  const cases = [
    {
      name: "invalid metadata JSON",
      image: { type: "image", data: "QUJDRA==", mimeType: "image/jpeg" },
      text: "not-json",
      error: /invalid snapshot metadata/i,
    },
    {
      name: "missing dimensions",
      image: { type: "image", data: "QUJDRA==", mimeType: "image/jpeg" },
      text: JSON.stringify({ width: 640 }),
      error: /snapshot dimensions/i,
    },
    {
      name: "dimensions exceed requested bound",
      image: { type: "image", data: "QUJDRA==", mimeType: "image/jpeg" },
      text: JSON.stringify({ width: 1281, height: 720 }),
      error: /snapshot dimensions/i,
    },
    {
      name: "unsupported MIME",
      image: { type: "image", data: "QUJDRA==", mimeType: "image/gif" },
      text: JSON.stringify({ width: 640, height: 360 }),
      error: /snapshot image type/i,
    },
    {
      name: "invalid base64",
      image: { type: "image", data: "NOT_BASE64_!", mimeType: "image/jpeg" },
      text: JSON.stringify({ width: 640, height: 360 }),
      error: /snapshot image data/i,
    },
    {
      name: "oversized base64",
      image: { type: "image", data: "A".repeat(8_000_004), mimeType: "image/jpeg" },
      text: JSON.stringify({ width: 640, height: 360 }),
      error: /snapshot image data/i,
    },
  ];

  for (const scenario of cases) {
    await test(scenario.name, async () => {
      const vendorResult = {
        content: [scenario.image, { type: "text", text: scenario.text }],
      };
      const device = new ObsbotDevice({
        invoke: async (tool) => {
          if (tool === "obsbot_wake") return { ok: true };
          if (tool === "obsbot_capture_snapshot") return vendorResult;
          throw new Error(`unexpected tool ${tool}`);
        },
      });

      await assert.rejects(
        device.snapshot({ maxDim: 1280, quality: 85, settleMs: 600 }),
        scenario.error,
      );
      assert.equal(vendorResult.content[0].data, "");
    });
  }
});

test("device adapter maps only bounded PTZ and sleep operations", async () => {
  const calls = [];
  const device = new ObsbotDevice({
    invoke: async (tool, args) => {
      calls.push([tool, args]);
      return { ok: true };
    },
  });

  await device.move(20, -5);
  await device.recenter();
  await device.sleep();

  assert.deepEqual(calls, [
    ["obsbot_gimbal_move", { yaw: 20, pitch: -5, roll: 0 }],
    ["obsbot_gimbal_recenter", {}],
    ["obsbot_sleep", {}],
  ]);
});

test("interrupt closes the active helper before parking through a fresh backend", async () => {
  const events = [];
  const device = new ObsbotDevice({
    invoke: async () => { throw new Error("old backend must not receive sleep"); },
    shutdown: async () => { events.push("old-shutdown"); },
    restart: async () => {
      events.push("restart");
      return {
        invoke: async (tool, args) => {
          events.push([tool, args]);
          return { ok: true };
        },
        shutdown: async () => { events.push("new-shutdown"); },
      };
    },
  });

  const parked = await device.interruptAndSleep();
  await device.shutdown();

  assert.equal(parked, true);
  assert.deepEqual(events, [
    "old-shutdown",
    "restart",
    ["obsbot_sleep", {}],
    "new-shutdown",
  ]);
});

test("shutdown is idempotent for the currently owned backend", async () => {
  let shutdownCalls = 0;
  const device = new ObsbotDevice({
    invoke: async () => ({ ok: true }),
    shutdown: async () => { shutdownCalls += 1; },
  });

  await Promise.all([device.shutdown(), device.shutdown(), device.shutdown()]);

  assert.equal(shutdownCalls, 1);
});

test("concurrent interrupts share one backend replacement", async () => {
  const events = [];
  let releaseOldShutdown;
  const oldShutdownGate = new Promise((resolve) => { releaseOldShutdown = resolve; });
  const device = new ObsbotDevice({
    invoke: async () => ({ ok: true }),
    shutdown: async () => {
      events.push("old-shutdown");
      await oldShutdownGate;
    },
    restart: async () => {
      events.push("restart");
      return {
        invoke: async (tool) => { events.push(tool); return { ok: true }; },
        shutdown: async () => { events.push("new-shutdown"); },
      };
    },
  });

  const first = device.interruptAndSleep();
  const second = device.interruptAndSleep();
  await new Promise((resolve) => setImmediate(resolve));
  releaseOldShutdown();

  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  await device.shutdown();
  assert.deepEqual(events, [
    "old-shutdown",
    "restart",
    "obsbot_sleep",
    "new-shutdown",
  ]);
});

test("snapshot cannot migrate from an old wake onto the replacement backend", async () => {
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
      if (tool === "obsbot_capture_snapshot") {
        throw new Error("old backend must not capture after shutdown");
      }
      return { ok: true };
    },
    shutdown: async () => { events.push("old:shutdown"); },
    restart: async () => ({
      invoke: async (tool) => {
        events.push(`new:${tool}`);
        if (tool === "obsbot_capture_snapshot") {
          throw new Error("replacement backend must never receive stale capture");
        }
        return { ok: true };
      },
      shutdown: async () => { events.push("new:shutdown"); },
    }),
  });

  const pendingSnapshot = device.snapshot({ maxDim: 640, quality: 80, settleMs: 0 });
  await oldWakeStarted;
  assert.equal(await device.interruptAndSleep(), true);
  events.push("stop:resolved");
  releaseOldWake();

  await assert.rejects(pendingSnapshot, /backend.*changed|backend.*closed/i);
  assert.deepEqual(events, [
    "old:obsbot_wake",
    "old:shutdown",
    "new:obsbot_sleep",
    "stop:resolved",
  ]);
});

test("terminal shutdown during old-backend close prevents replacement", async () => {
  const events = [];
  let releaseOldShutdown;
  let markOldShutdownStarted;
  const oldShutdownStarted = new Promise((resolve) => { markOldShutdownStarted = resolve; });
  const device = new ObsbotDevice({
    invoke: async () => ({ ok: true }),
    shutdown: async () => {
      events.push("old:shutdown");
      markOldShutdownStarted();
      await new Promise((resolve) => { releaseOldShutdown = resolve; });
    },
    restart: async () => {
      events.push("restart");
      return { invoke: async () => ({ ok: true }), shutdown: async () => {} };
    },
  });

  const interrupt = device.interruptAndSleep();
  await oldShutdownStarted;
  const terminal = device.shutdown();
  releaseOldShutdown();

  await assert.rejects(interrupt, /terminal/i);
  await terminal;
  await assert.rejects(device.status(), /terminal/i);
  assert.deepEqual(events, ["old:shutdown"]);
});

test("terminal shutdown during restart closes the returned replacement", async () => {
  const events = [];
  let releaseRestart;
  let markRestartStarted;
  const restartStarted = new Promise((resolve) => { markRestartStarted = resolve; });
  const device = new ObsbotDevice({
    invoke: async () => ({ ok: true }),
    shutdown: async () => { events.push("old:shutdown"); },
    restart: async () => {
      events.push("restart");
      markRestartStarted();
      await new Promise((resolve) => { releaseRestart = resolve; });
      return {
        invoke: async () => ({ ok: true }),
        shutdown: async () => { events.push("new:shutdown"); },
      };
    },
  });

  const interrupt = device.interruptAndSleep();
  await restartStarted;
  const terminal = device.shutdown();
  releaseRestart();

  await assert.rejects(interrupt, /terminal/i);
  await terminal;
  await assert.rejects(device.move(1, 1), /terminal/i);
  assert.deepEqual(events, ["old:shutdown", "restart", "new:shutdown"]);
});

test("terminal shutdown reports an uninstalled replacement close failure", async () => {
  let releaseRestart;
  let markRestartStarted;
  const restartStarted = new Promise((resolve) => { markRestartStarted = resolve; });
  const device = new ObsbotDevice({
    invoke: async () => ({ ok: true }),
    shutdown: async () => {},
    restart: async () => {
      markRestartStarted();
      await new Promise((resolve) => { releaseRestart = resolve; });
      return {
        invoke: async () => ({ ok: true }),
        shutdown: async () => { throw new Error("replacement close failed"); },
      };
    },
  });

  const interrupt = device.interruptAndSleep();
  await restartStarted;
  const terminal = device.shutdown();
  releaseRestart();

  await assert.rejects(interrupt, /replacement close failed/i);
  await assert.rejects(
    terminal,
    (error) => error instanceof AggregateError
      && error.errors.some((child) => /replacement close failed/i.test(child.message)),
  );
});

test("terminal shutdown during replacement sleep closes replacement exactly once", async () => {
  const events = [];
  let releaseSleep;
  let markSleepStarted;
  const sleepStarted = new Promise((resolve) => { markSleepStarted = resolve; });
  const device = new ObsbotDevice({
    invoke: async () => ({ ok: true }),
    shutdown: async () => { events.push("old:shutdown"); },
    restart: async () => ({
      invoke: async (tool) => {
        events.push(`new:${tool}`);
        if (tool === "obsbot_sleep") {
          markSleepStarted();
          await new Promise((resolve) => { releaseSleep = resolve; });
        }
        return { ok: true };
      },
      shutdown: async () => {
        events.push("new:shutdown");
        releaseSleep();
      },
    }),
  });

  const interrupt = device.interruptAndSleep();
  await sleepStarted;
  const terminal = device.shutdown();
  const [interruptResult, terminalResult] = await Promise.race([
    Promise.allSettled([interrupt, terminal]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("terminal shutdown deadlocked")), 250)),
  ]);

  assert.equal(interruptResult.status, "rejected");
  assert.match(interruptResult.reason.message, /terminal/i);
  assert.equal(terminalResult.status, "fulfilled");
  await assert.rejects(device.recenter(), /terminal/i);
  assert.deepEqual(events, ["old:shutdown", "new:obsbot_sleep", "new:shutdown"]);
});
