import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_VLM_SYSTEM_PROMPT,
  PromptStore,
} from "../src/prompt-store.js";

test("default VLM prompt refers to the operator and the permitted subject", () => {
  assert.match(DEFAULT_VLM_SYSTEM_PROMPT, /explicitly activated by the operator/);
  assert.match(DEFAULT_VLM_SYSTEM_PROMPT, /the permitted subject/);
});

test("prompt store uses only configured actors", () => {
  const store = new PromptStore({ allowedActors: ["operator", "agent_a"] });
  assert.equal(store.status("operator").revision, 0);
  assert.equal(store.status("agent_a").revision, 0);
  assert.throws(() => store.status("legacy_owner"), /not allowed to edit/i);
  assert.throws(() => store.status("legacy_agent_a"), /not allowed to edit/i);
  assert.throws(() => store.status("legacy_agent_b"), /not allowed to edit/i);
  assert.throws(() => store.status("system"), /not allowed to edit/i);
});

test("prompt store has no implicit principal actors", () => {
  const store = new PromptStore();
  for (const actor of ["legacy_owner", "legacy_agent_a", "legacy_agent_b"]) {
    assert.throws(() => store.status(actor), /not allowed to edit/i);
  }
});

const ACTORS = ["operator", "agent_a", "agent_b"];

test("prompt store supports replace append reset and revision metadata", () => {
  let now = 1_000;
  const store = new PromptStore({ now: () => now, allowedActors: ACTORS });

  const initial = store.get("operator");
  assert.equal(initial.prompt, DEFAULT_VLM_SYSTEM_PROMPT);
  assert.equal(initial.revision, 0);
  assert.equal(initial.updatedBy, "system");
  assert.equal(initial.action, "initial");
  assert.match(initial.sha256, /^[a-f0-9]{64}$/);
  assert.equal(initial.history.length, 1);

  now = 2_000;
  const replaced = store.replace("agent_a", {
    prompt: "Describe the scene like a playful noir detective.",
    expectedRevision: 0,
  });
  assert.equal(replaced.revision, 1);
  assert.equal(replaced.updatedBy, "agent_a");
  assert.equal(replaced.action, "replace");
  assert.equal(store.get("agent_b").prompt, "Describe the scene like a playful noir detective.");

  now = 3_000;
  const appended = store.append("agent_b", {
    text: "Pay special attention to color and composition.",
    expectedRevision: 1,
  });
  assert.equal(appended.revision, 2);
  assert.equal(appended.action, "append");
  assert.equal(appended.updatedBy, "agent_b");
  assert.equal(
    store.get("operator").prompt,
    "Describe the scene like a playful noir detective.\n\nPay special attention to color and composition.",
  );

  now = 4_000;
  const reset = store.reset("operator", { expectedRevision: 2 });
  assert.equal(reset.revision, 3);
  assert.equal(reset.action, "reset");
  assert.equal(reset.updatedBy, "operator");
  assert.equal(store.get("agent_a").prompt, DEFAULT_VLM_SYSTEM_PROMPT);
  assert.deepEqual(
    reset.history.map((entry) => entry.revision),
    [0, 1, 2, 3],
  );
});

test("prompt mutations reject stale revisions without changing state", () => {
  const store = new PromptStore({ allowedActors: ACTORS });
  store.replace("operator", { prompt: "Revision one", expectedRevision: 0 });

  assert.throws(
    () => store.append("agent_a", { text: "stale append", expectedRevision: 0 }),
    /revision conflict.*expected 0.*current 1/i,
  );
  assert.equal(store.status("agent_b").revision, 1);
  assert.equal(store.get("agent_b").prompt, "Revision one");
});

test("prompt store rejects unknown actors and malformed or oversized prompts", () => {
  const store = new PromptStore({
    defaultPrompt: "Default prompt",
    maxPromptChars: 32,
    allowedActors: ACTORS,
  });

  assert.throws(() => store.get("intruder"), /not allowed to edit/i);
  assert.throws(
    () => store.replace("operator", { prompt: "", expectedRevision: 0 }),
    /1 to 32 characters/i,
  );
  assert.throws(
    () => store.replace("operator", { prompt: "x".repeat(33), expectedRevision: 0 }),
    /1 to 32 characters/i,
  );
  assert.throws(
    () => store.append("operator", { text: "", expectedRevision: 0 }),
    /append text.*non-empty/i,
  );
  assert.equal(store.status("operator").revision, 0);
});

test("prompt history is bounded metadata and never retains prior prompt text", () => {
  const store = new PromptStore({ historyLimit: 3, allowedActors: ACTORS });
  for (let revision = 0; revision < 5; revision += 1) {
    store.replace("operator", {
      prompt: `Prompt revision ${revision + 1}`,
      expectedRevision: revision,
    });
  }

  const status = store.status("agent_a");
  assert.deepEqual(status.history.map((entry) => entry.revision), [3, 4, 5]);
  assert.equal(JSON.stringify(status.history).includes("Prompt revision"), false);
  for (const entry of status.history) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["action", "chars", "revision", "sha256", "updatedAtMs", "updatedBy"],
    );
  }
});
