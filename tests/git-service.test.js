import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { GitWorkspaceService } from "../src/main/git-service.js";

function runGit(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function makeRepository(t, { initialCommit = true } = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-git-workspace-"));
  const projectPath = path.join(tempRoot, "project with spaces");
  await mkdir(projectPath);
  runGit(projectPath, "init", "--quiet", "--initial-branch=main");
  runGit(projectPath, "config", "user.name", "Vibe Desktop Test");
  runGit(projectPath, "config", "user.email", "vibe-test@example.invalid");
  if (initialCommit) {
    await writeFile(path.join(projectPath, "tracked.txt"), "before\n");
    runGit(projectPath, "add", "--", "tracked.txt");
    runGit(projectPath, "commit", "--quiet", "-m", "initial commit");
  }
  const service = new GitWorkspaceService({
    authorizeProjectRoot: async (requested) => {
      assert.equal(path.resolve(requested), path.resolve(projectPath));
      return projectPath;
    },
  });
  t.after(async () =>
    rm(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    }),
  );
  return { tempRoot, projectPath, service };
}

function fakeGhExecFile(realExecFile, { prList = [] } = {}) {
  return (command, args, options, callback) => {
    if (command === "gh" && args[0] === "auth" && args[1] === "status") {
      queueMicrotask(() => callback(null, "Logged in to github.com\n", ""));
      return undefined;
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      queueMicrotask(() => callback(null, JSON.stringify(prList), ""));
      return undefined;
    }
    return realExecFile(command, args, options, callback);
  };
}

test("status parses staged, unstaged and untracked files without losing spaces", async (t) => {
  const { projectPath, service } = await makeRepository(t);
  await writeFile(path.join(projectPath, "tracked.txt"), "staged version\n");
  await service.stage({ projectPath, paths: ["tracked.txt"] });
  await writeFile(path.join(projectPath, "tracked.txt"), "working version\n");
  await writeFile(path.join(projectPath, "untracked file.txt"), "new file\n");

  const result = await service.status({ projectPath });
  assert.equal(result.isGitRepository, true);
  assert.equal(result.branch, "main");
  assert.equal(result.dirty, true);
  assert.equal(result.filesTruncated, false);
  assert.deepEqual(
    result.files.map(
      ({
        path: filePath,
        indexStatus,
        worktreeStatus,
        staged,
        unstaged,
        untracked,
      }) => ({
        path: filePath,
        indexStatus,
        worktreeStatus,
        staged,
        unstaged,
        untracked,
      }),
    ),
    [
      {
        path: "tracked.txt",
        indexStatus: "M",
        worktreeStatus: "M",
        staged: true,
        unstaged: true,
        untracked: false,
      },
      {
        path: "untracked file.txt",
        indexStatus: "?",
        worktreeStatus: "?",
        staged: false,
        unstaged: false,
        untracked: true,
      },
    ],
  );
});

test("diff returns separate staged, working-tree and untracked views with a hard byte limit", async (t) => {
  const { projectPath, service } = await makeRepository(t);
  await writeFile(path.join(projectPath, "tracked.txt"), "index version\n");
  await service.stage({ projectPath, paths: ["tracked.txt"] });
  await writeFile(path.join(projectPath, "tracked.txt"), "working version\n");
  await writeFile(path.join(projectPath, "new file.txt"), "new content\n");

  const staged = await service.diff({
    projectPath,
    path: "tracked.txt",
    staged: true,
  });
  const working = await service.diff({ projectPath, path: "tracked.txt" });
  const untracked = await service.diff({ projectPath, path: "new file.txt" });
  assert.match(staged.diffText, /before/);
  assert.match(staged.diffText, /index version/);
  assert.doesNotMatch(staged.diffText, /working version/);
  assert.match(working.diffText, /index version/);
  assert.match(working.diffText, /working version/);
  assert.equal(untracked.untracked, true);
  assert.match(untracked.diffText, /new content/);
  assert.equal(untracked.bytes, Buffer.byteLength(untracked.diffText, "utf8"));

  await writeFile(path.join(projectPath, "literal[1].txt"), "literal target\n");
  await writeFile(path.join(projectPath, "literal1.txt"), "pathspec match\n");
  const literal = await service.diff({
    projectPath,
    path: "literal[1].txt",
  });
  assert.match(literal.diffText, /literal target/);
  assert.doesNotMatch(literal.diffText, /pathspec match/);

  await writeFile(path.join(projectPath, "large.txt"), "x\n".repeat(400_000));
  const large = await service.diff({ projectPath, path: "large.txt" });
  assert.equal(large.truncated, true);
  assert.ok(large.bytes < large.maxBytes + 100);
  assert.match(large.diffText, /diff truncated/);
});

test("stage, unstage and commit are explicit scoped Git operations", async (t) => {
  const { projectPath, service } = await makeRepository(t);
  await writeFile(path.join(projectPath, "tracked.txt"), "edited\n");
  let result = await service.stage({
    projectPath,
    paths: ["tracked.txt", "tracked.txt"],
  });
  assert.equal(
    result.files.find((file) => file.path === "tracked.txt").staged,
    true,
  );

  result = await service.unstage({ projectPath, paths: ["tracked.txt"] });
  assert.equal(
    result.files.find((file) => file.path === "tracked.txt").staged,
    false,
  );
  assert.equal(
    await readFile(path.join(projectPath, "tracked.txt"), "utf8"),
    "edited\n",
  );

  await service.stage({ projectPath, paths: ["tracked.txt"] });
  const commit = await service.commit({
    projectPath,
    message: "Save selected changes",
  });
  assert.match(commit.hash, /^[a-f0-9]{40,64}$/);
  assert.equal(commit.subject, "Save selected changes");
  assert.equal((await service.status({ projectPath })).dirty, false);
  assert.equal(
    (await service.log({ projectPath, limit: 1 })).items[0].hash,
    commit.hash,
  );
  const history = await service.log({ projectPath, limit: 10 });
  assert.equal(history.items.length, 2);
  assert.equal(history.items[0].hash, commit.hash);
  assert.equal(history.items[1].subject, "initial commit");
});

test("unstaging staged files works before the first commit and preserves their worktree contents", async (t) => {
  const { projectPath, service } = await makeRepository(t, {
    initialCommit: false,
  });
  await writeFile(path.join(projectPath, "first.txt"), "keep this file\n");
  await service.stage({ projectPath, paths: ["first.txt"] });
  const result = await service.unstage({ projectPath, paths: ["first.txt"] });
  assert.equal(
    await readFile(path.join(projectPath, "first.txt"), "utf8"),
    "keep this file\n",
  );
  assert.equal(result.files[0].untracked, true);
  assert.deepEqual((await service.log({ projectPath })).items, []);
});

test("repository paths reject traversal, .git access and symlinks that escape the project", async (t) => {
  const { tempRoot, projectPath, service } = await makeRepository(t);
  await assert.rejects(
    service.diff({ projectPath, path: "../outside.txt" }),
    /leave the selected repository/,
  );
  await assert.rejects(
    service.diff({ projectPath, path: ".git/config" }),
    /not available/,
  );
  await mkdir(path.join(projectPath, "nested"));
  await writeFile(path.join(projectPath, "nested", "file.txt"), "nested\n");
  await assert.rejects(
    service.diff({ projectPath, path: "nested" }),
    /individual files/,
  );
  await assert.rejects(
    service.stage({ projectPath, paths: ["nested"] }),
    /individual files/,
  );
  await assert.rejects(
    service.stage({ projectPath, paths: ["C:\\outside.txt"] }),
    /must be relative/,
  );

  const outside = path.join(tempRoot, "outside");
  const link = path.join(projectPath, "outside-link");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "private\n");
  try {
    await symlink(outside, link, "junction");
  } catch (error) {
    if (["EACCES", "EPERM", "ENOTSUP", "UNKNOWN"].includes(error?.code)) {
      t.skip(`Directory symlinks are unavailable (${error.code})`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    service.diff({ projectPath, path: "outside-link/secret.txt" }),
    /outside the selected repository/,
  );
  await assert.rejects(
    service.stage({ projectPath, paths: ["outside-link/secret.txt"] }),
    /outside the selected repository/,
  );
});

test("worktree listing is read-only and includes linked worktrees", async (t) => {
  const { tempRoot, projectPath, service } = await makeRepository(t);
  const linkedPath = path.join(tempRoot, "linked worktree");
  runGit(projectPath, "worktree", "add", "--quiet", "-b", "linked", linkedPath);
  const result = await service.worktrees({ projectPath });
  assert.equal(result.isGitRepository, true);
  assert.equal(result.items.length, 2);
  const canonicalProject = await realpath(projectPath);
  const canonicalLinked = await realpath(linkedPath);
  const canonicalItems = await Promise.all(
    result.items.map(async (item) => ({
      ...item,
      path: await realpath(item.path),
    })),
  );
  assert.ok(
    canonicalItems.some(
      // Git can expand Windows short names and junctions in the runner's TEMP
      // directory. Compare canonical identity using the platform's path rules.
      (item) =>
        path.relative(canonicalProject, item.path) === "" &&
        item.branch === "main",
    ),
    JSON.stringify({ canonicalProject, canonicalItems }),
  );
  assert.ok(
    canonicalItems.some(
      (item) =>
        path.relative(canonicalLinked, item.path) === "" &&
        item.branch === "linked",
    ),
    JSON.stringify({ canonicalLinked, canonicalItems }),
  );
  assert.equal(result.truncated, false);
  assert.equal(
    (await readFile(path.join(linkedPath, "tracked.txt"), "utf8")).replace(
      /\r\n/g,
      "\n",
    ),
    "before\n",
  );
});

test("PR listing recognizes GitHub remotes without exposing remote credentials", async (t) => {
  const { projectPath } = await makeRepository(t);
  runGit(
    projectPath,
    "remote",
    "add",
    "origin",
    "https://build-user:super-secret-token@github.com/mistral-community/vibe-desktop.git",
  );
  const service = new GitWorkspaceService({
    authorizeProjectRoot: async () => projectPath,
    execFileImpl: fakeGhExecFile(execFile, {
      prList: [
        {
          number: 12,
          title: "Workspace support",
          state: "OPEN",
          url: "https://github.com/mistral-community/vibe-desktop/pull/12",
          headRefName: "feature/workspace",
          baseRefName: "main",
          isDraft: false,
          reviewDecision: "REVIEW_REQUIRED",
        },
      ],
    }),
  });
  const result = await service.pullRequests({ projectPath });
  assert.equal(result.available, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.repository, "mistral-community/vibe-desktop");
  assert.equal(result.items[0].number, 12);
  assert.equal(
    result.items[0].url,
    "https://github.com/mistral-community/vibe-desktop/pull/12",
  );
  assert.doesNotMatch(JSON.stringify(result), /super-secret-token|build-user/);
});

test("PR creation is explicit, requires a published synchronized branch, and sends body via stdin", async (t) => {
  const { projectPath } = await makeRepository(t);
  runGit(
    projectPath,
    "remote",
    "add",
    "origin",
    "https://github.com/example/project.git",
  );
  runGit(projectPath, "config", "branch.main.remote", "origin");
  runGit(projectPath, "config", "branch.main.merge", "refs/heads/main");
  runGit(projectPath, "update-ref", "refs/remotes/origin/main", "HEAD");
  const head = runGit(projectPath, "rev-parse", "HEAD");
  let sentBody = "";
  let createArgs;
  const execFileImpl = (command, args, options, callback) => {
    if (command === "gh" && args[0] === "auth") {
      queueMicrotask(() => callback(null, "authenticated", ""));
      return undefined;
    }
    if (command === "git" && args.includes("ls-remote")) {
      queueMicrotask(() => callback(null, `${head}\trefs/heads/main\n`, ""));
      return undefined;
    }
    return execFile(command, args, options, callback);
  };
  const spawnImpl = (_command, args) => {
    createArgs = args;
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin.on("data", (chunk) => (sentBody += chunk.toString("utf8")));
    child.stdin.on("finish", () => {
      setImmediate(() => {
        child.stdout.end("https://github.com/example/project/pull/42\n");
        child.stderr.end();
        child.emit("close", 0, null);
      });
    });
    return child;
  };
  const service = new GitWorkspaceService({
    authorizeProjectRoot: async () => projectPath,
    execFileImpl,
    spawnImpl,
  });
  const result = await service.createPullRequest({
    projectPath,
    title: "A checked pull request",
    body: "review these changes",
    base: "main",
    draft: true,
  });
  assert.deepEqual(result, {
    isGitRepository: true,
    url: "https://github.com/example/project/pull/42",
  });
  assert.equal(sentBody, "review these changes");
  assert.ok(createArgs.includes("--head"));
  assert.ok(createArgs.includes("main"));
  assert.ok(!createArgs.includes("review these changes"));
});

test("safe non-repository results and selected-project authorization are enforced", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-git-empty-"));
  const selected = path.join(tempRoot, "selected");
  const other = path.join(tempRoot, "other");
  await mkdir(selected);
  await mkdir(other);
  t.after(async () =>
    rm(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    }),
  );
  const service = new GitWorkspaceService({
    authorizeProjectRoot: async (requested) => {
      if (path.resolve(requested) !== path.resolve(selected))
        throw new Error("not selected");
      return selected;
    },
  });
  const result = await service.status({ projectPath: selected });
  assert.deepEqual(result, {
    isGitRepository: false,
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    dirty: false,
    files: [],
    filesTruncated: false,
  });
  await assert.rejects(
    service.status({ projectPath: other }),
    /not been selected/,
  );
});

test("large repositories cap the rendered status without losing the dirty state", async (t) => {
  const { projectPath, service } = await makeRepository(t);
  await Promise.all(
    Array.from({ length: 650 }, (_, index) =>
      writeFile(
        path.join(
          projectPath,
          `untracked-${String(index).padStart(4, "0")}.txt`,
        ),
        "local change\n",
      ),
    ),
  );
  const result = await service.status({ projectPath });
  assert.equal(result.files.length, 500);
  assert.equal(result.filesTruncated, true);
  assert.equal(result.dirty, true);
  assert.ok(result.files.every((file) => file.untracked));
});

test("Windows Git invocations hide child windows and inherit the executable lookup hardening", async (t) => {
  const { projectPath } = await makeRepository(t);
  let observedOptions;
  const service = new GitWorkspaceService({
    authorizeProjectRoot: async () => projectPath,
    platform: "win32",
    env: { PATH: process.env.PATH },
    execFileImpl(command, args, options, callback) {
      observedOptions = options;
      return execFile(command, args, options, callback);
    },
  });
  await service.status({ projectPath });
  assert.equal(observedOptions.windowsHide, true);
  assert.equal(observedOptions.env.NODEFAULTCURRENTDIRECTORYINEXEPATH, "1");
  assert.ok(observedOptions.maxBuffer <= 4 * 1024 * 1024);
});
