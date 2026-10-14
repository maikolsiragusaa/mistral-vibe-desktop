import assert from "node:assert/strict";
import test from "node:test";
import { McpConfigService } from "../src/main/mcp-config-service.js";

function fieldResponse(list, targets = ["user-toml"]) {
  return {
    fields: [{ name: "mcp_servers", layerValues: [{ layer: "user-toml", value: list }] }],
    targets,
  };
}

function makeFake({ list, onWrite, refreshOk = true }) {
  let current = structuredClone(list);
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "config/fields/read") return fieldResponse(current);
    if (method === "config/write") {
      const result = onWrite ? await onWrite(params, current) : { status: "applied" };
      if (result && result.apply !== false) {
        // Emulate upstream leaf semantics for the cases under test.
        for (const op of params.ops) {
          const parts = op.path.split("/").slice(1);
          if (parts[0] !== "mcp_servers") continue;
          if (parts.length === 1) current = structuredClone(op.value);
          else if (parts[1] === "-") current.push(structuredClone(op.value));
          else if (parts.length === 2) {
            if (op.op === "remove") current.splice(Number(parts[1]), 1);
            else current[Number(parts[1])] = structuredClone(op.value);
          } else if (parts.length === 3) {
            const entry = current[Number(parts[1])];
            if (op.op === "remove") delete entry[parts[2]];
            else entry[parts[2]] = structuredClone(op.value);
          }
        }
      }
      const { apply, ...rest } = result ?? {};
      return Object.keys(rest).length ? rest : { status: "applied" };
    }
    if (method === "mcp_catalog/refresh") {
      if (!refreshOk) throw new Error("refresh failed");
      return { ok: true };
    }
    throw new Error(`unexpected method ${method}`);
  };
  return { request, calls, getList: () => current };
}

const FULL_A = {
  name: "srv-a",
  transport: "stdio",
  command: "python",
  args: ["-V"],
  cwd: "C:\\work",
  env: { KEEP_ME: "fixture-secret-1", OTHER: "x" },
  disabled: false,
  prompt: "hi",
  startup_timeout_sec: 33,
  tool_timeout_sec: 77,
  sampling_enabled: false,
  disabled_tools: ["t1", "t2"],
};

const PARTIAL_B = {
  name: "srv-b",
  transport: "stdio",
  command: "python",
  args: ["--version"],
  disabled: false,
};

test("add preserves every field of every existing server", async () => {
  const { request, getList } = makeFake({ list: [FULL_A, PARTIAL_B] });
  const service = new McpConfigService({ request });
  const described = await service.describe("s1");
  const added = await service.mutate("s1", {
    op: "add",
    name: "srv-d",
    expectedRevision: described.revision,
    entry: { transport: "stdio", command: "python", args: ["-V"] },
  });
  assert.equal(added.outcome, "applied-verified");
  const list = getList();
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], FULL_A);
  assert.deepEqual(list[1], PARTIAL_B);
  assert.equal(list[2].name, "srv-d");
});

test("edit of one command preserves timeouts, tools, sampling and env", async () => {
  const { request, getList } = makeFake({ list: [FULL_A, PARTIAL_B] });
  const service = new McpConfigService({ request });
  const described = await service.describe("s1");
  const result = await service.mutate("s1", {
    op: "set",
    name: "srv-b",
    expectedRevision: described.revision,
    fields: { args: ["-c", "x"] },
  });
  assert.equal(result.outcome, "applied-verified");
  const list = getList();
  assert.deepEqual(list[0], FULL_A);
  assert.deepEqual(list[1].args, ["-c", "x"]);
  assert.equal(list[1].command, "python");
});

test("disable uses a single leaf op and changes nothing else", async () => {
  const { request, calls, getList } = makeFake({ list: [FULL_A, PARTIAL_B] });
  const service = new McpConfigService({ request });
  const described = await service.describe("s1");
  const result = await service.mutate("s1", {
    op: "enable",
    name: "srv-b",
    disabled: true,
    expectedRevision: described.revision,
  });
  assert.equal(result.outcome, "applied-verified");
  const writes = calls.filter((call) => call.method === "config/write");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].params.ops.length, 1);
  assert.equal(writes[0].params.ops[0].path, "/mcp_servers/1/disabled");
  assert.deepEqual(getList()[0], FULL_A);
  assert.equal(getList()[1].disabled, true);
});

test("remove preserves the survivors byte-for-byte", async () => {
  const { request, getList } = makeFake({ list: [FULL_A, PARTIAL_B] });
  const service = new McpConfigService({ request });
  const described = await service.describe("s1");
  const result = await service.mutate("s1", {
    op: "remove",
    name: "srv-b",
    expectedRevision: described.revision,
  });
  assert.equal(result.outcome, "applied-verified");
  assert.deepEqual(getList(), [FULL_A]);
});

test("unknown upstream fields survive every mutation", async () => {
  const withUnknown = { ...PARTIAL_B, mystery_future_field: "keepme" };
  const { request, getList } = makeFake({ list: [FULL_A, withUnknown] });
  const service = new McpConfigService({ request });
  const described = await service.describe("s1");
  const edited = await service.mutate("s1", {
    op: "set",
    name: "srv-b",
    expectedRevision: described.revision,
    fields: { disabled: true },
  });
  assert.equal(edited.outcome, "applied-verified");
  assert.equal(getList()[1].mystery_future_field, "keepme");
});

test("stale revision refuses the write without touching config", async () => {
  const { request, calls, getList } = makeFake({ list: [FULL_A] });
  const service = new McpConfigService({ request });
  const result = await service.mutate("s1", {
    op: "enable",
    name: "srv-a",
    disabled: true,
    expectedRevision: "stale-revision",
  });
  assert.equal(result.outcome, "conflict");
  assert.equal(calls.filter((call) => call.method === "config/write").length, 0);
  assert.deepEqual(getList(), [FULL_A]);
});

test("missing or duplicated identity refuses the write", async () => {
  const dup = { ...PARTIAL_B };
  const { request, getList } = makeFake({ list: [FULL_A, PARTIAL_B, dup] });
  const service = new McpConfigService({ request });
  const described = await service.describe("s1");
  const result = await service.mutate("s1", {
    op: "remove",
    name: "srv-b",
    expectedRevision: described.revision,
  });
  assert.equal(result.outcome, "conflict");
  assert.equal(getList().length, 3);
});

test("upstream rejection is reported, never claimed as success", async () => {
  const { request } = makeFake({
    list: [PARTIAL_B],
    onWrite: () => ({ status: "applied", rejected: true, failures: [{ path: "/mcp_servers/-", message: "nope" }] }),
  });
  const service = new McpConfigService({ request });
  const described = await service.describe("s1");
  const result = await service.mutate("s1", {
    op: "add",
    name: "srv-x",
    expectedRevision: described.revision,
    entry: { transport: "stdio", command: "python", args: [] },
  });
  assert.equal(result.outcome, "rejected");
});

test("pending reload is reported distinctly", async () => {
  const { request } = makeFake({
    list: [PARTIAL_B],
    onWrite: () => ({ status: "pending" }),
  });
  const service = new McpConfigService({ request });
  const described = await service.describe("s1");
  const result = await service.mutate("s1", {
    op: "enable",
    name: "srv-b",
    disabled: true,
    expectedRevision: described.revision,
  });
  assert.equal(result.outcome, "pending-reload");
});

test("readback failure after a write is reported as readback-failed", async () => {
  let reads = 0;
  const { request } = makeFake({ list: [PARTIAL_B] });
  const flaky = async (method, params) => {
    if (method === "config/fields/read") {
      reads += 1;
      // Reads: 1 = describe, 2 = pre-write re-read, 3+ = post-write readback.
      if (reads > 2) throw new Error("readback failed");
    }
    return request(method, params);
  };
  const service = new McpConfigService({ request: flaky });
  const described = await service.describe("s1");
  const result = await service.mutate("s1", {
    op: "enable",
    name: "srv-b",
    disabled: true,
    expectedRevision: described.revision,
  });
  assert.equal(result.outcome, "readback-failed");
});

test("existing env values never appear in snapshots, results or messages", async () => {
  const { request } = makeFake({ list: [FULL_A] });
  const service = new McpConfigService({ request });
  const described = await service.describe("s1");
  const blob = JSON.stringify(described);
  assert.equal(blob.includes("fixture-secret-1"), false);
  assert.deepEqual(described.servers[0].envKeys, ["KEEP_ME", "OTHER"]);
  const result = await service.mutate("s1", {
    op: "set",
    name: "srv-a",
    expectedRevision: described.revision,
    fields: { command: "python3" },
  });
  assert.equal(result.outcome, "applied-verified");
  assert.equal(JSON.stringify(result).includes("fixture-secret-1"), false);
});

test("env edits keep untouched variables and support explicit removal", async () => {
  const { request, getList } = makeFake({ list: [FULL_A] });
  const service = new McpConfigService({ request });
  const described = await service.describe("s1");
  const result = await service.mutate("s1", {
    op: "set",
    name: "srv-a",
    expectedRevision: described.revision,
    fields: {},
    env: { keep: ["KEEP_ME"], set: { OTHER: "changed", ADDED: "new" }, remove: [] },
  });
  assert.equal(result.outcome, "applied-verified");
  assert.deepEqual(getList()[0].env, { KEEP_ME: "fixture-secret-1", OTHER: "changed", ADDED: "new" });
  const described2 = await service.describe("s1");
  const removed = await service.mutate("s1", {
    op: "set",
    name: "srv-a",
    expectedRevision: described2.revision,
    fields: {},
    env: { keep: ["KEEP_ME"], set: {}, remove: ["OTHER", "ADDED"] },
  });
  assert.equal(removed.outcome, "applied-verified");
  assert.deepEqual(getList()[0].env, { KEEP_ME: "fixture-secret-1" });
});

test("env keep-list referencing a changed variable is a conflict", async () => {
  const { request } = makeFake({ list: [FULL_A] });
  const service = new McpConfigService({ request });
  const described = await service.describe("s1");
  const result = await service.mutate("s1", {
    op: "set",
    name: "srv-a",
    expectedRevision: described.revision,
    fields: {},
    env: { keep: ["MISSING_VAR"], set: {}, remove: [] },
  });
  assert.equal(result.outcome, "conflict");
});

test("servers owned by a read-only layer are refused, never shadowed", async () => {
  const projectOwned = { name: "proj", transport: "stdio", command: "x", args: [] };
  const request = async (method) => {
    if (method === "config/fields/read")
      return {
        fields: [
          {
            name: "mcp_servers",
            layerValues: [
              { layer: "project-toml", value: [projectOwned] },
              { layer: "user-toml", value: [] },
            ],
          },
        ],
        targets: ["user-toml"],
      };
    throw new Error(`unexpected method ${method}`);
  };
  const service = new McpConfigService({ request });
  const described = await service.describe("s1");
  const result = await service.mutate("s1", {
    op: "enable",
    name: "proj",
    disabled: true,
    expectedRevision: described.revision,
  });
  assert.equal(result.outcome, "rejected");
  assert.match(result.message, /not in a writable layer/);
});

test("fresh homes with only the default layer still describe and add", async () => {
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "config/fields/read")
      return {
        fields: [{ name: "mcp_servers", layerValues: [{ layer: "default", value: [] }] }],
        targets: ["user-toml"],
      };
    if (method === "config/write") return { status: "applied" };
    if (method === "mcp_catalog/refresh") return { ok: true };
    throw new Error(`unexpected method ${method}`);
  };
  // NOTE: this fake keeps no state, so the post-write readback still shows
  // the default layer; the assertion below targets resolution + op shape.
  const service = new McpConfigService({ request });
  const described = await service.describe("s1");
  assert.deepEqual(described.servers, []);
  assert.equal(described.targetLayer, "user-toml");
  const result = await service.mutate("s1", {
    op: "add",
    name: "srv-first",
    expectedRevision: described.revision,
    entry: { transport: "stdio", command: "python", args: [] },
  });
  const writes = calls.filter((call) => call.method === "config/write");
  assert.equal(writes.length, 1);
  // Empty baseline: a whole-list write (nothing exists to preserve).
  assert.equal(writes[0].params.ops[0].path, "/mcp_servers");
  // The stateless fake cannot echo the write back, which must surface as a
  // verification failure rather than a false confirmation.
  assert.equal(result.outcome, "readback-failed");
});

test("mutations are serialized within one app instance", async () => {
  const order = [];
  const { request } = makeFake({
    list: [PARTIAL_B],
    onWrite: async (params) => {
      order.push(`start:${params.ops[0].path}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push(`end:${params.ops[0].path}`);
      return { status: "applied" };
    },
  });
  const service = new McpConfigService({ request });
  const described = await service.describe("s1");
  // The second mutation runs while the first write is still in flight and
  // skips the revision check; the per-app mutex must still serialize the two
  // upstream writes instead of interleaving them.
  const first = service.mutate("s1", {
    op: "enable",
    name: "srv-b",
    disabled: true,
    expectedRevision: described.revision,
  });
  const second = service.mutate("s1", {
    op: "set",
    name: "srv-b",
    expectedRevision: null,
    fields: { prompt: "hello" },
  });
  const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => result.outcome === "applied-verified"));
  const starts = order.filter((entry) => entry.startsWith("start:"));
  const ends = order.filter((entry) => entry.startsWith("end:"));
  assert.equal(starts.length, 2);
  assert.ok(order.indexOf(ends[0]) < order.indexOf(starts[1]));
});
