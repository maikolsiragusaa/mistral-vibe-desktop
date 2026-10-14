import assert from "node:assert/strict";
import test from "node:test";
import { EditorService } from "../src/main/editor-service.js";

function fakeStat(existing) {
  const set = new Set(existing);
  return async (p) => {
    if (set.has(p)) return { isFile: () => true };
    const err = new Error("ENOENT");
    err.code = "ENOENT";
    throw err;
  };
}

test("openTerminal falls back to direct cmd with cwd, never a shell string", async () => {
  const calls = [];
  const svc = new EditorService({
    authorizeProjectRoot: async (p) => p,
    statImpl: fakeStat(["C:\\Windows\\System32\\cmd.exe"]),
    spawnImpl: (exe, argv, opts) => {
      calls.push({ exe, argv, opts });
      return { unref() {} };
    },
    platform: "win32",
    env: { PATH: "C:\\nothing", SystemRoot: "C:\\Windows" },
  });
  const result = await svc.openTerminal({ folder: "C:\\repo & evil" });
  assert.equal(result.exePath, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(result.argv, ["/d"]);
  assert.equal(result.cwd, "C:\\repo & evil");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.shell, false);
  // The folder travels via cwd, never inside a parsed command string.
  assert.equal(calls[0].argv.join(" ").includes("repo"), false);
  assert.equal(calls[0].opts.cwd, "C:\\repo & evil");
});

test("openTerminal prefers wt.exe with structured argv", async () => {
  const calls = [];
  const svc = new EditorService({
    authorizeProjectRoot: async (p) => p,
    statImpl: async (p) => {
      if (p === "C:\\tools\\wt.exe" || p === "C:\\Windows\\System32\\cmd.exe")
        return { isFile: () => true };
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    },
    spawnImpl: (exe, argv, opts) => {
      calls.push({ exe, argv, opts });
      return { unref() {} };
    },
    platform: "win32",
    env: { PATH: "C:\\tools", SystemRoot: "C:\\Windows" },
  });
  const result = await svc.openTerminal({ folder: "C:\\repo" });
  assert.equal(result.exePath, "C:\\tools\\wt.exe");
  assert.deepEqual(result.argv, ["-d", "C:\\repo"]);
});

test("open refuses .cmd/.bat launchers instead of routing them through cmd.exe", async () => {
  const calls = [];
  const svc = new EditorService({
    authorizeProjectRoot: async (p) => p,
    statImpl: fakeStat(["C:\\Editors\\code.cmd", "C:\\Windows\\System32\\cmd.exe"]),
    spawnImpl: (exe, argv, opts) => {
      calls.push({ exe, argv, opts });
      return { unref() {} };
    },
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
  });
  // Batch wrappers cannot start without cmd.exe's own parser, which expands
  // %VAR% inside arguments even with shell:false (see editor-launcher-real).
  await assert.rejects(
    svc.open({ editorExe: "C:\\Editors\\code.cmd", folder: "C:\\repo" }),
    /direct \.exe/,
  );
  await assert.rejects(
    svc.open({ editorExe: "C:\\Editors\\start.bat", folder: "C:\\repo" }),
    /direct \.exe/,
  );
  assert.equal(calls.length, 0);
});

test("open surfaces spawn failures instead of false confirmations", async () => {
  const svc = new EditorService({
    authorizeProjectRoot: async (p) => p,
    statImpl: fakeStat(["C:\\Editors\\Code.exe"]),
    spawnImpl: () => {
      throw new Error("ENOENT");
    },
    platform: "win32",
    env: {},
  });
  await assert.rejects(svc.open({ editorExe: "C:\\Editors\\Code.exe", folder: "C:\\repo" }), /could not be launched/);
});

test("folder validation rejects quotes and control characters", async () => {
  const svc = new EditorService({
    authorizeProjectRoot: async (p) => p,
    statImpl: fakeStat(["C:\\Editors\\Code.exe"]),
    spawnImpl: () => ({ unref() {} }),
    platform: "win32",
    env: {},
  });
  await assert.rejects(svc.open({ editorExe: "C:\\Editors\\Code.exe", folder: 'C:\\re"po' }), /invalid/i);
});
