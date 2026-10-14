import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAddIntent,
  buildEditIntent,
  buildEnvChange,
  diffScalars,
  isEmptyEdit,
  scalarsFromSnapshot,
} from "../src/renderer/resources/mcp-intent.ts";
import type { RedactedMcpServer } from "../src/renderer/resources/mcp-mutation-types.ts";

const SNAPSHOT: RedactedMcpServer = {
  name: "srv-a",
  transport: "stdio",
  command: "python",
  args: ["-V"],
  cwd: "C:\\work",
  prompt: null,
  startup_timeout_sec: 33,
  tool_timeout_sec: 77,
  sampling_enabled: false,
  disabled: false,
  disabled_tools: ["t1"],
  envKeys: ["KEEP_ME", "OTHER"],
  envConfigured: true,
};

test("diff sends only changed scalar fields and unsets cleared ones", () => {
  const { fields, unset } = diffScalars(scalarsFromSnapshot(SNAPSHOT), {
    command: "python",
    args: ["-V"],
    cwd: null,
    prompt: null,
    startup_timeout_sec: 33,
    tool_timeout_sec: 90,
    sampling_enabled: false,
    disabled: false,
    disabled_tools: ["t1"],
  });
  assert.deepEqual(fields, { tool_timeout_sec: 90 });
  assert.deepEqual(unset, ["cwd"]);
});

test("identical form state produces an empty edit", () => {
  const intent = buildEditIntent(SNAPSHOT, "rev", {
    command: "python",
    args: ["-V"],
    cwd: "C:\\work",
    prompt: "",
    startupTimeout: "33",
    toolTimeout: "77",
    samplingEnabled: false,
    disabled: false,
    disabledTools: ["t1"],
  }, null);
  assert.equal(isEmptyEdit(intent), true);
});

test("env change keeps untouched variables by name only", () => {
  const change = buildEnvChange(["KEEP_ME", "OTHER"], {
    kept: ["KEEP_ME", "OTHER"],
    replaced: {},
    added: {},
    removed: [],
  });
  assert.equal(change, null);
  const edited = buildEnvChange(["KEEP_ME", "OTHER"], {
    kept: ["KEEP_ME"],
    replaced: {},
    added: { ADDED: "new" },
    removed: ["OTHER"],
  });
  assert.deepEqual(edited, { keep: ["KEEP_ME"], set: { ADDED: "new" }, remove: ["OTHER"] });
});

test("add intent carries explicit values only", () => {
  const intent = buildAddIntent("srv-n", "rev", {
    command: "python",
    args: [],
    cwd: "",
    prompt: "",
    startupTimeout: "",
    toolTimeout: "",
    samplingEnabled: true,
    disabled: false,
    disabledTools: [],
  }, { FOO: "bar" }, "user-toml");
  assert.equal(intent.op, "add");
  if (intent.op !== "add") throw new Error("unreachable");
  assert.equal(intent.entry.command, "python");
  assert.deepEqual(intent.entry.env, { FOO: "bar" });
  assert.equal(intent.targetLayer, "user-toml");
});

test("snapshot scalars never include unknown fields", () => {
  const withUnknown = { ...SNAPSHOT, mystery_future_field: "keepme" };
  const scalars = scalarsFromSnapshot(withUnknown);
  assert.equal("mystery_future_field" in scalars, false);
  const { fields } = diffScalars(scalars, { ...scalars, command: "python3" });
  assert.deepEqual(Object.keys(fields), ["command"]);
});
