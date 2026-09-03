import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateRuntimeConfig } from "../src/config.js";

function uniqueToken(label) {
  const pad = `${label}${"x".repeat(48)}`.replace(/[^A-Za-z0-9_-]/g, "x");
  return pad.slice(0, 43);
}

function validVision() {
  return { baseUrl: "http://127.0.0.1:11434", model: "qwen3-vl:8b" };
}

const tokens = {
  operator: uniqueToken("operator"),
  agent_a: uniqueToken("agent-a"),
  agent_b: uniqueToken("agent-b"),
};
const sources = {
  operator: ["100.64.0.10"],
  agent_a: ["100.64.0.11"],
  agent_b: ["100.64.0.12"],
};

function baseConfig(overrides = {}) {
  return {
    bindHost: "100.64.0.10",
    port: 8766,
    operatorPrincipal: "operator",
    tokens,
    sources,
    vision: validVision(),
    minutes: 30,
    ...overrides,
  };
}

test("runtime config accepts only loopback or Tailscale bindings", () => {
  const config = validateRuntimeConfig(baseConfig());
  assert.equal(config.bindHost, "100.64.0.10");
  assert.equal(config.durationMs, 1_800_000);
  assert.deepEqual(config.sources, sources);
  assert.deepEqual(config.principals, ["operator", "agent_a", "agent_b"]);

  for (const bindHost of ["0.0.0.0", "192.168.1.170", "8.8.8.8"]) {
    assert.throws(
      () => validateRuntimeConfig(baseConfig({ bindHost })),
      /loopback or Tailscale/i,
    );
  }
});

test("runtime config allows seven days and rejects longer sessions", () => {
  const sevenDays = validateRuntimeConfig(baseConfig({ minutes: 10_080 }));
  assert.equal(sevenDays.durationMs, 604_800_000);

  for (const minutes of [0, 10_081, Number.NaN]) {
    assert.throws(
      () => validateRuntimeConfig(baseConfig({ bindHost: "127.0.0.1", minutes })),
      /1 through 10080/i,
    );
  }
});

test("runtime config accepts arbitrary valid principal IDs and returns principals", () => {
  const customTokens = {
    ops: uniqueToken("ops"),
    "desk-cam_01": uniqueToken("desk-cam"),
  };
  const customSources = {
    ops: ["100.64.0.10"],
    "desk-cam_01": ["100.64.0.11"],
  };
  const config = validateRuntimeConfig(baseConfig({
    operatorPrincipal: "ops",
    tokens: customTokens,
    sources: customSources,
  }));
  assert.equal(config.operatorPrincipal, "ops");
  assert.deepEqual(config.principals, ["ops", "desk-cam_01"]);
  assert.deepEqual(config.tokens, customTokens);
  assert.deepEqual(config.sources, customSources);
});

test("runtime config requires an explicit configured operator principal", () => {
  const config = validateRuntimeConfig(baseConfig());
  assert.equal(config.operatorPrincipal, "operator");

  for (const operatorPrincipal of [undefined, "system", "missing_agent", "Uppercase"]) {
    assert.throws(
      () => validateRuntimeConfig(baseConfig({ operatorPrincipal })),
      /operatorPrincipal/i,
    );
  }
});

test("runtime config accepts one principal and eight principals", () => {
  const one = validateRuntimeConfig(baseConfig({
    tokens: { operator: uniqueToken("one") },
    sources: { operator: ["127.0.0.1"] },
  }));
  assert.deepEqual(one.principals, ["operator"]);

  const eightIds = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
  const eightTokens = Object.fromEntries(eightIds.map((id) => [id, uniqueToken(id)]));
  const eightSources = Object.fromEntries(eightIds.map((id, index) => [id, [`100.64.0.${10 + index}`]]));
  const eight = validateRuntimeConfig(baseConfig({
    operatorPrincipal: "alpha",
    tokens: eightTokens,
    sources: eightSources,
  }));
  assert.deepEqual(eight.principals, eightIds);
});

test("runtime config rejects invalid reserved mismatched empty and oversized principal sets", () => {
  assert.throws(
    () => validateRuntimeConfig(baseConfig({ tokens: {}, sources: {} })),
    /1 to 8 principals/i,
  );

  const nineIds = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  assert.throws(
    () => validateRuntimeConfig(baseConfig({
      tokens: Object.fromEntries(nineIds.map((id) => [id, uniqueToken(id)])),
      sources: Object.fromEntries(nineIds.map((id) => [id, ["127.0.0.1"]])),
    })),
    /1 to 8 principals/i,
  );

  for (const invalidId of ["system", "Uppercase", "1agent", "AGENT", "has space", "bad.id", ""]) {
    assert.throws(
      () => validateRuntimeConfig(baseConfig({
        tokens: { [invalidId || " "]: uniqueToken("bad"), operator: uniqueToken("ok") },
        sources: { [invalidId || " "]: ["127.0.0.1"], operator: ["127.0.0.1"] },
      })),
      /principal IDs|reserved/i,
    );
  }

  assert.throws(
    () => validateRuntimeConfig(baseConfig({
      sources: { operator: ["100.64.0.10"], agent_a: ["100.64.0.11"] },
    })),
    /key sets must match exactly/i,
  );
  assert.throws(
    () => validateRuntimeConfig(baseConfig({
      tokens: { operator: uniqueToken("operator") },
      sources: { operator: ["100.64.0.10"], agent_a: ["100.64.0.11"] },
    })),
    /key sets must match exactly/i,
  );
  assert.throws(
    () => validateRuntimeConfig(baseConfig({
      sources: {
        operator: ["100.64.0.10"],
        agent_a: [],
        agent_b: ["100.64.0.12"],
      },
    })),
    /non-empty IP list/i,
  );
});

test("runtime config rejects the published placeholder credentials", () => {
  const example = JSON.parse(
    readFileSync(new URL("../config.example.json", import.meta.url), "utf8"),
  );
  assert.throws(() => validateRuntimeConfig(example), /placeholder credentials/i);
});
