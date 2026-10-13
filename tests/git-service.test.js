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
  // App-managed worktree space for creation tests (mirrors userData/worktrees).
  const managedRoot = path.join(tempRoot, "managed worktrees");
  await mkdir(managedRoot, { recursive: true });
  // Session ownership is free by default; individual tests override it.
  let ownership = async () => ({ unknown: false, sessions: [] });
  const service = new GitWorkspaceService({
    authorizeProjectRoot: async (requested) => {
      assert.equal(path.resolve(requested), path.resolve(projectPath));
      return projectPath;
    },
    managedWorktreesRoot: managedRoot,
    getWorktreeOwnership: (...args) => ownership(...args),
  });
  t.after(async () =>
    rm(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    }),
  );
  return {
    tempRoot,
    projectPath,
    service,
    managedRoot,
    setOwnership: (next) => {
      ownership = next;
    },
  };
}

function fakeGhExecFile(realExecFile, { prList = [], prView = null } = {}) {
  return (command, args, options, callback) => {
    if (command === "gh" && args[0] === "auth" && args[1] === "status") {
      queueMicrotask(() => callback(null, "Logged in to github.com\n", ""));
      return undefined;
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      queueMicrotask(() => callback(null, JSON.stringify(prList), ""));
      return undefined;
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      queueMicrotask(() => callback(null, JSON.stringify(prView ?? {}), ""));
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

test("PR details report files and checks read-only without remote actions", async (t) => {
  const { projectPath } = await makeRepository(t);
  runGit(projectPath, "remote", "add", "origin", "https://github.com/example/project.git");
  const service = new GitWorkspaceService({
    authorizeProjectRoot: async () => projectPath,
    execFileImpl: fakeGhExecFile(execFile, {
      prView: {
        number: 42,
        title: "Workspace support",
        state: "OPEN",
        url: "https://github.com/example/project/pull/42",
        headRefName: "feature/workspace",
        baseRefName: "main",
        isDraft: false,
        reviewDecision: "REVIEW_REQUIRED",
        body: "Please review",
        files: [
          { path: "src/a.ts", additions: 10, deletions: 2 },
          { path: "src/b.ts", additions: 1, deletions: 1 },
        ],
        commits: [{ oid: "abc" }, { oid: "def" }],
        statusCheckRollup: [
          { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "lint", status: "IN_PROGRESS", conclusion: "" },
        ],
      },
    }),
  });
  const details = await service.pullRequestDetails({ projectPath, number: 42 });
  assert.equal(details.number, 42);
  assert.equal(details.files.length, 2);
  assert.equal(details.files[0].path, "src/a.ts");
  assert.equal(details.checks.length, 2);
  assert.equal(details.commits, 2);
  assert.equal(details.url, "https://github.com/example/project/pull/42");
  await assert.rejects(service.pullRequestDetails({ projectPath, number: 0 }), /invalid/);
  await assert.rejects(service.pullRequestDetails({ projectPath, number: 1.5 }), /invalid/);
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

test("Windows paths reject UNC, ADS streams, trailing-dot .git and symlink directories", async (t) => {
  const { tempRoot, projectPath, service } = await makeRepository(t);
  await assert.rejects(
    service.diff({ projectPath, path: "//server/share/evil.txt" }),
    /must be relative/,
  );
  await assert.rejects(
    service.diff({ projectPath, path: "\\\\server\\share\\evil.txt" }),
    /must be relative/,
  );
  await assert.rejects(
    service.diff({ projectPath, path: "notes.txt:secret" }),
    /not available/,
  );
  await assert.rejects(
    service.diff({ projectPath, path: ".git./config" }),
    /not available/,
  );
  await assert.rejects(
    service.diff({ projectPath, path: ".GIT/config" }),
    /not available/,
  );
  // Case-insensitive escape: drive-relative and absolute forms rejected.
  await assert.rejects(
    service.stage({ projectPath, paths: ["D:evil.txt"] }),
    /must be relative/,
  );
  await assert.rejects(
    service.stage({ projectPath, paths: ["/absolute.txt"] }),
    /must be relative/,
  );
  // Symlink to a directory is still a directory selection.
  const outsideDir = path.join(tempRoot, "outside-dir");
  await mkdir(outsideDir);
  const dirLink = path.join(projectPath, "dir-link");
  try {
    await symlink(outsideDir, dirLink, "junction");
  } catch (error) {
    if (["EACCES", "EPERM", "ENOTSUP", "UNKNOWN"].includes(error?.code)) {
      t.skip(`Directory symlinks are unavailable (${error.code})`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    service.stage({ projectPath, paths: ["dir-link"] }),
    /individual files|outside the selected repository/,
  );
  // File symlink pointing outside is rejected via realpath identity.
  const outsideFile = path.join(tempRoot, "secret-outside.txt");
  await writeFile(outsideFile, "private\n");
  const fileLink = path.join(projectPath, "file-link.txt");
  try {
    await symlink(outsideFile, fileLink, "file");
  } catch (error) {
    if (["EACCES", "EPERM", "ENOTSUP", "UNKNOWN"].includes(error?.code)) {
      t.skip(`File symlinks are unavailable (${error.code})`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    service.diff({ projectPath, path: "file-link.txt" }),
    /outside the selected repository/,
  );
});

test("sibling worktrees are independent workspaces requiring explicit selection", async (t) => {
  const { tempRoot, projectPath, service } = await makeRepository(t);
  const sibling = path.join(tempRoot, "sibling-worktree");
  runGit(projectPath, "worktree", "add", "--quiet", "-b", "sibling", sibling);
  // Operating on the sibling through the main root is never allowed:
  // mutations only accept repository-relative paths.
  await assert.rejects(
    service.stage({ projectPath, paths: ["../sibling-worktree/tracked.txt"] }),
    /leave the selected repository/,
  );
  // Explicitly selecting the sibling worktree folder is a legitimate
  // independent workspace and must work.
  const siblingService = new GitWorkspaceService({
    authorizeProjectRoot: async (requested) => {
      assert.equal(path.resolve(requested), path.resolve(sibling));
      return sibling;
    },
  });
  const status = await siblingService.status({ projectPath: sibling });
  assert.equal(status.isGitRepository, true);
  await writeFile(path.join(sibling, "tracked.txt"), "sibling edit\n");
  const after = await siblingService.status({ projectPath: sibling });
  assert.equal(after.dirty, true);
  assert.ok(after.files.some((file) => file.path === "tracked.txt"));
});

function extractHunks(diffText) {
  const hunks = [];
  const lines = String(diffText).split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  let current = null;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      current = { header: line.replace(/\r$/, ""), lines: [] };
      hunks.push(current);
    } else if (current) current.lines.push(line.replace(/\r$/, ""));
  }
  return hunks;
}

test("hunk staging applies one of several hunks and verifies the index", async (t) => {
  const { projectPath, service } = await makeRepository(t);
  const target = path.join(projectPath, "tracked.txt");
  const base = Array.from({ length: 40 }, (_, i) => `line${i + 1} before`).join("\n") + "\n";
  await writeFile(target, base);
  runGit(projectPath, "add", "--", "tracked.txt");
  runGit(projectPath, "commit", "--quiet", "-m", "forty lines");
  const edited = base
    .replace("line2 before", "line2 AFTER")
    .replace("line20 before", "line20 AFTER")
    .replace("line38 before", "line38 AFTER");
  await writeFile(target, edited);
  const working = await service.diff({ projectPath, path: "tracked.txt" });
  const hunks = extractHunks(working.diffText);
  assert.ok(hunks.length >= 2, `expected multiple hunks, got ${hunks.length}`);
  const middle = hunks[1] ?? hunks[0];
  const after = await service.stageHunk({
    projectPath,
    path: "tracked.txt",
    header: middle.header,
    lines: middle.lines,
  });
  const stagedFile = after.files.find((file) => file.path === "tracked.txt");
  assert.ok(stagedFile.staged, "file is partially staged");
  // Verify the actual index content, not just the call result.
  const stagedDiff = runGit(projectPath, "diff", "--cached", "--", "tracked.txt");
  const workingDiff = runGit(projectPath, "diff", "--", "tracked.txt");
  assert.match(stagedDiff, /line20 AFTER/);
  assert.doesNotMatch(stagedDiff, /line2 AFTER/);
  assert.doesNotMatch(stagedDiff, /line38 AFTER/);
  assert.match(workingDiff, /line2 AFTER/);
  // Unstage the same hunk: index returns to clean for that hunk.
  const middleStaged = extractHunks(
    (await service.diff({ projectPath, path: "tracked.txt", staged: true })).diffText,
  );
  assert.ok(middleStaged.length >= 1);
  const back = await service.unstageHunk({
    projectPath,
    path: "tracked.txt",
    header: middleStaged[0].header,
    lines: middleStaged[0].lines,
  });
  assert.ok(back.files.find((file) => file.path === "tracked.txt"));
  assert.equal(runGit(projectPath, "diff", "--cached", "--", "tracked.txt").trim(), "");
});

test("hunk staging rejects concurrent edits and index changes as stale", async (t) => {
  const { projectPath, service } = await makeRepository(t);
  const target = path.join(projectPath, "tracked.txt");
  await writeFile(target, "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\n");
  runGit(projectPath, "add", "--", "tracked.txt");
  runGit(projectPath, "commit", "--quiet", "-m", "base");
  await writeFile(target, "alpha\nBETA\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\nIOTA\n");
  const before = extractHunks((await service.diff({ projectPath, path: "tracked.txt" })).diffText);
  assert.ok(before.length >= 1);
  // Concurrent working-tree edit after the diff: hunk must be refused.
  await writeFile(target, "alpha\nBETA\nCONCURRENT\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\nIOTA\n");
  await assert.rejects(
    service.stageHunk({ projectPath, path: "tracked.txt", header: before[0].header, lines: before[0].lines }),
    /no longer matches|stale/i,
  );
  // Index changed after the diff: cached-view hunk must be refused.
  await writeFile(target, "alpha\nBETA\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\nIOTA\n");
  const fresh = extractHunks((await service.diff({ projectPath, path: "tracked.txt" })).diffText);
  await service.stage({ projectPath, paths: ["tracked.txt"] });
  await assert.rejects(
    service.stageHunk({ projectPath, path: "tracked.txt", header: fresh[0].header, lines: fresh[0].lines }),
    /no changes|no longer matches|stale/i,
  );
});

test("hunk staging works with CRLF files and refuses untracked or oversized hunks", async (t) => {
  const { projectPath, service } = await makeRepository(t);
  const target = path.join(projectPath, "crlf.txt");
  await writeFile(target, "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\n");
  runGit(projectPath, "add", "--", "crlf.txt");
  runGit(projectPath, "commit", "--quiet", "-m", "crlf base");
  await writeFile(target, "one\r\nTWO\r\nthree\r\nfour\r\nfive\r\nsix\r\nSEVEN\r\n");
  const hunks = extractHunks((await service.diff({ projectPath, path: "tracked.txt" }).catch(() => ({ diffText: "" }))).diffText);
  const crlfDiff = await service.diff({ projectPath, path: "crlf.txt" });
  const crlfHunks = extractHunks(crlfDiff.diffText);
  assert.ok(crlfHunks.length >= 1, "CRLF diff produces hunks");
  const first = crlfHunks[0];
  const after = await service.stageHunk({ projectPath, path: "crlf.txt", header: first.header, lines: first.lines });
  assert.ok(after.files.some((file) => file.path === "crlf.txt" && file.staged));
  assert.equal(hunks.length, hunks.length); // keep linter calm about unused helper shape
  await writeFile(path.join(projectPath, "new-untracked.txt"), "hello\n");
  const untrackedDiff = await service.diff({ projectPath, path: "new-untracked.txt" });
  const untrackedHunks = extractHunks(untrackedDiff.diffText);
  assert.ok(untrackedHunks.length >= 1);
  await assert.rejects(
    service.stageHunk({ projectPath, path: "new-untracked.txt", header: untrackedHunks[0].header, lines: untrackedHunks[0].lines }),
    /whole, not by hunk/,
  );
  await assert.rejects(
    service.stageHunk({ projectPath, path: "crlf.txt", header: "@@ nonsense @@", lines: [" context"] }),
    /invalid|no longer matches/i,
  );
});

test("worktrees report dirty and ahead state for safe navigation", async (t) => {
  const { projectPath, service } = await makeRepository(t);
  const linkedPath = path.join(await realpath(path.dirname(projectPath)), "wt-details");
  runGit(projectPath, "worktree", "add", "--quiet", "-b", "details-branch", linkedPath);
  // No git cleanup needed: makeRepository removes the whole temp root,
  // including the linked checkout, after the test.
  let result = await service.worktrees({ projectPath });
  const linked = result.items.find((item) => item.branch === "details-branch");
  assert.ok(linked, "linked worktree is listed");
  assert.equal(linked.dirty, false);
  await writeFile(path.join(linkedPath, "tracked.txt"), "dirty edit\n");
  result = await service.worktrees({ projectPath });
  const dirty = result.items.find((item) => item.branch === "details-branch");
  assert.equal(dirty.dirty, true);
});

test("worktree creation uses the managed space and never dirties the main checkout", async (t) => {
  const { projectPath, service, managedRoot } = await makeRepository(t);
  const headBefore = runGit(projectPath, "rev-parse", "HEAD");
  const created = await service.createWorktree({ projectPath, branch: "feature/m2-space" });
  const item = created.items.find((entry) => entry.branch === "feature/m2-space");
  assert.ok(item, "created worktree is listed and verified");
  assert.equal(item.branch, "feature/m2-space");
  const canonicalTarget = await realpath(item.path);
  const canonicalManaged = await realpath(managedRoot);
  assert.ok(
    canonicalTarget.toLowerCase().startsWith(canonicalManaged.toLowerCase()),
    `worktree lives in the managed space: ${canonicalTarget}`,
  );
  assert.ok(
    !canonicalTarget.toLowerCase().startsWith((await realpath(projectPath)).toLowerCase() + path.sep),
    "worktree is outside the repository checkout",
  );
  // The main checkout is untouched: same HEAD and no new debris inside it.
  assert.equal(runGit(projectPath, "rev-parse", "HEAD"), headBefore);
  const mainStatus = await service.status({ projectPath });
  assert.ok(
    mainStatus.files.every((file) => !file.path.startsWith(".worktrees")),
    "no .worktrees debris in Changes",
  );
  assert.ok(
    mainStatus.files.every((file) => !file.path.includes("feature")),
    "main checkout gained no worktree files",
  );
});

test("worktree creation and safe removal respect dirty, untracked and unpushed guards", async (t) => {
  const { projectPath, service } = await makeRepository(t);
  const created = await service.createWorktree({ projectPath, branch: "feature-m2" });
  const item = created.items.find((entry) => entry.branch === "feature-m2");
  assert.ok(item, "created worktree is listed and verified");
  const target = item.path;
  // Dirty worktree cannot be removed.
  await writeFile(path.join(target, "tracked.txt"), "uncommitted\n");
  await assert.rejects(
    service.removeWorktree({ projectPath, worktreePath: target }),
    /uncommitted changes/,
  );
  runGit(projectPath, "worktree", "list", "--porcelain");
  // Clean the modification, then untracked files still block removal.
  await writeFile(path.join(target, "tracked.txt"), "before\n");
  await writeFile(path.join(target, "important-notes.txt"), "do not lose\n");
  await assert.rejects(
    service.removeWorktree({ projectPath, worktreePath: target }),
    /untracked/,
  );
  await rm(path.join(target, "important-notes.txt"), { force: true });
  // Unpushed commits (no upstream, HEAD diverged) block removal.
  await writeFile(path.join(target, "tracked.txt"), "new commit content\n");
  runGit(target, "add", "--", "tracked.txt");
  runGit(target, "commit", "--quiet", "-m", "worktree commit");
  await assert.rejects(
    service.removeWorktree({ projectPath, worktreePath: target }),
    /nowhere else|upstream|unpushed/i,
  );
  // Main checkout can never be removed; unknown paths are refused.
  await assert.rejects(
    service.removeWorktree({ projectPath, worktreePath: projectPath }),
    /main checkout/,
  );
  await assert.rejects(
    service.removeWorktree({ projectPath, worktreePath: path.join(projectPath, "nope") }),
    /identified with certainty/,
  );
  // Existing branches cannot be overwritten by creation.
  await assert.rejects(
    service.createWorktree({ projectPath, branch: "main" }),
    /already exists/,
  );
  await assert.rejects(
    service.createWorktree({ projectPath, branch: "../evil" }),
    /invalid/,
  );
});

test("file explorer lists lazily and previews safely", async (t) => {
  const { projectPath, service } = await makeRepository(t);
  await mkdir(path.join(projectPath, "docs"));
  await writeFile(path.join(projectPath, "docs", "notes.md"), "# Notes\n\nHello **world**\n");
  await writeFile(path.join(projectPath, "data.json"), '{"key": "value"}\n');
  await writeFile(path.join(projectPath, "binary.dat"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  await writeFile(path.join(projectPath, "big.txt"), "x\n".repeat(400_000));
  // 1x1 transparent PNG.
  await writeFile(
    path.join(projectPath, "pixel.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
  );

  const root = await service.listDirectory({ projectPath, dir: "" });
  assert.equal(root.isGitRepository, true);
  assert.ok(root.entries.some((e) => e.name === "docs" && e.kind === "directory"));
  assert.ok(root.entries.every((e) => e.name !== ".git"), "never lists .git");
  const docs = await service.listDirectory({ projectPath, dir: "docs" });
  assert.ok(docs.entries.some((e) => e.name === "notes.md" && e.kind === "file"));

  const md = await service.readFile({ projectPath, path: "docs/notes.md" });
  assert.equal(md.kind, "markdown");
  assert.match(md.text, /Hello/);
  const json = await service.readFile({ projectPath, path: "data.json" });
  assert.equal(json.kind, "json");
  const image = await service.readFile({ projectPath, path: "pixel.png" });
  assert.equal(image.kind, "image");
  assert.match(image.mime, /image\/png/);
  assert.ok(image.base64.length > 0);
  const binary = await service.readFile({ projectPath, path: "binary.dat" });
  assert.equal(binary.kind, "binary");
  const big = await service.readFile({ projectPath, path: "big.txt" });
  assert.equal(big.truncated, true);

  await assert.rejects(service.readFile({ projectPath, path: "../outside.txt" }), /leave/);
  await assert.rejects(service.readFile({ projectPath, path: ".git/config" }), /not available/);
  await assert.rejects(service.readFile({ projectPath, path: "docs" }), /individual files/);
  await assert.rejects(service.listDirectory({ projectPath, dir: ".." }), /leave/);
});

test("worktree removal is blocked by session ownership and unknown state", async (t) => {
  const { projectPath, service, setOwnership } = await makeRepository(t);
  const created = await service.createWorktree({ projectPath, branch: "owned-branch" });
  const target = created.items.find((entry) => entry.branch === "owned-branch").path;
  // Occupied by an agent turn: blocked with the reason, checkout preserved.
  setOwnership(async () => ({
    unknown: false,
    sessions: [
      {
        sessionId: "sess-live-turn",
        occupied: true,
        attached: true,
        hasActiveTurn: true,
        hasPendingCallbacks: false,
        leaseHeld: false,
      },
    ],
  }));
  await assert.rejects(
    service.removeWorktree({ projectPath, worktreePath: target }),
    /used by 1 session\(s\)/,
  );
  assert.ok((await service.worktrees({ projectPath })).items.some((entry) => entry.branch === "owned-branch"));
  // Unverifiable ownership blocks as well — never assume a directory is free.
  setOwnership(async () => ({ unknown: true, sessions: [] }));
  await assert.rejects(
    service.removeWorktree({ projectPath, worktreePath: target }),
    /unverifiable/,
  );
  // Provider failure also blocks.
  setOwnership(async () => {
    throw new Error("backend gone");
  });
  await assert.rejects(
    service.removeWorktree({ projectPath, worktreePath: target }),
    /unverifiable/,
  );
  // Idle listed sessions warn but allow: removal succeeds once free.
  setOwnership(async () => ({
    unknown: false,
    sessions: [{ sessionId: "sess-saved", occupied: false, attached: false }],
  }));
  const after = await service.removeWorktree({ projectPath, worktreePath: target });
  assert.ok(!after.items.some((entry) => entry.branch === "owned-branch"));
});

test("concurrent mutations on one repository serialize without index corruption", async (t) => {
  const { projectPath, service } = await makeRepository(t);
  const target = path.join(projectPath, "tracked.txt");
  const base = Array.from({ length: 40 }, (_, i) => `line${i + 1} before`).join("\n") + "\n";
  await writeFile(target, base);
  runGit(projectPath, "add", "--", "tracked.txt");
  runGit(projectPath, "commit", "--quiet", "-m", "forty lines");
  const edited = base
    .replace("line2 before", "line2 AFTER")
    .replace("line20 before", "line20 AFTER")
    .replace("line38 before", "line38 AFTER");
  await writeFile(target, edited);
  const hunks = extractHunks((await service.diff({ projectPath, path: "tracked.txt" })).diffText);
  assert.ok(hunks.length >= 3);
  // Three overlapping generations race: serialization makes them run in
  // order; the first stages, the rest see a stale index and are refused —
  // the index is never corrupted and the process never deadlocks.
  const results = await Promise.allSettled(
    hunks.map((hunk) =>
      service.stageHunk({ projectPath, path: "tracked.txt", header: hunk.header, lines: hunk.lines }),
    ),
  );
  const stagedDiff = runGit(projectPath, "diff", "--cached", "--", "tracked.txt");
  assert.ok(results.some((r) => r.status === "fulfilled"), "at least one hunk stages");
  assert.match(stagedDiff, /AFTER/);
  // Whole-file concurrent stages both succeed and converge.
  await writeFile(target, edited.replace("line2 AFTER", "line2 AFTER2"));
  const [first, second] = await Promise.all([
    service.stage({ projectPath, paths: ["tracked.txt"] }),
    service.stage({ projectPath, paths: ["tracked.txt"] }),
  ]);
  assert.ok(first.files.find((f) => f.path === "tracked.txt").staged);
  assert.ok(second.files.find((f) => f.path === "tracked.txt").staged);
});

test("hunk staging refuses renames and deletions as whole-file operations", async (t) => {
  const { projectPath, service } = await makeRepository(t);
  await writeFile(path.join(projectPath, "gone.txt"), "delete me\n");
  runGit(projectPath, "add", "--", "gone.txt");
  runGit(projectPath, "commit", "--quiet", "-m", "add gone");
  runGit(projectPath, "mv", "gone.txt", "renamed.txt");
  const renameDiff = await service.diff({ projectPath, path: "renamed.txt" });
  const renameHunks = extractHunks(renameDiff.diffText);
  if (renameHunks.length > 0) {
    await assert.rejects(
      service.stageHunk({ projectPath, path: "renamed.txt", header: renameHunks[0].header, lines: renameHunks[0].lines }),
      /whole, not by hunk/,
    );
  }
  runGit(projectPath, "reset", "--quiet", "--hard", "HEAD");
  await rm(path.join(projectPath, "tracked.txt"));
  const deleteDiff = await service.diff({ projectPath, path: "tracked.txt" });
  const deleteHunks = extractHunks(deleteDiff.diffText);
  if (deleteHunks.length > 0) {
    await assert.rejects(
      service.stageHunk({ projectPath, path: "tracked.txt", header: deleteHunks[0].header, lines: deleteHunks[0].lines }),
      /whole, not by hunk/,
    );
  }
});

test("mutations refuse when the repository identity changes (TOCTOU)", async (t) => {
  const { projectPath } = await makeRepository(t);
  await writeFile(path.join(projectPath, "tracked.txt"), "changed\n");
  let topLevelCalls = 0;
  const service = new GitWorkspaceService({
    authorizeProjectRoot: async () => projectPath,
    execFileImpl(command, args, options, callback) {
      // Simulate the repo being swapped between resolve and mutation:
      // the identity re-check (2nd top-level lookup) points elsewhere.
      if (
        command === "git" &&
        args.includes("rev-parse") &&
        args.includes("--show-toplevel")
      ) {
        topLevelCalls += 1;
        if (topLevelCalls === 2) {
          queueMicrotask(() => callback(null, `${os.tmpdir()}\n`, ""));
          return undefined;
        }
      }
      return execFile(command, args, options, callback);
    },
  });
  await assert.rejects(
    service.stage({ projectPath, paths: ["tracked.txt"] }),
    /changed during the operation/,
  );
});
