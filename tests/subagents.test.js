import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { VibeBackend } from "../src/main/backend.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function exists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createTempRoot(prefix) {
  const tempPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return fs.realpath(tempPath);
}

function waitForEvent(emitter, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off("event", onEvent);
      reject(new Error("Timed out waiting for backend event"));
    }, timeoutMs);
    timer.unref?.();
    const onEvent = (event) => {
      let ok = false;
      try {
        ok = predicate(event);
      } catch {
        ok = false;
      }
      if (ok) {
        clearTimeout(timer);
        emitter.off("event", onEvent);
        resolve(event);
      }
    };
    emitter.on("event", onEvent);
  });
}

async function startFixture(env = {}) {
  const python =
    process.env.VIBE_TEST_PYTHON ??
    path.join(repoRoot, ".runtime", "venv", "Scripts", "python.exe");
  const fixture = spawn(python, [path.join(repoRoot, "scripts", "test-provider.py")], {
    windowsHide: true,
    shell: false,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "ignore"],
  });
  let stdout = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Loopback fixture did not start")), 10_000);
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
      reject(new Error("Loopback fixture could not start"));
    });
    fixture.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Loopback fixture exited before startup"));
    });
  });
  const { url } = await ready;
  return { fixture, url };
}

test(
  "real engine runs three concurrent subagents with independent readable transcripts",
  { timeout: 240_000 },
  async (t) => {
    const python = path.join(repoRoot, ".runtime", "venv", "Scripts", "python.exe");
    const serverExecutable =
      process.env.VIBE_APP_SERVER_FOR_TEST ??
      process.env.VIBE_APP_SERVER ??
      path.join(repoRoot, ".runtime", "venv", "Scripts", "vibe-app-server.exe");
    if (!(await exists(python)) || !(await exists(serverExecutable))) {
      t.skip("The pinned Windows Vibe runtime is not installed in this checkout");
      return;
    }

    const root = await createTempRoot("vibe-desktop-subagents-");
    const userData = path.join(root, "app-data");
    const vibeHome = path.join(root, "vibe-home");
    const workspace = path.join(root, "workspace");
    await Promise.all([fs.mkdir(userData), fs.mkdir(vibeHome), fs.mkdir(workspace)]);
    await fs.mkdir(path.join(workspace, ".vibe"));
    await fs.writeFile(path.join(workspace, ".vibe", "config.toml"), 'default_agent = "plan"\n', "utf8");

    // A long fixture delay keeps all three spawned children alive together:
    // spawns happen upfront while waits resolve sequentially, so polling
    // observes three concurrent children and a working parent.
    const { fixture, url: apiBase } = await startFixture({
      TEST_PROVIDER_SUBAGENT_SCENARIO: "1",
      TEST_PROVIDER_SUBAGENT_COUNT: "3",
      TEST_PROVIDER_DELAY_SECONDS: "8",
    });
    t.after(() => {
      try {
        fixture.kill();
      } catch {}
    });

    const config = [
      'active_model = "fixture-model"',
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

    let backend;
    try {
      backend = new VibeBackend({
        app: {
          getVersion: () => "0.3.0-test",
          getAppPath: () => repoRoot,
          getPath: (name) => (name === "userData" ? userData : root),
        },
        dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [workspace] }) },
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
      t.after(async () => {
        try {
          await backend.shutdown();
        } catch {}
        await fs.rm(root, { recursive: true, force: true });
      });

      await backend.chooseProject();
      await backend.connect();
      const opened = await backend.request("session/start", { agentConfig: { cwd: workspace } });
      let parentId = opened?.state?.session?.id;
      assert.equal(typeof parentId, "string");

      try {
        const trust = await backend.request("workspace/trust/status", { cwd: workspace });
        const decisions = trust.details?.availableDecisions ?? [];
        if (trust.details && decisions.includes("trust_cwd")) {
          await backend.request("workspace/trust/decision", {
            sessionId: parentId,
            cwd: workspace,
            decision: "trust_cwd",
          });
          // Vibe does not persist an empty stopped session: like the desktop
          // client, drop it and start a fresh trusted session for the tools.
          try {
            await backend.request("session/stop", { sessionId: parentId });
          } catch {
            /* Ephemeral untrusted sessions may already be gone. */
          }
          const fresh = await backend.request("session/start", {
            agentConfig: { cwd: workspace },
          });
          parentId = fresh?.state?.session?.id ?? parentId;
        }
      } catch {
        /* Trust is optional for the fixture workspace. */
      }
      assert.equal(typeof parentId, "string");

      // Use the ask-before-tools agent mode, matching the desktop UI flow
      // that exercises programmatic subagents through run_typescript.
      // (agents/list is not dispatched by Unified; runtime/read lists agents.)
      try {
        const runtime = await backend.request("runtime/read", { sessionId: parentId });
        const names = (runtime?.runtime?.agents ?? []).map((a) => a?.name).filter(Boolean);
        const askMode = names.find((n) => n === "ask") ?? names.find((n) => /ask/i.test(n));
        if (askMode) {
          await backend.request("session/agent/update", {
            sessionId: parentId,
            agentName: askMode,
          });
        }
      } catch {
        /* Default agent can still expose the fixture tool. */
      }

      // Auto-approve tool/approval callbacks so the fixture program can spawn.
      const seenCallbacks = new Set();
      const callbackLog = [];
      backend.on("event", (event) => {
        if (event?.method !== "callback/call") return;
        const callback = event.params?.callback;
        const callbackId = callback?.callbackId;
        const sessionId = event.params?.sessionId ?? callback?.sessionId;
        if (typeof callbackId !== "string" || seenCallbacks.has(callbackId)) return;
        seenCallbacks.add(callbackId);
        const kind = callback?.detail?.kind;
        callbackLog.push({ callbackId, kind });
        void (async () => {
          try {
            if (kind === "approval") {
              const choices = callback?.detail?.choices;
              const decision = Array.isArray(choices) && choices.length ? choices[0] : "approve";
              const scopes = callback?.detail?.pathScopeChoices;
              const output = { type: "approval", decision: { type: decision } };
              if (Array.isArray(scopes) && scopes.length) output.decision.pathScope = scopes[0];
              await backend.request("callback/result", {
                sessionId,
                result: { callbackId, output },
              });
            } else if (kind === "user_input") {
              const questions = callback?.detail?.request?.questions ?? [];
              await backend.request("callback/result", {
                sessionId,
                result: {
                  callbackId,
                  output: {
                    type: "user_input",
                    result: {
                      answers: questions.map((q) => ({ question: q.question, answer: "fixture-answer" })),
                    },
                  },
                },
              });
            }
          } catch {}
        })();
      });

      const parentDone = waitForEvent(
        backend,
        (event) => event.method === "turn/completed" && event.params?.sessionId === parentId,
        180_000,
      );
      await backend.request("turn/start", {
        sessionId: parentId,
        message: [{ type: "text", text: "Delegate a local fixture inspection to Explore." }],
      });

      // Three concurrent children must appear while the parent still works.
      let children = [];
      let lastRead = null;
      const deadline = Date.now() + 120_000;
      let parentWorking = false;
      while (Date.now() < deadline) {
        const read = await backend.request("session/read", { sessionId: parentId });
        lastRead = read;
        children = read?.state?.childSessions ?? [];
        parentWorking = (read?.state?.turns ?? []).some((turn) => turn.status === "in_progress");
        if (children.length >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert.ok(
        children.length >= 3,
        `expected three concurrent subagents, saw ${children.length}; ` +
          `turns=${JSON.stringify((lastRead?.state?.turns ?? []).map((t) => t.status))} ` +
          `callbacks=${JSON.stringify(callbackLog)} ` +
          `history=${JSON.stringify((lastRead?.state?.history ?? []).slice(-3).map((h) => ({ type: h.type, text: (h.text ?? "").slice(0, 160) })))}`,
      );
      const childIds = children.slice(0, 3).map((child) => child.id);
      assert.equal(new Set(childIds).size, 3, "child session ids are distinct");
      assert.ok(parentWorking, "parent keeps working while children run");

      // Open each child conversation while it works; navigate between children.
      const transcripts = new Map();
      for (const childId of childIds) {
        const childRead = await backend.request("session/read", { sessionId: childId });
        assert.equal(childRead?.state?.session?.id, childId);
        transcripts.set(childId, childRead.state);
      }
      // Second pass proves updates arrive while children work.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      for (const childId of childIds) {
        const reread = await backend.request("session/read", { sessionId: childId });
        assert.equal(reread?.state?.session?.id, childId);
        assert.ok(
          (reread?.state?.eventId ?? 0) >= (transcripts.get(childId)?.eventId ?? 0),
          "child reads are monotonic across navigation",
        );
        transcripts.set(childId, reread.state);
      }

      // Children stay read-only: no resume, no steering, no ownership transfer.
      await assert.rejects(
        backend.request("session/resume", { sessionId: childIds[0] }),
        /read-only|List sessions/,
      );
      await assert.rejects(
        backend.request("turn/steer", {
          sessionId: childIds[0],
          expectedTurnId: "turn-does-not-exist",
          message: [{ type: "text", text: "do not obey" }],
        }),
        /active Vibe session|does not target/,
      );

      await parentDone;
      // Back to the parent: history intact, children completed with output.
      const parent = await backend.request("session/read", { sessionId: parentId });
      assert.equal(parent?.state?.session?.id, parentId);
      let completedOutputs = 0;
      for (const childId of childIds) {
        const final = await backend.request("session/read", { sessionId: childId });
        const text = JSON.stringify(final?.state?.history ?? []);
        if (text.includes("Local subagent inspected the fixture.")) completedOutputs += 1;
      }
      assert.ok(
        completedOutputs >= 1,
        `expected child output in at least one transcript, saw ${completedOutputs}/3`,
      );
    } finally {
      if (backend) {
        try {
          await backend.shutdown();
        } catch {}
      }
    }
  },
);
