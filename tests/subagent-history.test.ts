import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEarlierPageToStore,
  applySessionReadToStore,
  createEmptyStore,
  dedupeHistory,
  mergeEarlierPage,
  mergeSessionRead,
  MAX_SUBAGENT_HISTORY,
} from "../src/renderer/subagent-history.ts";
import type { HistoryEntry } from "../src/renderer/types.ts";

function entry(id: string, text = id): HistoryEntry {
  return {
    id,
    type: "message",
    sessionId: "child-1",
    generationStatus: "complete",
    role: "assistant",
    text,
  } as HistoryEntry;
}

test("three historic pages survive live session/read updates", () => {
  // Initial live window: newest 2 entries.
  let store = createEmptyStore([entry("m3"), entry("m4")], "cursor-0");
  assert.deepEqual(store.extended.map((e) => e.id), ["m3", "m4"]);

  // Load three historic pages (oldest first via backward paging).
  store = applyEarlierPageToStore(store, [entry("m1"), entry("m2")], "cursor--1");
  assert.deepEqual(store.extended.map((e) => e.id), ["m1", "m2", "m3", "m4"]);
  assert.equal(store.beforeCursor, "cursor--1");

  store = applyEarlierPageToStore(store, [entry("m0")], "cursor--2");
  assert.deepEqual(store.extended.map((e) => e.id), ["m0", "m1", "m2", "m3", "m4"]);

  // Backend sends a fresh window with new live events (m5) and overlap.
  // The fresh window only covers the recent slice — older pages must stay.
  store = applySessionReadToStore(store, [entry("m3"), entry("m4"), entry("m5")], "cursor-live");
  assert.deepEqual(store.extended.map((e) => e.id), ["m0", "m1", "m2", "m3", "m4", "m5"]);
  // Paging cursor must not rewind to the fresh window's cursor.
  assert.equal(store.beforeCursor, "cursor--2");

  // A second live update keeps everything readable.
  store = applySessionReadToStore(store, [entry("m4"), entry("m5"), entry("m6")], "cursor-live-2");
  assert.deepEqual(store.extended.map((e) => e.id), ["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);
});

test("merge is deterministic with dedup by stable id and fresh-wins content", () => {
  const previous = [entry("a", "old-a"), entry("b"), entry("c")];
  const fresh = [entry("b", "new-b"), entry("c"), entry("d")];
  const merged = mergeSessionRead(previous, fresh);
  assert.deepEqual(merged.map((e) => e.id), ["a", "b", "c", "d"]);
  assert.equal(merged.find((e) => e.id === "b")?.text, "new-b");

  const earlier = mergeEarlierPage([entry("x"), entry("a", "older-a")], previous);
  assert.deepEqual(earlier.map((e) => e.id), ["x", "a", "b", "c"]);
  // Current (fresher) content wins for duplicates.
  assert.equal(earlier.find((e) => e.id === "a")?.text, "old-a");

  assert.deepEqual(dedupeHistory([entry("k"), entry("k", "v2")]).map((e) => e.text), ["v2"]);
});

test("ordering stays coherent when the fresh window slides", () => {
  const previous = [entry("1"), entry("2"), entry("3"), entry("4")];
  // Window slid forward by one: 1 drops out of the fresh slice.
  const merged = mergeSessionRead(previous, [entry("2"), entry("3"), entry("4"), entry("5")]);
  assert.deepEqual(merged.map((e) => e.id), ["1", "2", "3", "4", "5"]);
});

test("memory stays bounded at MAX_SUBAGENT_HISTORY", () => {
  const many = Array.from({ length: MAX_SUBAGENT_HISTORY + 100 }, (_, i) => entry(`e-${i}`));
  const merged = mergeSessionRead([], many);
  assert.equal(merged.length, MAX_SUBAGENT_HISTORY);
  // Newest entries survive trimming.
  assert.equal(merged.at(-1)?.id, `e-${many.length - 1}`);
});

test("stores keep independent cursors per child session", () => {
  const a = applyEarlierPageToStore(createEmptyStore([entry("a2")], "ca-0"), [entry("a1")], "ca-1");
  const b = createEmptyStore([entry("b1")], "cb-0");
  assert.equal(a.beforeCursor, "ca-1");
  assert.equal(b.beforeCursor, "cb-0");
  assert.deepEqual(a.extended.map((e) => e.id), ["a1", "a2"]);
  assert.deepEqual(b.extended.map((e) => e.id), ["b1"]);
  // Live update on A never touches B's cursor.
  const a2 = applySessionReadToStore(a, [entry("a2"), entry("a3")], "ca-live");
  assert.equal(a2.beforeCursor, "ca-1");
  assert.equal(b.beforeCursor, "cb-0");
});
