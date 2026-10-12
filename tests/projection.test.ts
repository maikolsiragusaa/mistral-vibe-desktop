import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatch, reduceEvent } from "../src/renderer/projection.ts";

test("streaming append handles Unicode and JSON pointer escapes without mutating the source", () => {
  const original = { content: [{ text: "Ciao " }], "a/b": { "~text": "x" } };
  const updated = applyPatch(original, [
    { op: "append", path: "/content/0/text", value: "世界" },
    { op: "replace", path: "/a~1b/~0text", value: "y" },
  ]);
  assert.equal(updated.content[0].text, "Ciao 世界");
  assert.equal(updated["a/b"]["~text"], "y");
  assert.equal(original.content[0].text, "Ciao ");
});
test("rejects prototype mutation and impossible streaming patches", () => {
  assert.throws(() =>
    applyPatch({}, [{ op: "add", path: "/__proto__/polluted", value: true }]),
  );
  assert.throws(() =>
    applyPatch({ n: 3 }, [{ op: "append", path: "/n", value: "x" }]),
  );
  assert.equal(({} as any).polluted, undefined);
});
test("duplicate events are ignored and gaps require a canonical reload", () => {
  const state: any = {
    eventId: 3,
    session: { id: "s" },
    history: [],
    turns: [],
    activeCallbacks: [],
    childSessions: [],
  };
  assert.equal(
    reduceEvent(state, {
      method: "turn/completed",
      params: { sessionId: "s", eventId: 3 },
    }),
    state,
  );
  assert.throws(
    () =>
      reduceEvent(state, {
        method: "turn/completed",
        params: { sessionId: "s", eventId: 5 },
      }),
    /gap/,
  );
  const updated = reduceEvent(state, {
    method: "turn/started",
    params: {
      sessionId: "s",
      eventId: 4,
      turn: { id: "t", status: "in_progress" },
    },
  });
  assert.equal(updated.turns?.[0].id, "t");
  assert.equal(updated.eventId, 4);
});

test("partial snapshots preserve the transcript while context handoff replaces it", () => {
  const state: any = {
    eventId: 10,
    session: { id: "s" },
    history: [{ id: "message" }],
    historyBeforeCursor: "older",
    turns: [{ id: "turn" }],
    activeCallbacks: [],
    childSessions: [],
  };
  const snapshot = {
    ...state,
    eventId: 11,
    history: null,
    historyBeforeCursor: null,
    turns: null,
  };
  const updated = reduceEvent(state, {
    method: "session/snapshot",
    params: { state: snapshot },
  });
  assert.deepEqual(updated.history, state.history);
  assert.deepEqual(updated.turns, state.turns);
  assert.equal(updated.historyBeforeCursor, "older");
  assert.equal(updated.eventId, 11);
  assert.equal(
    reduceEvent(updated, {
      method: "session/snapshot",
      params: { state: snapshot },
    }),
    updated,
  );
  assert.equal(
    reduceEvent(state, {
      method: "session/snapshot",
      params: { state: { ...snapshot, session: { id: "child" } } },
    }),
    state,
  );
  const cleared = {
    ...snapshot,
    session: { id: "new-context" },
    history: [],
    turns: [],
  };
  assert.equal(
    reduceEvent(state, {
      method: "session/contextCleared",
      params: { state: cleared },
    }),
    cleared,
  );
});
