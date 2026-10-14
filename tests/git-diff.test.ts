import assert from "node:assert/strict";
import test from "node:test";
import {
  hasCrlf,
  hunkHasChanges,
  hunkPayload,
  isBinaryDiff,
  parseDiffHunks,
} from "../src/renderer/git-diff.ts";

const SAMPLE = [
  "diff --git a/track.txt b/track.txt",
  "index 111..222 100644",
  "--- a/track.txt",
  "+++ b/track.txt",
  "@@ -1,4 +1,4 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  "@@ -10,3 +10,3 @@",
  " ten",
  "-eleven",
  "+ELEVEN",
].join("\n");

test("unified diff parses into hunks with line numbers", () => {
  const hunks = parseDiffHunks(SAMPLE);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].oldStart, 1);
  assert.equal(hunks[0].newStart, 1);
  const kinds = hunks[0].lines.map((l) => l.type);
  assert.deepEqual(kinds, ["hunk", "context", "remove", "add", "context"]);
  const removed = hunks[0].lines.find((l) => l.type === "remove")!;
  const added = hunks[0].lines.find((l) => l.type === "add")!;
  assert.equal(removed.oldNo, 2);
  assert.equal(removed.newNo, null);
  assert.equal(added.newNo, 2);
  assert.equal(added.oldNo, null);
  assert.equal(hunkHasChanges(hunks[0]), true);
});

test("hunk payload round-trips header and body for IPC", () => {
  const hunks = parseDiffHunks(SAMPLE);
  const payload = hunkPayload(hunks[1]);
  assert.equal(payload.header, "@@ -10,3 +10,3 @@");
  assert.ok(payload.lines.some((l) => l === "-eleven"));
  assert.ok(payload.lines.some((l) => l === "+ELEVEN"));
});

test("binary and CRLF diffs are detected", () => {
  assert.equal(isBinaryDiff("Binary files a/logo.png and b/logo.png differ\n"), true);
  assert.equal(isBinaryDiff(SAMPLE), false);
  assert.equal(hasCrlf("@@ -1 +1 @@\n-old\r\n+new\r\n"), true);
  assert.equal(hasCrlf(SAMPLE), false);
});

test("pure-context hunks report no stageable changes", () => {
  const hunks = parseDiffHunks("@@ -1,2 +1,2 @@\n a\n b\n");
  assert.equal(hunks.length, 1);
  assert.equal(hunkHasChanges(hunks[0]), false);
});
