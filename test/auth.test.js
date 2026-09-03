import assert from "node:assert/strict";
import test from "node:test";

import { TokenAuthenticator } from "../src/auth.js";

const auth = new TokenAuthenticator({
  agent_a: "test-agent-a-token-that-is-long-enough",
  agent_b: "test-agent-b-token-that-is-long-enough",
}, {
  allowedSourcesByAgent: {
    agent_a: ["100.64.0.11"],
    agent_b: ["100.64.0.12"],
  },
});

test("bearer token determines the agent identity", () => {
  assert.equal(
    auth.authenticate("Bearer test-agent-a-token-that-is-long-enough", "100.64.0.11"),
    "agent_a",
  );
  assert.equal(
    auth.authenticate("Bearer test-agent-b-token-that-is-long-enough", "::ffff:100.64.0.12"),
    "agent_b",
  );
});

test("a valid token from the wrong source address fails closed", () => {
  assert.throws(
    () => auth.authenticate("Bearer test-agent-a-token-that-is-long-enough", "100.64.0.10"),
    /unauthorized/i,
  );
  assert.throws(
    () => auth.authenticate("Bearer test-agent-b-token-that-is-long-enough", "100.64.0.11"),
    /unauthorized/i,
  );
});

test("malformed, missing, and incorrect bearer tokens fail closed", () => {
  for (const header of [
    undefined,
    "",
    "Basic test-agent-a-token-that-is-long-enough",
    "Bearer wrong",
    "bearer test-agent-a-token-that-is-long-enough",
    "Bearer  test-agent-a-token-that-is-long-enough",
  ]) {
    assert.throws(() => auth.authenticate(header, "100.64.0.11"), /unauthorized/i);
  }
});

test("short configured tokens are rejected at construction", () => {
  assert.throws(
    () => new TokenAuthenticator({ agent_a: "too-short" }),
    /at least 32 characters/i,
  );
});
