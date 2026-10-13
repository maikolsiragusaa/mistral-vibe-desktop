import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalLoopId,
  describeLoopInterval,
  describeLoopNextFire,
  sanitizeLoops,
} from "../src/renderer/loops-model.ts";

test("canonical ids prefer id, accept legacy loopId, never invent indexes", () => {
  assert.equal(canonicalLoopId({ id: "a", loopId: "b" }), "a");
  assert.equal(canonicalLoopId({ loopId: "b" }), "b");
  assert.equal(canonicalLoopId({}), null);
  assert.equal(canonicalLoopId({ id: 42 }), null);
});

test("intervals and next-fire times render only from real backend data", () => {
  assert.equal(describeLoopInterval({ interval: "1h" }), "1h");
  assert.equal(describeLoopInterval({ intervalSeconds: 3600 }), "every 1h");
  assert.equal(describeLoopInterval({}), "scheduled");
  assert.equal(describeLoopNextFire({}), null);
  assert.equal(describeLoopNextFire({ nextFireAt: "soon" }), null);
  assert.ok(
    (describeLoopNextFire({ nextFireAt: 1791854204 }) ?? "").startsWith("next: "),
  );
});

test("incomplete RPC payloads are dropped without guessing", () => {
  assert.deepEqual(sanitizeLoops(undefined), []);
  assert.deepEqual(sanitizeLoops({ loops: [] }), []);
  assert.equal(sanitizeLoops([null, "x", { id: "a" }]).length, 1);
});
