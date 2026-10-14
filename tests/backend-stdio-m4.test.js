import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PassThrough } from "node:stream";
import { VibeBackend } from "../src/main/backend.js";

class FakeAppServer extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.requests = [];
    let input = "";
    this.stdin.on("data", (chunk) => {
      input += chunk.toString("utf8");
      while (input.includes("\n")) {
        const newline = input.indexOf("\n");
        const frame = input.slice(0, newline);
        input = input.slice(newline + 1);
        if (!frame) continue;
        const message = JSON.parse(frame);
        if (!Object.hasOwn(message, "method") || !Object.hasOwn(message, "id")) continue;
        this.requests.push(message);
        const result = this.#result(message.method, message.params);
        this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      }
    });
  }

  #result(method, params = {}) {
    if (method === "initialize") return { serverInfo: { name: "vibe-app-server", version: "2.26.1" } };
    if (method === "setup/status") return { hasApiKey: false };
    if (method === "session/start") {
      return { state: { session: { id: "stdio-session", cwd: params.agentConfig?.cwd ?? "x" } } };
    }
    return {};
  }

  kill() {}
}

async function createBackend(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-stdio-m4-"));
  const userData = path.join(root, "user-data");
  await fs.mkdir(userData, { recursive: true });
  await fs.mkdir(path.join(root, "project"), { recursive: true });
  // Canonicalize like production dialog callers: CI runners expose TEMP
  // through short 8.3 names (RUNNER~1) while the service keys by realpath.
  const project = await fs.realpath(path.join(root, "project"));
  const app = {
    getVersion: () => "0.0.0-test",
    getAppPath: () => root,
    getPath: (name) => (name === "userData" ? userData : root),
  };
  const backend = new VibeBackend({
    app,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [project] }) },
    spawnProcess: () => new FakeAppServer(),
  });
  t.after(async () => {
    await backend.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  await backend.chooseProject();
  const started = await backend.request("session/start", { agentConfig: { cwd: project } });
  return { backend, sessionId: started.state.session.id };
}

test("config/write accepts a well-formed stdio server without executing it", async (t) => {
  const { backend, sessionId } = await createBackend(t);
  await backend.request("config/write", {
    sessionId,
    ops: [
      {
        op: "set",
        path: "/mcp_servers",
        value: [{ name: "ok-stdio", transport: "stdio", command: "python", args: ["-V"], env: { FOO: "bar" } }],
      },
    ],
  });
  await backend.request("config/write", {
    sessionId,
    ops: [{ op: "set", path: "/mcp_servers/0/disabled", value: true }],
  });
});

test("config/write rejects stdio shell strings, bad names, UNC cwd and mixed shapes", async (t) => {
  const { backend, sessionId } = await createBackend(t);
  await assert.rejects(
    backend.request("config/write", { sessionId, ops: [{ op: "set", path: "/mcp_servers/0/command", value: "x; evil" }] }),
    /shell string/,
  );
  await assert.rejects(
    backend.request("config/write", {
      sessionId,
      ops: [{ op: "set", path: "/mcp_servers", value: [{ name: "bad name!", transport: "stdio", command: "x" }] }],
    }),
    /MCP server name/,
  );
  await assert.rejects(
    backend.request("config/write", {
      sessionId,
      ops: [{ op: "set", path: "/mcp_servers", value: [{ name: "u", transport: "stdio", command: "x", cwd: "\\\\s\\s" }] }],
    }),
    /UNC/,
  );
  await assert.rejects(
    backend.request("config/write", {
      sessionId,
      ops: [{ op: "set", path: "/mcp_servers", value: [{ name: "u", transport: "stdio", url: "https://x/mcp", command: "x" }] }],
    }),
    /URL/,
  );
  await assert.rejects(
    backend.request("config/write", {
      sessionId,
      ops: [{ op: "set", path: "/mcp_servers", value: [{ name: "u", transport: "stdio" }] }],
    }),
    /require a command/,
  );
  await assert.rejects(
    backend.request("config/write", {
      sessionId,
      ops: [{ op: "set", path: "/mcp_servers", value: [{ name: "u", transport: "stdio", command: "x", env: { "1BAD": "v" } }] }],
    }),
    /environment variable/,
  );
});

test("config/write allows token-named env keys only inside mcp_servers env", async (t) => {
  const { backend, sessionId } = await createBackend(t);
  await backend.request("config/write", {
    sessionId,
    ops: [
      {
        op: "set",
        path: "/mcp_servers",
        value: [
          {
            name: "token-env",
            transport: "stdio",
            command: "server.exe",
            env: { GITHUB_TOKEN: "fixture-value", PLAIN: "x" },
          },
        ],
      },
    ],
  });
  await assert.rejects(
    backend.request("config/write", {
      sessionId,
      ops: [{ op: "set", path: "/mcp_servers/0/headers", value: { Authorization: "secret" } }],
    }),
    /not editable/,
  );
  await assert.rejects(
    backend.request("config/write", {
      sessionId,
      ops: [{ op: "set", path: "/providers/0/extra_token", value: "secret" }],
    }),
    /not editable|cannot contain credential/,
  );
});

test("config/write still rejects credential-bearing MCP fields", async (t) => {
  const { backend, sessionId } = await createBackend(t);
  await assert.rejects(
    backend.request("config/write", {
      sessionId,
      ops: [{ op: "set", path: "/mcp_servers/0/headers", value: { Authorization: "secret" } }],
    }),
    /not editable/,
  );
});
