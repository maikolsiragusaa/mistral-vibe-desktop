import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { VibeBackend } from "../src/main/backend.js";
import { McpConfigService } from "../src/main/mcp-config-service.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function pythonProcessesWithMarker(marker) {
  if (process.platform !== "win32") return [];
  const output = await new Promise((resolve) => {
    let text = "";
    const ps = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*" +
          marker +
          "*' } | Select-Object -ExpandProperty ProcessId",
      ],
      { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "ignore"] },
    );
    ps.stdout.on("data", (chunk) => {
      text += chunk.toString("utf8");
    });
    ps.once("error", () => resolve(""));
    ps.once("exit", () => resolve(text));
  });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number);
}

test(
  "real-engine MCP integrity: preservation, secrets, conflicts, layers, orphans",
  { timeout: 180_000 },
  async (t) => {
    const python =
      process.env.VIBE_TEST_PYTHON ??
      path.join(repoRoot, ".runtime", "venv", "Scripts", "python.exe");
    const serverExecutable =
      process.env.VIBE_APP_SERVER_FOR_TEST ??
      process.env.VIBE_APP_SERVER ??
      path.join(repoRoot, ".runtime", "venv", "Scripts", "vibe-app-server.exe");
    if (!existsSync(python) || !existsSync(serverExecutable)) {
      t.skip("The pinned Windows Vibe runtime is not installed in this checkout");
      return;
    }
    const marker = `vibe-m41-${process.pid}`;
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vibe-m41-int-")));
    const userData = path.join(root, "user-data");
    const vibeHome = path.join(root, "vibe-home");
    const workspace = path.join(root, "workspace");
    await Promise.all([fs.mkdir(userData), fs.mkdir(vibeHome), fs.mkdir(workspace)]);
    await fs.writeFile(
      path.join(vibeHome, "config.toml"),
      ["enable_telemetry = false", "enable_update_checks = false", 'active_model = "local"', "[[models]]", 'name = "protocol-test"', 'alias = "local"', 'provider = "llamacpp"', ""].join("\n"),
      "utf8",
    );
    const app = {
      getVersion: () => "0.0.0-test",
      getAppPath: () => repoRoot,
      getPath: (name) => (name === "userData" ? userData : root),
    };
    const backend = new VibeBackend({
      app,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [workspace] }) },
      env: {
        ...process.env,
        VIBE_APP_SERVER: serverExecutable,
        VIBE_HOME: vibeHome,
        MISTRAL_API_KEY: "",
        DO_NOT_TRACK: "1",
      },
    });
    t.after(async () => {
      for (const pid of await pythonProcessesWithMarker(marker)) {
        try {
          process.kill(pid);
        } catch {}
      }
      await backend.shutdown().catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    });
    const request = (method, params) => backend.request(method, params);
    const service = new McpConfigService({ request });

    await backend.chooseProject();
    const started = await request("session/start", { agentConfig: { cwd: workspace } });
    const sessionId = started.state.session.id;

    const readRawList = async () => {
      const fields = await request("config/fields/read", { sessionId });
      const field = fields.fields.find((entry) => entry.name === "mcp_servers");
      const layer = field.layerValues.find((entry) => entry.layer === "user-toml") ??
        field.layerValues.find((entry) => Array.isArray(entry.value));
      return { list: layer.value, layer: layer.layer, targets: fields.targets };
    };

    // 1. Seed A (full options + fixture secret), B (partial), C (HTTP).
    const seedA = {
      name: "m41-a", transport: "stdio", command: python, args: ["-V"], cwd: workspace,
      env: { KEEP_ME: "fixture-secret-1", OTHER: "plain" }, disabled: false, prompt: "seed",
      startup_timeout_sec: 33, tool_timeout_sec: 77, sampling_enabled: false,
      disabled_tools: ["t1", "t2"],
    };
    const seedB = { name: "m41-b", transport: "stdio", command: python, args: ["--version"], disabled: false };
    const seedC = { name: "m41-c", transport: "http", url: "https://example.com/mcp", disabled: false };
    const seedWrite = await request("config/write", {
      sessionId,
      ops: [{ op: "set", path: "/mcp_servers", value: [seedA, seedB, seedC] }],
      reason: "integrity seed",
    });
    assert.equal(seedWrite.rejected ?? false, false);
    let { list: baseline, layer: targetLayer } = await readRawList();
    assert.equal(baseline.length, 3);
    const baselineJson = JSON.stringify(baseline);

    // 2. Add D through the service: neighbors must stay identical.
    const described = await service.describe(sessionId);
    assert.ok(described.servers.every((server) => JSON.stringify(server).includes("fixture-secret-1") === false));
    const added = await service.mutate(sessionId, {
      op: "add",
      name: "m41-d",
      expectedRevision: described.revision,
      entry: { transport: "stdio", command: python, args: ["-V"] },
    });
    assert.equal(added.outcome, "applied-verified");
    let current = (await readRawList()).list;
    assert.equal(current.length, 4);
    assert.deepEqual(current.slice(0, 3), baseline);
    assert.equal(current[3].name, "m41-d");

    // 3. Edit only B's command: A (with secret), C, D must be untouched.
    const described2 = await service.describe(sessionId);
    const edited = await service.mutate(sessionId, {
      op: "set",
      name: "m41-b",
      expectedRevision: described2.revision,
      fields: { args: ["-c", "import sys"] },
    });
    assert.equal(edited.outcome, "applied-verified");
    current = (await readRawList()).list;
    assert.deepEqual(current[0], baseline[0]);
    assert.equal(current[0].env.KEEP_ME, "fixture-secret-1");
    assert.deepEqual(current[1].args, ["-c", "import sys"]);
    assert.deepEqual(current[2], baseline[2]);

    // 4. Disable B: single-field change, neighbors intact.
    const described3 = await service.describe(sessionId);
    const disabled = await service.mutate(sessionId, {
      op: "enable",
      name: "m41-b",
      disabled: true,
      expectedRevision: described3.revision,
    });
    assert.equal(disabled.outcome, "applied-verified");
    current = (await readRawList()).list;
    assert.equal(current[1].disabled, true);
    assert.deepEqual(current[0], baseline[0]);

    // 5. Stale revision must conflict without writing.
    const conflict = await service.mutate(sessionId, {
      op: "enable",
      name: "m41-b",
      disabled: false,
      expectedRevision: "stale-revision",
    });
    assert.equal(conflict.outcome, "conflict");
    current = (await readRawList()).list;
    assert.equal(current[1].disabled, true);

    // 6. Remove B: survivors identical, secret entry intact.
    const described4 = await service.describe(sessionId);
    const removed = await service.mutate(sessionId, {
      op: "remove",
      name: "m41-b",
      expectedRevision: described4.revision,
    });
    assert.equal(removed.outcome, "applied-verified");
    current = (await readRawList()).list;
    assert.ok(current.every((entry) => entry.name !== "m41-b"));
    assert.deepEqual(
      current.find((entry) => entry.name === "m41-a"),
      baseline[0],
    );

    // 7. Unknown field seeded via project file survives service mutations.
    // NOTE: project config requires trust; the grant restarts the runtime,
    // mirroring the production trust flow (decision, stop, open).
    await fs.mkdir(path.join(workspace, ".vibe"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".vibe", "config.toml"),
      ["[[mcp_servers]]", 'name = "m41-proj"', 'transport = "stdio"', `command = "${python.replace(/\\/g, "\\\\")}"`, 'args = ["-V"]', 'mystery_future_field = "keepme"', ""].join("\n"),
      "utf8",
    );
    const trust = await request("workspace/trust/status", { cwd: workspace });
    assert.equal(trust.status, "untrusted");
    await request("workspace/trust/decision", {
      sessionId,
      cwd: workspace,
      decision: "trust_cwd",
    });
    await request("session/stop", { sessionId });
    const reopened = await request("session/start", { agentConfig: { cwd: workspace } });
    const trustedSession = reopened.state.session.id;
    const trustedFields = await request("config/fields/read", { sessionId: trustedSession });
    const trustedMcp = trustedFields.fields.find((entry) => entry.name === "mcp_servers");
    t.diagnostic(`layers after trust: ${JSON.stringify(trustedMcp.layerValues.map((entry) => entry.layer))}`);
    const projLayer = trustedMcp.layerValues.find(
      (entry) => Array.isArray(entry.value) && entry.value.some((item) => item?.name === "m41-proj"),
    );
    assert.ok(projLayer, "project-owned server must be visible after trust");
    const projEntry = projLayer.value.find((item) => item?.name === "m41-proj");
    assert.equal(projEntry?.mystery_future_field, "keepme");
    // The service must refuse to shadow-edit a server owned by a layer it
    // cannot write instead of duplicating it elsewhere.
    const trustedService = new McpConfigService({ request: (method, params) => backend.request(method, params) });
    const projDescribed = await trustedService.describe(trustedSession);
    const shadowAttempt = await trustedService.mutate(trustedSession, {
      op: "enable",
      name: "m41-proj",
      disabled: true,
      expectedRevision: projDescribed.revision,
    });
    if (!trustedFields.targets.includes(projLayer.layer)) {
      assert.equal(shadowAttempt.outcome, "rejected");
      const reread = await request("config/fields/read", { sessionId: trustedSession });
      const again = reread.fields.find((entry) => entry.name === "mcp_servers");
      const names = again.layerValues.flatMap((entry) =>
        Array.isArray(entry.value) ? entry.value.map((item) => item?.name) : [],
      );
      assert.equal(names.filter((name) => name === "m41-proj").length, 1);
    } else {
      t.diagnostic("project layer is writable here; shadow check skipped");
    }

    // 8. Live fixture: real stdio server + slow starter observation + orphans.
    const liveService = new McpConfigService({ request: (method, params) => backend.request(method, params) });
    const liveDescribed = await liveService.describe(trustedSession);
    const liveAdd = await liveService.mutate(trustedSession, {
      op: "add",
      name: "m41-live",
      expectedRevision: liveDescribed.revision,
      entry: { transport: "stdio", command: python, args: [`${root}/x.py`] },
    });
    assert.equal(liveAdd.outcome, "applied-verified");
    // Point the entry at the real fixture via a command-only edit (no env).
    const liveDescribed2 = await liveService.describe(trustedSession);
    const fixtureCopy = path.join(root, `m41-fixture-${process.pid}.py`);
    await fs.copyFile(path.join(repoRoot, "scripts", "test-mcp.py"), fixtureCopy);
    const liveEdit = await liveService.mutate(trustedSession, {
      op: "set",
      name: "m41-live",
      expectedRevision: liveDescribed2.revision,
      fields: { args: [fixtureCopy] },
    });
    assert.equal(liveEdit.outcome, "applied-verified");
    await request("mcp_catalog/refresh", { sessionId: trustedSession }).catch(() => {});
    const runtime = await request("runtime/read", { sessionId: trustedSession });
    const liveSource = runtime.runtime.mcp.sources.find((entry) => entry.name === "m41-live");
    t.diagnostic(`live fixture status: ${liveSource?.status ?? "absent"}, tools: ${liveSource?.tools?.length ?? 0}`);
    assert.ok(liveSource, "live fixture source must be reported (any status, never invented)");
    assert.equal(typeof liveSource.status, "string");
    // Slow starter: exits immediately, must be reported honestly, never as ready.
    const slowDescribed = await liveService.describe(trustedSession);
    const slowAdd = await liveService.mutate(trustedSession, {
      op: "add",
      name: "m41-slow",
      expectedRevision: slowDescribed.revision,
      entry: { transport: "stdio", command: python, args: ["-c", `import sys; sys.exit(0)  # ${marker}`] },
    });
    assert.equal(slowAdd.outcome, "applied-verified");
    await request("mcp_catalog/refresh", { sessionId: trustedSession }).catch(() => {});
    const runtime2 = await request("runtime/read", { sessionId: trustedSession });
    const slowSource = runtime2.runtime.mcp.sources.find((entry) => entry.name === "m41-slow");
    t.diagnostic(`slow starter status: ${slowSource?.status ?? "absent"}`);
    assert.ok(slowSource, "slow starter must be reported (any status)");
    assert.notEqual(slowSource.status, "connected");
    // Cleanup through the service, then verify no fixture processes linger.
    const cleanDescribed = await liveService.describe(trustedSession);
    for (const victim of ["m41-slow", "m41-live"]) {
      const fresh = await liveService.describe(trustedSession);
      const out = await liveService.mutate(trustedSession, {
        op: "remove",
        name: victim,
        expectedRevision: fresh.revision,
      });
      assert.equal(outcomeOf(out), "applied-verified");
    }
    void cleanDescribed;
    await request("session/stop", { sessionId: trustedSession });
    await backend.shutdown();
    const leftovers = await pythonProcessesWithMarker(marker);
    assert.deepEqual(leftovers, [], `orphan fixture processes: ${leftovers.join(",")}`);
    void baselineJson;
  },
);

function outcomeOf(result) {
  return result.outcome;
}
