import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isSafeObservationText } from "../src/observation-text.js";

const vectors = JSON.parse(readFileSync(
  new URL("../clients/hermes-plugin/observation-text-vectors.json", import.meta.url),
  "utf8",
));

test("shared observation validator rejects media data and path payload forms", () => {
  for (const value of vectors.forbidden) {
    assert.equal(isSafeObservationText(value), false, value);
  }
});

test("shared observation validator preserves ordinary scene descriptions", () => {
  for (const value of vectors.allowed) {
    assert.equal(isSafeObservationText(value), true, value);
  }
});
