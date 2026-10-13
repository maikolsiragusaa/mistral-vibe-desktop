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

test("0.3.0 pool isolates forked sessions and blocks live deletes", async (t) => {
  const { backendPool, selectedProject, cleanup } = await createPool(t);
  const first = await backendPool.request("session/start", { agentConfig: { cwd: selectedProject } });
  const firstId = first.state.session.id;
  const forked = await backendPool.request("session/fork", { sourceSessionId: firstId, attach: true });
  const forkedId = forked.state.session.id;
  assert.notEqual(firstId, forkedId);
  assert.ok(backendPool.ownedSessions.has(firstId) || backendPool.ownedSessions.has(forkedId));

  await assert.rejects(
    backendPool.request("session/delete", { sessionId: forkedId }),
    /Stop this session before deleting/,
  );
  await backendPool.request("session/stop", { sessionId: forkedId });
  await backendPool.request("session/delete", { sessionId: forkedId });
  await cleanup();
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
  // Authorize the project on the shared known-session map.
  backendPool.primary.authorizedProjects.set(selectedProject.toLowerCase(), selectedProject);
  backendPool.primary.knownSessions.set("seed", { cwd: selectedProject, allowedRoots: [selectedProject] });
  // Seed fork source as listed.
  const start = await backendPool.request("session/start", { agentConfig: { cwd: selectedProject } });
  const sourceId = start.state.session.id;
  backendPool.primary.knownSessions.set(sourceId, { cwd: selectedProject, allowedRoots: [selectedProject] });
  // Reset ownership for the test's own start below (keep worker but clear map).
  // The pool already owns sourceId; fork from it is valid.
  t.after(async () => {
    await backendPool.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    backendPool,
    selectedProject,
    cleanup: async () => {},
  };
}
