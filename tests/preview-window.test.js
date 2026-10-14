import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  isAllowedPreviewNavigation,
  isAllowedPreviewUrl,
  previewOrigin,
  PreviewWindowService,
  previewUrlProblem,
} from "../src/main/preview-window.js";

test("initial preview URLs admit only explicit loopback http origins", () => {
  assert.equal(isAllowedPreviewUrl("http://localhost:3000/"), true);
  assert.equal(isAllowedPreviewUrl("http://127.0.0.1:5173/x"), true);
  assert.equal(isAllowedPreviewUrl("http://[::1]:8080/"), true);
  assert.equal(isAllowedPreviewUrl("https://localhost:3000/"), false);
  assert.equal(isAllowedPreviewUrl("http://example.com/"), false);
  assert.equal(isAllowedPreviewUrl("http://10.0.0.5:3000/"), false);
  assert.equal(isAllowedPreviewUrl("http://[::ffff:127.0.0.1]:3000/"), false);
  assert.equal(isAllowedPreviewUrl("file:///C:/secret.txt"), false);
  assert.equal(isAllowedPreviewUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedPreviewUrl("data:text/html,<h1>x</h1>"), false);
  assert.equal(isAllowedPreviewUrl("http://user:pass@localhost:3000/"), false);
  // Encoded hostnames normalize before the check, never bypass it.
  assert.equal(isAllowedPreviewUrl("http://%65xample.com/"), false);
  assert.equal(isAllowedPreviewUrl("http://localhost:3000/"), true);
  assert.equal(typeof previewUrlProblem("http://example.com/"), "string");
  assert.equal(previewUrlProblem("http://localhost:3000/"), null);
  assert.equal(previewOrigin("http://localhost:3000/a"), "http://localhost:3000");
});

test("redirects and later navigations stay on the approved origin", () => {
  const approved = "http://localhost:3000/app";
  assert.equal(isAllowedPreviewNavigation(approved, "http://localhost:3000/other"), true);
  assert.equal(isAllowedPreviewNavigation(approved, "http://localhost:9999/other"), false);
  assert.equal(isAllowedPreviewNavigation(approved, "http://127.0.0.1:3000/other"), false);
  assert.equal(isAllowedPreviewNavigation(approved, "https://localhost:3000/other"), false);
  assert.equal(isAllowedPreviewNavigation(approved, "https://example.com/"), false);
  assert.equal(isAllowedPreviewNavigation(approved, "file:///etc/passwd"), false);
  assert.equal(isAllowedPreviewNavigation(approved, "http://localhost:3000@evil.com/"), false);
});

class FakeContents extends EventEmitter {
  constructor() {
    super();
    this.session = { setPermissionRequestHandler: () => {} };
    this.loaded = [];
  }
  setWindowOpenHandler() {}
}

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.webContents = new FakeContents();
    this.destroyed = false;
    this.loaded = [];
  }
  isDestroyed() {
    return this.destroyed;
  }
  show() {}
  focus() {}
  close() {
    this.destroyed = true;
    this.emit("closed");
  }
  loadURL(url) {
    this.loaded.push(url);
    this.webContents.loaded.push(url);
    return Promise.resolve();
  }
}

function makeService() {
  const created = [];
  const service = new PreviewWindowService({
    createWindow: (options) => {
      assert.equal(options.webPreferences.sandbox, true);
      assert.equal(options.webPreferences.nodeIntegration, false);
      assert.equal(options.webPreferences.contextIsolation, true);
      assert.equal(options.webPreferences.preload, undefined);
      assert.ok(String(options.webPreferences.partition).includes("vibe-local-preview"));
      const window = new FakeWindow();
      created.push(window);
      return window;
    },
  });
  return { service, created };
}

test("preview windows open loopback URLs isolated and block hostile navigation", async () => {
  const { service, created } = makeService();
  await assert.rejects(service.open("https://example.com/"), /loopback/);
  assert.equal(created.length, 0);
  await service.open("http://localhost:3000/app");
  assert.equal(created.length, 1);
  const window = created[0];
  assert.equal(window.loaded[0], "http://localhost:3000/app");

  // Redirect to a public domain is blocked with an explanatory page.
  const redirect = window.webContents.listeners("will-redirect")[0];
  assert.ok(redirect);
  let prevented = false;
  redirect({ preventDefault: () => (prevented = true) }, "https://example.com/steal");
  assert.equal(prevented, true);
  assert.match(window.loaded.at(-1), /^data:text\/html,/);

  // file:// navigation is blocked as well.
  prevented = false;
  const navigate = window.webContents.listeners("will-navigate")[0];
  navigate({ preventDefault: () => (prevented = true) }, "file:///C:/secret.txt");
  assert.equal(prevented, true);

  // Same-origin loopback navigation is allowed through.
  prevented = false;
  navigate({ preventDefault: () => (prevented = true) }, "http://localhost:3000/other");
  assert.equal(prevented, false);

  // A dead local server shows an error page instead of hanging.
  window.webContents.emit("did-fail-load", {}, -102, "Connection refused", "http://localhost:3000/app");
  assert.match(window.loaded.at(-1), /^data:text\/html,/);

  await service.reload();
  assert.equal(window.loaded.at(-1), "http://localhost:3000/app");
  await service.close();
  assert.equal(window.isDestroyed(), true);
});
