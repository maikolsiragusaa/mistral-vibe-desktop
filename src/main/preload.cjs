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
  }),
);
