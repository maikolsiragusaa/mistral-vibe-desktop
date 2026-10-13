import assert from "node:assert/strict";
import test from "node:test";
import { EditorService } from "../src/main/editor-service.js";

function fakeStat(existing) {
  const set = new Set(existing);
  return async (p) => {
    if (set.has(p)) return { isFile: () => true, isDirectory: () => false };
    const err = new Error("ENOENT");
    err.code = "ENOENT";
    throw err;
  };
}

test("detect prefers known paths then PATH without a shell", async () => {
  const svc = new EditorService({
    authorizeProjectRoot: async (p) => p,
    statImpl: fakeStat(["C:\\Program Files\\Microsoft VS Code\\Code.exe"]),
    spawnImpl: () => { throw new Error("no spawn"); },
    platform: "win32",
    env: { PATH: "C:\\tools" },
  });
  const found = await svc.detect();
  const vscode = found.find((e) => e.id === "vscode");
  assert.equal(vscode.exePath, "C:\\Program Files\\Microsoft VS Code\\Code.exe");
  assert.equal(vscode.verified, true);
  const cursor = found.find((e) => e.id === "cursor");
  assert.equal(cursor.verified, false);
});

test("open refuses path injection, UNC and unauthorized folders", async (t) => {
  const calls = [];
  const denying = new EditorService({
    authorizeProjectRoot: async () => { throw new Error("not authorized"); },
    statImpl: fakeStat(["C:\\Editors\\Code.exe"]),
    spawnImpl: (exe, argv, opts) => {
      calls.push({ exe, argv, opts });
      return { unref() {} };
    },
    platform: "win32",
    env: {},
  });
  await assert.rejects(
    denying.open({ editorExe: "C:\\Editors\\Code.exe; rm -rf", folder: "C:\\repo" }),
    /invalid/i,
  );
  await assert.rejects(
    denying.open({ editorExe: "C:\\Editors\\Code.exe", folder: "\\\\server\\share" }),
    /UNC/,
  );
  await assert.rejects(
    denying.open({ editorExe: "C:\\Editors\\Code.exe", folder: "C:\\repo" }),
    /Open this folder/,
  );
  const allowing = new EditorService({
    authorizeProjectRoot: async (p) => p,
    statImpl: fakeStat(["C:\\Editors\\Code.exe"]),
    spawnImpl: (exe, argv, opts) => {
      calls.push({ exe, argv, opts });
      return { unref() {} };
    },
    platform: "win32",
    env: {},
  });
  await assert.rejects(
    allowing.open({ editorExe: "C:\\Editors\\Code.exe", folder: "C:\\repo", file: "../escape" }),
    /inside/,
  );
  await assert.rejects(
    allowing.open({ editorExe: "C:\\Editors\\Code.exe", folder: "C:\\repo", file: "a.ts", line: 0 }),
    /Line/,
  );
  assert.equal(calls.length, 0);
});

test("open uses structured argv and authorizes the folder first", async () => {
  const calls = [];
  const svc = new EditorService({
    authorizeProjectRoot: async (p) => p,
    statImpl: fakeStat(["C:\\Editors\\Code.exe"]),
    spawnImpl: (exe, argv, opts) => {
      calls.push({ exe, argv, opts });
      assert.equal(opts.shell, undefined);
      return { unref() {} };
    },
    platform: "win32",
    env: {},
  });
  const result = await svc.open({
    editorExe: "C:\\Editors\\Code.exe",
    folder: "C:\\repo",
    file: "src/a.ts",
    line: 12,
  });
  assert.equal(result.exePath, "C:\\Editors\\Code.exe");
  assert.deepEqual(result.argv, ["C:\\repo", "--goto", "C:\\repo\\src\\a.ts:12"]);
  assert.equal(calls.length, 1);
});

test("openTerminal is Windows-only and prefers wt when available", async () => {
  const calls = [];
  const svc = new EditorService({
    authorizeProjectRoot: async (p) => p,
    statImpl: fakeStat(["C:\\tools\\wt.exe"]),
    spawnImpl: (exe, argv) => {
      calls.push({ exe, argv });
      return { unref() {} };
    },
    platform: "win32",
    env: { PATH: "C:\\tools", SystemRoot: "C:\\Windows" },
  });
  // PATH lookup joins dir+binary; fake only knows the joined path.
  const svc2 = new EditorService({
    authorizeProjectRoot: async (p) => p,
    statImpl: async (p) => {
      if (p === "C:\\tools\\wt.exe") return { isFile: () => true };
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    },
    spawnImpl: (exe, argv) => {
      calls.push({ exe, argv });
      return { unref() {} };
    },
    platform: "win32",
    env: { PATH: "C:\\tools", SystemRoot: "C:\\Windows" },
  });
  const result = await svc2.openTerminal({ folder: "C:\\repo" });
  assert.equal(result.exePath, "C:\\tools\\wt.exe");
  assert.deepEqual(result.argv, ["-d", "C:\\repo"]);
});
