import { History, LoaderCircle, RefreshCw } from "lucide-react";
import { formatDate, shortHash } from "../git-api";
import type { GitLogItem } from "../git-types";

export interface HistoryPanelProps {
  history: GitLogItem[] | null;
  loadingTab: boolean;
  onRefresh: () => void;
}

export function HistoryPanel({ history, loadingTab, onRefresh }: HistoryPanelProps) {
  return (
    <section className="git-workspace__list-view" aria-label="Commit history">
      <div className="git-workspace__pane-heading">
        <div>
          <span className="git-workspace__eyebrow">LOCAL HISTORY</span>
          <h2>Recent commits</h2>
        </div>
        <button
          type="button"
          className="git-workspace__icon-button"
          onClick={onRefresh}
          disabled={loadingTab}
          aria-label="Refresh commit history"
        >
          <RefreshCw size={15} />
        </button>
      </div>
      {loadingTab && (
        <div className="git-workspace__loading">
          <LoaderCircle size={17} className="git-workspace__spin" /> Reading history…
        </div>
      )}
      {!loadingTab && history?.length === 0 && (
        <div className="git-workspace__list-empty">
          <History size={18} /> No commits yet.
        </div>
      )}
      <div className="git-workspace__history-list">
        {history?.map((item) => (
          <article className="git-workspace__history-item" key={item.hash}>
            <span className="git-workspace__history-node" aria-hidden="true" />
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
  );
}
