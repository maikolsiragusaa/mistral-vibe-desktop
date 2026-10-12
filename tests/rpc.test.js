import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { JsonRpcClient } from "../src/main/rpc-client.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.killed = false;
    this.writes = [];
    this.stdin.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean))
        this.writes.push(JSON.parse(line));
    });
  }

  send(message) {
    this.stdout.write(Buffer.from(`${JSON.stringify(message)}\n`, "utf8"));
  }

  exit(code = 0) {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

async function until(predicate, timeoutMs = 500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error("Timed out waiting for the test condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("framed JSON-RPC handles fragmented UTF-8 and interleaved notifications", async () => {
  const child = new FakeChild();
  const rpc = new JsonRpcClient(child);
  const received = new Promise((resolve) => rpc.once("event", resolve));
  const response = rpc.request("runtime/read", { sessionId: "s1" });
  await until(() => child.writes.length === 1);
  const data = Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id: child.writes[0].id,
      result: { label: "Café 🌿" },
    }) + "\n",
    "utf8",
  );
  const split = data.indexOf(Buffer.from("🌿")) + 2;
  child.stdout.write(data.subarray(0, split));
  child.stdout.write(data.subarray(split));
  child.send({
    jsonrpc: "2.0",
    method: "turn/started",
    params: { turnId: "t1" },
  });

  assert.deepEqual(await response, { label: "Café 🌿" });
  assert.deepEqual(await received, {
    method: "turn/started",
    params: { turnId: "t1" },
  });
  rpc.close();
});

test("callback requests are acknowledged before their UI event is delivered", async () => {
  const child = new FakeChild();
  const rpc = new JsonRpcClient(child);
  const callback = {
    callbackId: "cb-1",
    sessionId: "s1",
    detail: { kind: "approval" },
  };
  const received = new Promise((resolve) => rpc.once("event", resolve));
  child.send({
    jsonrpc: "2.0",
    id: "server-1",
    method: "callback/call",
    params: { callback },
  });

  assert.deepEqual(await received, {
    method: "callback/call",
    params: { callback },
  });
  await until(() => child.writes.length === 1);
  assert.deepEqual(child.writes[0], {
    jsonrpc: "2.0",
    id: "server-1",
    result: { callbackId: "cb-1", accepted: true },
  });
  rpc.close();
});

test("responses remain independent from event consumption", async () => {
  const child = new FakeChild();
  const rpc = new JsonRpcClient(child);
  const response = rpc.request("setup/status", {});
  await until(() => child.writes.length === 1);
  child.send({
    jsonrpc: "2.0",
    method: "session/updated",
    params: { revision: 1 },
  });
  child.send({
    jsonrpc: "2.0",
    id: child.writes[0].id,
    result: { hasApiKey: false },
  });
  assert.deepEqual(await response, { hasApiKey: false });
  rpc.close();
});

test("malformed and oversized frames close the transport and fail pending requests", async () => {
  const child = new FakeChild();
  const rpc = new JsonRpcClient(child, { maxFrameBytes: 80 });
  const failed = new Promise((resolve) => rpc.once("transportError", resolve));
  const pending = rpc.request("setup/status", {});
  await until(() => child.writes.length === 1);
  child.stdout.write(Buffer.alloc(81, 0x78));
  assert.match((await failed).message, /size limit/);
  await assert.rejects(pending, /size limit/);
});

test("process exit rejects every outstanding request", async () => {
  const child = new FakeChild();
  const rpc = new JsonRpcClient(child);
  const pending = rpc.request("runtime/read", { sessionId: "s1" });
  await until(() => child.writes.length === 1);
  child.exit(13);
  await assert.rejects(pending, /exited/);
});

test("a server error is returned to its matching request", async () => {
  const child = new FakeChild();
  const rpc = new JsonRpcClient(child);
  const pending = rpc.request("session/read", { sessionId: "s1" });
  await until(() => child.writes.length === 1);
  child.send({
    jsonrpc: "2.0",
    id: child.writes[0].id,
    error: { code: -32001, message: "not found" },
  });
  await assert.rejects(
    pending,
    (error) => error.message === "not found" && error.code === -32001,
  );
  rpc.close();
});
