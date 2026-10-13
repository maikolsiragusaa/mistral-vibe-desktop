import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  shell,
} from "electron";
import { mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VibeBackendPool } from "./backend-pool.js";
import { GitWorkspaceService } from "./git-service.js";
import { BrowserAuthService } from "./browser-auth.js";
import { PreviewWindowService } from "./preview-window.js";
import { randomUUID } from "node:crypto";
import os from "node:os";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true,
      allowServiceWorkers: false,
      corsEnabled: false,
    },
  },
]);

const currentDir = path.dirname(fileURLToPath(import.meta.url));
let mainWindow = null;
let quotaWindow = null;
let backend = null;
let gitWorkspace = null;
let browserAuth = null;
let localPreview = null;
const gitLinks = new Set();
const authLinks = new Map();
let quitting = false;
let ipcInstalled = false;

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
  [".ico", "image/x-icon"],
]);

const rendererCsp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function trustedUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "app:" && url.hostname === "renderer";
  } catch {
    return false;
  }
}

async function serveRenderer(request) {
  if (!trustedUrl(request.url) || !["GET", "HEAD"].includes(request.method)) {
    return new Response("Not found", { status: 404 });
  }
  let relativePath;
  try {
    relativePath = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (relativePath === "/" || relativePath === "") relativePath = "/index.html";
  const rendererRoot = path.resolve(app.getAppPath(), "dist");
  const filePath = path.resolve(rendererRoot, `.${relativePath}`);
  if (
    filePath !== rendererRoot &&
    !filePath.startsWith(`${rendererRoot}${path.sep}`)
  ) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const details = await stat(filePath);
    if (!details.isFile()) return new Response("Not found", { status: 404 });
    const body = request.method === "HEAD" ? null : await readFile(filePath);
    const headers = {
      "Content-Type":
        contentTypes.get(path.extname(filePath).toLowerCase()) ??
        "application/octet-stream",
      "Content-Security-Policy": rendererCsp,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control":
        path.basename(filePath) === "index.html"
          ? "no-cache"
          : "public, max-age=31536000, immutable",
    };
    return new Response(body, { status: 200, headers });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

function assertTrustedSender(event) {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error("Untrusted app renderer");
  }
  if (!trustedUrl(event.senderFrame.url))
    throw new Error("Untrusted app renderer");
}

function installIpc() {
  if (ipcInstalled) return;
  ipcInstalled = true;
  const handle = (channel, callback) => {
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedSender(event);
      return callback(...args);
    });
  };

  handle("vibe:connect", () => backend.connect());
  handle("vibe:request", (method, params) => backend.request(method, params));
  handle("vibe:choose-project", () => backend.chooseProject());
  handle("vibe:preferences:read", () => backend.readPreferences());
  handle("vibe:preferences:save", (preferences) =>
    backend.savePreferences(preferences),
  );
  handle("vibe:open-external", (url) =>
    gitLinks.has(url)
      ? shell.openExternal(url)
      : backend.openExternal(url, shell),
  );
  handle("vibe:git", (method, params) => {
    const operations = new Set([
      "status",
      "diff",
      "log",
      "stage",
      "unstage",
      "stageHunk",
      "unstageHunk",
      "createWorktree",
      "removeWorktree",
      "pruneWorktrees",
      "listDirectory",
      "readFile",
      "pullRequestDetails",
      "commit",
      "worktrees",
      "pullRequests",
      "createPullRequest",
    ]);
    if (!operations.has(method))
      throw new TypeError("Unsupported Git workspace operation");
    return Promise.resolve(gitWorkspace[method](params)).then((result) => {
      for (const url of [
        result?.url,
        typeof result?.repository === "string"
          ? `https://github.com/${result.repository}`
          : result?.repository?.url,
        ...(result?.items || []).map((item) => item.url),
      ]) {
        if (typeof url !== "string") continue;
        const parsed = new URL(url);
        if (
          parsed.protocol === "https:" &&
          parsed.hostname === "github.com" &&
          !parsed.username &&
          !parsed.password &&
          !parsed.search &&
          !parsed.hash &&
          /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/pull\/[1-9]\d*)?\/?$/.test(
            parsed.pathname,
          )
        )
          gitLinks.add(url);
      }
      if (gitLinks.size > 100) gitLinks.delete(gitLinks.values().next().value);
      return result;
    });
  });
  handle("vibe:auth", (action, attemptId) => {
    if (!["begin", "status", "complete", "cancel"].includes(action))
      throw new TypeError("Unsupported browser sign-in action");
    return browserAuth[action](attemptId);
  });
  handle("vibe:open-auth-link", async (id) => {
    const link = authLinks.get(id);
    if (!link || link.expiresAt < Date.now())
      throw new Error("This sign-in link has expired. Request a new one.");
    await shell.openExternal(link.url);
  });
  handle("vibe:quota-dashboard", (kind) => {
    const targets = {
      vibe: "https://console.mistral.ai/codestral/cli",
      usage: "https://admin.mistral.ai/organization/usage",
      limits: "https://admin.mistral.ai/plateforme/limits",
    };
    if (!Object.hasOwn(targets, kind))
      throw new TypeError("Unsupported quota dashboard");
    const official = (raw) => {
      try {
        const url = new URL(raw);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          (url.hostname === "mistral.ai" ||
            url.hostname.endsWith(".mistral.ai"))
        );
      } catch {
        return false;
      }
    };
    if (!quotaWindow || quotaWindow.isDestroyed()) {
      quotaWindow = new BrowserWindow({
        parent: mainWindow,
        width: 1080,
        height: 780,
        minWidth: 760,
        minHeight: 580,
        title: "Mistral usage and limits",
        autoHideMenuBar: true,
        webPreferences: {
          partition: "persist:vibe-mistral-quota",
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      quotaWindow.webContents.session.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      quotaWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (official(url)) void quotaWindow?.loadURL(url).catch(() => {});
        return { action: "deny" };
      });
      for (const eventName of ["will-navigate", "will-redirect"])
        quotaWindow.webContents.on(eventName, (event, url) => {
          if (!official(url)) event.preventDefault();
        });
      quotaWindow.on("closed", () => {
        quotaWindow = null;
      });
    }
    quotaWindow.show();
    quotaWindow.focus();
    return quotaWindow.loadURL(targets[kind]);
  });
  handle("vibe:preview-open", (url) => localPreview.open(url));
  handle("vibe:preview-reload", () => localPreview.reload());
  handle("vibe:preview-close", () => localPreview.close());
  handle("vibe:window-theme", (theme) => {
    if (!["light", "dark"].includes(theme))
      throw new TypeError("Unsupported window theme");
    if (process.platform === "win32" && mainWindow && !mainWindow.isDestroyed())
      mainWindow.setTitleBarOverlay({
        color: theme === "dark" ? "#181b20" : "#f6f3ed",
        symbolColor: theme === "dark" ? "#f6f3ed" : "#252a31",
        height: 42,
      });
  });

  backend.on("event", (event) => {
    if (
      ["mcp_catalog/authUrl", "connector_catalog/authUrl"].includes(
        event.method,
      )
    ) {
      try {
        const url = new URL(event.params.url);
        if (url.protocol !== "https:" || url.username || url.password) return;
        const id = randomUUID();
        authLinks.set(id, {
          url: url.href,
          expiresAt: Date.now() + 5 * 60_000,
        });
        if (authLinks.size > 20)
          authLinks.delete(authLinks.keys().next().value);
        event = {
          ...event,
          params: {
            name: event.params.name || event.params.alias,
            sessionId: event.params.sessionId,
            authLink: {
              id,
              host: url.hostname,
              name: event.params.name || event.params.alias,
            },
          },
        };
      } catch {
        return;
      }
    }
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send("vibe:event", event);
  });
  backend.on("status", (status) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send("vibe:status", status);
  });
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 920,
    minHeight: 640,
    backgroundColor: "#f4f1ea",
    title: "Vibe Desktop",
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    ...(process.platform === "win32"
      ? {
          titleBarOverlay: {
            color: "#f6f3ed",
            symbolColor: "#252a31",
            height: 42,
          },
        }
      : {}),
    webPreferences: {
      preload: path.join(currentDir, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!trustedUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on("will-redirect", (event, url) => {
    if (!trustedUrl(url)) event.preventDefault();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (
    process.platform === "win32" &&
    Number(os.release().split(".")[2]) >= 22000
  ) {
    try {
      mainWindow.setBackgroundMaterial("mica");
    } catch {
      /* Solid theme surface remains available. */
    }
  }
  void mainWindow.loadURL("app://renderer/index.html").catch(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
}

async function startApp() {
  if (process.env.VIBE_DESKTOP_USER_DATA) {
    const userData = process.env.VIBE_DESKTOP_USER_DATA;
    if (!path.isAbsolute(userData))
      throw new TypeError("VIBE_DESKTOP_USER_DATA must be an absolute path");
    const resolvedUserData = path.resolve(userData);
    mkdirSync(resolvedUserData, { recursive: true });
    app.setPath("userData", resolvedUserData);
  }
  await app.whenReady();
  Menu.setApplicationMenu(null);
  protocol.handle("app", serveRenderer);
  backend = new VibeBackendPool({ app, dialog, getWindow: () => mainWindow });
  gitWorkspace = new GitWorkspaceService({
    authorizeProjectRoot: (cwd) => backend.authorizeProjectRoot(cwd),
    managedWorktreesRoot: path.join(app.getPath("userData"), "worktrees"),
    getWorktreeOwnership: (worktreePath) =>
      Promise.resolve(backend.describeWorktreeUsage(worktreePath)),
  });
  browserAuth = new BrowserAuthService({
    app,
    openExternal: (url) => shell.openExternal(url),
  });
  localPreview = new PreviewWindowService({
    createWindow: (options) => new BrowserWindow(options),
    getMainWindow: () => mainWindow,
  });
  installIpc();
  createWindow();
  app.on("activate", createWindow);
}

app.on("before-quit", (event) => {
  if (quitting || !backend) return;
  event.preventDefault();
  quitting = true;
  void Promise.allSettled([
    backend.shutdown(),
    browserAuth?.shutdown(),
    localPreview?.shutdown(),
  ]).finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

void startApp();
