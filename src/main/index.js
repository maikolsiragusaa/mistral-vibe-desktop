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
import { VibeBackend } from "./backend.js";

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
let backend = null;
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
  handle("vibe:open-external", (url) => backend.openExternal(url, shell));

  backend.on("event", (event) => {
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
  backend = new VibeBackend({ app, dialog, getWindow: () => mainWindow });
  installIpc();
  createWindow();
  app.on("activate", createWindow);
}

app.on("before-quit", (event) => {
  if (quitting || !backend) return;
  event.preventDefault();
  quitting = true;
  void backend.shutdown().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

void startApp();
