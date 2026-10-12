import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { JsonRpcClient } from "./rpc-client.js";

const MAX_RPC_BYTES = 16 * 1024 * 1024;
const MAX_PREFS_BYTES = 64 * 1024;
const MAX_RECENT_PROJECTS = 20;
const THEMES = new Set(["light", "dark", "system"]);
const CALLBACK_KINDS = ["approval", "user_input"];

const PARAM_KEYS = Object.freeze({
  "setup/status": ["provider"],
  "setup/store-credential": ["provider", "apiKey", "customDomain"],
  "session/list": [
    "cursor",
    "limit",
    "rootSessionId",
    "parentSessionId",
    "cwd",
    "cwds",
    "pinned",
    "includeArchived",
  ],
  "session/start": ["agentConfig", "historyLimit", "idempotencyKey", "kind"],
  "session/resume": ["sessionId", "agentConfig", "historyLimit"],
  "session/read": ["sessionId", "history", "turns"],
  "session/stop": ["sessionId", "reason"],
  "session/title/update": ["sessionId", "title"],
  "session/pin": ["sessionId", "pinned"],
  "session/archive": ["sessionId", "archived"],
  "turn/start": [
    "idempotencyKey",
    "sessionId",
    "message",
    "injected",
    "clientUserMessageId",
    "autoTitle",
    "userDisplayContent",
    "mentionStats",
  ],
  "turn/interrupt": ["sessionId", "expectedTurnId"],
  "turn/steer": [
    "idempotencyKey",
    "sessionId",
    "expectedTurnId",
    "message",
    "clientUserMessageId",
    "userDisplayContent",
    "injectInvokedSkill",
    "mentionStats",
  ],
  "callback/result": ["sessionId", "result"],
  "runtime/read": ["sessionId"],
  "agents/list": ["sessionId"],
  "session/agent/update": ["sessionId", "agentName"],
  "config/model/write": ["sessionId", "modelAlias", "reasoningEffort"],
  "stats/read": ["sessionId"],
  "review/state": ["sessionId"],
  "review/baseline": ["sessionId", "path"],
  "review/turnDiff": ["sessionId", "path", "owner"],
  "review/hunks": ["sessionId", "path", "owner"],
  "review/approve": ["sessionId", "target"],
  "workspace/trust/status": ["cwd"],
  "workspace/trust/decision": ["decision", "cwd", "sessionId"],
  "workspace/git/worktrees/list": ["cwd", "includeDetails"],
  "session/shellCommand": [
    "sessionId",
    "command",
    "cwd",
    "timeoutSeconds",
    "operationId",
    "action",
  ],
  "session/history/list": ["sessionId", "turnId", "page"],
  "mcp/read": ["sessionId"],
  "skills/list": ["sessionId"],
  "plugins/read": ["sessionId"],
  "diagnostics/list": ["sessionId"],
});

const REQUIRED_KEYS = Object.freeze({
  "setup/store-credential": ["provider", "apiKey"],
  "session/start": ["agentConfig"],
  "session/resume": ["sessionId"],
  "session/read": ["sessionId"],
  "session/stop": ["sessionId"],
  "session/title/update": ["sessionId", "title"],
  "session/pin": ["sessionId", "pinned"],
  "session/archive": ["sessionId", "archived"],
  "turn/start": ["sessionId", "message"],
  "turn/interrupt": ["sessionId", "expectedTurnId"],
  "turn/steer": ["sessionId", "expectedTurnId", "message"],
  "callback/result": ["sessionId", "result"],
  "runtime/read": ["sessionId"],
  "session/agent/update": ["sessionId", "agentName"],
  "config/model/write": ["sessionId"],
  "stats/read": ["sessionId"],
  "review/state": ["sessionId"],
  "review/baseline": ["sessionId", "path"],
  "review/turnDiff": ["sessionId", "path", "owner"],
  "review/hunks": ["sessionId", "path"],
  "review/approve": ["sessionId", "target"],
  "workspace/trust/decision": ["decision", "sessionId"],
  "workspace/git/worktrees/list": ["cwd"],
  "session/history/list": ["sessionId"],
  "mcp/read": ["sessionId"],
  "skills/list": ["sessionId"],
  "plugins/read": ["sessionId"],
  "diagnostics/list": ["sessionId"],
});

const ACTIVE_SESSION_METHODS = new Set([
  "session/stop",
  "session/title/update",
  "session/pin",
  "session/archive",
  "turn/start",
  "turn/interrupt",
  "turn/steer",
  "callback/result",
  "runtime/read",
  "agents/list",
  "session/agent/update",
  "config/model/write",
  "stats/read",
  "review/state",
  "review/baseline",
  "review/turnDiff",
  "review/hunks",
  "review/approve",
  "workspace/trust/decision",
  "session/shellCommand",
  "mcp/read",
  "skills/list",
  "plugins/read",
  "diagnostics/list",
]);

const SESSION_READ_METHODS = new Set(["session/read", "session/history/list"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) throw new TypeError(`${label} must be an object`);
}

function assertOnlyKeys(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key))
      throw new TypeError(`${label} contains unsupported field: ${key}`);
  }
}

function requireString(value, label, { min = 1, max = 4096 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new TypeError(
      `${label} must be a string between ${min} and ${max} characters`,
    );
  }
  return value;
}

function stablePathKey(input) {
  const normalized = path.normalize(input).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function serverProcessEnvironment(env, platform) {
  const childEnv = { ...env };
  if (platform === "win32") {
    // Keep GitPython's temporary patch from removing a key while Vibe copies
    // os.environ, and exclude the current directory from executable lookup.
    const noCwdSearch = "NODEFAULTCURRENTDIRECTORYINEXEPATH";
    // GitPython patches this key in os.environ while Vibe copies the mapping
    // to launch a shell; keeping it present avoids the concurrent delete race.
    for (const key of Object.keys(childEnv)) {
      if (key.toUpperCase() === noCwdSearch) delete childEnv[key];
    }
    childEnv[noCwdSearch] = "1";
  }
  return childEnv;
}

function getField(object, ...names) {
  for (const name of names) {
    if (Object.hasOwn(object ?? {}, name)) return object[name];
  }
  return undefined;
}

export function resolveServerExecutable({
  env = process.env,
  platform = process.platform,
  appPath,
  resourcesPath,
  exists = existsSync,
} = {}) {
  const executable =
    platform === "win32" ? "vibe-app-server.exe" : "vibe-app-server";
  const candidates = [];
  if (env.VIBE_APP_SERVER) candidates.push(env.VIBE_APP_SERVER);
  if (resourcesPath)
    candidates.push(
      path.join(resourcesPath, "backend", "vibe-app-server", executable),
    );
  if (appPath) {
    if (platform === "win32")
      candidates.push(
        path.join(appPath, ".runtime", "venv", "Scripts", executable),
      );
    else
      candidates.push(
        path.join(appPath, ".runtime", "venv", "bin", executable),
      );
  }
  for (const candidate of candidates) {
    if (
      candidate === env.VIBE_APP_SERVER &&
      !path.isAbsolute(candidate) &&
      !candidate.includes(path.sep)
    ) {
      return candidate;
    }
    if (exists(candidate)) return candidate;
  }
  return executable;
}

export class VibeBackend extends EventEmitter {
  constructor({
    app,
    dialog,
    getWindow = () => null,
    spawnProcess = spawn,
    platform = process.platform,
    env = process.env,
    existsSync: fileExists = existsSync,
    realpath = fs.realpath,
    stat = fs.stat,
    readFile = fs.readFile,
    writeFile = fs.writeFile,
    rename = fs.rename,
    mkdir = fs.mkdir,
    unlink = fs.unlink,
    now = Date.now,
  }) {
    super();
    this.app = app;
    this.dialog = dialog;
    this.getWindow = getWindow;
    this.spawnProcess = spawnProcess;
    this.platform = platform;
    this.env = env;
    this.existsSync = fileExists;
    this.fs = { realpath, stat, readFile, writeFile, rename, mkdir, unlink };
    this.now = now;
    this.rpc = null;
    this.connectPromise = null;
    this.child = null;
    this.serverInfo = null;
    this.setup = null;
    this.activeSessionId = null;
    this.activeProjectRoot = null;
    this.activeTurnId = null;
    this.knownSessions = new Map();
    this.pendingCallbacks = new Map();
    this.authorizedProjects = new Map();
    this.preferences = { theme: "system", recentProjects: [] };
    this.preferencesLoaded = false;
    this.preferencesPromise = null;
    this.state = "disconnected";
  }

  get status() {
    return { state: this.state };
  }

  async connect() {
    if (this.rpc && !this.rpc.closed) {
      if (this.serverInfo && this.setup)
        return { serverInfo: this.serverInfo, setup: this.setup };
    }
    if (this.connectPromise) return this.connectPromise;
    const connection = this.#connectOnce();
    this.connectPromise = connection;
    try {
      return await connection;
    } finally {
      if (this.connectPromise === connection) this.connectPromise = null;
    }
  }

  async #connectOnce() {
    this.#setStatus("connecting");
    try {
      if (!this.rpc || this.rpc.closed) await this.#launch();
      const rpc = this.rpc;
      const initialization = await rpc.request("initialize", {
        clientInfo: {
          name: "vibe-desktop",
          version: this.app.getVersion(),
          entrypoint: "desktop",
        },
        capabilities: {
          callbackKinds: CALLBACK_KINDS,
          clientTools: [],
          disabledNotifications: [],
        },
      });
      this.serverInfo = initialization?.serverInfo;
      await rpc.notify("initialized", {});
      this.setup = await rpc.request("setup/status", {});
      this.#setStatus("ready");
      return { serverInfo: this.serverInfo, setup: this.setup };
    } catch (error) {
      await this.#disposeProcess({ killTree: true });
      this.serverInfo = null;
      this.setup = null;
      this.#setStatus("error", safeMessage(error));
      throw error;
    }
  }

  async request(method, rawParams = {}) {
    if (!Object.hasOwn(PARAM_KEYS, method))
      throw new TypeError("Unsupported Vibe method");
    const params = this.#validateParams(method, rawParams);

    if (method === "session/start") {
      await this.#switchSessionIfNeeded();
    } else if (method === "session/resume") {
      this.#authorizeResume(params);
      await this.#switchSessionIfNeeded(params.sessionId);
    }

    this.#authorizeSessionMethod(method, params);
    await this.connect();
    const result = await this.rpc.request(method, params);
    if (method === "callback/result")
      this.pendingCallbacks.delete(params.result.callbackId);
    this.#recordResult(method, params, result);
    if (method === "session/stop") {
      await this.#disposeProcess({ killTree: true });
      this.activeSessionId = null;
      this.activeProjectRoot = null;
      this.activeTurnId = null;
      this.#setStatus("disconnected");
    }
    return result;
  }

  async chooseProject() {
    await this.#loadPreferences();
    const window = this.getWindow();
    const options = { properties: ["openDirectory"] };
    const result = window
      ? await this.dialog.showOpenDialog(window, options)
      : await this.dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths?.[0]) return null;
    const projectPath = await this.#canonicalDirectory(result.filePaths[0]);
    this.#addAuthorizedProject(projectPath);
    return projectPath;
  }

  async readPreferences() {
    await this.#loadPreferences();
    return structuredClone(this.preferences);
  }

  async savePreferences(input) {
    await this.#loadPreferences();
    requireObject(input, "preferences");
    assertOnlyKeys(input, ["theme", "recentProjects"], "preferences");
    if (!THEMES.has(input.theme)) throw new TypeError("Unsupported theme");
    if (
      !Array.isArray(input.recentProjects) ||
      input.recentProjects.length > MAX_RECENT_PROJECTS
    ) {
      throw new TypeError(
        "recentProjects must be an array of at most 20 project paths",
      );
    }
    const recentProjects = [];
    const seen = new Set();
    for (const rawPath of input.recentProjects) {
      const candidate = await this.#canonicalDirectory(rawPath);
      const key = stablePathKey(candidate);
      if (!this.authorizedProjects.has(key))
        throw new Error("Choose a project folder before saving it");
      if (!seen.has(key)) {
        seen.add(key);
        recentProjects.push(candidate);
      }
    }
    const next = { theme: input.theme, recentProjects };
    await this.fs.mkdir(this.app.getPath("userData"), { recursive: true });
    const prefsPath = this.#preferencesPath();
    const tempPath = `${prefsPath}.${this.now()}.tmp`;
    await this.fs.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await this.fs.rename(tempPath, prefsPath);
    this.preferences = next;
    return structuredClone(next);
  }

  async openExternal(rawUrl, shell) {
    const url = requireString(rawUrl, "url", { max: 2048 });
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new TypeError("Invalid external URL");
    }
    const repositoryUrl =
      "https://github.com/maikolsiragusaa/mistral-vibe-desktop";
    const isProjectRepository = parsed.toString() === repositoryUrl;
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      (!isOfficialMistralHost(parsed.hostname) && !isProjectRepository) ||
      (parsed.port && parsed.port !== "443")
    ) {
      throw new TypeError("Only official Mistral HTTPS links can be opened");
    }
    await shell.openExternal(parsed.toString());
  }

  async shutdown() {
    if (this.rpc && this.activeSessionId) {
      try {
        await this.rpc.request(
          "session/stop",
          { sessionId: this.activeSessionId },
          { timeoutMs: 2500 },
        );
      } catch {
        // App shutdown must continue even if the server is already exiting.
      }
    }
    await this.#disposeProcess({ killTree: true });
    this.activeSessionId = null;
    this.activeProjectRoot = null;
    this.#setStatus("disconnected");
  }

  #setStatus(state, message) {
    this.state = state;
    this.emit("status", message ? { state, message } : { state });
  }

  async #launch() {
    const userData = this.app.getPath("userData");
    await this.fs.mkdir(userData, { recursive: true });
    const command = resolveServerExecutable({
      env: this.env,
      platform: this.platform,
      appPath: this.app.getAppPath(),
      resourcesPath: process.resourcesPath,
      exists: (candidate) => this.existsSync(candidate),
    });
    const child = this.spawnProcess(command, [], {
      cwd: userData,
      env: serverProcessEnvironment(this.env, this.platform),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const rpc = new JsonRpcClient(child, { maxFrameBytes: MAX_RPC_BYTES });
    this.rpc = rpc;
    rpc.on("event", (event) => {
      this.#trackEvent(event);
      this.emit("event", event);
    });
    rpc.on("transportError", (error) => {
      if (this.rpc !== rpc) return;
      this.activeSessionId = null;
      this.activeProjectRoot = null;
      this.activeTurnId = null;
      this.pendingCallbacks.clear();
      this.#setStatus("error", safeMessage(error));
    });
    rpc.on("exit", () => {
      if (this.rpc !== rpc) return;
      this.rpc = null;
      this.child = null;
      this.activeSessionId = null;
      this.activeProjectRoot = null;
      this.activeTurnId = null;
      this.pendingCallbacks.clear();
      this.#setStatus("disconnected");
    });
  }

  async #switchSessionIfNeeded(requestedSessionId = null) {
    if (!this.activeSessionId || this.activeSessionId === requestedSessionId)
      return;
    if (this.activeTurnId)
      throw new Error(
        "Interrupt or wait for the active turn before switching sessions",
      );
    await this.#stopAndRestart();
  }

  async #stopAndRestart() {
    const rpc = this.rpc;
    const activeSessionId = this.activeSessionId;
    if (rpc && activeSessionId) {
      try {
        await rpc.request(
          "session/stop",
          { sessionId: activeSessionId },
          { timeoutMs: 3000 },
        );
      } catch {}
    }
    await this.#disposeProcess({ killTree: true });
    this.activeSessionId = null;
    this.activeProjectRoot = null;
    this.activeTurnId = null;
    this.#setStatus("disconnected");
  }

  async #disposeProcess({ killTree }) {
    const rpc = this.rpc;
    const child = this.child;
    this.rpc = null;
    this.child = null;
    this.pendingCallbacks.clear();
    rpc?.close();
    if (!child || child.exitCode !== null) return;
    try {
      child.stdin.end();
    } catch {}
    const exited = await waitForExit(child, 1800);
    if (!exited) {
      if (
        killTree &&
        this.platform === "win32" &&
        Number.isInteger(child.pid)
      ) {
        await runTaskkill(child.pid, this.spawnProcess);
      }
      if (child.exitCode === null) {
        try {
          child.kill();
        } catch {}
      }
      await waitForExit(child, 1000);
    }
  }

  #validateParams(method, input) {
    requireObject(input, "params");
    assertOnlyKeys(input, PARAM_KEYS[method], `${method} params`);
    for (const key of REQUIRED_KEYS[method] ?? []) {
      if (!Object.hasOwn(input, key))
        throw new TypeError(`${method} requires ${key}`);
    }
    const encoded = JSON.stringify(input);
    if (Buffer.byteLength(encoded, "utf8") > MAX_RPC_BYTES)
      throw new TypeError("Request is too large");

    if (input.sessionId !== undefined)
      requireString(input.sessionId, "sessionId", { max: 256 });
    if (method === "setup/status" && input.provider !== undefined)
      requireString(input.provider, "provider", { max: 128 });
    if (method === "setup/store-credential") {
      requireString(input.provider, "provider", { max: 128 });
      requireString(input.apiKey, "apiKey", { max: 10000 });
      if (
        input.customDomain !== undefined &&
        typeof input.customDomain !== "boolean"
      )
        throw new TypeError("customDomain must be a boolean");
    }
    if (method === "session/list") this.#validateSessionListParams(input);
    if (method === "session/start") this.#validateSessionStart(input);
    if (method === "session/resume")
      this.#validateResumeAgentConfig(input.agentConfig);
    if (method === "session/title/update")
      requireString(input.title, "title", { max: 500 });
    if (method === "session/pin" && typeof input.pinned !== "boolean")
      throw new TypeError("pinned must be a boolean");
    if (method === "session/archive" && typeof input.archived !== "boolean")
      throw new TypeError("archived must be a boolean");
    if (method === "turn/start" || method === "turn/steer") {
      validateTextMessage(input.message);
    }
    if (method === "callback/result") validateCallbackResult(input.result);
    if (method === "session/agent/update")
      requireString(input.agentName, "agentName", { max: 128 });
    if (method === "config/model/write") {
      if (input.modelAlias !== undefined && input.modelAlias !== null)
        requireString(input.modelAlias, "modelAlias", { max: 256 });
      if (input.reasoningEffort !== undefined && input.reasoningEffort !== null)
        requireString(input.reasoningEffort, "reasoningEffort", { max: 64 });
    }
    if (
      method === "review/baseline" ||
      method === "review/turnDiff" ||
      method === "review/hunks"
    )
      requireString(input.path, "path", { max: 4096 });
    if (
      method === "review/turnDiff" ||
      (method === "review/hunks" && input.owner !== undefined)
    )
      validateReviewOwner(input.owner);
    if (
      method === "workspace/trust/status" ||
      method === "workspace/trust/decision"
    )
      this.#validateProjectPath(input.cwd, {
        required: method === "workspace/trust/status",
      });
    if (
      method === "workspace/trust/decision" &&
      !["trust_repo", "trust_cwd", "decline"].includes(input.decision)
    ) {
      throw new TypeError("Unsupported workspace trust decision");
    }
    if (method === "workspace/git/worktrees/list")
      this.#validateProjectPath(input.cwd, { required: true });
    if (method === "session/shellCommand") this.#validateShellRequest(input);
    if (method === "session/history/list") {
      if (input.page !== undefined) {
        requireObject(input.page, "page");
        assertOnlyKeys(input.page, ["cursor", "limit", "direction"], "page");
      }
    }

    return structuredClone(input);
  }

  #validateSessionListParams(params) {
    if (params.cwd !== undefined && params.cwds !== undefined)
      throw new TypeError("Use cwd or cwds, not both");
    if (params.cwd !== undefined)
      this.#validateProjectPath(params.cwd, { required: true, exact: true });
    if (params.cwds !== undefined) {
      if (
        !Array.isArray(params.cwds) ||
        params.cwds.length > MAX_RECENT_PROJECTS
      )
        throw new TypeError("cwds must contain at most 20 paths");
      for (const cwd of params.cwds)
        this.#validateProjectPath(cwd, { required: true, exact: true });
    }
    if (
      params.limit !== undefined &&
      (!Number.isInteger(params.limit) ||
        params.limit < 1 ||
        params.limit > 500)
    )
      throw new TypeError("limit must be between 1 and 500");
  }

  #validateSessionStart(params) {
    requireObject(params.agentConfig, "agentConfig");
    assertOnlyKeys(params.agentConfig, ["cwd", "agent"], "agentConfig");
    this.#validateProjectPath(params.agentConfig.cwd, {
      required: true,
      exact: true,
    });
    if (params.agentConfig.agent !== undefined)
      requireString(params.agentConfig.agent, "agent", { max: 128 });
    if (params.kind !== undefined && params.kind !== "normal")
      throw new TypeError("Only normal user sessions are supported");
  }

  #validateResumeAgentConfig(agentConfig) {
    if (agentConfig === undefined) return;
    requireObject(agentConfig, "agentConfig");
    assertOnlyKeys(agentConfig, ["cwd", "agent"], "agentConfig");
    if (agentConfig.cwd !== undefined)
      this.#validateProjectPath(agentConfig.cwd, {
        required: true,
        exact: true,
      });
    if (agentConfig.agent !== undefined)
      requireString(agentConfig.agent, "agent", { max: 128 });
  }

  #validateShellRequest(params) {
    if (
      params.action !== undefined &&
      !["run", "interrupt"].includes(params.action)
    )
      throw new TypeError("Invalid shell action");
    if ((params.action ?? "run") === "run")
      requireString(params.command, "command", { max: 32768 });
    if ((params.action ?? "run") === "interrupt")
      requireString(params.operationId, "operationId", { max: 256 });
    if (params.cwd !== undefined)
      this.#validateProjectPath(params.cwd, {
        required: true,
        allowSubdirectory: true,
      });
    if (
      params.timeoutSeconds !== undefined &&
      (typeof params.timeoutSeconds !== "number" ||
        params.timeoutSeconds <= 0 ||
        params.timeoutSeconds > 600)
    )
      throw new TypeError("timeoutSeconds must be between 0 and 600");
  }

  #authorizeSessionMethod(method, params) {
    const sessionId = params.sessionId;
    if (!sessionId) return;
    if (SESSION_READ_METHODS.has(method)) {
      if (!this.knownSessions.has(sessionId))
        throw new Error(
          "Read the project session list before opening this session",
        );
      return;
    }
    if (method === "session/stop" && this.activeTurnId) {
      throw new Error(
        "Interrupt or wait for the active turn before stopping the session",
      );
    }
    if (method === "callback/result") {
      const pending = this.pendingCallbacks.get(params.result.callbackId);
      if (!pending || pending.sessionId !== sessionId)
        throw new Error("This callback is no longer pending");
      validateCallbackAgainstPending(params.result, pending);
      return;
    }
    if (
      ACTIVE_SESSION_METHODS.has(method) &&
      sessionId !== this.activeSessionId
    ) {
      throw new Error("This request does not target the active Vibe session");
    }
  }

  #authorizeResume(params) {
    const entry = this.knownSessions.get(params.sessionId);
    if (
      !entry ||
      !entry.allowedRoots.some((root) =>
        this.authorizedProjects.has(stablePathKey(root)),
      )
    ) {
      throw new Error("List sessions for a chosen project before resuming one");
    }
    const requestedCwd = params.agentConfig?.cwd;
    if (requestedCwd !== undefined) {
      const allowed = this.#canonicalProjectSyncLookup(requestedCwd);
      if (
        !allowed ||
        !entry.allowedRoots.some(
          (root) => stablePathKey(root) === stablePathKey(allowed),
        )
      ) {
        throw new Error("Resume workspace must belong to the selected project");
      }
    }
  }

  #recordResult(method, params, result) {
    const state = result?.state;
    if (method === "session/list") {
      const roots = params.cwd
        ? [this.#canonicalProjectSyncLookup(params.cwd)].filter(Boolean)
        : (params.cwds
            ?.map((cwd) => this.#canonicalProjectSyncLookup(cwd))
            .filter(Boolean) ?? [...this.authorizedProjects.values()]);
      for (const session of result.items ?? [])
        this.#rememberSession(session, roots);
    } else if (method === "session/start" || method === "session/resume") {
      const session = state?.session;
      if (session?.id) {
        const requestedCwd = params.agentConfig?.cwd;
        const entry = this.knownSessions.get(session.id);
        const roots = requestedCwd
          ? [this.#canonicalProjectSyncLookup(requestedCwd)].filter(Boolean)
          : (entry?.allowedRoots ?? []);
        this.#rememberSession(session, roots);
        this.activeSessionId = session.id;
        this.activeProjectRoot = roots[0] ?? null;
      }
    } else if (method === "session/read" && state?.session?.id) {
      const previous = this.knownSessions.get(state.session.id);
      this.#rememberSession(state.session, previous?.allowedRoots ?? []);
    } else if (
      method === "turn/start" &&
      result?.turn?.status === "in_progress" &&
      typeof result.turn.id === "string"
    ) {
      this.activeTurnId = result.turn.id;
    } else if (method === "turn/interrupt") {
      // Keep the turn active until the canonical turn/completed event arrives.
    } else if (method === "session/stop") {
      this.activeTurnId = null;
    }
  }

  #trackEvent(event) {
    const params = event?.params;
    if (!isObject(params)) return;
    if (event.method === "callback/call") {
      const callback = params.callback;
      const callbackId = callback?.callbackId;
      const sessionId = params.sessionId ?? callback?.sessionId;
      const kind = callback?.detail?.kind;
      if (
        typeof callbackId === "string" &&
        typeof sessionId === "string" &&
        CALLBACK_KINDS.includes(kind)
      ) {
        this.pendingCallbacks.set(callbackId, {
          sessionId,
          kind,
          choices: callback.detail.choices,
          pathScopes: callback.detail.pathScopeChoices,
          questions: callback.detail.request?.questions,
        });
        if (this.pendingCallbacks.size > 500)
          this.pendingCallbacks.delete(
            this.pendingCallbacks.keys().next().value,
          );
      }
      return;
    }
    const turn = params.turn;
    if (
      event.method === "turn/started" &&
      typeof turn?.id === "string" &&
      params.sessionId === this.activeSessionId
    ) {
      this.activeTurnId = turn.id;
    } else if (
      event.method === "turn/completed" &&
      typeof turn?.id === "string" &&
      turn.id === this.activeTurnId
    ) {
      this.activeTurnId = null;
    }
  }

  #rememberSession(session, allowedRoots) {
    if (!session || typeof session.id !== "string") return;
    this.knownSessions.set(session.id, {
      cwd: typeof session.cwd === "string" ? session.cwd : null,
      allowedRoots: [
        ...new Map(
          allowedRoots.map((root) => [stablePathKey(root), root]),
        ).values(),
      ],
    });
    if (this.knownSessions.size > 5000)
      this.knownSessions.delete(this.knownSessions.keys().next().value);
  }

  #validateProjectPath(
    rawPath,
    { required = false, exact = false, allowSubdirectory = false } = {},
  ) {
    if (rawPath === undefined || rawPath === null) {
      if (required) throw new TypeError("A selected project path is required");
      return;
    }
    const value = requireString(rawPath, "cwd", { max: 4096 });
    if (!path.isAbsolute(value))
      throw new TypeError("Project path must be absolute");
    const canonical = this.#canonicalProjectSyncLookup(value);
    if (!canonical)
      throw new Error("Project path must be an existing selected folder");
    const roots = [...this.authorizedProjects.values()];
    const allowed = roots.some((root) => {
      if (exact) return stablePathKey(root) === stablePathKey(canonical);
      if (allowSubdirectory) return isInside(root, canonical);
      return stablePathKey(root) === stablePathKey(canonical);
    });
    if (!allowed)
      throw new Error("Project path has not been selected in this app");
  }

  #canonicalProjectSyncLookup(rawPath) {
    if (typeof rawPath !== "string" || !path.isAbsolute(rawPath)) return null;
    const normalized = path.resolve(rawPath);
    for (const [key, root] of this.authorizedProjects) {
      if (key === stablePathKey(normalized)) return root;
      if (isInside(root, normalized)) return normalized;
    }
    return null;
  }

  #addAuthorizedProject(projectPath) {
    this.authorizedProjects.set(stablePathKey(projectPath), projectPath);
  }

  async #canonicalDirectory(rawPath) {
    const value = requireString(rawPath, "project path", { max: 4096 });
    if (!path.isAbsolute(value))
      throw new TypeError("Project path must be absolute");
    const canonical = await this.fs.realpath(value);
    const details = await this.fs.stat(canonical);
    if (!details.isDirectory())
      throw new TypeError("Project path must name a directory");
    return canonical;
  }

  async #loadPreferences() {
    if (this.preferencesLoaded) return;
    if (this.preferencesPromise) return this.preferencesPromise;
    this.preferencesPromise = (async () => {
      const filePath = this.#preferencesPath();
      try {
        const details = await this.fs.stat(filePath);
        if (details.size > MAX_PREFS_BYTES)
          throw new Error("Preferences are too large");
        const stored = JSON.parse(await this.fs.readFile(filePath, "utf8"));
        if (!isObject(stored)) throw new Error("Invalid preferences");
        const theme = THEMES.has(stored.theme) ? stored.theme : "system";
        const projects = [];
        const seen = new Set();
        if (Array.isArray(stored.recentProjects)) {
          for (const candidate of stored.recentProjects.slice(
            0,
            MAX_RECENT_PROJECTS,
          )) {
            try {
              const projectPath = await this.#canonicalDirectory(candidate);
              const key = stablePathKey(projectPath);
              if (!seen.has(key)) {
                seen.add(key);
                projects.push(projectPath);
                this.#addAuthorizedProject(projectPath);
              }
            } catch {
              // Stale or moved directories are omitted from the recent list.
            }
          }
        }
        this.preferences = { theme, recentProjects: projects };
      } catch {
        this.preferences = { theme: "system", recentProjects: [] };
      }
      this.preferencesLoaded = true;
    })();
    try {
      await this.preferencesPromise;
    } finally {
      this.preferencesPromise = null;
    }
  }

  #preferencesPath() {
    return path.join(this.app.getPath("userData"), "preferences.json");
  }
}

function validateCallbackResult(value) {
  requireObject(value, "result");
  assertOnlyKeys(value, ["callbackId", "output", "error"], "callback result");
  requireString(value.callbackId, "callbackId", { max: 256 });
  if (Object.hasOwn(value, "error") === Object.hasOwn(value, "output")) {
    throw new TypeError(
      "Callback result must contain exactly one of output or error",
    );
  }
  if (value.error !== undefined) {
    requireObject(value.error, "callback error");
    assertOnlyKeys(
      value.error,
      ["message", "code", "details"],
      "callback error",
    );
    requireString(value.error.message, "error message", { max: 2000 });
    if (value.error.code !== undefined && value.error.code !== null)
      requireString(value.error.code, "error code", { max: 128 });
  } else {
    requireObject(value.output, "callback output");
    assertOnlyKeys(
      value.output,
      ["type", "decision", "feedback", "result"],
      "callback output",
    );
    if (value.output.type === "approval") {
      assertOnlyKeys(
        value.output,
        ["type", "decision", "feedback"],
        "approval callback output",
      );
      requireObject(value.output.decision, "approval decision");
      assertOnlyKeys(
        value.output.decision,
        ["type", "pathScope"],
        "approval decision",
      );
      if (
        ![
          "approve",
          "approve_for_session",
          "approve_permanently",
          "deny",
          "cancel_turn",
        ].includes(value.output.decision.type)
      ) {
        throw new TypeError("Unsupported approval decision");
      }
      if (
        value.output.decision.pathScope !== undefined &&
        !["exact", "directory_recursive"].includes(
          value.output.decision.pathScope,
        )
      ) {
        throw new TypeError("Unsupported approval path scope");
      }
      if (value.output.feedback !== undefined && value.output.feedback !== null)
        requireString(value.output.feedback, "feedback", { max: 2000 });
    } else if (value.output.type === "user_input") {
      assertOnlyKeys(
        value.output,
        ["type", "result"],
        "user input callback output",
      );
      requireObject(value.output.result, "user input result");
      assertOnlyKeys(
        value.output.result,
        ["answers", "cancelled"],
        "user input result",
      );
      if (
        !Array.isArray(value.output.result.answers) ||
        value.output.result.answers.length > 20
      ) {
        throw new TypeError(
          "User input answers must be an array of at most 20 items",
        );
      }
      for (const answer of value.output.result.answers) {
        requireObject(answer, "user input answer");
        assertOnlyKeys(
          answer,
          ["question", "answer", "isOther"],
          "user input answer",
        );
        requireString(answer.question, "question", { max: 4000 });
        requireString(answer.answer, "answer", { min: 0, max: 4000 });
        if (answer.isOther !== undefined && typeof answer.isOther !== "boolean")
          throw new TypeError("isOther must be a boolean");
      }
      if (
        value.output.result.cancelled !== undefined &&
        typeof value.output.result.cancelled !== "boolean"
      ) {
        throw new TypeError("cancelled must be a boolean");
      }
    } else {
      throw new TypeError("Unsupported callback output type");
    }
  }
}

function validateCallbackAgainstPending(result, pending) {
  if (!result.output) return;
  if (result.output.type !== pending.kind) {
    throw new TypeError(
      `Callback output must match the pending ${pending.kind} request`,
    );
  }
  if (pending.kind === "approval") {
    const decision = result.output.decision.type;
    if (
      Array.isArray(pending.choices) &&
      pending.choices.length &&
      !pending.choices.includes(decision)
    ) {
      throw new TypeError("Approval decision was not offered for this request");
    }
    const scope = result.output.decision.pathScope;
    if (
      scope !== undefined &&
      Array.isArray(pending.pathScopes) &&
      pending.pathScopes.length &&
      !pending.pathScopes.includes(scope)
    ) {
      throw new TypeError(
        "Approval path scope was not offered for this request",
      );
    }
  } else if (Array.isArray(pending.questions)) {
    const expected = new Set(
      pending.questions.map((question) => question.question),
    );
    for (const answer of result.output.result.answers) {
      if (!expected.has(answer.question))
        throw new TypeError("Answer does not match a pending question");
    }
  }
}

function validateTextMessage(message) {
  if (!Array.isArray(message) || message.length === 0 || message.length > 64) {
    throw new TypeError(
      "message must be a non-empty array with at most 64 text blocks",
    );
  }
  for (const block of message) {
    requireObject(block, "message block");
    assertOnlyKeys(block, ["type", "text"], "message block");
    if (block.type !== "text")
      throw new TypeError("Only text message blocks are supported");
    requireString(block.text, "message text", { max: 100_000 });
  }
}

function validateReviewOwner(owner) {
  requireObject(owner, "review owner");
  if (owner.kind === "agent") {
    assertOnlyKeys(owner, ["kind", "turnId"], "agent review owner");
    if (!Number.isInteger(owner.turnId) || owner.turnId < 0)
      throw new TypeError(
        "agent review owner turnId must be a non-negative integer",
      );
  } else if (owner.kind === "manual") {
    assertOnlyKeys(owner, ["kind", "index"], "manual review owner");
    if (!Number.isInteger(owner.index) || owner.index < 0)
      throw new TypeError(
        "manual review owner index must be a non-negative integer",
      );
  } else {
    throw new TypeError("Review owner kind must be agent or manual");
  }
}

function isOfficialMistralHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "mistral.ai" || normalized.endsWith(".mistral.ai");
}

function safeMessage(error) {
  if (error?.code === "ENOENT") return "Vibe app server could not be found";
  if (error?.message === "Vibe app server request timed out")
    return "Vibe app server did not respond in time";
  return error instanceof Error
    ? error.message.slice(0, 240)
    : "Vibe app server error";
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    const onExit = () => finish(true);
    const finish = (didExit) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(didExit);
    };
    child.once("exit", onExit);
  });
}

async function runTaskkill(pid, spawnProcess) {
  await new Promise((resolve) => {
    let process;
    try {
      process = spawnProcess(
        "taskkill.exe",
        ["/pid", String(pid), "/t", "/f"],
        {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        },
      );
    } catch {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        process.kill();
      } catch {}
      resolve();
    }, 1000);
    timer.unref?.();
    process.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    process.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
