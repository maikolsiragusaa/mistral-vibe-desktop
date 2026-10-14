import type { ReactNode } from "react";
import { Check, FileCode2, LoaderCircle, Minus, Plus } from "lucide-react";
import { DiffViewer } from "../DiffViewer";
import type { GitDiff, GitFile, GitStatus } from "../git-types";

export type FileFilter = "all" | "staged" | "unstaged" | "conflicted";

export interface ChangesPanelProps {
  status: GitStatus | null;
  loadingStatus: boolean;
  working: boolean;
  stagedCount: number;
  changesCount: number;
  conflictedCount: number;
  stagedFiles: GitFile[];
  workingFiles: GitFile[];
  visibleCount: number;
  fileQuery: string;
  fileFilter: FileFilter;
  selectedPath: string | null;
  selectedFile: GitFile | undefined;
  showStagedDiff: boolean;
  diff: GitDiff | null;
  loadingDiff: boolean;
  diffRevision: number;
  commitMessage: string;
  renderFileRow: (file: GitFile) => ReactNode;
  onFileQueryChange: (value: string) => void;
  onFileFilterChange: (filter: FileFilter) => void;
  onToggleStagedDiff: (staged: boolean) => void;
  onStageHunk: (filePath: string, header: string, lines: string[]) => void;
  onUnstageHunk: (filePath: string, header: string, lines: string[]) => void;
  onCommitMessageChange: (value: string) => void;
  onCommit: () => void;
}

export function ChangesPanel({
  status,
  loadingStatus,
  working,
  stagedCount,
  changesCount,
  conflictedCount,
  stagedFiles,
  workingFiles,
  visibleCount,
  fileQuery,
  fileFilter,
  selectedPath,
  selectedFile,
  showStagedDiff,
  diff,
  loadingDiff,
  diffRevision,
  commitMessage,
  renderFileRow,
  onFileQueryChange,
  onFileFilterChange,
  onToggleStagedDiff,
  onStageHunk,
  onUnstageHunk,
  onCommitMessageChange,
  onCommit,
}: ChangesPanelProps) {
  return (
    <div className="git-workspace__changes">
      <aside className="git-workspace__file-pane" aria-label="Changed files">
        <div className="git-workspace__pane-heading">
          <div>
            <span className="git-workspace__eyebrow">WORKING TREE</span>
            <h2>Changed files</h2>
          </div>
          <span className="git-workspace__count-pill">{changesCount}</span>
        </div>
        <p className="git-workspace__attribution-help">
          Baseline captured on open. Agent tags reflect observed Vibe writes;
          other new changes have unknown source. Review flow: inspect hunks →
          stage → commit → create a PR.
        </p>
        <div className="git-workspace__file-tools" role="search">
          <input
            type="search"
            placeholder="Filter changed files…"
            aria-label="Filter changed files"
            value={fileQuery}
            onChange={(event) => onFileQueryChange(event.target.value)}
          />
          <div className="git-workspace__filter-chips" role="group" aria-label="Change filter">
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
                onClick={() => onFileFilterChange(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {status?.filesTruncated && (
          <p className="git-workspace__limit-note">Showing the first 500 changed paths.</p>
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
          {visibleCount === 0 && !loadingStatus && (
            <div className="git-workspace__list-empty">
              <Check size={18} />
              <span>
                {(status?.files.length ?? 0) > 0
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
              onCommit();
            }}
          >
            <label htmlFor="git-commit-message">
              Commit staged changes <span>{stagedCount}</span>
            </label>
            <textarea
              id="git-commit-message"
              value={commitMessage}
              onChange={(event) => onCommitMessageChange(event.target.value)}
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
                <LoaderCircle size={14} className="git-workspace__spin" />
              ) : (
                <Check size={14} />
              )}
              Commit staged files
            </button>
          </form>
        )}
      </aside>

      <section className="git-workspace__diff-pane" aria-label="Selected file diff">
        <div className="git-workspace__diff-heading">
          <div className="git-workspace__diff-title">
            <FileCode2 size={15} />
            <span title={selectedPath ?? undefined}>
              {selectedPath ?? "Select a changed file"}
            </span>
          </div>
          {selectedFile && (
            <div className="git-workspace__diff-toggle" role="group" aria-label="Diff version">
              <button
                type="button"
                className={!showStagedDiff ? "is-active" : ""}
                aria-pressed={!showStagedDiff}
                onClick={() => onToggleStagedDiff(false)}
              >
                Working tree
              </button>
              <button
                type="button"
                className={showStagedDiff ? "is-active" : ""}
                aria-pressed={showStagedDiff}
                onClick={() => onToggleStagedDiff(true)}
              >
                Index
              </button>
            </div>
          )}
        </div>
        <div className="git-workspace__diff-note">
          Repository diff · separate from Vibe engine review and its approval flow.
        </div>
        <div
          className="git-workspace__diff-content"
          aria-label="Unified diff"
          aria-busy={loadingDiff}
        >
          {loadingDiff ? (
            <div className="git-workspace__loading">
              <LoaderCircle className="git-workspace__spin" size={18} /> Loading diff…
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
                    ? (header, lines) => onStageHunk(selectedPath, header, lines)
                    : undefined
              }
              onUnstageHunk={
                showStagedDiff
                  ? selectedPath
                    ? (header, lines) => onUnstageHunk(selectedPath, header, lines)
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
              <span>Choose a changed file to inspect its unified diff.</span>
            </div>
          )}
        </div>
        {diff?.truncated && (
          <div className="git-workspace__truncation">
            Diff preview is capped at 512 KiB ({diff.bytes.toLocaleString()} bytes shown).
          </div>
        )}
      </section>
    </div>
  );
}

export function ChangesFileRow({
  file,
  selected,
  label,
  working,
  onSelect,
  onStage,
  onUnstage,
}: {
  file: GitFile;
  selected: boolean;
  label: string;
  working: boolean;
  onSelect: (filePath: string) => void;
  onStage: (filePath: string) => void;
  onUnstage: (filePath: string) => void;
}) {
  const displayName = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
  return (
    <article
      role="listitem"
      className={selected ? "git-workspace__file is-selected" : "git-workspace__file"}
    >
      <button
        type="button"
        className="git-workspace__file-select"
        aria-pressed={selected}
        onClick={() => onSelect(file.path)}
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
          {file.untracked ? "U" : `${file.indexStatus}${file.worktreeStatus}`}
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
              onClick={() => onStage(file.path)}
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
              onClick={() => onUnstage(file.path)}
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
}
