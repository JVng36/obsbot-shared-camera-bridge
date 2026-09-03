import assert from "node:assert/strict";
import test from "node:test";

import { CameraRuntime } from "../src/runtime.js";

test("runtime schedules hard expiry and cleans every resource exactly once", async () => {
  const events = [];
  let timerCallback;
  const bridge = {
    status() { return { active: true, expiresAtMs: 6_000 }; },
    async terminate(reason) { events.push(["terminate", reason]); return { active: false }; },
  };
  const http = {
    async listen(options) { events.push(["listen", options]); },
    async close() { events.push(["http-close"]); },
  };
  const device = { async shutdown() { events.push(["device-shutdown"]); } };
  const runtime = new CameraRuntime({
    bridge,
    http,
    device,
    now: () => 1_000,
    setTimer: (callback, delay) => {
      events.push(["timer", delay]);
      timerCallback = callback;
      return 123;
    },
    clearTimer: (handle) => events.push(["clear-timer", handle]),
  });

  await runtime.start({ host: "127.0.0.1", port: 8766 });
  assert.deepEqual(events, [
    ["listen", { host: "127.0.0.1", port: 8766 }],
    ["timer", 5_000],
  ]);

  await timerCallback();
  await runtime.shutdown("operator");
  assert.deepEqual(events, [
    ["listen", { host: "127.0.0.1", port: 8766 }],
    ["timer", 5_000],
    ["clear-timer", 123],
    ["terminate", "expired"],
    ["http-close"],
    ["device-shutdown"],
  ]);
});

test("shutdown starts listener drain and terminal device release before parking finishes", async () => {
  const events = [];
  let finishParking;
  const parking = new Promise((resolve) => { finishParking = resolve; });
  const runtime = new CameraRuntime({
    bridge: {
      status() { return { active: true, expiresAtMs: 6_000 }; },
      async terminate() {
        events.push("terminate-start");
        await parking;
        events.push("terminate-finish");
      },
    },
    http: {
      async listen() {},
      async close() { events.push("http-close"); },
    },
    device: {
      async shutdown() { events.push("device-shutdown"); },
    },
    now: () => 1_000,
    setTimer: () => 123,
    clearTimer: () => {},
  });
  await runtime.start({ host: "127.0.0.1", port: 8766 });

  const shutdown = runtime.shutdown("operator");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["terminate-start", "http-close", "device-shutdown"]);

  finishParking();
  await shutdown;
  assert.deepEqual(events, [
    "terminate-start",
    "http-close",
    "device-shutdown",
    "terminate-finish",
  ]);
});

test("shutdown attempts every cleanup stage before reporting aggregate failure", async () => {
  const events = [];
  const runtime = new CameraRuntime({
    bridge: {
      status() { return { active: true, expiresAtMs: 6_000 }; },
      async terminate() { events.push("terminate"); throw new Error("terminate failed"); },
    },
    http: {
      async listen() { events.push("listen"); },
      async close() { events.push("http-close"); throw new Error("HTTP close failed"); },
    },
    device: {
      async shutdown() { events.push("device-shutdown"); throw new Error("device failed"); },
    },
    now: () => 1_000,
    setTimer: () => 123,
    clearTimer: () => events.push("clear-timer"),
  });
  await runtime.start({ host: "127.0.0.1", port: 8766 });

  await assert.rejects(
    () => runtime.shutdown("operator"),
    (error) => error instanceof AggregateError && error.errors.length === 3,
  );
  assert.deepEqual(events, [
    "listen",
    "clear-timer",
    "terminate",
    "http-close",
    "device-shutdown",
  ]);
});

test("failed listen performs privacy cleanup before start rejects", async () => {
  const events = [];
  const runtime = new CameraRuntime({
    bridge: {
      status() { return { active: true, expiresAtMs: 6_000 }; },
      async terminate(reason) { events.push(["terminate", reason]); },
    },
    http: {
      async listen() { events.push("listen"); throw new Error("bind failed"); },
      async close() { events.push("http-close"); },
    },
    device: { async shutdown() { events.push("device-shutdown"); } },
    now: () => 1_000,
  });

  await assert.rejects(
    () => runtime.start({ host: "127.0.0.1", port: 8766 }),
    /bind failed/i,
  );
  assert.deepEqual(events, [
    "listen",
    ["terminate", "failure"],
    "http-close",
    "device-shutdown",
  ]);
});

test("runtime schedules a seven-day finite expiry without timer overflow", async () => {
  let scheduledDelay;
  const runtime = new CameraRuntime({
    bridge: {
      status() { return { active: true, expiresAtMs: 604_801_000 }; },
      async terminate() {},
    },
    http: { async listen() {}, async close() {} },
    device: { async shutdown() {} },
    now: () => 1_000,
    setTimer: (_callback, delay) => { scheduledDelay = delay; return 123; },
    clearTimer: () => {},
  });

  await runtime.start({ host: "127.0.0.1", port: 8766 });
  assert.equal(scheduledDelay, 604_800_000);
  await runtime.shutdown("operator");
});
