const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, listener) {
  if (typeof listener !== "function")
    throw new TypeError("Listener must be a function");
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld(
  "vibe",
  Object.freeze({
    connect: () => ipcRenderer.invoke("vibe:connect"),
    request: (method, params = {}) =>
      ipcRenderer.invoke("vibe:request", method, params),
    chooseProject: () => ipcRenderer.invoke("vibe:choose-project"),
    chooseWorktreeRoot: () => ipcRenderer.invoke("vibe:choose-worktree-root"),
    chooseEditorPath: () => ipcRenderer.invoke("vibe:choose-editor-path"),
    notify: (notice) => ipcRenderer.invoke("vibe:notify", notice),
    onNoticeClick: (listener) => subscribe("vibe:notice-click", listener),
    editorDetect: () => ipcRenderer.invoke("vibe:editor:detect"),
    editorDetectAcp: () => ipcRenderer.invoke("vibe:editor:detect-acp"),
    editorOpen: (input) => ipcRenderer.invoke("vibe:editor:open", input),
    editorOpenTerminal: (input) => ipcRenderer.invoke("vibe:editor:open-terminal", input),
    readPreferences: () => ipcRenderer.invoke("vibe:preferences:read"),
    savePreferences: (preferences) =>
      ipcRenderer.invoke("vibe:preferences:save", preferences),
    onEvent: (listener) => subscribe("vibe:event", listener),
    onStatus: (listener) => subscribe("vibe:status", listener),
    openExternal: (url) => ipcRenderer.invoke("vibe:open-external", url),
    git: (method, params) => ipcRenderer.invoke("vibe:git", method, params),
    setWindowTheme: (theme) => ipcRenderer.invoke("vibe:window-theme", theme),
    auth: (action, attemptId) =>
      ipcRenderer.invoke("vibe:auth", action, attemptId),
    openAuthLink: (id) => ipcRenderer.invoke("vibe:open-auth-link", id),
    openQuotaDashboard: (kind) =>
      ipcRenderer.invoke("vibe:quota-dashboard", kind),
    previewOpen: (url) => ipcRenderer.invoke("vibe:preview-open", url),
    previewReload: () => ipcRenderer.invoke("vibe:preview-reload"),
    previewClose: () => ipcRenderer.invoke("vibe:preview-close"),
  }),
);
