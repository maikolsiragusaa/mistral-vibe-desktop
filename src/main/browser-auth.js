import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import path from "node:path";
import { resolveServerExecutable } from "./backend.js";

const OFFICIAL_AUTH_ORIGIN = "https://console.mistral.ai";
const MAX_RESPONSE_LINE = 64 * 1024;
const BEGIN_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 15_000;
const MAX_AUTH_ATTEMPT_MS = 15 * 60_000;

const SAFE_MESSAGES = Object.freeze({
  AUTH_STATUS_FAILED: "Could not read the current sign-in status.",
  BROWSER_SIGN_IN_FAILED: "Mistral sign-in could not be completed.",
  AUTH_PROCESS_FAILED: "The sign-in helper stopped unexpectedly.",
  AUTH_PROCESS_MISSING: "The sign-in helper could not be started.",
  AUTH_RESPONSE_INVALID: "The sign-in helper returned an invalid response.",
  AUTH_TIMEOUT: "The sign-in helper did not respond in time.",
  AUTH_URL_UNTRUSTED:
    "The sign-in link did not match the official Mistral console.",
  AUTH_ATTEMPT_ACTIVE: "A sign-in attempt is already in progress.",
  AUTH_ATTEMPT_EXPIRED:
    "This sign-in attempt has expired. Start again to get a new link.",
  AUTH_ATTEMPT_MISMATCH: "This sign-in attempt is no longer active.",
  AUTH_OPEN_FAILED: "Could not open the Mistral sign-in page.",
  AUTH_CANCELLED: "Sign-in was cancelled.",
});

export class BrowserAuthError extends Error {
  constructor(
    code,
    message = SAFE_MESSAGES[code] ?? SAFE_MESSAGES.BROWSER_SIGN_IN_FAILED,
  ) {
    super(message);
    this.name = "BrowserAuthError";
    this.code = code;
  }
}

function safeAttemptId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function safePersistMetadata(value) {
  const result = {};
  for (const key of [
    "persistResult",
    "persistProviderResult",
    "persistConsoleBaseUrlResult",
    "persistVibeBaseUrlResult",
  ]) {
    if (typeof value?.[key] === "string" && value[key].length <= 64)
      result[key] = value[key];
  }
  return result;
}

function validateOfficialSignInUrl(value) {
  if (typeof value !== "string" || value.length > 4096)
    throw new BrowserAuthError("AUTH_URL_UNTRUSTED");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserAuthError("AUTH_URL_UNTRUSTED");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== OFFICIAL_AUTH_ORIGIN ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hash
  ) {
    throw new BrowserAuthError("AUTH_URL_UNTRUSTED");
  }
  return url.toString();
}

function processEnvironment(env, platform) {
  const result = { ...env };
  delete result.NODE_OPTIONS;
  delete result.ELECTRON_RUN_AS_NODE;
  delete result.ELECTRON_NO_ATTACH_CONSOLE;
  delete result.PYTHONPATH;
  delete result.PYTHONHOME;
  if (platform === "win32") {
    for (const key of Object.keys(result))
      if (key.toUpperCase() === "NODEFAULTCURRENTDIRECTORYINEXEPATH")
        delete result[key];
    result.NODEFAULTCURRENTDIRECTORYINEXEPATH = "1";
  }
  return result;
}

function waitForClose(child, timeoutMs = 750) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    const onClose = () => finish();
    function finish() {
      clearTimeout(timer);
      child.off?.("close", onClose);
      resolve();
    }
    child.once?.("close", onClose);
  });
}

/**
 * Owns a single official Vibe delegated-auth helper process. It does not expose
 * sign-in URLs or credentials to the renderer; begin() opens the validated URL.
 */
export class BrowserAuthService extends EventEmitter {
  constructor({
    app,
    env = process.env,
    openExternal,
    spawnProcess = spawn,
    platform = process.platform,
    resourcesPath = process.resourcesPath,
    exists,
    now = Date.now,
    requestTimeoutMs = STATUS_TIMEOUT_MS,
  }) {
    super();
    if (
      !app ||
      typeof app.getAppPath !== "function" ||
      typeof app.getPath !== "function"
    )
      throw new TypeError(
        "BrowserAuthService requires an Electron app adapter",
      );
    if (typeof openExternal !== "function")
      throw new TypeError(
        "BrowserAuthService requires an external browser opener",
      );
    this.app = app;
    this.env = env;
    this.openExternal = openExternal;
    this.spawnProcess = spawnProcess;
    this.platform = platform;
    this.resourcesPath = resourcesPath;
    this.exists = exists;
    this.now = now;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.pendingRequests = new Map();
    this.statusOperation = null;
    this.nextRequestId = 0;
    this.outputBuffer = "";
    this.closingChild = false;
    this.expiresAtMs = null;
    this.attemptId = null;
    this.persistMetadata = {};
    this.current = { state: "idle" };
  }

  async begin() {
    if (this.statusOperation) await this.statusOperation.catch(() => {});
    if (
      ["starting", "awaiting_browser", "verifying"].includes(this.current.state)
    )
      throw new BrowserAuthError("AUTH_ATTEMPT_ACTIVE");

    this.attemptId = null;
    this.expiresAtMs = null;
    this.persistMetadata = {};
    this.#setStatus({ state: "starting" });
    try {
      await this.#ensureChild();
      const result = await this.#request("begin", {}, BEGIN_TIMEOUT_MS);
      if (
        !safeAttemptId(result?.attemptId) ||
        typeof result?.expiresAt !== "string"
      )
        throw new BrowserAuthError("AUTH_RESPONSE_INVALID");
      const expiresAtMs = Date.parse(result.expiresAt);
      if (
        !Number.isFinite(expiresAtMs) ||
        expiresAtMs <= this.now() ||
        expiresAtMs - this.now() > MAX_AUTH_ATTEMPT_MS
      ) {
        throw new BrowserAuthError("AUTH_RESPONSE_INVALID");
      }
      const signInUrl = validateOfficialSignInUrl(result.signInUrl);
      this.attemptId = result.attemptId;
      this.expiresAtMs = expiresAtMs;
      this.#setStatus({
        state: "awaiting_browser",
        attemptId: this.attemptId,
        expiresAt: new Date(expiresAtMs).toISOString(),
      });
      try {
        await this.openExternal(signInUrl);
      } catch {
        await this.cancel(this.attemptId);
        throw new BrowserAuthError("AUTH_OPEN_FAILED");
      }
      return this.status();
    } catch (error) {
      if (!(error instanceof BrowserAuthError))
        error = new BrowserAuthError("BROWSER_SIGN_IN_FAILED");
      if (this.current.state !== "cancelled")
        this.#setStatus({ state: "error", message: error.message });
      await this.#stopChild();
      throw error;
    }
  }

  async status() {
    if (
      [
        "starting",
        "awaiting_browser",
        "verifying",
        "completed",
        "cancelled",
        "expired",
        "error",
      ].includes(this.current.state)
    )
      return { ...this.current, ...this.persistMetadata };

    if (this.statusOperation) return this.statusOperation;
    const operation = this.#readStatus();
    this.statusOperation = operation;
    try {
      return await operation;
    } finally {
      if (this.statusOperation === operation) this.statusOperation = null;
    }
  }

  async #readStatus() {
    let startedForStatus = false;
    try {
      if (!this.child) {
        startedForStatus = true;
        await this.#ensureChild();
      }
      const result = await this.#request("status", {}, this.requestTimeoutMs);
      const auth = result?.auth;
      if (
        !auth ||
        typeof auth.canUseActiveProvider !== "boolean" ||
        typeof auth.kind !== "string"
      )
        throw new BrowserAuthError("AUTH_RESPONSE_INVALID");
      return {
        state: auth.canUseActiveProvider ? "authenticated" : "signed_out",
        authKind: auth.kind,
        signOutAvailable: Boolean(auth.signOutAvailable),
      };
    } catch (error) {
      if (error instanceof BrowserAuthError) throw error;
      throw new BrowserAuthError("AUTH_STATUS_FAILED");
    } finally {
      if (startedForStatus) await this.#stopChild();
    }
  }

  async complete(attemptId) {
    if (
      this.current.state === "expired" ||
      (this.expiresAtMs !== null && this.now() >= this.expiresAtMs)
    ) {
      this.#setStatus({
        state: "expired",
        attemptId: this.attemptId,
        message: SAFE_MESSAGES.AUTH_ATTEMPT_EXPIRED,
      });
      await this.#stopChild();
      throw new BrowserAuthError("AUTH_ATTEMPT_EXPIRED");
    }
    if (
      this.current.state !== "awaiting_browser" ||
      !safeAttemptId(attemptId) ||
      attemptId !== this.attemptId
    )
      throw new BrowserAuthError("AUTH_ATTEMPT_MISMATCH");

    this.#setStatus({
      state: "verifying",
      attemptId: this.attemptId,
      expiresAt: this.current.expiresAt,
    });
    const remainingMs = Math.max(1, this.expiresAtMs - this.now() + 10_000);
    try {
      const result = await this.#request(
        "complete",
        { attemptId },
        remainingMs,
      );
      if (result?.status !== "completed" || result.attemptId !== attemptId)
        throw new BrowserAuthError("AUTH_RESPONSE_INVALID");
      this.persistMetadata = safePersistMetadata(result);
      this.#setStatus({
        state: "completed",
        attemptId,
        ...this.persistMetadata,
      });
      await this.#stopChild();
      return { ...this.current };
    } catch (error) {
      if (this.current.state !== "cancelled") {
        const safeError =
          error instanceof BrowserAuthError
            ? error
            : new BrowserAuthError("BROWSER_SIGN_IN_FAILED");
        this.#setStatus({
          state: "error",
          attemptId,
          message: safeError.message,
        });
      }
      await this.#stopChild();
      throw error instanceof BrowserAuthError
        ? error
        : new BrowserAuthError("BROWSER_SIGN_IN_FAILED");
    }
  }

  async cancel(attemptId) {
    if (attemptId !== undefined && attemptId !== this.attemptId)
      throw new BrowserAuthError("AUTH_ATTEMPT_MISMATCH");
    if (
      ["completed", "cancelled", "expired", "error", "idle"].includes(
        this.current.state,
      )
    )
      return { ...this.current };
    const cancelledAttemptId = this.attemptId ?? undefined;
    this.#setStatus({
      state: "cancelled",
      ...(cancelledAttemptId ? { attemptId: cancelledAttemptId } : {}),
    });
    const cancellation = new BrowserAuthError("AUTH_CANCELLED");
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(cancellation);
    }
    this.pendingRequests.clear();
    await this.#stopChild();
    return { ...this.current };
  }

  async shutdown() {
    if (
      ["starting", "awaiting_browser", "verifying"].includes(this.current.state)
    )
      await this.cancel(this.attemptId ?? undefined);
    else await this.#stopChild();
  }

  #setStatus(status) {
    this.current = { ...status };
    this.emit("status", { ...this.current });
  }

  #launchSpec() {
    const appPath = this.app.getAppPath();
    if (this.app.isPackaged) {
      const command = resolveServerExecutable({
        env: this.env,
        platform: this.platform,
        appPath,
        resourcesPath: this.resourcesPath,
        exists: this.exists,
      });
      return { command, args: ["--desktop-auth"] };
    }

    const python = path.join(
      appPath,
      ".runtime",
      "venv",
      this.platform === "win32" ? "Scripts" : "bin",
      this.platform === "win32" ? "python.exe" : "python",
    );
    const script = path.join(appPath, "scripts", "auth-sidecar.py");
    return { command: python, args: [script] };
  }

  async #ensureChild() {
    if (this.child) return;
    const { command, args } = this.#launchSpec();
    const cwd = this.app.getPath("userData");
    const env = processEnvironment(this.env, this.platform);
    if (!this.app.isPackaged) {
      env.PYTHONUTF8 = "1";
      env.PYTHONIOENCODING = "utf-8";
    }
    let child;
    try {
      child = this.spawnProcess(command, args, {
        cwd,
        env,
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      throw new BrowserAuthError("AUTH_PROCESS_MISSING");
    }
    if (!child?.stdin || !child?.stdout || !child?.stderr) {
      try {
        child?.kill?.();
      } catch {}
      throw new BrowserAuthError("AUTH_PROCESS_MISSING");
    }
    this.child = child;
    this.closingChild = false;
    child.stderr.on("data", () => {}); // Never forward helper output; it can contain local config detail.
    child.stdout.on("data", (chunk) => this.#readOutput(chunk));
    child.once("error", () => this.#handleChildFailure());
    child.once("close", () => this.#handleChildFailure());
    child.stdin.on("error", () => this.#handleChildFailure());
  }

  #readOutput(chunk) {
    this.outputBuffer += chunk.toString("utf8");
    if (
      this.outputBuffer.length > MAX_RESPONSE_LINE &&
      !this.outputBuffer.includes("\n")
    ) {
      this.#failPending(new BrowserAuthError("AUTH_RESPONSE_INVALID"));
      this.#stopChild();
      return;
    }
    let newline;
    while ((newline = this.outputBuffer.indexOf("\n")) >= 0) {
      const line = this.outputBuffer.slice(0, newline);
      this.outputBuffer = this.outputBuffer.slice(newline + 1);
      if (!line || line.length > MAX_RESPONSE_LINE) {
        this.#failPending(new BrowserAuthError("AUTH_RESPONSE_INVALID"));
        this.#stopChild();
        return;
      }
      this.#acceptResponse(line);
    }
  }

  #acceptResponse(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      this.#failPending(new BrowserAuthError("AUTH_RESPONSE_INVALID"));
      this.#stopChild();
      return;
    }
    const pending = this.pendingRequests.get(response?.id);
    if (!pending) return;
    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) {
      pending.reject(
        new BrowserAuthError(
          response.error.code === "AUTH_STATUS_FAILED"
            ? "AUTH_STATUS_FAILED"
            : "BROWSER_SIGN_IN_FAILED",
        ),
      );
      return;
    }
    if (!response.result || typeof response.result !== "object") {
      pending.reject(new BrowserAuthError("AUTH_RESPONSE_INVALID"));
      return;
    }
    pending.resolve(response.result);
  }

  #request(action, params, timeoutMs) {
    if (!this.child)
      return Promise.reject(new BrowserAuthError("AUTH_PROCESS_MISSING"));
    const id = `desktop-auth-${++this.nextRequestId}`;
    const payload = JSON.stringify({ id, action, ...params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pendingRequests.delete(id);
          reject(new BrowserAuthError("AUTH_TIMEOUT"));
          this.#stopChild();
        },
        Math.max(1, timeoutMs),
      );
      timer.unref?.();
      this.pendingRequests.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${payload}\n`, "utf8", (error) => {
          if (error) {
            this.pendingRequests.delete(id);
            clearTimeout(timer);
            reject(new BrowserAuthError("AUTH_PROCESS_FAILED"));
          }
        });
      } catch {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(new BrowserAuthError("AUTH_PROCESS_FAILED"));
      }
    });
  }

  #failPending(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  #handleChildFailure() {
    if (this.closingChild) return;
    const needsFailureStatus =
      this.pendingRequests.size > 0 ||
      ["starting", "awaiting_browser", "verifying"].includes(
        this.current.state,
      );
    this.#failPending(new BrowserAuthError("AUTH_PROCESS_FAILED"));
    this.child = null;
    this.outputBuffer = "";
    if (
      needsFailureStatus &&
      !["cancelled", "completed", "expired"].includes(this.current.state)
    )
      this.#setStatus({
        state: "error",
        message: SAFE_MESSAGES.AUTH_PROCESS_FAILED,
      });
  }

  async #stopChild() {
    const child = this.child;
    if (!child) return;
    this.closingChild = true;
    this.child = null;
    this.outputBuffer = "";
    this.#failPending(new BrowserAuthError("AUTH_PROCESS_FAILED"));
    try {
      child.stdin.end();
    } catch {}
    try {
      child.kill();
    } catch {}
    await waitForClose(child);
    this.closingChild = false;
  }
}
