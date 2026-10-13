import type { FormEvent, ReactNode } from "react";
import {
  ExternalLink,
  FileCode2,
  Folder,
  Globe,
  History,
  LoaderCircle,
  Minus,
  RefreshCw,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { previewUrlProblem } from "../preview-url";
import type { DirEntry, FilePreview, GitStatus } from "../git-types";

export interface FilesPanelProps {
  status: GitStatus | null;
  treeCache: Map<string, DirEntry[]>;
  expandedDirs: Set<string>;
  treeLoading: boolean;
  previewPath: string | null;
  preview: FilePreview | null;
  previewLoading: boolean;
  recentPaths: string[];
  treeQuery: string;
  dirtyPaths: Set<string>;
  webUrl: string;
  activePreviewUrl: string | null;
  previewWorking: boolean;
  onReloadTree: () => void;
  onQueryChange: (value: string) => void;
  onToggleDir: (dir: string) => void;
  onOpenPreview: (filePath: string) => void;
  onWebUrlChange: (value: string) => void;
  onSubmitWebPreview: (event: FormEvent<HTMLFormElement>) => void;
  onPreviewReload: () => void;
  onPreviewClose: () => void;
  onOpenExternal: (url: string) => void;
  renderTreeRows: (dir: string, depth: number, rows: ReactNode[], seen: Set<string>) => ReactNode[];
}

export function FilesPanel({
  status,
  previewPath,
  preview,
  previewLoading,
  recentPaths,
  treeQuery,
  treeLoading,
  webUrl,
  activePreviewUrl,
  previewWorking,
  onReloadTree,
  onQueryChange,
  onOpenPreview,
  onWebUrlChange,
  onSubmitWebPreview,
  onPreviewReload,
  onPreviewClose,
  onOpenExternal,
  renderTreeRows,
}: FilesPanelProps) {
  const webProblem = webUrl.trim() ? previewUrlProblem(webUrl) : null;
  return (
    <section className="git-workspace__list-view" aria-label="File explorer">
      <div className="git-workspace__pane-heading">
        <div>
          <span className="git-workspace__eyebrow">REPOSITORY</span>
          <h2>Files</h2>
        </div>
        <button
          type="button"
          className="git-workspace__icon-button"
          onClick={onReloadTree}
          disabled={treeLoading}
          aria-label="Reload file tree"
        >
          <RefreshCw size={15} />
        </button>
      </div>
      <p className="git-workspace__view-note">
        Read-only inspector: previews never grant local files any app
        privileges. Modified files carry their Git state.
      </p>
      <div className="git-workspace__explorer">
        <aside className="git-workspace__tree" aria-label="Folder tree">
          <div className="git-workspace__file-tools" role="search">
            <input
              type="search"
              placeholder="Find a file…"
              aria-label="Find a file"
              value={treeQuery}
              onChange={(event) => onQueryChange(event.target.value)}
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
                  onClick={() => onOpenPreview(recent)}
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
                  onClick={() => onOpenPreview(file.path)}
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
                File too large to preview ({(preview.size ?? 0).toLocaleString()} bytes, cap{" "}
                {(preview.maxBytes ?? 0).toLocaleString()}).
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
          Optional loopback preview (for example a dev server you started
          yourself). Only an explicitly submitted localhost URL opens in an
          isolated window without app privileges, and it can never leave its
          approved origin. Nothing is ever launched automatically.
        </p>
        <form className="git-workspace__wt-create-row" onSubmit={onSubmitWebPreview}>
          <input
            type="url"
            placeholder="http://localhost:3000/"
            aria-label="Local preview URL"
            value={webUrl}
            onChange={(event) => onWebUrlChange(event.target.value)}
          />
          <button
            type="submit"
            className="git-workspace__button git-workspace__button--primary"
            disabled={previewWorking}
          >
            Open preview
          </button>
          {activePreviewUrl && (
            <>
              <button
                type="button"
                className="git-workspace__button git-workspace__button--quiet"
                onClick={onPreviewReload}
                disabled={previewWorking}
              >
                <RefreshCw size={13} /> Reload
              </button>
              <button
                type="button"
                className="git-workspace__button git-workspace__button--quiet"
                onClick={() => onOpenExternal(activePreviewUrl)}
              >
                Open in browser <ExternalLink size={13} />
              </button>
              <button
                type="button"
                className="git-workspace__button git-workspace__button--quiet"
                onClick={onPreviewClose}
                disabled={previewWorking}
              >
                Stop
              </button>
            </>
          )}
        </form>
        {webProblem && (
          <p className="git-workspace__limit-note" role="alert">
            {webProblem}
          </p>
        )}
        {activePreviewUrl && (
          <p className="git-workspace__view-note" role="status">
            Previewing <code>{activePreviewUrl}</code> in an isolated window.
            Redirects and navigations outside this origin are blocked.
          </p>
        )}
      </div>
    </section>
  );
}
