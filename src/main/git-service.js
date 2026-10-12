import { execFile, spawn } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_STATUS_FILES = 500;
const MAX_PATHS_PER_MUTATION = 200;
const MAX_PATH_LENGTH = 4096;
const MAX_LOG_LIMIT = 100;
const MAX_WORKTREES = 100;
const MAX_PULL_REQUESTS = 30;
const GITHUB_OWNER_OR_REPO = /^[A-Za-z0-9_.-]+$/;

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
  if (portable.startsWith("/") || /^[A-Za-z]:/.test(portable)) {
    throw new TypeError(
      "File path must be relative to the selected repository",
    );
  }
  const pieces = portable.split("/");
  if (pieces.some((piece) => piece === "..")) {
    throw new TypeError("File path cannot leave the selected repository");
  }
  const normalized = pieces.filter((piece) => piece && piece !== ".");
  if (
    normalized.length === 0 ||
    normalized.some((piece) => piece.toLowerCase() === ".git")
  ) {
    throw new TypeError("File path is not available to the Git workspace");
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
    this.authorizeProjectRoot = authorizeProjectRoot;
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
    await this.#runGit(
      root,
      ["--literal-pathspecs", "add", "--", ...safePaths],
      "Git stage",
    );
    return this.status({ projectPath });
  }

  async unstage({ projectPath, paths } = {}) {
    const root = await this.#requireRepository(projectPath);
    const safePaths = await this.#validateMutationPaths(root, paths);
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
    return {
      isGitRepository: true,
      ...parseWorktreeList(result.stdout, MAX_WORKTREES),
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

  async #assertSafeFilePath(root, relativePath) {
    const absolute = await this.#assertSafePath(root, relativePath);
    try {
      if ((await lstat(absolute)).isDirectory())
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
