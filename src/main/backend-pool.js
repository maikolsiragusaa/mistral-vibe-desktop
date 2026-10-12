import { EventEmitter } from "node:events";
import { VibeBackend } from "./backend.js";

const MAX_CONNECTIONS = 4;
const SESSION_READ_METHODS = new Set(["session/read", "session/history/list"]);
const NEW_SESSION_METHODS = new Set(["session/start", "session/resume"]);

/**
 * Keeps one official app-server connection attached to each live desktop
 * session. Vibe's protocol switches the root session per connection, so a
 * single connection cannot safely keep two tabs generating at once.
 */
export class VibeBackendPool extends EventEmitter {
  constructor(options = {}) {
    super();
    const {
      maxConnections = MAX_CONNECTIONS,
      backendFactory = (backendOptions) => new VibeBackend(backendOptions),
      ...backendOptions
    } = options;
    if (
      !Number.isInteger(maxConnections) ||
      maxConnections < 1 ||
      maxConnections > MAX_CONNECTIONS
    )
      throw new TypeError(
        `maxConnections must be between 1 and ${MAX_CONNECTIONS}`,
      );
    this.maxConnections = maxConnections;
    this.backendFactory = backendFactory;
    this.backendOptions = backendOptions;
    this.primary = backendFactory(backendOptions);
    this.backends = [this.primary];
    this.ownedSessions = new Map();
    this.allocationTail = Promise.resolve();
    this.shuttingDown = false;
    this.#attach(this.primary);
  }

  get status() {
    const connected = this.backends.find(
      (backend) => backend.status?.state === "ready",
    );
    if (connected) return { state: "ready" };
    return this.primary.status ?? { state: "disconnected" };
  }

  async connect() {
    if (this.shuttingDown) throw new Error("Vibe backend is shutting down");
    return this.primary.connect();
  }

  async request(method, params = {}) {
    if (this.shuttingDown) throw new Error("Vibe backend is shutting down");
    if (method === "session/start")
      return this.#withAllocationLock(() => this.#startNew(method, params));
    if (method === "session/resume")
      return this.#withAllocationLock(() => this.#resume(params));

    const sessionId = params?.sessionId;
    const owner =
      typeof sessionId === "string" ? this.ownedSessions.get(sessionId) : null;
    if (method === "session/stop") {
      if (!owner) throw new Error("This session is not attached to this app");
      try {
        return await owner.request(method, params);
      } finally {
        this.ownedSessions.delete(sessionId);
      }
    }
    if (SESSION_READ_METHODS.has(method)) {
      if (owner) return owner.request(method, params);
      const knownSession = this.primary.knownSessions.get(sessionId);
      const parentOwner = knownSession?.readOnlyChild
        ? this.ownedSessions.get(knownSession.parentSessionId)
        : null;
      if (parentOwner) return parentOwner.request(method, params);
      // The official server handles canonical stored-session reads at the host
      // boundary; this does not replace the primary connection's live root.
      return this.primary.request(method, params);
    }
    if (NEW_SESSION_METHODS.has(method))
      throw new Error("Session allocation failed");
    if (sessionId && owner) return owner.request(method, params);
    return this.primary.request(method, params);
  }

  chooseProject() {
    return this.primary.chooseProject();
  }
  authorizeProjectRoot(cwd) {
    return this.primary.authorizeProjectRoot(cwd);
  }
  readPreferences() {
    return this.primary.readPreferences();
  }
  savePreferences(input) {
    return this.primary.savePreferences(input);
  }
  openExternal(url, shell) {
    return this.primary.openExternal(url, shell);
  }

  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const workers = [...this.backends];
    this.ownedSessions.clear();
    await Promise.allSettled(workers.map((backend) => backend.shutdown()));
  }

  async #startNew(method, params) {
    const worker = this.#allocateBackend();
    const result = await worker.request(method, params);
    const sessionId = result?.state?.session?.id;
    if (typeof sessionId !== "string" || !sessionId)
      throw new Error(
        "Vibe started a session without returning its session id",
      );
    if (this.ownedSessions.has(sessionId))
      throw new Error(
        "Vibe returned a session id already attached to this app",
      );
    this.ownedSessions.set(sessionId, worker);
    this.emit("status", { ...worker.status, sessionId });
    return result;
  }

  async #resume(params) {
    const sessionId = params?.sessionId;
    this.primary.validateResumeForPool(params);
    if (typeof sessionId === "string") {
      const attached = this.ownedSessions.get(sessionId);
      if (attached) {
        attached.validateResumeForPool(params);
        return attached.request("session/read", { sessionId });
      }
    }
    const worker = this.#allocateBackend();
    const result = await worker.request("session/resume", params);
    const resumedId = result?.state?.session?.id;
    if (typeof resumedId !== "string" || !resumedId)
      throw new Error(
        "Vibe resumed a session without returning its session id",
      );
    this.ownedSessions.set(resumedId, worker);
    this.emit("status", { ...worker.status, sessionId: resumedId });
    return result;
  }

  #allocateBackend() {
    const available = this.backends.find((backend) => !backend.activeSessionId);
    if (available) return available;
    if (this.backends.length >= this.maxConnections)
      throw new Error(
        `At most ${this.maxConnections} Vibe sessions can be attached at once`,
      );
    const worker = this.backendFactory(this.backendOptions);
    worker.authorizedProjects = this.primary.authorizedProjects;
    worker.knownSessions = this.primary.knownSessions;
    this.backends.push(worker);
    this.#attach(worker);
    return worker;
  }

  #attach(backend) {
    backend.on("event", (event) => {
      const original =
        event?.params && typeof event.params === "object" ? event.params : {};
      const nestedSession = original.callback?.sessionId;
      const sessionId =
        original.sessionId ?? nestedSession ?? backend.activeSessionId ?? null;
      const forwarded =
        sessionId && !original.sessionId
          ? { ...event, params: { ...original, sessionId } }
          : event;
      this.emit("event", forwarded);
    });
    backend.on("status", (status) => {
      const attachedId = [...this.ownedSessions].find(
        ([, owner]) => owner === backend,
      )?.[0];
      const sessionId = backend.activeSessionId ?? attachedId ?? null;
      this.emit("status", { ...status, sessionId });
      if (["error", "disconnected"].includes(status?.state)) {
        for (const [id, owner] of this.ownedSessions) {
          if (owner === backend) this.ownedSessions.delete(id);
        }
      }
    });
  }

  async #withAllocationLock(operation) {
    let release;
    const previous = this.allocationTail;
    this.allocationTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.shuttingDown) throw new Error("Vibe backend is shutting down");
      return await operation();
    } finally {
      release();
    }
  }
}
