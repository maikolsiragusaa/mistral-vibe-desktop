import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { VibeBackendPool } from "../src/main/backend-pool.js";

test("sessions keep independent app-server owners and resume-in-place only reads", async (t) => {
  const backends = [];
  const pool = new VibeBackendPool({
    backendFactory: () => {
      const backend = new FakeBackend();
      backends.push(backend);
      return backend;
    },
  });
  t.after(() => pool.shutdown());

  const statuses = [];
  const events = [];
  pool.on("status", (status) => statuses.push(status));
  pool.on("event", (event) => events.push(event));
  const first = await pool.request("session/start", {
    agentConfig: { cwd: "C:\\selected\\one" },
  });
  const second = await pool.request("session/start", {
    agentConfig: { cwd: "C:\\selected\\two" },
  });
  const firstId = first.state.session.id;
  const secondId = second.state.session.id;
  assert.equal(backends.length, 2);
  assert.equal(pool.ownedSessions.get(firstId), backends[0]);
  assert.equal(pool.ownedSessions.get(secondId), backends[1]);
  assert.ok(statuses.some((status) => status.sessionId === firstId));
  assert.ok(statuses.some((status) => status.sessionId === secondId));

  backends[0].notify({
    method: "callback/call",
    params: { sessionId: firstId },
  });
  assert.equal(events.at(-1).params.sessionId, firstId);
  await pool.request("turn/start", { sessionId: firstId, message: [] });
  assert.ok(
    backends[0].requests.some((request) => request.method === "turn/start"),
  );
  assert.ok(
    !backends[1].requests.some((request) => request.method === "turn/start"),
  );

  const subagentId = "subagent-of-second-session";
  pool.primary.knownSessions.set(subagentId, {
    cwd: "C:\\selected\\two",
    allowedRoots: ["C:\\selected\\two"],
    readOnlyChild: true,
    parentSessionId: secondId,
  });
  await pool.request("session/read", { sessionId: subagentId });
  assert.ok(
    backends[1].requests.some(
      (request) =>
        request.method === "session/read" &&
        request.params.sessionId === subagentId,
    ),
  );
  assert.equal(pool.ownedSessions.has(subagentId), false);
  assert.equal(pool.ownedSessions.get(secondId), backends[1]);
  await assert.rejects(
    pool.request("session/resume", { sessionId: subagentId }),
    /parent-controlled/,
  );
  assert.equal(
    backends.length,
    2,
    "rejected child resume does not allocate a worker",
  );

  const resumed = await pool.request("session/resume", {
    sessionId: firstId,
    agentConfig: { cwd: "C:\\selected\\one" },
  });
  assert.equal(resumed.state.session.id, firstId);
  assert.equal(backends[0].requests.at(-1).method, "session/read");
  assert.ok(
    !backends[0].requests.some(
      (request) => request.method === "session/resume",
    ),
  );

  await pool.request("session/stop", { sessionId: firstId });
  assert.equal(pool.ownedSessions.has(firstId), false);
  assert.equal(pool.ownedSessions.get(secondId), backends[1]);
  assert.equal(backends[1].activeSessionId, secondId);
});

test("allocations serialize, cap at four, and shutdown owns every child process", async (t) => {
  const backends = [];
  const pool = new VibeBackendPool({
    maxConnections: 4,
    backendFactory: () => {
      const backend = new FakeBackend();
      backends.push(backend);
      return backend;
    },
  });
  t.after(() => pool.shutdown());

  const sessions = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      pool.request("session/start", {
        agentConfig: { cwd: `C:\\selected\\project-${index}` },
      }),
    ),
  );
  assert.equal(backends.length, 4);
  assert.equal(pool.ownedSessions.size, 4);
  await assert.rejects(
    pool.request("session/start", {
      agentConfig: { cwd: "C:\\selected\\fifth" },
    }),
    /At most 4/,
  );

  await pool.shutdown();
  assert.deepEqual(
    backends.map((backend) => backend.shutdownCalls),
    [1, 1, 1, 1],
  );
  assert.equal(pool.ownedSessions.size, 0);
  assert.ok(
    sessions.every((session) => typeof session.state.session.id === "string"),
  );
});

test("unattached session reads use the primary host connection without replacing a live owner", async (t) => {
  const backends = [];
  const pool = new VibeBackendPool({
    backendFactory: () => {
      const backend = new FakeBackend();
      backends.push(backend);
      return backend;
    },
  });
  t.after(() => pool.shutdown());
  const live = await pool.request("session/start", {
    agentConfig: { cwd: "C:\\selected\\live" },
  });
  const liveId = live.state.session.id;
  pool.primary.knownSessions.set("stored-session", {
    cwd: "C:\\selected\\stored",
    allowedRoots: ["C:\\selected\\stored"],
  });

  const read = await pool.request("session/read", {
    sessionId: "stored-session",
  });
  assert.equal(read.state.session.id, "stored-session");
  assert.ok(
    pool.primary.requests.some((request) => request.method === "session/read"),
  );
  assert.equal(pool.ownedSessions.get(liveId), pool.primary);
  assert.equal(pool.primary.activeSessionId, liveId);
});

test("pool rejects unsafe connection limits", () => {
  assert.throws(
    () => new VibeBackendPool({ maxConnections: 5 }),
    /between 1 and 4/,
  );
  assert.throws(
    () => new VibeBackendPool({ maxConnections: 0 }),
    /between 1 and 4/,
  );
});

test("worktree usage describes occupied, idle, free and unknown placement read-only", async (t) => {
  const backends = [];
  const pool = new VibeBackendPool({
    backendFactory: () => {
      const backend = new FakeBackend();
      backends.push(backend);
      return backend;
    },
  });
  t.after(() => pool.shutdown());
  const worker = backends[0];
  worker.activeTurnId = null;
  worker.pendingCallbacks = new Map();
  worker.sessionLeaseHolders = new Map();
  pool.primary.sessionLeaseHolders = new Map();
  pool.primary.knownSessions.set("sess-live", {
    cwd: "C:\\managed\\wt-one",
    allowedRoots: ["C:\\managed\\wt-one"],
  });
  pool.primary.knownSessions.set("sess-saved", {
    cwd: "C:\\managed\\wt-one",
    allowedRoots: ["C:\\managed\\wt-one"],
  });
  pool.ownedSessions.set("sess-live", worker);
  worker.activeSessionId = "sess-live";
  worker.activeTurnId = "turn-9";

  const occupied = pool.describeWorktreeUsage("C:\\managed\\wt-one", { platform: "win32" });
  assert.equal(occupied.unknown, false);
  assert.equal(occupied.sessions.length, 2);
  const live = occupied.sessions.find((s) => s.sessionId === "sess-live");
  assert.equal(live.occupied, true);
  assert.equal(live.hasActiveTurn, true);
  assert.equal(live.attached, true);
  const saved = occupied.sessions.find((s) => s.sessionId === "sess-saved");
  assert.equal(saved.occupied, false);
  assert.ok(Object.isFrozen(occupied));
  assert.ok(Object.isFrozen(occupied.sessions));

  // Case-insensitive match on Windows.
  const lower = pool.describeWorktreeUsage("c:\\MANAGED\\wt-one", { platform: "win32" });
  assert.equal(lower.sessions.length, 2);

  // A checkout with no sessions is free, never unknown.
  const free = pool.describeWorktreeUsage("C:\\managed\\wt-empty", { platform: "win32" });
  assert.equal(free.unknown, false);
  assert.deepEqual([...free.sessions], []);

  // An active turn on an unlisted session cannot be placed: unknown blocks.
  worker.activeSessionId = "sess-ghost";
  worker.activeTurnId = "turn-ghost";
  const unknown = pool.describeWorktreeUsage("C:\\managed\\wt-one", { platform: "win32" });
  assert.equal(unknown.unknown, true);

  // Pending callbacks for unknown sessions are also unverifiable.
  worker.activeSessionId = null;
  worker.activeTurnId = null;
  worker.pendingCallbacks.set("cb-1", { sessionId: "sess-ghost", kind: "approval" });
  const unknownCallbacks = pool.describeWorktreeUsage("C:\\managed\\wt-empty", { platform: "win32" });
  assert.equal(unknownCallbacks.unknown, true);

  // Leases held on a placed session mark it occupied without any turn.
  worker.pendingCallbacks.clear();
  pool.primary.sessionLeaseHolders.set("sess-saved", { processId: 1234 });
  const leased = pool.describeWorktreeUsage("C:\\managed\\wt-one", { platform: "win32" });
  assert.equal(leased.unknown, false);
  assert.equal(leased.sessions.find((s) => s.sessionId === "sess-saved").occupied, true);
  assert.equal(leased.sessions.find((s) => s.sessionId === "sess-saved").leaseHeld, true);
});

class FakeBackend extends EventEmitter {
  constructor() {
    super();
    this.identity = ++FakeBackend.nextIdentity;
    this.activeSessionId = null;
    this.activeProjectRoot = null;
    this.authorizedProjects = new Map();
    this.knownSessions = new Map();
    this.requests = [];
    this.shutdownCalls = 0;
    this._nextSession = 1;
  }

  get status() {
    return { state: "ready" };
  }
  async connect() {
    return { serverInfo: { name: "fixture" }, setup: {} };
  }
  chooseProject() {
    return Promise.resolve(null);
  }
  authorizeProjectRoot(cwd) {
    return Promise.resolve(cwd);
  }
  readPreferences() {
    return Promise.resolve({ theme: "system", recentProjects: [] });
  }
  savePreferences(input) {
    return Promise.resolve(input);
  }
  openExternal() {
    return Promise.resolve();
  }

  validateResumeForPool(params) {
    if (!params?.sessionId || !this.knownSessions.has(params.sessionId))
      throw new Error("session must be known");
    if (this.knownSessions.get(params.sessionId)?.readOnlyChild)
      throw new Error("subagent is parent-controlled");
  }

  async request(method, params = {}) {
    this.requests.push({ method, params });
    if (method === "session/start" || method === "session/resume") {
      const id =
        method === "session/resume"
          ? params.sessionId
          : `session-${this.identity}-${this._nextSession++}`;
      const cwd =
        params.agentConfig?.cwd ??
        this.knownSessions.get(id)?.cwd ??
        "C:\\selected\\project";
      this.activeSessionId = id;
      this.activeProjectRoot = cwd;
      this.knownSessions.set(id, { cwd, allowedRoots: [cwd] });
      this.emit("status", { state: "ready" });
      return { state: { session: { id, cwd } } };
    }
    if (method === "session/read") {
      const known = this.knownSessions.get(params.sessionId);
      return {
        state: { session: { id: params.sessionId, cwd: known?.cwd ?? null } },
      };
    }
    if (method === "session/stop") {
      this.activeSessionId = null;
      this.activeProjectRoot = null;
      this.emit("status", { state: "disconnected" });
      return { stopped: true };
    }
    if (method === "turn/start")
      return {
        turn: {
          id: "fixture-turn",
          status: "in_progress",
          sessionId: params.sessionId,
        },
      };
    return {};
  }

  notify(event) {
    this.emit("event", event);
  }

  async shutdown() {
    this.shutdownCalls += 1;
    this.activeSessionId = null;
    this.activeProjectRoot = null;
    this.emit("status", { state: "disconnected" });
  }
}

FakeBackend.nextIdentity = 0;
