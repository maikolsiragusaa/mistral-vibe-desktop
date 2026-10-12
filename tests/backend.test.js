import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { VibeBackend, resolveServerExecutable } from "../src/main/backend.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function createBackend(t, options = {}) {
  const root = await createTempRoot("vibe-desktop-test-");
  const userData = path.join(root, "user-data");
  await fs.mkdir(userData);
  const selectedProject = path.join(root, "project");
  const otherProject = path.join(root, "other-project");
  await fs.mkdir(selectedProject);
  await fs.mkdir(otherProject);
  const app = {
    getVersion: () => "0.1.0-test",
    getAppPath: () => root,
    getPath: (name) => (name === "userData" ? userData : root),
  };
  const dialog = {
    showOpenDialog: async () => ({
      canceled: false,
      filePaths: [selectedProject],
    }),
  };
  const backend = new VibeBackend({ app, dialog, ...options });
  t.after(async () => {
    await backend.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { backend, root, selectedProject, otherProject, userData };
}

test("runtime resolver follows env, packaged resources, local venv, then PATH", () => {
  const existing = new Set([
    "C:\\resources\\backend\\vibe-app-server\\vibe-app-server.exe",
    "C:\\app\\.runtime\\venv\\Scripts\\vibe-app-server.exe",
  ]);
  const resolverOptions = {
    platform: "win32",
    appPath: "C:\\app",
    resourcesPath: "C:\\resources",
    exists: (candidate) => existing.has(candidate),
  };
  assert.equal(
    resolveServerExecutable({
      ...resolverOptions,
      env: { VIBE_APP_SERVER: "D:\\custom\\vibe-app-server.exe" },
      exists: (p) => p.startsWith("D:") || existing.has(p),
    }),
    "D:\\custom\\vibe-app-server.exe",
  );
  assert.equal(
    resolveServerExecutable({ ...resolverOptions, env: {} }),
    "C:\\resources\\backend\\vibe-app-server\\vibe-app-server.exe",
  );
  assert.equal(
    resolveServerExecutable({
      ...resolverOptions,
      env: {},
      exists: (candidate) =>
        candidate === "C:\\app\\.runtime\\venv\\Scripts\\vibe-app-server.exe",
    }),
    "C:\\app\\.runtime\\venv\\Scripts\\vibe-app-server.exe",
  );
  assert.equal(
    resolveServerExecutable({
      ...resolverOptions,
      env: {},
      exists: () => false,
    }),
    "vibe-app-server.exe",
  );
});

test("project picker is the only way to add a recent project to preferences", async (t) => {
  const { backend, selectedProject, otherProject, userData } =
    await createBackend(t);
  await assert.rejects(
    backend.savePreferences({ theme: "dark", recentProjects: [otherProject] }),
    /Choose a project folder/,
  );
  assert.equal(await backend.chooseProject(), selectedProject);
  const saved = await backend.savePreferences({
    theme: "dark",
    recentProjects: [selectedProject],
  });
  assert.deepEqual(saved, { theme: "dark", recentProjects: [selectedProject] });
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(userData, "preferences.json"), "utf8"),
    ),
    saved,
  );
  assert.deepEqual(await backend.readPreferences(), saved);
});

test("project picker canonicalizes a directory junction before session authorization", async (t) => {
  let pickedPath;
  const servers = [];
  const { backend, root, selectedProject } = await createBackend(t, {
    dialog: {
      showOpenDialog: async () => ({
        canceled: false,
        filePaths: [pickedPath],
      }),
    },
    spawnProcess: () => {
      const server = new FakeAppServer();
      servers.push(server);
      return server;
    },
  });
  const junction = path.join(root, "project-alias");
  try {
    await fs.symlink(selectedProject, junction, "junction");
  } catch (error) {
    if (["EACCES", "EPERM", "ENOTSUP", "UNKNOWN"].includes(error?.code)) {
      t.skip(`Directory junctions are unavailable (${error.code})`);
      return;
    }
    throw error;
  }
  pickedPath = junction;

  assert.notEqual(junction, selectedProject);
  assert.equal(await fs.realpath(junction), selectedProject);
  const chosenProject = await backend.chooseProject();
  assert.equal(chosenProject, selectedProject);

  await backend.request("session/start", {
    agentConfig: { cwd: chosenProject },
  });
  const startRequest = servers[0].requests.find(
    (request) => request.method === "session/start",
  );
  assert.equal(startRequest.params.agentConfig.cwd, selectedProject);
  await assert.rejects(
    backend.request("session/start", {
      agentConfig: { cwd: junction },
    }),
    /Project path must be an existing selected folder/,
  );
});

test("connect serializes concurrent handshakes and creates a new user-data directory before spawn", async (t) => {
  const root = await createTempRoot("vibe-desktop-connect-test-");
  const userData = path.join(root, "not-created-yet");
  const childProcesses = [];
  const app = {
    getVersion: () => "0.1.0-test",
    getAppPath: () => root,
    getPath: (name) => (name === "userData" ? userData : root),
  };
  const backend = new VibeBackend({
    app,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    spawnProcess: (command, args, options) => {
      assert.equal(command, "vibe-app-server.exe");
      assert.equal(fsSyncExists(options.cwd), true);
      const child = new FakeAppServer();
      childProcesses.push(child);
      return child;
    },
  });
  t.after(async () => {
    await backend.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });

  const [first, second] = await Promise.all([
    backend.connect(),
    backend.connect(),
  ]);
  assert.deepEqual(first, second);
  assert.equal(childProcesses.length, 1);
  assert.equal(
    childProcesses[0].requests.filter(
      (request) => request.method === "initialize",
    ).length,
    1,
  );
});

test("approval, denial, and user-question callback outputs use the upstream callback/result contract", async (t) => {
  const servers = [];
  const { backend, selectedProject } = await createBackend(t, {
    spawnProcess: () => {
      const child = new FakeAppServer();
      servers.push(child);
      return child;
    },
  });
  await backend.chooseProject();
  const started = await backend.request("session/start", {
    agentConfig: { cwd: selectedProject },
  });
  const sessionId = started.state.session.id;
  const server = servers[0];

  const approval = await deliverCallback(
    backend,
    server,
    "approval-allow",
    sessionId,
    "approval",
  );
  assert.equal(approval.result.callbackId, "approval-allow");
  await backend.request("callback/result", {
    sessionId,
    result: {
      callbackId: "approval-allow",
      output: { type: "approval", decision: { type: "approve" } },
    },
  });

  await deliverCallback(
    backend,
    server,
    "approval-deny",
    sessionId,
    "approval",
  );
  await backend.request("callback/result", {
    sessionId,
    result: {
      callbackId: "approval-deny",
      output: {
        type: "approval",
        decision: { type: "deny" },
        feedback: "Keep the workspace unchanged.",
      },
    },
  });

  await deliverCallback(backend, server, "question-1", sessionId, "user_input");
  await backend.request("callback/result", {
    sessionId,
    result: {
      callbackId: "question-1",
      output: {
        type: "user_input",
        result: {
          answers: [{ question: "Which option?", answer: "A", isOther: false }],
          cancelled: false,
        },
      },
    },
  });

  const results = server.requests.filter(
    (request) => request.method === "callback/result",
  );
  assert.deepEqual(
    results.map((request) => request.params.result.output.type),
    ["approval", "approval", "user_input"],
  );
  assert.deepEqual(
    results.map((request) => request.params.result.output.decision?.type),
    ["approve", "deny", undefined],
  );
  await assert.rejects(
    backend.request("callback/result", {
      sessionId,
      result: {
        callbackId: "unknown",
        output: { type: "approval", decision: { type: "approve" } },
      },
    }),
    /no longer pending/,
  );
  await deliverCallback(
    backend,
    server,
    "stale-after-exit",
    sessionId,
    "approval",
  );
  server.kill();
  await assert.rejects(
    backend.request("callback/result", {
      sessionId,
      result: {
        callbackId: "stale-after-exit",
        output: { type: "approval", decision: { type: "approve" } },
      },
    }),
    /no longer pending/,
  );
  assert.equal(
    servers.length,
    1,
    "a rejected stale callback does not relaunch the sidecar",
  );
});

test("active turn blocks a session switch until interrupt completion, then restarts and resumes sessions", async (t) => {
  const servers = [];
  const { backend, selectedProject, otherProject } = await createBackend(t, {
    spawnProcess: () => {
      const child = new FakeAppServer();
      servers.push(child);
      return child;
    },
  });
  await backend.chooseProject();
  // Authorize a second root through the same explicit project-picker boundary.
  const chooseProject = backend.dialog.showOpenDialog;
  backend.dialog.showOpenDialog = async () => ({
    canceled: false,
    filePaths: [otherProject],
  });
  await backend.chooseProject();
  backend.dialog.showOpenDialog = chooseProject;

  const first = await backend.request("session/start", {
    agentConfig: { cwd: selectedProject },
  });
  const sessionId = first.state.session.id;
  const turn = await backend.request("turn/start", {
    sessionId,
    message: [{ type: "text", text: "Hold until interrupted." }],
  });
  await assert.rejects(
    backend.request("session/start", { agentConfig: { cwd: otherProject } }),
    /Interrupt or wait for the active turn/,
  );
  await backend.request("turn/interrupt", {
    sessionId,
    expectedTurnId: turn.turn.id,
  });
  servers[0].notify("turn/completed", {
    sessionId,
    turn: { id: turn.turn.id, status: "interrupted" },
  });
  await until(() => backend.activeTurnId === null);

  const second = await backend.request("session/start", {
    agentConfig: { cwd: otherProject },
  });
  assert.notEqual(second.state.session.id, sessionId);
  assert.equal(servers.length, 2);
  await backend.request("session/stop", { sessionId: second.state.session.id });
  const resumed = await backend.request("session/resume", { sessionId });
  assert.equal(resumed.state.session.id, sessionId);
  assert.equal(servers.length, 3);
});

test("session start cannot opt into auto-approve or use an unselected cwd", async (t) => {
  const { backend, selectedProject } = await createBackend(t);
  await assert.rejects(
    backend.request("session/start", {
      agentConfig: { cwd: selectedProject, autoApprove: true },
    }),
    /unsupported field: autoApprove/,
  );
  await assert.rejects(
    backend.request("session/start", {
      agentConfig: { cwd: "C:\\outside", agent: "default" },
    }),
    /existing selected folder/,
  );
  await assert.rejects(
    backend.request("server/execute", {}),
    /Unsupported Vibe method/,
  );
  await assert.rejects(
    backend.request("review/turnDiff", {
      sessionId: "s1",
      path: "README.md",
      owner: { kind: "agent", turnId: -1 },
    }),
    /non-negative integer/,
  );
  await assert.rejects(
    backend.request("workspace/trust/decision", {
      sessionId: "s1",
      decision: "approve_all",
    }),
    /Unsupported workspace trust decision/,
  );
  await assert.rejects(
    backend.request("workspace/trust/decision", {
      sessionId: "s1",
      decision: "trust_session",
    }),
    /Unsupported workspace trust decision/,
  );
});

test("external navigation only permits official Mistral HTTPS hosts", async (t) => {
  const { backend } = await createBackend(t);
  const opened = [];
  const shell = { openExternal: async (url) => opened.push(url) };
  await backend.openExternal("https://docs.mistral.ai/vibe", shell);
  await backend.openExternal(
    "https://github.com/maikolsiragusaa/mistral-vibe-desktop",
    shell,
  );
  assert.equal(opened[0], "https://docs.mistral.ai/vibe");
  assert.equal(
    opened[1],
    "https://github.com/maikolsiragusaa/mistral-vibe-desktop",
  );
  await assert.rejects(
    backend.openExternal("https://mistral.ai.attacker.example/", shell),
    /Only official/,
  );
  await assert.rejects(
    backend.openExternal("http://mistral.ai/", shell),
    /Only official/,
  );
  await assert.rejects(
    backend.openExternal("https://user@mistral.ai/", shell),
    /Only official/,
  );
  await assert.rejects(
    backend.openExternal("https://github.com/attacker/repo", shell),
    /Only official/,
  );
  assert.equal(opened.length, 2);
});

test(
  "real Vibe app-server streams a turn against the loopback fixture without paid credentials",
  {
    timeout: 120_000,
  },
  async (t) => {
    const python =
      process.env.VIBE_TEST_PYTHON ??
      path.join(repoRoot, ".runtime", "venv", "Scripts", "python.exe");
    const serverExecutable =
      process.env.VIBE_APP_SERVER_FOR_TEST ??
      process.env.VIBE_APP_SERVER ??
      path.join(repoRoot, ".runtime", "venv", "Scripts", "vibe-app-server.exe");
    if (!(await exists(python)) || !(await exists(serverExecutable))) {
      t.skip(
        "The pinned Windows Vibe runtime is not installed in this checkout",
      );
      return;
    }

    const root = await createTempRoot("vibe-desktop-e2e-");
    const userData = path.join(root, "app-data");
    const vibeHome = path.join(root, "vibe-home");
    const workspace = path.join(root, "workspace");
    const freshWorkspace = path.join(root, "fresh-workspace");
    await Promise.all([
      fs.mkdir(userData),
      fs.mkdir(vibeHome),
      fs.mkdir(workspace),
      fs.mkdir(freshWorkspace),
    ]);
    for (const project of [workspace, freshWorkspace]) {
      await fs.mkdir(path.join(project, ".vibe"));
      await fs.writeFile(
        path.join(project, ".vibe", "config.toml"),
        'default_agent = "plan"\n',
        "utf8",
      );
    }
    const fixture = spawn(
      python,
      [path.join(repoRoot, "scripts", "test-provider.py")],
      {
        windowsHide: true,
        shell: false,
        env: { ...process.env, TEST_PROVIDER_DELAY_SECONDS: "1.5" },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let stdout = "";
    const fixtureReady = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Loopback model fixture did not start")),
        10_000,
      );
      fixture.stdout.setEncoding("utf8");
      fixture.stdout.on("data", (chunk) => {
        stdout += chunk;
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(stdout.slice(0, newline)));
        } catch {
          reject(new Error("Loopback fixture returned invalid startup data"));
        }
      });
      fixture.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Loopback model fixture could not start"));
      });
      fixture.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Loopback model fixture exited before startup"));
      });
    });

    let backend;
    try {
      const { url: apiBase } = await fixtureReady;
      const config = [
        'active_model = "fixture-model"',
        'theme = "dark"',
        'default_agent = "accept-edits"',
        "include_project_context = false",
        "enable_update_checks = false",
        "enable_telemetry = false",
        "enable_otel = false",
        "[experiments]",
        "enable = false",
        "[[providers]]",
        'name = "fixture"',
        `api_base = "${apiBase}"`,
        'api_key_env_var = "TEST_FAKE_API_KEY"',
        'api_style = "openai"',
        "[[models]]",
        'name = "fixture-model"',
        'provider = "fixture"',
        'alias = "fixture-model"',
        'thinking = "off"',
        "",
      ].join("\n");
      await fs.writeFile(path.join(vibeHome, "config.toml"), config, "utf8");
      const app = {
        getVersion: () => "0.1.0-test",
        getAppPath: () => repoRoot,
        getPath: (name) => (name === "userData" ? userData : root),
      };
      let selectedProject = workspace;
      backend = new VibeBackend({
        app,
        dialog: {
          showOpenDialog: async () => ({
            canceled: false,
            filePaths: [selectedProject],
          }),
        },
        env: {
          ...process.env,
          VIBE_APP_SERVER: serverExecutable,
          VIBE_HOME: vibeHome,
          TEST_FAKE_API_KEY: "no-billing-fixture-key",
          MISTRAL_API_KEY: "",
          DO_NOT_TRACK: "1",
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
        },
      });
      await backend.chooseProject();
      const connected = await backend.connect();
      assert.equal(connected.serverInfo?.name, "vibe-app-server");
      assert.equal(connected.serverInfo?.version, "2.26.1");
      const listed = await backend.request("session/list", {
        cwd: workspace,
        limit: 10,
      });
      assert.ok(Array.isArray(listed.items));
      const trust = await backend.request("workspace/trust/status", {
        cwd: workspace,
      });
      assert.equal(trust.status, "untrusted");
      assert.ok(trust.details?.availableDecisions.includes("trust_cwd"));

      const opened = await backend.request("session/start", {
        agentConfig: { cwd: workspace },
      });
      const sessionId = opened?.state?.session?.id;
      assert.equal(typeof sessionId, "string");
      const untrustedRuntime = await backend.request("runtime/read", {
        sessionId,
      });
      assert.equal(
        untrustedRuntime.runtime.config.defaultAgent,
        "accept-edits",
      );
      const untrustedTurnCompleted = waitForEvent(
        backend,
        (event) => event.method === "turn/completed",
        60_000,
      );
      await backend.request("turn/start", {
        sessionId,
        message: [{ type: "text", text: "Check the current project setup." }],
      });
      await untrustedTurnCompleted;
      await backend.request("session/stop", { sessionId });
      const resumedBeforeTrust = await backend.request("session/resume", {
        sessionId,
      });
      assert.equal(resumedBeforeTrust.state.session.id, sessionId);
      const resumedRuntime = await backend.request("runtime/read", {
        sessionId,
      });
      assert.equal(resumedRuntime.runtime.config.defaultAgent, "accept-edits");
      const trustDecision = await backend.request("workspace/trust/decision", {
        sessionId,
        cwd: workspace,
        decision: "trust_cwd",
      });
      assert.equal(trustDecision.status, "trusted");
      const runtimeBeforeTrustReload = await backend.request("runtime/read", {
        sessionId,
      });
      assert.equal(
        runtimeBeforeTrustReload.runtime.config.defaultAgent,
        "accept-edits",
      );
      await backend.request("session/stop", { sessionId });
      const resumedAfterTrust = await backend.request("session/resume", {
        sessionId,
      });
      assert.equal(resumedAfterTrust.state.session.id, sessionId);
      const trustedRuntime = await backend.request("runtime/read", {
        sessionId,
      });
      assert.equal(trustedRuntime.runtime.config.defaultAgent, "plan");
      const startedEvent = waitForEvent(
        backend,
        (event) => event.method === "turn/started",
        30_000,
      );
      const interruptedTurn = await backend.request("turn/start", {
        sessionId,
        message: [
          { type: "text", text: "Wait for cancellation before responding." },
        ],
      });
      await startedEvent;
      const interrupted = waitForEvent(
        backend,
        (event) =>
          event.method === "turn/completed" &&
          event.params.turn.id === interruptedTurn.turn.id,
        30_000,
      );
      await backend.request("turn/interrupt", {
        sessionId,
        expectedTurnId: interruptedTurn.turn.id,
      });
      const interruptedEvent = await interrupted;
      assert.equal(interruptedEvent.params.turn.status, "interrupted");

      await backend.request("session/stop", { sessionId });
      const resumed = await backend.request("session/resume", { sessionId });
      assert.equal(resumed?.state?.session?.id, sessionId);

      const completion = waitForEvent(
        backend,
        (event) => event.method === "turn/completed",
        60_000,
      );
      await backend.request("turn/start", {
        sessionId,
        message: [{ type: "text", text: "Reply with a short greeting." }],
      });
      await completion;
      const read = await backend.request("session/read", { sessionId });
      assert.match(JSON.stringify(read.state), /Local fixture response\./);

      // Vibe does not persist an empty session when it is stopped. After the
      // user trusts the project, a fresh session (rather than resume of that
      // empty id) is required to load project-level configuration.
      selectedProject = freshWorkspace;
      assert.equal(await backend.chooseProject(), freshWorkspace);
      const emptyTrust = await backend.request("workspace/trust/status", {
        cwd: freshWorkspace,
      });
      assert.equal(emptyTrust.status, "untrusted");
      const emptySession = await backend.request("session/start", {
        agentConfig: { cwd: freshWorkspace },
      });
      const emptySessionId = emptySession.state.session.id;
      const emptyRuntime = await backend.request("runtime/read", {
        sessionId: emptySessionId,
      });
      assert.equal(emptyRuntime.runtime.config.defaultAgent, "accept-edits");
      const emptyTrustDecision = await backend.request(
        "workspace/trust/decision",
        {
          sessionId: emptySessionId,
          cwd: freshWorkspace,
          decision: "trust_cwd",
        },
      );
      assert.equal(emptyTrustDecision.status, "trusted");
      await backend.request("session/stop", { sessionId: emptySessionId });
      const freshSession = await backend.request("session/start", {
        agentConfig: { cwd: freshWorkspace },
      });
      const freshSessionId = freshSession.state.session.id;
      assert.notEqual(freshSessionId, emptySessionId);
      const freshRuntime = await backend.request("runtime/read", {
        sessionId: freshSessionId,
      });
      assert.equal(freshRuntime.runtime.config.defaultAgent, "plan");
      const health = await fetch(apiBase.replace(/\/v1$/, "/health")).then(
        (response) => response.json(),
      );
      assert.ok(
        health.requests >= 1,
        "the configured provider fixture handled a model request",
      );
      await backend.request("session/stop", { sessionId: freshSessionId });
    } finally {
      if (backend) await backend.shutdown();
      try {
        fixture.kill();
      } catch {}
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "real Vibe app-server asks before writing, records the effect, and confirms Unified review methods are unavailable",
  {
    timeout: 120_000,
  },
  async (t) => {
    const python =
      process.env.VIBE_TEST_PYTHON ??
      path.join(repoRoot, ".runtime", "venv", "Scripts", "python.exe");
    const serverExecutable =
      process.env.VIBE_APP_SERVER_FOR_TEST ??
      process.env.VIBE_APP_SERVER ??
      path.join(repoRoot, ".runtime", "venv", "Scripts", "vibe-app-server.exe");
    if (!(await exists(python)) || !(await exists(serverExecutable))) {
      t.skip(
        "The pinned Windows Vibe runtime is not installed in this checkout",
      );
      return;
    }

    const root = await createTempRoot("vibe-desktop-tool-e2e-");
    const userData = path.join(root, "app-data");
    const vibeHome = path.join(root, "vibe-home");
    const workspace = path.join(root, "workspace");
    const targetPath = path.join(workspace, "fixture.txt");
    const targetContent = "Written by the isolated Vibe fixture.\n";
    await Promise.all([
      fs.mkdir(userData),
      fs.mkdir(vibeHome),
      fs.mkdir(workspace),
    ]);
    await fs.mkdir(path.join(workspace, ".vibe"));
    await fs.writeFile(
      path.join(workspace, ".vibe", "config.toml"),
      'default_agent = "ask"\n',
      "utf8",
    );

    const fixture = spawn(
      python,
      [path.join(repoRoot, "scripts", "test-provider.py")],
      {
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          TEST_PROVIDER_TOOL_SCENARIO: "1",
          TEST_PROVIDER_WRITE_PATH: targetPath,
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let stdout = "";
    const fixtureReady = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Loopback model fixture did not start")),
        10_000,
      );
      fixture.stdout.setEncoding("utf8");
      fixture.stdout.on("data", (chunk) => {
        stdout += chunk;
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(stdout.slice(0, newline)));
        } catch {
          reject(new Error("Loopback fixture returned invalid startup data"));
        }
      });
      fixture.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Loopback model fixture could not start"));
      });
      fixture.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Loopback model fixture exited before startup"));
      });
    });

    let backend;
    try {
      const { url: apiBase } = await fixtureReady;
      const config = [
        'active_model = "fixture-model"',
        'theme = "dark"',
        'default_agent = "ask"',
        "include_project_context = false",
        "enable_update_checks = false",
        "enable_telemetry = false",
        "enable_otel = false",
        "[experiments]",
        "enable = false",
        "[[providers]]",
        'name = "fixture"',
        `api_base = "${apiBase}"`,
        'api_key_env_var = "TEST_FAKE_API_KEY"',
        'api_style = "openai"',
        "[[models]]",
        'name = "fixture-model"',
        'provider = "fixture"',
        'alias = "fixture-model"',
        'thinking = "off"',
        "",
      ].join("\n");
      await fs.writeFile(path.join(vibeHome, "config.toml"), config, "utf8");
      const app = {
        getVersion: () => "0.1.0-test",
        getAppPath: () => repoRoot,
        getPath: (name) => (name === "userData" ? userData : root),
      };
      backend = new VibeBackend({
        app,
        dialog: {
          showOpenDialog: async () => ({
            canceled: false,
            filePaths: [workspace],
          }),
        },
        env: {
          ...process.env,
          VIBE_APP_SERVER: serverExecutable,
          VIBE_HOME: vibeHome,
          TEST_FAKE_API_KEY: "no-billing-fixture-key",
          MISTRAL_API_KEY: "",
          DO_NOT_TRACK: "1",
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
        },
      });
      await backend.chooseProject();
      const connected = await backend.connect();
      assert.equal(connected.serverInfo?.version, "2.26.1");

      // Trust the temporary project through Vibe's real protocol, then open a
      // fresh session so the project configuration is loaded by the engine.
      const untrusted = await backend.request("session/start", {
        agentConfig: { cwd: workspace },
      });
      const untrustedSessionId = untrusted.state.session.id;
      const trustStatus = await backend.request("workspace/trust/status", {
        cwd: workspace,
      });
      if (trustStatus.status === "untrusted") {
        await backend.request("workspace/trust/decision", {
          sessionId: untrustedSessionId,
          cwd: workspace,
          decision: "trust_cwd",
        });
      }
      await backend.request("session/stop", { sessionId: untrustedSessionId });
      const opened = await backend.request("session/start", {
        agentConfig: { cwd: workspace, agent: "ask" },
      });
      const sessionId = opened.state.session.id;
      assert.equal(await exists(targetPath), false);

      const approvalEvent = waitForEvent(
        backend,
        (event) =>
          event.method === "callback/call" &&
          event.params.callback?.detail?.kind === "approval",
        60_000,
      );
      const started = await backend.request("turn/start", {
        sessionId,
        message: [
          {
            type: "text",
            text: "Create fixture.txt in this workspace with the exact isolated fixture content.",
          },
        ],
      });
      const approval = await approvalEvent;
      const callback = approval.params.callback;
      assert.equal(approval.params.sessionId ?? callback.sessionId, sessionId);
      assert.equal(callback.detail.kind, "approval");
      assert.ok(
        ["write_file", "file_system.write_file"].includes(
          callback.detail.effect.toolName,
        ),
      );
      assert.equal(callback.detail.effect.input.filePath, targetPath);
      assert.ok(callback.detail.choices.includes("approve"));
      assert.equal(await exists(targetPath), false);

      const completionEvent = waitForEvent(
        backend,
        (event) =>
          event.method === "turn/completed" &&
          event.params.turn?.id === started.turn.id,
        60_000,
      );
      const response = await backend.request("callback/result", {
        sessionId,
        result: {
          callbackId: callback.callbackId,
          output: { type: "approval", decision: { type: "approve" } },
        },
      });
      assert.equal(response.accepted, true);
      const completed = await completionEvent;
      assert.equal(completed.params.turn.status, "completed");
      assert.equal(await fs.readFile(targetPath, "utf8"), targetContent);

      const read = await backend.request("session/read", { sessionId });
      const writeEffect = read.state.history.find(
        (entry) =>
          entry.type === "effect" &&
          entry.detail?.kind === "file_write" &&
          JSON.stringify(entry.detail).includes("fixture.txt"),
      );
      assert.ok(writeEffect, "the written file appears as a history effect");
      assert.equal(writeEffect.state.status, "completed");

      // This wheel's default Unified Harness returns method-not-found here.
      // The pinned source wires these review procedures only in its legacy
      // CoreRequestHandler; there is no Unified replacement to emulate.
      await assert.rejects(
        backend.request("review/state", { sessionId }),
        /Method not found: review\/state/,
      );
      await assert.rejects(
        backend.request("review/turnDiff", {
          sessionId,
          path: targetPath,
          owner: { kind: "agent", turnId: 0 },
        }),
        /Method not found: review\/turnDiff/,
      );
      const health = await fetch(apiBase.replace(/\/v1$/, "/health")).then(
        (healthResponse) => healthResponse.json(),
      );
      assert.ok(health.requests >= 2);
      await backend.request("session/stop", { sessionId });
    } finally {
      if (backend) await backend.shutdown();
      try {
        fixture.kill();
      } catch {}
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createTempRoot(prefix) {
  const tempPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return fs.realpath(tempPath);
}

async function deliverCallback(backend, server, callbackId, sessionId, kind) {
  const delivered = waitForEvent(
    backend,
    (event) =>
      event.method === "callback/call" &&
      event.params.callback.callbackId === callbackId,
    2_000,
  );
  server.callback(callbackId, sessionId, kind);
  await delivered;
  await until(() =>
    server.responses.some(
      (response) => response.id === `callback-${callbackId}`,
    ),
  );
  return server.responses.find(
    (response) => response.id === `callback-${callbackId}`,
  );
}

function fsSyncExists(filePath) {
  return existsSync(filePath);
}

class FakeAppServer extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.killed = false;
    this.requests = [];
    this.responses = [];
    let input = "";
    this.stdin.on("data", (chunk) => {
      input += chunk.toString("utf8");
      while (input.includes("\n")) {
        const newline = input.indexOf("\n");
        const frame = input.slice(0, newline);
        input = input.slice(newline + 1);
        if (!frame) continue;
        const message = JSON.parse(frame);
        if (!Object.hasOwn(message, "method")) {
          this.responses.push(message);
          continue;
        }
        this.requests.push(message);
        if (!Object.hasOwn(message, "id")) continue;
        const result = this.#result(message.method, message.params);
        const response = { jsonrpc: "2.0", id: message.id, result };
        this.responses.push(response);
        this.stdout.write(`${JSON.stringify(response)}\n`);
      }
    });
    this.stdin.once("finish", () => this.kill());
  }

  #result(method, params = {}) {
    if (method === "initialize")
      return { serverInfo: { name: "vibe-app-server", version: "2.26.1" } };
    if (method === "setup/status") return { hasApiKey: false };
    if (method === "session/start" || method === "session/resume") {
      const id =
        method === "session/resume"
          ? params.sessionId
          : `session-${path.basename(params.agentConfig.cwd)}`;
      return {
        state: {
          session: { id, cwd: params.agentConfig?.cwd ?? "C:\\project" },
        },
      };
    }
    if (method === "turn/start")
      return {
        turn: {
          id: `turn-${this.requests.length}`,
          sessionId: params.sessionId,
          status: "in_progress",
        },
      };
    if (method === "turn/interrupt") return { accepted: true };
    if (method === "session/stop") return { stopped: true };
    if (method === "callback/result") return { accepted: true };
    return {};
  }

  notify(method, params) {
    this.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  callback(callbackId, sessionId, kind) {
    const detail =
      kind === "approval"
        ? { kind, choices: ["approve", "deny"], pathScopeChoices: [] }
        : {
            kind,
            request: {
              questions: [
                {
                  question: "Which option?",
                  options: [{ label: "A" }, { label: "B" }],
                },
              ],
            },
          };
    this.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: `callback-${callbackId}`,
        method: "callback/call",
        params: { callback: { callbackId, sessionId, detail } },
      })}\n`,
    );
  }

  kill() {
    if (this.exitCode !== null) return false;
    this.killed = true;
    this.exitCode = 1;
    this.emit("exit", 1, null);
    return true;
  }
}

function waitForEvent(backend, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("Timed out waiting for Vibe event")),
      timeoutMs,
    );
    const listener = (event) => {
      if (predicate(event)) finish(null, event);
    };
    const finish = (error, value) => {
      clearTimeout(timer);
      backend.off("event", listener);
      if (error) reject(error);
      else resolve(value);
    };
    backend.on("event", listener);
  });
}

async function until(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error("Timed out waiting for the test condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
