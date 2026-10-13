import { EventEmitter } from "node:events";
import { VibeBackend } from "./backend.js";

const MAX_CONNECTIONS = 4;
const SESSION_READ_METHODS = new Set([
  "session/read",
  "session/history/list",
  "session/history/get",
  "session/turns/list",
  "session/rewind/read",
  "session/ready/read",
  "session/ready/wait",
  "session/log/read",
  "session/backgroundProcess/output",
]);
const NEW_SESSION_METHODS = new Set([
  "session/start",
  "session/resume",
  "session/continue",
  "session/fork",
]);
const HOST_METADATA_METHODS = new Set([
  "session/pin",
  "session/archive",
  "session/markAsSeen",
  "session/rename",
  "session/title/update",
  "session/delete",
]);

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
    if (method === "session/start" || method === "session/continue")
      return this.#withAllocationLock(() => this.#startNew(method, params));
    if (method === "session/resume")
      return this.#withAllocationLock(() => this.#resume(params));
    if (method === "session/fork")
      return this.#withAllocationLock(() => this.#fork(params));

    const sessionId = params?.sessionId ?? params?.sourceSessionId;
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
    if (method === "session/delete") {
      if (owner) throw new Error("Stop this session before deleting it");
      return this.primary.request(method, params);
    }
    if (method === "session/rewind") {
      // In-place rewind mutates the attached session; fork-rewind replaces it.
      if (params?.inplace === false) {
        if (!owner) throw new Error("This session is not attached to this app");
        const result = await owner.request(method, params);
        const nextId = result?.state?.session?.id ?? result?.session?.id;
        if (typeof nextId === "string" && nextId !== sessionId) {
          this.ownedSessions.delete(sessionId);
          this.ownedSessions.set(nextId, owner);
        }
        return result;
      }
      if (!owner) throw new Error("This session is not attached to this app");
      return owner.request(method, params);
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
    if (HOST_METADATA_METHODS.has(method)) {
      if (owner) return owner.request(method, params);
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

  async #fork(params) {
    const sourceId = params?.sourceSessionId;
    if (typeof sourceId === "string") {
      const sourceEntry = this.primary.knownSessions.get(sourceId);
      if (sourceEntry?.readOnlyChild)
        throw new Error(
          "Subagent sessions are read-only and remain controlled by their parent",
        );
      // Validate the source is listed before consuming a worker slot: an
      // unlisted source must fail without growing the backend list.
      this.primary.validateForkSourceForPool(params);
      // A source owned by another worker with a live turn must not be forked
      // mid-turn: the transcript could race the copy. This matches the
      // single backend's active-turn guard for the same source, which the
      // pool would otherwise bypass by allocating an idle worker.
      const sourceOwner = this.ownedSessions.get(sourceId);
      if (sourceOwner?.activeTurnId)
        throw new Error(
          "Interrupt or wait for the active turn before forking this session",
        );
    }
    // Upstream contract (2.26.1): attach:false persists a known session but
    // attaches nothing (backend is shut down server-side, session_attached=false).
    // It must not consume a worker slot or appear in ownedSessions.
    if (params?.attach === false) {
      const result = await this.primary.request("session/fork", params);
      const nextId =
        result?.state?.session?.id ?? result?.session?.id ?? result?.sessionId;
      if (typeof nextId !== "string" || !nextId)
        throw new Error(
          "Vibe forked a session without returning its session id",
        );
      if (this.ownedSessions.has(nextId))
        throw new Error(
          "Vibe returned a session id already attached to this app",
        );
      return result;
    }
    const worker = this.#allocateBackend();
    try {
      const result = await worker.request("session/fork", params);
      const nextId =
        result?.state?.session?.id ?? result?.session?.id ?? result?.sessionId;
      if (typeof nextId !== "string" || !nextId)
        throw new Error(
          "Vibe forked a session without returning its session id",
        );
      if (this.ownedSessions.has(nextId)) {
        // Do not leave the worker holding a duplicate root.
        try {
          await worker.request("session/stop", { sessionId: nextId });
        } catch {
          /* Best effort: the id collision already fails the call. */
        }
        throw new Error(
          "Vibe returned a session id already attached to this app",
        );
      }
      this.ownedSessions.set(nextId, worker);
      this.emit("status", { ...worker.status, sessionId: nextId });
      return result;
    } catch (error) {
      // A failed attached fork must not leave a half-attached worker claiming
      // the source session. Ownership is only set on success above.
      throw error;
    }
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
