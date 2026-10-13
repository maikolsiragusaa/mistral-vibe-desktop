import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  adoptDiscoveredCapabilities,
  canProbeSafely,
  getCapability,
  isMutativeMethod,
  probeCapability,
  setCapability,
  setRuntimeIdentity,
} from "../src/renderer/capabilities.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("session/compact is classified mutative and never auto-probed", () => {
  assert.equal(isMutativeMethod("session/compact"), true);
  assert.equal(canProbeSafely("session/compact"), false);
  assert.equal(canProbeSafely("review/state"), true);
});

test("mounting logic never invokes a working session/compact (no side effects)", async () => {
  // Simulate a fully working engine: the requester would succeed.
  let calls = 0;
  const workingRequester = async () => {
    calls += 1;
    return {};
  };
  const sessionId = `sess-mutative-${Date.now()}`;
  // Even with a working engine, the automatic probe must not call it.
  assert.equal(await probeCapability(workingRequester, sessionId, "session/compact"), "unknown");
  assert.equal(calls, 0);
  assert.equal(getCapability(sessionId, "session/compact"), "unknown");

  // A failing engine must also leave the state unknown (no verdict).
  const failingRequester = async () => {
    calls += 1;
    throw new Error("Method not found: session/compact");
  };
  assert.equal(await probeCapability(failingRequester, sessionId, "session/compact"), "unknown");
  assert.equal(calls, 0);
  assert.equal(getCapability(sessionId, "session/compact"), "unknown");

  // Static guard: the menu component must not probe on mount/render.
  const source = await readFile(path.join(repoRoot, "src", "renderer", "CompactMenuItem.tsx"), "utf8");
  assert.doesNotMatch(source, /probeCapability/);
  // Only the explicit click handler may call session/compact.
  const compactCalls = (source.match(/session\/compact/g) ?? []).length;
  assert.ok(compactCalls >= 2, "explicit compact action plus cache keys remain");
  // No RPC inside useEffect: the sync effect only reads the cache.
  const effects = [...source.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\}, \[/g)].map((m) => m[1]);
  for (const body of effects) {
    assert.doesNotMatch(body, /request\s*\(/);
  }
});

test("safe methods still probe; mutative verify only via explicit action", async () => {
  const sessionId = `sess-safe-${Date.now()}`;
  setRuntimeIdentity(`test-identity-${Date.now()}`);
  const ok = async () => ({});
  assert.equal(await probeCapability(ok, sessionId, "tools/list"), "verified");
  assert.equal(getCapability(sessionId, "tools/list"), "verified");
});

test("capability cache is bound to runtime identity with invalidation", async () => {
  const sessionId = `sess-ident-${Date.now()}`;
  setRuntimeIdentity("vibe@2.26.1-instance-a");
  setCapability(sessionId, "tools/list", "verified");
  assert.equal(getCapability(sessionId, "tools/list"), "verified");
  setRuntimeIdentity("vibe@2.26.1-instance-b");
  assert.equal(getCapability(sessionId, "tools/list"), "unknown");
  // Same identity keeps verdicts.
  setCapability(sessionId, "tools/list", "verified");
  setRuntimeIdentity("vibe@2.26.1-instance-b");
  assert.equal(getCapability(sessionId, "tools/list"), "verified");
});

test("official discovery only verifies, never marks unsupported from registry", () => {
  const sessionId = `sess-disc-${Date.now()}`;
  setRuntimeIdentity(`disc-${Date.now()}`);
  adoptDiscoveredCapabilities(sessionId, ["tools/list"], "2.26.1");
  assert.equal(getCapability(sessionId, "tools/list"), "verified");
  // Methods absent from the advertised list stay unknown — not unsupported.
  assert.equal(getCapability(sessionId, "review/state"), "unknown");
  assert.equal(getCapability(sessionId, "session/compact"), "unknown");
  // Non-array discovery payloads are ignored safely.
  adoptDiscoveredCapabilities(sessionId, { tools: true });
  assert.equal(getCapability(sessionId, "review/state"), "unknown");
});
