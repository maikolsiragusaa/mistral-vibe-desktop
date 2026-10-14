import assert from "node:assert/strict";
import test from "node:test";
import {
  formatBytes,
  precheckCustomRoot,
  previewWorktreePath,
  sanitizeWorktreeDirName,
} from "../src/renderer/worktree-custom.ts";

test("dir names are bounded slugs, never paths", () => {
  assert.equal(sanitizeWorktreeDirName("feature/a"), "feature-a");
  assert.equal(sanitizeWorktreeDirName("../escape"), null);
  assert.equal(sanitizeWorktreeDirName(""), null);
  assert.equal(sanitizeWorktreeDirName("a".repeat(200)), null);
});

test("custom roots must be absolute and never UNC", () => {
  assert.equal(precheckCustomRoot("D:\\worktrees"), null);
  assert.match(precheckCustomRoot("relative/dir") ?? "", /absolute/);
  assert.match(precheckCustomRoot("\\\\server\\share") ?? "", /UNC/);
});

test("preview joins root/namespace/name without guessing", () => {
  assert.equal(
    previewWorktreePath("C:\\wt", "repo-abc123", "feature-a"),
    "C:\\wt\\repo-abc123\\feature-a",
  );
});

test("disk sizes render measured values only", () => {
  assert.equal(formatBytes(null), "unknown size");
  assert.equal(formatBytes(512), "512 B");
  assert.match(formatBytes(2 * 1024 * 1024), /MiB/);
});
