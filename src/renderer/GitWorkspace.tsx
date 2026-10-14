import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Check,
  Clock3,
  ExternalLink,
  FileCode2,
  Folder,
  GitBranch,
  GitPullRequest,
  History,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import "./git-workspace.css";
import { errorMessage, fileStateLabel, gitRequest, normalizePath, projectRelativePath, shortHash } from "./git-api";
import type {
  DirEntry,
  FilePreview,
  GitDiff,
  GitFile,
  GitLogItem,
  GitStatus,
  GitTab,
  GitWorktree,
  GitWorkspaceProps,
  PullRequestDetails,
  PullRequestState,
} from "./git-types";
import { previewUrlProblem } from "./preview-url";
import { ChangesFileRow, ChangesPanel, type FileFilter } from "./panels/ChangesPanel";
import { FilesPanel } from "./panels/FilesPanel";
import { HistoryPanel } from "./panels/HistoryPanel";
import { PullRequestsPanel } from "./panels/PullRequestsPanel";
import { WorktreesPanel } from "./panels/WorktreesPanel";

export type { GitWorkspaceProps };

export function GitWorkspace({
  projectPath,
  agentPaths = [],
  initialPaths,
  onError,
  onOpenSession,
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
  const [customRoot, setCustomRoot] = useState<string | null>(null);
  const [previewTarget, setPreviewTarget] = useState<string | null>(null);
  const [diskRows, setDiskRows] = useState<{ path: string; branch?: string | null; bytes: number | null; files: number | null }[] | null>(null);
  const [editors, setEditors] = useState<{ id: string; label: string; exePath: string | null; verified: boolean }[]>([]);
  const [customEditorPath, setCustomEditorPath] = useState<string | null>(null);
  const [treeCache, setTreeCache] = useState<Map<string, DirEntry[]>>(new Map());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set([""]));
  const [treeLoading, setTreeLoading] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [recentPaths, setRecentPaths] = useState<string[]>([]);
  const [treeQuery, setTreeQuery] = useState("");
  const [webUrl, setWebUrl] = useState("");
  const [activePreviewUrl, setActivePreviewUrl] = useState<string | null>(null);
  const [previewWorking, setPreviewWorking] = useState(false);
  const [createdPrUrl, setCreatedPrUrl] = useState<string | null>(null);
  const [showPrDialog, setShowPrDialog] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [fileFilter, setFileFilter] = useState<FileFilter>("all");
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
  const baselinePaths = baseline.current ?? new Set<string>();
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
  const dirtyPaths = useMemo(
    () => new Set((status?.files ?? []).map((file) => file.path)),
    [status?.files],
  );

  const renderFileRow = useCallback(
    (file: GitFile) => (
      <ChangesFileRow
        key={file.path}
        file={file}
        selected={selectedPath === file.path}
        label={fileStateLabel(file, baselinePaths, agentPathSet)}
        working={working}
        onSelect={(filePath) => {
          setSelectedPath(filePath);
          setShowStagedDiff(false);
        }}
        onStage={(filePath) => void mutateFile("stage", filePath)}
        onUnstage={(filePath) => void mutateFile("unstage", filePath)}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedPath, baselinePaths, agentPathSet, working, projectPath],
  );

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
    setActivePreviewUrl(null);
    setWorktrees(null);
    setPullRequests(null);
    setCreatedPrUrl(null);
    setError("");
    setNotice("");
    setCustomRoot(null);
    setPreviewTarget(null);
    setDiskRows(null);
    setLoadingStatus(true);
    void loadStatus(true, generation);
    void window.vibe?.readPreferences().then((prefs) => {
      const saved = prefs?.worktreeRoots?.[projectPath] ?? null;
      if (typeof saved === "string" && saved) setCustomRoot(saved);
      if (typeof prefs?.customEditorPath === "string") setCustomEditorPath(prefs.customEditorPath);
    }).catch(() => {});
    void window.vibe?.editorDetect().then(setEditors).catch(() => {});
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
    void gitRequest<{ rows: { path: string; branch?: string | null; bytes: number | null; files: number | null }[] }>("worktreeDiskUsage", { projectPath })
      .then((result) => {
        if (active) setDiskRows(result.rows ?? []);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [projectPath, reportError, tab, worktreeRevision]);

  useEffect(() => {
    if (!showWtDialog || !wtBranch.trim()) {
      setPreviewTarget(null);
      return;
    }
    let active = true;
    void gitRequest<{ target: string }>("previewWorktreePath", {
      projectPath,
      branch: wtBranch.trim(),
      ...(customRoot ? { customRoot } : {}),
    })
      .then((result) => {
        if (active) setPreviewTarget(result.target ?? null);
      })
      .catch(() => {
        if (active) setPreviewTarget(null);
      });
    return () => {
      active = false;
    };
  }, [showWtDialog, wtBranch, customRoot, projectPath]);

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

  async function mutateFile(method: "stage" | "unstage", filePath: string) {
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
  }

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
      setNotice(`Committed ${result.hash.slice(0, 8)} · ${result.subject}`);
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

  const toggleDir = useCallback(
    (dir: string) => {
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        if (next.has(dir)) next.delete(dir);
        else {
          next.add(dir);
          if (!treeCache.has(dir)) void loadDirectory(dir);
        }
        return next;
      });
    },
    [treeCache, loadDirectory],
  );

  const renderTreeRows = useCallback(
    (dir: string, depth: number, rows: ReactNode[], seen: Set<string>): ReactNode[] => {
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
                <p
                  key={`${entry.path}:loading`}
                  className="git-workspace__limit-note"
                  style={{ paddingLeft: 20 + depth * 14 }}
                >
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
    },
    [treeCache, treeQuery, expandedDirs, treeLoading, previewPath, dirtyPaths, toggleDir, openPreview],
  );

  const submitWebPreview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = previewUrlProblem(webUrl);
    if (problem) {
      reportError(problem);
      return;
    }
    if (!window.vibe?.previewOpen) {
      reportError("The isolated preview bridge is unavailable.");
      return;
    }
    setPreviewWorking(true);
    setError("");
    void window.vibe
      .previewOpen(webUrl.trim())
      .then((result) => {
        // Explicit user approval: only this submitted URL opens, isolated
        // without app privileges and unable to leave its origin.
        setActivePreviewUrl(result.url);
      })
      .catch((reason: unknown) => reportError(errorMessage(reason)))
      .finally(() => setPreviewWorking(false));
  };

  const reloadPreview = () => {
    if (!window.vibe?.previewReload) {
      reportError("The isolated preview bridge is unavailable.");
      return;
    }
    setPreviewWorking(true);
    void window.vibe
      .previewReload()
      .then((result) => setActivePreviewUrl(result.url))
      .catch((reason: unknown) => reportError(errorMessage(reason)))
      .finally(() => setPreviewWorking(false));
  };

  const closePreview = () => {
    if (!window.vibe?.previewClose) {
      setActivePreviewUrl(null);
      return;
    }
    setPreviewWorking(true);
    void window.vibe
      .previewClose()
      .then(() => setActivePreviewUrl(null))
      .catch((reason: unknown) => reportError(errorMessage(reason)))
      .finally(() => setPreviewWorking(false));
  };

  const refreshWorktrees = () => setWorktreeRevision((revision) => revision + 1);

  const chooseCustomRoot = async () => {
    if (!window.vibe?.chooseWorktreeRoot) {
      reportError("The folder picker is unavailable.");
      return;
    }
    try {
      const picked = await window.vibe.chooseWorktreeRoot();
      if (!picked) return;
      setCustomRoot(picked);
      try {
        const prefs = await window.vibe.readPreferences();
        await window.vibe.savePreferences({
          ...prefs,
          worktreeRoots: { ...(prefs.worktreeRoots ?? {}), [projectPath]: picked },
        });
      } catch {
        // Preference persistence is best-effort; the chosen folder still applies this run.
      }
      setNotice(`Custom worktree folder selected: ${picked}. Existing checkouts stay where they are.`);
    } catch (reason) {
      reportError(errorMessage(reason));
    }
  };

  const clearCustomRoot = async () => {
    setCustomRoot(null);
    setPreviewTarget(null);
    try {
      const prefs = await window.vibe?.readPreferences();
      if (prefs) {
        const next = { ...(prefs.worktreeRoots ?? {}) };
        delete next[projectPath];
        await window.vibe?.savePreferences({ ...prefs, worktreeRoots: next });
      }
    } catch {
      /* best-effort */
    }
  };

  const openInEditor = async (folder: string, file?: string | null, line?: number | null) => {
    if (!window.vibe?.editorOpen) {
      reportError("The editor bridge is unavailable.");
      return;
    }
    try {
      const list = editors.length ? editors : await window.vibe.editorDetect().catch(() => []);
      const verified = list.find((e) => e.verified) ?? null;
      const exe = customEditorPath ?? verified?.exePath ?? null;
      if (!exe && !verified) {
        reportError("No supported editor was found. Install VS Code, Cursor or VSCodium, or configure a custom editor path.");
        return;
      }
      await window.vibe.editorOpen({
        editorExe: customEditorPath,
        editorId: customEditorPath ? null : (verified?.id ?? null),
        folder,
        file: file ?? null,
        line: line ?? null,
      });
      setNotice("Editor process started (files only — the agent session stays here).");
    } catch (reason) {
      reportError(errorMessage(reason));
    }
  };

  const openTerminalHere = async (folder: string) => {
    if (!window.vibe?.editorOpenTerminal) {
      reportError("The terminal bridge is unavailable.");
      return;
    }
    try {
      await window.vibe.editorOpenTerminal({ folder });
      setNotice("Terminal process started in the workspace folder.");
    } catch (reason) {
      reportError(errorMessage(reason));
    }
  };

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
        ...(customRoot ? { customRoot } : {}),
      });
      setWorktrees(result.items ?? []);
      const created = (result.items ?? []).find((entry) => entry.branch === wtBranch.trim());
      setWtBranch("");
      setShowWtDialog(false);
      setPreviewTarget(null);
      setNotice(
        created
          ? `Worktree created at ${created.path} ${customRoot ? "under the chosen folder" : "in the app-managed space"}. Select its folder via Open project to work in it.`
          : `Worktree created ${customRoot ? "under the chosen folder" : "in the app-managed space"}. Select its folder via Open project to work in it.`,
      );
      try {
        const usage = await gitRequest<{ rows: { path: string; branch?: string | null; bytes: number | null; files: number | null }[] }>("worktreeDiskUsage", { projectPath });
        setDiskRows(usage.rows ?? []);
      } catch {
        /* disk view is best-effort */
      }
    } catch (reason) {
      reportError(errorMessage(reason));
    } finally {
      setWorking(false);
    }
  };

  const removeWorktree = async (worktreePath: string) => {
    if (
      !window.confirm(
        `Remove the worktree at\n${worktreePath}\n\nOnly free, clean worktrees without unpushed commits can be removed. Occupied, dirty, untracked or unpushed worktrees are refused with the reason.`,
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
              <ChangesPanel
                status={status}
                loadingStatus={loadingStatus}
                working={working}
                stagedCount={stagedCount}
                changesCount={changesCount}
                conflictedCount={conflictedCount}
                stagedFiles={stagedFiles}
                workingFiles={workingFiles}
                visibleCount={visibleFiles.length}
                fileQuery={fileQuery}
                fileFilter={fileFilter}
                selectedPath={selectedPath}
                selectedFile={selectedFile}
                showStagedDiff={showStagedDiff}
                diff={diff}
                loadingDiff={loadingDiff}
                diffRevision={diffRevision}
                commitMessage={commitMessage}
                renderFileRow={renderFileRow}
                onFileQueryChange={setFileQuery}
                onFileFilterChange={setFileFilter}
                onToggleStagedDiff={setShowStagedDiff}
                onStageHunk={(filePath, header, lines) =>
                  void mutateHunk("stageHunk", filePath, header, lines)
                }
                onUnstageHunk={(filePath, header, lines) =>
                  void mutateHunk("unstageHunk", filePath, header, lines)
                }
                onCommitMessageChange={setCommitMessage}
                onCommit={() => void createCommit()}
              />
            )}

            {tab === "files" && (
              <FilesPanel
                status={status}
                treeCache={treeCache}
                expandedDirs={expandedDirs}
                treeLoading={treeLoading}
                previewPath={previewPath}
                preview={preview}
                previewLoading={previewLoading}
                recentPaths={recentPaths}
                treeQuery={treeQuery}
                dirtyPaths={dirtyPaths}
                webUrl={webUrl}
                activePreviewUrl={activePreviewUrl}
                previewWorking={previewWorking}
                onReloadTree={() => void loadDirectory("")}
                onQueryChange={setTreeQuery}
                onToggleDir={toggleDir}
                onOpenPreview={(filePath) => void openPreview(filePath)}
                onWebUrlChange={setWebUrl}
                onSubmitWebPreview={submitWebPreview}
                onPreviewReload={reloadPreview}
                onPreviewClose={closePreview}
                onOpenExternal={(url) => void openExternal(url)}
                renderTreeRows={renderTreeRows}
                onOpenInEditor={(file) => void openInEditor(projectPath, file)}
                onOpenTerminal={() => void openTerminalHere(projectPath)}
              />
            )}

            {tab === "history" && (
              <HistoryPanel
                history={history}
                loadingTab={loadingTab}
                onRefresh={() => setHistoryRevision((revision) => revision + 1)}
              />
            )}

            {tab === "worktrees" && (
              <WorktreesPanel
                worktrees={worktrees}
                loadingTab={loadingTab}
                working={working}
                status={status}
                wtBranch={wtBranch}
                showWtDialog={showWtDialog}
                onRefresh={refreshWorktrees}
                onPrune={() => void pruneWorktrees()}
                onOpenCreate={() => {
                  setWtBranch("");
                  setShowWtDialog(true);
                }}
                onCloseCreate={() => setShowWtDialog(false)}
                onBranchChange={setWtBranch}
                onCreate={(event) => void createWorktree(event)}
                onRemove={(worktreePath) => void removeWorktree(worktreePath)}
                onCopyPath={(worktreePath) => void copyWorktreePath(worktreePath)}
                onOpenSession={onOpenSession}
                customRoot={customRoot}
                rootKind={customRoot ? "custom" : "managed"}
                previewPath={previewTarget}
                diskRows={diskRows}
                onChooseCustomRoot={() => void chooseCustomRoot()}
                onClearCustomRoot={() => void clearCustomRoot()}
                onOpenInEditor={(folder) => void openInEditor(folder)}
                onOpenTerminal={(folder) => void openTerminalHere(folder)}
              />
            )}

            {tab === "pull-requests" && (
              <PullRequestsPanel
                pullRequests={pullRequests}
                loadingTab={loadingTab}
                working={working}
                selectedPr={selectedPr}
                prDetails={prDetails}
                prDetailsLoading={prDetailsLoading}
                prTitle={prTitle}
                prBody={prBody}
                prBase={prBase}
                prDraft={prDraft}
                showPrDialog={showPrDialog}
                prDialogRef={prDialog}
                onRefresh={() => setPrRevision((revision) => revision + 1)}
                onOpenCreate={openPrDialog}
                onCloseCreate={closePrDialog}
                onTitleChange={setPrTitle}
                onBodyChange={setPrBody}
                onBaseChange={setPrBase}
                onDraftChange={setPrDraft}
                onCreate={(event) => void createPullRequest(event)}
                onOpenDetails={(number) => void openPrDetails(number)}
                onClearDetails={() => {
                  setSelectedPr(null);
                  setPrDetails(null);
                }}
                onOpenExternal={(url) => void openExternal(url)}
              />
            )}
          </div>
        </>
      )}

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
