/** Shared Git workspace contracts: one definition, no duplication. */

export type GitTab = "changes" | "files" | "history" | "worktrees" | "pull-requests";

export interface DirEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  symlink?: boolean;
  size?: number;
}

export interface FilePreview {
  path: string;
  kind: string;
  size?: number;
  text?: string;
  truncated?: boolean;
  maxBytes?: number;
  mime?: string;
  base64?: string;
}

export interface GitFile {
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

export interface GitStatus {
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

export interface GitDiff {
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

export interface GitLogItem {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface WorktreeSessionUsage {
  sessionId: string;
  occupied: boolean;
  attached: boolean;
  hasActiveTurn: boolean;
  hasPendingCallbacks: boolean;
  leaseHeld: boolean;
  readOnlyChild: boolean;
}

export interface GitWorktree {
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
  usage?: {
    state: "occupied" | "idle" | "free" | "unknown";
    sessions: WorktreeSessionUsage[];
  };
}

export interface PullRequest {
  number: number | null;
  title: string;
  state: string;
  url: string | null;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  reviewDecision: string | null;
}

export interface PullRequestState {
  isGitRepository: boolean;
  available: boolean;
  authenticated: boolean;
  repository: string | null;
  items: PullRequest[];
}

export interface PullRequestDetails extends PullRequest {
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
  /** Open a session (e.g. from a worktree's associated session). */
  onOpenSession?: (cwd: string, sessionId: string) => void;
}
