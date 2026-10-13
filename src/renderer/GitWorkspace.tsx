import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  Clock3,
  ExternalLink,
  FileCode2,
  Folder,
  GitBranch,
  GitPullRequest,
  Globe,
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
import ReactMarkdown from "react-markdown";
import "./git-workspace.css";
import { DiffViewer } from "./DiffViewer";
import { isAllowedPreviewUrl, previewUrlProblem } from "./preview-url";

type GitTab = "changes" | "files" | "history" | "worktrees" | "pull-requests";

interface DirEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  symlink?: boolean;
  size?: number;
}

interface FilePreview {
  path: string;
  kind: string;
  size?: number;
  text?: string;
  truncated?: boolean;
  maxBytes?: number;
  mime?: string;
  base64?: string;
}

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
  dirty?: boolean | null;
  ahead?: number | null;
  behind?: number | null;
  upstream?: string | null;
  untrackedCount?: number;
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

interface PullRequestDetails extends PullRequest {
  repository: string;
  number: number;
  body: string;
  commits: number;
  files: { path: string; additions: number; deletions: number }[];
  filesTruncated?: boolean;
  checks: { name: string; status: string; conclusion: string | null }[];
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
  const [selectedPr, setSelectedPr] = useState<number | null>(null);
  const [prDetails, setPrDetails] = useState<PullRequestDetails | null>(null);
  const [prDetailsLoading, setPrDetailsLoading] = useState(false);
  const [wtBranch, setWtBranch] = useState("");
  const [showWtDialog, setShowWtDialog] = useState(false);
  const [treeCache, setTreeCache] = useState<Map<string, DirEntry[]>>(new Map());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set([""]));
  const [treeLoading, setTreeLoading] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [recentPaths, setRecentPaths] = useState<string[]>([]);
  const [treeQuery, setTreeQuery] = useState("");
  const [webUrl, setWebUrl] = useState("");
  const [framedUrl, setFramedUrl] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [createdPrUrl, setCreatedPrUrl] = useState<string | null>(null);
  const [showPrDialog, setShowPrDialog] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [fileFilter, setFileFilter] = useState<
    "all" | "staged" | "unstaged" | "conflicted"
  >("all");
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
  const conflictedCount = status?.files.filter((file) => file.conflicted).length ?? 0;
  const selectedFile = status?.files.find((file) => file.path === selectedPath);
  const visibleFiles = useMemo(() => {
    const needle = fileQuery.trim().toLowerCase();
    return (status?.files ?? []).filter((file) => {
      if (fileFilter === "staged" && !file.staged) return false;
      if (fileFilter === "unstaged" && !(file.unstaged || file.untracked)) return false;
      if (fileFilter === "conflicted" && !file.conflicted) return false;
      if (
        needle &&
        !`${file.path} ${file.originalPath ?? ""}`.toLowerCase().includes(needle)
      )
        return false;
      return true;
    });
  }, [status?.files, fileFilter, fileQuery]);
  const stagedFiles = visibleFiles.filter((file) => file.staged);
  const workingFiles = visibleFiles.filter(
    (file) => !file.staged || file.unstaged || file.untracked,
  );
  const renderFileRow = (file: GitFile) => {
    const selected = selectedPath === file.path;
    const label = fileStateLabel(file, baselinePaths, agentPathSet);
    const displayName = file.originalPath
      ? `${file.originalPath} → ${file.path}`
      : file.path;
    return (
      <article
        key={file.path}
        role="listitem"
        className={
          selected ? "git-workspace__file is-selected" : "git-workspace__file"
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
          title={displayName}
        >
          <FileCode2 size={15} />
          <span className="git-workspace__file-name">{displayName}</span>
          <span
            className={
              file.conflicted
                ? "git-workspace__file-badge is-conflict"
                : file.staged && !file.unstaged && !file.untracked
                  ? "git-workspace__file-badge is-staged"
                  : "git-workspace__file-badge"
            }
            title={
              file.conflicted
                ? "Merge conflict"
                : file.staged && !file.unstaged && !file.untracked
                  ? "Staged in index"
                  : file.untracked
                    ? "Untracked"
                    : "Modified in working tree"
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
                onClick={() => void mutateFile("stage", file.path)}
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
                onClick={() => void mutateFile("unstage", file.path)}
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
  };
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
    setTreeCache(new Map());
    setExpandedDirs(new Set([""]));
    setPreviewPath(null);
    setPreview(null);
    setSelectedPr(null);
    setPrDetails(null);
    setRecentPaths([]);
    setFramedUrl(null);
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

  const mutateHunk = async (
    method: "stageHunk" | "unstageHunk",
    filePath: string,
    header: string,
    lines: string[],
  ) => {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const result = await gitRequest<GitStatus>(method, {
        projectPath,
        path: filePath,
        header,
        lines,
      });
      acceptStatus(result);
      setDiffRevision((revision) => revision + 1);
      setNotice(
        method === "stageHunk" ? "Hunk staged in the index." : "Hunk unstaged.",
      );
    } catch (reason) {
      reportError(errorMessage(reason));
    } finally {
      setWorking(false);
    }
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

  const loadDirectory = useCallback(
    async (dir: string) => {
      setTreeLoading(true);
      try {
        const result = await gitRequest<{
          entries: DirEntry[];
        }>("listDirectory", { projectPath, dir });
        setTreeCache((prev) => {
          const next = new Map(prev);
          next.set(dir, result.entries ?? []);
          return next;
        });
        setError("");
      } catch (reason) {
        reportError(errorMessage(reason));
      } finally {
        setTreeLoading(false);
      }
    },
    [projectPath, reportError],
  );

  const openPreview = useCallback(
    async (filePath: string) => {
      setPreviewPath(filePath);
      setPreviewLoading(true);
      setRecentPaths((prev) =>
        [filePath, ...prev.filter((p) => p !== filePath)].slice(0, 10),
      );
      try {
        const result = await gitRequest<FilePreview>("readFile", {
          projectPath,
          path: filePath,
        });
        setPreview(result);
        setError("");
      } catch (reason) {
        setPreview(null);
        reportError(errorMessage(reason));
      } finally {
        setPreviewLoading(false);
      }
    },
    [projectPath, reportError],
  );

  // Load the repository root when the Files tab opens.
  useEffect(() => {
    if (tab !== "files") return;
    if (!status?.isGitRepository) return;
    if (!treeCache.has("")) void loadDirectory("");
  }, [tab, status?.isGitRepository, treeCache, loadDirectory]);

  const toggleDir = (dir: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        if (!treeCache.has(dir)) void loadDirectory(dir);
      }
      return next;
    });
  };

  const submitWebPreview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = previewUrlProblem(webUrl);
    if (problem) {
      reportError(problem);
      return;
    }
    setError("");
    // Explicit user approval: only this submitted URL is ever framed, and the
    // frame is sandboxed without same-origin access or IPC.
    setFramedUrl(webUrl.trim());
    setFrameKey((key) => key + 1);
  };

  const refreshWorktrees = () => setWorktreeRevision((revision) => revision + 1);

  const createWorktree = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!wtBranch.trim()) return;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const result = await gitRequest<{ items: GitWorktree[] }>("createWorktree", {
        projectPath,
        branch: wtBranch.trim(),
      });
      setWorktrees(result.items ?? []);
      setWtBranch("");
      setShowWtDialog(false);
      setNotice(`Worktree created for branch ${wtBranch.trim()} under .worktrees/. Select its folder via Open project to work in it.`);
    } catch (reason) {
      reportError(errorMessage(reason));
    } finally {
      setWorking(false);
    }
  };

  const removeWorktree = async (worktreePath: string) => {
    if (
      !window.confirm(
        `Remove the worktree at\n${worktreePath}\n\nOnly clean worktrees without unpushed commits can be removed. Dirty, untracked or unpushed worktrees are refused with the reason.`,
      )
    )
      return;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const result = await gitRequest<{ items: GitWorktree[] }>("removeWorktree", {
        projectPath,
        worktreePath,
      });
      setWorktrees(result.items ?? []);
      setNotice("Worktree removed.");
    } catch (reason) {
      reportError(errorMessage(reason));
    } finally {
      setWorking(false);
    }
  };

  const pruneWorktrees = async () => {
    setWorking(true);
    setError("");
    try {
      const result = await gitRequest<{ items: GitWorktree[] }>("pruneWorktrees", {
        projectPath,
      });
      setWorktrees(result.items ?? []);
      setNotice("Stale worktree metadata pruned. Real checkouts are never deleted by pruning.");
    } catch (reason) {
      reportError(errorMessage(reason));
    } finally {
      setWorking(false);
    }
  };

  const copyWorktreePath = async (worktreePath: string) => {
    try {
      await navigator.clipboard.writeText(worktreePath);
      setNotice("Worktree path copied. Open it via Open project to authorize it as an independent workspace.");
    } catch {
      reportError("Could not copy the worktree path.");
    }
  };

  const openPrDetails = async (number: number | null) => {
    if (number == null) return;
    setSelectedPr(number);
    setPrDetailsLoading(true);
    setPrDetails(null);
    try {
      const result = await gitRequest<PullRequestDetails>("pullRequestDetails", {
        projectPath,
        number,
      });
      setPrDetails(result);
      setError("");
    } catch (reason) {
      reportError(errorMessage(reason));
    } finally {
      setPrDetailsLoading(false);
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
    { id: "files", label: "Files", icon: Folder },
    { id: "history", label: "History", icon: History },
    { id: "worktrees", label: "Worktrees", icon: Workflow },
    { id: "pull-requests", label: "Pull requests", icon: GitPullRequest },
  ];
  const dirtyPaths = useMemo(
    () => new Set((status?.files ?? []).map((file) => file.path)),
    [status?.files],
  );
  const renderTreeRows = (
    dir: string,
    depth: number,
    rows: ReactNode[],
    seen: Set<string>,
  ): ReactNode[] => {
    const entries = treeCache.get(dir) ?? [];
    const needle = treeQuery.trim().toLowerCase();
    for (const entry of entries) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      if (
        needle &&
        !entry.path.toLowerCase().includes(needle) &&
        entry.kind !== "directory"
      )
        continue;
      if (entry.kind === "directory") {
        const open = expandedDirs.has(entry.path) || Boolean(needle);
        rows.push(
          <button
            key={entry.path}
            type="button"
            className="git-workspace__tree-row"
            style={{ paddingLeft: 6 + depth * 14 }}
            aria-expanded={open}
            onClick={() => toggleDir(entry.path)}
            title={entry.path}
          >
            <Folder size={14} />
            <span>{entry.name}/</span>
            {entry.symlink && <small>link</small>}
          </button>,
        );
        if (open) {
          if (!treeCache.has(entry.path)) {
            rows.push(
              <p key={`${entry.path}:loading`} className="git-workspace__limit-note" style={{ paddingLeft: 20 + depth * 14 }}>
                {treeLoading ? "Loading…" : "Not loaded"}
              </p>,
            );
          } else {
            renderTreeRows(entry.path, depth + 1, rows, seen);
          }
        }
      } else {
        rows.push(
          <button
            key={entry.path}
            type="button"
            className={
              previewPath === entry.path
                ? "git-workspace__tree-row is-selected"
                : dirtyPaths.has(entry.path)
                  ? "git-workspace__tree-row is-dirty"
                  : "git-workspace__tree-row"
            }
            style={{ paddingLeft: 6 + depth * 14 }}
            onClick={() => void openPreview(entry.path)}
            title={`${entry.path}${dirtyPaths.has(entry.path) ? " · modified" : ""}`}
          >
            <FileCode2 size={14} />
            <span>{entry.name}</span>
            {dirtyPaths.has(entry.path) && (
              <span className="git-workspace__file-badge" title="Modified in Git">M</span>
            )}
            {entry.symlink && <small>link</small>}
          </button>,
        );
      }
    }
    return rows;
  };

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
                    writes; other new changes have unknown source. Review flow:
                    inspect hunks → stage → commit → create a PR.
                  </p>
                  <div className="git-workspace__file-tools" role="search">
                    <input
                      type="search"
                      placeholder="Filter changed files…"
                      aria-label="Filter changed files"
                      value={fileQuery}
                      onChange={(event) => setFileQuery(event.target.value)}
                    />
                    <div
                      className="git-workspace__filter-chips"
                      role="group"
                      aria-label="Change filter"
                    >
                      {(
                        [
                          ["all", `All ${changesCount}`],
                          ["staged", `Staged ${stagedCount}`],
                          ["unstaged", "Unstaged"],
                          ["conflicted", `Conflicts ${conflictedCount}`],
                        ] as const
                      ).map(([id, label]) => (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={fileFilter === id}
                          className={fileFilter === id ? "is-active" : ""}
                          onClick={() => setFileFilter(id)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {status.filesTruncated && (
                    <p className="git-workspace__limit-note">
                      Showing the first 500 changed paths.
                    </p>
                  )}
                  <div className="git-workspace__file-list" role="list">
                    {fileFilter !== "unstaged" && stagedFiles.length > 0 && (
                      <p className="git-workspace__group-heading" role="presentation">
                        Staged · {stagedFiles.length} ready to commit
                      </p>
                    )}
                    {fileFilter !== "unstaged" && stagedFiles.map(renderFileRow)}
                    {fileFilter !== "staged" && workingFiles.length > 0 && (
                      <p className="git-workspace__group-heading" role="presentation">
                        Working tree · {workingFiles.length} not yet staged
                      </p>
                    )}
                    {fileFilter !== "staged" && workingFiles.map(renderFileRow)}
                    {!visibleFiles.length && !loadingStatus && (
                      <div className="git-workspace__list-empty">
                        <Check size={18} />
                        <span>
                          {status.files.length
                            ? "No files match this filter"
                            : "No changed files"}
                        </span>
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
                      <DiffViewer
                        key={`${selectedPath}-${showStagedDiff ? "staged" : "work"}-${diffRevision}`}
                        diffText={diff.diffText}
                        filePath={selectedPath ?? diff.path}
                        staged={showStagedDiff}
                        working={working}
                        truncated={diff.truncated}
                        onStageHunk={
                          showStagedDiff
                            ? undefined
                            : selectedPath
                              ? (header, lines) =>
                                  void mutateHunk(
                                    "stageHunk",
                                    selectedPath,
                                    header,
                                    lines,
                                  )
                              : undefined
                        }
                        onUnstageHunk={
                          showStagedDiff
                            ? selectedPath
                              ? (header, lines) =>
                                  void mutateHunk(
                                    "unstageHunk",
                                    selectedPath,
                                    header,
                                    lines,
                                  )
                              : undefined
                            : undefined
                        }
                      />
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

            {tab === "files" && (
              <section className="git-workspace__list-view" aria-label="File explorer">
                <div className="git-workspace__pane-heading">
                  <div>
                    <span className="git-workspace__eyebrow">REPOSITORY</span>
                    <h2>Files</h2>
                  </div>
                  <button
                    type="button"
                    className="git-workspace__icon-button"
                    onClick={() => void loadDirectory("")}
                    disabled={treeLoading}
                    aria-label="Reload file tree"
                  >
                    <RefreshCw size={15} />
                  </button>
                </div>
                <p className="git-workspace__view-note">
                  Read-only inspector: previews never grant local files any
                  app privileges. Modified files carry their Git state.
                </p>
                <div className="git-workspace__explorer">
                  <aside className="git-workspace__tree" aria-label="Folder tree">
                    <div className="git-workspace__file-tools" role="search">
                      <input
                        type="search"
                        placeholder="Find a file…"
                        aria-label="Find a file"
                        value={treeQuery}
                        onChange={(event) => setTreeQuery(event.target.value)}
                      />
                    </div>
                    {recentPaths.length > 0 && (
                      <>
                        <p className="git-workspace__group-heading">Recent</p>
                        {recentPaths.map((recent) => (
                          <button
                            key={`recent:${recent}`}
                            type="button"
                            className={
                              previewPath === recent
                                ? "git-workspace__tree-row is-selected"
                                : "git-workspace__tree-row"
                            }
                            onClick={() => void openPreview(recent)}
                            title={recent}
                          >
                            <History size={13} /> <span>{recent}</span>
                          </button>
                        ))}
                      </>
                    )}
                    {(status?.files ?? []).length > 0 && (
                      <>
                        <p className="git-workspace__group-heading">
                          Modified · {(status?.files ?? []).length}
                        </p>
                        {(status?.files ?? []).slice(0, 20).map((file) => (
                          <button
                            key={`modified:${file.path}`}
                            type="button"
                            className={
                              previewPath === file.path
                                ? "git-workspace__tree-row is-selected"
                                : "git-workspace__tree-row is-dirty"
                            }
                            onClick={() => void openPreview(file.path)}
                            title={file.path}
                          >
                            <FileCode2 size={13} /> <span>{file.path}</span>
                          </button>
                        ))}
                      </>
                    )}
                    <p className="git-workspace__group-heading">Tree</p>
                    {renderTreeRows("", 0, [], new Set())}
                    {treeLoading && (
                      <div className="git-workspace__loading">
                        <LoaderCircle size={15} className="git-workspace__spin" /> Loading…
                      </div>
                    )}
                  </aside>
                  <div className="git-workspace__preview" aria-label="File preview" aria-busy={previewLoading}>
                    {previewLoading ? (
                      <div className="git-workspace__loading">
                        <LoaderCircle size={17} className="git-workspace__spin" /> Reading file…
                      </div>
                    ) : !preview ? (
                      <div className="git-workspace__diff-empty">
                        <Folder size={18} />
                        <span>Select a file to preview it read-only.</span>
                      </div>
                    ) : preview.kind === "image" && preview.base64 ? (
                      <>
                        <p className="git-workspace__group-heading">{preview.path}</p>
                        <img src={`data:${preview.mime ?? "image/png"};base64,${preview.base64}`} alt={preview.path} />
                      </>
                    ) : preview.kind === "binary" ? (
                      <div className="git-workspace__diff-empty">
                        <Minus size={18} />
                        <span>Binary file — no text preview ({(preview.size ?? 0).toLocaleString()} bytes).</span>
                      </div>
                    ) : preview.kind === "too-large" ? (
                      <div className="git-workspace__diff-empty">
                        <Minus size={18} />
                        <span>
                          File too large to preview ({(preview.size ?? 0).toLocaleString()} bytes, cap {(preview.maxBytes ?? 0).toLocaleString()}).
                        </span>
                      </div>
                    ) : preview.kind === "markdown" && preview.text != null ? (
                      <>
                        <p className="git-workspace__group-heading">{preview.path}</p>
                        <ReactMarkdown>{preview.text}</ReactMarkdown>
                      </>
                    ) : (
                      <>
                        <p className="git-workspace__group-heading">
                          {preview.path}
                          {preview.kind === "json" ? " · JSON" : ""}
                          {preview.truncated ? ` · first ${(preview.maxBytes ?? 0).toLocaleString()} bytes` : ""}
                        </p>
                        <pre>
                          <code>{preview.text}</code>
                        </pre>
                      </>
                    )}
                  </div>
                </div>
                <div className="git-workspace__web-preview">
                  <div className="git-workspace__pane-heading">
                    <div>
                      <span className="git-workspace__eyebrow">LOCAL WEB</span>
                      <h2>App preview</h2>
                    </div>
                    <Globe size={15} />
                  </div>
                  <p className="git-workspace__view-note">
                    Optional loopback preview (for example a dev server you
                    started yourself). Only an explicitly submitted localhost
                    URL is framed, isolated without app privileges, and nothing
                    is ever launched automatically.
                  </p>
                  <form
                    className="git-workspace__wt-create-row"
                    onSubmit={submitWebPreview}
                  >
                    <input
                      type="url"
                      placeholder="http://localhost:3000/"
                      aria-label="Local preview URL"
                      value={webUrl}
                      onChange={(event) => setWebUrl(event.target.value)}
                    />
                    <button
                      type="submit"
                      className="git-workspace__button git-workspace__button--primary"
                    >
                      Preview
                    </button>
                    {framedUrl && (
                      <>
                        <button
                          type="button"
                          className="git-workspace__button git-workspace__button--quiet"
                          onClick={() => setFrameKey((key) => key + 1)}
                        >
                          <RefreshCw size={13} /> Reload
                        </button>
                        <button
                          type="button"
                          className="git-workspace__button git-workspace__button--quiet"
                          onClick={() => void openExternal(framedUrl)}
                        >
                          Open in browser <ExternalLink size={13} />
                        </button>
                      </>
                    )}
                  </form>
                  {!framedUrl && !isAllowedPreviewUrl(webUrl) && webUrl.trim() && (
                    <p className="git-workspace__limit-note" role="alert">
                      {previewUrlProblem(webUrl)}
                    </p>
                  )}
                  {framedUrl && (
                    <iframe
                      key={frameKey}
                      title={`Local preview of ${framedUrl}`}
                      src={framedUrl}
                      sandbox="allow-scripts"
                      referrerPolicy="no-referrer"
                      className="git-workspace__frame"
                    />
                  )}
                </div>
              </section>
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
                  <div className="git-workspace__heading-actions">
                    <button
                      type="button"
                      className="git-workspace__icon-button"
                      onClick={refreshWorktrees}
                      disabled={loadingTab}
                      aria-label="Refresh worktrees"
                    >
                      <RefreshCw size={15} />
                    </button>
                    <button
                      type="button"
                      className="git-workspace__button git-workspace__button--quiet"
                      onClick={() => void pruneWorktrees()}
                      disabled={working || loadingTab}
                      title="Remove stale worktree metadata only; never deletes real checkouts"
                    >
                      Prune stale
                    </button>
                    <button
                      type="button"
                      className="git-workspace__button git-workspace__button--primary"
                      onClick={() => {
                        setWtBranch("");
                        setShowWtDialog(true);
                      }}
                      disabled={working}
                    >
                      <Plus size={14} /> New worktree
                    </button>
                  </div>
                </div>
                <p className="git-workspace__view-note">
                  One agent per worktree: each checkout shows its branch, dirty
                  state and unpushed commits. Removal is safe-only — dirty,
                  untracked or unpushed worktrees are refused with the reason,
                  never force-deleted. Open a worktree via Open project to
                  authorize it as an independent workspace.
                </p>
                {showWtDialog && (
                  <form
                    className="git-workspace__wt-create"
                    onSubmit={(event) => void createWorktree(event)}
                  >
                    <label htmlFor="git-wt-branch">New branch worktree</label>
                    <div className="git-workspace__wt-create-row">
                      <input
                        id="git-wt-branch"
                        value={wtBranch}
                        onChange={(event) => setWtBranch(event.target.value)}
                        maxLength={128}
                        placeholder="feature/my-work"
                        autoFocus
                        required
                        disabled={working}
                      />
                      <button
                        type="submit"
                        className="git-workspace__button git-workspace__button--primary"
                        disabled={working || !wtBranch.trim()}
                      >
                        Create
                      </button>
                      <button
                        type="button"
                        className="git-workspace__button git-workspace__button--quiet"
                        onClick={() => setShowWtDialog(false)}
                        disabled={working}
                      >
                        Cancel
                      </button>
                    </div>
                    <small>
                      Created under <code>.worktrees/</code> from HEAD without
                      moving your session or overwriting branches.
                    </small>
                  </form>
                )}
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
                  {worktrees?.map((tree) => {
                    const isCurrent =
                      status?.root != null &&
                      tree.path.replace(/\\/g, "/").toLowerCase() ===
                        status.root.replace(/\\/g, "/").toLowerCase();
                    return (
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
                          <span className="git-workspace__worktree-state">
                            {isCurrent && (
                              <span className="git-workspace__tag">Current</span>
                            )}
                            {tree.dirty == null ? (
                              <span className="git-workspace__tag">Unknown state</span>
                            ) : tree.dirty ? (
                              <span className="git-workspace__tag git-workspace__tag--warn">
                                Dirty{(tree.untrackedCount ?? 0) > 0 ? ` · ${tree.untrackedCount} untracked` : ""}
                              </span>
                            ) : (
                              <span className="git-workspace__tag git-workspace__tag--ok">Clean</span>
                            )}
                            {(tree.ahead ?? 0) > 0 && (
                              <span className="git-workspace__tag git-workspace__tag--warn">
                                ↑ {tree.ahead} unpushed
                              </span>
                            )}
                            {(tree.behind ?? 0) > 0 && (
                              <span className="git-workspace__tag">↓ {tree.behind}</span>
                            )}
                          </span>
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
                        <span className="git-workspace__file-actions">
                          <button
                            type="button"
                            className="git-workspace__mini-button"
                            onClick={() => void copyWorktreePath(tree.path)}
                            title="Copy the worktree path to open it via Open project"
                          >
                            Copy path
                          </button>
                          {!isCurrent && !tree.bare && (
                            <button
                              type="button"
                              className="git-workspace__mini-button"
                              onClick={() => void removeWorktree(tree.path)}
                              disabled={working}
                              title="Remove this worktree (safe-only: refused when dirty, untracked or unpushed)"
                            >
                              Remove
                            </button>
                          )}
                        </span>
                      </article>
                    );
                  })}
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
                      className={
                        selectedPr === item.number
                          ? "git-workspace__pr-item is-selected"
                          : "git-workspace__pr-item"
                      }
                      key={item.number ?? item.url}
                    >
                      <button
                        type="button"
                        className="git-workspace__pr-select"
                        onClick={() => void openPrDetails(item.number)}
                        disabled={!item.number || prDetailsLoading}
                        title="Show files changed and check status"
                        aria-label={`Review pull request ${item.number}: ${item.title}`}
                      >
                        <span className="git-workspace__pr-icon">
                          <GitPullRequest size={16} />
                        </span>
                        <span className="git-workspace__pr-main">
                          <strong>{item.title}</strong>
                          <span>
                            #{item.number ?? "?"} · {item.headRefName} →{" "}
                            {item.baseRefName}
                            {item.isDraft ? " · Draft" : ""}
                          </span>
                        </span>
                        <span className="git-workspace__pr-state">
                          {item.reviewDecision || item.state}
                        </span>
                      </button>
                      {item.url && (
                        <button
                          type="button"
                          className="git-workspace__icon-button"
                          onClick={() => void openExternal(item.url!)}
                          aria-label={`Open pull request ${item.number} in browser`}
                        >
                          <ArrowUpRight size={15} />
                        </button>
                      )}
                    </article>
                  ))}
                </div>
                {(prDetailsLoading || prDetails) && (
                  <div className="git-workspace__pr-details" aria-live="polite">
                    {prDetailsLoading ? (
                      <div className="git-workspace__loading">
                        <LoaderCircle size={15} className="git-workspace__spin" /> Reading PR details…
                      </div>
                    ) : prDetails ? (
                      <>
                        <div className="git-workspace__pane-heading">
                          <div>
                            <span className="git-workspace__eyebrow">
                              REVIEW · #{prDetails.number} · {prDetails.commits} COMMITS
                            </span>
                            <h2>{prDetails.title}</h2>
                          </div>
                          <button
                            type="button"
                            className="git-workspace__icon-button"
                            onClick={() => {
                              setSelectedPr(null);
                              setPrDetails(null);
                            }}
                            aria-label="Close pull request details"
                          >
                            <X size={15} />
                          </button>
                        </div>
                        {prDetails.body && (
                          <div className="git-workspace__pr-body">
                            <ReactMarkdown>{prDetails.body}</ReactMarkdown>
                          </div>
                        )}
                        <p className="git-workspace__group-heading">
                          Checks · {prDetails.checks.length}
                        </p>
                        {prDetails.checks.length === 0 ? (
                          <p className="git-workspace__view-note">No check runs reported.</p>
                        ) : (
                          prDetails.checks.map((check) => (
                            <p key={check.name} className="git-workspace__check-row">
                              <span
                                className={
                                  check.conclusion === "SUCCESS"
                                    ? "git-workspace__tag git-workspace__tag--ok"
                                    : check.conclusion != null && check.conclusion !== "SUCCESS"
                                      ? "git-workspace__tag git-workspace__tag--warn"
                                      : "git-workspace__tag"
                                }
                              >
                                {check.conclusion ?? check.status}
                              </span>{" "}
                              {check.name}
                            </p>
                          ))
                        )}
                        <p className="git-workspace__group-heading">
                          Files changed · {prDetails.files.length}
                          {prDetails.filesTruncated ? " (truncated)" : ""}
                        </p>
                        {prDetails.files.map((file) => (
                          <p key={file.path} className="git-workspace__check-row" title={file.path}>
                            <FileCode2 size={13} /> {file.path}{" "}
                            <small>
                              +{file.additions} −{file.deletions}
                            </small>
                          </p>
                        ))}
                        {prDetails.url && (
                          <button
                            type="button"
                            className="git-workspace__button git-workspace__button--quiet"
                            onClick={() => void openExternal(prDetails.url!)}
                          >
                            Open pull request #{prDetails.number} in browser <ExternalLink size={13} />
                          </button>
                        )}
                        <p className="git-workspace__view-note">
                          Review approvals happen on GitHub. Approving or
                          merging from here is intentionally unsupported.
                        </p>
                      </>
                    ) : null}
                  </div>
                )}
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
