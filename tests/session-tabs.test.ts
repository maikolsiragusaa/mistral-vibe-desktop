import assert from "node:assert/strict";
import test from "node:test";
import {
  connectionLimitExplanation,
  describeSessionTab,
  emptyTabUiState,
} from "../src/renderer/session-tabs.ts";

test("tab states distinguish working, approval, detached, external and ended", () => {
  const base = {
    id: "s1", title: "Build", cwd: "C:\\repo\\wt-a", branch: "feature-a",
    model: "mistral-large", hasActiveTurn: false, hasPendingCallbacks: false,
    attached: true, leaseHeld: false, terminated: false,
    childRunning: 0, childWaiting: 0, detached: false, draftLength: 0,
  };
  assert.equal(describeSessionTab({ ...base, hasActiveTurn: true }).state, "working");
  assert.equal(describeSessionTab({ ...base, hasPendingCallbacks: true }).state, "waiting-approval");
  assert.equal(describeSessionTab({ ...base, hasPendingCallbacks: true }).attention, true);
  assert.equal(describeSessionTab({ ...base, detached: true, attached: false }).state, "detached");
  assert.equal(describeSessionTab({ ...base, leaseHeld: true }).state, "externally-held");
  assert.equal(describeSessionTab({ ...base, terminated: true }).state, "terminated");
  assert.equal(describeSessionTab({ ...base, title: "  " }).title, "New session");
});

test("tooltips bind worktree/model/children without guessing branch from names", () => {
  const tab = describeSessionTab({
    id: "s2", title: "A", cwd: "C:\\r\\feature-B", branch: null,
    model: "mistral-medium", hasActiveTurn: false, hasPendingCallbacks: false,
    attached: true, leaseHeld: false, terminated: false,
    childRunning: 3, childWaiting: 0, detached: false, draftLength: 5,
  });
  assert.equal(tab.shortCwd, "feature-B");
  assert.match(tab.tooltip, /3 subagent\(s\) working/);
  assert.match(tab.tooltip, /draft kept/);
  assert.equal(tab.branch, null);
});

test("connection limit explains viewable vs attached with safe options", () => {
  const msg = connectionLimitExplanation(4, 4);
  assert.match(msg, /4 attached session slots/);
  assert.match(msg, /never stops a session silently/);
  assert.match(msg, /Stop an attached session/);
});

test("per-tab UI state preserves view only, never history", () => {
  const s = emptyTabUiState();
  assert.equal(s.scrollTop, 0);
  assert.equal(s.draft, "");
  assert.ok(!("history" in s));
});
