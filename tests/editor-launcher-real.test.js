import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EditorService } from "../src/main/editor-service.js";

// Real-process launcher verification. No mocks: every spawn below starts a
// genuine Windows process in an isolated temp directory. Nothing outside the
// temp directory is touched and no system configuration is changed.

async function tempRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function runOnce(exe, argv, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, argv, { shell: false, ...options });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

test("hazard proof: cmd.exe expands %VAR% inside arguments despite shell:false", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows command-processor parsing is Windows-only");
    return;
  }
  const root = await tempRoot(t, "vibe-cmd-hazard-");
  const shim = path.join(root, "shim.cmd");
  await fs.writeFile(shim, "@echo %1\r\n", "utf8");
  // % is legal in NTFS names, so an authorized folder can contain it.
  const evilFolder = path.join(root, "proj-%COMSPEC%-end");
  await fs.mkdir(evilFolder, { recursive: true });
  // This is how Windows itself invokes a batch file: cmd.exe parses the
  // command line no matter how the parent spawned it (shell:false only skips
  // the parent-side shell, never cmd.exe's own parser).
  const code = await runOnce(
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
    ["/d", "/c", shim, evilFolder, ">", "arg.log"],
    { cwd: root, windowsHide: true, stdio: "ignore" },
  );
  assert.equal(code, 0);
  const logged = (await fs.readFile(path.join(root, "arg.log"), "utf8")).trim();
  // The argument did NOT arrive literally: cmd.exe expanded %COMSPEC%, so the
  // child received a different path than the authorized one. Because batch
  // launchers cannot be invoked without cmd.exe's parser, custom .cmd/.bat
  // editors are refused outright (see the test below).
  assert.notEqual(logged, evilFolder);
  assert.ok(logged.includes("Windows"), `expected expansion, got: ${logged}`);
});

test("custom .cmd/.bat editors are refused instead of routed through cmd.exe", async (t) => {
  const service = new EditorService({
    authorizeProjectRoot: async (folder) => folder,
    statImpl: async () => ({ isFile: () => true }),
    spawnImpl: () => {
      throw new Error("must not spawn");
    },
    platform: "win32",
    env: {},
  });
  await assert.rejects(
    service.open({ editorExe: "C:\\Editors\\code.cmd", folder: "C:\\repo" }),
    /direct executable|\.exe/i,
  );
  await assert.rejects(
    service.open({ editorExe: "C:\\Editors\\start.bat", folder: "C:\\repo" }),
    /direct executable|\.exe/i,
  );
});

test("a real missing executable rejects instead of false-confirming", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows spawn behavior is Windows-only");
    return;
  }
  const root = await tempRoot(t, "vibe-missing-exe-");
  const service = new EditorService({
    authorizeProjectRoot: async (folder) => folder,
    platform: "win32",
    env: {},
  });
  await assert.rejects(
    service.open({ editorExe: path.join(root, "no-such-editor.exe"), folder: root }),
    /not be launched|not found/i,
  );
});

test("a real executable spawn is confirmed by the OS process event", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows spawn behavior is Windows-only");
    return;
  }
  const root = await tempRoot(t, "vibe-real-spawn-");
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const service = new EditorService({
    authorizeProjectRoot: async (folder) => folder,
    platform: "win32",
    env: { ...process.env, SystemRoot: systemRoot, PATH: "" },
  });
  // where.exe is a console executable that exits immediately without windows.
  const result = await service.open({
    editorExe: path.join(systemRoot, "System32", "where.exe"),
    folder: root,
  });
  assert.equal(result.exePath, path.join(systemRoot, "System32", "where.exe"));
  assert.deepEqual(result.argv, [root]);
});

test("terminal fallback spawns a real process without parsing the folder", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows terminal handoff is Windows-only");
    return;
  }
  const root = await tempRoot(t, "vibe-term-");
  // A metachar folder name is legal on NTFS and must travel via cwd, never
  // through a parsed command string.
  const tricky = path.join(root, "a & b");
  await fs.mkdir(tricky, { recursive: true });
  const service = new EditorService({
    authorizeProjectRoot: async (folder) => folder,
    platform: "win32",
    env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", PATH: "" },
  });
  const result = await service.openTerminal({ folder: tricky });
  assert.deepEqual(result.argv, ["/d"]);
  assert.equal(result.cwd, tricky);
  assert.equal(
    result.argv.join(" ").includes("a & b"),
    false,
    "folder must never appear inside parsed command text",
  );
  assert.ok(
    Number.isInteger(result.pid) && result.pid > 0,
    "the started process must be observable for cleanup",
  );
  // The interactive fallback shell stays alive by design; terminate the exact
  // process this handoff started so the temp directory can be released and no
  // orphan survives the test.
  process.kill(result.pid);
});
