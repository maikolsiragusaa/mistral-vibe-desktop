import assert from "node:assert/strict";
import test from "node:test";
import {
  getCapability,
  isUnsupportedError,
  probeCapability,
  setCapability,
} from "../src/renderer/capabilities.ts";

test("unsupported engine errors are recognized, other errors stay unknown", () => {
  assert.equal(isUnsupportedError("Method not found: review/state"), true);
  assert.equal(isUnsupportedError("The compact method is not implemented yet."), true);
  assert.equal(isUnsupportedError("Session not found"), false);
  assert.equal(isUnsupportedError("Timed out"), false);
});

test("verified and unsupported verdicts are cached per session", async () => {
  const ok = async () => ({});
  assert.equal(await probeCapability(ok, "sess-cap-1", "tools/list"), "verified");
  assert.equal(getCapability("sess-cap-1", "tools/list"), "verified");
  // Cached: a failing requester must not overturn the verdict.
  const failing = async () => {
    throw new Error("Method not found");
  };
  assert.equal(await probeCapability(failing, "sess-cap-1", "tools/list"), "verified");

  assert.equal(await probeCapability(failing, "sess-cap-2", "review/state"), "unsupported");
  assert.equal(getCapability("sess-cap-2", "review/state"), "unsupported");
  setCapability("sess-cap-2", "review/state", "unknown");
  assert.equal(getCapability("sess-cap-2", "review/state"), "unknown");
});

test("authorization and transport failures never become capability verdicts", async () => {
  const denied = async () => {
    throw new Error("This request does not target the active Vibe session");
  };
  assert.equal(await probeCapability(denied, "sess-cap-3", "stats/read"), "unknown");
  assert.equal(getCapability("sess-cap-3", "stats/read"), "unknown");
});
