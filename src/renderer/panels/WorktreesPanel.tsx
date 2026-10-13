import type { FormEvent } from "react";
import {
  ExternalLink,
  LoaderCircle,
  Plus,
  RefreshCw,
  Workflow,
} from "lucide-react";
import { shortHash } from "../git-api";
import type { GitStatus, GitWorktree } from "../git-types";

export interface WorktreeDiskRow {
  path: string;
  branch?: string | null;
  bytes: number | null;
  files: number | null;
}

export interface WorktreesPanelProps {
  worktrees: GitWorktree[] | null;
  loadingTab: boolean;
  working: boolean;
  status: GitStatus | null;
  wtBranch: string;
  showWtDialog: boolean;
  onRefresh: () => void;
  onPrune: () => void;
  onOpenCreate: () => void;
  onCloseCreate: () => void;
  onBranchChange: (value: string) => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => void;
  onRemove: (worktreePath: string) => void;
  onCopyPath: (worktreePath: string) => void;
  onOpenSession?: (cwd: string, sessionId: string) => void;
  /** M3: user-chosen parent dir (null = managed space). */
  customRoot?: string | null;
  rootKind?: "managed" | "custom";
  previewPath?: string | null;
  diskRows?: WorktreeDiskRow[] | null;
  onChooseCustomRoot?: () => void;
  onClearCustomRoot?: () => void;
  onOpenInEditor?: (folder: string) => void;
  onOpenTerminal?: (folder: string) => void;
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

function usageLabel(state: string): string {
  if (state === "occupied") return "Occupied";
  if (state === "idle") return "Idle session";
  if (state === "free") return "Available";
  return "Unknown use";
}

export function WorktreesPanel({
  worktrees,
  loadingTab,
  working,
  status,
  wtBranch,
  showWtDialog,
  onRefresh,
  onPrune,
  onOpenCreate,
  onCloseCreate,
  onBranchChange,
  onCreate,
  onRemove,
  onCopyPath,
  onOpenSession,
  customRoot = null,
  rootKind = "managed",
  previewPath = null,
  diskRows = null,
  onChooseCustomRoot,
  onClearCustomRoot,
  onOpenInEditor,
  onOpenTerminal,
}: WorktreesPanelProps) {
  return (
    <section className="git-workspace__list-view" aria-label="Git worktrees">
      <div className="git-workspace__pane-heading">
        <div>
          <span className="git-workspace__eyebrow">CHECKOUTS</span>
          <h2>Worktrees</h2>
        </div>
        <div className="git-workspace__heading-actions">
          <button
            type="button"
            className="git-workspace__icon-button"
            onClick={onRefresh}
            disabled={loadingTab}
            aria-label="Refresh worktrees"
          >
            <RefreshCw size={15} />
          </button>
          <button
            type="button"
            className="git-workspace__button git-workspace__button--quiet"
            onClick={onPrune}
            disabled={working || loadingTab}
            title="Remove stale worktree metadata only; never deletes real checkouts"
          >
            Prune stale
          </button>
          <button
            type="button"
            className="git-workspace__button git-workspace__button--primary"
            onClick={onOpenCreate}
            disabled={working}
          >
            <Plus size={14} /> New worktree
          </button>
        </div>
      </div>
      <p className="git-workspace__view-note">
        One agent per worktree: each checkout shows its branch, dirty state,
        unpushed commits and session use. Removal is safe-only — occupied,
        dirty, untracked or unpushed worktrees are refused with the reason,
        never force-deleted. Open a worktree via Open project to authorize it
        as an independent workspace.
      </p>
      {(onChooseCustomRoot || onClearCustomRoot) && (
        <div className="git-workspace__wt-location" role="group" aria-label="Worktree location">
          <small>
            Location: {rootKind === "custom" && customRoot ? `custom — ${customRoot}` : "app-managed space"}
          </small>
          <span className="git-workspace__file-actions">
            {onChooseCustomRoot && (
              <button
                type="button"
                className="git-workspace__mini-button"
                onClick={onChooseCustomRoot}
                disabled={working}
                title="Choose a custom parent folder for new worktrees (authorized via folder picker)"
              >
                Choose folder…
              </button>
            )}
            {rootKind === "custom" && onClearCustomRoot && (
              <button
                type="button"
                className="git-workspace__mini-button"
                onClick={onClearCustomRoot}
                disabled={working}
                title="Return to the app-managed worktree space"
              >
                Use managed space
              </button>
            )}
          </span>
        </div>
      )}
      {showWtDialog && (
        <form className="git-workspace__wt-create" onSubmit={onCreate}>
          <label htmlFor="git-wt-branch">New branch worktree</label>
          <div className="git-workspace__wt-create-row">
            <input
              id="git-wt-branch"
              value={wtBranch}
              onChange={(event) => onBranchChange(event.target.value)}
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
              onClick={onCloseCreate}
              disabled={working}
            >
              Cancel
            </button>
          </div>
          <small>
            {rootKind === "custom" && customRoot
              ? `Checkout will be created under the chosen folder (outside this repository). Existing checkouts stay where they are; nothing is migrated or deleted.`
              : `Created in the app-managed worktree space outside this checkout, so the main repository never becomes dirty from it.`}{" "}
            Your session stays where it is; sessions are never moved automatically.
          </small>
          {previewPath && (
            <small title={previewPath}>
              Final path preview: <code>{previewPath}</code>
            </small>
          )}
        </form>
      )}
      {loadingTab && (
        <div className="git-workspace__loading">
          <LoaderCircle size={17} className="git-workspace__spin" /> Reading worktrees…
        </div>
      )}
      {!loadingTab && worktrees?.length === 0 && (
        <div className="git-workspace__list-empty">
          <Workflow size={18} /> No worktrees found.
        </div>
      )}
      <div className="git-workspace__worktree-list">
        {worktrees?.map((tree) => {
          const isCurrent = status?.root != null && samePath(tree.path, status.root);
          const usageState = tree.usage?.state ?? "unknown";
          const occupied = usageState === "occupied";
          const unknownUse = usageState === "unknown";
          const blockReason = occupied
            ? "This worktree runs a session or agent — removal is blocked until it stops"
            : unknownUse
              ? "Session use is unverifiable — removal is blocked to protect running agents"
              : null;
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
                  {tree.branch ?? (tree.detached ? "Detached HEAD" : "Bare repository")}
                </strong>
                <span title={tree.path}>{tree.path}</span>
                <span className="git-workspace__worktree-state">
                  {isCurrent && <span className="git-workspace__tag">Current</span>}
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
                  <span
                    className={
                      occupied
                        ? "git-workspace__tag git-workspace__tag--warn"
                        : "git-workspace__tag"
                    }
                    title={
                      blockReason ??
                      (usageState === "idle"
                        ? "A saved session points here but nothing runs on it"
                        : "No session uses this checkout")
                    }
                  >
                    {usageLabel(usageState)}
                  </span>
                </span>
                {(tree.usage?.sessions ?? []).length > 0 && (
                  <span className="git-workspace__worktree-sessions">
                    {(tree.usage?.sessions ?? []).map((session) => (
                      <span key={session.sessionId} className="git-workspace__session-chip">
                        <code title={session.sessionId}>
                          {session.sessionId.slice(0, 8)}
                        </code>
                        {session.hasActiveTurn ? " · working" : ""}
                        {session.hasPendingCallbacks ? " · waiting" : ""}
                        {session.readOnlyChild ? " · subagent" : ""}
                        {onOpenSession && !session.readOnlyChild && (
                          <button
                            type="button"
                            className="git-workspace__mini-button"
                            onClick={() => onOpenSession(tree.path, session.sessionId)}
                            title={`Open session ${session.sessionId.slice(0, 8)}`}
                          >
                            Open session <ExternalLink size={12} />
                          </button>
                        )}
                      </span>
                    ))}
                  </span>
                )}
              </div>
              <code title={tree.head}>{shortHash(tree.head)}</code>
              {tree.locked && <span className="git-workspace__tag">Locked</span>}
              {tree.prunable && (
                <span className="git-workspace__tag git-workspace__tag--warn">Prunable</span>
              )}
              {diskRows && (
                <small className="git-workspace__limit-note">
                  {(() => {
                    const row = diskRows.find((r) => r.path === tree.path);
                    if (!row || row.bytes == null) return "size unknown";
                    if (row.bytes < 1024 * 1024) return `${(row.bytes / 1024).toFixed(1)} KiB · ${row.files ?? "?"} files`;
                    return `${(row.bytes / 1024 / 1024).toFixed(1)} MiB · ${row.files ?? "?"} files`;
                  })()}
                </small>
              )}
              <span className="git-workspace__file-actions">
                <button
                  type="button"
                  className="git-workspace__mini-button"
                  onClick={() => onCopyPath(tree.path)}
                  title="Copy the worktree path to open it via Open project"
                >
                  Copy path
                </button>
                {onOpenInEditor && (
                  <button
                    type="button"
                    className="git-workspace__mini-button"
                    onClick={() => onOpenInEditor(tree.path)}
                    title="Open this checkout folder in the configured editor (files only — not the agent session)"
                  >
                    Open in editor
                  </button>
                )}
                {onOpenTerminal && (
                  <button
                    type="button"
                    className="git-workspace__mini-button"
                    onClick={() => onOpenTerminal(tree.path)}
                    title="Open a Windows terminal in this checkout folder"
                  >
                    Terminal
                  </button>
                )}
                {!isCurrent && !tree.bare && (
                  <button
                    type="button"
                    className="git-workspace__mini-button"
                    onClick={() => onRemove(tree.path)}
                    disabled={working || occupied || unknownUse}
                    title={
                      blockReason ??
                      "Remove this worktree (safe-only: refused when dirty, untracked or unpushed)"
                    }
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
  );
}
