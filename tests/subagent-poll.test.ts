import assert from "node:assert/strict";
import test from "node:test";
import {
  BASE_POLL_MS,
  ERROR_BASE_POLL_MS,
  isStaleResponse,
  MAX_POLL_MS,
  nextErrorDelay,
  nextPollDelay,
  syncLabel,
} from "../src/renderer/subagent-poll.ts";

test("poll backoff grows exponentially and caps", () => {
  assert.equal(nextPollDelay(0), BASE_POLL_MS);
  assert.equal(nextPollDelay(1), BASE_POLL_MS * 2);
  assert.ok(nextPollDelay(100) <= MAX_POLL_MS);
  assert.ok(nextErrorDelay(0) >= BASE_POLL_MS);
  assert.equal(nextErrorDelay(0), ERROR_BASE_POLL_MS);
  assert.ok(nextErrorDelay(2) > nextPollDelay(2));
});

test("stale responses lose to newer request ids", () => {
  assert.equal(isStaleResponse(1, 2), true);
  assert.equal(isStaleResponse(2, 2), false);
  assert.equal(isStaleResponse(3, 2), false);
});

test("sync labels distinguish loading, watching, stale and error", () => {
  assert.equal(syncLabel(true, "", null, false), "loading");
  assert.equal(syncLabel(false, "boom", null, false), "error");
  assert.equal(syncLabel(false, "boom", Date.now(), false), "stale");
  assert.equal(syncLabel(true, "", Date.now(), false), "syncing");
  assert.equal(syncLabel(false, "", Date.now(), true), "watching");
  assert.equal(syncLabel(false, "", Date.now(), false), "synced");
});
