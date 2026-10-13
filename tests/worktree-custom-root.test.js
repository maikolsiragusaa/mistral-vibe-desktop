import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitWorkspaceService } from "../src/main/git-service.js";

function runGit(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

async function makeRepo(t) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-m3-wt-"));
  const projectPath = path.join(tempRoot, "project");
  await mkdir(projectPath);
  runGit(projectPath, "init", "--quiet", "--initial-branch=main");
  runGit(projectPath, "config", "user.name", "Vibe Test");
  runGit(projectPath, "config", "user.email", "vibe@example.invalid");
  await writeFile(path.join(projectPath, "a.txt"), "a\n");
  runGit(projectPath, "add", "--", "a.txt");
  runGit(projectPath, "commit", "--quiet", "-m", "init");
  const managedRoot = path.join(tempRoot, "managed");
  await mkdir(managedRoot, { recursive: true });
  const service = new GitWorkspaceService({
    authorizeProjectRoot: async () => projectPath,
    managedWorktreesRoot: managedRoot,
    getWorktreeOwnership: async () => ({ unknown: false, sessions: [] }),
  });
  t.after(() => rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { tempRoot, projectPath, service, managedRoot };
}

test("custom-root creation lands outside the repo with preview parity", async (t) => {
  const { projectPath, service, tempRoot } = await makeRepo(t);
  const customRoot = path.join(tempRoot, "custom parents");
  await mkdir(customRoot, { recursive: true });
  const preview = await service.previewWorktreePath({
    projectPath,
    branch: "feature/custom-a",
    customRoot,
  });
  assert.equal(preview.rootKind, "custom");
  assert.ok(preview.target.startsWith(await realpath(customRoot)));
  // Nothing created by preview.
  const before = await service.worktrees({ projectPath });
  const beforeCount = before.items.length;
  const created = await service.createWorktree({
    projectPath,
    branch: "feature/custom-a",
    customRoot,
  });
  assert.equal(created.items.length, beforeCount + 1);
  const row = created.items.find((w) => w.branch === "feature/custom-a");
  assert.ok(row);
  assert.equal(path.resolve(row.path), path.resolve(preview.target));
  // Main checkout untouched.
  const status = await service.status({ projectPath });
  assert.equal(status.branch, "main");
});

test("custom roots refuse UNC, inside-repo and overlapping worktrees", async (t) => {
  const { projectPath, service, tempRoot } = await makeRepo(t);
  await assert.rejects(
    service.createWorktree({ projectPath, branch: "feature/u", customRoot: "\\\\server\\share" }),
    /UNC/,
  );
  await assert.rejects(
    service.createWorktree({ projectPath, branch: "feature/in", customRoot: projectPath }),
    /inside the repository/,
  );
  const customRoot = path.join(tempRoot, "custom2");
  await mkdir(customRoot, { recursive: true });
  await service.createWorktree({ projectPath, branch: "feature/first", customRoot });
  // Same parent overlaps the existing checkout's namespace dir.
  await assert.rejects(
    service.createWorktree({ projectPath, branch: "feature/second", customRoot: (await service.worktrees({ projectPath })).items.find((w) => w.branch === "feature/first").path }),
    /overlaps|inside/i,
  );
});

test("collisions, existing branches and non-empty targets are refused", async (t) => {
  const { projectPath, service, tempRoot } = await makeRepo(t);
  const customRoot = path.join(tempRoot, "custom3");
  await mkdir(customRoot, { recursive: true });
  await service.createWorktree({ projectPath, branch: "feature/dup", customRoot });
  await assert.rejects(
    service.createWorktree({ projectPath, branch: "feature/dup", customRoot }),
    /already exists|directory already exists|overlaps/i,
  );
  await assert.rejects(
    service.createWorktree({ projectPath, branch: "main", customRoot }),
    /already exists/i,
  );
});

test("disk usage measures checkouts without deleting anything", async (t) => {
  const { projectPath, service, tempRoot } = await makeRepo(t);
  const customRoot = path.join(tempRoot, "custom4");
  await mkdir(customRoot, { recursive: true });
  await service.createWorktree({ projectPath, branch: "feature/sized", customRoot });
  const usage = await service.worktreeDiskUsage({ projectPath });
  assert.equal(usage.isGitRepository, true);
  assert.ok(usage.rows.length >= 2);
  for (const row of usage.rows) {
    assert.ok(typeof row.path === "string");
    assert.ok(row.bytes === null || Number.isFinite(row.bytes));
  }
  const still = await service.worktrees({ projectPath });
  assert.ok(still.items.some((w) => w.branch === "feature/sized"));
});
