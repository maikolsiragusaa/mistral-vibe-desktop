import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowUpRight,
  Check,
  Clock3,
  ExternalLink,
  FileCode2,
  GitBranch,
  GitPullRequest,
  History,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  ShieldAlert,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import "./git-workspace.css";

type GitTab = "changes" | "history" | "worktrees" | "pull-requests";

interface GitFile {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  deleted: boolean;
  conflicted: boolean;
}

interface GitStatus {
  isGitRepository: boolean;
  root?: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached?: boolean;
  dirty: boolean;
  files: GitFile[];
  filesTruncated: boolean;
}

interface GitDiff {
  isGitRepository: boolean;
  path: string;
  staged: boolean;
  untracked: boolean;
  diffText: string;
  bytes: number;
  truncated: boolean;
  maxBytes: number;
  indexStatus?: string;
  worktreeStatus?: string;
}

interface GitLogItem {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

interface GitWorktree {
  path: string;
  head?: string;
  branch?: string;
  detached?: boolean;
  bare?: boolean;
  locked?: string | boolean;
  prunable?: string | boolean;
}

interface PullRequest {
  number: number | null;
  title: string;
  state: string;
  url: string | null;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  reviewDecision: string | null;
}

interface PullRequestState {
  isGitRepository: boolean;
  available: boolean;
  authenticated: boolean;
  repository: string | null;
  items: PullRequest[];
}

export interface GitWorkspaceProps {
  projectPath: string;
  /** Paths observed in actual Vibe agent file-write effects, when available. */
  agentPaths?: string[];
  initialPaths?: string[];
  onError?: (message: string) => void;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

function projectRelativePath(
  value: string,
  projectPath: string,
): string | null {
  const candidate = normalizePath(value).replace(/\/$/, "");
  const root = normalizePath(projectPath).replace(/\/$/, "");
  if (candidate === root) return null;
  if (candidate.startsWith(`${root}/`)) return candidate.slice(root.length + 1);
  if (/^[a-z]:\//.test(candidate) || candidate.startsWith("/")) return null;
  return candidate;
}

function shortHash(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 8) : "—";
}

function fileStateLabel(
  file: GitFile,
  baseline: Set<string>,
  agentPaths: Set<string>,
) {
  const key = normalizePath(file.path);
  if (baseline.has(key)) return "Pre-existing";
  if (agentPaths.has(key)) return "Agent touched";
  return "New change · source unknown";
}

function diffKind(line: string): string {
  if (line.startsWith("diff --git ") || line.startsWith("index "))
    return "meta";
  if (line.startsWith("--- ") || line.startsWith("+++ ")) return "file";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  if (line.startsWith("\\ No newline")) return "meta";
  return "context";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function gitRequest<T>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  if (!window.vibe?.git)
    throw new Error("The local Git workspace bridge is unavailable.");
  return window.vibe.git<T>(method, params);
}

export function GitWorkspace({
  projectPath,
  agentPaths = [],
  initialPaths,
  onError,
}: GitWorkspaceProps) {
  const [tab, setTab] = useState<GitTab>("changes");
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showStagedDiff, setShowStagedDiff] = useState(false);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [history, setHistory] = useState<GitLogItem[] | null>(null);
  const [worktrees, setWorktrees] = useState<GitWorktree[] | null>(null);
  const [pullRequests, setPullRequests] = useState<PullRequestState | null>(
    null,
  );
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [loadingTab, setLoadingTab] = useState(false);
  const [working, setWorking] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prBase, setPrBase] = useState("");
  const [prDraft, setPrDraft] = useState(false);
  const [createdPrUrl, setCreatedPrUrl] = useState<string | null>(null);
  const [showPrDialog, setShowPrDialog] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [diffRevision, setDiffRevision] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [worktreeRevision, setWorktreeRevision] = useState(0);
  const [prRevision, setPrRevision] = useState(0);
  const baseline = useRef<Set<string> | null>(null);
  const projectGeneration = useRef(0);
  const diffGeneration = useRef(0);
  const prDialog = useRef<HTMLDialogElement>(null);

  const agentPathSet = useMemo(
    () =>
      new Set(
        agentPaths
          .map((value) => projectRelativePath(value, projectPath))
          .filter((value): value is string => Boolean(value)),
      ),
    [agentPaths, projectPath],
  );
  const stagedCount = status?.files.filter((file) => file.staged).length ?? 0;
  const changesCount = status?.files.length ?? 0;
  const selectedFile = status?.files.find((file) => file.path === selectedPath);
  const baselinePaths = baseline.current ?? new Set<string>();

  const reportError = useCallback(
    (message: string) => {
      setError(message);
      setNotice("");
      onError?.(message);
    },
    [onError],
  );

  const acceptStatus = useCallback(
    (next: GitStatus, captureBaseline = false) => {
      if (captureBaseline && baseline.current === null) {
        baseline.current = new Set(
          next.files.map((file) => normalizePath(file.path)),
        );
      }
      setStatus(next);
      setSelectedPath((current) => {
        if (current && next.files.some((file) => file.path === current))
          return current;
        return next.files[0]?.path ?? null;
      });
    },
    [],
  );

  const loadStatus = useCallback(
    async (captureBaseline = false, generation = projectGeneration.current) => {
      setLoadingStatus(true);
      try {
        const next = await gitRequest<GitStatus>("status", { projectPath });
        if (generation !== projectGeneration.current) return;
        baseline.current ??= captureBaseline
          ? new Set(next.files.map((file) => normalizePath(file.path)))
          : null;
        acceptStatus(next, captureBaseline);
        setError("");
      } catch (reason) {
        if (generation === projectGeneration.current)
          reportError(errorMessage(reason));
      } finally {
        if (generation === projectGeneration.current) setLoadingStatus(false);
      }
    },
    [acceptStatus, projectPath, reportError],
  );

  useEffect(() => {
    const generation = ++projectGeneration.current;
    baseline.current = initialPaths
      ? new Set(initialPaths.map(normalizePath))
      : null;
    setStatus(null);
    setSelectedPath(null);
    setShowStagedDiff(false);
    setDiff(null);
    setHistory(null);
    setWorktrees(null);
    setPullRequests(null);
    setCreatedPrUrl(null);
    setError("");
    setNotice("");
    setLoadingStatus(true);
    void loadStatus(true, generation);
    return () => {
      projectGeneration.current += 1;
    };
  }, [loadStatus, projectPath]);

  useEffect(() => {
    const generation = ++diffGeneration.current;
    if (!status?.isGitRepository || !selectedPath) {
      setDiff(null);
      setLoadingDiff(false);
      return () => {
        diffGeneration.current += 1;
      };
    }
    setLoadingDiff(true);
    void gitRequest<GitDiff>("diff", {
      projectPath,
      path: selectedPath,
      staged: showStagedDiff,
    })
      .then((next) => {
        if (generation === diffGeneration.current) setDiff(next);
      })
      .catch((reason) => {
        if (generation === diffGeneration.current)
          reportError(errorMessage(reason));
      })
      .finally(() => {
        if (generation === diffGeneration.current) setLoadingDiff(false);
      });
    return () => {
      diffGeneration.current += 1;
    };
  }, [
    diffRevision,
    projectPath,
    reportError,
    selectedPath,
    showStagedDiff,
    status?.isGitRepository,
  ]);

  useEffect(() => {
    if (tab !== "history") return;
    let active = true;
    setLoadingTab(true);
    void gitRequest<{ isGitRepository: boolean; items: GitLogItem[] }>("log", {
      projectPath,
      limit: 50,
    })
      .then((result) => {
        if (active) setHistory(result.items ?? []);
      })
      .catch((reason) => active && reportError(errorMessage(reason)))
      .finally(() => active && setLoadingTab(false));
    return () => {
      active = false;
    };
  }, [historyRevision, projectPath, reportError, tab]);

  useEffect(() => {
    if (tab !== "worktrees") return;
    let active = true;
    setLoadingTab(true);
    void gitRequest<{ isGitRepository: boolean; items: GitWorktree[] }>(
      "worktrees",
      { projectPath },
    )
      .then((result) => {
        if (active) setWorktrees(result.items ?? []);
      })
      .catch((reason) => active && reportError(errorMessage(reason)))
      .finally(() => active && setLoadingTab(false));
    return () => {
      active = false;
    };
  }, [projectPath, reportError, tab, worktreeRevision]);

  useEffect(() => {
    if (tab !== "pull-requests") return;
    let active = true;
    setLoadingTab(true);
    void gitRequest<PullRequestState>("pullRequests", { projectPath })
      .then((result) => {
        if (active) setPullRequests(result);
      })
      .catch((reason) => active && reportError(errorMessage(reason)))
      .finally(() => active && setLoadingTab(false));
    return () => {
      active = false;
    };
  }, [prRevision, projectPath, reportError, tab]);

  const refresh = async () => {
    setNotice("");
    await loadStatus(false);
  };

  const mutateFile = async (method: "stage" | "unstage", filePath: string) => {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const result = await gitRequest<GitStatus>(method, {
        projectPath,
        paths: [filePath],
      });
      acceptStatus(result);
      if (selectedPath === filePath) setShowStagedDiff(method === "stage");
      setDiffRevision((revision) => revision + 1);
      setNotice(method === "stage" ? "File staged." : "File unstaged.");
    } catch (reason) {
      reportError(errorMessage(reason));
    } finally {
      setWorking(false);
    }
  };

  const createCommit = async () => {
    const message = commitMessage.trim();
    if (!message || stagedCount === 0) return;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const result = await gitRequest<{ hash: string; subject: string }>(
        "commit",
        { projectPath, message },
      );
      setCommitMessage("");
      setNotice(`Committed ${shortHash(result.hash)} · ${result.subject}`);
      setHistory(null);
      setHistoryRevision((revision) => revision + 1);
      setDiffRevision((revision) => revision + 1);
      await loadStatus(false);
    } catch (reason) {
      reportError(errorMessage(reason));
    } finally {
      setWorking(false);
    }
  };

  const openPrDialog = () => {
    setPrTitle("");
    setPrBody("");
    setPrBase("");
    setPrDraft(false);
    setError("");
    prDialog.current?.showModal();
    setShowPrDialog(true);
  };

  const closePrDialog = () => {
    if (prDialog.current?.open) prDialog.current.close();
    setShowPrDialog(false);
  };

  const createPullRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!prTitle.trim()) return;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const result = await gitRequest<{ url: string }>("createPullRequest", {
        projectPath,
        title: prTitle,
        body: prBody,
        ...(prBase.trim() ? { base: prBase.trim() } : {}),
        draft: prDraft,
      });
      setCreatedPrUrl(result.url);
      setNotice("Pull request created. Review it in your browser when ready.");
      closePrDialog();
      setPrRevision((revision) => revision + 1);
    } catch (reason) {
      reportError(errorMessage(reason));
    } finally {
      setWorking(false);
    }
  };

  const openExternal = async (url: string) => {
    if (!window.vibe?.openExternal) {
      reportError("The secure browser bridge is unavailable.");
      return;
    }
    try {
      await window.vibe.openExternal(url);
    } catch (reason) {
      reportError(errorMessage(reason));
    }
  };

  const tabs: {
    id: GitTab;
    label: string;
    icon: LucideIcon;
    count?: number;
  }[] = [
    { id: "changes", label: "Changes", icon: FileCode2, count: changesCount },
    { id: "history", label: "History", icon: History },
    { id: "worktrees", label: "Worktrees", icon: Workflow },
    { id: "pull-requests", label: "Pull requests", icon: GitPullRequest },
  ];

  return (
    <section className="git-workspace" aria-label="Git workspace">
      <header className="git-workspace__header">
        <div className="git-workspace__heading">
          <div className="git-workspace__mark" aria-hidden="true">
            <GitBranch size={17} />
          </div>
          <div className="git-workspace__heading-copy">
            <div className="git-workspace__eyebrow">REPOSITORY</div>
            <h1>Git workspace</h1>
          </div>
        </div>
        <div className="git-workspace__repo-state">
          {status?.isGitRepository ? (
            <>
              <span className="git-workspace__branch">
                <GitBranch size={14} />
                {status.branch ??
                  (status.detached ? "Detached HEAD" : "Unborn branch")}
              </span>
              {status.ahead > 0 && (
                <span className="git-workspace__sync">↑ {status.ahead}</span>
              )}
              {status.behind > 0 && (
                <span className="git-workspace__sync">↓ {status.behind}</span>
              )}
              <span
                className={
                  status.dirty ? "git-workspace__dirty" : "git-workspace__clean"
                }
              >
                <span className="git-workspace__status-dot" />
                {status.dirty ? `${changesCount} changed` : "Clean"}
              </span>
            </>
          ) : (
            <span className="git-workspace__clean">
              {loadingStatus ? "Checking repository…" : "No Git repository"}
            </span>
          )}
          <button
            type="button"
            className="git-workspace__icon-button"
            onClick={() => void refresh()}
            disabled={loadingStatus || working}
            aria-label="Refresh Git status"
            title="Refresh Git status"
          >
            <RefreshCw
              size={15}
              className={loadingStatus ? "git-workspace__spin" : ""}
            />
          </button>
        </div>
      </header>

      {error && (
        <div
          className="git-workspace__message git-workspace__message--error"
          role="alert"
        >
          <ShieldAlert size={16} />
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError("")}
            aria-label="Dismiss error"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {notice && (
        <div
          className="git-workspace__message"
          role="status"
          aria-live="polite"
        >
          <Check size={15} />
          <span>{notice}</span>
          {createdPrUrl && (
            <button
              type="button"
              className="git-workspace__inline-link"
              onClick={() => void openExternal(createdPrUrl)}
            >
              Open pull request <ExternalLink size={13} />
            </button>
          )}
        </div>
      )}

      {!status?.isGitRepository ? (
        <div className="git-workspace__empty">
          <div className="git-workspace__empty-mark" aria-hidden="true">
            <GitBranch size={25} />
          </div>
          <h2>
            {loadingStatus
              ? "Reading repository status"
              : "This project has no Git repository"}
          </h2>
          <p>
            {loadingStatus
              ? "The selected folder is being checked locally."
              : "Select the repository root folder to inspect file changes, history, worktrees, and pull requests."}
          </p>
          {!loadingStatus && (
            <button
              type="button"
              className="git-workspace__button git-workspace__button--quiet"
              onClick={() => void refresh()}
            >
              <RefreshCw size={14} /> Try again
            </button>
          )}
        </div>
      ) : (
        <>
          <nav
            className="git-workspace__tabs"
            role="tablist"
            aria-label="Git views"
          >
            {tabs.map(({ id, label, icon: Icon, count }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                aria-controls={`git-panel-${id}`}
                id={`git-tab-${id}`}
                className={
                  tab === id
                    ? "git-workspace__tab is-active"
                    : "git-workspace__tab"
                }
                onClick={() => setTab(id)}
              >
                <Icon size={15} />
                <span>{label}</span>
                {count !== undefined && (
                  <span className="git-workspace__tab-count">{count}</span>
                )}
              </button>
            ))}
            <div className="git-workspace__tab-spacer" />
            <span
              className="git-workspace__head-label"
              title={status.head ?? "No commit yet"}
            >
              {shortHash(status.head)}
            </span>
          </nav>

          <div
            className="git-workspace__panel"
            role="tabpanel"
            id={`git-panel-${tab}`}
            aria-labelledby={`git-tab-${tab}`}
          >
            {tab === "changes" && (
              <div className="git-workspace__changes">
                <aside
                  className="git-workspace__file-pane"
                  aria-label="Changed files"
                >
                  <div className="git-workspace__pane-heading">
                    <div>
                      <span className="git-workspace__eyebrow">
                        WORKING TREE
                      </span>
                      <h2>Changed files</h2>
                    </div>
                    <span className="git-workspace__count-pill">
                      {changesCount}
                    </span>
                  </div>
                  <p className="git-workspace__attribution-help">
                    Baseline captured on open. Agent tags reflect observed Vibe
                    writes; other new changes have unknown source.
                  </p>
                  {status.filesTruncated && (
                    <p className="git-workspace__limit-note">
                      Showing the first 500 changed paths.
                    </p>
                  )}
                  <div className="git-workspace__file-list" role="list">
                    {status.files.map((file) => {
                      const selected = selectedPath === file.path;
                      const label = fileStateLabel(
                        file,
                        baselinePaths,
                        agentPathSet,
                      );
                      return (
                        <article
                          key={file.path}
                          role="listitem"
                          className={
                            selected
                              ? "git-workspace__file is-selected"
                              : "git-workspace__file"
                          }
                        >
                          <button
                            type="button"
                            className="git-workspace__file-select"
                            aria-pressed={selected}
                            onClick={() => {
                              setSelectedPath(file.path);
                              setShowStagedDiff(false);
                            }}
                            title={file.path}
                          >
                            <FileCode2 size={15} />
                            <span className="git-workspace__file-name">
                              {file.path}
                            </span>
                            <span
                              className={
                                file.conflicted
                                  ? "git-workspace__file-badge is-conflict"
                                  : "git-workspace__file-badge"
                              }
                            >
                              {file.untracked
                                ? "U"
                                : `${file.indexStatus}${file.worktreeStatus}`}
                            </span>
                          </button>
                          <div className="git-workspace__file-meta">
                            <span
                              className={`git-workspace__origin git-workspace__origin--${label === "Pre-existing" ? "old" : label === "Agent touched" ? "agent" : "unknown"}`}
                            >
                              {label}
                            </span>
                            <span className="git-workspace__file-actions">
                              {(file.unstaged || file.untracked) && (
                                <button
                                  type="button"
                                  className="git-workspace__mini-button"
                                  onClick={() =>
                                    void mutateFile("stage", file.path)
                                  }
                                  disabled={working}
                                  title={`Stage ${file.path}`}
                                  aria-label={`Stage ${file.path}`}
                                >
                                  <Plus size={13} /> Stage
                                </button>
                              )}
                              {file.staged && (
                                <button
                                  type="button"
                                  className="git-workspace__mini-button"
                                  onClick={() =>
                                    void mutateFile("unstage", file.path)
                                  }
                                  disabled={working}
                                  title={`Unstage ${file.path}`}
                                  aria-label={`Unstage ${file.path}`}
                                >
                                  <Minus size={13} /> Unstage
                                </button>
                              )}
                            </span>
                          </div>
                        </article>
                      );
                    })}
                    {!status.files.length && !loadingStatus && (
                      <div className="git-workspace__list-empty">
                        <Check size={18} />
                        <span>No changed files</span>
                      </div>
                    )}
                  </div>
                  {stagedCount > 0 && (
                    <form
                      className="git-workspace__commit"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void createCommit();
                      }}
                    >
                      <label htmlFor="git-commit-message">
                        Commit staged changes <span>{stagedCount}</span>
                      </label>
                      <textarea
                        id="git-commit-message"
                        value={commitMessage}
                        onChange={(event) =>
                          setCommitMessage(event.target.value)
                        }
                        maxLength={2000}
                        rows={3}
                        placeholder="Describe this commit"
                        disabled={working}
                      />
                      <button
                        type="submit"
                        className="git-workspace__button git-workspace__button--primary"
                        disabled={working || !commitMessage.trim()}
                      >
                        {working ? (
                          <LoaderCircle
                            size={14}
                            className="git-workspace__spin"
                          />
                        ) : (
                          <Check size={14} />
                        )}
                        Commit staged files
                      </button>
                    </form>
                  )}
                </aside>

                <section
                  className="git-workspace__diff-pane"
                  aria-label="Selected file diff"
                >
                  <div className="git-workspace__diff-heading">
                    <div className="git-workspace__diff-title">
                      <FileCode2 size={15} />
                      <span title={selectedPath ?? undefined}>
                        {selectedPath ?? "Select a changed file"}
                      </span>
                    </div>
                    {selectedFile && (
                      <div
                        className="git-workspace__diff-toggle"
                        role="group"
                        aria-label="Diff version"
                      >
                        <button
                          type="button"
                          className={!showStagedDiff ? "is-active" : ""}
                          aria-pressed={!showStagedDiff}
                          onClick={() => setShowStagedDiff(false)}
                        >
                          Working tree
                        </button>
                        <button
                          type="button"
                          className={showStagedDiff ? "is-active" : ""}
                          aria-pressed={showStagedDiff}
                          onClick={() => setShowStagedDiff(true)}
                        >
                          Index
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="git-workspace__diff-note">
                    Repository diff · separate from Vibe engine review and its
                    approval flow.
                  </div>
                  <div
                    className="git-workspace__diff-content"
                    aria-label="Unified diff"
                    aria-busy={loadingDiff}
                  >
                    {loadingDiff ? (
                      <div className="git-workspace__loading">
                        <LoaderCircle
                          className="git-workspace__spin"
                          size={18}
                        />{" "}
                        Loading diff…
                      </div>
                    ) : diff?.diffText ? (
                      <div className="git-workspace__diff-lines">
                        {diff.diffText
                          .replace(/\n$/, "")
                          .split("\n")
                          .map((line, index) => (
                            <div
                              className={`git-workspace__diff-line git-workspace__diff-line--${diffKind(line)}`}
                              key={`${index}-${line.slice(0, 40)}`}
                            >
                              <span
                                aria-hidden="true"
                                className="git-workspace__diff-marker"
                              >
                                {line.startsWith("+")
                                  ? "+"
                                  : line.startsWith("-")
                                    ? "−"
                                    : line.startsWith("@@")
                                      ? "·"
                                      : ""}
                              </span>
                              <code>{line || " "}</code>
                            </div>
                          ))}
                      </div>
                    ) : selectedFile ? (
                      <div className="git-workspace__diff-empty">
                        <Minus size={18} />
                        <span>
                          {showStagedDiff
                            ? "No staged diff for this file."
                            : "No working-tree diff for this file."}
                        </span>
                      </div>
                    ) : (
                      <div className="git-workspace__diff-empty">
                        <FileCode2 size={18} />
                        <span>
                          Choose a changed file to inspect its unified diff.
                        </span>
                      </div>
                    )}
                  </div>
                  {diff?.truncated && (
                    <div className="git-workspace__truncation">
                      Diff preview is capped at 512 KiB (
                      {diff.bytes.toLocaleString()} bytes shown).
                    </div>
                  )}
                </section>
              </div>
            )}

            {tab === "history" && (
              <section
                className="git-workspace__list-view"
                aria-label="Commit history"
              >
                <div className="git-workspace__pane-heading">
                  <div>
                    <span className="git-workspace__eyebrow">
                      LOCAL HISTORY
                    </span>
                    <h2>Recent commits</h2>
                  </div>
                  <button
                    type="button"
                    className="git-workspace__icon-button"
                    onClick={() =>
                      setHistoryRevision((revision) => revision + 1)
                    }
                    disabled={loadingTab}
                    aria-label="Refresh commit history"
                  >
                    <RefreshCw size={15} />
                  </button>
                </div>
                {loadingTab && (
                  <div className="git-workspace__loading">
                    <LoaderCircle size={17} className="git-workspace__spin" />{" "}
                    Reading history…
                  </div>
                )}
                {!loadingTab && history?.length === 0 && (
                  <div className="git-workspace__list-empty">
                    <History size={18} /> No commits yet.
                  </div>
                )}
                <div className="git-workspace__history-list">
                  {history?.map((item) => (
                    <article
                      className="git-workspace__history-item"
                      key={item.hash}
                    >
                      <span
                        className="git-workspace__history-node"
                        aria-hidden="true"
                      />
                      <div className="git-workspace__history-main">
                        <strong>{item.subject || "(no subject)"}</strong>
                        <span>
                          {item.author} · {formatDate(item.date)}
                        </span>
                      </div>
                      <code title={item.hash}>{shortHash(item.hash)}</code>
                    </article>
                  ))}
                </div>
              </section>
            )}

            {tab === "worktrees" && (
              <section
                className="git-workspace__list-view"
                aria-label="Git worktrees"
              >
                <div className="git-workspace__pane-heading">
                  <div>
                    <span className="git-workspace__eyebrow">CHECKOUTS</span>
                    <h2>Worktrees</h2>
                  </div>
                  <button
                    type="button"
                    className="git-workspace__icon-button"
                    onClick={() =>
                      setWorktreeRevision((revision) => revision + 1)
                    }
                    disabled={loadingTab}
                    aria-label="Refresh worktrees"
                  >
                    <RefreshCw size={15} />
                  </button>
                </div>
                <p className="git-workspace__view-note">
                  Worktrees are listed read-only here. No checkout or cleanup
                  action is performed.
                </p>
                {loadingTab && (
                  <div className="git-workspace__loading">
                    <LoaderCircle size={17} className="git-workspace__spin" />{" "}
                    Reading worktrees…
                  </div>
                )}
                {!loadingTab && worktrees?.length === 0 && (
                  <div className="git-workspace__list-empty">
                    <Workflow size={18} /> No worktrees found.
                  </div>
                )}
                <div className="git-workspace__worktree-list">
                  {worktrees?.map((tree) => (
                    <article
                      className="git-workspace__worktree-item"
                      key={`${tree.path}-${tree.head}`}
                    >
                      <div className="git-workspace__worktree-icon">
                        <Workflow size={16} />
                      </div>
                      <div className="git-workspace__worktree-main">
                        <strong>
                          {tree.branch ??
                            (tree.detached
                              ? "Detached HEAD"
                              : "Bare repository")}
                        </strong>
                        <span title={tree.path}>{tree.path}</span>
                      </div>
                      <code title={tree.head}>{shortHash(tree.head)}</code>
                      {tree.locked && (
                        <span className="git-workspace__tag">Locked</span>
                      )}
                      {tree.prunable && (
                        <span className="git-workspace__tag git-workspace__tag--warn">
                          Prunable
                        </span>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            )}

            {tab === "pull-requests" && (
              <section
                className="git-workspace__list-view"
                aria-label="GitHub pull requests"
              >
                <div className="git-workspace__pane-heading">
                  <div>
                    <span className="git-workspace__eyebrow">GITHUB</span>
                    <h2>Pull requests</h2>
                    {pullRequests?.repository && (
                      <span className="git-workspace__repo-name">
                        {pullRequests.repository}
                      </span>
                    )}
                  </div>
                  <div className="git-workspace__heading-actions">
                    <button
                      type="button"
                      className="git-workspace__icon-button"
                      onClick={() => setPrRevision((revision) => revision + 1)}
                      disabled={loadingTab}
                      aria-label="Refresh pull requests"
                    >
                      <RefreshCw size={15} />
                    </button>
                    {pullRequests?.available && pullRequests.authenticated && (
                      <button
                        type="button"
                        className="git-workspace__button git-workspace__button--primary"
                        onClick={openPrDialog}
                      >
                        <Plus size={14} /> Create pull request
                      </button>
                    )}
                  </div>
                </div>
                {loadingTab && (
                  <div className="git-workspace__loading">
                    <LoaderCircle size={17} className="git-workspace__spin" />{" "}
                    Checking GitHub CLI…
                  </div>
                )}
                {!loadingTab && pullRequests && !pullRequests.repository && (
                  <div className="git-workspace__capability-note">
                    <ShieldAlert size={20} />
                    <div>
                      <strong>No GitHub origin remote found</strong>
                      <p>
                        PR details are available for repositories whose origin
                        points to github.com.
                      </p>
                    </div>
                  </div>
                )}
                {!loadingTab &&
                  pullRequests?.repository &&
                  !pullRequests.available && (
                    <div className="git-workspace__capability-note">
                      <ShieldAlert size={20} />
                      <div>
                        <strong>GitHub CLI is unavailable</strong>
                        <p>
                          Install <code>gh</code> to read pull-request details
                          through your existing GitHub sign-in.
                        </p>
                      </div>
                    </div>
                  )}
                {!loadingTab &&
                  pullRequests?.available &&
                  !pullRequests.authenticated && (
                    <div className="git-workspace__capability-note">
                      <ShieldAlert size={20} />
                      <div>
                        <strong>GitHub CLI needs sign-in</strong>
                        <p>
                          Authenticate <code>gh</code> before loading or
                          creating pull requests. Vibe Desktop does not store a
                          separate GitHub credential.
                        </p>
                      </div>
                    </div>
                  )}
                {!loadingTab &&
                  pullRequests?.authenticated &&
                  !pullRequests.items.length && (
                    <div className="git-workspace__list-empty">
                      <GitPullRequest size={18} /> No open pull requests for
                      this repository.
                    </div>
                  )}
                <div className="git-workspace__pr-list">
                  {pullRequests?.items.map((item) => (
                    <article
                      className="git-workspace__pr-item"
                      key={item.number ?? item.url}
                    >
                      <div className="git-workspace__pr-icon">
                        <GitPullRequest size={16} />
                      </div>
                      <div className="git-workspace__pr-main">
                        <strong>{item.title}</strong>
                        <span>
                          #{item.number ?? "?"} · {item.headRefName} →{" "}
                          {item.baseRefName}
                          {item.isDraft ? " · Draft" : ""}
                        </span>
                      </div>
                      <span className="git-workspace__pr-state">
                        {item.reviewDecision || item.state}
                      </span>
                      {item.url && (
                        <button
                          type="button"
                          className="git-workspace__icon-button"
                          onClick={() => void openExternal(item.url!)}
                          aria-label={`Open pull request ${item.number}`}
                        >
                          <ArrowUpRight size={15} />
                        </button>
                      )}
                    </article>
                  ))}
                </div>
                <p className="git-workspace__view-note">
                  Opening a PR is a separate action. Creating one requires an
                  authenticated <code>gh</code> CLI and a branch already
                  published to origin.
                </p>
              </section>
            )}
          </div>
        </>
      )}

      <dialog
        className="git-workspace__pr-dialog"
        ref={prDialog}
        aria-labelledby="git-pr-dialog-title"
        onClose={() => setShowPrDialog(false)}
        onCancel={() => setShowPrDialog(false)}
      >
        {showPrDialog && (
          <form onSubmit={(event) => void createPullRequest(event)}>
            <div className="git-workspace__dialog-head">
              <div className="git-workspace__dialog-mark">
                <GitPullRequest size={19} />
              </div>
              <div>
                <span className="git-workspace__eyebrow">
                  EXPLICIT REMOTE ACTION
                </span>
                <h2 id="git-pr-dialog-title">Create pull request</h2>
              </div>
              <button
                type="button"
                className="git-workspace__icon-button"
                onClick={closePrDialog}
                aria-label="Close pull request form"
              >
                <X size={17} />
              </button>
            </div>
            <p className="git-workspace__dialog-note">
              This submits a new PR using your authenticated GitHub CLI. The
              branch must already be synchronized with origin; Vibe Desktop does
              not push it for you.
            </p>
            <label htmlFor="git-pr-title">Title</label>
            <input
              id="git-pr-title"
              value={prTitle}
              onChange={(event) => setPrTitle(event.target.value)}
              maxLength={256}
              autoFocus
              required
            />
            <label htmlFor="git-pr-body">Description</label>
            <textarea
              id="git-pr-body"
              value={prBody}
              onChange={(event) => setPrBody(event.target.value)}
              maxLength={50000}
              rows={7}
              placeholder="Describe the changes for reviewers"
            />
            <label htmlFor="git-pr-base">
              Base branch <span>Optional</span>
            </label>
            <input
              id="git-pr-base"
              value={prBase}
              onChange={(event) => setPrBase(event.target.value)}
              maxLength={256}
              placeholder="main"
            />
            <label className="git-workspace__checkbox">
              <input
                type="checkbox"
                checked={prDraft}
                onChange={(event) => setPrDraft(event.target.checked)}
              />{" "}
              Create as draft
            </label>
            <div className="git-workspace__dialog-actions">
              <button
                type="button"
                className="git-workspace__button git-workspace__button--quiet"
                onClick={closePrDialog}
                disabled={working}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="git-workspace__button git-workspace__button--primary"
                disabled={working || !prTitle.trim()}
              >
                {working ? (
                  <LoaderCircle size={14} className="git-workspace__spin" />
                ) : (
                  <GitPullRequest size={14} />
                )}
                Create pull request
              </button>
            </div>
          </form>
        )}
      </dialog>

      <footer className="git-workspace__footer">
        <span>
          <Clock3 size={13} /> Local repository view
        </span>
        <span>
          Changes from the engine review API are not represented as approvals
          here.
        </span>
      </footer>
    </section>
  );
}
