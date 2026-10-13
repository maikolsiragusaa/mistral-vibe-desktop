import assert from "node:assert/strict";
import test from "node:test";
import {
  describeLoopLastRun,
  planLoopReplace,
} from "../src/renderer/loops-model.ts";

test("last run renders only from real timestamps", () => {
  assert.equal(describeLoopLastRun({}), null);
  assert.equal(describeLoopLastRun({ lastRunAt: "soon" }), null);
  assert.ok((describeLoopLastRun({ lastRunAt: 1791854204 }) ?? "").startsWith("last: "));
  assert.ok((describeLoopLastRun({ lastFiredAt: 1791854204 }) ?? "").startsWith("last: "));
});

test("replace plans require valid ids and never delete first", () => {
  const plan = planLoopReplace({ id: "old-1" }, { interval: "1h", prompt: "check ci" });
  assert.deepEqual(plan, { oldId: "old-1", interval: "1h", prompt: "check ci" });
  assert.equal(planLoopReplace({}, { interval: "1h", prompt: "x" }), null);
  assert.equal(planLoopReplace({ id: "a" }, { interval: " ", prompt: "x" }), null);
  assert.equal(planLoopReplace({ id: "a" }, { interval: "1h", prompt: " " }), null);
  assert.equal(planLoopReplace({ id: "a" }, { interval: "1h", prompt: "x".repeat(9000) }), null);
});
