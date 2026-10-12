import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  BrowserAuthError,
  BrowserAuthService,
} from "../src/main/browser-auth.js";

const FUTURE = "2030-01-01T00:05:00.000Z";
const TRUSTED_URL =
  "https://console.mistral.ai/vibe/sign-in?attempt=fixture&code_challenge=not-a-secret";

function createChild(onRequest, { stderrText = "" } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killCount = 0;
  let input = "";
  child.stdin.on("data", (chunk) => {
    input += chunk.toString("utf8");
    let newline;
    while ((newline = input.indexOf("\n")) >= 0) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      const request = JSON.parse(line);
      const result = onRequest(request);
      child.stdout.write(`${JSON.stringify({ id: request.id, ...result })}\n`);
    }
  });
  if (stderrText) queueMicrotask(() => child.stderr.write(stderrText));
  child.kill = () => {
    child.killCount += 1;
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit("close", 0, null);
      child.stdout.end();
      child.stderr.end();
    });
    return true;
  };
  return child;
}

function createApp({ isPackaged = true } = {}) {
  return {
    isPackaged,
    getAppPath: () => "C:\\Program Files\\Vibe Desktop\\resources\\app",
    getPath: (name) =>
      name === "userData"
        ? "C:\\Users\\tester\\AppData\\Roaming\\Vibe Desktop"
        : "",
  };
}

function createHarness({
  onRequest,
  now = () => Date.parse("2030-01-01T00:00:00.000Z"),
  url = TRUSTED_URL,
  stderrText = "",
} = {}) {
  const children = [];
  const launches = [];
  const opened = [];
  const service = new BrowserAuthService({
    app: createApp(),
    env: {
      PATH: "C:\\Windows\\System32",
      NODE_OPTIONS: "--inspect",
      MISTRAL_API_KEY: "private-env-value",
    },
    openExternal: async (value) => opened.push(value),
    exists: () => true,
    platform: "win32",
    resourcesPath: "C:\\Program Files\\Vibe Desktop\\resources",
    now,
    spawnProcess: (command, args, options) => {
      launches.push({ command, args, options });
      const child = createChild(
        onRequest ??
          ((request) => {
            if (request.action === "begin")
              return {
                result: {
                  attemptId: "fixture-attempt",
                  expiresAt: FUTURE,
                  signInUrl: url,
                },
              };
            if (request.action === "complete")
              return {
                result: {
                  attemptId: request.attemptId,
                  status: "completed",
                  persistResult: "keyring",
                  api_key: "must-not-leak",
                },
              };
            return {
              result: {
                auth: {
                  kind: "signed_out",
                  canUseActiveProvider: false,
                  signOutAvailable: false,
                },
              },
            };
          }),
        { stderrText },
      );
      children.push(child);
      return child;
    },
  });
  return { service, children, launches, opened };
}

test("delegated browser sign-in opens only the validated official URL and returns safe status", async () => {
  const { service, children, launches, opened } = createHarness();
  const events = [];
  service.on("status", (status) => events.push(status));

  const begun = await service.begin();
  assert.deepEqual(begun, {
    state: "awaiting_browser",
    attemptId: "fixture-attempt",
    expiresAt: FUTURE,
  });
  assert.deepEqual(opened, [TRUSTED_URL]);
  assert.equal(JSON.stringify(begun).includes("sign-in?"), false);
  assert.equal(
    launches[0].command,
    "C:\\Program Files\\Vibe Desktop\\resources\\backend\\vibe-app-server\\vibe-app-server.exe",
  );
  assert.deepEqual(launches[0].args, ["--desktop-auth"]);
  assert.equal(launches[0].options.shell, false);
  assert.equal(launches[0].options.windowsHide, true);
  assert.equal(Object.hasOwn(launches[0].options.env, "NODE_OPTIONS"), false);
  assert.equal(launches[0].options.env.MISTRAL_API_KEY, "private-env-value");
  assert.ok(events.every((event) => !Object.hasOwn(event, "signInUrl")));

  const completed = await service.complete("fixture-attempt");
  assert.deepEqual(completed, {
    state: "completed",
    attemptId: "fixture-attempt",
    persistResult: "keyring",
  });
  assert.equal(JSON.stringify(completed).includes("must-not-leak"), false);
  assert.equal(children[0].killCount, 1);
  assert.deepEqual(await service.status(), completed);
});

test("status is projected to safe booleans and the helper is stopped after the read", async () => {
  const { service, children } = createHarness({
    onRequest: (request) => ({
      result: {
        auth: {
          kind: "os_keyring",
          canUseActiveProvider: true,
          signOutAvailable: true,
          envKey: "MISTRAL_API_KEY",
        },
      },
    }),
  });

  assert.deepEqual(await service.status(), {
    state: "authenticated",
    authKind: "os_keyring",
    signOutAvailable: true,
  });
  assert.equal(children[0].killCount, 1);
});

test("an initial status read cannot stop a concurrently starting sign-in", async () => {
  const { service, children } = createHarness();
  const statusRead = service.status();
  const begin = service.begin();

  assert.equal((await statusRead).state, "signed_out");
  assert.equal((await begin).state, "awaiting_browser");
  assert.equal(children.length, 2);
  assert.equal(children[0].killCount, 1);
  assert.equal(children[1].killCount, 0);
});

test("simultaneous begin requests create at most one active attempt", async () => {
  const { service } = createHarness();
  const attempts = await Promise.allSettled([service.begin(), service.begin()]);

  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    attempts.filter((result) => result.status === "rejected")[0].reason.code,
    "AUTH_ATTEMPT_ACTIVE",
  );
});

test("untrusted browser URLs are rejected before opening and terminate the owned helper", async () => {
  const { service, children, opened } = createHarness({
    url: "https://console.mistral.ai.attacker.example/sign-in",
  });

  await assert.rejects(service.begin(), (error) => {
    assert.ok(error instanceof BrowserAuthError);
    assert.equal(error.code, "AUTH_URL_UNTRUSTED");
    return true;
  });
  assert.deepEqual(opened, []);
  assert.equal(children[0].killCount, 1);
  assert.deepEqual(await service.status(), {
    state: "error",
    message: "The sign-in link did not match the official Mistral console.",
  });
});

test("a live attempt prevents re-entry and cancel kills only its helper", async () => {
  const { service, children } = createHarness();
  await service.begin();

  await assert.rejects(
    service.begin(),
    (error) => error.code === "AUTH_ATTEMPT_ACTIVE",
  );
  assert.deepEqual(await service.cancel("fixture-attempt"), {
    state: "cancelled",
    attemptId: "fixture-attempt",
  });
  await assert.rejects(
    service.complete("fixture-attempt"),
    (error) => error.code === "AUTH_ATTEMPT_MISMATCH",
  );
  assert.equal(children[0].killCount, 1);
});

test("expired attempts cannot be exchanged", async () => {
  let clock = Date.parse("2030-01-01T00:00:00.000Z");
  const { service, children } = createHarness({
    now: () => clock,
    onRequest: (request) =>
      request.action === "begin"
        ? {
            result: {
              attemptId: "fixture-attempt",
              expiresAt: "2030-01-01T00:01:00.000Z",
              signInUrl: TRUSTED_URL,
            },
          }
        : {
            result: {
              auth: {
                kind: "signed_out",
                canUseActiveProvider: false,
                signOutAvailable: false,
              },
            },
          },
  });
  await service.begin();
  clock = Date.parse("2030-01-01T00:01:00.000Z");

  await assert.rejects(
    service.complete("fixture-attempt"),
    (error) => error.code === "AUTH_ATTEMPT_EXPIRED",
  );
  assert.equal(service.current.state, "expired");
  assert.equal(children[0].killCount, 1);
});

test("helper error text and stderr are never included in user-facing status", async () => {
  const { service, children } = createHarness({
    onRequest: () => ({
      error: {
        code: "BROWSER_SIGN_IN_FAILED",
        message: "private-env-value leaked",
      },
    }),
    stderrText: "private-env-value diagnostic",
  });

  await assert.rejects(service.begin(), (error) => {
    assert.equal(error.message, "Mistral sign-in could not be completed.");
    assert.equal(error.message.includes("private-env-value"), false);
    return true;
  });
  assert.equal(children[0].killCount, 1);
});
