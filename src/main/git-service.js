import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile as readFsFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_STATUS_FILES = 500;
const MAX_PATHS_PER_MUTATION = 200;
const MAX_PATH_LENGTH = 4096;
const MAX_LOG_LIMIT = 100;
const MAX_WORKTREES = 100;
const MAX_WORKTREE_DETAILS = 25;
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_PREVIEW_BYTES = 512 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 2 * 1024 * 1024;
const PREVIEWABLE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".bmp"]);
const MAX_PULL_REQUESTS = 30;
const MAX_HUNK_LINES = 200;
const MAX_HUNK_BYTES = 256 * 1024;
const GITHUB_OWNER_OR_REPO = /^[A-Za-z0-9_.-]+$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@[^\0\n]{0,512}$/;

function parseUnifiedHunks(diffText) {
  const hunks = [];
  if (typeof diffText !== "string" || !diffText) return hunks;
  const lines = diffText.split("\n");
  // Drop the trailing artifact of the final newline, not a hunk line.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  let current = null;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      current = { header: line.replace(/\r$/, ""), lines: [] };
      hunks.push(current);
    } else if (current) {
      current.lines.push(line.replace(/\r$/, ""));
    }
  }
  return hunks.filter((h) => HUNK_HEADER.test(h.header));
}

function validateHunkInput(header, lines) {
  if (typeof header !== "string" || !HUNK_HEADER.test(header))
    throw new TypeError("Hunk header is invalid");
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > MAX_HUNK_LINES)
    throw new TypeError(`Hunk must contain between 1 and ${MAX_HUNK_LINES} lines`);
  let bytes = Buffer.byteLength(header, "utf8");
  for (const line of lines) {
    if (typeof line !== "string" || line.length > 8192 || line.includes("\0"))
      throw new TypeError("Hunk content is invalid");
    // An empty diff line is a blank context line; git emits it bare.
    if (line === "") {
      bytes += 1;
      continue;
    }
    const marker = line[0];
    if (marker !== " " && marker !== "+" && marker !== "-" && marker !== "\\")
      throw new TypeError("Hunk content is invalid");
    if (line[0] === "\\" && !line.startsWith("\\ No newline"))
      throw new TypeError("Hunk content is invalid");
    bytes += Buffer.byteLength(line, "utf8") + 1;
  }
  if (bytes > MAX_HUNK_BYTES) throw new TypeError("Hunk is too large");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inside(root, candidate, platform) {
  let relative = path.relative(root, candidate);
  if (platform === "win32") relative = relative.toLowerCase();
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function operationError(message, code = undefined) {
  const error = new Error(message);
  if (code !== undefined) error.code = code;
  return error;
}

function requireProjectPath(projectPath) {
  if (
    typeof projectPath !== "string" ||
    projectPath.length < 1 ||
    projectPath.length > MAX_PATH_LENGTH ||
    !path.isAbsolute(projectPath)
  ) {
    throw new TypeError("A selected project path is required");
  }
}

function normalizeRelativePath(input) {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > MAX_PATH_LENGTH ||
    input.includes("\0")
  ) {
    throw new TypeError("A repository-relative file path is required");
  }
  const portable = input.replaceAll("\\", "/");
  // Absolute, drive-anchored and UNC paths are never repository-relative.
  // UNC (//server/share or \\server\share) arrives here as a leading //.
  if (
    portable.startsWith("/") ||
    /^[A-Za-z]:/.test(portable) ||
    portable.startsWith("//")
  ) {
    throw new TypeError(
      "File path must be relative to the selected repository",
    );
  }
  const pieces = portable.split("/");
  if (pieces.some((piece) => piece === "..")) {
    throw new TypeError("File path cannot leave the selected repository");
  }
  const normalized = pieces.filter((piece) => piece && piece !== ".");
  if (normalized.length === 0) {
    throw new TypeError("File path is not available to the Git workspace");
  }
  for (const piece of normalized) {
    // NTFS alternate data streams and device syntax never reach Git.
    if (piece.includes(":")) {
      throw new TypeError("File path is not available to the Git workspace");
    }
    // Windows ignores trailing dots/spaces: ".git.", ".git " and "dir "
    // resolve to ".git" and "dir". Strip them before the guard so the
    // bypass cannot smuggle .git access or confuse canonicalization.
    const stripped = piece.replace(/[. ]+$/, "");
    if (!stripped) {
      throw new TypeError("File path is not available to the Git workspace");
    }
    if (stripped.toLowerCase() === ".git") {
      throw new TypeError("File path is not available to the Git workspace");
    }
  }
  return normalized.join("/");
}

function parseGitHubRepository(remote) {
  if (typeof remote !== "string" || remote.length > 4096) return null;
  let owner;
  let repository;
  const scp = /^(?:[^@/:]+@)?github\.com:([^/]+)\/([^/]+?)\/?$/i.exec(
    remote.trim(),
  );
  if (scp) {
    owner = scp[1];
    repository = scp[2];
  } else {
    let url;
    try {
      url = new URL(remote.trim());
    } catch {
      return null;
    }
    if (
      url.hostname.toLowerCase() !== "github.com" ||
      !["https:", "ssh:"].includes(url.protocol) ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (segments.length !== 2) return null;
    [owner, repository] = segments;
  }
  repository = repository.replace(/\.git$/i, "");
  if (
    !GITHUB_OWNER_OR_REPO.test(owner) ||
    !GITHUB_OWNER_OR_REPO.test(repository)
  ) {
    return null;
  }
  return `${owner}/${repository}`;
}

function safeUtf8Prefix(value, maxBytes) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  return buffer
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
}

function parsePorcelainV2(raw) {
  const fields = {
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    files: [],
  };
  const records = raw.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith("# ")) {
      for (const line of record.split(/\r?\n/)) {
        if (line.startsWith("# branch.oid ")) {
          const oid = line.slice("# branch.oid ".length);
          fields.head = oid === "(initial)" ? null : oid;
        } else if (line.startsWith("# branch.head ")) {
          const branch = line.slice("# branch.head ".length);
          fields.detached = branch === "(detached)";
          fields.branch =
            fields.detached || branch === "(unknown)" ? null : branch;
        } else if (line.startsWith("# branch.upstream ")) {
          fields.upstream = line.slice("# branch.upstream ".length) || null;
        } else if (line.startsWith("# branch.ab ")) {
          const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
          if (match) {
            fields.ahead = Number(match[1]);
            fields.behind = Number(match[2]);
          }
        }
      }
      continue;
    }

    let type = record[0];
    let xy = "..";
    let filePath = "";
    let originalPath;

    if (record.startsWith("? ")) {
      type = "?";
      filePath = record.slice(2);
      xy = "??";
    } else if (type === "1" || type === "2") {
      const fieldsMatch =
        type === "1"
          ? /^1 (..) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(record)
          : /^2 (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(record);
      if (!fieldsMatch) continue;
      xy = fieldsMatch[1];
      if (type === "2") {
        filePath = fieldsMatch[2];
        originalPath = records[index + 1] || undefined;
        index += 1;
      } else {
        filePath = fieldsMatch[2];
      }
    } else if (type === "u") {
      const match = /^u (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(
        record,
      );
      if (!match) continue;
      xy = match[1];
      filePath = match[2];
    } else {
      continue;
    }

    let safePath;
    try {
      safePath = normalizeRelativePath(filePath);
      if (originalPath !== undefined)
        originalPath = normalizeRelativePath(originalPath);
    } catch {
      continue;
    }
    const untracked = type === "?";
    const staged = !untracked && xy[0] !== ".";
    const unstaged = !untracked && xy[1] !== ".";
    const conflicted = type === "u" || xy.includes("U");
    fields.files.push({
      path: safePath,
      ...(originalPath ? { originalPath } : {}),
      indexStatus: untracked ? "?" : xy[0],
      worktreeStatus: untracked ? "?" : xy[1],
      staged,
      unstaged,
      untracked,
      deleted: xy.includes("D"),
      conflicted,
    });
  }
  fields.files.sort((a, b) => a.path.localeCompare(b.path));
  return fields;
}

function parseWorktreeList(raw, maxItems) {
  const worktrees = [];
  let current = {};
  for (const record of raw.split("\0")) {
    if (!record) {
      if (current.path) worktrees.push(current);
      current = {};
      continue;
    }
    const separator = record.indexOf(" ");
    if (separator < 0) continue;
    const key = record.slice(0, separator);
    const value = record.slice(separator + 1);
    if (key === "worktree") current.path = path.normalize(value);
    else if (key === "HEAD") current.head = value;
    else if (key === "branch")
      current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
    else if (key === "locked") current.locked = value || true;
    else if (key === "prunable") current.prunable = value || true;
  }
  if (current.path) worktrees.push(current);
  return {
    items: worktrees.slice(0, maxItems),
    truncated: worktrees.length > maxItems,
  };
}

function parseGitLog(raw) {
  const items = [];
  const fields = raw.split("\0");
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [hash, author, date, subject] = fields.slice(index, index + 4);
    if (!hash) continue;
    items.push({ hash, author, date, subject });
  }
  return items;
}

export class GitWorkspaceService {
  constructor({
    authorizeProjectRoot,
    managedWorktreesRoot = null,
    getWorktreeOwnership = null,
    execFileImpl = execFile,
    spawnImpl = spawn,
    gitPath = "git",
    ghPath = "gh",
    platform = process.platform,
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (typeof authorizeProjectRoot !== "function")
      throw new TypeError("authorizeProjectRoot must be a function");
    if (managedWorktreesRoot !== null && typeof managedWorktreesRoot !== "string")
      throw new TypeError("managedWorktreesRoot must be an absolute path or null");
    if (
      getWorktreeOwnership !== null &&
      typeof getWorktreeOwnership !== "function"
    )
      throw new TypeError("getWorktreeOwnership must be a function or null");
    this.authorizeProjectRoot = authorizeProjectRoot;
    this.managedWorktreesRoot = managedWorktreesRoot;
    this.getWorktreeOwnership = getWorktreeOwnership;
    this.mutationChains = new Map();
    this.execFileImpl = execFileImpl;
    this.spawnImpl = spawnImpl;
    this.gitPath = gitPath;
    this.ghPath = ghPath;
    this.platform = platform;
    this.timeoutMs = timeoutMs;
    this.env = {
      ...env,
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
    };
    if (platform === "win32") this.env.NODEFAULTCURRENTDIRECTORYINEXEPATH = "1";
  }

  async status({ projectPath } = {}) {
    const root = await this.#resolveRepository(projectPath);
    if (!root) return this.#emptyRepositoryStatus();
    const parsed = await this.#statusAtRoot(root);
    const files = parsed.files.slice(0, MAX_STATUS_FILES);
    return {
      isGitRepository: true,
      root,
      branch: parsed.branch,
      head: parsed.head,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      detached: parsed.detached,
      dirty: parsed.files.length > 0,
      files,
      filesTruncated: parsed.files.length > files.length,
    };
  }

  async diff({ projectPath, path: filePath, staged = false } = {}) {
    if (typeof staged !== "boolean")
      throw new TypeError("staged must be a boolean");
    const relativePath = normalizeRelativePath(filePath);
    const root = await this.#resolveRepository(projectPath);
    if (!root) {
      return {
        isGitRepository: false,
        path: relativePath,
        staged,
        untracked: false,
        diffText: "",
        bytes: 0,
        truncated: false,
        maxBytes: MAX_DIFF_BYTES,
      };
    }
    await this.#assertSafeFilePath(root, relativePath);
    const status = await this.#statusAtRoot(root);
    const changed = status.files.find((file) => file.path === relativePath);
    const untracked = Boolean(changed?.untracked && !staged);
    const args = untracked
      ? [
          "--no-pager",
          "--literal-pathspecs",
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--unified=3",
          "--",
          "/dev/null",
          relativePath,
        ]
      : [
          "--no-pager",
          "--literal-pathspecs",
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--unified=3",
          ...(staged ? ["--cached"] : []),
          "--",
          relativePath,
        ];
    let diffText = "";
    let truncated = false;
    try {
      const result = await this.#runGit(root, args, "Git diff", {
        maxBuffer: MAX_DIFF_BYTES + 1024,
        allowExitCodes: untracked ? [1] : [],
        readOnly: true,
      });
      diffText = result.stdout;
    } catch (error) {
      if (error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
      diffText = safeUtf8Prefix(error.stdout ?? "", MAX_DIFF_BYTES);
      truncated = true;
    }
    if (Buffer.byteLength(diffText, "utf8") > MAX_DIFF_BYTES) {
      diffText = safeUtf8Prefix(diffText, MAX_DIFF_BYTES);
      truncated = true;
    }
    if (truncated) diffText += "\n… diff truncated at 512 KiB …\n";
    return {
      isGitRepository: true,
      path: relativePath,
      staged,
      untracked,
      diffText,
      bytes: Buffer.byteLength(diffText, "utf8"),
      truncated,
      maxBytes: MAX_DIFF_BYTES,
      ...(changed
        ? {
            indexStatus: changed.indexStatus,
            worktreeStatus: changed.worktreeStatus,
          }
        : {}),
    };
  }

  async log({ projectPath, limit = 30 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_LIMIT)
      throw new TypeError(`limit must be between 1 and ${MAX_LOG_LIMIT}`);
    const root = await this.#resolveRepository(projectPath);
    if (!root) return { isGitRepository: false, items: [] };
    let result;
    try {
      result = await this.#runGit(
        root,
        [
          "log",
          `--max-count=${limit}`,
          "--pretty=format:%H%x00%an%x00%aI%x00%s%x00",
        ],
        "Git history",
        { maxBuffer: 512 * 1024, readOnly: true },
      );
    } catch (error) {
      if (error.code === 128) return { isGitRepository: true, items: [] };
      throw error;
    }
    return { isGitRepository: true, items: parseGitLog(result.stdout) };
  }

  async stage({ projectPath, paths } = {}) {
    const root = await this.#requireRepository(projectPath);
    const safePaths = await this.#validateMutationPaths(root, paths);
    return this.#serializeMutation(root, async () => {
      // Narrow the TOCTOU window: re-verify repo identity immediately before
      // the mutation; the returned status verifies the actual index effect.
      await this.#verifyRepositoryIdentity(root);
      await this.#runGit(
        root,
        ["--literal-pathspecs", "add", "--", ...safePaths],
        "Git stage",
      );
      return this.status({ projectPath });
    });
  }

  async unstage({ projectPath, paths } = {}) {
    const root = await this.#requireRepository(projectPath);
    const safePaths = await this.#validateMutationPaths(root, paths);
    return this.#serializeMutation(root, async () => {
      await this.#verifyRepositoryIdentity(root);
      let hasHead = true;
      try {
        await this.#runGit(
          root,
          ["rev-parse", "--verify", "HEAD"],
          "Git head lookup",
          { readOnly: true },
        );
      } catch (error) {
        if (error.code === 128) hasHead = false;
        else throw error;
      }
      if (hasHead) {
        await this.#runGit(
          root,
          ["--literal-pathspecs", "restore", "--staged", "--", ...safePaths],
          "Git unstage",
        );
      } else {
        await this.#runGit(
          root,
          [
            "--literal-pathspecs",
            "rm",
            "--cached",
            "--ignore-unmatch",
            "--",
            ...safePaths,
          ],
          "Git unstage",
        );
      }
      return this.status({ projectPath });
    });
  }

  async stageHunk({ projectPath, path: filePath, header, lines } = {}) {
    return this.#applyHunk({ projectPath, filePath, header, lines, reverse: false });
  }

  async unstageHunk({ projectPath, path: filePath, header, lines } = {}) {
    return this.#applyHunk({ projectPath, filePath, header, lines, reverse: true });
  }

  async #applyHunk({ projectPath, filePath, header, lines, reverse }) {
    const relativePath = normalizeRelativePath(filePath);
    validateHunkInput(header, lines);
    const root = await this.#requireRepository(projectPath);
    await this.#assertSafeFilePath(root, relativePath);
    return this.#serializeMutation(root, async () => {
      await this.#verifyRepositoryIdentity(root);
      await this.#applyHunkLocked(root, projectPath, relativePath, header, lines, reverse);
      // Success of the call is not enough: return the verified index state.
      return this.status({ projectPath });
    });
  }

  async #applyHunkLocked(root, projectPath, relativePath, header, lines, reverse) {
    const staged = Boolean(reverse);
    const status = await this.#statusAtRoot(root);
    const changed = status.files.find((file) => file.path === relativePath);
    if (!changed) throw operationError("This file has no changes to apply");
    if (changed.untracked)
      throw operationError("Untracked files are staged whole, not by hunk");
    if (changed.conflicted)
      throw operationError("Resolve conflicts before staging individual hunks");
    if (changed.originalPath)
      throw operationError("Renamed files are staged whole, not by hunk");
    if (changed.deleted)
      throw operationError("Deleted files are staged whole, not by hunk");
    // Regenerate the authoritative diff at execution time. The requested hunk
    // must match a current hunk exactly or the diff is stale (concurrent
    // edits, index changed, CRLF normalization) and the apply is refused.
    const fresh = await this.#rawDiffAtRoot(root, relativePath, staged);
    if (fresh.truncated)
      throw operationError("This diff is too large to stage by hunk; stage the whole file");
    if (/^Binary files .* differ/m.test(fresh.diffText))
      throw operationError("Binary files are staged whole, not by hunk");
    const current = parseUnifiedHunks(fresh.diffText);
    const wanted = lines.join("\n");
    const match = current.some(
      (h) => h.header === header && h.lines.join("\n") === wanted,
    );
    if (!match)
      throw operationError(
        "This hunk no longer matches the repository. Refresh the diff and try again",
        "STALE_HUNK",
      );
    const patch =
      `diff --git a/${relativePath} b/${relativePath}\n` +
      `--- a/${relativePath}\n` +
      `+++ b/${relativePath}\n` +
      `${header}\n` +
      lines.join("\n") +
      "\n";
    // Structured args, shell:false (execFile), patch via stdin — no shell
    // interpolation of user content. git apply is atomic: on failure the
    // index is left unchanged.
    await this.#runGit(
      root,
      ["apply", "--cached", ...(reverse ? ["--reverse"] : []), "--unidiff-zero", "-"],
      reverse ? "Git unstage hunk" : "Git stage hunk",
      { input: patch, maxBuffer: MAX_COMMAND_OUTPUT_BYTES },
    );
  }

  async #rawDiffAtRoot(root, relativePath, staged) {
    const args = [
      "--no-pager",
      "--literal-pathspecs",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--unified=3",
      ...(staged ? ["--cached"] : []),
      "--",
      relativePath,
    ];
    let diffText = "";
    let truncated = false;
    try {
      const result = await this.#runGit(root, args, "Git diff", {
        maxBuffer: MAX_DIFF_BYTES + 1024,
        readOnly: true,
      });
      diffText = result.stdout;
    } catch (error) {
      if (error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
      diffText = safeUtf8Prefix(error.stdout ?? "", MAX_DIFF_BYTES);
      truncated = true;
    }
    if (Buffer.byteLength(diffText, "utf8") > MAX_DIFF_BYTES) {
      diffText = safeUtf8Prefix(diffText, MAX_DIFF_BYTES);
      truncated = true;
    }
    return { diffText, truncated };
  }

  async commit({ projectPath, message } = {}) {
    const root = await this.#requireRepository(projectPath);
    if (
      typeof message !== "string" ||
      message.trim().length === 0 ||
      message.length > 2000 ||
      message.includes("\0")
    ) {
      throw new TypeError(
        "Commit message must be between 1 and 2000 characters",
      );
    }
    return this.#serializeMutation(root, async () => {
      await this.#verifyRepositoryIdentity(root);
      await this.#runGit(root, ["commit", "-m", message], "Git commit");
      const head = await this.#runGit(
        root,
        ["rev-parse", "HEAD"],
        "Git commit lookup",
        { readOnly: true },
      );
      const summary = await this.#runGit(
        root,
        ["show", "-s", "--format=%s", "HEAD"],
        "Git commit lookup",
        { readOnly: true },
      );
      return {
        isGitRepository: true,
        hash: head.stdout.trim(),
        subject: summary.stdout.trim(),
      };
    });
  }

  async worktrees({ projectPath } = {}) {
    const root = await this.#resolveRepository(projectPath);
    if (!root) return { isGitRepository: false, items: [], truncated: false };
    const result = await this.#runGit(
      root,
      ["worktree", "list", "--porcelain", "-z"],
      "Git worktree list",
      { maxBuffer: 1024 * 1024, readOnly: true },
    );
    const listed = parseWorktreeList(result.stdout, MAX_WORKTREES);
    // Enrich with read-only per-worktree state (dirty, ahead/behind) so the
    // UI can show ownership-relevant status without a second round trip.
    // Details are capped: beyond MAX_WORKTREE_DETAILS the items stay listed
    // with unknown state rather than blocking the view on 100 spawns.
    const items = [];
    for (let index = 0; index < listed.items.length; index += 1) {
      const item = listed.items[index];
      if (index >= MAX_WORKTREE_DETAILS) {
        items.push({
          ...item,
          dirty: null,
          ahead: null,
          behind: null,
          usage: { state: "unknown", sessions: [] },
        });
        continue;
      }
      try {
        const details = await this.#worktreeDetails(item.path);
        const usage = await this.#worktreeUsageFor(item.path);
        items.push({ ...item, ...details, usage });
      } catch {
        items.push({
          ...item,
          dirty: null,
          ahead: null,
          behind: null,
          usage: { state: "unknown", sessions: [] },
        });
      }
    }
    return { isGitRepository: true, items, truncated: listed.truncated };
  }

  async #worktreeUsageFor(worktreePath) {
    // Read-only ownership snapshot for display. Never throws: listing must
    // stay available and report "unknown" rather than fail.
    try {
      if (typeof this.getWorktreeOwnership !== "function")
        return { state: "unknown", sessions: [] };
      let canonical;
      try {
        canonical = await realpath(worktreePath);
      } catch {
        return { state: "unknown", sessions: [] };
      }
      const usage = await this.getWorktreeOwnership(canonical);
      if (!usage || typeof usage !== "object" || usage.unknown)
        return { state: "unknown", sessions: [] };
      const sessions = (Array.isArray(usage.sessions) ? usage.sessions : [])
        .filter((s) => s && typeof s.sessionId === "string")
        .slice(0, 10)
        .map((s) => ({
          sessionId: s.sessionId,
          occupied: Boolean(s.occupied),
          attached: Boolean(s.attached),
          hasActiveTurn: Boolean(s.hasActiveTurn),
          hasPendingCallbacks: Boolean(s.hasPendingCallbacks),
          leaseHeld: Boolean(s.leaseHeld),
          readOnlyChild: Boolean(s.readOnlyChild),
        }));
      const state = sessions.some((s) => s.occupied)
        ? "occupied"
        : sessions.length > 0
          ? "idle"
          : "free";
      return { state, sessions: Object.freeze(sessions) };
    } catch {
      return { state: "unknown", sessions: [] };
    }
  }

  async #worktreeDetails(worktreePath) {
    const status = await this.#runGit(
      worktreePath,
      ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
      "Git worktree status",
      { maxBuffer: 512 * 1024, readOnly: true },
    );
    const parsed = parsePorcelainV2(status.stdout);
    const untracked = parsed.files.filter((f) => f.untracked).map((f) => f.path);
    return {
      dirty: parsed.files.length > 0,
      untrackedCount: untracked.length,
      untrackedSample: untracked.slice(0, 10),
      ahead: parsed.ahead,
      behind: parsed.behind,
      upstream: parsed.upstream,
      head: parsed.head,
    };
  }

  async #findListedWorktree(root, worktreePath) {
    if (
      typeof worktreePath !== "string" ||
      worktreePath.length < 1 ||
      worktreePath.length > MAX_PATH_LENGTH ||
      !path.isAbsolute(worktreePath)
    )
      throw new TypeError("A worktree path is required");
    const result = await this.#runGit(
      root,
      ["worktree", "list", "--porcelain", "-z"],
      "Git worktree list",
      { maxBuffer: 1024 * 1024, readOnly: true },
    );
    const listed = parseWorktreeList(result.stdout, MAX_WORKTREES);
    let canonicalWanted;
    try {
      canonicalWanted = await realpath(worktreePath);
    } catch {
      throw operationError("This worktree could not be identified with certainty");
    }
    for (const item of listed.items) {
      let canonicalItem;
      try {
        canonicalItem = await realpath(item.path);
      } catch {
        continue;
      }
      const same = this.platform === "win32"
        ? canonicalItem.toLowerCase() === canonicalWanted.toLowerCase()
        : canonicalItem === canonicalWanted;
      if (same) return { item, canonicalPath: canonicalItem, listed };
    }
    throw operationError("This worktree could not be identified with certainty");
  }

  #managedNamespaceFor(root) {
    // Deterministic per-repository namespace inside the app-managed space:
    // <managed>/<slug>-<sha1(root)[:12]>. Multi-repo safe (hash), readable
    // (slug), bounded (fixed depth). Never inside the checkout itself, so the
    // main repository never becomes dirty from a new checkout and agents
    // watching the tree never see foreign worktree files.
    const base = path.basename(root).replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 48) || "repo";
    const digest = createHash("sha1")
      .update(this.platform === "win32" ? root.toLowerCase() : root)
      .digest("hex")
      .slice(0, 12);
    return `${base}-${digest}`;
  }

  async createWorktree({ projectPath, branch, directory } = {}) {
    // Minimal local adapter: the Unified harness 2.26.1 exposes list/remove/
    // reap/prune but no creation RPC, so creation is a circumscribed
    // `git worktree add` in the app-managed space OUTSIDE the checkout
    // (userData/worktrees/<repo>-<hash>/<name>). Rationale: a checkout nested
    // inside the repository shows up as untracked noise in Changes, pollutes
    // agent file watches, and risks accidental commits of the link directory.
    // The shared .gitignore is never touched (too invasive); pre-existing
    // worktrees in any location keep working for list/remove. Never moves the
    // active session, never overwrites existing branches, never migrates or
    // deletes older worktrees.
    const root = await this.#requireRepository(projectPath);
    if (typeof this.managedWorktreesRoot !== "string" || !path.isAbsolute(this.managedWorktreesRoot))
      throw operationError("Worktree creation is unavailable in this installation");
    if (
      typeof branch !== "string" ||
      branch.length < 1 ||
      branch.length > 128 ||
      branch.includes("\0") ||
      branch.includes("..") ||
      branch.startsWith("-") ||
      branch.startsWith("/") ||
      !/^[A-Za-z0-9_./-]+$/.test(branch)
    )
      throw new TypeError("Worktree branch name is invalid");
    const name = typeof directory === "string" && directory ? directory : branch.replaceAll("/", "-");
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name))
      throw new TypeError("Worktree directory name is invalid");
    let managed;
    try {
      await mkdir(this.managedWorktreesRoot, { recursive: true });
      managed = await realpath(this.managedWorktreesRoot);
      const details = await stat(managed);
      if (!details.isDirectory()) throw new Error("not-directory");
    } catch {
      throw operationError("Worktree creation is unavailable in this installation");
    }
    const namespace = path.join(managed, this.#managedNamespaceFor(root));
    await mkdir(namespace, { recursive: true });
    const target = path.join(namespace, name);
    if (!inside(managed, target, this.platform) || target === namespace)
      throw new TypeError("Worktree directory is invalid");
    return this.#serializeMutation(root, async () => {
      await this.#verifyRepositoryIdentity(root);
      try {
        await stat(target);
        throw operationError("This worktree directory already exists");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      try {
        await this.#runGit(
          root,
          ["show-ref", "--verify", `refs/heads/${branch}`],
          "Git branch lookup",
          { readOnly: true },
        );
        throw operationError("This branch already exists; choose a new branch name");
      } catch (error) {
        if (error.code !== 128) throw error;
      }
      const headBefore = await this.#runGit(root, ["rev-parse", "HEAD"], "Git head lookup", { readOnly: true });
      await this.#runGit(
        root,
        ["worktree", "add", "--quiet", "-b", branch, "--", target],
        "Git worktree create",
      );
      // Verify the worktree really exists with the right branch, and that the
      // main checkout is untouched (same HEAD, no new debris inside it).
      const { item } = await this.#findListedWorktree(root, target);
      if (item.branch !== branch)
        throw operationError("The created worktree has an unexpected branch");
      const headAfter = await this.#runGit(root, ["rev-parse", "HEAD"], "Git head lookup", { readOnly: true });
      if (headBefore.stdout.trim() !== headAfter.stdout.trim())
        throw operationError("The main checkout changed during worktree creation");
      return this.worktrees({ projectPath });
    });
  }

  async #checkWorktreeOwnership(canonicalPath) {
    // Session/agent ownership gate: a checkout that is clean for Git can
    // still run an agent turn. Removal must not interrupt live work. The
    // ownership snapshot comes from the backend pool adapter (read-only);
    // this service never duplicates session state. Returns null when free,
    // otherwise a refusal reason. External processes outside the app's
    // control are undetectable — documented, and unknown state blocks.
    if (typeof this.getWorktreeOwnership !== "function")
      throw operationError(
        "Session ownership is unverifiable right now. Removal is blocked to protect running agents",
        "WORKTREE_OCCUPIED",
      );
    let usage;
    try {
      usage = await this.getWorktreeOwnership(canonicalPath);
    } catch {
      throw operationError(
        "Session ownership is unverifiable right now. Removal is blocked to protect running agents",
        "WORKTREE_OCCUPIED",
      );
    }
    if (!usage || typeof usage !== "object" || usage.unknown)
      throw operationError(
        "Session ownership is unverifiable right now. Removal is blocked to protect running agents",
        "WORKTREE_OCCUPIED",
      );
    const sessions = Array.isArray(usage.sessions) ? usage.sessions : [];
    const occupied = sessions.filter((s) => s && s.occupied);
    if (occupied.length > 0) {
      const summary = occupied
        .slice(0, 3)
        .map((s) => {
          const bits = [];
          if (s.hasActiveTurn) bits.push("active turn");
          if (s.hasPendingCallbacks) bits.push("waiting for you");
          if (s.leaseHeld) bits.push("used by another client");
          if (s.attached && !bits.length) bits.push("attached session");
          return `${String(s.sessionId ?? "session").slice(0, 8)} (${bits.join(", ") || "in use"})`;
        })
        .join("; ");
      throw operationError(
        `This worktree is used by ${occupied.length} session(s): ${summary}. Stop them explicitly first`,
        "WORKTREE_OCCUPIED",
      );
    }
    return sessions;
  }

  async removeWorktree({ projectPath, worktreePath } = {}) {
    // Safe removal only: no --force, no reset --hard, no clean -fd, no
    // generic directory deletion. Occupied, dirty, untracked, unpushed,
    // locked, main or uncertain worktrees are refused with the reason.
    const root = await this.#requireRepository(projectPath);
    const { item, canonicalPath } = await this.#findListedWorktree(root, worktreePath);
    return this.#serializeMutation(root, async () => {
      await this.#verifyRepositoryIdentity(root);
      // Re-identify after acquiring the lock: the checkout may have changed
      // while waiting (renamed filesystem, pruned metadata).
      const checked = await this.#findListedWorktree(root, canonicalPath);
      const currentPath = checked.canonicalPath;
      let canonicalRoot;
      try {
        canonicalRoot = await realpath(root);
      } catch {
        throw operationError("The selected project folder is unavailable");
      }
      const isMain = this.platform === "win32"
        ? currentPath.toLowerCase() === canonicalRoot.toLowerCase()
        : currentPath === canonicalRoot;
      if (isMain) throw operationError("The main checkout cannot be removed");
      if (checked.item.locked) throw operationError("This worktree is locked by Git");
      if (checked.item.bare) throw operationError("Bare repositories cannot be removed here");
      await this.#checkWorktreeOwnership(currentPath);
      const details = await this.#worktreeDetails(currentPath);
      if (details.untrackedCount > 0)
        throw operationError(
          `This worktree has ${details.untrackedCount} untracked file(s) (${details.untrackedSample.join(", ")}). Move or delete them explicitly first`,
          "WORKTREE_UNTRACKED",
        );
      if (details.dirty)
        throw operationError(
          "This worktree has uncommitted changes. Commit, stash or discard them explicitly first",
          "WORKTREE_DIRTY",
        );
      if (typeof details.ahead === "number" && details.ahead > 0)
        throw operationError(
          `This worktree is ${details.ahead} commit(s) ahead of its upstream. Push explicitly first`,
          "WORKTREE_UNPUSHED",
        );
      if (!details.upstream) {
        // No upstream: refuse when the worktree HEAD diverges from the main
        // checkout HEAD — those commits exist nowhere else we can verify.
        const mainHead = await this.#runGit(root, ["rev-parse", "HEAD"], "Git head lookup", { readOnly: true });
        const treeHead = await this.#runGit(currentPath, ["rev-parse", "HEAD"], "Git head lookup", { readOnly: true });
        if (mainHead.stdout.trim() !== treeHead.stdout.trim())
          throw operationError(
            "This worktree may contain commits that exist nowhere else (no upstream). Push or merge explicitly first",
            "WORKTREE_UNPUSHED",
          );
      }
      // Plain `git worktree remove` refuses dirty worktrees itself; with the
      // guards above it only removes clean, trackable checkouts.
      await this.#runGit(root, ["worktree", "remove", "--", currentPath], "Git worktree remove");
      return this.worktrees({ projectPath });
    });
  }

  async pruneWorktrees({ projectPath } = {}) {
    // Removes only stale worktree metadata (gitlink files pointing nowhere).
    // Never deletes real checkouts or user files.
    const root = await this.#requireRepository(projectPath);
    return this.#serializeMutation(root, async () => {
      await this.#verifyRepositoryIdentity(root);
      await this.#runGit(root, ["worktree", "prune"], "Git worktree prune");
      return this.worktrees({ projectPath });
    });
  }

  async listDirectory({ projectPath, dir } = {}) {
    // Read-only lazy tree listing. dir is repository-relative ("" or "." for
    // the root). .git is never listed. Symlink escapes are refused via the
    // same realpath identity check as Git mutations.
    const root = await this.#requireRepository(projectPath);
    const relativeDir = typeof dir === "string" && dir && dir !== "."
      ? normalizeRelativePath(dir)
      : "";
    let absolute = root;
    if (relativeDir) {
      absolute = await this.#assertSafePath(root, relativeDir);
      const details = await stat(absolute).catch((error) => {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
          throw operationError("This folder is unavailable");
        throw operationError("This folder could not be checked");
      });
      if (!details.isDirectory())
        throw new TypeError("Select a folder in the file explorer");
    }
    let names;
    try {
      names = await readdir(absolute, { withFileTypes: true });
    } catch {
      throw operationError("This folder could not be read");
    }
    const entries = [];
    for (const entry of names) {
      if (relativeDir === "" && entry.name === ".git") continue;
      if (entry.name === ".git" && relativeDir === "") continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      let safe;
      try {
        safe = normalizeRelativePath(relativePath);
      } catch {
        continue;
      }
      const isDir = entry.isDirectory();
      const isSymlink = entry.isSymbolicLink();
      let size = null;
      if (!isDir && !isSymlink) {
        try {
          size = (await stat(path.join(absolute, entry.name))).size;
        } catch {
          size = null;
        }
      }
      entries.push({
        name: entry.name,
        path: safe,
        kind: isDir ? "directory" : "file",
        symlink: isSymlink,
        ...(size !== null ? { size } : {}),
      });
      if (entries.length >= MAX_DIRECTORY_ENTRIES) break;
    }
    entries.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1,
    );
    return {
      isGitRepository: true,
      dir: relativeDir,
      entries,
      truncated: names.length > entries.length,
    };
  }

  async readFile({ projectPath, path: filePath } = {}) {
    // Read-only preview source. Never grants the file any Electron privilege:
    // the renderer displays returned text/data URLs without file:// access.
    // Binary, oversized and undecodable files get explicit messages.
    const relativePath = normalizeRelativePath(filePath);
    const root = await this.#requireRepository(projectPath);
    const absolute = await this.#assertSafeFilePath(root, relativePath);
    let details;
    try {
      details = await stat(absolute);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
        throw operationError("This file is unavailable");
      throw operationError("This file could not be checked");
    }
    if (details.isDirectory())
      throw new TypeError("Select individual files to preview");
    if (details.size > MAX_IMAGE_PREVIEW_BYTES)
      return {
        isGitRepository: true,
        path: relativePath,
        kind: "too-large",
        size: details.size,
        maxBytes: MAX_IMAGE_PREVIEW_BYTES,
      };
    const extension = path.extname(relativePath).toLowerCase();
    if (PREVIEWABLE_IMAGE_EXTENSIONS.has(extension)) {
      if (details.size > MAX_IMAGE_PREVIEW_BYTES)
        return { isGitRepository: true, path: relativePath, kind: "too-large", size: details.size, maxBytes: MAX_IMAGE_PREVIEW_BYTES };
      const buffer = await readFsFile(absolute);
      return {
        isGitRepository: true,
        path: relativePath,
        kind: "image",
        size: details.size,
        mime: extension === ".png" ? "image/png" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : extension === ".gif" ? "image/gif" : extension === ".bmp" ? "image/bmp" : "image/x-icon",
        base64: buffer.toString("base64"),
      };
    }
    const buffer = await readFsFile(absolute);
    const head = buffer.subarray(0, 8192);
    if (head.includes(0))
      return { isGitRepository: true, path: relativePath, kind: "binary", size: details.size };
    const truncated = buffer.length > MAX_PREVIEW_BYTES;
    const text = buffer.subarray(0, MAX_PREVIEW_BYTES).toString("utf8");
    return {
      isGitRepository: true,
      path: relativePath,
      kind: extension === ".md" || extension === ".markdown" ? "markdown" : extension === ".json" ? "json" : "text",
      size: details.size,
      text,
      truncated,
      maxBytes: MAX_PREVIEW_BYTES,
    };
  }

  async pullRequests({ projectPath } = {}) {
    const root = await this.#resolveRepository(projectPath);
    if (!root) return this.#emptyPullRequests();
    const repository = await this.#githubRepository(root);
    if (!repository)
      return {
        isGitRepository: true,
        available: false,
        authenticated: false,
        repository: null,
        items: [],
      };
    try {
      await this.#runGh(
        root,
        ["auth", "status", "--hostname", "github.com"],
        "GitHub authentication",
      );
    } catch (error) {
      if (error.code === "ENOENT")
        return {
          isGitRepository: true,
          available: false,
          authenticated: false,
          repository,
          items: [],
        };
      return {
        isGitRepository: true,
        available: true,
        authenticated: false,
        repository,
        items: [],
      };
    }
    const result = await this.#runGh(
      root,
      [
        "pr",
        "list",
        "--repo",
        repository,
        "--limit",
        String(MAX_PULL_REQUESTS),
        "--json",
        "number,title,state,url,headRefName,baseRefName,isDraft,reviewDecision",
      ],
      "GitHub pull requests",
    );
    let items;
    try {
      items = JSON.parse(result.stdout);
    } catch {
      throw operationError("GitHub returned invalid pull request data");
    }
    if (!Array.isArray(items))
      throw operationError("GitHub returned invalid pull request data");
    return {
      isGitRepository: true,
      available: true,
      authenticated: true,
      repository,
      items: items.slice(0, MAX_PULL_REQUESTS).map((item) => ({
        number: Number.isInteger(item.number) ? item.number : null,
        title: typeof item.title === "string" ? item.title.slice(0, 300) : "",
        state: typeof item.state === "string" ? item.state : "UNKNOWN",
        url: this.#validatePullRequestUrl(item.url, repository),
        headRefName:
          typeof item.headRefName === "string"
            ? item.headRefName.slice(0, 256)
            : "",
        baseRefName:
          typeof item.baseRefName === "string"
            ? item.baseRefName.slice(0, 256)
            : "",
        isDraft: Boolean(item.isDraft),
        reviewDecision:
          typeof item.reviewDecision === "string" ? item.reviewDecision : null,
      })),
    };
  }

  async pullRequestDetails({ projectPath, number } = {}) {
    // Read-only PR detail: files changed and check status for review. Never
    // pushes, merges or approves — opening the PR page stays explicit.
    if (!Number.isInteger(number) || number < 1 || number > 999999)
      throw new TypeError("Pull request number is invalid");
    const root = await this.#resolveRepository(projectPath);
    if (!root) throw operationError("The selected project is not a Git repository");
    const repository = await this.#githubRepository(root);
    if (!repository)
      throw operationError("The selected repository has no GitHub origin remote");
    try {
      await this.#runGh(root, ["auth", "status", "--hostname", "github.com"], "GitHub authentication");
    } catch {
      throw operationError("Authenticate the GitHub CLI to read pull request details");
    }
    const result = await this.#runGh(
      root,
      [
        "pr", "view", String(number),
        "--repo", repository,
        "--json",
        "number,title,state,url,headRefName,baseRefName,isDraft,reviewDecision,body,files,commits,statusCheckRollup",
      ],
      "GitHub pull request details",
    );
    let data;
    try {
      data = JSON.parse(result.stdout);
    } catch {
      throw operationError("GitHub returned invalid pull request data");
    }
    const files = Array.isArray(data.files) ? data.files.slice(0, 100).map((f) => ({
      path: typeof f?.path === "string" ? f.path.slice(0, 1024) : "",
      additions: Number.isInteger(f?.additions) ? f.additions : 0,
      deletions: Number.isInteger(f?.deletions) ? f.deletions : 0,
    })).filter((f) => f.path) : [];
    const checks = Array.isArray(data.statusCheckRollup)
      ? data.statusCheckRollup.slice(0, 50).map((c) => ({
          name: typeof c?.name === "string" ? c.name.slice(0, 256) : "check",
          status: typeof c?.status === "string" ? c.status : "UNKNOWN",
          conclusion: typeof c?.conclusion === "string" ? c.conclusion : null,
        }))
      : [];
    return {
      isGitRepository: true,
      repository,
      number: Number.isInteger(data.number) ? data.number : number,
      title: typeof data.title === "string" ? data.title.slice(0, 300) : "",
      state: typeof data.state === "string" ? data.state : "UNKNOWN",
      url: this.#validatePullRequestUrl(data.url, repository),
      headRefName: typeof data.headRefName === "string" ? data.headRefName.slice(0, 256) : "",
      baseRefName: typeof data.baseRefName === "string" ? data.baseRefName.slice(0, 256) : "",
      isDraft: Boolean(data.isDraft),
      reviewDecision: typeof data.reviewDecision === "string" ? data.reviewDecision : null,
      body: typeof data.body === "string" ? data.body.slice(0, 10000) : "",
      commits: Array.isArray(data.commits) ? data.commits.length : 0,
      files,
      filesTruncated: Array.isArray(data.files) && data.files.length > files.length,
      checks,
    };
  }

  async createPullRequest({
    projectPath,
    title,
    body,
    base,
    draft = false,
  } = {}) {
    const root = await this.#requireRepository(projectPath);
    const repository = await this.#githubRepository(root);
    if (!repository)
      throw operationError(
        "The selected repository has no GitHub origin remote",
      );
    if (
      typeof title !== "string" ||
      !title.trim() ||
      title.length > 256 ||
      title.includes("\0")
    )
      throw new TypeError(
        "Pull request title must be between 1 and 256 characters",
      );
    if (typeof body !== "string" || body.length > 50_000 || body.includes("\0"))
      throw new TypeError("Pull request body must be at most 50000 characters");
    if (
      base !== undefined &&
      (typeof base !== "string" || !/^[A-Za-z0-9_./-]{1,256}$/.test(base))
    )
      throw new TypeError("Pull request base branch is invalid");
    if (typeof draft !== "boolean")
      throw new TypeError("draft must be a boolean");

    const branch = await this.#runGit(
      root,
      ["branch", "--show-current"],
      "Git branch lookup",
      { readOnly: true },
    );
    const branchName = branch.stdout.trim();
    if (!branchName)
      throw operationError("A detached HEAD cannot create a pull request");
    let upstream;
    try {
      upstream = await this.#runGit(
        root,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        "Git upstream lookup",
        { readOnly: true },
      );
    } catch {
      throw operationError(
        "Push this branch to origin explicitly before creating a pull request",
      );
    }
    if (upstream.stdout.trim() !== `origin/${branchName}`)
      throw operationError(
        "Push this branch to origin explicitly before creating a pull request",
      );
    const ahead = await this.#runGit(
      root,
      ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      "Git upstream comparison",
      { readOnly: true },
    );
    const localAhead = Number(ahead.stdout.trim().split(/\s+/)[0]);
    if (!Number.isFinite(localAhead) || localAhead > 0)
      throw operationError(
        "Push this branch explicitly before creating a pull request",
      );
    const localHead = await this.#runGit(
      root,
      ["rev-parse", "HEAD"],
      "Git head lookup",
      { readOnly: true },
    );
    const remoteHead = await this.#runGit(
      root,
      ["ls-remote", "--heads", "origin", `refs/heads/${branchName}`],
      "Git remote branch lookup",
      { maxBuffer: 16 * 1024, readOnly: true },
    );
    const remoteObjectId = remoteHead.stdout.trim().split(/\s+/)[0];
    if (!remoteObjectId || remoteObjectId !== localHead.stdout.trim())
      throw operationError(
        "Push and synchronize this branch with origin explicitly before creating a pull request",
      );

    try {
      await this.#runGh(
        root,
        ["auth", "status", "--hostname", "github.com"],
        "GitHub authentication",
      );
    } catch {
      throw operationError(
        "Authenticate the GitHub CLI before creating a pull request",
      );
    }
    const args = [
      "pr",
      "create",
      "--repo",
      repository,
      "--head",
      branchName,
      "--title",
      title.trim(),
      "--body-file",
      "-",
    ];
    if (base) args.push("--base", base);
    if (draft) args.push("--draft");
    const result = await this.#spawnGh(root, args, body);
    const url = this.#validatePullRequestUrl(result.trim(), repository);
    if (!url)
      throw operationError("GitHub did not return a valid pull request URL");
    return { isGitRepository: true, url };
  }

  async #resolveRepository(projectPath) {
    requireProjectPath(projectPath);
    let authorizedRoot;
    try {
      authorizedRoot = await this.authorizeProjectRoot(projectPath);
    } catch {
      throw operationError("Project path has not been selected in this app");
    }
    if (typeof authorizedRoot !== "string" || !path.isAbsolute(authorizedRoot))
      throw operationError("The selected project path is invalid");
    let root;
    try {
      root = await realpath(authorizedRoot);
      const details = await stat(root);
      if (!details.isDirectory()) throw new Error("not-directory");
    } catch {
      throw operationError("The selected project folder is unavailable");
    }
    let topLevel;
    try {
      const result = await this.#runGit(
        root,
        ["rev-parse", "--show-toplevel"],
        "Git repository lookup",
        { readOnly: true },
      );
      topLevel = await realpath(result.stdout.trim());
    } catch (error) {
      if (error.code === 128) return null;
      throw error;
    }
    // The authorized root must be the repository (or linked-worktree) root
    // itself. A sibling worktree checked out beside the main repository is a
    // legitimate independent workspace: it is allowed only when the user
    // explicitly selects that worktree folder, which then resolves to its own
    // top level here. Operating on a sibling through the main root is never
    // allowed — mutations only accept repository-relative paths.
    if (
      !inside(root, topLevel, this.platform) ||
      !inside(topLevel, root, this.platform)
    )
      throw operationError(
        "Select the Git repository root to use its workspace",
      );
    return root;
  }

  async #requireRepository(projectPath) {
    const root = await this.#resolveRepository(projectPath);
    if (!root)
      throw operationError(
        "The selected project is not a Git repository",
        "NOT_GIT_REPOSITORY",
      );
    return root;
  }

  rootKey(root) {
    return this.platform === "win32" ? root.toLowerCase() : root;
  }

  async #serializeMutation(root, operation) {
    // Mutations on the same repository/index run one at a time so concurrent
    // stage/hunk/commit calls cannot interleave against the same index.lock.
    // Reads stay fully concurrent; different repositories are independent.
    const key = this.rootKey(root);
    const previous = this.mutationChains.get(key) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.mutationChains.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationChains.get(key) === tail)
        this.mutationChains.delete(key);
    }
  }

  async #statusAtRoot(root) {
    const result = await this.#runGit(
      root,
      ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
      "Git status",
      { maxBuffer: MAX_COMMAND_OUTPUT_BYTES, readOnly: true },
    );
    return parsePorcelainV2(result.stdout);
  }

  async #assertSafePath(root, relativePath) {
    const safePath = normalizeRelativePath(relativePath);
    const absolute = path.resolve(root, ...safePath.split("/"));
    if (!inside(root, absolute, this.platform) || absolute === root)
      throw new TypeError("File path cannot leave the selected repository");
    let cursor = absolute;
    while (true) {
      try {
        const canonical = await realpath(cursor);
        if (!inside(root, canonical, this.platform))
          throw new TypeError(
            "File path resolves outside the selected repository",
          );
        break;
      } catch (error) {
        if (error instanceof TypeError) throw error;
        if (!isMissingPath(error))
          throw operationError("File path could not be checked");
        const parent = path.dirname(cursor);
        if (parent === cursor)
          throw operationError("File path could not be checked");
        cursor = parent;
      }
    }
    return absolute;
  }

  async #verifyRepositoryIdentity(root) {
    // TOCTOU mitigation: the .git directory / worktree link could be swapped
    // between #resolveRepository and a mutation. Re-resolve the top level
    // immediately before mutating and refuse when the identity changed.
    let topLevel;
    try {
      const result = await this.#runGit(
        root,
        ["rev-parse", "--show-toplevel"],
        "Git repository lookup",
        { readOnly: true },
      );
      topLevel = await realpath(result.stdout.trim());
    } catch (error) {
      throw operationError("The selected Git repository changed during the operation");
    }
    if (
      !inside(root, topLevel, this.platform) ||
      !inside(topLevel, root, this.platform)
    )
      throw operationError("The selected Git repository changed during the operation");
    return root;
  }

  async #assertSafeFilePath(root, relativePath) {
    const absolute = await this.#assertSafePath(root, relativePath);
    try {
      // stat follows symlinks: a symlink pointing to a directory is still a
      // directory selection and is rejected. Missing paths (new files) pass.
      if ((await stat(absolute)).isDirectory())
        throw new TypeError("Select individual files in the Git workspace");
    } catch (error) {
      if (error instanceof TypeError) throw error;
      if (!isMissingPath(error))
        throw operationError("File path could not be checked");
    }
    return absolute;
  }

  async #validateMutationPaths(root, paths) {
    if (
      !Array.isArray(paths) ||
      paths.length < 1 ||
      paths.length > MAX_PATHS_PER_MUTATION
    )
      throw new TypeError(
        `paths must contain between 1 and ${MAX_PATHS_PER_MUTATION} files`,
      );
    const unique = new Set();
    const safePaths = [];
    for (const input of paths) {
      const relativePath = normalizeRelativePath(input);
      await this.#assertSafeFilePath(root, relativePath);
      if (!unique.has(relativePath)) {
        unique.add(relativePath);
        safePaths.push(relativePath);
      }
    }
    return safePaths;
  }

  async #githubRepository(root) {
    let remote;
    try {
      const result = await this.#runGit(
        root,
        ["remote", "get-url", "origin"],
        "Git remote lookup",
        { readOnly: true },
      );
      remote = result.stdout.trim();
    } catch (error) {
      if (error.code === 2 || error.code === 128) return null;
      throw error;
    }
    return parseGitHubRepository(remote);
  }

  async #runGit(
    root,
    args,
    label,
    {
      maxBuffer = MAX_COMMAND_OUTPUT_BYTES,
      allowExitCodes = [],
      input,
      readOnly = false,
    } = {},
  ) {
    const commandArgs = readOnly
      ? ["-c", "core.fsmonitor=false", ...args]
      : args;
    return this.#runExecFile(this.gitPath, commandArgs, root, label, {
      maxBuffer,
      allowExitCodes,
      input,
    });
  }

  async #runGh(root, args, label) {
    return this.#runExecFile(this.ghPath, args, root, label, {
      maxBuffer: 1024 * 1024,
    });
  }

  async #runExecFile(
    command,
    args,
    cwd,
    label,
    { maxBuffer, allowExitCodes = [], input } = {},
  ) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => {
        child?.kill();
        finish(reject, operationError(`${label} timed out`, "ETIMEDOUT"));
      }, this.timeoutMs);
      timer.unref?.();
      let child;
      try {
        child = this.execFileImpl(
          command,
          args,
          {
            cwd,
            env: this.env,
            windowsHide: true,
            timeout: this.timeoutMs,
            maxBuffer,
            encoding: "utf8",
          },
          (error, stdout = "", stderr = "") => {
            const output = String(stdout ?? "");
            if (
              !error ||
              (Number.isInteger(error.code) &&
                allowExitCodes.includes(error.code))
            ) {
              finish(resolve, { stdout: output, stderr: "" });
              return;
            }
            const mapped = operationError(`${label} failed`, error.code);
            if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
              mapped.stdout = output;
            finish(reject, mapped);
          },
        );
        if (input !== undefined && child?.stdin) child.stdin.end(input, "utf8");
      } catch (error) {
        finish(reject, operationError(`${label} failed`, error?.code));
      }
    });
  }

  async #spawnGh(root, args, input) {
    return new Promise((resolve, reject) => {
      let child;
      let timer;
      let settled = false;
      const output = [];
      let outputBytes = 0;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      try {
        child = this.spawnImpl(this.ghPath, args, {
          cwd: root,
          env: this.env,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        finish(
          reject,
          operationError("GitHub pull request creation failed", error?.code),
        );
        return;
      }
      timer = setTimeout(() => {
        child.kill();
        finish(
          reject,
          operationError("GitHub pull request creation timed out", "ETIMEDOUT"),
        );
      }, this.timeoutMs);
      timer.unref?.();
      child.stdout.on("data", (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > 16 * 1024) {
          child.kill();
          finish(
            reject,
            operationError(
              "GitHub pull request response exceeded the size limit",
            ),
          );
          return;
        }
        output.push(Buffer.from(chunk));
      });
      // Drain stderr without retaining it; CLI diagnostics can expose local or remote details.
      child.stderr.on("data", () => {});
      child.once("error", (error) =>
        finish(
          reject,
          operationError("GitHub pull request creation failed", error?.code),
        ),
      );
      child.once("close", (code) => {
        if (code === 0) finish(resolve, Buffer.concat(output).toString("utf8"));
        else
          finish(
            reject,
            operationError("GitHub pull request creation failed", code),
          );
      });
      child.stdin.end(input, "utf8");
    });
  }

  #validatePullRequestUrl(rawUrl, repository) {
    if (typeof rawUrl !== "string" || rawUrl.length > 2048) return null;
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    const [owner, repo, section, number] = url.pathname
      .split("/")
      .filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.search ||
      url.hash ||
      `${owner}/${repo}`.toLowerCase() !== repository.toLowerCase() ||
      section !== "pull" ||
      !/^\d+$/.test(number ?? "")
    ) {
      return null;
    }
    return `https://github.com/${owner}/${repo}/pull/${number}`;
  }

  #emptyRepositoryStatus() {
    return {
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
    };
  }

  #emptyPullRequests() {
    return {
      isGitRepository: false,
      available: false,
      authenticated: false,
      repository: null,
      items: [],
    };
  }
}

function isMissingPath(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}
