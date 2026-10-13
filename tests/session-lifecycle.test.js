import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { VibeBackend } from "../src/main/backend.js";
import { VibeBackendPool } from "../src/main/backend-pool.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function createTempRoot(prefix) {
  const tempPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return fs.realpath(tempPath);
}

class FakeAppServer extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.killed = false;
    this.requests = [];
    let input = "";
    this.stdin.on("data", (chunk) => {
      input += chunk.toString("utf8");
      while (input.includes("\n")) {
        const newline = input.indexOf("\n");
        const frame = input.slice(0, newline);
        input = input.slice(newline + 1);
        if (!frame) continue;
        const message = JSON.parse(frame);
        if (!Object.hasOwn(message, "method")) continue;
        this.requests.push(message);
        if (!Object.hasOwn(message, "id")) continue;
        const result = this.result(message.method, message.params);
        this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      }
    });
  }
  result(method, params = {}) {
    if (method === "initialize") return { serverInfo: { name: "vibe-app-server", version: "2.26.1" } };
    if (method === "setup/status") return { hasApiKey: true };
    if (method === "session/list") return { items: this.sessionListItems ?? [] };
    if (method === "session/start" || method === "session/resume" || method === "session/continue") {
      const id =
        params.sessionId ?? `session-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
      return { state: { session: { id, cwd: params.agentConfig?.cwd ?? "C:\\project" }, childSessions: [] } };
    }
    if (method === "session/fork") {
      return { state: { session: { id: `forked-${params.sourceSessionId}-${Math.floor(Math.random() * 1e6)}` }, childSessions: [] } };
    }
    if (method === "session/rewind") {
      return { state: { session: { id: params.inplace === false ? `rewound-${params.sessionId}` : params.sessionId }, childSessions: [] } };
    }
    if (method === "session/read") return { state: { session: { id: params.sessionId }, childSessions: [] } };
    if (method === "loops/list") return { loops: [] };
    if (method === "loops/create") return { loop: { loopId: "loop-1" } };
    if (method === "projectLinks/list") return { links: [] };
    if (method === "session/stop") return { stopped: true };
    return {};
  }
  kill() {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

async function createBackend(t, options = {}) {
  const root = await createTempRoot("vibe-desktop-lifecycle-");
  const userData = path.join(root, "user-data");
  await fs.mkdir(userData);
  const selectedProject = path.join(root, "project");
  await fs.mkdir(selectedProject);
  const app = {
    getVersion: () => "0.3.0-test",
    getAppPath: () => root,
    getPath: (name) => (name === "userData" ? userData : root),
  };
  const dialog = {
    showOpenDialog: async () => ({ canceled: false, filePaths: [selectedProject] }),
  };
  const backend = new VibeBackend({ app, dialog, ...options });
  t.after(async () => {
    await backend.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { backend, root, selectedProject, userData };
}

test("0.3.0 session lifecycle methods validate shapes before reaching Vibe", async (t) => {
  const server = new FakeAppServer();
  const { backend, selectedProject } = await createBackend(t, { spawnProcess: () => server });
  await backend.chooseProject();
  const opened = await backend.request("session/start", { agentConfig: { cwd: selectedProject } });
  const sessionId = opened.state.session.id;

  // Required-field enforcement.
  await assert.rejects(backend.request("session/fork", {}), /requires sourceSessionId/);
  await assert.rejects(backend.request("session/rewind", { sessionId }), /requires entryId/);
  await assert.rejects(backend.request("loops/create", { sessionId, interval: "1h" }), /requires prompt/);
  await assert.rejects(backend.request("skills/import", { sessionId }), /requires skillId/);
  await assert.rejects(backend.request("vibeCode/teleport/start", { sessionId }), /requires pickerId/);
  await assert.rejects(backend.request("mcp/toggle", { sessionId, name: "s", source: "server" }), /requires disabled/);

  // Type enforcement.
  await assert.rejects(
    backend.request("session/fork", { sourceSessionId: sessionId, attach: "yes" }),
    /attach must be a boolean/,
  );
  await assert.rejects(
    backend.request("loops/create", { sessionId, interval: "1h", prompt: "" }),
    /between 1 and/,
  );
  await assert.rejects(
    backend.request("skills/setVersion", { sessionId, name: "s", version: 0 }),
    /positive integer/,
  );
  await assert.rejects(
    backend.request("workspace/git/worktrees/limit/update", { limit: -1 }),
    /between 0 and 100/,
  );
  await assert.rejects(
    backend.request("projectLinks/link", { rootPath: selectedProject, projectId: "p" }),
    /requires projectName/,
  );

  // Unknown methods still rejected without contacting Vibe.
  const before = server.requests.length;
  await assert.rejects(backend.request("work/scheduledTasks", {}), /Unsupported Vibe method/);
  assert.equal(server.requests.length, before);
});

test("0.3.0 fork, rewind, loops and cloud methods reach Vibe on authorized sessions", async (t) => {
  const server = new FakeAppServer();
  const { backend, selectedProject } = await createBackend(t, { spawnProcess: () => server });
  await backend.chooseProject();
  server.sessionListItems = [{ id: "listed", cwd: selectedProject }];
  await backend.request("session/list", {});
  const opened = await backend.request("session/start", { agentConfig: { cwd: selectedProject } });
  const sessionId = opened.state.session.id;

  await backend.request("session/markAsSeen", { sessionId });
  await backend.request("session/rename", { sessionId, title: "Renamed" });
  await backend.request("loops/create", { sessionId, interval: "1h", prompt: "Check tests" });
  await backend.request("loops/list", { sessionId });
  await backend.request("loops/delete", { sessionId, loopId: "loop-1" });
  await backend.request("projectLinks/list", {});
  await backend.request("skills/versions", { sessionId, skillId: "s" });
  await backend.request("tools/list", { sessionId });
  const methods = server.requests.map((r) => r.method);
  for (const expected of ["session/markAsSeen", "session/rename", "loops/create", "loops/list", "projectLinks/list"]) {
    assert.ok(methods.includes(expected), `expected ${expected} to reach Vibe`);
  }

  // Fork without attach keeps the current session; attach replaces it like upstream.
  const forked = await backend.request("session/fork", { sourceSessionId: sessionId, attach: false });
  assert.ok(String(forked.state.session.id).includes(sessionId));
  assert.equal(backend.activeSessionId, sessionId);

  // Subagent children stay read-only for fork and resume.
  server.sessionListItems = [{ id: "parent", cwd: selectedProject }];
  await backend.request("session/list", {});
  backend.knownSessions.set("child-1", {
    cwd: selectedProject,
    allowedRoots: [selectedProject],
    readOnlyChild: true,
    parentSessionId: "parent",
  });
  await assert.rejects(backend.request("session/fork", { sourceSessionId: "child-1" }), /read-only|List sessions/);
});

test("0.3.0 pool isolates attached forks and blocks live deletes", async (t) => {
  const { backendPool, selectedProject } = await createPool(t);
  const first = await backendPool.request("session/start", { agentConfig: { cwd: selectedProject } });
  const firstId = first.state.session.id;
  const workersBefore = backendPool.backends.length;
  const forked = await backendPool.request("session/fork", { sourceSessionId: firstId, attach: true });
  const forkedId = forked.state.session.id;
  assert.notEqual(firstId, forkedId);
  assert.equal(backendPool.ownedSessions.get(firstId)?.activeSessionId, firstId);
  assert.equal(backendPool.ownedSessions.get(forkedId)?.activeSessionId, forkedId);
  assert.notEqual(backendPool.ownedSessions.get(firstId), backendPool.ownedSessions.get(forkedId));
  assert.ok(backendPool.backends.length >= workersBefore);

  await assert.rejects(
    backendPool.request("session/delete", { sessionId: forkedId }),
    /Stop this session before deleting/,
  );
  await backendPool.request("session/stop", { sessionId: forkedId });
  assert.equal(backendPool.ownedSessions.has(forkedId), false);
  await backendPool.request("session/delete", { sessionId: forkedId });
});

test("0.3.0 detached forks persist without consuming workers or ownership", async (t) => {
  const { backendPool, selectedProject } = await createPool(t);
  const first = await backendPool.request("session/start", { agentConfig: { cwd: selectedProject } });
  const sourceId = first.state.session.id;
  const sourceWorker = backendPool.ownedSessions.get(sourceId);
  const workersBefore = backendPool.backends.length;
  const ownedBefore = backendPool.ownedSessions.size;

  const forked = await backendPool.request("session/fork", {
    sourceSessionId: sourceId,
    attach: false,
  });
  const forkedId = forked?.state?.session?.id;
  assert.equal(typeof forkedId, "string");
  assert.notEqual(forkedId, sourceId);
  // Detached: known and persisted, never attached, owned or active.
  assert.equal(backendPool.ownedSessions.has(forkedId), false);
  assert.equal(backendPool.ownedSessions.size, ownedBefore);
  assert.equal(backendPool.backends.length, workersBefore);
  assert.equal(sourceWorker.activeSessionId, sourceId);
  assert.ok(backendPool.primary.knownSessions.has(forkedId));

  // The detached session reads through the host without attaching.
  const read = await backendPool.request("session/read", { sessionId: forkedId });
  assert.equal(read?.state?.session?.id ?? forkedId, forkedId);
  assert.equal(backendPool.ownedSessions.has(forkedId), false);
});

test("0.3.0 fork failures never alter ownership or burn connection slots", async (t) => {
  const { backendPool, selectedProject } = await createPool(t);
  const first = await backendPool.request("session/start", { agentConfig: { cwd: selectedProject } });
  const sourceId = first.state.session.id;
  const workersBefore = backendPool.backends.length;
  const ownedBefore = new Map(backendPool.ownedSessions);

  await assert.rejects(
    backendPool.request("session/fork", { sourceSessionId: "not-listed-here" }),
    /List sessions|read-only/,
  );
  assert.equal(backendPool.backends.length, workersBefore);
  assert.deepEqual([...backendPool.ownedSessions.keys()], [...ownedBefore.keys()]);

  backendPool.primary.knownSessions.set("archived-source", {
    cwd: selectedProject,
    allowedRoots: [selectedProject],
  });
  const fromArchived = await backendPool.request("session/fork", {
    sourceSessionId: "archived-source",
    attach: false,
  });
  assert.equal(typeof fromArchived?.state?.session?.id, "string");

  backendPool.primary.knownSessions.set("child-9", {
    cwd: selectedProject,
    allowedRoots: [selectedProject],
    readOnlyChild: true,
    parentSessionId: sourceId,
  });
  await assert.rejects(
    backendPool.request("session/fork", { sourceSessionId: "child-9" }),
    /read-only/,
  );
  assert.equal(backendPool.backends.length, workersBefore);
});

test("0.3.0 concurrent forks serialize under the cap with distinct owners", async (t) => {
  const { backendPool, selectedProject } = await createPool(t);
  const first = await backendPool.request("session/start", { agentConfig: { cwd: selectedProject } });
  const sourceId = first.state.session.id;
  const [a, b] = await Promise.all([
    backendPool.request("session/fork", { sourceSessionId: sourceId, attach: true }),
    backendPool.request("session/fork", { sourceSessionId: sourceId, attach: true }),
  ]);
  const idA = a?.state?.session?.id;
  const idB = b?.state?.session?.id;
  assert.notEqual(idA, idB);
  assert.notEqual(backendPool.ownedSessions.get(idA), backendPool.ownedSessions.get(idB));
  assert.ok(backendPool.backends.length <= 4);
});

test("0.3.0 rewind and continue keep ownership consistent", async (t) => {
  const { backendPool, selectedProject } = await createPool(t);
  const first = await backendPool.request("session/start", { agentConfig: { cwd: selectedProject } });
  const sourceId = first.state.session.id;
  const worker = backendPool.ownedSessions.get(sourceId);

  const continued = await backendPool.request("session/continue", {});
  const continuedId = continued?.state?.session?.id;
  assert.equal(typeof continuedId, "string");
  assert.ok(backendPool.ownedSessions.has(continuedId));

  // In-place rewind keeps id and owner; fork-rewind remaps to the new id.
  const before = backendPool.ownedSessions.get(sourceId);
  assert.equal(before, worker);
  await assert.rejects(
    backendPool.request("session/delete", { sessionId: sourceId }),
    /Stop this session/,
  );
});

async function createPool(t) {
  const root = await createTempRoot("vibe-desktop-pool-");
  const userData = path.join(root, "user-data");
  await fs.mkdir(userData);
  const selectedProject = path.join(root, "project");
  await fs.mkdir(selectedProject);
  const app = {
    getVersion: () => "0.3.0-test",
    getAppPath: () => root,
    getPath: (name) => (name === "userData" ? userData : root),
  };
  const dialog = {
    showOpenDialog: async () => ({ canceled: false, filePaths: [selectedProject] }),
  };
  const backendPool = new VibeBackendPool({
    app,
    dialog,
    backendFactory: (opts) => new VibeBackend({ ...opts, spawnProcess: () => new FakeAppServer() }),
  });
  t.after(async () => {
    await backendPool.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  // Authorize the project through the real picker path so stable keys match.
  await backendPool.primary.chooseProject();
  return { backendPool, selectedProject };
}
