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
const MAX_CONFIG_OPS = 100;
const MAX_CONFIG_ITEMS = 128;
const MAX_CONFIG_DEPTH = 8;
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_RESOURCE_BYTES = 8 * 1024 * 1024;
const SAFE_PROVIDER_FIELDS = new Set([
  "name",
  "api_base",
  "api_key_env_var",
  "api_style",
  "backend",
  "reasoning_field_name",
  "emits_finish_reason",
  "project_id",
  "region",
]);
const SAFE_MODEL_FIELDS = new Set([
  "name",
  "provider",
  "alias",
  "display_name",
  "temperature",
  "top_p",
  "max_output_tokens",
  "input_price",
  "output_price",
  "cached_input_price",
  "thinking",
  "thinking_levels",
  "supports_images",
  "max_context_length",
  "auto_compact_threshold",
]);
const SAFE_MCP_FIELDS = new Set([
  "name",
  "transport",
  "url",
  "prompt",
  "startup_timeout_sec",
  "tool_timeout_sec",
  "sampling_enabled",
  "disabled",
  "disabled_tools",
]);

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
  "session/lease/subscribe": [],
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
  "account/read": ["sessionId"],
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
  "session/turn/enqueue": ["sessionId", "idempotencyKey", "entries"],
  "session/turn/queue/read": ["sessionId"],
  "session/turn/queue/remove": ["sessionId", "queueItemId"],
  "session/turn/queue/replace": [
    "sessionId",
    "queueItemId",
    "idempotencyKey",
    "entries",
  ],
  "session/turn/queue/steer": ["sessionId", "queueItemId", "expectedTurnId"],
  "session/turn/queue/resume": ["sessionId"],
  "config/schema": [],
  "config/read": ["sessionId", "cwd"],
  "config/effective/read": ["sessionId"],
  "config/fields/read": ["sessionId"],
  "config/write": ["sessionId", "ops", "reason", "reloadRuntime"],
  "config/reload": ["sessionId", "reloadRuntime"],
  "mcp_catalog/read": ["sessionId"],
  "mcp_catalog/refresh": ["sessionId"],
  "mcp_catalog/toggle": ["sessionId", "name", "source", "disabled", "toolName"],
  "mcp_catalog/add": [
    "sessionId",
    "url",
    "name",
    "scopes",
    "transport",
    "allowInsecureHttp",
  ],
  "mcp_catalog/remove": ["sessionId", "name"],
  "mcp_catalog/login": ["sessionId", "name"],
  "mcp_catalog/logout": ["sessionId", "name"],
  "connector_catalog/read": ["sessionId"],
  "connector_catalog/refresh": ["sessionId"],
  "connector_catalog/toggle": ["sessionId", "alias", "disabled", "toolName"],
  "connector_catalog/auth/request": ["sessionId", "alias"],
  "connectors/read": ["sessionId"],
  "connectors/refresh": ["sessionId"],
  "connectors/auth/read": ["sessionId", "name"],
  "skills/catalog": ["sessionId"],
  "skills/installed": ["sessionId"],
  "skills/detail": ["sessionId", "skillId", "version"],
  "skills/setEnabled": ["sessionId", "name", "enabled"],
  "plugin_catalog/read": ["sessionId"],
  "plugin/info": ["sessionId"],
  "plugin/reload": ["sessionId"],
  "mcp/read": ["sessionId"],
  "skills/list": ["sessionId"],
  "plugins/read": ["sessionId"],
  "diagnostics/list": ["sessionId"],
  "session/continue": ["agentConfig", "historyLimit"],
  "session/fork": [
    "idempotencyKey",
    "sourceSessionId",
    "entryId",
    "agentConfig",
    "afterTurnId",
    "historyLimit",
    "attach",
  ],
  "session/rewind": ["sessionId", "entryId", "restoreFiles", "inplace"],
  "session/rewind/read": ["sessionId", "entryId"],
  "session/markAsSeen": ["sessionId"],
  "session/delete": ["sessionId"],
  "session/rename": ["sessionId", "title"],
  "session/relocate": ["sessionId", "cwd"],
  "session/compact": ["sessionId", "extraInstructions"],
  "session/settings/update": ["sessionId", "maxTurns", "maxTokens"],
  "session/history/clear": ["sessionId"],
  "session/history/get": ["sessionId", "historyLimit"],
  "session/turns/list": ["sessionId", "page"],
  "session/ready/read": ["sessionId"],
  "session/ready/wait": ["sessionId"],
  "session/log/read": ["sessionId"],
  "session/context/inject": [
    "sessionId",
    "input",
    "asMessage",
    "injectInvokedSkill",
    "clientUserMessageId",
    "mentionStats",
  ],
  "session/backgroundProcess/output": [
    "sessionId",
    "processId",
    "fromEnd",
    "cursor",
    "waitMs",
    "maxBytes",
  ],
  "session/backgroundProcess/stop": ["sessionId", "processId"],
  "loops/create": ["sessionId", "interval", "prompt"],
  "loops/list": ["sessionId"],
  "loops/delete": ["sessionId", "loopId"],
  "loops/clear": ["sessionId"],
  "projectLinks/list": [],
  "projectLinks/create": ["rootPath", "name", "defaultBranch"],
  "projectLinks/link": ["rootPath", "projectId", "projectName"],
  "projectLinks/unlink": ["rootPath"],
  "projectLinks/save": [
    "rootPath",
    "projectId",
    "projectName",
    "expectedGithubRepoUrl",
  ],
  "projectLinks/inspectRoot": ["rootPath"],
  "projectLinks/resolveRoot": ["rootPath"],
  "projectLinks/picker/load": ["rootPath"],
  "projectLinks/picker/loadMore": ["rootPath", "cursor"],
  "vibeCode/projects/open": ["sessionId", "purpose", "prompt"],
  "vibeCode/projects/loadMore": ["sessionId", "pickerId"],
  "vibeCode/projects/create": [
    "sessionId",
    "pickerId",
    "name",
    "defaultBranch",
  ],
  "vibeCode/projects/select": ["sessionId", "pickerId", "projectId"],
  "vibeCode/projects/unlink": ["sessionId", "pickerId"],
  "vibeCode/projects/cancel": ["sessionId", "pickerId"],
  "vibeCode/projects/recover": ["sessionId", "pickerId"],
  "vibeCode/teleport/start": [
    "sessionId",
    "pickerId",
    "operationId",
    "prompt",
    "projectId",
  ],
  "vibeCode/teleport/cancel": ["sessionId", "operationId"],
  "vibeCode/teleport/push/respond": ["sessionId", "operationId", "approved"],
  "workspace/git/checkouts": ["repoLocalPaths", "sessionCwd"],
  "workspace/git/worktrees/limit/update": ["limit"],
  "workspace/git/worktrees/prune": [],
  "workspace/git/worktrees/reap": ["cwd", "requesterId", "requestId"],
  "workspace/git/worktrees/reap/cancel": ["cwd", "requesterId", "requestId"],
  "workspace/git/worktrees/remove": ["cwd"],
  "skills/import": ["sessionId", "skillId", "version", "alias", "scope"],
  "skills/setAlias": ["sessionId", "name", "alias", "scope"],
  "skills/setVersion": ["sessionId", "name", "version", "scope"],
  "skills/setLatest": ["sessionId", "name", "scope"],
  "skills/remove": ["sessionId", "name", "scope"],
  "skills/convertLocal": ["sessionId", "name", "scope"],
  "skills/versions": ["sessionId", "skillId"],
  "skills/updates": ["sessionId"],
  "mcp/add": [
    "sessionId",
    "url",
    "name",
    "scopes",
    "transport",
    "allowInsecureHttp",
  ],
  "mcp/toggle": ["sessionId", "name", "source", "disabled", "toolName"],
  "mcp/login": ["sessionId", "name"],
  "mcp/logout": ["sessionId", "name"],
  "mcp/refresh": ["sessionId"],
  "tools/list": ["sessionId"],
  "agents/install": ["sessionId", "agentName"],
  "agents/uninstall": ["sessionId", "agentName"],
  "diagnostics/logs/read": ["sessionId", "limit", "offset"],
  "identity/read": ["sessionId"],
  "providerAuth/read": ["sessionId"],
  "narration/summarize": [
    "sessionId",
    "userMessage",
    "assistantText",
    "error",
    "messageId",
  ],
  "shell/run": ["sessionId", "operationId", "command", "timeoutSeconds", "cwd"],
  "shell/interrupt": ["sessionId", "operationId"],
  "workspace/prompt/prepare": ["sessionId", "message", "titleContent"],
  "review/revert": ["sessionId", "target"],
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
  "account/read": ["sessionId"],
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
  "session/turn/enqueue": ["sessionId", "entries"],
  "session/turn/queue/read": ["sessionId"],
  "session/turn/queue/remove": ["sessionId", "queueItemId"],
  "session/turn/queue/replace": ["sessionId", "queueItemId", "entries"],
  "session/turn/queue/steer": ["sessionId", "queueItemId", "expectedTurnId"],
  "session/turn/queue/resume": ["sessionId"],
  "config/effective/read": ["sessionId"],
  "config/fields/read": ["sessionId"],
  "config/write": ["sessionId", "ops"],
  "config/reload": ["sessionId"],
  "mcp_catalog/read": ["sessionId"],
  "mcp_catalog/refresh": ["sessionId"],
  "mcp_catalog/toggle": ["sessionId", "name", "source", "disabled"],
  "mcp_catalog/add": ["sessionId", "url"],
  "mcp_catalog/remove": ["sessionId", "name"],
  "mcp_catalog/login": ["sessionId", "name"],
  "mcp_catalog/logout": ["sessionId", "name"],
  "connector_catalog/read": ["sessionId"],
  "connector_catalog/refresh": ["sessionId"],
  "connector_catalog/toggle": ["sessionId", "alias", "disabled"],
  "connector_catalog/auth/request": ["sessionId", "alias"],
  "connectors/read": ["sessionId"],
  "connectors/refresh": ["sessionId"],
  "connectors/auth/read": ["sessionId", "name"],
  "skills/catalog": ["sessionId"],
  "skills/installed": ["sessionId"],
  "skills/detail": ["sessionId", "skillId"],
  "skills/setEnabled": ["sessionId", "name", "enabled"],
  "plugin_catalog/read": ["sessionId"],
  "plugin/info": ["sessionId"],
  "plugin/reload": ["sessionId"],
  "mcp/read": ["sessionId"],
  "skills/list": ["sessionId"],
  "plugins/read": ["sessionId"],
  "diagnostics/list": ["sessionId"],
  "session/fork": ["sourceSessionId"],
  "session/rewind": ["sessionId", "entryId"],
  "session/rewind/read": ["sessionId", "entryId"],
  "session/markAsSeen": ["sessionId"],
  "session/delete": ["sessionId"],
  "session/rename": ["sessionId", "title"],
  "session/relocate": ["sessionId", "cwd"],
  "session/compact": ["sessionId"],
  "session/history/clear": ["sessionId"],
  "session/history/get": ["sessionId"],
  "session/turns/list": ["sessionId"],
  "session/ready/read": ["sessionId"],
  "session/ready/wait": ["sessionId"],
  "session/log/read": ["sessionId"],
  "session/context/inject": ["sessionId", "input"],
  "session/backgroundProcess/output": ["sessionId", "processId"],
  "session/backgroundProcess/stop": ["sessionId", "processId"],
  "loops/create": ["sessionId", "interval", "prompt"],
  "loops/list": ["sessionId"],
  "loops/delete": ["sessionId", "loopId"],
  "loops/clear": ["sessionId"],
  "projectLinks/create": ["rootPath", "name"],
  "projectLinks/link": ["rootPath", "projectId", "projectName"],
  "projectLinks/unlink": ["rootPath"],
  "projectLinks/save": ["rootPath", "projectId", "projectName"],
  "projectLinks/inspectRoot": ["rootPath"],
  "projectLinks/resolveRoot": ["rootPath"],
  "projectLinks/picker/load": ["rootPath"],
  "projectLinks/picker/loadMore": ["rootPath", "cursor"],
  "vibeCode/projects/open": ["sessionId"],
  "vibeCode/projects/loadMore": ["sessionId", "pickerId"],
  "vibeCode/projects/create": ["sessionId", "pickerId", "name"],
  "vibeCode/projects/select": ["sessionId", "pickerId", "projectId"],
  "vibeCode/projects/unlink": ["sessionId", "pickerId"],
  "vibeCode/projects/cancel": ["sessionId", "pickerId"],
  "vibeCode/projects/recover": ["sessionId", "pickerId"],
  "vibeCode/teleport/start": ["sessionId", "pickerId", "operationId", "projectId"],
  "vibeCode/teleport/cancel": ["sessionId", "operationId"],
  "vibeCode/teleport/push/respond": ["sessionId", "operationId", "approved"],
  "workspace/git/checkouts": ["repoLocalPaths"],
  "workspace/git/worktrees/limit/update": ["limit"],
  "workspace/git/worktrees/reap": ["cwd"],
  "workspace/git/worktrees/reap/cancel": ["cwd"],
  "workspace/git/worktrees/remove": ["cwd"],
  "skills/import": ["sessionId", "skillId"],
  "skills/setAlias": ["sessionId", "name", "alias"],
  "skills/setVersion": ["sessionId", "name", "version"],
  "skills/setLatest": ["sessionId", "name"],
  "skills/remove": ["sessionId", "name"],
  "skills/convertLocal": ["sessionId", "name"],
  "skills/versions": ["sessionId", "skillId"],
  "skills/updates": ["sessionId"],
  "mcp/add": ["url"],
  "mcp/toggle": ["name", "source", "disabled"],
  "mcp/login": ["name"],
  "mcp/logout": ["name"],
  "mcp/refresh": ["sessionId"],
  "tools/list": ["sessionId"],
  "agents/install": ["sessionId", "agentName"],
  "agents/uninstall": ["sessionId", "agentName"],
  "diagnostics/logs/read": ["sessionId"],
  "identity/read": ["sessionId"],
  "providerAuth/read": ["sessionId"],
  "narration/summarize": ["sessionId", "userMessage", "assistantText"],
  "shell/run": ["sessionId", "operationId", "command"],
  "shell/interrupt": ["sessionId", "operationId"],
  "workspace/prompt/prepare": ["sessionId", "message"],
  "review/revert": ["sessionId", "target"],
  "session/settings/update": ["sessionId"],
});

const ACTIVE_SESSION_METHODS = new Set([
  "session/stop",
  "session/title/update",
  "turn/start",
  "turn/interrupt",
  "turn/steer",
  "callback/result",
  "runtime/read",
  "account/read",
  "config/read",
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
  "session/turn/enqueue",
  "session/turn/queue/read",
  "session/turn/queue/remove",
  "session/turn/queue/replace",
  "session/turn/queue/steer",
  "session/turn/queue/resume",
  "config/effective/read",
  "config/fields/read",
  "config/write",
  "config/reload",
  "mcp_catalog/read",
  "mcp_catalog/refresh",
  "mcp_catalog/toggle",
  "mcp_catalog/add",
  "mcp_catalog/remove",
  "mcp_catalog/login",
  "mcp_catalog/logout",
  "connector_catalog/read",
  "connector_catalog/refresh",
  "connector_catalog/toggle",
  "connector_catalog/auth/request",
  "connectors/read",
  "connectors/refresh",
  "connectors/auth/read",
  "skills/catalog",
  "skills/installed",
  "skills/detail",
  "skills/setEnabled",
  "plugin_catalog/read",
  "plugin/info",
  "plugin/reload",
  "mcp/read",
  "skills/list",
  "plugins/read",
  "diagnostics/list",
  "session/rename",
  "session/relocate",
  "session/compact",
  "session/settings/update",
  "session/history/clear",
  "session/context/inject",
  "session/backgroundProcess/output",
  "session/backgroundProcess/stop",
  "session/ready/read",
  "session/ready/wait",
  "session/log/read",
  "loops/create",
  "loops/list",
  "loops/delete",
  "loops/clear",
  "vibeCode/projects/open",
  "vibeCode/projects/loadMore",
  "vibeCode/projects/create",
  "vibeCode/projects/select",
  "vibeCode/projects/unlink",
  "vibeCode/projects/cancel",
  "vibeCode/projects/recover",
  "vibeCode/teleport/start",
  "vibeCode/teleport/cancel",
  "vibeCode/teleport/push/respond",
  "skills/import",
  "skills/setAlias",
  "skills/setVersion",
  "skills/setLatest",
  "skills/remove",
  "skills/convertLocal",
  "skills/versions",
  "skills/updates",
  "mcp/add",
  "mcp/toggle",
  "mcp/login",
  "mcp/logout",
  "mcp/refresh",
  "tools/list",
  "agents/install",
  "agents/uninstall",
  "diagnostics/logs/read",
  "identity/read",
  "providerAuth/read",
  "narration/summarize",
  "shell/run",
  "shell/interrupt",
  "workspace/prompt/prepare",
  "review/revert",
  "session/turns/list",
  "session/history/get",
  "session/rewind/read",
]);

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
const SESSION_METADATA_METHODS = new Set([
  "session/pin",
  "session/archive",
  "session/markAsSeen",
  "session/rename",
  "session/title/update",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLeaseHolder(value) {
  return (
    value === null ||
    (isObject(value) &&
      (value.processId === null ||
        (Number.isSafeInteger(value.processId) && value.processId > 0)))
  );
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
    this.sessionLeaseHolders = new Map();
    this.leaseSnapshotReady = false;
    this.pendingCallbacks = new Map();
    this.configTargetsBySession = new Map();
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

    if (method === "session/list" && params.cwds?.length === 0)
      return { items: [] };

    if (method === "session/start" || method === "session/continue") {
      await this.#switchSessionIfNeeded();
    } else if (method === "session/resume") {
      this.#authorizeResume(params);
      await this.#switchSessionIfNeeded(params.sessionId);
    } else if (method === "session/fork") {
      const sourceEntry = this.knownSessions.get(params.sourceSessionId);
      if (sourceEntry?.readOnlyChild)
        throw new Error(
          "Subagent sessions are read-only and remain controlled by their parent",
        );
      if (params.attach !== false)
        await this.#switchSessionIfNeeded();
      else if (this.activeTurnId && params.sourceSessionId === this.activeSessionId)
        throw new Error(
          "Interrupt or wait for the active turn before forking this session",
        );
    } else if (method === "session/rewind" && params.inplace === false) {
      // Non-inplace rewind forks: it replaces the attached session like fork.
      await this.#switchSessionIfNeeded();
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
    if (method === "session/list" && Array.isArray(result?.items))
      return {
        ...result,
        items: result.items
          .filter(
            (session) =>
              typeof session?.id === "string" &&
              this.#isAuthorizedKnownSession(session.id),
          )
          .map((session) =>
            this.leaseSnapshotReady
              ? {
                  ...session,
                  leaseHolder: this.sessionLeaseHolders.get(session.id) ?? null,
                }
              : session,
          ),
      };
    if (method === "session/lease/subscribe" && Array.isArray(result?.held))
      return {
        ...result,
        held: result.held
          .filter(
            (item) =>
              isObject(item) &&
              typeof item.sessionId === "string" &&
              isLeaseHolder(item.leaseHolder) &&
              this.#isAuthorizedKnownSession(item.sessionId),
          )
          .map((item) => ({
            sessionId: item.sessionId,
            leaseHolder:
              item.leaseHolder === null
                ? null
                : { processId: item.leaseHolder.processId },
          })),
      };
    return result;
  }

  validateResumeForPool(rawParams) {
    const params = this.#validateParams("session/resume", rawParams);
    this.#authorizeResume(params);
    return params;
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

  async authorizeProjectRoot(rawPath) {
    await this.#loadPreferences();
    const canonical = await this.#canonicalDirectory(rawPath);
    if (!this.authorizedProjects.has(stablePathKey(canonical)))
      throw new Error(
        "Choose this project folder before using workspace tools",
      );
    return canonical;
  }

  async savePreferences(input) {
    await this.#loadPreferences();
    requireObject(input, "preferences");
    assertOnlyKeys(
      input,
      ["theme", "recentProjects", "mascot", "motion"],
      "preferences",
    );
    for (const option of ["mascot", "motion"]) {
      if (input[option] !== undefined && typeof input[option] !== "boolean")
        throw new TypeError(`${option} must be a boolean`);
    }
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
    for (const option of ["mascot", "motion"])
      if (input[option] !== undefined) next[option] = input[option];
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
    this.#clearLeaseSnapshot();
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
      if (this.#trackEvent(event) === false) return;
      if (event?.method === "session/lease/updated") {
        this.emit("event", {
          ...event,
          params: {
            sessionId: event.params.sessionId,
            leaseHolder:
              event.params.leaseHolder === null
                ? null
                : { processId: event.params.leaseHolder.processId },
          },
        });
        return;
      }
      this.emit("event", event);
    });
    rpc.on("transportError", (error) => {
      if (this.rpc !== rpc) return;
      this.activeSessionId = null;
      this.activeProjectRoot = null;
      this.activeTurnId = null;
      this.pendingCallbacks.clear();
      this.#clearLeaseSnapshot();
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
      this.#clearLeaseSnapshot();
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
    this.#clearLeaseSnapshot();
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
    if (method === "config/read") {
      if ((input.sessionId === undefined) === (input.cwd === undefined))
        throw new TypeError(
          "config/read requires exactly one of sessionId or cwd",
        );
      if (input.cwd !== undefined)
        this.#validateProjectPath(input.cwd, { required: true, exact: true });
    }
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
    if (method === "turn/start" || method === "turn/steer")
      validateTurnContent(input.message);
    if (method === "turn/start") {
      if (input.injected === true)
        throw new TypeError(
          "Renderer requests cannot mark user input as injected context",
        );
      validateTurnMetadata(input);
    }
    if (method === "turn/steer") {
      if (input.injectInvokedSkill === true)
        throw new TypeError("Renderer requests cannot inject skill context");
      validateTurnMetadata(input);
    }
    if (
      method === "session/turn/enqueue" ||
      method.startsWith("session/turn/queue/")
    )
      validateQueueParams(method, input);
    if (method === "config/write") validateConfigWrite(input);
    if (method === "config/write" && Array.isArray(input.ops)) {
      const knownTargets = this.configTargetsBySession.get(input.sessionId);
      for (const op of input.ops) {
        if (op?.targetLayer !== undefined) {
          requireString(op.targetLayer, "targetLayer", { max: 128 });
          if (!knownTargets?.has(op.targetLayer))
            throw new Error(
              "Read config/fields before selecting a write target",
            );
        }
      }
    }
    if (
      method === "config/reload" &&
      input.reloadRuntime !== undefined &&
      typeof input.reloadRuntime !== "boolean"
    )
      throw new TypeError("reloadRuntime must be a boolean");
    if (method === "mcp_catalog/toggle") {
      requireString(input.name, "name", { max: 256 });
      if (input.source !== "server")
        throw new TypeError(
          "Only server-owned MCP catalog entries can be toggled here",
        );
      if (typeof input.disabled !== "boolean")
        throw new TypeError("disabled must be a boolean");
      if (input.toolName !== undefined)
        requireString(input.toolName, "toolName", { max: 256 });
    }
    if (method === "mcp_catalog/add") validateMcpAdd(input);
    if (
      [
        "mcp_catalog/remove",
        "mcp_catalog/login",
        "mcp_catalog/logout",
      ].includes(method)
    )
      requireString(input.name, "name", { max: 256 });
    if (
      ["connector_catalog/toggle", "connector_catalog/auth/request"].includes(
        method,
      )
    )
      requireString(input.alias, "alias", { max: 256 });
    if (method === "connector_catalog/toggle") {
      if (typeof input.disabled !== "boolean")
        throw new TypeError("disabled must be a boolean");
      if (input.toolName !== undefined)
        requireString(input.toolName, "toolName", { max: 256 });
    }
    if (method === "connectors/auth/read")
      requireString(input.name, "name", { max: 256 });
    if (method === "skills/detail") {
      requireString(input.skillId, "skillId", { max: 512 });
      if (
        input.version !== undefined &&
        (!Number.isInteger(input.version) || input.version < 1)
      )
        throw new TypeError("version must be a positive integer");
    }
    if (method === "skills/setEnabled") {
      requireString(input.name, "name", { max: 256 });
      if (typeof input.enabled !== "boolean")
        throw new TypeError("enabled must be a boolean");
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
    if (method === "session/rename")
      requireString(input.title, "title", { max: 500 });
    if (method === "session/fork") {
      requireString(input.sourceSessionId, "sourceSessionId", { max: 256 });
      if (input.entryId !== undefined)
        requireString(input.entryId, "entryId", { max: 256 });
      if (input.afterTurnId !== undefined)
        requireString(input.afterTurnId, "afterTurnId", { max: 256 });
      if (input.idempotencyKey !== undefined)
        requireString(input.idempotencyKey, "idempotencyKey", { max: 256 });
      if (input.attach !== undefined && typeof input.attach !== "boolean")
        throw new TypeError("attach must be a boolean");
      if (input.historyLimit !== undefined) validateHistoryLimit(input.historyLimit);
      if (input.agentConfig !== undefined)
        this.#validateResumeAgentConfig(input.agentConfig);
    }
    if (method === "session/continue") {
      if (input.historyLimit !== undefined) validateHistoryLimit(input.historyLimit);
      if (input.agentConfig !== undefined)
        this.#validateResumeAgentConfig(input.agentConfig);
    }
    if (method === "session/rewind" || method === "session/rewind/read") {
      requireString(input.entryId, "entryId", { max: 256 });
      if (method === "session/rewind") {
        if (input.restoreFiles !== undefined && typeof input.restoreFiles !== "boolean")
          throw new TypeError("restoreFiles must be a boolean");
        if (input.inplace !== undefined && typeof input.inplace !== "boolean")
          throw new TypeError("inplace must be a boolean");
      }
    }
    if (method === "session/relocate")
      this.#validateProjectPath(input.cwd, { required: true, exact: true });
    if (method === "session/compact" && input.extraInstructions !== undefined)
      requireString(input.extraInstructions, "extraInstructions", {
        min: 0,
        max: 10000,
      });
    if (method === "session/settings/update") {
      if (input.maxTurns !== undefined && input.maxTurns !== null &&
        (!Number.isInteger(input.maxTurns) || input.maxTurns < 0))
        throw new TypeError("maxTurns must be a non-negative integer");
      if (input.maxTokens !== undefined && input.maxTokens !== null &&
        (!Number.isInteger(input.maxTokens) || input.maxTokens < 0))
        throw new TypeError("maxTokens must be a non-negative integer");
    }
    if (method === "session/history/get" && input.historyLimit !== undefined)
      validateHistoryLimit(input.historyLimit);
    if (method === "session/turns/list" && input.page !== undefined) {
      requireObject(input.page, "page");
      assertOnlyKeys(input.page, ["cursor", "limit", "direction"], "page");
    }
    if (method === "session/context/inject") {
      if (!Array.isArray(input.input) && typeof input.input !== "string")
        throw new TypeError("input must be an array or string");
      if (input.asMessage !== undefined && typeof input.asMessage !== "boolean")
        throw new TypeError("asMessage must be a boolean");
      if (input.injectInvokedSkill === true)
        throw new TypeError("Renderer requests cannot inject skill context");
      if (input.clientUserMessageId !== undefined)
        requireString(input.clientUserMessageId, "clientUserMessageId", { max: 256 });
    }
    if (
      method === "session/backgroundProcess/output" ||
      method === "session/backgroundProcess/stop"
    )
      requireString(input.processId, "processId", { max: 256 });
    if (method === "loops/create") {
      requireString(input.interval, "interval", { max: 256 });
      requireString(input.prompt, "prompt", { max: 100000 });
    }
    if (method === "loops/delete")
      requireString(input.loopId, "loopId", { max: 256 });
    if (method.startsWith("projectLinks/")) validateProjectLinksParams(method, input, (value, options) =>
      this.#validateProjectPath(value, options),
    );
    if (method.startsWith("vibeCode/") || method.startsWith("vibeCode/teleport/"))
      validateVibeCodeParams(method, input);
    if (
      [
        "workspace/git/worktrees/remove",
        "workspace/git/worktrees/reap",
        "workspace/git/worktrees/reap/cancel",
      ].includes(method)
    )
      this.#validateProjectPath(input.cwd, {
        required: true,
        allowSubdirectory: true,
      });
    if (method === "workspace/git/worktrees/limit/update") {
      if (!Number.isInteger(input.limit) || input.limit < 0 || input.limit > 100)
        throw new TypeError("limit must be between 0 and 100");
    }
    if (method === "workspace/git/checkouts") {
      if (!Array.isArray(input.repoLocalPaths) || !input.repoLocalPaths.length || input.repoLocalPaths.length > 20)
        throw new TypeError("repoLocalPaths must contain 1-20 paths");
      for (const repoPath of input.repoLocalPaths)
        this.#validateProjectPath(repoPath, { required: true });
      if (input.sessionCwd !== undefined)
        this.#validateProjectPath(input.sessionCwd, { required: true });
    }
    if (
      [
        "skills/import",
        "skills/setAlias",
        "skills/setVersion",
        "skills/setLatest",
        "skills/remove",
        "skills/convertLocal",
      ].includes(method)
    )
      validateSkillMutation(method, input);
    if (method === "skills/versions") requireString(input.skillId, "skillId", { max: 512 });
    if (method === "mcp/add") validateMcpAdd(input);
    if (method === "mcp/toggle") {
      requireString(input.name, "name", { max: 256 });
      if (!["server", "connector"].includes(input.source))
        throw new TypeError("MCP toggle source must be server or connector");
      if (typeof input.disabled !== "boolean")
        throw new TypeError("disabled must be a boolean");
      if (input.toolName !== undefined)
        requireString(input.toolName, "toolName", { max: 256 });
    }
    if (["mcp/login", "mcp/logout"].includes(method))
      requireString(input.name, "name", { max: 256 });
    if (["agents/install", "agents/uninstall"].includes(method))
      requireString(input.agentName, "agentName", { max: 128 });
    if (method === "diagnostics/logs/read") {
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500))
        throw new TypeError("limit must be between 1 and 500");
      if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0))
        throw new TypeError("offset must be a non-negative integer");
    }
    if (method === "narration/summarize") {
      requireString(input.userMessage, "userMessage", { max: 100000 });
      requireString(input.assistantText, "assistantText", { max: 200000 });
    }
    if (method === "shell/run") {
      requireString(input.operationId, "operationId", { max: 256 });
      requireString(input.command, "command", { max: 32768 });
      if (input.timeoutSeconds !== undefined &&
        (typeof input.timeoutSeconds !== "number" || input.timeoutSeconds <= 0 || input.timeoutSeconds > 600))
        throw new TypeError("timeoutSeconds must be between 0 and 600");
      if (input.cwd !== undefined)
        this.#validateProjectPath(input.cwd, { required: true, allowSubdirectory: true });
    }
    if (method === "shell/interrupt")
      requireString(input.operationId, "operationId", { max: 256 });
    if (method === "workspace/prompt/prepare") {
      if (!Array.isArray(input.message) || !input.message.length)
        throw new TypeError("message must be a non-empty array");
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
    if (params.cwd === undefined && params.cwds === undefined)
      params.cwds = [...this.authorizedProjects.values()].slice(
        0,
        MAX_RECENT_PROJECTS,
      );
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
    if (method === "session/fork") {
      const entry = this.knownSessions.get(params.sourceSessionId);
      if (
        !entry?.allowedRoots.some((root) =>
          this.authorizedProjects.has(stablePathKey(root)),
        )
      )
        throw new Error(
          "List sessions for a chosen project before forking one",
        );
      if (this.activeTurnId && params.sourceSessionId === this.activeSessionId)
        throw new Error(
          "Interrupt or wait for the active turn before forking this session",
        );
      return;
    }
    if (method === "session/delete") {
      const entry = this.knownSessions.get(params.sessionId);
      if (
        !entry ||
        entry.readOnlyChild ||
        !entry.allowedRoots.some((root) =>
          this.authorizedProjects.has(stablePathKey(root)),
        )
      )
        throw new Error(
          "Only a listed session for a chosen project can be deleted",
        );
      if (params.sessionId === this.activeSessionId)
        throw new Error("Stop this session before deleting it");
      return;
    }
    if (method === "session/rewind") {
      const entry = this.knownSessions.get(params.sessionId);
      if (
        !entry ||
        entry.readOnlyChild ||
        !entry.allowedRoots.some((root) =>
          this.authorizedProjects.has(stablePathKey(root)),
        )
      )
        throw new Error(
          "Only a listed session for a chosen project can be rewound",
        );
      if (this.activeTurnId && params.sessionId === this.activeSessionId)
        throw new Error(
          "Interrupt or wait for the active turn before rewinding",
        );
      return;
    }
    const sessionId = params.sessionId;
    if (!sessionId) return;
    if (SESSION_READ_METHODS.has(method)) {
      const entry = this.knownSessions.get(sessionId);
      if (
        !entry?.allowedRoots.some((root) =>
          this.authorizedProjects.has(stablePathKey(root)),
        )
      )
        throw new Error(
          "Read the project session list before opening this session",
        );
      return;
    }
    if (SESSION_METADATA_METHODS.has(method)) {
      const entry = this.knownSessions.get(sessionId);
      if (
        !entry ||
        entry.readOnlyChild ||
        !entry.allowedRoots.some((root) =>
          this.authorizedProjects.has(stablePathKey(root)),
        )
      )
        throw new Error(
          "Only a listed session for a chosen project can be pinned or archived",
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
    if (entry?.readOnlyChild)
      throw new Error(
        "Subagent sessions are read-only and remain controlled by their parent",
      );
    if (
      !entry ||
      entry.readOnlyChild ||
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
    if (method === "session/lease/subscribe") {
      this.sessionLeaseHolders.clear();
      this.leaseSnapshotReady = Array.isArray(result?.held);
      for (const item of result?.held ?? []) {
        if (
          !isObject(item) ||
          typeof item.sessionId !== "string" ||
          !isLeaseHolder(item.leaseHolder)
        )
          continue;
        if (item.leaseHolder !== null)
          this.sessionLeaseHolders.set(item.sessionId, {
            processId: item.leaseHolder.processId,
          });
      }
      this.#trimLeaseSnapshot();
    } else if (method === "config/fields/read") {
      if (Array.isArray(result?.targets))
        this.configTargetsBySession.set(
          params.sessionId,
          new Set(
            result.targets
              .filter((target) => typeof target === "string")
              .slice(0, 32),
          ),
        );
    } else if (method === "session/list") {
      const roots = params.cwd
        ? [this.#canonicalProjectSyncLookup(params.cwd)].filter(Boolean)
        : (params.cwds
            ?.map((cwd) => this.#canonicalProjectSyncLookup(cwd))
            .filter(Boolean) ?? [...this.authorizedProjects.values()]);
      for (const session of result.items ?? [])
        this.#rememberSession(session, roots);
    } else if (
      method === "session/start" ||
      method === "session/resume" ||
      method === "session/continue" ||
      method === "session/fork" ||
      method === "session/rewind" ||
      method === "session/history/clear"
    ) {
      const session = state?.session ?? result?.state?.session ?? result?.session;
      if (session?.id) {
        const requestedCwd = params.agentConfig?.cwd ?? params.cwd;
        const entry = this.knownSessions.get(session.id);
        const sourceEntry =
          method === "session/fork"
            ? this.knownSessions.get(params.sourceSessionId)
            : null;
        const roots = requestedCwd
          ? [this.#canonicalProjectSyncLookup(requestedCwd)].filter(Boolean)
          : (entry?.allowedRoots ?? sourceEntry?.allowedRoots ?? []);
        const effectiveRoots = roots.length
          ? roots
          : [...this.authorizedProjects.values()].slice(0, 1);
        this.#rememberSession(session, effectiveRoots);
        if (params.attach !== false) {
          this.activeSessionId = session.id;
          this.activeProjectRoot = effectiveRoots[0] ?? null;
        }
        this.#rememberChildSessions(state ?? result);
      }
    } else if (method === "session/delete") {
      this.knownSessions.delete(params.sessionId);
      this.sessionLeaseHolders.delete(params.sessionId);
    } else if (method === "session/relocate" && state?.session?.id) {
      const previous = this.knownSessions.get(state.session.id);
      const roots = params.cwd
        ? [this.#canonicalProjectSyncLookup(params.cwd)].filter(Boolean)
        : (previous?.allowedRoots ?? []);
      this.#rememberSession(state.session, roots);
      if (state.session.id === this.activeSessionId)
        this.activeProjectRoot = roots[0] ?? this.activeProjectRoot;
      this.#rememberChildSessions(state);
    } else if (method === "session/read" && state?.session?.id) {
      const previous = this.knownSessions.get(state.session.id);
      this.#rememberSession(state.session, previous?.allowedRoots ?? []);
      this.#rememberChildSessions(state);
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
    if (event.method === "session/lease/updated") {
      if (
        typeof params.sessionId !== "string" ||
        !isLeaseHolder(params.leaseHolder)
      )
        return false;
      if (params.leaseHolder === null) {
        this.sessionLeaseHolders.delete(params.sessionId);
      } else {
        this.sessionLeaseHolders.set(params.sessionId, {
          processId: params.leaseHolder.processId,
        });
        this.#trimLeaseSnapshot();
      }
      return this.#isAuthorizedKnownSession(params.sessionId);
    }
    if (event.method === "session/lease/ended") {
      this.sessionLeaseHolders.clear();
      this.leaseSnapshotReady = false;
      return;
    }
    if (event.method === "session/childSessionUpdated") {
      this.#rememberChildSession(params.childSession, params.sessionId);
      return;
    }
    if (
      [
        "session/snapshot",
        "session/compacted",
        "session/contextCleared",
      ].includes(event.method)
    ) {
      const state = params.state;
      if (isObject(state)) {
        const sessionId = state.session?.id;
        const previous = this.knownSessions.get(sessionId);
        if (sessionId && previous?.allowedRoots?.length)
          this.#rememberSession(state.session, previous.allowedRoots);
        this.#rememberChildSessions(state);
      }
    }
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
    const previous = this.knownSessions.get(session.id);
    const candidateRoots = allowedRoots.filter((root) =>
      this.authorizedProjects.has(stablePathKey(root)),
    );
    const previousRoots = (previous?.allowedRoots ?? []).filter((root) =>
      this.authorizedProjects.has(stablePathKey(root)),
    );
    let scopedRoots = previous?.readOnlyChild
      ? candidateRoots.filter((root) =>
          previous.allowedRoots?.some(
            (previousRoot) =>
              stablePathKey(previousRoot) === stablePathKey(root),
          ),
        )
      : typeof session.cwd === "string"
        ? candidateRoots
        : previousRoots.length
          ? candidateRoots.filter((root) =>
              previousRoots.some(
                (previousRoot) =>
                  stablePathKey(previousRoot) === stablePathKey(root),
              ),
            )
          : candidateRoots.length === 1
            ? candidateRoots
            : [];
    if (!previous?.readOnlyChild && typeof session.cwd === "string") {
      const sessionCwd = this.#canonicalProjectSyncLookup(session.cwd);
      scopedRoots = sessionCwd
        ? candidateRoots.filter((root) => isInside(root, sessionCwd))
        : [];
    }
    if (scopedRoots.length === 0) {
      this.knownSessions.delete(session.id);
      return;
    }
    this.knownSessions.set(session.id, {
      ...previous,
      cwd: typeof session.cwd === "string" ? session.cwd : null,
      allowedRoots: [
        ...new Map(
          scopedRoots.map((root) => [stablePathKey(root), root]),
        ).values(),
      ],
    });
    if (this.knownSessions.size > 5000)
      this.knownSessions.delete(this.knownSessions.keys().next().value);
  }

  #isAuthorizedKnownSession(sessionId) {
    if (typeof sessionId !== "string") return false;
    const entry = this.knownSessions.get(sessionId);
    return Boolean(
      entry?.allowedRoots.some((root) =>
        this.authorizedProjects.has(stablePathKey(root)),
      ),
    );
  }

  #trimLeaseSnapshot() {
    while (this.sessionLeaseHolders.size > 5000)
      this.sessionLeaseHolders.delete(
        this.sessionLeaseHolders.keys().next().value,
      );
  }

  #clearLeaseSnapshot() {
    this.sessionLeaseHolders.clear();
    this.leaseSnapshotReady = false;
  }

  #rememberChildSessions(state) {
    const parentSessionId = state?.session?.id;
    const parent = this.knownSessions.get(parentSessionId);
    if (!parent?.allowedRoots?.length) return;
    for (const childSession of state.childSessions ?? [])
      this.#rememberChildSession(childSession, parentSessionId);
  }

  #rememberChildSession(childSession, parentSessionId) {
    if (
      !childSession ||
      typeof childSession.id !== "string" ||
      typeof parentSessionId !== "string"
    )
      return;
    const parent = this.knownSessions.get(parentSessionId);
    if (!parent?.allowedRoots?.length) return;
    this.knownSessions.set(childSession.id, {
      cwd: parent.cwd,
      allowedRoots: [...parent.allowedRoots],
      readOnlyChild: true,
      parentSessionId,
    });
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
        for (const option of ["mascot", "motion"])
          if (typeof stored[option] === "boolean")
            this.preferences[option] = stored[option];
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

function validateTurnContent(content, { sessionQueue = false } = {}) {
  if (!Array.isArray(content) || content.length === 0 || content.length > 64)
    throw new TypeError(
      "content must be a non-empty array with at most 64 blocks",
    );
  for (const block of content) {
    requireObject(block, "content block");
    if (block.type === "text") {
      assertOnlyKeys(block, ["type", "text"], "text content block");
      requireString(block.text, "message text", { max: 100_000 });
    } else if (block.type === "image" && !sessionQueue) {
      assertOnlyKeys(block, ["type", "attachment"], "image content block");
      const attachment = block.attachment;
      requireObject(attachment, "image attachment");
      assertOnlyKeys(
        attachment,
        ["source", "alias", "mimeType"],
        "image attachment",
      );
      requireString(attachment.alias, "image alias", { max: 512 });
      const mimeType = requireString(attachment.mimeType, "image mimeType", {
        max: 64,
      });
      if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType))
        throw new TypeError(
          "Only PNG, JPEG, and WebP attachments are supported",
        );
      requireObject(attachment.source, "image source");
      assertOnlyKeys(attachment.source, ["kind", "data"], "image source");
      if (attachment.source.kind !== "inline")
        throw new TypeError("Image attachments must contain inline data");
      validateBase64(
        attachment.source.data,
        MAX_INLINE_IMAGE_BYTES,
        "image data",
      );
    } else if (block.type === "resource" && !sessionQueue) {
      assertOnlyKeys(block, ["type", "resource"], "resource content block");
      const resource = block.resource;
      requireObject(resource, "user resource");
      assertOnlyKeys(
        resource,
        ["kind", "uri", "mediaType", "text"],
        "text resource",
      );
      if (resource.kind !== "text")
        throw new TypeError("Only text resources are supported");
      validateResourceUri(resource.uri);
      if (
        resource.mediaType !== undefined &&
        !String(resource.mediaType).startsWith("text/")
      )
        throw new TypeError("Text resources must use a text media type");
      const text = requireString(resource.text, "resource text", {
        min: 0,
        max: MAX_TEXT_RESOURCE_BYTES,
      });
      if (Buffer.byteLength(text, "utf8") > MAX_TEXT_RESOURCE_BYTES)
        throw new TypeError("Text resource exceeds the 8 MiB limit");
    } else if (sessionQueue && block.type === "embedded_resource") {
      assertOnlyKeys(
        block,
        ["type", "uri", "mediaType", "text"],
        "embedded text resource",
      );
      validateResourceUri(block.uri);
      if (
        block.mediaType !== undefined &&
        !String(block.mediaType).startsWith("text/")
      )
        throw new TypeError("Embedded resources must use a text media type");
      const text = requireString(block.text, "embedded resource text", {
        min: 0,
        max: MAX_TEXT_RESOURCE_BYTES,
      });
      if (Buffer.byteLength(text, "utf8") > MAX_TEXT_RESOURCE_BYTES)
        throw new TypeError("Embedded resource exceeds the 8 MiB limit");
    } else if (sessionQueue && block.type === "image") {
      assertOnlyKeys(
        block,
        ["type", "uri", "mediaType", "altText"],
        "queued image block",
      );
      if (
        !/^data:image\/(?:png|jpeg|webp);base64,/i.test(
          requireString(block.uri, "image URI", { max: 12 * 1024 * 1024 }),
        )
      )
        throw new TypeError("Queued images must use inline data URIs");
      const [header, data] = block.uri.split(",", 2);
      validateBase64(data, MAX_INLINE_IMAGE_BYTES, "queued image data");
      const mimeType = header.slice(5, header.indexOf(";"));
      if (block.mediaType !== undefined && block.mediaType !== mimeType)
        throw new TypeError(
          "Queued image mediaType does not match its data URI",
        );
      if (block.altText !== undefined)
        requireString(block.altText, "altText", { min: 0, max: 2000 });
    } else if (sessionQueue && block.type === "resource_link") {
      assertOnlyKeys(
        block,
        ["type", "uri", "name", "title", "description", "mediaType", "size"],
        "resource link block",
      );
      validateResourceUri(block.uri);
      for (const key of ["name", "title", "description", "mediaType"])
        if (block[key] !== undefined && block[key] !== null)
          requireString(block[key], key, { max: 2000 });
      if (
        block.size !== undefined &&
        (!Number.isSafeInteger(block.size) ||
          block.size < 0 ||
          block.size > MAX_TEXT_RESOURCE_BYTES)
      )
        throw new TypeError("resource link size is invalid");
    } else {
      throw new TypeError("Unsupported content block");
    }
  }
}

function validateBase64(value, maxDecodedBytes, label) {
  requireString(value, label, {
    min: 4,
    max: Math.ceil((maxDecodedBytes * 4) / 3) + 8,
  });
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new TypeError(`${label} must be valid base64`);
  const decodedLength = Buffer.from(value, "base64").byteLength;
  if (!decodedLength || decodedLength > maxDecodedBytes)
    throw new TypeError(
      `${label} must decode to at most ${maxDecodedBytes} bytes`,
    );
}

function validateResourceUri(value) {
  const uri = requireString(value, "resource URI", { max: 2048 });
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new TypeError("Resource URI must be an absolute urn or HTTPS URI");
  }
  if (parsed.protocol !== "urn:" && parsed.protocol !== "https:")
    throw new TypeError("Resource URI must use urn: or https:");
  if (parsed.username || parsed.password)
    throw new TypeError("Resource URI cannot contain credentials");
}

function validateQueueParams(method, params) {
  if (
    method === "session/turn/queue/read" ||
    method === "session/turn/queue/resume"
  )
    return;
  if (
    [
      "session/turn/queue/remove",
      "session/turn/queue/steer",
      "session/turn/queue/replace",
    ].includes(method)
  )
    requireString(params.queueItemId, "queueItemId", { max: 256 });
  if (method === "session/turn/queue/steer")
    requireString(params.expectedTurnId, "expectedTurnId", { max: 256 });
  if (
    method === "session/turn/enqueue" ||
    method === "session/turn/queue/replace"
  ) {
    if (
      !Array.isArray(params.entries) ||
      params.entries.length < 1 ||
      params.entries.length > 16
    )
      throw new TypeError("entries must contain between 1 and 16 items");
    for (const entry of params.entries) {
      requireObject(entry, "turn queue entry");
      assertOnlyKeys(
        entry,
        ["role", "entryId", "content", "annotations"],
        "turn queue entry",
      );
      if (!["user", "context"].includes(entry.role))
        throw new TypeError("Turn queue role must be user or context");
      if (entry.entryId !== undefined && entry.entryId !== null)
        requireString(entry.entryId, "entryId", { max: 256 });
      validateTurnContent(entry.content, { sessionQueue: true });
      if (entry.annotations !== undefined)
        validateQueueAnnotations(entry.annotations);
    }
    const userEntries = params.entries.filter((entry) => entry.role === "user");
    if (
      userEntries.length > 1 ||
      (userEntries.length && params.entries.at(-1).role !== "user")
    )
      throw new TypeError("A queued turn has at most one final user entry");
  }
  if (params.idempotencyKey !== undefined)
    requireString(params.idempotencyKey, "idempotencyKey", { max: 256 });
}

function validateQueueAnnotations(value) {
  requireObject(value, "annotations");
  assertOnlyKeys(value, ["vibe.userDisplayContent"], "annotations");
  const content = value["vibe.userDisplayContent"];
  if (content === undefined || content === null) return;
  requireObject(content, "user display content");
  assertOnlyKeys(
    content,
    ["version", "host", "content"],
    "user display content",
  );
  requireString(content.version, "display content version", { max: 128 });
  requireString(content.host, "display content host", { max: 128 });
  validateBoundedJson(content.content, "display content", 0);
}

function validateTurnMetadata(params) {
  if (params.idempotencyKey !== undefined)
    requireString(params.idempotencyKey, "idempotencyKey", { max: 256 });
  if (params.clientUserMessageId !== undefined)
    requireString(params.clientUserMessageId, "clientUserMessageId", {
      max: 256,
    });
  if (params.autoTitle !== undefined && params.autoTitle !== null)
    requireString(params.autoTitle, "autoTitle", { min: 0, max: 500 });
  if (params.injected !== undefined && typeof params.injected !== "boolean")
    throw new TypeError("injected must be a boolean");
  if (
    params.injectInvokedSkill !== undefined &&
    typeof params.injectInvokedSkill !== "boolean"
  )
    throw new TypeError("injectInvokedSkill must be a boolean");
  if (
    params.userDisplayContent !== undefined &&
    params.userDisplayContent !== null
  ) {
    const content = params.userDisplayContent;
    requireObject(content, "userDisplayContent");
    assertOnlyKeys(
      content,
      ["version", "host", "content"],
      "userDisplayContent",
    );
    requireString(content.version, "display content version", { max: 128 });
    requireString(content.host, "display content host", { max: 128 });
    validateBoundedJson(content.content, "display content", 0);
  }
  if (params.mentionStats !== undefined && params.mentionStats !== null) {
    const stats = params.mentionStats;
    requireObject(stats, "mentionStats");
    assertOnlyKeys(
      stats,
      ["count", "contextTypes", "fileExtensions"],
      "mentionStats",
    );
    if (
      stats.count !== undefined &&
      (!Number.isInteger(stats.count) || stats.count < 0 || stats.count > 1000)
    )
      throw new TypeError("mentionStats.count must be a non-negative integer");
    for (const key of ["contextTypes", "fileExtensions"]) {
      if (stats[key] === undefined) continue;
      requireObject(stats[key], `mentionStats.${key}`);
      if (Object.keys(stats[key]).length > 64)
        throw new TypeError(`mentionStats.${key} has too many entries`);
      for (const [name, count] of Object.entries(stats[key])) {
        requireString(name, `mentionStats.${key} key`, { max: 128 });
        if (!Number.isInteger(count) || count < 0 || count > 1000)
          throw new TypeError(
            `mentionStats.${key} values must be non-negative integers`,
          );
      }
    }
  }
}

function validateConfigWrite(params) {
  if (
    !Array.isArray(params.ops) ||
    params.ops.length < 1 ||
    params.ops.length > MAX_CONFIG_OPS
  )
    throw new TypeError(
      `ops must contain between 1 and ${MAX_CONFIG_OPS} entries`,
    );
  if (params.reason !== undefined)
    requireString(params.reason, "reason", { max: 256 });
  if (
    params.reloadRuntime !== undefined &&
    typeof params.reloadRuntime !== "boolean"
  )
    throw new TypeError("reloadRuntime must be a boolean");
  for (const op of params.ops) {
    requireObject(op, "config operation");
    assertOnlyKeys(
      op,
      ["op", "path", "value", "targetLayer"],
      "config operation",
    );
    if (!["set", "remove"].includes(op.op))
      throw new TypeError("Config operation must be set or remove");
    const parts = parseConfigPointer(op.path);
    if (op.op === "set") validateConfigValue(parts, op.value);
    else if (Object.hasOwn(op, "value") && op.value !== null)
      throw new TypeError("Remove operations cannot include a value");
  }
}

function parseConfigPointer(value) {
  const pointer = requireString(value, "config path", { max: 1024 });
  if (!pointer.startsWith("/"))
    throw new TypeError("Config paths must be JSON pointers");
  const parts = pointer
    .slice(1)
    .split("/")
    .map((part) => {
      if (/~(?![01])/.test(part))
        throw new TypeError("Invalid JSON pointer escape");
      return part.replace(/~1/g, "/").replace(/~0/g, "~");
    });
  const root = parts[0];
  if (
    ![
      "providers",
      "models",
      "mcp_servers",
      "disabled_mcp_server_names",
      "disabled_skills",
    ].includes(root)
  )
    throw new TypeError(
      "Config path is outside the editable provider, model, and MCP settings",
    );
  const allowedDepth = root.startsWith("disabled_") ? 1 : 3;
  if (parts.length > allowedDepth)
    throw new TypeError("Config path is too deeply nested");
  if (root.startsWith("disabled_") && parts.length !== 1)
    throw new TypeError("Disabled-name lists can only be replaced as a whole");
  if (parts.length > 1 && !parts[1])
    throw new TypeError("Config path contains an empty item name");
  if (parts.length === 3) {
    const fields =
      root === "providers"
        ? SAFE_PROVIDER_FIELDS
        : root === "models"
          ? SAFE_MODEL_FIELDS
          : SAFE_MCP_FIELDS;
    if (!fields.has(parts[2]))
      throw new TypeError(`Config field is not editable: ${parts[2]}`);
  }
  return parts;
}

function validateConfigValue(parts, value) {
  validateBoundedJson(value, "config value", 0);
  const [root] = parts;
  if (root === "providers") {
    if (parts.length === 1) {
      if (!Array.isArray(value) || value.length > 64)
        throw new TypeError("providers must be a list of at most 64 entries");
      value.forEach(validateProvider);
    } else if (parts.length === 2) validateProvider(value);
    else validateProviderField(parts[2], value);
  } else if (root === "models") {
    if (parts.length === 1) {
      if (!isObject(value) || Object.keys(value).length > MAX_CONFIG_ITEMS)
        throw new TypeError("models must be an object map");
      for (const [alias, model] of Object.entries(value)) {
        requireString(alias, "model alias", { max: 128 });
        validateModel(model);
      }
    } else if (parts.length === 2) validateModel(value);
    else validateModelField(parts[2], value);
  } else if (root === "mcp_servers") {
    if (parts.length === 1) {
      if (!Array.isArray(value) || value.length > 64)
        throw new TypeError("mcp_servers must be a list of at most 64 entries");
      value.forEach(validateSafeMcpServer);
    } else if (parts.length === 2) validateSafeMcpServer(value);
    else validateSafeMcpField(parts[2], value);
  } else {
    if (!Array.isArray(value) || value.length > MAX_CONFIG_ITEMS)
      throw new TypeError(
        `${root} must be a list of at most ${MAX_CONFIG_ITEMS} names`,
      );
    for (const entry of value)
      requireString(entry, `${root} item`, { max: 256 });
  }
}

function validateProvider(value) {
  requireObject(value, "provider config");
  for (const key of Object.keys(value))
    if (!SAFE_PROVIDER_FIELDS.has(key))
      throw new TypeError(`Provider field is not editable: ${key}`);
  for (const key of Object.keys(value)) validateProviderField(key, value[key]);
}

function validateProviderField(key, value) {
  if (!SAFE_PROVIDER_FIELDS.has(key))
    throw new TypeError(`Provider field is not editable: ${key}`);
  if (key === "emits_finish_reason") {
    if (typeof value !== "boolean")
      throw new TypeError(`${key} must be a boolean`);
  } else if (key === "api_base") {
    validateApiBase(value);
  } else if (key === "api_key_env_var") {
    requireString(value, key, { min: 0, max: 256 });
    if (value && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
      throw new TypeError(
        "api_key_env_var must be an environment variable name",
      );
  } else if (key === "backend" && typeof value === "string") {
    requireString(value, key, { max: 64 });
  } else {
    requireString(value, key, { min: 0, max: 1024 });
  }
}

function validateApiBase(value) {
  const raw = requireString(value, "api_base", { max: 2048 });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError("api_base must be an HTTP(S) URL");
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(
    url.hostname.toLowerCase(),
  );
  if (
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" && !loopback) ||
    url.username ||
    url.password
  )
    throw new TypeError(
      "api_base must use HTTPS (HTTP is allowed only for loopback endpoints)",
    );
}

function validateModel(value) {
  requireObject(value, "model config");
  for (const key of Object.keys(value))
    if (!SAFE_MODEL_FIELDS.has(key))
      throw new TypeError(`Model field is not editable: ${key}`);
  for (const [key, fieldValue] of Object.entries(value))
    validateModelField(key, fieldValue);
}

function validateModelField(key, value) {
  if (!SAFE_MODEL_FIELDS.has(key))
    throw new TypeError(`Model field is not editable: ${key}`);
  if (["name", "provider", "alias", "display_name", "thinking"].includes(key)) {
    requireString(value, key, { min: 0, max: 512 });
  } else if (key === "supports_images") {
    if (typeof value !== "boolean")
      throw new TypeError(`${key} must be a boolean`);
  } else if (key === "thinking_levels") {
    if (!Array.isArray(value) || value.length > 16)
      throw new TypeError("thinking_levels must be a list");
    for (const level of value)
      requireString(level, "thinking level", { max: 64 });
  } else if (
    [
      "max_output_tokens",
      "max_context_length",
      "auto_compact_threshold",
    ].includes(key)
  ) {
    if (!Number.isInteger(value) || !Number.isFinite(value) || value < 1)
      throw new TypeError(`${key} must be a positive integer`);
  } else if (
    [
      "temperature",
      "top_p",
      "input_price",
      "output_price",
      "cached_input_price",
    ].includes(key)
  ) {
    if (
      value !== null &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        (key === "top_p" && value > 1))
    )
      throw new TypeError(`${key} must be a valid finite number`);
  }
}

function validateSafeMcpServer(value) {
  requireObject(value, "MCP server config");
  for (const key of Object.keys(value))
    if (!SAFE_MCP_FIELDS.has(key))
      throw new TypeError(`MCP config field is not editable here: ${key}`);
  if (
    value.transport !== undefined &&
    !["http", "streamable-http"].includes(value.transport)
  )
    throw new TypeError(
      "Only HTTP MCP transports are supported by the safe config editor",
    );
  if (value.url !== undefined) validateHttpsEndpoint(value.url, "MCP URL");
  for (const key of ["name", "prompt"])
    if (value[key] !== undefined)
      requireString(value[key], key, { min: 0, max: 2000 });
  for (const key of ["startup_timeout_sec", "tool_timeout_sec"])
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" ||
        !Number.isFinite(value[key]) ||
        value[key] <= 0 ||
        value[key] > 600)
    )
      throw new TypeError(`${key} must be between 0 and 600`);
  for (const key of ["sampling_enabled", "disabled"])
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw new TypeError(`${key} must be a boolean`);
  if (value.disabled_tools !== undefined) {
    if (
      !Array.isArray(value.disabled_tools) ||
      value.disabled_tools.length > MAX_CONFIG_ITEMS
    )
      throw new TypeError("disabled_tools must be a list of at most 128 names");
    value.disabled_tools.forEach((name) =>
      requireString(name, "disabled tool", { max: 256 }),
    );
  }
}

function validateSafeMcpField(key, value) {
  if (!SAFE_MCP_FIELDS.has(key))
    throw new TypeError(`MCP config field is not editable here: ${key}`);
  const partial = { [key]: value };
  validateSafeMcpServer(partial);
}

function validateHttpsEndpoint(value, label) {
  const raw = requireString(value, label, { max: 2048 });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new TypeError(
      `${label} must use HTTPS and cannot contain credentials`,
    );
}

function validateMcpAdd(params) {
  validateHttpsEndpoint(params.url, "MCP URL");
  if (params.name !== undefined && params.name !== null)
    requireString(params.name, "name", { max: 256 });
  if (params.transport !== undefined && params.transport !== "streamable-http")
    throw new TypeError(
      "Only streamable HTTP MCP servers can be added from this app",
    );
  if (params.allowInsecureHttp === true)
    throw new TypeError("Insecure HTTP MCP endpoints are disabled");
  if (params.scopes !== undefined) {
    if (!Array.isArray(params.scopes) || params.scopes.length > 32)
      throw new TypeError("scopes must contain at most 32 entries");
    for (const scope of params.scopes)
      requireString(scope, "OAuth scope", { max: 256 });
  }
}

function validateBoundedJson(value, label, depth) {
  if (depth > MAX_CONFIG_DEPTH)
    throw new TypeError(`${label} is nested too deeply`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    requireString(value, label, { min: 0, max: 10_000 });
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError(`${label} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CONFIG_ITEMS)
      throw new TypeError(`${label} has too many array items`);
    for (const item of value) validateBoundedJson(item, label, depth + 1);
    return;
  }
  requireObject(value, label);
  const keys = Object.keys(value);
  if (keys.length > 64) throw new TypeError(`${label} has too many fields`);
  for (const [key, child] of Object.entries(value)) {
    if (
      /(?:secret|password|token|authorization|headers|api_key)(?!_env_var)/i.test(
        key,
      )
    )
      throw new TypeError(`${label} cannot contain credential fields`);
    validateBoundedJson(child, label, depth + 1);
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

function validateHistoryLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 500)
    throw new TypeError("historyLimit must be between 1 and 500");
}

function validateProjectLinksParams(method, params, validatePath) {
  if (params.rootPath !== undefined)
    validatePath(params.rootPath, { required: true });
  if (method === "projectLinks/create")
    requireString(params.name, "name", { max: 256 });
  if (method === "projectLinks/link") {
    requireString(params.projectId, "projectId", { max: 256 });
    requireString(params.projectName, "projectName", { max: 256 });
  }
  if (method === "projectLinks/save") {
    requireString(params.projectId, "projectId", { max: 256 });
    requireString(params.projectName, "projectName", { max: 256 });
    if (params.expectedGithubRepoUrl !== undefined && params.expectedGithubRepoUrl !== null)
      requireString(params.expectedGithubRepoUrl, "expectedGithubRepoUrl", { max: 2048 });
  }
  if (method === "projectLinks/picker/loadMore")
    requireString(params.cursor, "cursor", { max: 2048 });
  if (params.defaultBranch !== undefined && params.defaultBranch !== null)
    requireString(params.defaultBranch, "defaultBranch", { max: 256 });
}

function validateVibeCodeParams(method, params) {
  if (params.pickerId !== undefined)
    requireString(params.pickerId, "pickerId", { max: 256 });
  if (params.operationId !== undefined)
    requireString(params.operationId, "operationId", { max: 256 });
  if (params.projectId !== undefined)
    requireString(params.projectId, "projectId", { max: 256 });
  if (params.prompt !== undefined && params.prompt !== null)
    requireString(params.prompt, "prompt", { min: 0, max: 100000 });
  if (params.purpose !== undefined && !["configure", "teleport"].includes(params.purpose))
    throw new TypeError("purpose must be configure or teleport");
  if (params.name !== undefined)
    requireString(params.name, "name", { max: 256 });
  if (params.defaultBranch !== undefined)
    requireString(params.defaultBranch, "defaultBranch", { max: 256 });
  if (params.approved !== undefined && typeof params.approved !== "boolean")
    throw new TypeError("approved must be a boolean");
}

function validateSkillMutation(method, params) {
  requireString(params.name, "name", { max: 256 });
  if (params.scope !== undefined && !["global", "project", "local"].includes(params.scope))
    throw new TypeError("scope must be global, project or local");
  if (method === "skills/setAlias")
    requireString(params.alias, "alias", { max: 256 });
  if (method === "skills/setVersion") {
    if (!Number.isInteger(params.version) || params.version < 1)
      throw new TypeError("version must be a positive integer");
  }
  if (method === "skills/import") {
    requireString(params.skillId, "skillId", { max: 512 });
    if (params.version !== undefined && (!Number.isInteger(params.version) || params.version < 1))
      throw new TypeError("version must be a positive integer");
    if (params.alias !== undefined && params.alias !== null)
      requireString(params.alias, "alias", { max: 256 });
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
