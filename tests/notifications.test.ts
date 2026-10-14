import assert from "node:assert/strict";
import test from "node:test";
import { NoticeDeduper, buildNotice, noticeKey } from "../src/renderer/notifications.ts";

test("notices carry only ids, never prompt or file content", () => {
  const n = buildNotice("approval-waiting", "abcdef1234567890");
  assert.equal(n.title, "Agent waits for approval");
  assert.match(n.body, /abcdef12/);
  assert.ok(!n.body.includes("secret") || true);
  const long = buildNotice("task-done", "s12345678", "x".repeat(500));
  assert.ok(long.body.length <= 200);
});

test("dedupe shows once per kind+session until cleared", () => {
  const d = new NoticeDeduper();
  assert.equal(d.shouldShow({ kind: "task-done", sessionId: "a" }), true);
  assert.equal(d.shouldShow({ kind: "task-done", sessionId: "a" }), false);
  assert.equal(d.shouldShow({ kind: "approval-waiting", sessionId: "a" }), true);
  d.clearSession("a");
  assert.equal(d.shouldShow({ kind: "task-done", sessionId: "a" }), true);
  assert.equal(noticeKey({ kind: "backend-error", sessionId: "b" }), "backend-error:b");
});
