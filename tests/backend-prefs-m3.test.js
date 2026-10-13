import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VibeBackend } from "../src/main/backend.js";

async function createBackend(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-m3-prefs-"));
  const userData = path.join(root, "user-data");
  await fs.mkdir(userData);
  const selectedProject = path.join(root, "project");
  await fs.mkdir(selectedProject);
  const app = {
    getVersion: () => "0.3.0-test",
    getAppPath: () => root,
    getPath: (name) => (name === "userData" ? userData : root),
  };
  const dialog = {
    showOpenDialog: async () => ({ canceled: false, filePaths: [selectedProject] }),
  };
  const backend = new VibeBackend({ app, dialog });
  t.after(async () => {
    await backend.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { backend, selectedProject };
}

test("M3 prefs persist worktree roots, custom editor and notification toggle", async (t) => {
  const { backend, selectedProject } = await createBackend(t);
  await backend.chooseProject();
  const customRoot = path.join(os.tmpdir(), "vibe-m3-custom");
  await fs.mkdir(customRoot, { recursive: true });
  const saved = await backend.savePreferences({
    theme: "dark",
    recentProjects: [selectedProject],
    worktreeRoots: { [selectedProject]: customRoot },
    customEditorPath: "C:\\Editors\\Code.exe",
    notificationsEnabled: false,
  });
  assert.equal(saved.worktreeRoots[selectedProject], customRoot);
  assert.equal(saved.customEditorPath, "C:\\Editors\\Code.exe");
  assert.equal(saved.notificationsEnabled, false);
  const reloaded = await backend.readPreferences();
  assert.deepEqual(reloaded.worktreeRoots, saved.worktreeRoots);
});

test("M3 prefs refuse UNC roots, shell metachars and non-exe editors", async (t) => {
  const { backend, selectedProject } = await createBackend(t);
  await backend.chooseProject();
  const base = { theme: "dark", recentProjects: [selectedProject] };
  // UNC roots are dropped (never persisted).
  const unc = await backend.savePreferences({
    ...base,
    worktreeRoots: { [selectedProject]: "\\\\server\\share" },
  });
  assert.deepEqual(unc.worktreeRoots ?? {}, {});
  await assert.rejects(
    backend.savePreferences({ ...base, customEditorPath: "C:\\x\\a.exe; evil" }),
    /invalid/,
  );
  await assert.rejects(
    backend.savePreferences({ ...base, customEditorPath: "relative\\code.exe" }),
    /absolute/,
  );
  await assert.rejects(
    backend.savePreferences({ ...base, notificationsEnabled: "yes" }),
    /boolean/,
  );
});
