import assert from "node:assert/strict";
import test from "node:test";
import {
  clearStoredDrafts,
  hasStoredDrafts,
  isDraftPersistenceEnabled,
  loadDurableDrafts,
  loadLegacyDrafts,
  saveDurableDrafts,
  setDraftPersistenceEnabled,
  DRAFT_LIMITS,
} from "../src/renderer/drafts.ts";

function installStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const storage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  return store;
}

function uninstallStorage() {
  // @ts-expect-error restore a non-browser harness
  delete (globalThis as Record<string, unknown>).localStorage;
}

test("first run defaults to opt-in off with no stored drafts", () => {
  installStorage();
  try {
    assert.equal(isDraftPersistenceEnabled(), false);
    assert.equal(loadDurableDrafts().size, 0);
    assert.equal(hasStoredDrafts(), false);
    assert.equal(loadLegacyDrafts().size, 0);
  } finally {
    uninstallStorage();
  }
});

test("opt-in enables save, simulated restart restores, opt-out clears", () => {
  const store = installStorage();
  try {
    setDraftPersistenceEnabled(true);
    assert.equal(isDraftPersistenceEnabled(), true);
    const drafts = new Map([
      ["session-a", "unsent hello"],
      ["project:/x", "second draft"],
    ]);
    saveDurableDrafts(drafts);
    assert.ok(store.has("vibe-desktop:drafts:v1"));

    // Simulated full restart: fresh module state, same storage.
    const restored = loadDurableDrafts();
    assert.equal(restored.get("session-a"), "unsent hello");
    assert.equal(restored.get("project:/x"), "second draft");

    setDraftPersistenceEnabled(false);
    assert.equal(isDraftPersistenceEnabled(), false);
    assert.equal(store.has("vibe-desktop:drafts:v1"), false);
    assert.equal(loadDurableDrafts().size, 0);
  } finally {
    uninstallStorage();
  }
});

test("legacy M1 drafts are surfaced once, never silently deleted or enabled", () => {
  installStorage({
    "vibe-desktop:drafts:v1": JSON.stringify({ "old-session": "kept text" }),
  });
  try {
    assert.equal(isDraftPersistenceEnabled(), false);
    assert.equal(loadDurableDrafts().size, 0);
    assert.equal(hasStoredDrafts(), true);
    const legacy = loadLegacyDrafts();
    assert.equal(legacy.get("old-session"), "kept text");
    // Still disabled and still stored: the app decides visibly.
    assert.equal(isDraftPersistenceEnabled(), false);
    assert.equal(hasStoredDrafts(), true);
    clearStoredDrafts();
    assert.equal(hasStoredDrafts(), false);
  } finally {
    uninstallStorage();
  }
});

test("corrupt JSON, oversized drafts and unavailable storage are safe", () => {
  installStorage({ "vibe-desktop:drafts:v1": "{not json" });
  try {
    setDraftPersistenceEnabled(true);
    assert.equal(loadDurableDrafts().size, 0);
    assert.equal(hasStoredDrafts(), false);
    const big = "x".repeat(DRAFT_LIMITS.MAX_DRAFT_CHARS + 1);
    saveDurableDrafts(new Map([["s", big]]));
    // Oversized input is truncated to the limit, never silently dropped.
    const truncated = loadDurableDrafts();
    assert.equal(truncated.size, 1);
    assert.equal(truncated.get("s")?.length, DRAFT_LIMITS.MAX_DRAFT_CHARS);
    const many = new Map<string, string>();
    for (let i = 0; i < DRAFT_LIMITS.MAX_DRAFTS + 10; i++) many.set(`s${i}`, "v");
    saveDurableDrafts(many);
    assert.ok(loadDurableDrafts().size <= DRAFT_LIMITS.MAX_DRAFTS);
  } finally {
    uninstallStorage();
  }

  uninstallStorage();
  assert.equal(isDraftPersistenceEnabled(), false);
  assert.equal(loadDurableDrafts().size, 0);
  // Must not throw without storage.
  setDraftPersistenceEnabled(true);
  saveDurableDrafts(new Map([["s", "v"]]));
  clearStoredDrafts();
});

test("drafts stay separated per session key", () => {
  installStorage();
  try {
    setDraftPersistenceEnabled(true);
    saveDurableDrafts(
      new Map([
        ["a", "first"],
        ["b", "second"],
      ]),
    );
    const restored = loadDurableDrafts();
    assert.equal(restored.get("a"), "first");
    assert.equal(restored.get("b"), "second");
  } finally {
    uninstallStorage();
  }
});
