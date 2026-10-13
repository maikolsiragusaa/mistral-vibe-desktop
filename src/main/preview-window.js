import { EventEmitter } from "node:events";

// Isolated local web preview.
//
// A sandboxed <iframe> cannot enforce redirect policy: framed content can
// navigate itself to arbitrary origins and the renderer cannot intercept it.
// This service therefore opens loopback content in a dedicated Electron
// BrowserWindow with no preload, no Node integration and loopback-only
// navigation guards (initial URL, redirects and subsequent navigations).
// Nothing is ever launched automatically: every URL comes from an explicit
// user approval in the renderer, which re-validates with the same rules.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const MAX_URL_LENGTH = 2048;

export function previewUrlProblem(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "Enter a local URL to preview.";
  if (value.length > MAX_URL_LENGTH) return "This URL is too long.";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "Enter a complete URL such as http://localhost:3000/.";
  }
  if (url.protocol !== "http:") return "Only http:// loopback origins can be previewed.";
  if (url.username || url.password) return "URLs with credentials cannot be previewed.";
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (!LOOPBACK_HOSTS.has(host)) return "Only localhost, 127.0.0.1 or ::1 can be previewed.";
  return null;
}

export function isAllowedPreviewUrl(raw) {
  return previewUrlProblem(raw) === null;
}

export function previewOrigin(raw) {
  try {
    const url = new URL(String(raw).trim());
    const host = url.hostname.toLowerCase();
    return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return null;
  }
}

/** Subsequent navigations must stay on the approved loopback origin. */
export function isAllowedPreviewNavigation(approvedRaw, nextRaw) {
  if (!isAllowedPreviewUrl(nextRaw)) return false;
  const approvedOrigin = previewOrigin(approvedRaw);
  const nextOrigin = previewOrigin(nextRaw);
  if (!approvedOrigin || !nextOrigin) return false;
  return approvedOrigin === nextOrigin;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function blockedPage(blockedUrl, reason) {
  return `data:text/html,${encodeURIComponent(
    `<!doctype html><html><head><meta charset="utf-8"><title>Blocked preview navigation</title></head>` +
      `<body style="font-family:sans-serif;padding:32px;max-width:640px">` +
      `<h1>Blocked preview navigation</h1>` +
      `<p>${escapeHtml(reason)}</p>` +
      `<p>Blocked target: <code>${escapeHtml(blockedUrl)}</code></p>` +
      `<p>Local previews stay on the approved loopback origin. Use Open in browser for anything else.</p>` +
      `</body></html>`,
  )}`;
}

function errorPage(failedUrl, description) {
  return `data:text/html,${encodeURIComponent(
    `<!doctype html><html><head><meta charset="utf-8"><title>Preview unavailable</title></head>` +
      `<body style="font-family:sans-serif;padding:32px;max-width:640px">` +
      `<h1>Preview unavailable</h1>` +
      `<p>The local server did not respond: <code>${escapeHtml(failedUrl)}</code></p>` +
      `<p>${escapeHtml(description || "Connection failed.")}</p>` +
      `<p>Start the server yourself, then use Reload in Vibe Desktop. Nothing is launched automatically.</p>` +
      `</body></html>`,
  )}`;
}

export class PreviewWindowService extends EventEmitter {
  constructor({ createWindow, getMainWindow = () => null } = {}) {
    super();
    if (typeof createWindow !== "function")
      throw new TypeError("createWindow must be a function");
    this.createWindow = createWindow;
    this.getMainWindow = getMainWindow;
    this.window = null;
    this.approvedUrl = null;
    this.showingFallback = false;
  }

  async open(rawUrl) {
    const problem = previewUrlProblem(rawUrl);
    if (problem) throw new TypeError(problem);
    const url = String(rawUrl).trim();
    const window = this.#ensureWindow();
    this.approvedUrl = url;
    this.showingFallback = false;
    // Fire-and-forget: a blocked redirect or dead server must not hang the
    // IPC call. did-fail-load and navigation guards surface dedicated pages.
    void window.loadURL(url).catch(() => {});
    return { url };
  }

  async reload() {
    if (!this.approvedUrl) throw new Error("No local preview is open.");
    const window = this.#ensureWindow();
    this.showingFallback = false;
    void window.loadURL(this.approvedUrl).catch(() => {});
    return { url: this.approvedUrl };
  }

  async close() {
    this.approvedUrl = null;
    this.#destroyWindow();
  }

  async shutdown() {
    this.approvedUrl = null;
    this.#destroyWindow();
  }

  #ensureWindow() {
    if (this.window && !this.window.isDestroyed()) {
      try {
        this.window.show();
        this.window.focus();
      } catch {
        // A hidden preview window is still usable.
      }
      return this.window;
    }
    const parent =
      typeof this.getMainWindow === "function" ? this.getMainWindow() : null;
    const window = this.createWindow({
      parent: parent && !parent.isDestroyed?.() ? parent : null,
      width: 1100,
      height: 800,
      minWidth: 640,
      minHeight: 480,
      title: "Local preview",
      autoHideMenuBar: true,
      webPreferences: {
        partition: "persist:vibe-local-preview",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.window = window;
    try {
      window.webContents.session.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
    } catch {
      // Hardening best effort on fakes and older Electron builds.
    }
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    for (const eventName of ["will-navigate", "will-redirect"]) {
      window.webContents.on(eventName, (event, url) => {
        if (!isAllowedPreviewNavigation(this.approvedUrl, url)) {
          event.preventDefault();
          this.#showBlocked(url);
        }
      });
    }
    window.webContents.on("did-fail-load", (_event, code, description, validatedURL) => {
      if (this.showingFallback) return;
      if (validatedURL.startsWith("data:")) return;
      this.#showError(validatedURL || this.approvedUrl || "", description);
    });
    window.on("closed", () => {
      if (this.window === window) this.window = null;
    });
    return window;
  }

  #showBlocked(url) {
    this.showingFallback = true;
    try {
      void this.window?.loadURL(blockedPage(url, "This navigation leaves the approved local origin."));
    } catch {
      // The window may have closed mid-navigation.
    }
  }

  #showError(url, description) {
    this.showingFallback = true;
    try {
      void this.window?.loadURL(errorPage(url, description));
    } catch {
      // The window may have closed mid-navigation.
    }
  }

  #destroyWindow() {
    const window = this.window;
    this.window = null;
    this.showingFallback = false;
    if (!window) return;
    try {
      if (!window.isDestroyed()) window.close();
    } catch {
      // Shutdown continues regardless.
    }
  }
}
