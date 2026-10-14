import { EventEmitter } from "node:events";

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

function idKey(id) {
  if (typeof id === "number" && Number.isFinite(id)) return `n:${id}`;
  if (typeof id === "string") return `s:${id}`;
  return null;
}

function responseError(payload) {
  const error = new Error(
    typeof payload?.message === "string"
      ? payload.message
      : "Vibe request failed",
  );
  if (typeof payload?.code === "number") error.code = payload.code;
  return error;
}

/** JSON-RPC 2.0 over newline-delimited UTF-8 frames on a child process. */
export class JsonRpcClient extends EventEmitter {
  constructor(
    child,
    { maxFrameBytes = MAX_FRAME_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
  ) {
    super();
    this.child = child;
    this.maxFrameBytes = maxFrameBytes;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.failure = null;

    child.stdout.on("data", (chunk) => this.#read(chunk));
    child.stdout.on("error", () =>
      this.#fail(new Error("Vibe app server output failed")),
    );
    // Drain stderr to keep the child from blocking. It can include workspace or
    // provider diagnostics, so it is intentionally never copied into app logs.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () =>
      this.#fail(new Error("Vibe app server input failed")),
    );
    child.once("error", () =>
      this.#fail(new Error("Vibe app server could not start")),
    );
    child.once("exit", (code, signal) => {
      this.#fail(new Error("Vibe app server exited"));
      this.emit("exit", { code, signal });
    });
  }

  async request(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    this.#ensureOpen();
    const id = this.nextId++;
    const key = idKey(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error("Vibe app server request timed out"));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(key, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#write({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        const pending = this.pending.get(key);
        this.pending.delete(key);
        pending?.reject(error);
      });
    });
  }

  async notify(method, params = {}) {
    this.#ensureOpen();
    return this.#write({ jsonrpc: "2.0", method, params });
  }

  async respond(id, result) {
    this.#ensureOpen();
    return this.#write({ jsonrpc: "2.0", id, result });
  }

  async respondError(id, code, message) {
    this.#ensureOpen();
    return this.#write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  close(error = new Error("Vibe app server connection closed")) {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  #ensureOpen() {
    if (this.closed || this.child.exitCode !== null || this.child.killed) {
      throw this.failure ?? new Error("Vibe app server is not connected");
    }
  }

  async #write(message) {
    const frame = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (frame.length > this.maxFrameBytes)
      throw new Error("Vibe request is too large");
    const stdin = this.child.stdin;
    if (this.closed || stdin.destroyed || !stdin.writable) {
      throw this.failure ?? new Error("Vibe app server is not connected");
    }
    await new Promise((resolve, reject) => {
      stdin.write(frame, (error) =>
        error ? reject(new Error("Vibe app server write failed")) : resolve(),
      );
    });
  }

  #read(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : Buffer.from(chunk);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > this.maxFrameBytes) {
        this.#fail(new Error("Vibe app server frame exceeded the size limit"));
        return;
      }
      let frame = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (frame.length && frame[frame.length - 1] === 0x0d)
        frame = frame.subarray(0, -1);
      if (!frame.length) continue;
      let message;
      try {
        message = JSON.parse(frame.toString("utf8"));
      } catch {
        this.#fail(new Error("Vibe app server sent invalid JSON"));
        return;
      }
      this.#dispatch(message);
      if (this.closed) return;
    }
    if (this.buffer.length > this.maxFrameBytes) {
      this.#fail(new Error("Vibe app server frame exceeded the size limit"));
    }
  }

  #dispatch(message) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
      this.#fail(new Error("Vibe app server sent an invalid JSON-RPC message"));
      return;
    }

    if (Object.hasOwn(message, "id") && typeof message.method === "string") {
      this.#handleServerRequest(message);
      return;
    }

    if (Object.hasOwn(message, "id")) {
      const key = idKey(message.id);
      const pending = key ? this.pending.get(key) : undefined;
      if (pending) {
        this.pending.delete(key);
        if (message.error) pending.reject(responseError(message.error));
        else if (Object.hasOwn(message, "result"))
          pending.resolve(message.result);
        else
          pending.reject(new Error("Vibe app server sent an invalid response"));
      }
      return;
    }

    if (typeof message.method === "string") {
      this.emit("event", {
        method: message.method,
        params: message.params ?? {},
      });
      return;
    }

    this.#fail(new Error("Vibe app server sent an invalid JSON-RPC message"));
  }

  #handleServerRequest(message) {
    if (message.method !== "callback/call") {
      this.respondError(message.id, -32601, "Method not found").catch(() => {});
      return;
    }
    const callback = message.params?.callback;
    const callbackId = callback?.callbackId;
    const kind = callback?.detail?.kind;
    if (
      typeof callbackId !== "string" ||
      !["approval", "user_input"].includes(kind)
    ) {
      this.respondError(message.id, -32601, "Unsupported callback").catch(
        () => {},
      );
      return;
    }
    // Delivery acknowledgement unblocks the server; the user-facing answer is
    // a later callback/result request from the renderer.
    this.respond(message.id, { callbackId, accepted: true })
      .then(() => {
        this.emit("event", { method: "callback/call", params: message.params });
      })
      .catch(() => {});
  }

  #fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.emit("transportError", error);
  }
}
